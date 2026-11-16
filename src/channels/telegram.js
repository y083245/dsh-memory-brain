import { normalizeSensitiveText, sensitiveTextForms } from '../sensitive.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TELEGRAM_ID_MAX = 2 ** 52 - 1;
const MAX_SEGMENT_UTF16 = 4096;
const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const MAX_POLL_RETRY_MS = 30_000;
const MAX_OUTBOX_RETRY_MS = 24 * 60 * 60 * 1000;
const CHAT_CMD_RE = /^\/chat(?:@([A-Za-z0-9_]+))?$/i;

async function defaultLoadSdk() {
  const [{ Api, GrammyError, HttpError }, { HttpsProxyAgent }, { SocksProxyAgent }] = await Promise.all([
    import('grammy'),
    import('https-proxy-agent'),
    import('socks-proxy-agent'),
  ]);
  return { Api, GrammyError, HttpError, HttpsProxyAgent, SocksProxyAgent };
}

function isValidTelegramId(id, { signed = false } = {}) {
  if (!Number.isSafeInteger(id) || id === 0 || Math.abs(id) > TELEGRAM_ID_MAX) return false;
  return signed ? true : id > 0;
}

function splitTextUtf16(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const segments = [];
  let chunk = '';
  for (const cp of text) {
    if (chunk.length > 0 && chunk.length + cp.length > MAX_SEGMENT_UTF16) {
      segments.push(chunk);
      chunk = cp;
    } else {
      chunk += cp;
    }
  }
  if (chunk.length > 0) segments.push(chunk);
  return segments;
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' ||
    String(err?.message ?? '').toLowerCase().includes('aborted');
}

function isGrammyError(err, GrammyError) {
  return (GrammyError && err instanceof GrammyError) ||
    (typeof err?.error_code === 'number' && err?.ok === false);
}

function isHttpError(err, HttpError) {
  return (HttpError && err instanceof HttpError) || err?.name === 'HttpError';
}

function extractProxySecrets(parsedProxy) {
  const raw = [];
  if (!parsedProxy) return raw;
  const { username, password } = parsedProxy;
  if (password) {
    raw.push(password);
    try { raw.push(decodeURIComponent(password)); } catch {}
    if (username) {
      raw.push(`${username}:${password}`);
      try { raw.push(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`); } catch {}
    }
  }
  return raw;
}

function buildSecretForms(secrets) {
  const out = new Set();
  for (const raw of secrets) {
    if (typeof raw !== 'string' || raw.length < 6) continue;
    const canonical = normalizeSensitiveText(raw);
    const compact = canonical.replace(/[\s._-]+/g, '');
    if (canonical.length >= 6) out.add(canonical);
    if (compact.length >= 6) out.add(compact);
  }
  return [...out];
}

function normalizeTelegramUpdate(update, me, accountId, log) {
  const deliveryRef = String(update?.update_id ?? '');
  const msg = update?.message;
  if (!msg || typeof msg !== 'object') return { kind: 'unsupported', deliveryRef };

  if (msg.migrate_to_chat_id !== undefined || msg.migrate_from_chat_id !== undefined) {
    log('telegram: received group migration candidate signal');
    return { kind: 'unsupported', deliveryRef };
  }
  if (msg.sender_chat) return { kind: 'unsupported', deliveryRef };
  if (msg.from?.is_bot === true) {
    return { kind: 'message', senderType: 'bot', deliveryRef };
  }

  const chatTypeRaw = msg.chat?.type;
  if (chatTypeRaw !== 'private' && chatTypeRaw !== 'group' && chatTypeRaw !== 'supergroup') {
    return { kind: 'unsupported', deliveryRef };
  }
  const chatType = chatTypeRaw === 'private' ? 'private' : 'group';
  if (!isValidTelegramId(msg.chat?.id, { signed: chatType === 'group' })) {
    return { kind: 'unsupported', deliveryRef };
  }
  if (chatType === 'group' && msg.chat.id >= 0) {
    return { kind: 'unsupported', deliveryRef };
  }
  if (!isValidTelegramId(msg.from?.id) || !isValidTelegramId(msg.message_id)) {
    return { kind: 'unsupported', deliveryRef };
  }
  if (typeof msg.text !== 'string' || !msg.text.trim()) {
    return { kind: 'unsupported', deliveryRef };
  }

  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const threadId = Number.isSafeInteger(msg.message_thread_id) && msg.message_thread_id > 0 && msg.is_topic_message !== false
    ? String(msg.message_thread_id)
    : null;
  const conversation = { platform: 'telegram', accountId, tenantId: null, chatType, chatId, threadId };

  const replyRaw = msg.reply_to_message;
  const isImplicitTopicRoot = replyRaw && (
    Boolean(replyRaw.forum_topic_created) ||
    (threadId !== null && String(replyRaw.message_id) === threadId)
  );
  const explicitReply = replyRaw && !isImplicitTopicRoot ? replyRaw : null;
  const replyTo = explicitReply && isValidTelegramId(explicitReply.message_id) &&
    (explicitReply.chat?.id === undefined || explicitReply.chat.id === msg.chat.id)
    ? { conversation, platformChatId: chatId, messageId: String(explicitReply.message_id) }
    : null;

  let text = msg.text;
  let trigger = chatType === 'private' ? 'directed' : 'ambient';
  if (chatType === 'group') {
    const botUsername = typeof me.username === 'string' ? me.username.toLowerCase() : '';
    const entities = Array.isArray(msg.entities) ? msg.entities : [];
    const replyToBot = explicitReply?.from?.id === me.id;
    let cmdDirected = false;
    let mentionDirected = false;

    for (const ent of entities) {
      if (!ent || typeof ent.offset !== 'number' || typeof ent.length !== 'number') continue;
      if (ent.type === 'bot_command' && ent.offset === 0) {
        const cmd = msg.text.slice(0, ent.length);
        const match = CHAT_CMD_RE.exec(cmd);
        if (match && (!match[1] || (botUsername && match[1].toLowerCase() === botUsername))) {
          cmdDirected = true;
          const rest = msg.text.slice(ent.length).trim();
          text = rest || '/chat';
        }
      } else if (ent.type === 'mention' && botUsername) {
        const mention = msg.text.slice(ent.offset, ent.offset + ent.length).toLowerCase();
        if (mention === `@${botUsername}`) mentionDirected = true;
      } else if (ent.type === 'text_mention' && ent.user?.id === me.id) {
        mentionDirected = true;
      }
    }
    if (replyToBot || cmdDirected || mentionDirected) trigger = 'directed';
  }

  return {
    kind: 'message',
    senderType: 'human',
    actor: { platform: 'telegram', accountId, tenantId: null, userId },
    conversation,
    message: { conversation, platformChatId: chatId, messageId: String(msg.message_id) },
    replyTo,
    text,
    occurredAt: Number.isSafeInteger(msg.date) && msg.date >= 0 ? msg.date * 1000 : Date.now(),
    deliveryRef,
    trigger,
  };
}

export function createTelegramAdapter({
  channelHost,
  readConfig,
  env = process.env,
  log = () => {},
  loadSdk = defaultLoadSdk,
} = {}) {
  let queue = Promise.resolve();
  let state = { status: 'idle', accountId: null, username: null, observationVerified: false };
  let activeSession = null;
  let pendingStartAbort = null;

  const enqueue = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  async function stopImpl() {
    const session = activeSession;
    activeSession = null;
    if (session) {
      session.closing = true;
      try { session.abortController?.abort(); } catch {}
      try { await session.pollPromise; } catch {}
      try { session.registration?.close?.(); } catch {}
    }
    state = { status: 'idle', accountId: null, username: null, observationVerified: false };
  }

  async function startImpl() {
    const settings = readConfig?.()?.channels?.telegram;
    if (settings?.enabled !== true) {
      await stopImpl();
      state.status = 'disabled';
      return { status: 'disabled' };
    }
    const transport = settings.transport ?? 'polling';
    const tokenEnv = settings.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN';
    const proxyEnv = settings.proxyUrlEnv ?? 'TELEGRAM_PROXY_URL';
    if (transport !== 'polling' || !ENV_NAME_RE.test(tokenEnv) || !ENV_NAME_RE.test(proxyEnv)) {
      await stopImpl();
      log('telegram: invalid transport or environment variable name');
      state.status = 'invalid_config';
      return { status: 'invalid_config' };
    }
    const botToken = typeof env?.[tokenEnv] === 'string' ? env[tokenEnv].trim() : '';
    if (!botToken) {
      await stopImpl();
      state.status = 'awaiting_credentials';
      return { status: 'awaiting_credentials' };
    }
    const proxyUrl = typeof env?.[proxyEnv] === 'string' ? env[proxyEnv].trim() : '';
    let parsedProxy = null;
    if (proxyUrl) {
      try {
        parsedProxy = new URL(proxyUrl);
        if (!ALLOWED_PROXY_PROTOCOLS.has(parsedProxy.protocol) || !parsedProxy.hostname) {
          throw new Error('unsupported proxy');
        }
      } catch {
        await stopImpl();
        log('telegram: invalid proxy URL');
        state.status = 'invalid_proxy';
        return { status: 'invalid_proxy' };
      }
    }

    const configuredAccountId = typeof settings.accountId === 'string' && settings.accountId ? settings.accountId : null;
    const groupPolicy = settings.groupPolicy ?? 'directed';
    if (activeSession && !activeSession.closing &&
        activeSession.tokenEnv === tokenEnv && activeSession.botToken === botToken &&
        activeSession.proxyEnv === proxyEnv && activeSession.proxyUrl === proxyUrl &&
        activeSession.configuredAccountId === configuredAccountId && activeSession.groupPolicy === groupPolicy) {
      return { status: 'running' };
    }

    await stopImpl();

    let sdk;
    try {
      sdk = await loadSdk();
    } catch (err) {
      log(`telegram: failed to load SDK: ${err?.message ?? err}`);
      state.status = 'sdk_error';
      return { status: 'sdk_error' };
    }

    let agent;
    if (parsedProxy) {
      agent = parsedProxy.protocol === 'http:' || parsedProxy.protocol === 'https:'
        ? new sdk.HttpsProxyAgent(proxyUrl)
        : new sdk.SocksProxyAgent(proxyUrl);
    }

    const api = new sdk.Api(botToken, {
      sensitiveLogs: false,
      ...(agent ? { baseFetchConfig: { agent } } : {}),
    });

    const startupAbort = new AbortController();
    pendingStartAbort = startupAbort;
    const startupSignal = AbortSignal.any([startupAbort.signal, AbortSignal.timeout(10_000)]);

    let me;
    try {
      me = await api.getMe(startupSignal);
    } catch (err) {
      if (pendingStartAbort === startupAbort) pendingStartAbort = null;
      if (isGrammyError(err, sdk.GrammyError) && err.error_code === 401) {
        log('telegram: getMe failed with 401 Unauthorized');
        state.status = 'auth_error';
        return { status: 'auth_error' };
      }
      log(`telegram: getMe failed (${err?.error_code ?? err?.code ?? 'network'})`);
      state.status = 'network_error';
      return { status: 'network_error' };
    }

    if (!isValidTelegramId(me?.id)) {
      if (pendingStartAbort === startupAbort) pendingStartAbort = null;
      log('telegram: getMe returned invalid bot id');
      state.status = 'auth_error';
      return { status: 'auth_error' };
    }
    const accountId = String(me.id);
    if (configuredAccountId && configuredAccountId !== accountId) {
      if (pendingStartAbort === startupAbort) pendingStartAbort = null;
      log('telegram: configured accountId does not match bot id');
      state.status = 'account_mismatch';
      return { status: 'account_mismatch' };
    }

    try {
      const webhook = await api.getWebhookInfo(startupSignal);
      if (typeof webhook?.url === 'string' && webhook.url.length > 0) {
        log('telegram: active webhook detected; refusing to deleteWebhook or start polling');
        state.status = 'webhook_conflict';
        return { status: 'webhook_conflict' };
      }
    } catch (err) {
      log(`telegram: getWebhookInfo failed (${err?.error_code ?? err?.code ?? 'network'})`);
      state.status = 'network_error';
      return { status: 'network_error' };
    } finally {
      if (pendingStartAbort === startupAbort) pendingStartAbort = null;
    }

    const observationVerified = me.can_read_all_group_messages === true;
    const session = {
      tokenEnv,
      botToken,
      proxyEnv,
      proxyUrl,
      configuredAccountId,
      groupPolicy,
      accountId,
      closing: false,
      abortController: new AbortController(),
      registration: null,
      pollPromise: null,
    };
    activeSession = session;

    const secretForms = buildSecretForms([botToken, ...extractProxySecrets(parsedProxy)]);
    const isSensitive = (text) => {
      if (typeof text !== 'string' || !text || secretForms.length === 0) return false;
      const forms = sensitiveTextForms(text);
      return forms.some((form) => secretForms.some((sec) => form.includes(sec)));
    };

    const isCurrent = () => {
      if (session.closing || activeSession !== session) return false;
      const cur = readConfig?.()?.channels?.telegram;
      if (cur?.enabled !== true || (cur.transport ?? 'polling') !== 'polling') return false;
      const curTokenEnv = cur.botTokenEnv ?? 'TELEGRAM_BOT_TOKEN';
      const curProxyEnv = cur.proxyUrlEnv ?? 'TELEGRAM_PROXY_URL';
      if (curTokenEnv !== tokenEnv || curProxyEnv !== proxyEnv) return false;
      const curToken = typeof env?.[curTokenEnv] === 'string' ? env[curTokenEnv].trim() : '';
      const curProxy = typeof env?.[curProxyEnv] === 'string' ? env[curProxyEnv].trim() : '';
      if (curToken !== botToken || curProxy !== proxyUrl) return false;
      if (cur.accountId !== undefined && cur.accountId !== accountId) return false;
      if ((cur.groupPolicy ?? 'directed') !== groupPolicy) return false;
      return true;
    };

    const outboundAdapter = {
      splitText: splitTextUtf16,
      async sendText({ conversation, replyToMessageId, text, signal }) {
        const extra = {};
        if (conversation.threadId != null) extra.message_thread_id = Number(conversation.threadId);
        if (replyToMessageId != null) extra.reply_parameters = { message_id: Number(replyToMessageId) };
        try {
          const sent = await api.sendMessage(conversation.chatId, text, extra, signal);
          if (isValidTelegramId(sent?.message_id)) {
            return { status: 'sent', platformMessageId: String(sent.message_id) };
          }
          return { status: 'unknown' };
        } catch (err) {
          if (isAbortError(err) || isHttpError(err, sdk.HttpError)) return { status: 'unknown' };
          if (isGrammyError(err, sdk.GrammyError)) {
            if (err.error_code === 429) {
              const retryAfterMs = clamp((err.parameters?.retry_after ?? 2) * 1000, 1000, MAX_OUTBOX_RETRY_MS);
              return { status: 'rate_limited', retryAfterMs };
            }
            if (err.error_code >= 500 && err.error_code < 600) return { status: 'unknown' };
            if ([400, 401, 403, 404].includes(err.error_code)) return { status: 'failed' };
          }
          return { status: 'unknown' };
        }
      },
    };

    try {
      session.registration = channelHost.registerAccount(
        { platform: 'telegram', accountId, tenantId: null },
        { adapter: outboundAdapter, isCurrent, observationVerified, isSensitive },
      );
    } catch (err) {
      log(`telegram: registration failed: ${err?.message ?? err}`);
      await stopImpl();
      state.status = 'registration_error';
      return { status: 'registration_error' };
    }

    const poller = session.registration.startPolling();
    if (!poller) {
      await stopImpl();
      state.status = 'unavailable';
      return { status: 'unavailable' };
    }

    const runPollLoop = async () => {
      let attempt = 0;
      while (!session.closing && isCurrent()) {
        const checkpoint = poller.readCheckpoint();
        if (!checkpoint) break;
        try {
          const updates = await api.getUpdates({
            ...(checkpoint.offset != null ? { offset: checkpoint.offset } : {}),
            limit: 100,
            timeout: 25,
            allowed_updates: ['message'],
          }, session.abortController.signal);
          attempt = 0;

          if (!Array.isArray(updates) || updates.length === 0) {
            if (checkpoint.offset != null) poller.acceptBatch([], checkpoint);
            continue;
          }
          const seenIds = new Set();
          const sorted = [...updates]
            .sort((a, b) => (a?.update_id ?? 0) - (b?.update_id ?? 0))
            .filter((u) => {
              const id = u?.update_id;
              if (!Number.isSafeInteger(id) || id < 0) return false;
              if (checkpoint.offset != null && id < checkpoint.offset) return false;
              if (seenIds.has(id)) return false;
              seenIds.add(id);
              return true;
            });
          if (sorted.length === 0) {
            if (checkpoint.offset != null) poller.acceptBatch([], checkpoint);
            continue;
          }
          const events = sorted.map((u) => normalizeTelegramUpdate(u, me, accountId, log));
          const batchRes = poller.acceptBatch(events, checkpoint);
          if (batchRes?.status === 'retryableFailure') {
            if (batchRes.reason === 'stale_checkpoint') break;
            await sleepWithSignal(1000, session.abortController.signal);
          } else if (batchRes?.blocked != null) {
            await sleepWithSignal(500, session.abortController.signal);
          }
        } catch (err) {
          if (session.closing || isAbortError(err)) break;
          if (isGrammyError(err, sdk.GrammyError)) {
            if (err.error_code === 409) {
              log('telegram: 409 conflict during getUpdates; stopping poller');
              if (activeSession === session) state.status = 'conflict';
              session.closing = true;
              try { session.registration?.close?.(); } catch {}
              break;
            }
            if (err.error_code === 401) {
              log('telegram: 401 unauthorized during getUpdates; stopping poller');
              if (activeSession === session) state.status = 'auth_error';
              session.closing = true;
              try { session.registration?.close?.(); } catch {}
              break;
            }
            if (err.error_code === 429) {
              const waitMs = clamp((err.parameters?.retry_after ?? 2) * 1000, 1000, 60_000);
              await sleepWithSignal(waitMs, session.abortController.signal);
              continue;
            }
          }
          attempt += 1;
          const base = Math.min(MAX_POLL_RETRY_MS, 1000 * (2 ** Math.min(attempt - 1, 5)));
          const jitter = Math.floor(Math.random() * 500);
          await sleepWithSignal(base + jitter, session.abortController.signal);
        }
      }
    };

    session.pollPromise = runPollLoop().catch((err) => {
      if (!session.closing) log(`telegram: poll loop exited with error: ${err?.message ?? err}`);
    });

    state = {
      status: 'running',
      accountId,
      username: me.username ?? null,
      observationVerified,
    };
    return { status: 'running' };
  }

  return {
    start: () => enqueue(startImpl),
    stop: () => {
      try { pendingStartAbort?.abort(); } catch {}
      return enqueue(stopImpl);
    },
    syncConfig: () => enqueue(async () => {
      try {
        return await startImpl();
      } catch (err) {
        log(`telegram: syncConfig failed: ${err?.message ?? err}`);
        return { status: 'error' };
      }
    }),
    status: () => ({ ...state }),
  };
}
