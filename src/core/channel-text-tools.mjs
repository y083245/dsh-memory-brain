import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveTextTarget } from './channel-intake.mjs';
import { createChannelTextSender } from './channel-text-sender.mjs';
import { encodeConversationKey, encodeMessageKey, encodePersonKey } from './identity.mjs';
import { isChannelOutboxId, isChannelOutboxText } from './outbox-store.mjs';
import {
  channelCommonToolNames, validChannelToolArgs, validChannelToolResult,
} from '../../plugins/qq-agent-presets/channel-tool-contract.mjs';

const SEND = 'channel_send_text';
const REPLY = 'channel_reply_text';
const REQUEST_ID = /^task_([a-f0-9]{64})$/;
const AUTHORIZATION_ID = /^grant_([a-f0-9]{64})_([A-Za-z0-9_-]{43})$/;

function hasDataKeys(value, keys) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

export function createChannelTextTools({ store, adapterFor, isSensitive, authorizeSource, findTextSession, isSilent }) {
  if (typeof authorizeSource !== 'function') throw new TypeError('Invalid channel text source authorizer');
  const key = randomBytes(32);

  function signature(entry, source, requestId, operationId, replyTo) {
    const { sessionId, generation, conversationKey, bindingRevision } = entry.snapshot;
    return createHmac('sha256', key).update(JSON.stringify([
      sessionId, generation, entry.textGrantGeneration ?? 0, conversationKey, bindingRevision, encodePersonKey(source.actor),
      requestId, operationId, replyTo && encodeMessageKey(replyTo),
    ])).digest('base64url');
  }

  function revokeTextGrants(entry) {
    // Older queued turns in this same DSH session must lose their signatures
    // as well. A later directed turn may get a new grant if sending is restored.
    entry.textGrantGeneration = (entry.textGrantGeneration ?? 0) + 1;
    entry.textRequestId = null;
  }

  function readPolicy(entry, source) {
    const { conversationKey, bindingRevision } = entry.snapshot;
    const policy = authorizeSource({ conversationKey, bindingRevision, source });
    if (typeof policy?.then === 'function') {
      void Promise.resolve(policy).catch(() => {});
      return null;
    }
    if (!resolveTextTarget(policy, source.conversation, { source })) {
      revokeTextGrants(entry);
      return null;
    }
    return policy;
  }

  function sessionAllowsSending(entry) {
    if (findTextSession(entry.snapshot) !== entry) return false;
    if (!isSilent()) return true;
    revokeTextGrants(entry);
    return false;
  }

  function readTurn(entry, requestId, options) {
    const checked = entry.textBinding.readTextTurn({ ...entry.snapshot, requestId }, options);
    if (checked.status === 'revoked') revokeTextGrants(entry);
    return checked;
  }

  const sender = createChannelTextSender({
    store, adapterFor, isSensitive,
    authorize({ operationId, authorizationId, source }, conversation, { phase, replyTo }) {
      const authorization = AUTHORIZATION_ID.exec(authorizationId);
      if (!authorization || !source) return null;
      const conversationKey = encodeConversationKey(conversation);
      const entry = findTextSession({ conversationKey });
      if (!entry?.textBinding || encodeConversationKey(source.conversation) !== conversationKey) return null;
      const [, requestDigest, mac] = authorization;
      const requestId = `task_${requestDigest}`;
      const submitting = phase === 'submit';
      if (submitting && entry.textRequestId !== requestId) return null;
      const generation = entry.textGrantGeneration;
      const expected = signature(entry, source, requestId, operationId, replyTo);
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
      const policy = readPolicy(entry, source);
      if (!policy) return null;
      const checked = readTurn(entry, requestId, { source, allowCompleted: !submitting });
      if (!sessionAllowsSending(entry) || entry.textGrantGeneration !== generation ||
          (submitting && entry.textRequestId !== requestId)) return null;
      if (checked.status === 'active' && (!replyTo || encodeMessageKey(replyTo) === encodeMessageKey(checked.message))) return policy;
      return !submitting && checked.status === 'completed' ? policy : null;
    },
  });

  function registerTurn({ binding, turn }) {
    try {
      const entry = findTextSession(turn);
      if (!entry || typeof binding.readTextTurn !== 'function' || !REQUEST_ID.test(turn.requestId)) return;
      entry.textBinding = binding;
      entry.textRequestId = null;
      const generation = entry.textGrantGeneration;
      const checked = readTurn(entry, turn.requestId);
      if (checked.status !== 'active') return;
      const { source } = checked;
      if (readPolicy(entry, source) && sessionAllowsSending(entry) && entry.textGrantGeneration === generation) {
        entry.textRequestId = turn.requestId;
      }
    } catch {
      // Missing authorization cannot publish a tool grant for the dispatched turn.
    }
  }

  function invokeTextTool(input) {
    try {
      if (!hasDataKeys(input, ['sessionId', 'requestId', 'callId', 'name', 'args'])) return { status: 'invalid' };
      const { sessionId, requestId, callId, name, args } = input;
      if (![sessionId, requestId, callId].every(isChannelOutboxId) || (name !== SEND && name !== REPLY) ||
          !hasDataKeys(args, ['text']) || !isChannelOutboxText(args.text) || !args.text.trim()) return { status: 'invalid' };

      const entry = findTextSession({ sessionId });
      if (entry?.textRequestId !== requestId) return { status: 'denied' };
      const checked = readTurn(entry, requestId);
      if (checked.status !== 'active') {
        if (checked.status === 'denied') entry.textRequestId = null;
        return { status: 'denied' };
      }
      const { source, message } = checked;
      const replyTo = name === REPLY ? message : null;
      const operationId = `tool_${createHash('sha256').update(JSON.stringify([sessionId, requestId, callId])).digest('hex')}`;
      const [, requestDigest] = REQUEST_ID.exec(requestId);
      const authorizationId = `grant_${requestDigest}_${signature(entry, source, requestId, operationId, replyTo)}`;
      const { status } = sender.submitText({ operationId, authorizationId, source }, source.conversation, args.text, replyTo);
      if (status === 'denied' && entry.textRequestId === requestId) entry.textRequestId = null;
      return { status };
    } catch {
      return { status: 'unavailable' };
    }
  }

  return { registerTurn, invokeTextTool, deliverNextText: sender.deliverNext };
}

export function createChannelCommonToolGrants({ actions, authorizeSource, findTextSession }) {
  if (typeof actions?.invoke !== 'function' || typeof authorizeSource !== 'function') {
    throw new TypeError('Invalid channel common tool authorizer');
  }
  const grants = new WeakMap();

  function currentSource(entry, binding, requestId, source) {
    try {
      const turn = binding.readTextTurn({ ...entry.snapshot, requestId }, { source });
      if (turn.status !== 'active') return null;
      const { conversationKey, bindingRevision } = entry.snapshot;
      const policy = authorizeSource({ conversationKey, bindingRevision, source: turn.source });
      if (typeof policy?.then === 'function') {
        void Promise.resolve(policy).catch(() => {});
        return null;
      }
      if (!resolveTextTarget(policy, turn.source.conversation, { source: turn.source }) ||
          findTextSession(entry.snapshot) !== entry) return null;
      return turn;
    } catch {
      return null;
    }
  }

  function registerTurn({ binding, turn }) {
    try {
      const entry = findTextSession(turn);
      if (!entry) return;
      grants.delete(entry);
      if (typeof binding.readTextTurn !== 'function' || !REQUEST_ID.test(turn.requestId)) return;
      const current = currentSource(entry, binding, turn.requestId);
      if (!current) return;
      grants.set(entry, { binding, requestId: turn.requestId, source: current.source, seenThroughSeq: 0 });
    } catch {
      // Missing authorization cannot publish a tool grant for the dispatched turn.
    }
  }

  async function invokeCommonTool(input, { signal } = {}) {
    try {
      if (!hasDataKeys(input, ['sessionId', 'requestId', 'callId', 'name', 'args'])) return { status: 'invalid' };
      const { sessionId, requestId, callId, name, args } = input;
      if (![sessionId, requestId, callId].every(isChannelOutboxId) || !channelCommonToolNames.includes(name) ||
          !validChannelToolArgs(name, args)) return { status: 'invalid' };

      const entry = findTextSession({ sessionId });
      const grant = grants.get(entry);
      if (grant?.requestId !== requestId) return { status: 'denied' };
      const { binding, source } = grant;
      const { conversationKey } = entry.snapshot;
      let context;
      function readContext() {
        if (signal?.aborted || grants.get(entry) !== grant || findTextSession(entry.snapshot) !== entry) return null;
        const turn = currentSource(entry, binding, requestId, source);
        if (!turn) {
          grants.delete(entry);
          return null;
        }
        context ??= Object.freeze({ conversationKey, source, message: turn.message, requestId, callId, binding });
        return context;
      }

      if (!readContext()) return { status: 'denied' };
      const page = name === 'channel_get_unread' || name === 'channel_wait_for_messages';
      const cursor = page ? args.afterSeq : args.throughSeq;
      if (cursor !== undefined && cursor > grant.seenThroughSeq) {
        const persisted = binding.toolReadCursor(conversationKey);
        if (!Number.isSafeInteger(persisted) || cursor > persisted) return { status: 'denied' };
      }
      const result = await actions.invoke({ name, args, readContext, signal });
      if (!readContext()) return { status: 'denied' };
      if (!validChannelToolResult(name, result)) return { status: 'unavailable' };
      if (page && result.status === 'ok' && Array.isArray(result.data.messages)) {
        // The inbox supplies a chronological page from the authorized cursor.
        // Only delivered rows extend this turn's ability to acknowledge reads.
        for (const message of result.data.messages) {
          const seq = message?.seq;
          if (Number.isSafeInteger(seq) && seq > grant.seenThroughSeq) grant.seenThroughSeq = seq;
        }
      }
      return result;
    } catch {
      return { status: 'unavailable' };
    }
  }

  return { registerTurn, invokeCommonTool };
}
