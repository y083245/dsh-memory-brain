import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { createDailyReport } from '../src/daily-report.js';
import { createLongMemory } from '../src/long-memory.js';

const feishu = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const telegram = { platform: 'telegram', accountId: '41' };

function fixture(t, { now = Date.now, leaseMs } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'channel-archive-'));
  const dbFile = path.join(dir, 'queue.sqlite');
  const memoryDir = path.join(dir, 'long-memory');
  const root = path.join(memoryDir, 'channel-archive');
  const memory = createLongMemory({ stateDir: memoryDir, redact: (text) => text.replaceAll('fixture-secret', '[redacted]') });
  let store;
  function reopen() {
    store?.close();
    store = openChannelInbox(dbFile, { archive: memory.channelArchive, now, leaseMs });
  }
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  reopen();
  function enqueue(account = feishu, { id = 1, threadId = '7', text = '共同的故事 🐋 fixture-secret' } = {}) {
    const isFeishu = account.platform === 'feishu';
    const userId = isFeishu ? 'ou_fixture' : '42';
    const chatId = isFeishu ? 'oc_fixture' : '-100123';
    const policy = { ...account, enabled: true, allow: { groups: [chatId], senders: [userId] } };
    const bind = (getPolicy = () => policy) => store.bind(account, getPolicy);
    const inbox = bind();
    const conversation = { ...account, chatType: 'group', chatId, threadId };
    const event = {
      kind: 'message', senderType: 'human', trigger: 'directed', occurredAt: Date.UTC(2026, 10, 1),
      actor: { ...account, userId }, conversation, deliveryRef: isFeishu ? `evt_${id}` : String(id),
      message: { conversation, platformChatId: chatId, messageId: isFeishu ? `om_${id}` : String(id) }, text,
    };
    if (isFeishu) assert.equal(inbox.accept(event).status, 'durableAccepted');
    else {
      const poller = inbox.startPolling();
      assert.equal(poller.acceptBatch([event], poller.readCheckpoint()).results[0].status, 'durableAccepted');
    }
    const { conversationKey: key, messageKey } = inbox.pending().find((task) => task.event.deliveryRef === event.deliveryRef).event;
    const digest = createHash('sha256').update(key).digest('hex');
    const file = path.join(root, `c1_${digest}`, '2026-11.jsonl');
    return { bind, inbox, key, messageKey, policy, file, watermark: `${file}.watermark.json` };
  }
  return { dbFile, dir, memory, enqueue, reopen };
}

function project({ inbox, messageKey }) {
  const { status, token } = inbox.claim(messageKey);
  assert.equal(status, 'claimed');
  assert.deepEqual(inbox.recheckLease(messageKey, token), { status: 'not_projected' });
  const projected = inbox.project(messageKey, token);
  assert.equal(projected.status, 'projected');
  return { token, recordId: projected.recordId };
}

test('projected UTF-8 history is read at its published watermark and shares the QQ search ranking', async (t) => {
  const { dir, memory, enqueue } = fixture(t);
  const task = enqueue();
  const { token, recordId } = project(task);
  const { key, file, watermark, inbox, messageKey } = task;
  assert.equal(inbox.complete(messageKey), false);
  const published = fs.readFileSync(file);
  assert.equal(JSON.parse(fs.readFileSync(watermark, 'utf8')).bytes, published.length);
  assert.equal(JSON.parse(published).recordId, recordId);
  assert.equal(JSON.parse(published).messageKey, messageKey);
  assert.doesNotMatch(published.toString(), /fixture-secret/);
  fs.appendFileSync(file, published.toString().replace('共同的故事', '未发布的故事'));
  assert.equal(inbox.recheckLease(messageKey, token).status, 'ready');
  assert.equal(memory.archiveRows(key).length, 1);
  assert.equal(memory.listArchiveRows(key).rows[0].recordId, recordId);
  assert.equal(memory.search(key, { query: '未发布' }).matched, 0);
  const hit = memory.search(key, { query: '共同的故事', debug: true }).hits[0];
  assert.equal(memory.rowsAt(key, [hit, { file: hit.file, line: 2 }]).length, 1);
  const at = new Date(Date.UTC(2026, 10, 1));
  memory.archive('group:123', { dir: 'in', text: '共同的故事 🐋 [redacted]', at });
  assert.equal(hit.score, memory.search('group:123', { query: '共同的故事', debug: true }).hits[0].score);
  const day = [at.getFullYear(), at.getMonth() + 1, at.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
  const report = await createDailyReport({ stateDir: dir, now: () => at.getTime() }).compute(day);
  assert.deepEqual(Object.keys(report.sessions), ['group:123']);
});

test('a complete unpublished tail is republished once and a torn UTF-8 tail is replaced on replay', (t) => {
  const { memory, enqueue, reopen } = fixture(t);
  const task = enqueue();
  const { token, recordId } = project(task);
  const { file, watermark, messageKey, inbox, key } = task;
  const full = fs.readFileSync(file);
  assert.equal(inbox.release(messageKey, token).status, 'released');
  fs.rmSync(watermark);
  assert.equal(memory.archiveRows(key).length, 0);
  reopen();
  const resumed = task.bind();
  const second = project({ ...task, inbox: resumed });
  assert.equal(second.recordId, recordId);
  assert.deepEqual(fs.readFileSync(file), full);
  assert.equal(resumed.release(messageKey, second.token).status, 'released');
  fs.rmSync(watermark);
  fs.truncateSync(file, full.indexOf(Buffer.from('🐋')) + 2);
  const third = project({ ...task, inbox: resumed });
  assert.equal(third.recordId, recordId);
  assert.deepEqual(fs.readFileSync(file), full);
  assert.equal(memory.archiveRows(key).length, 1);
});

test('a SQLite failure after publishing retains the lease and replay does not append another record', (t) => {
  const { dbFile, memory, enqueue } = fixture(t);
  const { inbox, messageKey, key } = enqueue();
  const { token } = inbox.claim(messageKey);
  const fault = new DatabaseSync(dbFile);
  try {
    fault.exec(`CREATE TRIGGER fail_projection BEFORE UPDATE OF projected ON inbox_execution
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    assert.equal(inbox.project(messageKey, token).reason, 'storage_unavailable');
    assert.equal(inbox.recheckLease(messageKey, token).status, 'not_projected');
    assert.equal(memory.archiveRows(key).length, 1);
    fault.exec('DROP TRIGGER fail_projection');
    assert.equal(inbox.project(messageKey, token).status, 'projected');
    assert.equal(inbox.recheckLease(messageKey, token).status, 'ready');
    assert.equal(memory.archiveRows(key).length, 1);
  } finally {
    fault.close();
  }
});

test('a new projection only reads its own tail even when an earlier record occupies the same month', (t) => {
  const { memory, enqueue } = fixture(t);
  const first = enqueue(feishu, { text: 'x'.repeat(4000) });
  const { token } = project(first);
  assert.equal(first.inbox.finish(first.messageKey, token).status, 'completed');
  const bytes = fs.statSync(first.file).size;
  const readSync = fs.readSync;
  let readPrefix = false;
  const tracked = t.mock.method(fs, 'readSync', (...args) => {
    const [, , , length, offset] = args;
    if (offset === 0 && length === bytes) readPrefix = true;
    return readSync(...args);
  });
  project(enqueue(feishu, { id: 2 }));
  tracked.mock.restore();
  assert.equal(readPrefix, false);
  assert.equal(memory.archiveRows(first.key).length, 2);
});

test('revocation between claim, projection and execution clears the corresponding queue payload', (t) => {
  const { memory, enqueue } = fixture(t);
  const before = enqueue();
  const { token } = before.inbox.claim(before.messageKey);
  before.policy.allow.senders = [];
  assert.equal(before.inbox.project(before.messageKey, token).status, 'unauthorized');
  assert.deepEqual(before.inbox.pending(), []);
  assert.deepEqual(memory.archiveRows(before.key), []);
  const after = enqueue(feishu, { id: 2 });
  const second = project(after);
  after.policy.allow.senders = [];
  assert.equal(after.inbox.recheckLease(after.messageKey, second.token).status, 'unauthorized');
  assert.deepEqual(after.inbox.pending(), []);
});

test('record IDs, history references and forgetting are confined to platform, account, tenant and topic', (t) => {
  const { memory, enqueue, reopen } = fixture(t);
  const tasks = [enqueue(), enqueue({ ...feishu, accountId: 'cli_other' }), enqueue({ ...feishu, tenantId: 'tenant_b' }),
    enqueue(telegram), enqueue(telegram, { id: 2, threadId: '8' })];
  const projected = tasks.map(project);
  assert.equal(new Set(projected.map((item) => item.recordId)).size, tasks.length);
  const [first, other] = tasks;
  const { recordId, token } = projected[0];
  const hit = memory.search(first.key, { debug: true }).hits[0];
  for (const task of tasks.slice(1)) assert.deepEqual(memory.rowsAt(task.key, [hit]), []);
  assert.equal(other.inbox.forgetRecord(first.key, recordId).status, 'invalid_scope');
  assert.equal(first.inbox.forgetRecord(first.key, projected[1].recordId).status, 'not_found');
  const retained = enqueue(feishu, { id: 2, text: '留下的消息' });
  assert.equal(first.inbox.finish(first.messageKey, token).status, 'completed');
  project(retained);
  const keptHit = memory.search(first.key, { query: '留下的消息', debug: true }).hits[0];
  assert.equal(keptHit.line, 2);
  assert.equal(first.inbox.forgetRecord(first.key, recordId).status, 'forgotten');
  assert.equal(first.inbox.forgetRecord(first.key, projected[4].recordId).status, 'not_found');
  assert.doesNotMatch(fs.readFileSync(first.file, 'utf8'), /共同的故事/);
  assert.equal(memory.search(first.key, { query: '共同的故事' }).matched, 0);
  assert.equal(memory.rowsAt(first.key, [keptHit])[0].text, '留下的消息');
  reopen();
  assert.equal(first.bind().forgetRecord(first.key, recordId).status, 'forgotten');
  for (const task of tasks.slice(1)) assert.equal(memory.search(task.key, { query: '共同的故事' }).matched, 1);
});

test('forgetting a leased record invalidates execution and removes the queued body', (t) => {
  const { memory, enqueue } = fixture(t);
  const { inbox, messageKey, key } = enqueue();
  const { token, recordId } = project({ inbox, messageKey });
  assert.equal(inbox.forgetRecord(key, recordId).status, 'forgotten');
  assert.equal(inbox.recheckLease(messageKey, token).status, 'stale_lease');
  assert.equal(inbox.claim(messageKey).status, 'not_pending');
  assert.deepEqual(inbox.pending(), []);
  assert.deepEqual(memory.archiveRows(key), []);
});

test('a tombstone blocks execution when the SQLite cleanup of a forgotten task must be retried', (t) => {
  const { dbFile, memory, enqueue } = fixture(t);
  const { inbox, messageKey, key } = enqueue();
  const { token, recordId } = project({ inbox, messageKey });
  const fault = new DatabaseSync(dbFile);
  try {
    fault.exec(`CREATE TRIGGER fail_queue_cleanup BEFORE UPDATE OF event ON inbox_messages
      WHEN NEW.event IS NULL BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    assert.equal(inbox.forgetRecord(key, recordId).reason, 'storage_unavailable');
    assert.deepEqual(memory.archiveRows(key), []);
    assert.equal(inbox.recheckTask(messageKey).status, 'lease_required');
    assert.equal(Object.hasOwn(inbox.pending()[0].event, 'text'), false);
    fault.exec('DROP TRIGGER fail_queue_cleanup');
    assert.equal(inbox.recheckLease(messageKey, token).status, 'forgotten');
    assert.deepEqual(inbox.pending(), []);
  } finally { fault.close(); }
});

test('another SQLite connection cannot expose or complete a task that requires projection', (t) => {
  const { dbFile, enqueue } = fixture(t);
  const { messageKey, policy } = enqueue();
  const intakeStore = openChannelInbox(dbFile);
  try {
    const intake = intakeStore.bind(feishu, () => policy);
    assert.equal(intake.recheckTask(messageKey).status, 'lease_required');
    assert.equal(Object.hasOwn(intake.pending()[0].event, 'text'), false);
    assert.equal(intake.claim(messageKey).reason, 'archive_unavailable');
    assert.equal(intake.complete(messageKey), false);
  } finally { intakeStore.close(); }
});

test('a lease that expires during the authorization recheck cannot return a task for execution', (t) => {
  let time = Date.UTC(2026, 10, 1);
  const { enqueue } = fixture(t, { now: () => time, leaseMs: 100 });
  const task = enqueue();
  const { token } = project(task);
  const resumed = task.bind(() => {
    time += 100;
    return task.policy;
  });
  assert.equal(resumed.recheckLease(task.messageKey, token).status, 'stale_lease');
  assert.equal(task.inbox.claim(task.messageKey).status, 'claimed');
});

test('revoking a task removes its unpublished archive tail during recovery', (t) => {
  const { enqueue, memory } = fixture(t);
  const task = enqueue();
  const { token } = project(task);
  assert.equal(task.inbox.release(task.messageKey, token).status, 'released');
  fs.rmSync(task.watermark);
  task.policy.allow.senders = [];
  assert.equal(task.inbox.claim(task.messageKey).status, 'unauthorized');
  assert.deepEqual(task.inbox.pending(), []);
  assert.equal(fs.statSync(task.file).size, 0);
  assert.deepEqual(memory.archiveRows(task.key), []);
});

test('metadata mismatch and linked archive directories are rejected without reading or overwriting their targets', (t) => {
  const { memory, enqueue } = fixture(t);
  const task = enqueue();
  const { token } = project(task);
  const dir = path.dirname(task.file);
  const original = fs.readFileSync(task.file);
  const meta = path.join(dir, 'conversation.json');
  const contents = fs.readFileSync(meta);
  fs.writeFileSync(meta, '{}');
  assert.throws(() => memory.search(task.key), /archive/i);
  assert.equal(task.inbox.recheckLease(task.messageKey, token).reason, 'archive_unavailable');
  fs.writeFileSync(meta, contents);
  const moved = `${dir}-moved`;
  fs.renameSync(dir, moved);
  fs.symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => memory.search(task.key), /archive/i);
  assert.equal(task.inbox.project(task.messageKey, token).reason, 'archive_unavailable');
  assert.deepEqual(fs.readFileSync(path.join(moved, path.basename(task.file))), original);
});
