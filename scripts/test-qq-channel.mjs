import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adapterUrl = new URL('../src/channels/qq.js', import.meta.url);

async function createFixture(config = {}, { unsupportedNotice, fetch } = {}) {
  const { createQQAdapter } = await import(adapterUrl.href);
  const listeners = new Map();
  const sent = [];
  class FakeBot {
    constructor(options) { this.options = options; }
    onPrivateMessage(callback) { listeners.set('private', callback); }
    onGroupMessage(callback) { listeners.set('group', callback); }
    onNotice(kind, callback) {
      if (kind === unsupportedNotice) throw new Error('unsupported notice');
      listeners.set(kind, callback);
    }
    async sendPrivateMessage(id, segment) { return this.send('private', id, segment); }
    async sendGroupMessage(id, segment) { return this.send('group', id, segment); }
    send(kind, id, segment) {
      sent.push({ kind, id, segment });
      return { message_id: 1 };
    }
  }
  const adapter = await createQQAdapter({ wsUrl: 'ws://fixture.invalid', ...config }, {
    fetch,
    loadSdk: async () => ({
      SnowLumaWebSocketClient: FakeBot,
      text: (value) => ({ type: 'text', data: { text: value } }),
    }),
  });
  return { adapter, listeners, sent };
}

test('the QQ transport uses the WebSocket token and keeps the legacy token fallback', async () => {
  const { adapter } = await createFixture({ wsAccessToken: 'ws-fixture', accessToken: 'http-fixture' });
  assert.deepEqual(adapter.bot.options, { url: 'ws://fixture.invalid', accessToken: 'ws-fixture', reconnect: true });
  const fallback = await createFixture({ accessToken: 'http-fixture' });
  assert.equal(fallback.adapter.bot.options.accessToken, 'http-fixture');
});

test('QQ ingress filters self events and passes original OneBot payloads into the existing handler', async () => {
  const { adapter, listeners } = await createFixture();
  const incoming = [];
  adapter.bindIngress({ onMessage: (...args) => incoming.push(args) });
  const privateEvent = { user_id: '2', self_id: 1, message: [{ type: 'image', data: { file: 'fixture' } }] };
  const groupEvent = { group_id: 3, user_id: 2, sender: { user_id: '2' }, self_id: 1 };
  await listeners.get('private')({ user_id: '1', self_id: 1 });
  await listeners.get('group')({ ...groupEvent, sender: { user_id: '1' } });
  await listeners.get('group')({ ...groupEvent, user_id: '1' });
  await listeners.get('private')(privateEvent);
  await listeners.get('group')(groupEvent);
  assert.deepEqual(incoming, [['private', '2', privateEvent], ['group', 3, groupEvent]]);
  assert.equal(incoming[0][2], privateEvent);
});

test('QQ notices and handler errors stay isolated from message ingress', async () => {
  const { adapter, listeners } = await createFixture({}, { unsupportedNotice: 'group_recall' });
  const notices = [];
  const logs = [];
  adapter.bindIngress({
    onMessage: async () => { throw new Error('fixture failure'); },
    onPoke: (event) => notices.push(event),
    onRecall: (event) => notices.push(event),
    log: (...args) => logs.push(args.join(' ')),
  });
  await listeners.get('notify')({ sub_type: 'poke' });
  await listeners.get('friend_recall')({ message_id: 8 });
  await listeners.get('private')({ user_id: 2, self_id: 1 });
  assert.deepEqual(notices, [{ sub_type: 'poke' }, { message_id: 8, notice_type: 'friend_recall' }]);
  assert.match(logs.join('\n'), /group_recall[\s\S]*fixture failure/);
});

test('QQ text transport selects the correct OneBot call and neutralizes CQ syntax', async () => {
  const { adapter, sent } = await createFixture();
  assert.deepEqual(await adapter.sendText('private', '2', '[CQ:image,file=fixture]'), { message_id: 1 });
  await adapter.sendText('group', 3, 'hello');
  assert.deepEqual(sent, [
    { kind: 'private', id: 2, segment: { type: 'text', data: { text: '[CQ：image,file=fixture]' } } },
    { kind: 'group', id: 3, segment: { type: 'text', data: { text: 'hello' } } },
  ]);
});

test('the normal bridge entry point uses the adapter for QQ ingress and text sends', () => {
  const source = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]@snowluma\/sdk|bot\.on(?:Private|Group)Message\(|bot\.send(?:Private|Group)Message\(/);
  assert.match(source, /await createQQAdapter\(cfg\.snowluma\)/);
  assert.match(source, /qq\.bindIngress\(\{/);
  assert.match(source, /qq\.sendText\(/);
});


test('QQ structured text keeps replies, mentions and HTTP authentication in the adapter', async () => {
  const requests = [];
  const { adapter } = await createFixture({ httpUrl: 'http://fixture.invalid/', accessToken: 'http-fixture' }, {
    fetch: async (url, request) => {
      requests.push({ url, request });
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 8 } }) };
    },
  });
  assert.deepEqual(await adapter.sendStructuredText('group', '3', '[CQ:bad]', '-7', '2'), { message_id: 8 });
  assert.equal(requests[0].url, 'http://fixture.invalid/send_group_msg');
  assert.equal(requests[0].request.headers.authorization, 'Bearer http-fixture');
  assert.deepEqual(JSON.parse(requests[0].request.body), { group_id: 3, message: [
    { type: 'reply', data: { id: '-7' } },
    { type: 'at', data: { qq: '2' } },
    { type: 'text', data: { text: '[CQ：bad]' } },
  ] });
  await assert.rejects(() => adapter.sendStructuredText('group', '3', 'hello', '0'), /非零整数/);
  await assert.rejects(() => adapter.sendStructuredText('group', '3', 'hello', null, 'all'), /正整数/);
  assert.equal(requests.length, 1);
});
