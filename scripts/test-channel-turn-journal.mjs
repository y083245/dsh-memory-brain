import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createChannelArchive } from '../src/core/channel-archive.mjs';
import { openChannelInbox } from '../src/core/inbox-store.mjs';

const feishu = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const telegram = { platform: 'telegram', accountId: '41' };
const submission = { sessionId: 'session_fixture', generation: 1, requestId: 'request_fixture' };
const body = 'synthetic queued message';
const occurredAt = Date.UTC(2026, 10, 1);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-turn-journal-'));
  const file = join(dir, 'queue.sqlite');
  const archive = createChannelArchive(join(dir, 'archive'), (text) => text);
  let time = occurredAt;
  let store;
  const open = () => openChannelInbox(file, { archive, now: () => time, leaseMs: 100 });
  const reopen = () => {
    store?.close();
    store = open();
    return store;
  };
  t.after(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  reopen();

  function channel(account = feishu, { privateChat = false } = {}) {
    const isFeishu = account.platform === 'feishu';
    const userId = isFeishu ? 'ou_fixture' : '42';
    const chatId = privateChat ? (isFeishu ? 'oc_direct' : userId) : (isFeishu ? 'oc_group' : '-100123');
    const endpoint = {
      actor: { ...account, userId },
      conversation: { ...account, chatType: privateChat ? 'private' : 'group', chatId },
    };
    const policy = { ...account, enabled: true, groupPolicy: 'observe', observationVerified: true,
      allow: { private: [userId], groups: privateChat ? [] : [chatId], senders: [userId] } };
    const bind = (getPolicy = () => policy, connection = store) => connection.bind(account, getPolicy);

    function enqueue(id = 1, trigger = 'directed') {
      const inbox = bind();
      const deliveryRef = isFeishu ? `evt_${id}` : String(id);
      const event = {
        ...endpoint, kind: 'message', senderType: 'human', trigger, occurredAt, deliveryRef, text: body,
        message: { conversation: endpoint.conversation, platformChatId: chatId,
          messageId: isFeishu ? `om_${id}` : String(id) },
      };
      if (isFeishu) assert.equal(inbox.accept(event).status, 'durableAccepted');
      else {
        const poller = inbox.startPolling();
        const result = poller.acceptBatch([event], poller.readCheckpoint());
        assert.equal(result.results[0].status, 'durableAccepted');
      }
      return inbox.pending().find((task) => task.event.deliveryRef === deliveryRef);
    }
    return { endpoint, bind, enqueue, policy };
  }
  return { channel, open, reopen, file, archive, advance: (elapsed) => { time += elapsed; },
    get bindings() { return store.privateBindings; } };
}

function lease(inbox, { event: { messageKey } }, project = true) {
  const { status, token } = inbox.claim(messageKey);
  assert.equal(status, 'claimed');
  const projected = project ? inbox.project(messageKey, token) : {};
  if (project) assert.equal(projected.status, 'projected');
  return { messageKey, token, recordId: projected.recordId };
}

test('beginTurn persists only trusted recovery metadata before a submit and fences a replaced lease', (t) => {
  const f = fixture(t);
  const channel = f.channel();
  const task = channel.enqueue();
  const inbox = channel.bind();
  const { messageKey, token } = lease(inbox, task);
  assert.deepEqual(inbox.readTurn(messageKey, token), { status: 'no_turn' });
  const expected = { taskId: task.taskId, conversationKey: task.event.conversationKey, dialogueId: task.dialogueId,
    bindingRevision: null, ...submission, turnId: null, state: 'submitting' };
  assert.deepEqual(inbox.beginTurn(messageKey, token, { ...submission, text: body, dialogueId: 'spoofed' }),
    { status: 'started', turn: expected });
  assert.deepEqual(inbox.beginTurn(messageKey, token, { ...submission, requestId: 'different_request' }),
    { status: 'turn', turn: expected });
  f.reopen();
  const resumed = channel.bind();
  assert.deepEqual(resumed.readTurn(messageKey, token), { status: 'turn', turn: expected });
  f.advance(100);
  const renewed = lease(resumed, task, false).token;
  assert.deepEqual(resumed.readTurn(messageKey, token), { status: 'stale_lease' });
  assert.deepEqual(resumed.readTurn(messageKey, renewed), { status: 'turn', turn: expected });
  assert.equal(resumed.finish(messageKey, renewed).status, 'unresolved_turn');
});

test('beginTurn requires an authorized directed task and a current archive projection', (t) => {
  const f = fixture(t);
  const channel = f.channel();
  const inbox = channel.bind();
  const first = channel.enqueue();
  const { messageKey, token } = lease(inbox, first, false);
  assert.equal(inbox.beginTurn(messageKey, token, submission).status, 'not_projected');
  assert.equal(inbox.project(messageKey, token).status, 'projected');
  assert.equal(inbox.beginTurn(messageKey, token, { ...submission, requestId: '\n' }).status, 'invalid_turn');
  assert.equal(inbox.beginTurn(messageKey, token, { ...submission, generation: -1 }).status, 'invalid_turn');
  const expiring = channel.bind(() => {
    f.advance(100);
    return channel.policy;
  });
  assert.equal(expiring.beginTurn(messageKey, token, submission).status, 'stale_lease');
  const replacement = lease(inbox, first);
  channel.policy.enabled = false;
  assert.equal(inbox.beginTurn(messageKey, replacement.token, submission).status, 'unauthorized');
  assert.deepEqual(inbox.pending(), []);
  channel.policy.enabled = true;
  const ambient = lease(inbox, channel.enqueue(2, 'ambient'));
  assert.equal(inbox.beginTurn(ambient.messageKey, ambient.token, submission).status, 'not_directed');
  assert.deepEqual(inbox.readTurn(ambient.messageKey, ambient.token), { status: 'no_turn' });
});

test('journal evidence preserves the exact turn ID and requires proof to complete', (t) => {
  const channel = fixture(t).channel();
  const task = channel.enqueue();
  const inbox = channel.bind();
  const { messageKey, token } = lease(inbox, task);
  const { requestId } = submission;
  assert.equal(inbox.beginTurn(messageKey, token, submission).status, 'started');
  assert.equal(inbox.finishTurn(messageKey, token, requestId, { state: 'completed' }).status, 'turn_conflict');
  assert.equal(inbox.updateTurn(messageKey, token, 'wrong_request', { state: 'accepted', turnId: 'turn_a' }).status,
    'turn_conflict');
  assert.deepEqual(inbox.updateTurn(messageKey, token, requestId, { state: 'retry' }), { status: 'retry_ready' });
  assert.deepEqual(inbox.readTurn(messageKey, token), { status: 'no_turn' });
  assert.equal(inbox.beginTurn(messageKey, token, submission).turn.requestId, requestId);
  const accepted = inbox.updateTurn(messageKey, token, requestId, { state: 'accepted', turnId: 'turn_a' });
  assert.equal(accepted.status, 'updated');
  assert.equal(accepted.turn.state, 'accepted');
  assert.equal(inbox.updateTurn(messageKey, token, requestId, { state: 'retry' }).status, 'turn_conflict');
  assert.equal(inbox.updateTurn(messageKey, token, requestId, { state: 'uncertain', turnId: 'turn_b' }).status,
    'turn_conflict');
  const uncertain = inbox.updateTurn(messageKey, token, requestId, { state: 'uncertain' });
  assert.equal(uncertain.turn.turnId, 'turn_a');
  assert.equal(uncertain.turn.state, 'uncertain');
  assert.equal(inbox.finishTurn(messageKey, token, requestId, { state: 'completed', turnId: 'turn_b' }).status,
    'turn_conflict');
  assert.equal(inbox.finishTurn(messageKey, token, requestId, { state: 'completed', turnId: 'turn_a' }).status,
    'completed');
  assert.deepEqual(inbox.pending(), []);
  assert.equal(inbox.readTurn(messageKey, token).status, 'stale_lease');
});

test('turn finalization and body removal roll back together on storage failure', (t) => {
  const f = fixture(t);
  const channel = f.channel();
  const inbox = channel.bind();
  const { messageKey, token } = lease(inbox, channel.enqueue());
  const { requestId } = submission;
  assert.equal(inbox.beginTurn(messageKey, token, submission).status, 'started');
  assert.equal(inbox.updateTurn(messageKey, token, requestId, { state: 'retiring' }).status, 'updated');
  const fault = new DatabaseSync(f.file);
  try {
    fault.exec(`CREATE TRIGGER fail_body_clear BEFORE UPDATE OF event ON inbox_messages
      WHEN NEW.event IS NULL BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    assert.equal(inbox.finishTurn(messageKey, token, requestId, { state: 'retired' }).reason, 'storage_unavailable');
    assert.equal(inbox.readTurn(messageKey, token).turn.state, 'retiring');
    assert.equal(inbox.recheckLease(messageKey, token).task.event.text, body);
  } finally {
    fault.exec('DROP TRIGGER fail_body_clear');
    fault.close();
  }
  assert.equal(inbox.finishTurn(messageKey, token, requestId, { state: 'retired' }).status, 'retired');
  assert.deepEqual(inbox.pending(), []);
});

test('forgetting keeps the turn recoverable across restart and blocks the same source', (t) => {
  const f = fixture(t);
  const channel = f.channel();
  const inbox = channel.bind();
  const first = channel.enqueue();
  const { messageKey, token, recordId } = lease(inbox, first);
  const { requestId } = submission;
  const { turn } = inbox.beginTurn(messageKey, token, submission);
  assert.deepEqual(inbox.readOrphanedTurn(requestId), { status: 'no_turn' });
  assert.equal(inbox.finishOrphanedTurn(requestId, { state: 'retired' }).status, 'no_turn');
  assert.equal(inbox.forgetRecord(turn.conversationKey, recordId).status, 'forgotten');
  assert.deepEqual(inbox.pending(), []);
  assert.doesNotMatch(readFileSync(f.file).toString(), /synthetic queued message/);
  f.reopen();
  const resumed = channel.bind();
  assert.deepEqual(resumed.orphanedTurns(), [turn]);
  assert.deepEqual(resumed.readOrphanedTurn(requestId), { status: 'turn', turn });
  const otherAccount = f.channel({ ...feishu, tenantId: 'tenant_other' }).bind();
  assert.deepEqual(otherAccount.orphanedTurns(), []);
  assert.deepEqual(otherAccount.readOrphanedTurn(requestId), { status: 'no_turn' });
  assert.equal(otherAccount.finishOrphanedTurn(requestId, { state: 'retired' }).status, 'no_turn');
  const observation = lease(resumed, channel.enqueue(2, 'ambient'));
  assert.deepEqual(resumed.readTurn(observation.messageKey, observation.token), { status: 'no_turn' });
  assert.equal(resumed.finish(observation.messageKey, observation.token).status, 'completed');
  const next = lease(resumed, channel.enqueue(3));
  const nextSubmission = { ...submission, requestId: 'request_next' };
  assert.deepEqual(resumed.readTurn(next.messageKey, next.token), { status: 'blocked_turn' });
  assert.deepEqual(resumed.beginTurn(next.messageKey, next.token, nextSubmission), { status: 'blocked_turn', turn });
  assert.equal(resumed.beginOrphanedRetirement(requestId).status, 'turn');
  assert.equal(resumed.finishOrphanedTurn(requestId, { state: 'retired' }).status, 'retired');
  assert.deepEqual(resumed.orphanedTurns(), []);
  assert.deepEqual(resumed.readOrphanedTurn(requestId), { status: 'no_turn' });
  assert.deepEqual(resumed.readTurn(next.messageKey, next.token), { status: 'no_turn' });
  assert.equal(resumed.beginTurn(next.messageKey, next.token, submission).status, 'turn_conflict');
  assert.equal(resumed.beginTurn(next.messageKey, next.token, nextSubmission).status, 'started');
});

test('authorization cancellation leaves a blocker for the shared dialogue across accounts', (t) => {
  const f = fixture(t);
  const first = f.channel(feishu, { privateChat: true });
  const second = f.channel(telegram, { privateChat: true });
  assert.equal(f.bindings.link([first, second].map(({ endpoint }) => ({ ...endpoint, bindingRevision: null }))).status,
    'linked');
  const source = first.bind();
  const nextInbox = second.bind();
  const original = first.enqueue();
  const next = second.enqueue();
  const { messageKey, token } = lease(source, original);
  const { turn } = source.beginTurn(messageKey, token, submission);
  assert.equal(nextInbox.claim(next.event.messageKey).status, 'out_of_order');
  first.policy.enabled = false;
  assert.equal(source.recheckLease(messageKey, token).status, 'unauthorized');
  assert.deepEqual(source.orphanedTurns(), [turn]);
  const nextLease = lease(nextInbox, next);
  const nextSubmission = { ...submission, requestId: 'request_next' };
  assert.deepEqual(nextInbox.readTurn(nextLease.messageKey, nextLease.token), { status: 'blocked_turn' });
  assert.deepEqual(nextInbox.beginTurn(nextLease.messageKey, nextLease.token, nextSubmission),
    { status: 'blocked_turn', turn });
  assert.equal(source.finishOrphanedTurn(submission.requestId, { state: 'completed', turnId: 'turn_exact' }).status,
    'completed');
  assert.equal(nextInbox.beginTurn(nextLease.messageKey, nextLease.token, nextSubmission).status, 'started');
});

test('binding cancellation retains the source blocker after the dialogue changes', (t) => {
  const f = fixture(t);
  const channel = f.channel(feishu, { privateChat: true });
  const partner = f.channel(telegram, { privateChat: true });
  assert.equal(f.bindings.link([channel, partner].map(({ endpoint }) => ({ ...endpoint, bindingRevision: null }))).status,
    'linked');
  const inbox = channel.bind();
  const original = channel.enqueue();
  const { messageKey, token } = lease(inbox, original);
  const { turn } = inbox.beginTurn(messageKey, token, submission);
  assert.equal(f.bindings.unlink({ ...channel.endpoint, bindingRevision: original.bindingRevision }).status, 'unlinked');
  assert.equal(inbox.recheckLease(messageKey, token).status, 'binding_changed');
  const next = channel.enqueue(2);
  assert.notEqual(next.dialogueId, original.dialogueId);
  const nextLease = lease(inbox, next);
  const nextSubmission = { ...submission, requestId: 'request_next' };
  assert.deepEqual(inbox.beginTurn(nextLease.messageKey, nextLease.token, nextSubmission),
    { status: 'blocked_turn', turn });
});

test('global turn capacity counts unresolved orphans across SQLite connections until finalization', (t) => {
  const f = fixture(t);
  const first = f.channel();
  const second = f.channel(telegram);
  const inbox = first.bind();
  const firstLease = lease(inbox, first.enqueue());
  const next = second.enqueue();
  const connection = f.open();
  try {
    const nextInbox = second.bind(undefined, connection);
    const nextLease = lease(nextInbox, next);
    const intent = { ...submission, maxActiveTurns: 1 };
    const nextIntent = { ...intent, requestId: 'request_next' };
    assert.equal(inbox.beginTurn(firstLease.messageKey, firstLease.token, { ...intent, maxActiveTurns: 0 }).status,
      'invalid_turn');
    const { status, turn } = inbox.beginTurn(firstLease.messageKey, firstLease.token, intent);
    assert.equal(status, 'started');
    assert.equal(nextInbox.beginTurn(nextLease.messageKey, nextLease.token, nextIntent).status, 'turn_capacity');
    assert.deepEqual(inbox.beginTurn(firstLease.messageKey, firstLease.token, intent), { status: 'turn', turn });
    assert.equal(inbox.forgetRecord(turn.conversationKey, firstLease.recordId).status, 'forgotten');
    assert.equal(nextInbox.beginTurn(nextLease.messageKey, nextLease.token, nextIntent).status, 'turn_capacity');
    assert.equal(inbox.finishOrphanedTurn(turn.requestId, { state: 'completed', turnId: '42' }).status, 'completed');
    assert.equal(nextInbox.beginTurn(nextLease.messageKey, nextLease.token, nextIntent).status, 'started');
  } finally {
    connection.close();
  }
});

test('a retiring intent fences concurrent completion across a replaced lease and cancellation', (t) => {
  const f = fixture(t);
  const channel = f.channel();
  const inbox = channel.bind();
  const task = channel.enqueue();
  const { messageKey, token, recordId } = lease(inbox, task);
  const { requestId } = submission;
  const { turn } = inbox.beginTurn(messageKey, token, submission);
  assert.equal(inbox.finishTurn(messageKey, token, requestId, { state: 'retired' }).status, 'turn_conflict');
  const retiring = { ...turn, state: 'retiring' };
  assert.deepEqual(inbox.updateTurn(messageKey, token, requestId, { state: 'retiring' }), {
    status: 'updated', turn: retiring,
  });
  f.advance(100);
  const replacement = lease(inbox, task);
  const completed = { state: 'completed', turnId: '42' };
  assert.equal(inbox.finishTurn(messageKey, token, requestId, completed).status, 'stale_lease');
  assert.deepEqual(inbox.readTurn(messageKey, replacement.token), { status: 'turn', turn: retiring });
  assert.equal(inbox.finishTurn(messageKey, replacement.token, requestId, completed).status, 'turn_conflict');
  assert.equal(inbox.updateTurn(messageKey, replacement.token, requestId, { state: 'uncertain' }).status,
    'turn_conflict');
  assert.equal(inbox.forgetRecord(turn.conversationKey, recordId).status, 'forgotten');
  assert.deepEqual(inbox.beginOrphanedRetirement(requestId), { status: 'turn', turn: retiring });
  assert.equal(inbox.finishOrphanedTurn(requestId, completed).status, 'turn_conflict');
  const next = lease(inbox, channel.enqueue(2));
  assert.deepEqual(inbox.readTurn(next.messageKey, next.token), { status: 'blocked_turn' });
  const nextIntent = { ...submission, requestId: 'request_next' };
  assert.equal(inbox.finishOrphanedTurn(requestId, { state: 'retired' }).status, 'retired');
  assert.equal(inbox.beginTurn(next.messageKey, next.token, nextIntent).status, 'started');
});

test('scoped orphan evidence pins a pending ID before retirement and cannot be overwritten', (t) => {
  const f = fixture(t);
  const channel = f.channel();
  const inbox = channel.bind();
  const { messageKey, token, recordId } = lease(inbox, channel.enqueue());
  const { turn } = inbox.beginTurn(messageKey, token, submission);
  const { requestId } = turn;
  assert.equal(inbox.forgetRecord(turn.conversationKey, recordId).status, 'forgotten');
  const other = f.channel({ ...feishu, tenantId: 'tenant_other' }).bind();
  const evidence = { state: 'accepted', turnId: '42' };
  assert.equal(other.updateOrphanedTurn(requestId, evidence).status, 'no_turn');
  assert.equal(other.beginOrphanedRetirement(requestId).status, 'no_turn');
  const accepted = { ...turn, ...evidence };
  assert.deepEqual(inbox.updateOrphanedTurn(requestId, evidence), { status: 'updated', turn: accepted });
  assert.equal(inbox.updateOrphanedTurn(requestId, { ...evidence, turnId: '43' }).status, 'turn_conflict');
  assert.equal(inbox.finishOrphanedTurn(requestId, { state: 'completed', turnId: '43' }).status, 'turn_conflict');
  const retiring = { ...accepted, state: 'retiring' };
  assert.deepEqual(inbox.beginOrphanedRetirement(requestId), { status: 'turn', turn: retiring });
  assert.deepEqual(inbox.beginOrphanedRetirement(requestId), { status: 'turn', turn: retiring });
  assert.equal(inbox.updateOrphanedTurn(requestId, evidence).status, 'turn_conflict');
  assert.equal(inbox.finishOrphanedTurn(requestId, { state: 'completed', turnId: '42' }).status, 'turn_conflict');
  assert.deepEqual(inbox.finishOrphanedTurn(requestId, { state: 'retired' }), {
    status: 'retired', turn: { ...retiring, state: 'retired' },
  });
});
