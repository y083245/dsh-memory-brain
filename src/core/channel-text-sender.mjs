import { SENSITIVE_RE } from '../sensitive.js';
import { resolveTextTarget } from './channel-intake.mjs';
import { readAccountRef, readConversationRef, readMessageRef, readPersonRef } from './identity.mjs';
import { isChannelOutboxId, isChannelOutboxText, validateChannelOutboxSegments } from './outbox-store.mjs';

const UNKNOWN = Object.freeze({ status: 'unknown' });
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_ATTEMPTS = 3;

function synchronous(value) {
  if (typeof value?.then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError('Channel text sender callback must be synchronous');
  }
  return value;
}

function readContext({ operationId, authorizationId, source } = {}) {
  if (!isChannelOutboxId(operationId) || !isChannelOutboxId(authorizationId)) {
    throw new TypeError('Invalid channel text operation context');
  }
  return Object.freeze({
    operationId,
    authorizationId,
    source: source == null ? null : Object.freeze({
      conversation: Object.freeze(readConversationRef(source.conversation)),
      actor: Object.freeze(readPersonRef(source.actor)),
    }),
  });
}

function readSendResult(result, conversation, attempt, maxAttempts) {
  switch (result?.status) {
    case 'sent': {
      const { messageId } = readMessageRef({
        conversation, platformChatId: conversation.chatId, messageId: result.platformMessageId,
      });
      return { status: 'sent', platformMessageId: messageId };
    }
    case 'rate_limited': {
      const delayMs = result.retryAfterMs;
      if (attempt < maxAttempts && Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= MAX_RETRY_DELAY_MS) {
        return { status: 'retry', delayMs };
      }
      return { status: 'failed' };
    }
    case 'failed':
      return { status: 'failed' };
    default:
      return UNKNOWN;
  }
}

async function sendWithTimeout(sendText, request, timeoutMs, attempt, maxAttempts) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = performance.now() + timeoutMs;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve(UNKNOWN);
        controller.abort();
      }, timeoutMs);
    });
    const result = await Promise.race([sendText({ ...request, signal: controller.signal }), timeout]);
    if (performance.now() >= deadline) {
      controller.abort();
      return UNKNOWN;
    }
    return readSendResult(result, request.conversation, attempt, maxAttempts);
  } catch {
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}

// The trusted host supplies reply references from verified tasks or history.
// resolveTextTarget checks structure and scope; the host supplies message provenance.
// authorize checks that the grant is bound to the exact source and target and
// still matches the current generation, capability and mute state.
export function createChannelTextSender({
  store, authorize, adapterFor, isSensitive, requestTimeoutMs = 15_000, maxAttempts = MAX_REQUEST_ATTEMPTS,
} = {}) {
  if (![store?.enqueue, store?.claim, store?.claimRemainingMs, store?.settle, store?.get,
    authorize, adapterFor, isSensitive].every((callback) => typeof callback === 'function')) {
    throw new TypeError('Invalid channel text sender callbacks');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_REQUEST_ATTEMPTS) {
    throw new RangeError('Invalid channel text sender limits');
  }

  function authorizedTarget(context, conversation, replyTo) {
    try {
      const policy = synchronous(authorize(context, conversation));
      return policy && resolveTextTarget(policy, conversation, { source: context.source, replyTo });
    } catch {
      return null;
    }
  }

  function submitText(input, target, text, replyTo = null) {
    if (!isChannelOutboxText(text) || !text.trim()) return { status: 'invalid' };
    let context, conversation, quoted;
    try {
      context = readContext(input);
      conversation = Object.freeze(readConversationRef(target));
      quoted = replyTo == null ? null : readMessageRef(replyTo);
    } catch {
      return { status: 'invalid' };
    }
    const resolved = authorizedTarget(context, conversation, quoted);
    if (!resolved) return { status: 'denied' };
    try {
      if (synchronous(isSensitive(text)) !== false || SENSITIVE_RE.test(text)) return { status: 'sensitive' };
    } catch {
      return { status: 'sensitive' };
    }
    let segments;
    try {
      const adapter = synchronous(adapterFor(readAccountRef(resolved.conversation)));
      if (typeof adapter?.sendText !== 'function') return { status: 'unavailable' };
      segments = validateChannelOutboxSegments(synchronous(adapter.splitText(text)));
      if (segments.join('') !== text) return { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
    return store.enqueue({ ...context, conversation: resolved.conversation, replyTo: quoted, segments });
  }

  async function deliverNext(input) {
    let account;
    try {
      account = readAccountRef(input);
    } catch {
      return null;
    }
    if (account.platform === 'qq') return null;
    const claim = store.claim(account);
    if (!claim) return null;
    const settle = (result) => store.settle(account, claim, result) ?? store.get(account, claim.operationId);

    let sendText;
    try {
      const adapter = synchronous(adapterFor(Object.freeze({ ...account })));
      const send = adapter?.sendText;
      if (typeof send === 'function') sendText = send.bind(adapter);
    } catch {
      // No adapter call has been made.
    }
    const context = readContext(claim);
    const resolved = authorizedTarget(context, Object.freeze(claim.conversation), claim.replyTo);
    if (!resolved) return settle({ status: 'cancelled' });
    if (!sendText) return settle({ status: 'failed' });
    const request = { ...resolved, conversation: Object.freeze(resolved.conversation), sendId: claim.sendId, text: claim.text };
    const timeoutMs = Math.min(requestTimeoutMs, store.claimRemainingMs(claim));
    if (timeoutMs <= 0) return settle(UNKNOWN);
    // The request starts synchronously in the same turn as the policy and lease checks.
    return settle(await sendWithTimeout(sendText, request, timeoutMs, claim.attempt, maxAttempts));
  }

  return { submitText, deliverNext };
}
