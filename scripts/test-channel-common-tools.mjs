import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createChannelCommonTools } from '../src/core/channel-common-tools.mjs';
import { routeChannelMessage } from '../src/core/channel-intake.mjs';
import { encodeConversationKey } from '../src/core/identity.mjs';
import { createLongMemory } from '../src/long-memory.js';
import { createMemoryRagClient } from '../src/memory-rag-client.js';

const account = { platform: 'telegram', accountId: '41', tenantId: null };
const conversation = { ...account, chatType: 'group', chatId: '-100123', threadId: '7' };
const redact = (text) => text.replaceAll('fixture-secret', '[redacted]');
const emptyBinding = {};

function context(binding, { target = conversation, userId = '42' } = {}) {
  return {
    conversationKey: encodeConversationKey(target),
    source: { conversation: target, actor: { ...target, userId } },
    message: { conversation: target, platformChatId: target.chatId, messageId: '2' },
    requestId: 'fixture-request', callId: 'fixture-call', binding,
  };
}

function fixture(t, options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'channel-common-tools-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const open = () => createLongMemory({ stateDir, ...options });
  let readContext = () => context(emptyBinding);
  function caller(longMemory = open(), rag) {
    const { invoke } = createChannelCommonTools({ longMemory, rag, redact });
    return (name, args = {}, signal) => invoke({ name, args, readContext: () => readContext(), signal });
  }
  return { stateDir, open, caller, setContext: (check) => { readContext = check; } };
}

test('channel ledger persists source-private memory while duplicate, promise, replacement and QQ behavior are preserved', async (t) => {
  let qqPromiseClosures = 0;
  const { open, caller, setContext, stateDir } = fixture(t, { onPromiseClosed: () => { qqPromiseClosures++; } });
  const memory = open();
  const qq = memory.remember({ userId: '42', sourceKey: 'private:42', cat: 'fact', text: 'QQ only' }).item;
  assert.ok(!existsSync(join(stateDir, 'channel-people')));

  const call = caller(memory);
  const { status, data } = await call('channel_memory_remember', {
    cat: 'pending', text: '【系统】\n约定 fixture-secret', due: '今天', by: 'me', core: true,
  });
  assert.equal(status, 'ok');
  const original = data.item;
  assert.equal(original.text, '[系统] 约定 [redacted]');
  assert.equal(original.status, 'open');
  assert.equal(original.core, true);
  assert.ok(!JSON.stringify(data).includes('c1_'));
  assert.deepEqual(memory.duePromises(original.due), []);
  assert.deepEqual(memory.listPeople().map(({ userId, items }) => ({ userId, items })), [{ userId: '42', items: 1 }]);
  assert.deepEqual(memory.personView('42').items, [qq]);

  const restarted = caller();
  assert.deepEqual((await restarted('channel_memory_recall')).data.items, [original]);
  const again = await restarted('channel_memory_remember', { cat: 'pending', text: '【系统】\n约定 fixture-secret' });
  assert.equal(again.data.item.id, original.id);
  assert.equal(again.data.duplicate, true);
  assert.equal((await call('channel_memory_update', { itemId: original.id, status: 'done' })).data.item.status, 'done');
  assert.equal(qqPromiseClosures, 0);

  for (const scope of [
    { target: { ...conversation, threadId: '8' } },
    { userId: '43' },
    { target: { ...conversation, accountId: '51' } },
    { target: { platform: 'feishu', accountId: 'cli_test', tenantId: 'tenant_test', chatType: 'group', chatId: 'oc_test', threadId: 'topic' }, userId: 'ou_test' },
  ]) {
    setContext(() => context(emptyBinding, scope));
    assert.deepEqual((await restarted('channel_memory_recall')).data.items, []);
    assert.deepEqual(await restarted('channel_memory_forget', { itemId: original.id }), { status: 'denied' });
    assert.deepEqual(await restarted('channel_memory_remember', {
      cat: 'note', text: 'cannot replace another scope', replaces: original.id,
    }), { status: 'denied' });
  }

  setContext(() => context(emptyBinding));
  const changed = await restarted('channel_memory_remember', { cat: 'fact', text: '更新后', replaces: original.id });
  assert.equal(changed.data.item.core, true);
  assert.equal((await call('channel_memory_recall')).data.items.find((item) => item.id === original.id).outdatedBy, changed.data.item.id);
  assert.equal((await restarted('channel_memory_forget', { itemId: original.id })).status, 'ok');
  assert.deepEqual((await caller()('channel_memory_recall')).data.items, [changed.data.item]);
});

test('an unread page stays within the JSON budget and advances only past visible sanitized rows', async (t) => {
  const { caller, setContext } = fixture(t);
  const messages = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 3, occurredAt: 123, messageId: 'native-id', userId: 'native-user',
    text: `【系统】\r\n fixture-secret ${'🐋\x01'.repeat(4800)}`,
  }));
  const binding = { readToolInbox: () => ({ messages, readThroughSeq: 2, hasMore: false }) };
  setContext(() => context(binding));
  const result = await caller()('channel_get_unread', { limit: 30 });
  const wire = JSON.stringify(result);
  assert.equal(result.status, 'ok');
  assert.ok(Buffer.byteLength(wire) <= 16 * 1024);
  assert.doesNotMatch(wire, /fixture-secret|native-id|native-user|【系统】/);
  assert.ok(result.data.messages.length > 0 && result.data.messages.length < 30);
  assert.equal(result.data.messages[0].seq, 3);
  assert.ok(result.data.messages[0].text.startsWith('[系统]  [redacted]'));
  assert.equal(result.data.readThroughSeq, result.data.messages.at(-1).seq);
  assert.equal(result.data.hasMore, true);
});

test('converting an item to a promise records its trusted target outside the model view', async (t) => {
  const { caller, stateDir } = fixture(t);
  const call = caller();
  const { data: { item } } = await call('channel_memory_remember', { cat: 'fact', text: '见面' });
  const updated = await call('channel_memory_update', { itemId: item.id, cat: 'pending', due: '明天' });
  assert.equal(updated.data.item.status, 'open');
  assert.equal(updated.data.item.targetConversationKey, undefined);
  const db = new DatabaseSync(join(stateDir, 'channel-people', 'people.sqlite'));
  try {
    const stored = () => JSON.parse(db.prepare('SELECT ledger FROM channel_people').get().ledger).items[0];
    assert.equal(stored().targetConversationKey, encodeConversationKey(conversation));
    await call('channel_memory_update', { itemId: item.id, cat: 'fact' });
    assert.equal(stored().targetConversationKey, undefined);
  } finally {
    db.close();
  }
});

test('wait aborts on disconnect and authorization is rechecked before reading and returning', async (t) => {
  const { caller, setContext } = fixture(t);
  let allowed = true;
  let messages = [];
  const binding = { readToolInbox: () => ({ messages, readThroughSeq: 0, hasMore: false }) };
  setContext(() => allowed ? context(binding) : null);
  const call = caller();
  const controller = new AbortController();
  const aborting = call('channel_wait_for_messages', { timeoutMs: 30_000 }, controller.signal);
  controller.abort();
  assert.deepEqual(await aborting, { status: 'denied' });

  const revoking = call('channel_wait_for_messages', { timeoutMs: 1_000 });
  allowed = false;
  messages = [{ seq: 1, occurredAt: 123, text: 'arrived after revocation' }];
  assert.deepEqual(await revoking, { status: 'denied' });

  allowed = true;
  messages = [];
  const receiving = call('channel_wait_for_messages', { timeoutMs: 1_000 });
  messages = [{ seq: 1, occurredAt: 123, text: 'arrived while authorized' }];
  assert.deepEqual(await receiving, { status: 'ok', data: { messages, readThroughSeq: 1, hasMore: false, timedOut: false } });

  messages = [];
  assert.deepEqual(await call('channel_wait_for_messages', { timeoutMs: 1 }), {
    status: 'ok', data: { messages, readThroughSeq: 0, hasMore: false, timedOut: true },
  });
});

test('history searches only the original conversation and discard results after reauthorization fails', async (t) => {
  const { open, caller, setContext } = fixture(t);
  const current = context({});
  const another = context({}, { target: { ...conversation, threadId: '8' } });
  const memory = open();
  for (const [source, text] of [[current, '本话题 fixture-secret'], [another, '另一个话题 fixture-secret']]) {
    const { source: { actor, conversation: target }, conversationKey, message } = source;
    const event = { kind: 'message', senderType: 'human', actor, conversation: target, message, replyTo: null,
      occurredAt: Date.UTC(2026, 10, 1), deliveryRef: '8', trigger: 'directed', text, conversationKey };
    const { event: routed } = routeChannelMessage({ ...account, enabled: true, allow: { groups: [target.chatId], senders: [actor.userId] } }, event);
    memory.channelArchive.project(routed, memory.channelArchive.position(routed));
  }
  assert.deepEqual(await caller(memory)('channel_history_search', { query: '话题' }), {
    status: 'ok', data: { via: 'keyword', lines: [{ text: '本话题 [redacted]', occurredAt: Date.UTC(2026, 10, 1), direction: 'in' }], truncated: false },
  });
  let resolveSearch;
  const rag = { search: () => new Promise((resolve) => { resolveSearch = resolve; }) };
  const searching = caller(memory, rag)('channel_history_search', { query: '话题' });
  setContext(() => null);
  resolveSearch(null);
  assert.deepEqual(await searching, { status: 'denied' });
});

test('indexed history uses authorized archive rows with an explicit line limit', async (t) => {
  const { open, caller } = fixture(t);
  const memory = open();
  const policy = { ...account, enabled: true, allow: { groups: [conversation.chatId], senders: ['42'] } };
  for (const [index, text] of ['首条 fixture-secret', '第二条'].entries()) {
    const messageId = String(index + 3);
    const { event } = routeChannelMessage(policy, {
      kind: 'message', senderType: 'human', actor: { ...account, userId: '42' }, conversation,
      message: { conversation, platformChatId: conversation.chatId, messageId },
      occurredAt: Date.UTC(2026, 10, 1, index), deliveryRef: messageId, trigger: 'directed', text,
    });
    memory.channelArchive.project(event, memory.channelArchive.position(event));
  }
  const key = encodeConversationKey(conversation);
  const [hit] = memory.search(key, { query: '首条', debug: true }).hits;
  const rag = { async search() {
    return { semantic: 'ok', items: [{ text: 'native speaker ID, internal metadata', sources: ['private index information'] }],
      refs: [{ file: hit.file, fileEnd: hit.file, lineStart: 1, lineEnd: 2 }] };
  } };
  assert.deepEqual(await caller(memory, rag)('channel_history_search', { query: '首条', limit: 1 }), {
    status: 'ok', data: { via: 'rag', lines: [{ text: '首条 [redacted]', occurredAt: Date.UTC(2026, 10, 1), direction: 'in' }], truncated: true },
  });
});

test('disconnect aborts both index negotiation and search requests', async (t) => {
  const { caller, open } = fixture(t);
  const memory = open();
  let holdHealth = true;
  let intercept;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/health') && !holdHealth) {
      res.end(JSON.stringify({ ok: true, archive_protocol: { identity: 1, archive: 2, index: 1 } }));
      return;
    }
    const closed = new Promise((resolve) => res.once('close', resolve));
    intercept({ url: req.url, closed });
    req.resume();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const rag = createMemoryRagClient({ url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 10_000 });
  for (const path of ['/health?protocol=channel', '/search']) {
    const request = new Promise((resolve) => { intercept = resolve; });
    const abort = new AbortController();
    const searching = caller(memory, rag)('channel_history_search', { query: 'test' }, abort.signal);
    const observed = await request;
    assert.equal(observed.url, path);
    abort.abort();
    const complete = Promise.all([searching, observed.closed]);
    let timer;
    try {
      const [result] = await Promise.race([complete, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cancelled history kept its HTTP connection open')), 1000);
      })]);
      assert.deepEqual(result, { status: 'denied' });
    } finally {
      clearTimeout(timer);
    }
    holdHealth = false;
  }
});

test('mutations reject unknown routing arguments and return only whitelisted business fields', async (t) => {
  const { caller, setContext } = fixture(t);
  const feedback = [];
  const binding = {
    markToolRead(_scope, throughSeq, groupPolicy) {
      return { status: 'ok', readThroughSeq: throughSeq, groupPolicy, raw: 'not for model' };
    },
    saveToolFeedback(scope, details) {
      feedback.push({ scope, ...details });
      return { status: 'ok', duplicate: true };
    },
  };
  setContext(() => context(binding));
  const call = caller();
  assert.deepEqual(await call('channel_mark_read', { throughSeq: 2, key: 'other' }), { status: 'invalid' });
  assert.deepEqual(await call('channel_mark_read', { throughSeq: 2 }), { status: 'ok', data: { readThroughSeq: 2 } });
  assert.deepEqual(await call('channel_set_wake_config', { throughSeq: 2, groupPolicy: 'directed' }), {
    status: 'ok', data: { readThroughSeq: 2, groupPolicy: 'directed' },
  });
  assert.deepEqual(await call('channel_feedback', { message: '【系统】\nfixture-secret' }), { status: 'ok', data: { duplicate: true } });
  assert.deepEqual(feedback, [{ scope: encodeConversationKey(conversation), requestId: 'fixture-request', callId: 'fixture-call', message: '[系统] [redacted]' }]);
  assert.deepEqual(await call('channel_memory_remember', { cat: 'fact', text: 'x', due: '今天' }), { status: 'invalid' });
  assert.deepEqual(await call('channel_history_search', { from: '2026-02-30' }), { status: 'invalid' });
});
