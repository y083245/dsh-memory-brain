import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createChannelTextSender } from '../src/core/channel-text-sender.mjs';
import { openChannelOutbox } from '../src/core/outbox-store.mjs';

const telegram = { platform: 'telegram', accountId: '41', tenantId: null };
const feishu = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const topic = { ...telegram, chatType: 'group', chatId: '-100123', threadId: '7' };
const room = { ...feishu, chatType: 'group', chatId: 'oc_fixture', threadId: 'omt_fixture' };
const source = { conversation: topic, actor: { ...telegram, userId: '42' } };
const feishuSource = { conversation: room, actor: { ...feishu, userId: 'ou_fixture' } };
const reply = { conversation: topic, platformChatId: '-100123', messageId: '19' };
const policy = { ...telegram, enabled: true, allow: { groups: ['-100123', '-100124'], senders: ['42'] } };
const feishuPolicy = { ...feishu, enabled: true, allow: { groups: ['oc_fixture'], senders: ['ou_fixture'] } };
const context = { operationId: 'operation-1', authorizationId: 'generation-1', source };

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-text-sender-'));
  let now = 1_800_000_000_000;
  const store = openChannelOutbox(join(dir, 'outbox.sqlite'), { now: () => now, leaseMs: options.leaseMs });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  const adapter = {
    splitText: (text) => text.split(/(?=世界)/u),
    async sendText(request) {
      calls.push(request);
      return options.sendText ? options.sendText(request) : { status: 'sent', platformMessageId: String(90 + calls.length) };
    },
  };
  const sender = createChannelTextSender({
    store,
    authorize: () => policy,
    adapterFor: () => adapter,
    isSensitive: () => false,
    ...options.sender,
  });
  return { ...sender, store, calls, adapter, advance: (ms) => { now += ms; } };
}

test('normalizes the source, exact topic and quoted message before queuing and sending', async (t) => {
  const grants = [];
  const { submitText, deliverNext, calls } = fixture(t, {
    sender: { authorize: (grant, destination) => { grants.push([grant, destination]); return policy; } },
  });
  const queued = submitText({
    ...context, debug: 'fixture',
    source: { ...source, text: 'incoming fixture', actor: { ...source.actor, nickname: 'fixture' } },
  }, { ...topic, unsafeFallback: '-100124' }, '你好，世界', { ...reply, extra: 'fixture' });
  assert.equal(queued.status, 'queued');
  assert.equal(calls.length, 0);
  assert.equal((await deliverNext(telegram)).status, 'pending');
  assert.equal((await deliverNext(telegram)).status, 'sent');
  assert.deepEqual(grants, Array.from({ length: 4 }, () => [context, topic]));
  assert.deepEqual(calls.map(({ conversation, replyToMessageId, text }) => ({ conversation, replyToMessageId, text })), [
    { conversation: topic, replyToMessageId: '19', text: '你好，' },
    { conversation: topic, replyToMessageId: '19', text: '世界' },
  ]);
  assert.deepEqual(calls.map(({ sendId }) => sendId), queued.operation.segments.map(({ sendId }) => sendId));
});

test('rejects a different chat, topic, account or mismatched reply instead of enqueuing', (t) => {
  const { submitText, store } = fixture(t);
  for (const [target, quoted] of [
    [{ ...topic, chatId: '-100124' }, null],
    [{ ...topic, threadId: '8' }, null],
    [{ ...topic, accountId: '43' }, null],
    [topic, { ...reply, conversation: { ...topic, threadId: '8' } }],
    [topic, { ...reply, platformChatId: '-100124' }],
    [topic, '19'],
  ]) {
    assert.ok(['denied', 'invalid'].includes(submitText(context, target, 'fixture', quoted).status));
  }
  assert.equal(store.get(telegram, context.operationId), null);
});

test('a source-free grant can bind only an explicitly trusted group without a quote', async (t) => {
  const { submitText, deliverNext, calls } = fixture(t, {
    sender: {
      authorize: ({ authorizationId }, destination) =>
        authorizationId === 'group-grant' && destination.chatId === '-100123' && destination.threadId === '7' ? policy : null,
    },
  });
  const groupContext = { ...context, authorizationId: 'group-grant', source: null };
  assert.equal(submitText(groupContext, { ...topic, chatId: '-100124' }, 'fixture').status, 'denied');
  assert.equal(submitText(groupContext, { ...topic, threadId: '8' }, 'fixture').status, 'denied');
  assert.equal(submitText(groupContext, topic, 'fixture', reply).status, 'denied');
  assert.equal(submitText(groupContext, topic, 'fixture').status, 'queued');
  assert.equal((await deliverNext(telegram)).status, 'sent');
  assert.equal(calls[0].replyToMessageId, null);
});

test('checks the complete text for known tokens and disguised credentials before splitting', (t) => {
  const knownToken = 'abcdef0123456789'.repeat(2);
  let splits = 0;
  const { submitText, store } = fixture(t, {
    sender: {
      isSensitive: (text) => text.includes(knownToken),
      adapterFor: () => ({ splitText() { splits++; }, sendText() {} }),
    },
  });
  assert.equal(submitText(context, topic, `fixture ${knownToken} tail`).status, 'sensitive');
  assert.equal(submitText(context, topic, 'ｔｏｋｅｎ：fixture').status, 'sensitive');
  assert.equal(splits, 0);
  assert.equal(store.get(telegram, context.operationId), null);
});

test('requires an exact-token checker and rejects unsafe text or segmentation', (t) => {
  const { store, submitText } = fixture(t, {
    sender: {
      adapterFor: () => ({ splitText: () => ['a\ud83d', '\ude00b'], sendText() {} }),
    },
  });
  assert.throws(() => createChannelTextSender({ store, authorize: () => policy, adapterFor: () => null }), TypeError);
  assert.equal(submitText(context, topic, 'a😀b').status, 'unavailable');
  for (const invalid of ['', ' ', 'a\u0000b', '\ud83d', 'x'.repeat(1024 * 1024 + 1)]) {
    assert.equal(submitText(context, topic, invalid).status, 'invalid');
  }
  assert.equal(store.get(telegram, context.operationId), null);
});

test('requires the actual segment contents to reproduce the audited text', (t) => {
  const { submitText, store } = fixture(t, {
    sender: {
      adapterFor: () => ({
        splitText: () => Object.assign(['altered fixture'], { join: () => 'fixture' }),
        sendText() {},
      }),
    },
  });
  assert.equal(submitText(context, topic, 'fixture').status, 'unavailable');
  assert.equal(store.get(telegram, context.operationId), null);
});

test('rechecks current authorization after selecting the adapter and stops unsent segments', async (t) => {
  let currentPolicy = policy;
  let selectingForDelivery = false;
  const { submitText, deliverNext, adapter, calls } = fixture(t, {
    sender: {
      authorize: () => currentPolicy,
      adapterFor() {
        if (selectingForDelivery) currentPolicy = { ...policy, deny: { senders: ['42'] } };
        return adapter;
      },
    },
  });
  assert.equal(submitText(context, topic, '你好，世界', reply).status, 'queued');
  assert.equal((await deliverNext(telegram)).status, 'pending');
  selectingForDelivery = true;
  const result = await deliverNext(telegram);
  assert.equal(result.status, 'cancelled');
  assert.equal(calls.length, 1);
  assert.deepEqual(result.segments.map(({ status, platformMessageId }) => [status, platformMessageId]), [
    ['sent', '91'], ['cancelled', null],
  ]);
});

test('invokes the adapter in the same turn as the final authorization check', async (t) => {
  let current = true;
  let delivering = false;
  const { submitText, deliverNext, calls } = fixture(t, {
    sender: {
      authorize() {
        if (delivering) queueMicrotask(() => { current = false; });
        return current ? policy : null;
      },
    },
    sendText() {
      assert.equal(current, true);
      return { status: 'sent', platformMessageId: '91' };
    },
  });
  assert.equal(submitText(context, topic, 'fixture').status, 'queued');
  delivering = true;
  assert.equal((await deliverNext(telegram)).status, 'sent');
  assert.equal(calls.length, 1);
});

test('does not invoke the adapter if authorization checking outlasts the claim lease', async (t) => {
  let delivering = false;
  const { submitText, deliverNext, advance, calls } = fixture(t, {
    leaseMs: 10,
    sender: {
      authorize() {
        if (delivering) advance(10);
        return policy;
      },
    },
  });
  assert.equal(submitText(context, topic, 'fixture').status, 'queued');
  delivering = true;
  assert.equal((await deliverNext(telegram)).status, 'unknown');
  assert.equal(calls.length, 0);
  assert.equal(await deliverNext(telegram), null);
});

test('honors confirmed rate limits and attempts the same segment at most three times', async (t) => {
  const { submitText, deliverNext, advance, calls } = fixture(t, {
    sendText: () => ({ status: 'rate_limited', retryAfterMs: 250 }),
  });
  assert.equal(submitText(context, topic, '你好，世界').status, 'queued');
  assert.equal((await deliverNext(telegram)).status, 'pending');
  advance(249);
  assert.equal(await deliverNext(telegram), null);
  advance(1);
  assert.equal((await deliverNext(telegram)).status, 'pending');
  advance(250);
  const result = await deliverNext(telegram);
  assert.equal(result.status, 'failed');
  assert.equal(result.segments[0].attempts, 3);
  assert.deepEqual(calls.map(({ text }) => text), ['你好，', '你好，', '你好，']);
  assert.equal(new Set(calls.map(({ sendId }) => sendId)).size, 1);
  advance(250);
  assert.equal(await deliverNext(telegram), null);
});

test('fails confirmed rate limits with unavailable, invalid or excessive delays', async (t) => {
  for (const retryAfterMs of [undefined, -1, Infinity, 86_400_001, '250']) {
    await t.test(String(retryAfterMs), async (subtest) => {
      const { submitText, deliverNext, calls } = fixture(subtest, {
        sendText: () => ({ status: 'rate_limited', retryAfterMs }),
      });
      assert.equal(submitText(context, topic, 'fixture').status, 'queued');
      assert.equal((await deliverNext(telegram)).status, 'failed');
      assert.equal(await deliverNext(telegram), null);
      assert.equal(calls.length, 1);
    });
  }
});

test('ambiguous failures stop remaining segments and preserve confirmed platform IDs', async (t) => {
  for (const [name, response] of [
    ['thrown error', () => { throw new Error('fixture error'); }],
    ['malformed success', () => ({ status: 'sent', platformMessageId: 'om_wrong_platform' })],
    ['mismatched receipt chat', () => ({ status: 'sent', platformMessageId: '92', platformChatId: '-100456' })],
    ['mismatched receipt topic', () => ({ status: 'sent', platformMessageId: '92', threadId: '42' })],
    ['unknown status', () => ({ status: 'unexpected' })],
    ['empty response', () => undefined],
  ]) {
    await t.test(name, async (subtest) => {
      const { submitText, deliverNext, calls } = fixture(subtest, {
        sendText: ({ text }) => text === '你好，' ? { status: 'sent', platformMessageId: '91' } : response(),
      });
      assert.equal(submitText(context, topic, '你好，世界世界').status, 'queued');
      assert.equal((await deliverNext(telegram)).status, 'pending');
      const result = await deliverNext(telegram);
      assert.equal(result.status, 'unknown');
      assert.deepEqual(result.segments.map(({ platformMessageId }) => platformMessageId), ['91', null, null]);
      assert.equal(await deliverNext(telegram), null);
      assert.equal(calls.length, 2);
    });
  }
});

test('times out a request that ignores cancellation and discards its late acknowledgement', async (t) => {
  let acknowledge;
  const { submitText, deliverNext, calls, store } = fixture(t, {
    sender: { requestTimeoutMs: 10 },
    sendText: () => new Promise((resolve) => { acknowledge = resolve; }),
  });
  assert.equal(submitText(context, topic, '你好，世界').status, 'queued');
  const result = await deliverNext(telegram);
  assert.equal(result.status, 'unknown');
  assert.equal(calls[0].signal.aborted, true);
  acknowledge({ status: 'sent', platformMessageId: '91' });
  await Promise.resolve();
  assert.deepEqual(store.get(telegram, context.operationId), result);
  assert.equal(await deliverNext(telegram), null);
  assert.equal(calls.length, 1);
});

test('limits the platform timeout to the remaining claim time', async (t) => {
  let delivering = false;
  let lateTimer;
  t.after(() => clearTimeout(lateTimer));
  const { submitText, deliverNext, advance, calls } = fixture(t, {
    leaseMs: 1_000,
    sender: {
      requestTimeoutMs: 1_000,
      authorize() {
        if (delivering) advance(990);
        return policy;
      },
    },
    sendText: () => new Promise((resolve) => {
      lateTimer = setTimeout(() => resolve({ status: 'sent', platformMessageId: '91' }), 50);
    }),
  });
  assert.equal(submitText(context, topic, 'fixture').status, 'queued');
  delivering = true;
  assert.equal((await deliverNext(telegram)).status, 'unknown');
  assert.equal(calls[0].signal.aborted, true);
});

test('selects the adapter using the canonical account including the Feishu tenant', async (t) => {
  const accounts = [];
  const adapters = new Map([
    ['telegram', { splitText: (text) => [text], sendText: async () => ({ status: 'sent', platformMessageId: '91' }) }],
    ['feishu', { splitText: (text) => [text], sendText: async () => ({ status: 'sent', platformMessageId: 'om_fixture' }) }],
  ]);
  const { submitText, deliverNext } = fixture(t, {
    sender: {
      authorize: (_grant, destination) => destination.platform === 'telegram' ? policy : feishuPolicy,
      adapterFor(account) { accounts.push(account); return adapters.get(account.platform); },
    },
  });
  assert.equal(submitText({ ...context, source: feishuSource }, room, 'fixture').status, 'queued');
  assert.equal(submitText(context, topic, 'fixture').status, 'queued');
  assert.equal(await deliverNext({ ...feishu, tenantId: 'tenant_b' }), null);
  assert.equal((await deliverNext({ platform: 'telegram', accountId: '41' })).segments[0].platformMessageId, '91');
  assert.equal((await deliverNext(feishu)).segments[0].platformMessageId, 'om_fixture');
  assert.deepEqual(accounts, [feishu, telegram, telegram, feishu]);
});
