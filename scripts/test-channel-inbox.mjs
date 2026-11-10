import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openChannelInbox } from '../src/core/inbox-store.mjs';

const telegram = { platform: 'telegram', accountId: '41' };
const feishu = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const day = 24 * 60 * 60 * 1000;

function policy(account) {
  const chatId = account.platform === 'feishu' ? 'oc_fixture' : '-100123';
  return { ...account, enabled: true, allow: { groups: [chatId] } };
}

function message(account, deliveryRef, { messageId = deliveryRef, threadId = null, text = 'fixture text' } = {}) {
  const isFeishu = account.platform === 'feishu';
  const chatId = isFeishu ? 'oc_fixture' : '-100123';
  const conversation = { ...account, chatType: 'group', chatId, threadId };
  return {
    kind: 'message', senderType: 'human', trigger: 'directed', deliveryRef, occurredAt: 1794268800000,
    actor: { ...account, userId: isFeishu ? 'ou_fixture' : '42' },
    conversation, message: { conversation, platformChatId: chatId, messageId }, text,
  };
}

function fixture(t, capacity = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-inbox-'));
  const file = join(dir, 'queue.sqlite');
  let time = 1794268800000;
  let store;
  const reopen = () => {
    store?.close();
    store = openChannelInbox(file, { capacity, now: () => time });
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
    advance: (elapsed) => { time += elapsed; },
  };
}

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
    assert.deepEqual(inbox.pending().map(({ event }) => event.conversation.threadId), ['7', '8']);
  }
});

test('filtered deliveries are durable and never persist their bodies', (t) => {
  const f = fixture(t);
  const blockedText = 'blocked-body-fixture-6a3';
  const event = message(feishu, 'evt_filtered', { messageId: 'om_filtered', text: blockedText });
  const blocked = f.bind(feishu, () => ({ ...policy(feishu), allow: {} }));
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
