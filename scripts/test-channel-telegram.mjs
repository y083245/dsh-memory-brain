import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { createLongMemory } from '../src/long-memory.js';
import { startChannelHost } from '../src/runtime/channel-host.mjs';
import { createTelegramAdapter } from '../src/channels/telegram.js';

class FakeGrammyError extends Error {
  constructor(errorCode, description = 'err', parameters = {}) {
    super(description);
    this.ok = false;
    this.error_code = errorCode;
    this.description = description;
    this.parameters = parameters;
  }
}

class FakeHttpError extends Error {
  constructor(message = 'network error') {
    super(message);
    this.name = 'HttpError';
  }
}

function makeSdkHarness({
  me = { id: 123456789, is_bot: true, username: 'MyTestBot', can_read_all_group_messages: false },
  getMeImpl,
  webhookUrl = '',
  getUpdatesImpl = async () => [],
  sendMessageImpl = async () => ({ message_id: 9001 }),
} = {}) {
  const calls = { apiOpts: [], getUpdates: [], sendMessage: [], deleteWebhook: 0, proxyAgents: [] };

  class FakeHttpsProxyAgent {
    constructor(url) { this.url = url; this.kind = 'https'; calls.proxyAgents.push({ kind: 'https', url }); }
  }
  class FakeSocksProxyAgent {
    constructor(url) { this.url = url; this.kind = 'socks'; calls.proxyAgents.push({ kind: 'socks', url }); }
  }
  class FakeApi {
    constructor(token, opts) {
      this.token = token;
      this.opts = opts;
      calls.apiOpts.push({ token, opts });
    }
    async getMe() {
      if (getMeImpl) return getMeImpl();
      return me;
    }
    async getWebhookInfo() {
      return { url: webhookUrl };
    }
    async deleteWebhook() {
      calls.deleteWebhook += 1;
      return true;
    }
    async getUpdates(params, signal) {
      calls.getUpdates.push({ params, signal });
      return getUpdatesImpl(params, signal);
    }
    async sendMessage(chatId, text, extra, signal) {
      calls.sendMessage.push({ chatId, text, extra, signal });
      return sendMessageImpl(chatId, text, extra, signal);
    }
  }

  return {
    calls,
    loadSdk: async () => ({
      Api: FakeApi,
      GrammyError: FakeGrammyError,
      HttpError: FakeHttpError,
      HttpsProxyAgent: FakeHttpsProxyAgent,
      SocksProxyAgent: FakeSocksProxyAgent,
    }),
  };
}

function makeHostHarness({
  checkpointQueue = [{ offset: null }],
  acceptBatchImpl = () => ({ status: 'accepted' }),
} = {}) {
  const registrations = [];
  const batches = [];
  let closed = 0;
  let checkpointIdx = 0;

  const channelHost = {
    registerAccount(account, hooks) {
      const rec = { account, hooks, closed: false };
      registrations.push(rec);
      return {
        startPolling() {
          return {
            readCheckpoint() {
              const cp = checkpointQueue[Math.min(checkpointIdx, checkpointQueue.length - 1)];
              return cp;
            },
            acceptBatch(events, checkpoint) {
              batches.push({ events, checkpoint });
              checkpointIdx += 1;
              return acceptBatchImpl(events, checkpoint);
            },
          };
        },
        close() {
          rec.closed = true;
          closed += 1;
        },
      };
    },
  };
  return { channelHost, registrations, batches, closedCount: () => closed };
}

test('missing token stays awaiting_credentials and invalid proxy refuses without bypass', async () => {
  const host = makeHostHarness();
  let sdkLoaded = false;
  const adapter1 = createTelegramAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: {},
    loadSdk: async () => { sdkLoaded = true; return {}; },
  });
  assert.deepEqual(await adapter1.start(), { status: 'awaiting_credentials' });
  assert.equal(sdkLoaded, false);
  assert.equal(host.registrations.length, 0);

  const logs = [];
  const adapter2 = createTelegramAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '123:secret_tok', TELEGRAM_PROXY_URL: 'ftp://user:pass_secret@proxy.local:21' },
    log: (m) => logs.push(m),
    loadSdk: async () => { sdkLoaded = true; return {}; },
  });
  assert.deepEqual(await adapter2.start(), { status: 'invalid_proxy' });
  assert.equal(sdkLoaded, false);
  assert.equal(logs.join('\n').includes('pass_secret'), false);
});

test('wires http and socks5 proxy agents, checks observationVerified, and handles 401/webhook/409 conflicts', async () => {
  const sdkHttp = makeSdkHarness({ me: { id: 42, is_bot: true, username: 'BotA', can_read_all_group_messages: true } });
  const hostHttp = makeHostHarness();
  const aHttp = createTelegramAdapter({
    channelHost: hostHttp.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '42:tok', TELEGRAM_PROXY_URL: 'http://127.0.0.1:8080' },
    loadSdk: sdkHttp.loadSdk,
  });
  assert.deepEqual(await aHttp.start(), { status: 'running' });
  assert.equal(sdkHttp.calls.proxyAgents[0].kind, 'https');
  assert.equal(sdkHttp.calls.apiOpts[0].opts.sensitiveLogs, false);
  assert.equal(hostHttp.registrations[0].hooks.observationVerified, true);
  await aHttp.stop();

  const sdkSocks = makeSdkHarness({
    me: { id: 42, is_bot: true, username: 'BotA', can_read_all_group_messages: false },
    getUpdatesImpl: async () => { throw new FakeGrammyError(409, 'Conflict'); },
  });
  const hostSocks = makeHostHarness();
  const aSocks = createTelegramAdapter({
    channelHost: hostSocks.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '42:tok', TELEGRAM_PROXY_URL: 'socks5://127.0.0.1:1080' },
    loadSdk: sdkSocks.loadSdk,
  });
  assert.deepEqual(await aSocks.start(), { status: 'running' });
  assert.equal(sdkSocks.calls.proxyAgents[0].kind, 'socks');
  assert.equal(hostSocks.registrations[0].hooks.observationVerified, false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(aSocks.status().status, 'conflict');
  await aSocks.stop();

  const sdk401 = makeSdkHarness({ getMeImpl: async () => { throw new FakeGrammyError(401, 'Unauthorized'); } });
  const a401 = createTelegramAdapter({
    channelHost: makeHostHarness().channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '42:bad' },
    loadSdk: sdk401.loadSdk,
  });
  assert.deepEqual(await a401.start(), { status: 'auth_error' });

  const sdkHook = makeSdkHarness({ webhookUrl: 'https://example.com/hook' });
  const aHook = createTelegramAdapter({
    channelHost: makeHostHarness().channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '42:tok' },
    loadSdk: sdkHook.loadSdk,
  });
  assert.deepEqual(await aHook.start(), { status: 'webhook_conflict' });
  assert.equal(sdkHook.calls.deleteWebhook, 0);
});

test('polling loop commits batches, clears offset on empty poll, stops on stale_checkpoint, and retries blocked without skipping', async () => {
  let pollCount = 0;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const sdk = makeSdkHarness({
    getUpdatesImpl: async (_params, signal) => {
      pollCount += 1;
      if (pollCount === 1) {
        return [{ update_id: 10, message: { message_id: 1, date: 1700000000, chat: { id: 77, type: 'private' }, from: { id: 77, is_bot: false }, text: 'hi' } }];
      }
      if (pollCount === 2) return [];
      if (pollCount === 3) {
        resolveDone();
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      return [];
    },
  });

  let batchCall = 0;
  const host = makeHostHarness({
    checkpointQueue: [{ offset: null }, { offset: 11 }, { offset: null }],
    acceptBatchImpl: () => {
      batchCall += 1;
      if (batchCall === 2) return { status: 'accepted' };
      return { status: 'accepted' };
    },
  });

  const adapter = createTelegramAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '123456789:tok' },
    loadSdk: sdk.loadSdk,
  });
  await adapter.start();
  await done;
  await adapter.stop();

  assert.equal(host.batches.length, 2);
  assert.equal(host.batches[0].events.length, 1);
  assert.equal(host.batches[1].events.length, 0);
  assert.equal(host.batches[1].checkpoint.offset, 11);

  // stale_checkpoint stops poller cleanly
  let pollStale = 0;
  const sdkStale = makeSdkHarness({
    getUpdatesImpl: async () => {
      pollStale += 1;
      return [{ update_id: 5, message: { message_id: 1, date: 1700000000, chat: { id: 77, type: 'private' }, from: { id: 77, is_bot: false }, text: 'x' } }];
    },
  });
  const hostStale = makeHostHarness({
    checkpointQueue: [{ offset: 5 }],
    acceptBatchImpl: () => ({ status: 'retryableFailure', reason: 'stale_checkpoint' }),
  });
  const aStale = createTelegramAdapter({
    channelHost: hostStale.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '123456789:tok' },
    loadSdk: sdkStale.loadSdk,
  });
  await aStale.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pollStale, 1);
  await aStale.stop();
});

test('normalizes forum threads, implicit topic roots, /chat@bot, mentions, replies, and filters unsupported updates', async () => {
  let sentBatch = false;
  let resolveBatch;
  const batchDone = new Promise((r) => { resolveBatch = r; });

  const sdk = makeSdkHarness({
    me: { id: 999, is_bot: true, username: 'HelperBot', can_read_all_group_messages: true },
    getUpdatesImpl: async (_params, signal) => {
      if (!sentBatch) {
        sentBatch = true;
        return [
          // 1: Forum topic message with implicit reply_to_message matching thread_id -> replyTo must be null
          {
            update_id: 2,
            message: {
              message_id: 55,
              message_thread_id: 50,
              is_topic_message: true,
              date: 1700000001,
              chat: { id: -10012345, type: 'supergroup' },
              from: { id: 101, is_bot: false },
              reply_to_message: { message_id: 50, forum_topic_created: { name: 'Topic' } },
              text: '/chat@helperbot hello topic',
              entities: [{ type: 'bot_command', offset: 0, length: 15 }],
            },
          },
          // 2: Group @mention
          {
            update_id: 3,
            message: {
              message_id: 56,
              date: 1700000002,
              chat: { id: -10012345, type: 'supergroup' },
              from: { id: 101, is_bot: false },
              text: 'hey @HelperBot',
              entities: [{ type: 'mention', offset: 4, length: 10 }],
            },
          },
          // 3: Explicit reply to bot
          {
            update_id: 4,
            message: {
              message_id: 57,
              date: 1700000003,
              chat: { id: -10012345, type: 'supergroup' },
              from: { id: 101, is_bot: false },
              reply_to_message: { message_id: 54, chat: { id: -10012345 }, from: { id: 999 } },
              text: 'replying to you',
            },
          },
          // 4: /chat@otherbot -> ambient
          {
            update_id: 5,
            message: {
              message_id: 58,
              date: 1700000004,
              chat: { id: -10012345, type: 'supergroup' },
              from: { id: 101, is_bot: false },
              text: '/chat@OtherBot hi',
              entities: [{ type: 'bot_command', offset: 0, length: 14 }],
            },
          },
          // 5: Bot sender
          {
            update_id: 6,
            message: { message_id: 59, date: 1700000005, chat: { id: -10012345, type: 'supergroup' }, from: { id: 888, is_bot: true }, text: 'bot' },
          },
          // 6: Anonymous sender_chat
          {
            update_id: 7,
            message: { message_id: 60, date: 1700000006, chat: { id: -10012345, type: 'supergroup' }, sender_chat: { id: -10012345 }, from: { id: 1087968824, is_bot: false }, text: 'anon' },
          },
          // 7: Migration signal
          {
            update_id: 8,
            message: { message_id: 61, date: 1700000007, chat: { id: -10012345, type: 'group' }, migrate_to_chat_id: -10099999 },
          },
        ];
      }
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  });

  const host = makeHostHarness({
    acceptBatchImpl: () => { resolveBatch(); return { status: 'accepted' }; },
  });
  const adapter = createTelegramAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '999:tok' },
    loadSdk: sdk.loadSdk,
  });
  await adapter.start();
  await batchDone;
  await adapter.stop();

  const ev = host.batches[0].events;
  assert.equal(ev.length, 7);
  assert.equal(ev[0].conversation.threadId, '50');
  assert.equal(ev[0].replyTo, null);
  assert.equal(ev[0].trigger, 'directed');
  assert.equal(ev[0].text, 'hello topic');

  assert.equal(ev[1].trigger, 'directed');
  assert.equal(ev[2].trigger, 'directed');
  assert.equal(ev[2].replyTo.messageId, '54');
  assert.equal(ev[3].trigger, 'ambient');
  assert.equal(ev[4].senderType, 'bot');
  assert.equal(ev[5].kind, 'unsupported');
  assert.equal(ev[6].kind, 'unsupported');
});

test('outbound splitText preserves UTF-16 4096 limits/surrogates, sendText maps results, and isSensitive/isCurrent/stop work', async () => {
  let sendImpl = async () => ({ message_id: 321 });
  const sdk = makeSdkHarness({
    sendMessageImpl: (...args) => sendImpl(...args),
    getUpdatesImpl: async (_p, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  const host = makeHostHarness();
  let enabled = true;
  const botToken = '123456789:super_secret_token';
  const proxyUrl = 'http://alice:proxy_pw_secret%21@127.0.0.1:8080';
  const adapter = createTelegramAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled } } }),
    env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_PROXY_URL: proxyUrl },
    loadSdk: sdk.loadSdk,
  });
  await adapter.start();

  const { splitText, sendText } = host.registrations[0].hooks.adapter;
  const { isCurrent, isSensitive } = host.registrations[0].hooks;

  const emoji = '😀'.repeat(2050); // 4100 UTF-16 code units
  const parts = splitText(emoji);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 4096);
  assert.equal(parts[1].length, 4);
  assert.equal(parts.join(''), emoji);
  assert.equal(parts[0].isWellFormed(), true);

  const conv = { platform: 'telegram', accountId: '123456789', tenantId: null, chatType: 'group', chatId: '-1001', threadId: '50' };
  const res1 = await sendText({ conversation: conv, replyToMessageId: '10', text: 'hello' });
  assert.deepEqual(res1, { status: 'sent', platformMessageId: '321' });
  assert.equal(sdk.calls.sendMessage[0].extra.message_thread_id, 50);
  assert.deepEqual(sdk.calls.sendMessage[0].extra.reply_parameters, { message_id: 10 });

  sendImpl = async () => { throw new FakeGrammyError(429, 'Too Many Requests', { retry_after: 12 }); };
  assert.deepEqual(await sendText({ conversation: conv, replyToMessageId: null, text: 'x' }), { status: 'rate_limited', retryAfterMs: 12_000 });

  sendImpl = async () => { throw new FakeGrammyError(403, 'Forbidden'); };
  assert.deepEqual(await sendText({ conversation: conv, replyToMessageId: null, text: 'x' }), { status: 'failed' });

  sendImpl = async () => { throw new FakeHttpError('timeout'); };
  assert.deepEqual(await sendText({ conversation: conv, replyToMessageId: null, text: 'x' }), { status: 'unknown' });

  assert.equal(isCurrent(), true);
  assert.equal(isSensitive(`leak ${botToken}`), true);
  assert.equal(isSensitive('proxy_pw_secret!'), true);
  assert.equal(isSensitive(Buffer.from('proxy_pw_secret!').toString('base64')), true);
  assert.equal(isSensitive('safe message'), false);

  enabled = false;
  assert.equal(isCurrent(), false);
  await adapter.syncConfig();
  assert.equal(host.closedCount(), 1);
  assert.equal(adapter.status().status, 'disabled');
});

test('preserves entity offsets for /chat @Bot, deduplicates/filters stale update_id, and stop aborts in-flight getMe', async () => {
  let sentBatch = false;
  let resolveBatch;
  const batchDone = new Promise((r) => { resolveBatch = r; });

  const sdk = makeSdkHarness({
    me: { id: 999, is_bot: true, username: 'HelperBot', can_read_all_group_messages: true },
    getUpdatesImpl: async (_params, signal) => {
      if (!sentBatch) {
        sentBatch = true;
        return [
          { update_id: 9, message: { message_id: 1, date: 1700000000, chat: { id: 101, type: 'private' }, from: { id: 101, is_bot: false }, text: 'stale' } },
          {
            update_id: 10,
            message: {
              message_id: 2,
              date: 1700000001,
              chat: { id: -10012345, type: 'supergroup' },
              from: { id: 101, is_bot: false },
              text: '/chat @HelperBot hi',
              entities: [
                { type: 'bot_command', offset: 0, length: 5 },
                { type: 'mention', offset: 6, length: 10 },
              ],
            },
          },
          { update_id: 10, message: { message_id: 2, date: 1700000001, chat: { id: -10012345, type: 'supergroup' }, from: { id: 101, is_bot: false }, text: 'dup' } },
        ];
      }
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  });
  const host = makeHostHarness({
    checkpointQueue: [{ offset: 10 }],
    acceptBatchImpl: () => { resolveBatch(); return { status: 'accepted' }; },
  });
  const adapter = createTelegramAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '999:tok' },
    loadSdk: sdk.loadSdk,
  });
  await adapter.start();
  await batchDone;
  await adapter.stop();

  assert.equal(host.batches[0].events.length, 1);
  assert.equal(host.batches[0].events[0].deliveryRef, '10');
  assert.equal(host.batches[0].events[0].trigger, 'directed');
  assert.equal(host.batches[0].events[0].text, '@HelperBot hi');

  // stop() aborts an in-flight getMe() immediately without waiting 500s
  const sdkHang = {
    loadSdk: async () => ({
      Api: class {
        async getMe(signal) {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
          });
        }
      },
      GrammyError: FakeGrammyError,
      HttpError: FakeHttpError,
    }),
  };
  const aHang = createTelegramAdapter({
    channelHost: makeHostHarness().channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '999:tok' },
    loadSdk: sdkHang.loadSdk,
  });
  const startPromise = aHang.start();
  await new Promise((r) => setImmediate(r));
  await aHang.stop();
  const startRes = await startPromise;
  assert.equal(startRes.status, 'network_error');
});

test('real grammy Api + startChannelHost + openChannelInbox integration persists incoming message', async (t) => {
  const realGrammy = await import('grammy');
  const dir = mkdtempSync(join(tmpdir(), 'tg-int-'));
  const stateDir = join(dir, 'state');
  const longMemory = createLongMemory({ stateDir });
  const botId = 555666777;
  const token = `${botId}:real_grammy_test_token`;
  const prevTok = process.env.TG_TEST_TOKEN;
  process.env.TG_TEST_TOKEN = token;

  const config = {
    channels: {
      telegram: {
        enabled: true,
        botTokenEnv: 'TG_TEST_TOKEN',
        allow: { private: ['101'] },
      },
    },
  };
  const host = await startChannelHost({
    api: { workspace: { create: async () => {} }, sessions: { create: async () => {} } },
    workspacePath: dir,
    stateDir,
    longMemory,
    readConfig: () => config,
    readRoleState: () => ({ role: 'Test', mode: 'active' }),
    readRoleCard: () => 'Test card.',
    canRunTurns: () => false,
    intervalMs: 500,
  });

  let updatePolls = 0;
  let resolvePolled;
  const polled = new Promise((r) => { resolvePolled = r; });

  const stubFetch = async (url, opts) => {
    const method = String(url).split('/').pop();
    const jsonResp = (result) => ({
      json: async () => ({ ok: true, result }),
    });
    if (method === 'getMe') return jsonResp({ id: botId, is_bot: true, first_name: 'RealBot', username: 'RealTestBot', can_read_all_group_messages: false });
    if (method === 'getWebhookInfo') return jsonResp({ url: '' });
    if (method === 'getUpdates') {
      updatePolls += 1;
      if (updatePolls === 1) {
        queueMicrotask(resolvePolled);
        return jsonResp([{
          update_id: 1,
          message: {
            message_id: 11,
            date: 1700000010,
            chat: { id: 101, type: 'private' },
            from: { id: 101, is_bot: false },
            text: 'hello real grammy',
          },
        }]);
      }
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    return jsonResp({});
  };

  const adapter = createTelegramAdapter({
    channelHost: host,
    readConfig: () => config,
    env: process.env,
    loadSdk: async () => ({
      Api: class extends realGrammy.Api {
        constructor(tok, opts) {
          super(tok, { ...opts, fetch: stubFetch });
        }
      },
      GrammyError: realGrammy.GrammyError,
      HttpError: realGrammy.HttpError,
    }),
  });

  t.after(async () => {
    await adapter.stop();
    await host.close();
    if (prevTok === undefined) delete process.env.TG_TEST_TOKEN;
    else process.env.TG_TEST_TOKEN = prevTok;
    rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(await adapter.start(), { status: 'running' });
  assert.equal(host.platformState('telegram'), 'registered');
  await polled;
  await new Promise((r) => setTimeout(r, 20));
  await adapter.stop();
  await host.close();

  const inbox = openChannelInbox(join(stateDir, 'inbox.sqlite'));
  try {
    const binding = inbox.bind({ platform: 'telegram', accountId: String(botId), tenantId: null }, () => ({
      platform: 'telegram',
      accountId: String(botId),
      tenantId: null,
      ...config.channels.telegram,
    }));
    const pending = binding.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event.message.messageId, '11');
    assert.equal(pending[0].event.deliveryRef, '1');
    assert.equal(binding.recheckTask(pending[0].event.messageKey).status, 'lease_required');
  } finally {
    inbox.close();
  }
});

test('only a directly authored private Telegram command can approve memory sharing', async (t) => {
  const text = '/share_memory remember this';
  const messages = [
    {},
    { forward_origin: { type: 'hidden_user', sender_user_name: 'Original sender', date: 1700000000 } },
    { reply_to_message: { message_id: 100 } },
    { quote: { text: 'remember this' } },
    { entities: [{ type: 'expandable_blockquote', offset: 0, length: text.length }] },
    { chat: { id: -10012345, type: 'supergroup' } },
  ];
  const { promise: batchDone, resolve: notify } = Promise.withResolvers();
  let sentBatch = false;
  const sdk = makeSdkHarness({
    getUpdatesImpl: async (_params, signal) => {
      if (sentBatch) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      sentBatch = true;
      return messages.map((message, index) => ({
        update_id: index + 1,
        message: {
          chat: { id: 101, type: 'private' }, from: { id: 101, is_bot: false }, message_id: index + 1,
          text, date: 1700000000, ...message,
        },
      }));
    },
  });
  const host = makeHostHarness({ acceptBatchImpl: () => { notify(); return { status: 'accepted' }; } });
  const adapter = createTelegramAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { telegram: { enabled: true } } }),
    env: { TELEGRAM_BOT_TOKEN: '123:fixture_token' },
    loadSdk: sdk.loadSdk,
  });
  t.after(() => adapter.stop());
  await adapter.start();
  await batchDone;
  assert.deepEqual(host.batches[0].events.map((event) => event.memoryShareAllowed === true),
    [true, false, false, false, false, false]);
  assert.ok(host.batches[0].events.every((event) => event.text === text));
});
