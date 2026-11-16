import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { createLongMemory } from '../src/long-memory.js';
import { startChannelHost } from '../src/runtime/channel-host.mjs';
import { createFeishuAdapter } from '../src/channels/feishu.js';

function makeSdkHarness({
  botOpenId = 'ou_bot_1',
  tenantKey = 'tenant_1',
  failTenantQuery = false,
  scopes = [],
  onSend = async () => ({ code: 0, data: { message_id: 'om_sent_1' } }),
  onList = async () => ({ code: 0, data: { items: [{ message_id: 'om_thread_root' }] } }),
} = {}) {
  const calls = { request: [], create: [], reply: [], list: [], wsStart: 0, wsClose: [] };
  let registeredHandler = null;

  class FakeClient {
    constructor(opts) { this.opts = opts; }
    async request(req) {
      calls.request.push(req);
      if (req.url === '/open-apis/bot/v3/info') {
        if (!botOpenId) return { code: 99991663, msg: 'invalid' };
        return { code: 0, bot: { open_id: botOpenId, app_name: 'TestBot' } };
      }
      if (req.url === '/open-apis/tenant/v2/tenant/query') {
        if (failTenantQuery) throw Object.assign(new Error('no scope'), { status: 403 });
        return { code: 0, data: { tenant: { tenant_key: tenantKey } } };
      }
      if (req.url === '/open-apis/application/v6/scopes') {
        return { code: 0, data: { scopes } };
      }
      return { code: 0, data: {} };
    }
    tenant = {
      v2: {
        tenant: {
          query: async () => this.request({ method: 'GET', url: '/open-apis/tenant/v2/tenant/query' }),
        },
      },
    };
    application = {
      v6: {
        scope: {
          list: async () => this.request({ method: 'GET', url: '/open-apis/application/v6/scopes' }),
        },
      },
    };
    im = {
      v1: {
        message: {
          create: async (payload) => { calls.create.push(payload); return onSend('create', payload); },
          reply: async (payload) => { calls.reply.push(payload); return onSend('reply', payload); },
          list: async (payload) => { calls.list.push(payload); return onList(payload); },
        },
      },
    };
  }

  class FakeEventDispatcher {
    register(map) {
      registeredHandler = map['im.message.receive_v1'];
      return this;
    }
  }

  class FakeWSClient {
    constructor(opts) { this.opts = opts; }
    start() { calls.wsStart += 1; }
    close(opts) { calls.wsClose.push(opts); }
  }

  return {
    calls,
    emitReceive: (data) => registeredHandler(data),
    loadSdk: async () => ({
      Client: FakeClient,
      EventDispatcher: FakeEventDispatcher,
      WSClient: FakeWSClient,
      Domain: { Feishu: 'https://open.feishu.cn' },
      LoggerLevel: { warn: 2 },
    }),
  };
}

function makeHostHarness(acceptImpl = () => ({ status: 'durableAccepted' })) {
  const registrations = [];
  const accepted = [];
  let closed = 0;
  const channelHost = {
    registerAccount(account, hooks) {
      const rec = { account, hooks, closed: false };
      registrations.push(rec);
      return {
        accept(event) {
          accepted.push(event);
          return acceptImpl(event);
        },
        close() {
          rec.closed = true;
          closed += 1;
        },
      };
    },
  };
  return { channelHost, registrations, accepted, closedCount: () => closed };
}

test('missing credentials stay idle without throwing or registering', async () => {
  const host = makeHostHarness();
  let sdkLoaded = false;
  const adapter = createFeishuAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011' } } }),
    env: {},
    loadSdk: async () => { sdkLoaded = true; return {}; },
  });
  const res = await adapter.start();
  assert.deepEqual(res, { status: 'awaiting_credentials' });
  assert.equal(sdkLoaded, false);
  assert.equal(host.registrations.length, 0);
  assert.equal(adapter.status().status, 'awaiting_credentials');
});

test('startup resolves tenant_key via tenant.query, falls back to config, and registers lazily on first event', async () => {
  const sdk1 = makeSdkHarness({ tenantKey: 't_api_1' });
  const host1 = makeHostHarness();
  const adapter1 = createFeishuAdapter({
    channelHost: host1.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011' } } }),
    env: { FEISHU_APP_SECRET: 'secret_123456' },
    loadSdk: sdk1.loadSdk,
  });
  assert.deepEqual(await adapter1.start(), { status: 'running' });
  assert.equal(host1.registrations.length, 1);
  assert.equal(host1.registrations[0].account.tenantId, 't_api_1');
  await adapter1.stop();

  const sdk2 = makeSdkHarness({ failTenantQuery: true });
  const host2 = makeHostHarness();
  const adapter2 = createFeishuAdapter({
    channelHost: host2.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011', tenantId: 't_cfg_2' } } }),
    env: { FEISHU_APP_SECRET: 'secret_123456' },
    loadSdk: sdk2.loadSdk,
  });
  assert.deepEqual(await adapter2.start(), { status: 'running' });
  assert.equal(host2.registrations[0].account.tenantId, 't_cfg_2');
  await adapter2.stop();

  const sdk3 = makeSdkHarness({ failTenantQuery: true });
  const host3 = makeHostHarness();
  const adapter3 = createFeishuAdapter({
    channelHost: host3.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011' } } }),
    env: { FEISHU_APP_SECRET: 'secret_123456' },
    loadSdk: sdk3.loadSdk,
  });
  assert.deepEqual(await adapter3.start(), { status: 'running' });
  assert.equal(host3.registrations.length, 0);
  await sdk3.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_lazy_3',
    event_id: 'evt_lazy_1',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_msg_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      create_time: '1700000000000',
    },
  });
  assert.equal(host3.registrations.length, 1);
  assert.equal(host3.registrations[0].account.tenantId, 't_lazy_3');
  assert.equal(host3.accepted.length, 1);
  await adapter3.stop();
});

test('refuses startup on tenantId mismatch', async () => {
  const sdk = makeSdkHarness({ tenantKey: 't_real' });
  const host = makeHostHarness();
  const adapter = createFeishuAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011', tenantId: 't_other' } } }),
    env: { FEISHU_APP_SECRET: 'secret_123456' },
    loadSdk: sdk.loadSdk,
  });
  assert.deepEqual(await adapter.start(), { status: 'tenant_mismatch' });
  assert.equal(host.registrations.length, 0);
});

test('normalizes im.message.receive_v1 events, filters non-human/non-text, and throws on retryableFailure', async () => {
  let nextAccept = () => ({ status: 'durableAccepted' });
  const sdk = makeSdkHarness({ botOpenId: 'ou_bot_1', tenantKey: 't_1' });
  const host = makeHostHarness((ev) => nextAccept(ev));
  const adapter = createFeishuAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011' } } }),
    env: { FEISHU_APP_SECRET: 'secret_123456' },
    loadSdk: sdk.loadSdk,
  });
  await adapter.start();

  // Group @bot post message with parent_id (ordinary reply, no thread_id)
  await sdk.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_1',
    event_id: 'evt_1',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
    message: {
      message_id: 'om_2',
      parent_id: 'om_1',
      chat_id: 'oc_grp_1',
      chat_type: 'group',
      message_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: 'Title',
          content: [[{ tag: 'at', user_id: 'ou_bot_1', key: '@_user_1' }, { tag: 'text', text: ' hi ' }, { tag: 'a', text: 'link', href: 'https://example.com' }]],
        },
      }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_1' }, name: 'TestBot' }],
      create_time: '1700000001000',
    },
  });
  assert.equal(host.accepted.length, 1);
  assert.equal(host.accepted[0].trigger, 'directed');
  assert.equal(host.accepted[0].conversation.chatType, 'group');
  assert.equal(host.accepted[0].conversation.threadId, null);
  assert.equal(host.accepted[0].replyTo.messageId, 'om_1');
  assert.equal(host.accepted[0].text, 'Title\nhi link (https://example.com)');

  // Group @other -> ambient, thread_id preserved
  await sdk.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_1',
    event_id: 'evt_2',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
    message: {
      message_id: 'om_3',
      thread_id: 'omt_99',
      chat_id: 'oc_grp_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 ping' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bob' }, name: 'Bob' }],
      create_time: '1700000002000',
    },
  });
  assert.equal(host.accepted[1].trigger, 'ambient');
  assert.equal(host.accepted[1].conversation.threadId, 'omt_99');
  assert.equal(host.accepted[1].text, '@Bob ping');

  // Non-human and non-text are ignored without error
  await sdk.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_1',
    event_id: 'evt_3',
    sender: { sender_type: 'app', sender_id: { open_id: 'ou_other_bot' } },
    message: { message_id: 'om_4', chat_id: 'oc_grp_1', chat_type: 'group', message_type: 'text', content: '{"text":"bot"}' },
  });
  await sdk.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_1',
    event_id: 'evt_4',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
    message: { message_id: 'om_5', chat_id: 'oc_grp_1', chat_type: 'group', message_type: 'image', content: '{}' },
  });
  assert.equal(host.accepted.length, 2);

  // duplicate resolves cleanly, retryableFailure throws to WSClient
  nextAccept = () => ({ status: 'duplicate' });
  await sdk.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_1',
    event_id: 'evt_5',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
    message: { message_id: 'om_6', chat_id: 'oc_p2p_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"dup"}' },
  });
  nextAccept = () => ({ status: 'retryableFailure', reason: 'sqlite_busy' });
  await assert.rejects(() => sdk.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_1',
    event_id: 'evt_6',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
    message: { message_id: 'om_7', chat_id: 'oc_p2p_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"retry"}' },
  }), /retryableFailure/);

  await adapter.stop();
});

test('outbound splitText preserves surrogate pairs and sendText handles create, reply, threads, and error mapping', async () => {
  let sendBehavior = async () => ({ code: 0, data: { message_id: 'om_out_1' } });
  let listBehavior = async () => ({ code: 0, data: { items: [{ message_id: 'om_thread_1' }] } });
  const sdk = makeSdkHarness({
    onSend: (...args) => sendBehavior(...args),
    onList: (...args) => listBehavior(...args),
  });
  const host = makeHostHarness();
  const adapter = createFeishuAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011' } } }),
    env: { FEISHU_APP_SECRET: 'secret_123456' },
    loadSdk: sdk.loadSdk,
  });
  await adapter.start();

  const { splitText, sendText } = host.registrations[0].hooks.adapter;
  const emojiText = '😀'.repeat(3005);
  const parts = splitText(emojiText);
  assert.ok(parts.length >= 2);
  assert.equal(parts.join(''), emojiText);
  for (const part of parts) assert.equal(part.isWellFormed(), true);

  const conv = { platform: 'feishu', accountId: 'cli_aabbccddeeff0011', tenantId: 'tenant_1', chatType: 'group', chatId: 'oc_1', threadId: null };
  const sent1 = await sendText({ conversation: conv, replyToMessageId: null, sendId: 'op_1:0', text: 'hi' });
  assert.deepEqual(sent1, { status: 'sent', platformMessageId: 'om_out_1' });
  assert.equal(sdk.calls.create[0].params.receive_id_type, 'chat_id');
  const uuid1 = sdk.calls.create[0].data.uuid;
  assert.match(uuid1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

  const threadConv = { ...conv, threadId: 'omt_1' };
  await sendText({ conversation: threadConv, replyToMessageId: 'om_parent', sendId: 'op_2:0', text: 'reply' });
  assert.equal(sdk.calls.reply[0].data.reply_in_thread, true);

  // Proactive thread send uses message.list + reply_in_thread, never downgrades to chat_id
  await sendText({ conversation: threadConv, replyToMessageId: null, sendId: 'op_3:0', text: 'proactive' });
  assert.equal(sdk.calls.list[0].params.container_id_type, 'thread');
  assert.equal(sdk.calls.reply[1].path.message_id, 'om_thread_1');
  assert.equal(sdk.calls.create.length, 1);

  listBehavior = async () => ({ code: 0, data: { items: [] } });
  const threadFail = await sendText({ conversation: threadConv, replyToMessageId: null, sendId: 'op_4:0', text: 'fail' });
  assert.deepEqual(threadFail, { status: 'failed' });
  assert.equal(sdk.calls.create.length, 1);

  // Error mappings
  sendBehavior = async () => { throw Object.assign(new Error('rate limit'), { response: { status: 429, headers: { 'retry-after': '5' } } }); };
  assert.deepEqual(await sendText({ conversation: conv, replyToMessageId: null, sendId: 'op_5:0', text: 'x' }), { status: 'rate_limited', retryAfterMs: 5000 });

  sendBehavior = async () => { throw Object.assign(new Error('forbidden'), { response: { status: 403 } }); };
  assert.deepEqual(await sendText({ conversation: conv, replyToMessageId: null, sendId: 'op_6:0', text: 'x' }), { status: 'failed' });

  sendBehavior = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
  assert.deepEqual(await sendText({ conversation: conv, replyToMessageId: null, sendId: 'op_7:0', text: 'x' }), { status: 'unknown' });

  await adapter.stop();
});

test('isCurrent, isSensitive, and stop lifecycle behave safely', async () => {
  let enabled = true;
  const sdk = makeSdkHarness();
  const host = makeHostHarness();
  const secret = 'feishu_super_secret_xyz';
  const adapter = createFeishuAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled, appId: 'cli_aabbccddeeff0011' } } }),
    env: { FEISHU_APP_SECRET: secret },
    loadSdk: sdk.loadSdk,
  });
  await adapter.start();

  const { isCurrent, isSensitive } = host.registrations[0].hooks;
  assert.equal(isCurrent(), true);
  assert.equal(isSensitive(`leaked ${secret}`), true);
  assert.equal(isSensitive(Buffer.from(secret).toString('base64')), true);
  assert.equal(isSensitive('normal chat message'), false);

  enabled = false;
  assert.equal(isCurrent(), false);
  await adapter.syncConfig();
  assert.equal(sdk.calls.wsClose.length, 1);
  assert.equal(host.closedCount(), 1);
  assert.equal(adapter.status().status, 'disabled');
});

test('preserves newlines in multi-line text/post and handles async wsClient.start rejection safely', async () => {
  const sdk = makeSdkHarness({ botOpenId: 'ou_bot_1', tenantKey: 't_1' });
  const host = makeHostHarness();
  const logs = [];
  let rejectStart = false;
  const adapter = createFeishuAdapter({
    channelHost: host.channelHost,
    readConfig: () => ({ channels: { feishu: { enabled: true, appId: 'cli_aabbccddeeff0011' } } }),
    env: { FEISHU_APP_SECRET: 'secret_123456' },
    log: (m) => logs.push(m),
    loadSdk: async () => {
      const loaded = await sdk.loadSdk();
      return {
        ...loaded,
        WSClient: class extends loaded.WSClient {
          start(opts) {
            if (rejectStart) return Promise.reject(new Error('ws handshake failed'));
            return super.start(opts);
          }
        },
      };
    },
  });

  await adapter.start();
  await sdk.emitReceive({
    app_id: 'cli_aabbccddeeff0011',
    tenant_key: 't_1',
    event_id: 'evt_nl_1',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
    message: {
      message_id: 'om_nl_1',
      chat_id: 'oc_grp_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 line1\nline2\n  indented' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_1' }, name: 'TestBot' }],
    },
  });
  assert.equal(host.accepted[0].text, 'line1\nline2\n  indented');
  await adapter.stop();

  rejectStart = true;
  await adapter.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(adapter.status().status, 'ws_error');
  assert.match(logs.join('\n'), /wsClient start failed: ws handshake failed/);
  await adapter.stop();
});

test('real @larksuiteoapi/node-sdk EventDispatcher + startChannelHost integration persists incoming message', async (t) => {
  const realSdk = await import('@larksuiteoapi/node-sdk');
  const dir = mkdtempSync(join(tmpdir(), 'feishu-int-'));
  const stateDir = join(dir, 'state');
  const longMemory = createLongMemory({ stateDir });
  const appId = 'cli_aabbccddeeff0011';
  const tenantId = 'tenant_real_1';
  const secret = 'real_integration_secret_123';
  const prevSecret = process.env.FEISHU_TEST_SECRET;
  process.env.FEISHU_TEST_SECRET = secret;

  const config = {
    channels: {
      feishu: {
        enabled: true,
        appId,
        appSecretEnv: 'FEISHU_TEST_SECRET',
        allow: { private: ['ou_alice'] },
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

  let capturedDispatcher = null;
  const adapter = createFeishuAdapter({
    channelHost: host,
    readConfig: () => config,
    env: process.env,
    loadSdk: async () => ({
      ...realSdk,
      Client: class {
        async request(req) {
          if (req.url === '/open-apis/bot/v3/info') return { code: 0, bot: { open_id: 'ou_bot_real' } };
          if (req.url === '/open-apis/tenant/v2/tenant/query') return { code: 0, data: { tenant: { tenant_key: tenantId } } };
          return { code: 0, data: {} };
        }
        im = { v1: { message: { create: async () => ({ code: 0, data: { message_id: 'om_out_real' } }) } } };
      },
      WSClient: class {
        start({ eventDispatcher }) { capturedDispatcher = eventDispatcher; }
        close() {}
      },
    }),
  });

  t.after(async () => {
    await adapter.stop();
    await host.close();
    if (prevSecret === undefined) delete process.env.FEISHU_TEST_SECRET;
    else process.env.FEISHU_TEST_SECRET = prevSecret;
    rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(await adapter.start(), { status: 'running' });
  assert.equal(host.platformState('feishu'), 'registered');
  assert.ok(capturedDispatcher instanceof realSdk.EventDispatcher);

  await capturedDispatcher.invoke({
    schema: '2.0',
    header: {
      event_id: 'evt_real_1',
      event_type: 'im.message.receive_v1',
      create_time: '1700000005000',
      tenant_key: tenantId,
      app_id: appId,
    },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'om_real_1',
        chat_id: 'oc_p2p_real',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello real dispatcher' }),
        create_time: '1700000005000',
      },
    },
  }, { needCheck: false });

  await adapter.stop();
  await host.close();
  const inbox = openChannelInbox(join(stateDir, 'inbox.sqlite'));
  try {
    const binding = inbox.bind({ platform: 'feishu', accountId: appId, tenantId }, () => ({
      platform: 'feishu',
      accountId: appId,
      tenantId,
      ...config.channels.feishu,
    }));
    const pending = binding.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event.message.messageId, 'om_real_1');
    assert.equal(pending[0].event.deliveryRef, 'evt_real_1');
    assert.equal(binding.recheckTask(pending[0].event.messageKey).status, 'lease_required');
  } finally {
    inbox.close();
  }
});
