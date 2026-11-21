import { createHash } from 'node:crypto';
import { normalizeSensitiveText, sensitiveTextForms } from '../sensitive.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{1,125}$/;
const MAX_SEGMENT_CHARS = 3500;
const MAX_SEGMENT_BYTES = 12_000;
const DEFAULT_RETRY_AFTER_MS = 2000;
const MIN_RETRY_AFTER_MS = 1000;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE_FEISHU_CODES = new Set([99991400]);

function deterministicUuid(sendId) {
  const hex = createHash('sha256').update(String(sendId)).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function splitTextSafe(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const segments = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const cp of text) {
    const cpBytes = Buffer.byteLength(cp, 'utf8');
    if (chunk.length > 0 && (chunk.length + cp.length > MAX_SEGMENT_CHARS || chunkBytes + cpBytes > MAX_SEGMENT_BYTES)) {
      segments.push(chunk);
      chunk = cp;
      chunkBytes = cpBytes;
    } else {
      chunk += cp;
      chunkBytes += cpBytes;
    }
  }
  if (chunk.length > 0) segments.push(chunk);
  return segments;
}

function parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 8.64e15) return raw;
  if (typeof raw === 'string' && /^\d{1,16}$/.test(raw.trim())) {
    const value = Number(raw.trim());
    if (Number.isInteger(value) && value >= 0 && value <= 8.64e15) return value;
  }
  return Date.now();
}

function unwrapPostLocale(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed.content)) return parsed;
  for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
    if (parsed[key] && typeof parsed[key] === 'object' && Array.isArray(parsed[key].content)) return parsed[key];
  }
  for (const val of Object.values(parsed)) {
    if (val && typeof val === 'object' && Array.isArray(val.content)) return val;
  }
  return null;
}

function renderPostElement(el, mentionByKey) {
  if (!el || typeof el !== 'object') return '';
  switch (el.tag) {
    case 'text':
      return typeof el.text === 'string' ? el.text : '';
    case 'a': {
      const label = el.text || el.href || '';
      return el.href && el.text && el.text !== el.href ? `${el.text} (${el.href})` : label;
    }
    case 'at': {
      const userId = el.user_id ?? '';
      if (userId === 'all' || userId === 'all_members') return '@all';
      const byKey = typeof el.key === 'string' ? mentionByKey.get(el.key) : null;
      if (byKey) return el.key;
      return el.user_name ? `@${el.user_name}` : (userId ? `@${userId}` : '');
    }
    case 'code_block':
      return `\n\`\`\`${el.language ?? ''}\n${el.text ?? ''}\n\`\`\`\n`;
    case 'hr':
      return '\n---\n';
    default:
      return typeof el.text === 'string' ? el.text : '';
  }
}

function extractMessageText(message, botOpenId) {
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  const mentionByKey = new Map();
  let mentionedBot = false;
  for (const m of mentions) {
    if (typeof m?.key === 'string') mentionByKey.set(m.key, m);
    if (botOpenId && m?.id?.open_id === botOpenId) mentionedBot = true;
  }

  let rawText = '';
  try {
    const parsed = JSON.parse(message?.content ?? '{}');
    if (message?.message_type === 'text') {
      rawText = typeof parsed?.text === 'string' ? parsed.text : '';
    } else if (message?.message_type === 'post') {
      const body = unwrapPostLocale(parsed);
      if (body) {
        const lines = [];
        if (typeof body.title === 'string' && body.title.trim()) lines.push(body.title.trim());
        for (const para of body.content ?? []) {
          if (!Array.isArray(para)) continue;
          let line = '';
          for (const el of para) line += renderPostElement(el, mentionByKey);
          lines.push(line);
        }
        rawText = lines.join('\n').trim();
      }
    }
  } catch {
    return { text: '', mentionedBot };
  }

  if (!rawText) return { text: '', mentionedBot };

  const stripBot = message?.chat_type === 'group' && mentionedBot;
  let cleaned = rawText;
  for (const [key, m] of mentionByKey.entries()) {
    const isBotMention = botOpenId && m?.id?.open_id === botOpenId;
    if (stripBot && isBotMention) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`[ \\t]*${escaped}[ \\t]*`, 'g'), (match, offset, str) => {
        const before = offset > 0 ? str[offset - 1] : '\n';
        const after = offset + match.length < str.length ? str[offset + match.length] : '\n';
        return before === '\n' || after === '\n' ? '' : ' ';
      });
    } else {
      cleaned = cleaned.split(key).join(`@${m?.name || m?.id?.open_id || key}`);
    }
  }
  cleaned = cleaned.trim();
  if (!cleaned && stripBot) {
    const botMention = mentions.find((m) => m?.id?.open_id === botOpenId);
    cleaned = `@${botMention?.name || 'bot'}`;
  }
  return { text: cleaned, mentionedBot };
}

function parseRetryAfterMs(headers) {
  if (!headers || typeof headers !== 'object') return DEFAULT_RETRY_AFTER_MS;
  const getHeader = (name) => {
    if (typeof headers.get === 'function') return headers.get(name);
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name) return v;
    }
    return undefined;
  };
  const retryAfter = getHeader('retry-after');
  if (retryAfter != null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(secs * 1000)));
    }
  }
  const reset = getHeader('x-ratelimit-reset');
  if (reset != null) {
    const val = Number(reset);
    if (Number.isFinite(val) && val > 0) {
      const ms = val > 1e12 ? val - Date.now() : (val > 1e9 ? val * 1000 - Date.now() : val * 1000);
      if (Number.isFinite(ms) && ms > 0) {
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(ms)));
      }
    }
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function classifySendError(err) {
  const status = err?.response?.status ?? err?.status;
  const code = err?.response?.data?.code ?? err?.data?.code ?? err?.code;
  const headers = err?.response?.headers ?? err?.headers;
  const msg = String(err?.message ?? '').toLowerCase();

  if (err?.name === 'AbortError' || msg.includes('abort') || msg.includes('timeout') ||
      code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    return { status: 'unknown' };
  }
  if (status === 429 || RETRYABLE_FEISHU_CODES.has(code)) {
    return { status: 'rate_limited', retryAfterMs: parseRetryAfterMs(headers) };
  }
  if (status >= 500 && status < 600) {
    return { status: 'unknown' };
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 ||
      (typeof code === 'number' && code !== 0)) {
    return { status: 'failed' };
  }
  return { status: 'unknown' };
}

async function raceWithSignal(promise, signal) {
  if (!signal) return await promise;
  if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createFeishuAdapter({
  channelHost,
  readConfig,
  env = process.env,
  log = () => {},
  loadSdk = () => import('@larksuiteoapi/node-sdk'),
} = {}) {
  let queue = Promise.resolve();
  let state = { status: 'idle', appId: null, tenantId: null, botOpenId: null, observationVerified: false };
  let activeSession = null;

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
      try { session.wsClient?.close?.({ force: false }); } catch {}
      try { session.registration?.close?.(); } catch {}
    }
    state = { status: 'idle', appId: null, tenantId: null, botOpenId: null, observationVerified: false };
  }

  async function startImpl() {
    const settings = readConfig?.()?.channels?.feishu;
    if (settings?.enabled !== true) {
      await stopImpl();
      state.status = 'disabled';
      return { status: 'disabled' };
    }
    const transport = settings.transport ?? 'websocket';
    const domain = settings.domain ?? 'feishu';
    if (transport !== 'websocket' || domain !== 'feishu') {
      await stopImpl();
      log('feishu: unsupported transport or domain configuration');
      state.status = 'invalid_config';
      return { status: 'invalid_config' };
    }
    const appId = typeof settings.appId === 'string' ? settings.appId.trim() : '';
    const secretEnv = settings.appSecretEnv ?? 'FEISHU_APP_SECRET';
    if (!ENV_NAME_RE.test(secretEnv)) {
      await stopImpl();
      log('feishu: invalid appSecretEnv name');
      state.status = 'invalid_config';
      return { status: 'invalid_config' };
    }
    const appSecret = typeof env?.[secretEnv] === 'string' ? env[secretEnv] : '';
    if (!appId || !appSecret) {
      await stopImpl();
      state.status = 'awaiting_credentials';
      return { status: 'awaiting_credentials' };
    }
    const configuredTenantId = typeof settings.tenantId === 'string' && settings.tenantId ? settings.tenantId : null;
    if (activeSession && !activeSession.closing &&
        activeSession.appId === appId && activeSession.secretEnv === secretEnv &&
        activeSession.appSecret === appSecret && activeSession.configuredTenantId === configuredTenantId &&
        activeSession.groupPolicy === (settings.groupPolicy ?? 'directed')) {
      return { status: 'running' };
    }

    await stopImpl();

    let sdk;
    try {
      sdk = await loadSdk();
    } catch (err) {
      log(`feishu: failed to load SDK: ${err?.message ?? err}`);
      state.status = 'sdk_error';
      return { status: 'sdk_error' };
    }

    const sdkDomain = sdk.Domain?.Feishu ?? 'https://open.feishu.cn';
    const loggerLevel = sdk.LoggerLevel?.warn ?? 2;
    const client = new sdk.Client({ appId, appSecret, domain: sdkDomain, loggerLevel });

    let botOpenId;
    try {
      const info = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
      if (info?.code !== 0 || typeof info?.bot?.open_id !== 'string' || !info.bot.open_id) {
        log('feishu: bot/v3/info failed to return bot open_id');
        state.status = 'auth_error';
        return { status: 'auth_error' };
      }
      botOpenId = info.bot.open_id;
    } catch (err) {
      log(`feishu: auth check failed (${err?.response?.status ?? err?.code ?? 'error'})`);
      state.status = 'auth_error';
      return { status: 'auth_error' };
    }

    let resolvedTenantId = configuredTenantId;
    try {
      const tenantRes = client.tenant?.v2?.tenant?.query
        ? await client.tenant.v2.tenant.query()
        : await client.request({ method: 'GET', url: '/open-apis/tenant/v2/tenant/query' });
      const queriedKey = tenantRes?.code === 0 ? tenantRes?.data?.tenant?.tenant_key : null;
      if (typeof queriedKey === 'string' && queriedKey) {
        if (configuredTenantId && configuredTenantId !== queriedKey) {
          log('feishu: configured tenantId does not match tenant_key from API');
          state.status = 'tenant_mismatch';
          return { status: 'tenant_mismatch' };
        }
        resolvedTenantId = queriedKey;
      }
    } catch {
      // Missing tenant:tenant:readonly scope — fall back to configuredTenantId or lazy event discovery.
    }

    let observationVerified = false;
    if (settings.groupPolicy === 'observe') {
      try {
        const scopesRes = client.application?.v6?.scope?.list
          ? await client.application.v6.scope.list()
          : await client.request({ method: 'GET', url: '/open-apis/application/v6/scopes' });
        const scopes = scopesRes?.code === 0 ? scopesRes?.data?.scopes : null;
        if (Array.isArray(scopes)) {
          observationVerified = scopes.some((s) => s?.scope_name === 'im:message.group_msg' && s?.grant_status === 1);
        }
      } catch {
        observationVerified = false;
      }
    }

    const session = {
      appId,
      secretEnv,
      appSecret,
      configuredTenantId,
      groupPolicy: settings.groupPolicy ?? 'directed',
      botOpenId,
      tenantId: resolvedTenantId,
      observationVerified,
      closing: false,
      registration: null,
      wsClient: null,
    };
    activeSession = session;

    const canonicalSecret = appSecret.length >= 6 ? normalizeSensitiveText(appSecret) : '';
    const compactSecret = canonicalSecret.replace(/[\s._-]+/g, '');
    const secretForms = [...new Set([canonicalSecret, compactSecret].filter((s) => s.length >= 6))];
    const isSensitive = (text) => {
      if (typeof text !== 'string' || !text || secretForms.length === 0) return false;
      const forms = sensitiveTextForms(text);
      return forms.some((form) => secretForms.some((sec) => form.includes(sec)));
    };

    const isCurrent = () => {
      if (session.closing || activeSession !== session) return false;
      const cur = readConfig?.()?.channels?.feishu;
      if (cur?.enabled !== true) return false;
      if ((cur.transport ?? 'websocket') !== 'websocket' || (cur.domain ?? 'feishu') !== 'feishu') return false;
      if ((typeof cur.appId === 'string' ? cur.appId.trim() : '') !== appId) return false;
      const curEnv = cur.appSecretEnv ?? 'FEISHU_APP_SECRET';
      if (curEnv !== secretEnv || env?.[curEnv] !== appSecret) return false;
      const curTenant = typeof cur.tenantId === 'string' && cur.tenantId ? cur.tenantId : null;
      if (curTenant !== null && curTenant !== session.tenantId) return false;
      if ((cur.groupPolicy ?? 'directed') !== session.groupPolicy) return false;
      return true;
    };

    const outboundAdapter = {
      splitText: splitTextSafe,
      async sendText({ conversation, replyToMessageId, sendId, text, signal }) {
        const uuid = deterministicUuid(sendId);
        const content = JSON.stringify({ text });
        const doRequest = async () => {
          if (replyToMessageId != null) {
            return client.im.v1.message.reply({
              path: { message_id: replyToMessageId },
              data: { content, msg_type: 'text', uuid, ...(conversation.threadId ? { reply_in_thread: true } : {}) },
            });
          }
          if (conversation.threadId != null) {
            const listRes = await client.im.v1.message.list({
              params: { container_id_type: 'thread', container_id: conversation.threadId, page_size: 1 },
            });
            const rootMsgId = listRes?.code === 0 ? listRes?.data?.items?.[0]?.message_id : null;
            if (!rootMsgId) {
              throw Object.assign(new Error('Thread root message not found'), { status: 404 });
            }
            return client.im.v1.message.reply({
              path: { message_id: rootMsgId },
              data: { content, msg_type: 'text', uuid, reply_in_thread: true },
            });
          }
          return client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: conversation.chatId, msg_type: 'text', content, uuid },
          });
        };

        try {
          const res = await raceWithSignal(doRequest(), signal);
          if (res?.code === 0 && typeof res?.data?.message_id === 'string' && res.data.message_id) {
            return { status: 'sent', platformMessageId: res.data.message_id };
          }
          if (RETRYABLE_FEISHU_CODES.has(res?.code)) {
            return { status: 'rate_limited', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
          }
          if (typeof res?.code === 'number' && res.code !== 0) {
            return { status: 'failed' };
          }
          return { status: 'unknown' };
        } catch (err) {
          return classifySendError(err);
        }
      },
    };

    const ensureRegistered = (tenantId) => {
      if (session.registration) return session.registration;
      session.tenantId = tenantId;
      session.registration = channelHost.registerAccount(
        { platform: 'feishu', accountId: appId, tenantId },
        { adapter: outboundAdapter, isCurrent, observationVerified, isSensitive },
      );
      state.tenantId = tenantId;
      return session.registration;
    };

    if (resolvedTenantId) {
      try {
        ensureRegistered(resolvedTenantId);
      } catch (err) {
        log(`feishu: registration failed: ${err?.message ?? err}`);
        await stopImpl();
        state.status = 'registration_error';
        return { status: 'registration_error' };
      }
    }

    const dispatcher = new sdk.EventDispatcher({ loggerLevel }).register({
      'im.message.receive_v1': async (data) => {
        if (session.closing || activeSession !== session) return;
        if (data?.app_id && data.app_id !== appId) return;
        const tenantKey = typeof data?.tenant_key === 'string' ? data.tenant_key : '';
        if (!tenantKey) return;
        if (session.tenantId && tenantKey !== session.tenantId) return;

        if (!session.registration) {
          ensureRegistered(tenantKey);
        }

        if (data?.sender?.sender_type !== 'user') return;
        const userId = data?.sender?.sender_id?.open_id;
        if (typeof userId !== 'string' || !userId) return;

        const msg = data?.message;
        if (!msg || typeof msg.chat_id !== 'string' || typeof msg.message_id !== 'string') return;
        if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return;
        if (msg.message_type !== 'text' && msg.message_type !== 'post') return;

        const { text, mentionedBot } = extractMessageText(msg, botOpenId);
        if (!text.trim()) return;

        const chatType = msg.chat_type === 'p2p' ? 'private' : 'group';
        const threadId = typeof msg.thread_id === 'string' && msg.thread_id.length > 0 ? msg.thread_id : null;
        const conversation = {
          platform: 'feishu',
          accountId: appId,
          tenantId: tenantKey,
          chatType,
          chatId: msg.chat_id,
          threadId,
        };
        const replyTo = typeof msg.parent_id === 'string' && MESSAGE_ID_RE.test(msg.parent_id)
          ? { conversation, platformChatId: msg.chat_id, messageId: msg.parent_id }
          : null;
        const trigger = chatType === 'private' ? 'directed' : (mentionedBot ? 'directed' : 'ambient');
        const occurredAt = parseTimestampMs(msg.create_time ?? data.create_time);
        const deliveryRef = typeof data.event_id === 'string' && data.event_id ? data.event_id : msg.message_id;

        const res = session.registration.accept({
          kind: 'message',
          senderType: 'human',
          actor: { platform: 'feishu', accountId: appId, tenantId: tenantKey, userId },
          conversation,
          message: { conversation, platformChatId: msg.chat_id, messageId: msg.message_id },
          replyTo,
          text,
          ...(chatType === 'private' && threadId === null && msg.message_type === 'text' && !msg.parent_id &&
            !msg.root_id && !msg.mentions?.length && text.startsWith('/share_memory ') && { memoryShareAllowed: true }),
          occurredAt,
          deliveryRef,
          trigger,
        });
        if (res?.status === 'retryableFailure') {
          throw new Error(`Feishu inbox retryableFailure: ${res.reason ?? 'unknown'}`);
        }
      },
    });

    const wsClient = new sdk.WSClient({
      appId,
      appSecret,
      domain: sdkDomain,
      loggerLevel,
      autoReconnect: true,
    });
    session.wsClient = wsClient;
    Promise.resolve(wsClient.start({ eventDispatcher: dispatcher })).catch((err) => {
      log(`feishu: wsClient start failed: ${err?.message ?? err}`);
      if (!session.closing && activeSession === session) {
        state = { ...state, status: 'ws_error' };
      }
    });

    state = {
      status: 'running',
      appId,
      tenantId: session.tenantId,
      botOpenId,
      observationVerified,
    };
    return { status: 'running' };
  }

  return {
    start: () => enqueue(startImpl),
    stop: () => enqueue(stopImpl),
    syncConfig: () => enqueue(async () => {
      try {
        return await startImpl();
      } catch (err) {
        log(`feishu: syncConfig failed: ${err?.message ?? err}`);
        return { status: 'error' };
      }
    }),
    status: () => ({ ...state }),
  };
}
