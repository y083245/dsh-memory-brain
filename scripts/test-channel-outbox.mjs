import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openChannelOutbox } from '../src/core/outbox-store.mjs';

const telegram = { platform: 'telegram', accountId: '41', tenantId: null };
const feishu = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };

function plan(operationId, { account = telegram, threadId = null, segments = ['fixture text'] } = {}) {
  const isFeishu = account.platform === 'feishu';
  const conversation = { ...account, chatType: 'group', chatId: isFeishu ? 'oc_fixture' : '-100123', threadId };
  const actor = { ...account, userId: isFeishu ? 'ou_fixture' : '42' };
  const replyTo = { conversation, platformChatId: conversation.chatId, messageId: isFeishu ? 'om_fixture' : '7' };
  return { operationId, conversation, source: { conversation, actor }, replyTo, authorizationId: 'revision_fixture', segments };
}

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-outbox-'));
  const file = join(dir, 'queue.sqlite');
  const stores = new Set();
  let time = 1000;
  const open = () => {
    const store = openChannelOutbox(file, { now: () => time, leaseMs: 100, ...options });
    stores.add(store);
    return store;
  };
  const close = (store) => {
    store.close();
    stores.delete(store);
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { file, store: open(), open, close, advance: (elapsed) => { time += elapsed; } };
}

test('the complete plan is deduplicated after restart and conflicting changes keep the original plan', (t) => {
  const f = fixture(t);
  const original = plan('reply_1', { segments: ['first ', 'second'] });
  const queued = f.store.enqueue(original);
  assert.equal(queued.status, 'queued');
  assert.deepEqual(Object.keys(queued.operation).sort(), ['conversation', 'operationId', 'segments', 'status']);
  assert.deepEqual(queued.operation.segments[0], {
    sendId: queued.operation.segments[0].sendId, status: 'pending', attempts: 0, platformMessageId: null,
  });
  assert.notEqual(queued.operation.segments[0].sendId, queued.operation.segments[1].sendId);
  f.close(f.store);
  const reopened = f.open();
  assert.deepEqual(reopened.enqueue(original), { status: 'existing', operation: queued.operation });

  for (const changed of [
    plan('reply_1', { segments: ['changed ', 'second'] }),
    plan('reply_1', { segments: ['first second'] }),
    plan('reply_1', { threadId: '4', segments: original.segments }),
    { ...original, authorizationId: 'revision_new' },
    { ...original, replyTo: { ...original.replyTo, messageId: '8' } },
    { ...original, source: { ...original.source, actor: { ...original.source.actor, userId: '43' } } },
  ]) {
    assert.equal(reopened.enqueue(changed).status, 'conflict');
  }
  assert.deepEqual(reopened.get(telegram, original.operationId), queued.operation);
  assert.equal(reopened.claim(telegram).text, 'first ');
});

test('connections cannot claim the same segment, and a retry holds later work in its conversation', (t) => {
  const f = fixture(t);
  const second = f.open();
  const original = plan('first', { segments: ['part one', 'part two'] });
  f.store.enqueue(original);
  f.store.enqueue(plan('later'));
  f.store.enqueue(plan('topic', { threadId: '9' }));

  const claim = f.store.claim(telegram);
  assert.equal(claim.operationId, 'first');
  assert.equal(claim.attempt, 1);
  assert.equal(claim.expiresAt, 1100);
  assert.equal(f.store.claimRemainingMs(claim), 100);
  assert.deepEqual(claim.source, original.source);
  assert.deepEqual(claim.replyTo, original.replyTo);
  assert.equal(claim.authorizationId, original.authorizationId);
  const topic = second.claim(telegram);
  assert.equal(topic.operationId, 'topic');
  assert.equal(topic.conversation.threadId, '9');
  assert.equal(second.claim(telegram), null);
  assert.equal(second.settle(telegram, topic, { status: 'sent', platformMessageId: '16' }).status, 'sent');

  f.advance(24);
  assert.equal(f.store.claimRemainingMs(claim), 76);
  assert.equal(f.store.settle(telegram, claim, { status: 'retry', delayMs: 25 }).status, 'pending');
  assert.equal(second.claim(telegram), null);
  f.advance(24);
  assert.equal(second.claim(telegram), null);
  f.advance(1);
  const retried = second.claim(telegram);
  assert.equal(retried.sendId, claim.sendId);
  assert.notEqual(retried.token, claim.token);
  assert.equal(retried.attempt, 2);
  assert.equal(f.store.settle(telegram, claim, { status: 'sent', platformMessageId: '17' }), null);
  assert.equal(f.store.settle({ ...telegram, accountId: '51' }, retried, { status: 'sent', platformMessageId: '17' }), null);
  assert.equal(second.settle(telegram, retried, { status: 'sent', platformMessageId: '17' }).status, 'pending');

  const continuation = f.store.claim(telegram);
  assert.equal(continuation.operationId, 'first');
  assert.equal(continuation.text, 'part two');
  assert.notEqual(continuation.sendId, retried.sendId);
  assert.equal(second.claim(telegram), null);
  assert.equal(f.store.settle(telegram, continuation, { status: 'sent', platformMessageId: '18' }).status, 'sent');
  assert.equal(second.claim(telegram).operationId, 'later');
});

test('capacity and operation IDs are scoped by platform, account and tenant', (t) => {
  const f = fixture(t, { capacity: 1 });
  const otherTenant = { ...feishu, tenantId: 'tenant_b' };
  const otherBot = { ...telegram, accountId: '51' };
  const accounts = [feishu, otherTenant, telegram, otherBot];
  const sendIds = new Set();
  for (const account of accounts) {
    assert.equal(f.store.get(account, 'shared'), null);
    const queued = f.store.enqueue(plan('shared', { account }));
    assert.equal(queued.status, 'queued');
    sendIds.add(queued.operation.segments[0].sendId);
    assert.equal(f.store.enqueue(plan('other', { account, segments: ['extra'] })).status, 'full');
    assert.equal(f.store.enqueue(plan('shared', { account })).status, 'existing');
  }
  assert.equal(sendIds.size, accounts.length);
  for (const account of accounts) {
    const claim = f.store.claim(account);
    assert.equal(claim.conversation.tenantId, account.tenantId);
    assert.equal(claim.conversation.accountId, account.accountId);
    assert.equal(f.store.enqueue(plan('other', { account })).status, 'full');
    assert.equal(f.store.settle(account, claim, { status: 'failed' }).status, 'failed');
    assert.equal(f.store.enqueue(plan('other', { account })).status, 'queued');
  }
});

test('restart converts expired sends to unknown and keeps earlier confirmations while cancelling unsent parts', (t) => {
  const f = fixture(t);
  const original = plan('reply_1', {
    account: feishu, segments: ['fixture confirmed body', 'fixture uncertain body', 'fixture cancelled body'],
  });
  f.store.enqueue(original);
  const first = f.store.claim(feishu);
  f.store.settle(feishu, first, { status: 'sent', platformMessageId: 'om_confirmed' });
  const second = f.store.claim(feishu);
  f.close(f.store);
  f.advance(100);
  const reopened = f.open();
  assert.equal(reopened.claimRemainingMs(second), 0);
  assert.equal(reopened.claim(feishu), null);
  assert.equal(reopened.settle(feishu, second, { status: 'sent', platformMessageId: 'om_late' }), null);
  const recovered = reopened.get(feishu, original.operationId);
  assert.equal(recovered.status, 'unknown');
  assert.deepEqual(recovered.segments.map(({ status, attempts, platformMessageId }) =>
    [status, attempts, platformMessageId]), [
    ['sent', 1, 'om_confirmed'], ['unknown', 1, null], ['cancelled', 0, null],
  ]);
  assert.deepEqual(reopened.enqueue(original), { status: 'existing', operation: recovered });
  assert.equal(reopened.enqueue({ ...original, segments: ['different'] }).status, 'conflict');
  f.close(reopened);
  const stored = readFileSync(f.file);
  for (const value of [...original.segments, original.authorizationId, original.source.actor.userId, original.replyTo.messageId]) {
    assert.equal(stored.includes(value), false);
  }
});

test('late settlement alone records unknown and unblocks the next operation', (t) => {
  const f = fixture(t);
  f.store.enqueue(plan('first'));
  f.store.enqueue(plan('next'));
  const claim = f.store.claim(telegram);
  f.advance(100);
  assert.equal(f.store.settle(telegram, claim, { status: 'retry', delayMs: 0 }), null);
  assert.equal(f.store.get(telegram, 'first').status, 'unknown');
  assert.equal(f.store.claim(telegram).operationId, 'next');
});

test('the outbox persists only canonical source and reply and refuses cross-scope or mismatched targets', (t) => {
  const { store } = fixture(t);
  const original = plan('reply_1', { threadId: '5' });
  const alternate = plan('reply_1', { threadId: '6' });
  for (const bad of [
    { source: alternate.source },
    { source: { ...original.source, actor: { ...telegram, accountId: '51', userId: '42' } } },
    { source: null },
    { replyTo: alternate.replyTo },
    { replyTo: { ...original.replyTo, platformChatId: '-100456' } },
  ]) {
    assert.throws(() => store.enqueue({ ...original, ...bad }), TypeError);
  }
  const privateConversation = { ...telegram, chatType: 'private', chatId: '43' };
  assert.throws(() => store.enqueue({ ...original, conversation: privateConversation, source: null, replyTo: null }), TypeError);
  assert.throws(() => store.enqueue({
    ...original, conversation: privateConversation, source: { ...original.source, conversation: privateConversation }, replyTo: null,
  }), TypeError);
  assert.equal(store.get(telegram, original.operationId), null);

  const withExtras = {
    ...original,
    conversation: { ...original.conversation, text: 'discard' },
    source: {
      conversation: { ...original.source.conversation, text: 'discard' },
      actor: { ...original.source.actor, name: 'discard' },
      text: 'discard',
    },
    replyTo: { ...original.replyTo, token: 'discard' },
  };
  assert.equal(store.enqueue(withExtras).status, 'queued');
  assert.equal(store.enqueue(original).status, 'existing');
  const claimed = store.claim(telegram);
  assert.deepEqual(claimed.conversation, original.conversation);
  assert.deepEqual(claimed.source, original.source);
  assert.deepEqual(claimed.replyTo, original.replyTo);
  assert.equal(store.enqueue({ ...original, operationId: 'trusted_group', source: null, replyTo: null }).status, 'queued');
  assert.equal(store.settle(telegram, claimed, { status: 'sent', platformMessageId: '17' }).status, 'sent');
  const standalone = store.claim(telegram);
  assert.equal(standalone.source, null);
  assert.equal(standalone.replyTo, null);
});

test('invalid storage input errors omit text and a malformed receipt cannot create a confirmed send', (t) => {
  const { store } = fixture(t);
  const original = plan('reply_1', { account: feishu });
  const marker = 'fixture private body';
  for (const bad of [
    { operationId: marker },
    { authorizationId: marker },
    { segments: [] },
    { segments: new Array(1) },
    { segments: [''] },
    { segments: [marker + '\0'] },
    { segments: [marker + '\ud800'] },
    { segments: new Array(257).fill(marker) },
    { segments: [marker.repeat(40000), marker.repeat(40000)] },
  ]) {
    assert.throws(() => store.enqueue({ ...original, ...bad }), (error) =>
      error instanceof TypeError && !error.message.includes(marker));
  }
  assert.equal(store.get(feishu, original.operationId), null);
  store.enqueue(original);
  const claim = store.claim(feishu);
  assert.throws(() => store.settle(feishu, claim, { status: 'sent', platformMessageId: marker }), TypeError);
  assert.throws(() => store.settle(feishu, claim, { status: 'retry', delayMs: -1 }), TypeError);
  assert.equal(store.get(feishu, original.operationId).status, 'sending');
  assert.equal(store.settle(feishu, claim, { status: 'cancelled' }).status, 'cancelled');
});

test('a failed segment insert rolls back the entire enqueue transaction', (t) => {
  const f = fixture(t);
  const inspector = new DatabaseSync(f.file);
  try {
    inspector.exec(`
      CREATE TRIGGER reject_outbox_segment BEFORE INSERT ON outbox_segments
      WHEN NEW.text = 'fixture injected failure'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);
    const operation = plan('atomic', { segments: ['fixture first', 'fixture injected failure'] });
    assert.throws(() => f.store.enqueue(operation), /injected failure/);
    assert.equal(f.store.get(telegram, 'atomic'), null);
    assert.equal(f.store.claim(telegram), null);
    inspector.exec('DROP TRIGGER reject_outbox_segment');
    assert.equal(f.store.enqueue(operation).operation.segments.length, 2);
  } finally {
    inspector.close();
  }
});

test('a failed claim leaves the segment pending with its original attempt count', (t) => {
  const f = fixture(t);
  const original = f.store.enqueue(plan('claim_failure')).operation;
  const inspector = new DatabaseSync(f.file);
  try {
    inspector.exec(`
      CREATE TRIGGER reject_outbox_claim BEFORE UPDATE OF status ON outbox_operations
      WHEN NEW.status = 'sending'
      BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END;
    `);
    assert.throws(() => f.store.claim(telegram), /injected claim failure/);
    assert.deepEqual(f.store.get(telegram, 'claim_failure'), original);
    inspector.exec('DROP TRIGGER reject_outbox_claim');
    const claimed = f.store.claim(telegram);
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.sendId, original.segments[0].sendId);
    assert.equal(claimed.text, 'fixture text');
  } finally {
    inspector.close();
  }
});

test('a failed settlement keeps the lease and every segment in its original state', (t) => {
  const f = fixture(t);
  f.store.enqueue(plan('settle_failure', { segments: ['first', 'second'] }));
  const claim = f.store.claim(telegram);
  const before = f.store.get(telegram, 'settle_failure');
  const inspector = new DatabaseSync(f.file);
  try {
    inspector.exec(`
      CREATE TRIGGER reject_outbox_settle BEFORE UPDATE OF status ON outbox_operations
      WHEN NEW.status = 'failed'
      BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END;
    `);
    assert.throws(() => f.store.settle(telegram, claim, { status: 'failed' }), /injected settlement failure/);
    assert.deepEqual(f.store.get(telegram, 'settle_failure'), before);
    assert.equal(f.store.claim(telegram), null);
    inspector.exec('DROP TRIGGER reject_outbox_settle');
    const finished = f.store.settle(telegram, claim, { status: 'failed' });
    assert.equal(finished.status, 'failed');
    assert.deepEqual(finished.segments.map(({ status }) => status), ['failed', 'cancelled']);
  } finally {
    inspector.close();
  }
});
