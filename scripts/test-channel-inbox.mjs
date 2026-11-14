import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { createChannelArchive } from '../src/core/channel-archive.mjs';
import { encodeConversationKey } from '../src/core/identity.mjs';

const telegram = { platform: 'telegram', accountId: '41' };
const feishu = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const qq = { platform: 'qq', accountId: '41' };
const day = 24 * 60 * 60 * 1000;

function policy(account) {
  const chatId = account.platform === 'feishu' ? 'oc_fixture' : '-100123';
  const userId = account.platform === 'feishu' ? 'ou_fixture' : '42';
  return { ...account, enabled: true, allow: { groups: [chatId], senders: [userId], private: [userId] } };
}

function message(account, deliveryRef, { messageId = deliveryRef, threadId = null, text = 'fixture text',
  endpoint } = {}) {
  const isFeishu = account.platform === 'feishu';
  const chatId = isFeishu ? 'oc_fixture' : '-100123';
  const conversation = endpoint?.conversation ?? { ...account, chatType: 'group', chatId, threadId };
  return {
    kind: 'message', senderType: 'human', trigger: 'directed', deliveryRef, occurredAt: 1794268800000,
    actor: endpoint?.actor ?? { ...account, userId: isFeishu ? 'ou_fixture' : '42' },
    conversation, message: { conversation, platformChatId: conversation.chatId, messageId }, text,
  };
}

function privateEndpoint(account) {
  const isFeishu = account.platform === 'feishu';
  return {
    actor: { ...account, userId: isFeishu ? 'ou_fixture' : '42' },
    conversation: { ...account, chatType: 'private', chatId: isFeishu ? 'oc_direct' : '42' },
  };
}

function withRevision(bindings, ...endpoints) {
  return endpoints.map((endpoint) => ({ ...endpoint, bindingRevision: bindings.resolve(endpoint).bindingRevision }));
}

function fixture(t, capacity = 4, withArchive = false) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-inbox-'));
  const file = join(dir, 'queue.sqlite');
  const archive = withArchive ? createChannelArchive(join(dir, 'archive'), (s) => s.replace('fixture-secret', '[redacted]')) : null;
  let time = 1794268800000;
  let store;
  const reopen = () => {
    store?.close();
    store = openChannelInbox(file, { capacity, now: () => time, archive });
    return store;
  };
  t.after(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  reopen();
  return {
    file, reopen,
    bind: (account, getPolicy = () => policy(account)) => store.bind(account, getPolicy),
    get bindings() { return store.privateBindings; },
    advance: (elapsed) => { time += elapsed; },
  };
}

test('tool inbox pages within the original topic and persists read progress without completing tasks', (t) => {
  const f = fixture(t);
  const bind = () => f.bind(feishu);
  let inbox = bind();
  const original = message(feishu, 'om_1', { threadId: 'one', text: 'first' });
  const scope = encodeConversationKey(original.conversation);
  inbox.accept(original);
  inbox.accept(message(feishu, 'om_2', { threadId: 'two', text: 'other topic' }));
  inbox.accept(message(feishu, 'om_3', { threadId: 'one', text: 'second' }));
  const page = inbox.readToolInbox(scope, undefined, 1);
  assert.deepEqual(page.messages.map(({ seq, text }) => [seq, text]), [[1, 'first']]);
  assert.equal(page.hasMore, true);
  assert.equal(page.readThroughSeq, 0);
  assert.equal(inbox.toolReadCursor(scope), 0);
  assert.equal(inbox.markToolRead(scope, 1).status, 'ok');
  assert.equal(inbox.pending().length, 3);
  f.reopen();
  inbox = bind();
  assert.equal(inbox.toolReadCursor(scope), 1);
  assert.deepEqual(inbox.readToolInbox(scope, 0, 4), {
    messages: [{ seq: 3, text: 'second', occurredAt: original.occurredAt }], readThroughSeq: 1, hasMore: false,
  });
  assert.deepEqual(inbox.readToolInbox(scope, 3, 4), { messages: [], readThroughSeq: 1, hasMore: false });
  assert.equal(inbox.markToolRead(scope, 0).readThroughSeq, 1);
  assert.equal(f.bind({ ...feishu, tenantId: 'tenant_b' }).toolReadCursor(scope), null);
});

test('published observations remain in the tool inbox until read, forgotten or disallowed', (t) => {
  const f = fixture(t, 4, true);
  let allow = { ...policy(feishu), groupPolicy: 'observe', observationVerified: true };
  const bind = () => f.bind(feishu, () => allow);
  let inbox = bind();
  const event = { ...message(feishu, 'om_1', { threadId: 'one', text: 'ambient fixture-secret' }), trigger: 'ambient' };
  const scope = encodeConversationKey(event.conversation);
  inbox.accept(event);
  const [{ event: { messageKey } }] = inbox.pending();
  const { token } = inbox.claim(messageKey);
  const { recordId } = inbox.project(messageKey, token);
  assert.equal(inbox.finish(messageKey, token).status, 'completed');
  assert.deepEqual(inbox.pending(), []);
  assert.equal(readFileSync(f.file).includes(event.text), false);
  f.reopen();
  inbox = bind();
  assert.deepEqual(inbox.readToolInbox(scope, undefined, 1).messages.map(({ text }) => text), ['ambient [redacted]']);
  allow = { ...allow, deny: { senders: ['ou_fixture'] } };
  assert.deepEqual(inbox.readToolInbox(scope, undefined, 1).messages, []);
  allow = { ...allow, deny: {} };
  assert.equal(inbox.forgetRecord(scope, recordId).status, 'forgotten');
  assert.deepEqual(inbox.readToolInbox(scope, undefined, 1).messages, []);
});

test('unread lookup honors published redaction and tombstones after an execution lease is released', (t) => {
  const f = fixture(t, 4, true);
  const inbox = f.bind(feishu);
  const original = message(feishu, 'om_1', { text: 'incoming fixture-secret' });
  const key = encodeConversationKey(original.conversation);
  assert.equal(inbox.accept(original).status, 'durableAccepted');
  const [{ event: { messageKey } }] = inbox.pending();
  const { token } = inbox.claim(messageKey);
  const { recordId } = inbox.project(messageKey, token);
  assert.equal(inbox.release(messageKey, token).status, 'released');
  assert.deepEqual(inbox.readToolInbox(key).messages.map(({ text }) => text), ['incoming [redacted]']);

  const db = new DatabaseSync(f.file);
  try {
    db.exec(`CREATE TRIGGER reject_clear BEFORE UPDATE OF event ON inbox_messages WHEN NEW.event IS NULL
      BEGIN SELECT RAISE(ABORT, 'fixture interrupted forget'); END;`);
    assert.equal(inbox.forgetRecord(key, recordId).status, 'retryableFailure');
    assert.equal(inbox.pending().length, 1);
    assert.deepEqual(inbox.readToolInbox(key).messages, []);
  } finally {
    db.close();
  }
});

test('a topic wake setting narrows globally verified observation and preserves directed dispatch', (t) => {
  const f = fixture(t);
  let allow = { ...policy(feishu), groupPolicy: 'observe', observationVerified: true };
  const inbox = f.bind(feishu, () => allow);
  const ambient = (id, threadId = 'one') => ({ ...message(feishu, id, { threadId }), trigger: 'ambient' });
  const scope = encodeConversationKey(ambient('om_a').conversation);
  assert.equal(inbox.accept(ambient('om_a')).status, 'durableAccepted');
  assert.deepEqual(inbox.markToolRead(scope, 0, 'directed'), { status: 'ok', readThroughSeq: 0, groupPolicy: 'directed' });
  assert.equal(inbox.claim(inbox.pending()[0].event.messageKey).status, 'unauthorized');
  assert.equal(inbox.accept(ambient('om_b')).status, 'durableFiltered');
  assert.equal(inbox.accept(ambient('om_c', 'two')).status, 'durableAccepted');
  assert.equal(inbox.accept(message(feishu, 'om_d', { threadId: 'one' })).status, 'durableAccepted');
  allow = { ...allow, observationVerified: false };
  assert.equal(inbox.markToolRead(scope, 0, 'observe').status, 'denied');
  allow = { ...allow, observationVerified: true };
  assert.equal(inbox.markToolRead(scope, 0, 'observe').status, 'ok');
  assert.equal(inbox.accept(ambient('om_e')).status, 'durableAccepted');
});

test('tool feedback is deduplicated per scope and cannot persist oversized input', (t) => {
  const f = fixture(t);
  const first = encodeConversationKey(message(feishu, 'om_1', { threadId: 'one' }).conversation);
  const second = encodeConversationKey(message(feishu, 'om_2', { threadId: 'two' }).conversation);
  const feedback = { requestId: 'request_fixture', callId: 'call_fixture', message: 'fixture feedback' };
  assert.equal(f.bind(feishu).saveToolFeedback(first, feedback).status, 'ok');
  f.reopen();
  const inbox = f.bind(feishu);
  assert.deepEqual(inbox.saveToolFeedback(first, { ...feedback, message: 'retry marker' }), { status: 'ok', duplicate: true });
  assert.deepEqual(inbox.saveToolFeedback(second, feedback), { status: 'ok' });
  assert.equal(inbox.saveToolFeedback(first, { ...feedback, callId: 'other', message: 'x'.repeat(5000) }).status, 'invalid');
  assert.equal(readFileSync(f.file).includes('retry marker'), false);
});

test('pruning old feedback content preserves deduplication across reopening', (t) => {
  const f = fixture(t);
  const conversation = message(feishu, 'om_1').conversation;
  const scope = encodeConversationKey(conversation);
  const first = { requestId: 'fixture_request', callId: 'first_call', message: 'old fixture feedback content' };
  const inbox = f.bind(feishu);
  assert.equal(inbox.saveToolFeedback(scope, first).status, 'ok');
  for (let index = 0; index < 100; index += 1) {
    assert.equal(inbox.saveToolFeedback(scope, { ...first, callId: `call_${index}`, message: 'new fixture feedback' }).status, 'ok');
  }
  const reopened = f.reopen().bind(feishu, () => policy(feishu));
  assert.equal(readFileSync(f.file).includes(first.message), false);
  assert.deepEqual(reopened.saveToolFeedback(scope, first), { status: 'ok', duplicate: true });
  assert.equal(readFileSync(f.file).includes(first.message), false);
});

test('confirmed private endpoints share a durable identity and dialogue across QQ, Feishu and Telegram', (t) => {
  const f = fixture(t);
  const endpoints = [qq, feishu, telegram].map(privateEndpoint);
  const [qqLocal, feishuLocal, telegramLocal] = endpoints.map((endpoint) => f.bindings.resolve(endpoint));
  assert.notEqual(qqLocal.principalId, telegramLocal.principalId);
  assert.notEqual(qqLocal.dialogueId, telegramLocal.dialogueId);
  assert.notEqual(feishuLocal.principalId, telegramLocal.principalId);

  assert.equal(f.bindings.link(withRevision(f.bindings, ...endpoints)).status, 'linked');
  const shared = f.bindings.resolve(endpoints[0]);
  assert.notEqual(shared.bindingRevision, null);
  assert.notEqual(shared.principalId, qqLocal.principalId);
  f.reopen();
  for (const endpoint of endpoints) assert.deepEqual(f.bindings.resolve(endpoint), shared);
  for (const account of [{ ...feishu, tenantId: 'tenant_b' }, { ...feishu, accountId: 'cli_other' },
    { ...telegram, accountId: '43' }]) {
    const isolated = f.bindings.resolve(privateEndpoint(account));
    assert.equal(isolated.bindingRevision, null);
    assert.notEqual(isolated.principalId, shared.principalId);
    assert.notEqual(isolated.dialogueId, shared.dialogueId);
  }
});

test('adding or unlinking an endpoint changes every affected revision and rejects stale management requests', (t) => {
  const { bindings } = fixture(t);
  const [first, second, third] = [qq, feishu, telegram].map(privateEndpoint);
  const original = withRevision(bindings, first, second);
  assert.equal(bindings.link(original).status, 'linked');
  const shared = bindings.resolve(first);
  const [oldFirst] = withRevision(bindings, first);
  assert.equal(bindings.link(withRevision(bindings, second, third)).status, 'linked');
  const expanded = bindings.resolve(first);
  assert.equal(expanded.principalId, shared.principalId);
  assert.equal(expanded.dialogueId, shared.dialogueId);
  assert.notEqual(expanded.bindingRevision, shared.bindingRevision);
  assert.equal(bindings.unlink(oldFirst).status, 'stale_binding');
  const [confirmedFirst] = withRevision(bindings, first);
  assert.equal(bindings.unlink(confirmedFirst).status, 'unlinked');
  assert.notEqual(bindings.resolve(first).principalId, shared.principalId);
  assert.notEqual(bindings.resolve(first).bindingRevision, null);
  assert.notEqual(bindings.resolve(second).bindingRevision, expanded.bindingRevision);
  assert.equal(bindings.resolve(third).principalId, shared.principalId);
  assert.equal(bindings.link(original).status, 'stale_binding');
});

test('binding rejects conflicting person, private address and existing group assignments', (t) => {
  const { bindings } = fixture(t);
  const [first, second, third] = [qq, feishu, telegram].map(privateEndpoint);
  const fourth = privateEndpoint({ ...feishu, tenantId: 'tenant_b' });
  assert.equal(bindings.link(withRevision(bindings, first, second)).status, 'linked');
  assert.equal(bindings.link(withRevision(bindings, third, fourth)).status, 'linked');
  const firstBinding = bindings.resolve(first);
  const thirdBinding = bindings.resolve(third);
  assert.equal(bindings.link(withRevision(bindings, first, third)).status, 'binding_conflict');

  const otherActor = { ...second, actor: { ...second.actor, userId: 'ou_other' } };
  const otherAddress = { ...second, conversation: { ...second.conversation, chatId: 'oc_other' } };
  for (const endpoint of [otherActor, otherAddress]) {
    assert.equal(bindings.link(withRevision(bindings, first, endpoint)).status, 'binding_conflict');
    assert.notEqual(bindings.resolve(endpoint).principalId, firstBinding.principalId);
  }
  assert.deepEqual(bindings.resolve(first), firstBinding);
  assert.deepEqual(bindings.resolve(third), thirdBinding);
  assert.throws(() => bindings.resolve({ ...third, conversation: { ...third.conversation, chatId: '43' } }), TypeError);
  assert.throws(() => bindings.resolve(message(telegram, '1')), TypeError);
  assert.throws(() => bindings.resolve({ ...second, actor: { ...second.actor, tenantId: 'tenant_b' } }), TypeError);
});

test('a failed binding expansion preserves the existing group revision and endpoint mappings', (t) => {
  const f = fixture(t);
  const [first, second, third] = [qq, feishu, telegram].map(privateEndpoint);
  assert.equal(f.bindings.link(withRevision(f.bindings, first, second)).status, 'linked');
  const shared = f.bindings.resolve(first);
  const isolated = f.bindings.resolve(third);
  const db = new DatabaseSync(f.file);
  try {
    db.exec(`
      CREATE TRIGGER abort_binding_expansion BEFORE INSERT ON channel_private_bindings
      WHEN NOT EXISTS (SELECT 1 FROM channel_private_bindings WHERE conversation_key = NEW.conversation_key)
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);
    const confirmed = withRevision(f.bindings, second, third);
    assert.throws(() => f.bindings.link(confirmed), /injected failure/);
    assert.deepEqual(f.bindings.resolve(first), shared);
    assert.deepEqual(f.bindings.resolve(second), shared);
    assert.deepEqual(f.bindings.resolve(third), isolated);
    db.exec('DROP TRIGGER abort_binding_expansion');
    assert.equal(f.bindings.link(confirmed).status, 'linked');
  } finally {
    db.close();
  }
});

test('linked private tasks keep distinct IDs and original targets across restart and redelivery', (t) => {
  const f = fixture(t);
  const fsEndpoint = privateEndpoint(feishu);
  const tgEndpoint = privateEndpoint(telegram);
  assert.equal(f.bindings.link(withRevision(f.bindings, privateEndpoint(qq), fsEndpoint, tgEndpoint)).status, 'linked');
  const shared = f.bindings.resolve(privateEndpoint(qq));
  const fsEvent = message(feishu, 'evt_linked', { messageId: 'om_linked', endpoint: fsEndpoint });
  const tgEvent = message(telegram, '1', { endpoint: tgEndpoint });
  const fsInbox = f.bind(feishu);
  const poller = f.bind(telegram).startPolling();
  assert.equal(fsInbox.accept(fsEvent).status, 'durableAccepted');
  assert.equal(poller.acceptBatch([tgEvent], poller.readCheckpoint()).results[0].status, 'durableAccepted');
  const [fsTask] = fsInbox.pending();
  const [tgTask] = f.bind(telegram).pending();
  for (const task of [fsTask, tgTask]) {
    assert.equal(task.principalId, shared.principalId);
    assert.equal(task.dialogueId, shared.dialogueId);
    assert.equal(task.bindingRevision, shared.bindingRevision);
    assert.equal(typeof task.taskId, 'string');
    assert.ok(task.taskId.length > 0);
  }
  assert.notEqual(fsTask.taskId, tgTask.taskId);
  assert.equal(fsTask.event.conversation.chatId, 'oc_direct');
  assert.equal(tgTask.event.conversation.chatId, '42');

  f.reopen();
  const reopened = f.bind(feishu);
  assert.equal(reopened.accept({ ...fsEvent, deliveryRef: 'evt_linked_retry' }).status, 'duplicate');
  assert.deepEqual(reopened.pending(), [fsTask]);
  assert.deepEqual(f.bind(telegram).pending(), [tgTask]);
  assert.equal(reopened.recheckTask(fsTask.event.messageKey).task.taskId, fsTask.taskId);
  assert.deepEqual(f.bind(telegram).recheckTask(fsTask.event.messageKey), { status: 'not_pending' });
});

test('task recheck respects current allowlists and refuses stale private binding snapshots', (t) => {
  const f = fixture(t);
  const fsEndpoint = privateEndpoint(feishu);
  const tgEndpoint = privateEndpoint(telegram);
  assert.equal(f.bindings.link(withRevision(f.bindings, fsEndpoint, tgEndpoint)).status, 'linked');
  let current = policy(feishu);
  const fsInbox = f.bind(feishu, () => current);
  const privateEvent = message(feishu, 'evt_private', { messageId: 'om_private', endpoint: fsEndpoint });
  const groupEvent = message(feishu, 'evt_group', { messageId: 'om_group' });
  assert.equal(fsInbox.accept(privateEvent).status, 'durableAccepted');
  assert.equal(fsInbox.accept(groupEvent).status, 'durableAccepted');
  const [direct, group] = fsInbox.pending();
  assert.notEqual(group.principalId, direct.principalId);
  assert.notEqual(group.dialogueId, direct.dialogueId);
  assert.equal(fsInbox.recheckTask(direct.event.messageKey).status, 'ready');
  current = { ...current, allow: { ...current.allow, senders: [], private: [] } };
  assert.deepEqual(fsInbox.recheckTask(group.event.messageKey), { status: 'unauthorized' });
  assert.deepEqual(fsInbox.recheckTask(direct.event.messageKey), { status: 'unauthorized' });
  assert.equal(fsInbox.complete(group.event.messageKey), true);
  assert.equal(fsInbox.accept(message(feishu, 'evt_revoked', {
    messageId: 'om_revoked', endpoint: fsEndpoint,
  })).status, 'durableFiltered');
  current = policy(feishu);
  const [confirmed] = withRevision(f.bindings, tgEndpoint);
  assert.equal(f.bindings.unlink(confirmed).status, 'unlinked');
  assert.deepEqual(fsInbox.recheckTask(direct.event.messageKey), { status: 'binding_changed' });
  assert.deepEqual(fsInbox.recheckTask(group.event.messageKey), { status: 'not_pending' });
});

test('execution leases enforce cross-account dialogue order and fence expired workers after reopening', (t) => {
  const f = fixture(t);
  const firstEndpoint = privateEndpoint(feishu);
  const nextEndpoint = privateEndpoint(telegram);
  assert.equal(f.bindings.link(withRevision(f.bindings, firstEndpoint, nextEndpoint)).status, 'linked');
  const first = f.bind(feishu);
  const next = f.bind(telegram);
  assert.equal(first.accept(message(feishu, 'evt_first', { messageId: 'om_first', endpoint: firstEndpoint })).status,
    'durableAccepted');
  const poll = next.startPolling();
  assert.equal(poll.acceptBatch([message(telegram, '1', { endpoint: nextEndpoint }), message(telegram, '2')],
    poll.readCheckpoint()).status, 'committed');
  const [{ event: a }] = first.pending();
  const [{ event: b }, { event: unrelated }] = next.pending();
  assert.equal(next.claim(b.messageKey).status, 'out_of_order');
  const claimed = first.claim(a.messageKey);
  assert.equal(claimed.status, 'claimed');
  assert.equal(first.complete(a.messageKey), false);
  assert.equal(next.claim(unrelated.messageKey).status, 'claimed');
  f.reopen();
  const resumed = f.bind(feishu);
  assert.equal(resumed.claim(a.messageKey).status, 'busy');
  f.advance(claimed.expiresAt - a.occurredAt);
  const replacement = resumed.claim(a.messageKey);
  assert.equal(replacement.status, 'claimed');
  assert.notEqual(replacement.token, claimed.token);
  assert.equal(resumed.release(a.messageKey, claimed.token).status, 'stale_lease');
  assert.equal(resumed.finish(a.messageKey, claimed.token).status, 'stale_lease');
  assert.equal(resumed.renew(a.messageKey, replacement.token).status, 'renewed');
  assert.equal(resumed.release(a.messageKey, replacement.token).status, 'released');
  assert.equal(resumed.claim(a.messageKey).status, 'claimed');
});

test('claim discards stale bindings and revoked payloads while a missing policy is retryable', (t) => {
  const f = fixture(t);
  const endpoint = privateEndpoint(feishu);
  assert.equal(f.bindings.link(withRevision(f.bindings, endpoint, privateEndpoint(telegram))).status, 'linked');
  let current = policy(feishu);
  const inbox = f.bind(feishu, () => current);
  inbox.accept(message(feishu, 'evt_first', { messageId: 'om_first', endpoint }));
  inbox.accept(message(feishu, 'evt_second', { messageId: 'om_second' }));
  const [{ event: first }, { event: second }] = inbox.pending();
  current = null;
  assert.equal(inbox.claim(second.messageKey).status, 'policy_unavailable');
  assert.equal(inbox.pending().length, 2);
  current = { ...policy(feishu), allow: { private: [endpoint.actor.userId] } };
  assert.equal(inbox.claim(second.messageKey).status, 'unauthorized');
  const [confirmed] = withRevision(f.bindings, endpoint);
  assert.equal(f.bindings.unlink(confirmed).status, 'unlinked');
  assert.equal(inbox.claim(first.messageKey).status, 'binding_changed');
  assert.deepEqual(inbox.pending(), []);
});

test('pending rows from the previous queue format do not inherit later private bindings', (t) => {
  const f = fixture(t);
  const endpoint = privateEndpoint(feishu);
  const event = message(feishu, 'evt_legacy', { messageId: 'om_legacy', endpoint });
  const inbox = f.bind(feishu);
  assert.equal(inbox.accept(event).status, 'durableAccepted');
  const [{ event: normalized }] = inbox.pending();
  const db = new DatabaseSync(f.file);
  try {
    db.prepare('UPDATE inbox_messages SET event = ? WHERE message_key = ?')
      .run(JSON.stringify(normalized), normalized.messageKey);
  } finally {
    db.close();
  }
  f.reopen();
  const resumed = f.bind(feishu);
  const [legacy] = resumed.pending();
  assert.ok(legacy.taskId);
  assert.equal(legacy.bindingRevision, null);
  assert.equal(resumed.recheckTask(normalized.messageKey).status, 'ready');
  assert.equal(f.bindings.link(withRevision(f.bindings, endpoint, privateEndpoint(qq))).status, 'linked');
  assert.deepEqual(resumed.pending(), [legacy]);
  assert.deepEqual(resumed.recheckTask(normalized.messageKey), { status: 'binding_changed' });
});

test('migration assigns FIFO order to tasks persisted before execution leases existed', (t) => {
  const f = fixture(t);
  const inbox = f.bind(feishu);
  inbox.accept(message(feishu, 'evt_legacy', { messageId: 'om_legacy' }));
  inbox.accept(message(feishu, 'evt_current', { messageId: 'om_current' }));
  const [{ event: first }, { event: next }] = inbox.pending();
  const db = new DatabaseSync(f.file);
  try {
    db.prepare('UPDATE inbox_messages SET event = ? WHERE message_key = ?').run(JSON.stringify(first), first.messageKey);
    db.exec('DROP INDEX inbox_dialogue_order; ALTER TABLE inbox_messages DROP COLUMN dialogue_id; DROP TABLE inbox_execution;');
  } finally { db.close(); }
  f.reopen();
  const resumed = f.bind(feishu);
  assert.equal(resumed.claim(next.messageKey).status, 'out_of_order');
  const { status, token } = resumed.claim(first.messageKey);
  assert.equal(status, 'claimed');
  assert.equal(resumed.finish(first.messageKey, token).status, 'not_projected');
  assert.equal(resumed.release(first.messageKey, token).status, 'released');
});

test('Feishu retries recover one normalized task after reopening the database', (t) => {
  const f = fixture(t);
  const event = {
    ...message(feishu, 'evt_first', { messageId: 'om_fixture', threadId: 'thread_a' }),
    raw: 'untrusted original envelope',
  };
  assert.equal(f.bind(feishu).accept(event).status, 'durableAccepted');
  f.reopen();
  const inbox = f.bind(feishu);
  assert.equal(inbox.accept(event).status, 'duplicate');
  const changedThread = message(feishu, 'evt_second', { messageId: 'om_fixture', threadId: 'thread_b' });
  assert.equal(inbox.accept(changedThread).status, 'duplicate');
  const [task] = inbox.pending();
  assert.equal(inbox.pending().length, 1);
  assert.equal(task.event.text, 'fixture text');
  assert.equal(task.event.conversation.threadId, 'thread_a');
  assert.equal(task.event.raw, undefined);
  assert.equal(task.decision, 'directed');
});

test('identical delivery and message IDs are isolated by account, tenant and Telegram topic', (t) => {
  const f = fixture(t);
  for (const account of [feishu, { ...feishu, tenantId: 'tenant_b' }, { ...feishu, accountId: 'cli_other' }]) {
    const inbox = f.bind(account);
    assert.equal(inbox.accept(message(account, 'evt_same', { messageId: 'om_same' })).status, 'durableAccepted');
    assert.equal(inbox.pending().length, 1);
  }
  for (const account of [telegram, { ...telegram, accountId: '45' }]) {
    const inbox = f.bind(account);
    const poller = inbox.startPolling();
    const result = poller.acceptBatch([
      message(account, '1', { messageId: '9', threadId: '7' }),
      message(account, '2', { messageId: '9', threadId: '8' }),
      message(account, '3', { messageId: '9', threadId: '7' }),
    ], poller.readCheckpoint());
    assert.deepEqual(result.results.map(({ status }) => status), ['durableAccepted', 'durableAccepted', 'duplicate']);
    const [first, second] = inbox.pending();
    assert.deepEqual([first.event.conversation.threadId, second.event.conversation.threadId], ['7', '8']);
    assert.notEqual(first.dialogueId, second.dialogueId);
    assert.notEqual(first.taskId, second.taskId);
  }
});

test('filtered deliveries are durable and never persist their bodies', (t) => {
  const f = fixture(t);
  const blockedText = 'blocked-body-fixture-6a3';
  const event = message(feishu, 'evt_filtered', { messageId: 'om_filtered', text: blockedText });
  const blocked = f.bind(feishu, () => ({ ...policy(feishu), allow: { groups: ['oc_fixture'] } }));
  assert.deepEqual(blocked.accept(event), { status: 'durableFiltered', reason: 'unauthorized' });
  assert.deepEqual(blocked.pending(), []);
  assert.equal(readFileSync(f.file).includes(blockedText), false);
  f.reopen();
  assert.equal(f.bind(feishu).accept(event).status, 'duplicate');
});

test('active accounts prune expired delivery metadata from inactive accounts', (t) => {
  const f = fixture(t);
  const inactiveId = 'evt_inactive_fixture_0b3';
  const event = message(feishu, inactiveId, { messageId: 'om_inactive' });
  assert.equal(f.bind(feishu).accept(event).status, 'durableAccepted');
  const db = new DatabaseSync(f.file);
  try {
    const read = db.prepare('SELECT 1 FROM inbox_deliveries WHERE delivery_ref = ?');
    assert.ok(read.get(inactiveId));
    f.advance(3 * day);
    const poller = f.bind(telegram).startPolling();
    assert.equal(poller.acceptBatch([], poller.readCheckpoint()).status, 'committed');
    assert.equal(read.get(inactiveId), undefined);
  } finally {
    db.close();
  }
  assert.equal(f.bind(feishu).pending().length, 1);
});

test('a mismatched or malformed policy cannot acknowledge an authorized delivery', (t) => {
  const f = fixture(t);
  const event = message(feishu, 'evt_retry', { messageId: 'om_retry' });
  for (const getPolicy of [
    () => policy({ ...feishu, tenantId: 'other_tenant' }),
    () => ({ ...policy(feishu), deny: null }),
    () => { throw new Error('unavailable'); },
  ]) {
    assert.deepEqual(f.bind(feishu, getPolicy).accept(event), { status: 'retryableFailure', reason: 'policy_unavailable' });
  }
  assert.equal(f.bind(feishu).accept(event).status, 'durableAccepted');
});

test('Telegram confirms only the durable prefix when capacity is exhausted', (t) => {
  const f = fixture(t, 1);
  const inbox = f.bind(telegram);
  const poller = inbox.startPolling();
  const first = message(telegram, '10', { text: 'completed-body-fixture-4a1' });
  const unsupported = { kind: 'edited_message', deliveryRef: '11', text: 'unsupported fixture' };
  const last = message(telegram, '15');
  const batch = poller.acceptBatch([first, unsupported, last], poller.readCheckpoint());
  assert.equal(batch.status, 'committed');
  assert.deepEqual(batch.results.map(({ status }) => status), ['durableAccepted', 'durableFiltered']);
  assert.equal(batch.blocked, 'queue_full');
  assert.equal(batch.checkpoint.offset, 12);

  f.reopen();
  const resumed = f.bind(telegram);
  const restarted = resumed.startPolling();
  assert.equal(restarted.readCheckpoint().offset, 12);
  assert.equal(resumed.complete(resumed.pending()[0].event.messageKey), true);
  assert.equal(readFileSync(f.file).includes(first.text), false);
  const retry = restarted.acceptBatch([last], restarted.readCheckpoint());
  assert.equal(retry.checkpoint.offset, 16);
  assert.deepEqual(resumed.pending().map(({ event }) => event.deliveryRef), ['15']);
});

test('Telegram rejects stale pollers and stale responses, including empty checkpoints', (t) => {
  const f = fixture(t);
  const first = f.bind(telegram).startPolling();
  const original = first.readCheckpoint();
  const second = f.bind(telegram).startPolling();
  const request = second.readCheckpoint();
  assert.equal(first.readCheckpoint(), null);
  assert.equal(first.acceptBatch([message(telegram, '5')], original).reason, 'stale_checkpoint');
  const result = second.acceptBatch([], request);
  assert.equal(result.status, 'committed');
  assert.equal(result.checkpoint.offset, null);
  assert.equal(second.acceptBatch([message(telegram, '6')], request).reason, 'stale_checkpoint');
  assert.deepEqual(f.bind(telegram).pending(), []);
});

test('Telegram checkpoints cannot be used for another bot account', (t) => {
  const f = fixture(t);
  const first = f.bind(telegram).startPolling();
  const otherAccount = { ...telegram, accountId: '43' };
  const secondInbox = f.bind(otherAccount);
  const second = secondInbox.startPolling();
  const event = message(otherAccount, '3');
  assert.equal(second.acceptBatch([event], first.readCheckpoint()).reason, 'stale_checkpoint');
  assert.deepEqual(secondInbox.pending(), []);
});

test('Telegram expires old offsets and short-lived delivery IDs independently of business deduplication', (t) => {
  const f = fixture(t);
  const poller = f.bind(telegram).startPolling();
  const first = message(telegram, '1000', { messageId: '900' });
  assert.equal(poller.acceptBatch([first], poller.readCheckpoint()).checkpoint.offset, 1001);
  f.advance(2 * day);
  assert.equal(poller.readCheckpoint().offset, null);
  const replay = poller.acceptBatch([first], poller.readCheckpoint());
  assert.equal(replay.results[0].status, 'duplicate');
  assert.equal(replay.checkpoint.offset, 1001);
  f.advance(3 * day);
  const result = poller.acceptBatch([
    message(telegram, '2', { messageId: '901' }), message(telegram, '1000', { messageId: '902' }),
    message(telegram, '1001', { messageId: '900' }),
  ], poller.readCheckpoint());
  assert.deepEqual(result.results.map(({ status }) => status), ['durableAccepted', 'durableAccepted', 'duplicate']);
  assert.equal(result.checkpoint.offset, 1002);
});

test('Telegram refuses an out-of-order response and never crosses an update without a usable ID', (t) => {
  const f = fixture(t);
  const poller = f.bind(telegram).startPolling();
  const a = message(telegram, '2');
  const b = message(telegram, '5');
  const request = poller.readCheckpoint();
  assert.equal(poller.acceptBatch([b, a], request).reason, 'invalid_batch');
  assert.deepEqual(poller.readCheckpoint(), request);
  const partial = poller.acceptBatch([a, { kind: 'invalid' }, b], request);
  assert.equal(partial.blocked, 'invalid_delivery');
  assert.equal(partial.checkpoint.offset, 3);
  assert.deepEqual(f.bind(telegram).pending().map(({ event }) => event.deliveryRef), ['2']);
});

test('SQLite write failure does not advance the Telegram checkpoint or create partial tasks', (t) => {
  const f = fixture(t);
  const inbox = f.bind(telegram);
  const poller = inbox.startPolling();
  const a = message(telegram, '1');
  poller.acceptBatch([a], poller.readCheckpoint());
  const checkpoint = poller.readCheckpoint();
  const b = message(telegram, '2');

  const locked = new DatabaseSync(f.file);
  try {
    locked.exec('BEGIN IMMEDIATE');
    assert.deepEqual(poller.acceptBatch([b], checkpoint), { status: 'retryableFailure', reason: 'storage_unavailable' });
  } finally {
    locked.close();
  }
  assert.deepEqual(poller.readCheckpoint(), checkpoint);
  assert.deepEqual(inbox.pending().map(({ event }) => event.deliveryRef), ['1']);
  assert.equal(poller.acceptBatch([b], checkpoint).checkpoint.offset, 3);
});

test('a SQLite error after the first write rolls back the whole response', (t) => {
  const f = fixture(t);
  const inbox = f.bind(telegram);
  const poller = inbox.startPolling();
  const request = poller.readCheckpoint();
  const events = [message(telegram, '1'), message(telegram, '2')];

  const fault = new DatabaseSync(f.file);
  try {
    fault.exec(`
      CREATE TRIGGER abort_second_delivery
      BEFORE INSERT ON inbox_deliveries WHEN NEW.delivery_ref = '2'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);
    assert.deepEqual(poller.acceptBatch(events, request), { status: 'retryableFailure', reason: 'storage_unavailable' });
    assert.deepEqual(poller.readCheckpoint(), request);
    assert.deepEqual(inbox.pending(), []);
    fault.exec('DROP TRIGGER abort_second_delivery');
    assert.deepEqual(poller.acceptBatch(events, request).results.map(({ status }) => status), [
      'durableAccepted', 'durableAccepted',
    ]);
  } finally {
    fault.close();
  }
});

test('opening an existing inbox preserves this process’s SQLite writer lock', {
  skip: process.platform === 'win32' && 'POSIX fcntl regression',
}, (t) => {
  const f = fixture(t);
  const locked = new DatabaseSync(f.file);
  try {
    locked.exec('BEGIN IMMEDIATE');
    try {
      openChannelInbox(f.file).close();
    } catch (error) {
      assert.equal(error.errcode, 5); // SQLITE_BUSY
    }
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      try {
        db.exec('BEGIN IMMEDIATE');
        process.exitCode = 1;
      } catch (error) {
        if (error.errcode !== 5) throw error;
      } finally {
        db.close();
      }
    `, f.file], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
  } finally {
    locked.close();
  }
});
