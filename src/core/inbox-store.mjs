import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateBindings, isolatedMapping, PRIVATE_BINDING_SCHEMA } from './channel-bindings.mjs';
import { routeChannelMessage, validDeliveryRef } from './channel-intake.mjs';
import { decodeIdentityKey, readAccountRef } from './identity.mjs';

const HOUR_MS = 60 * 60 * 1000;
const CHECKPOINT_MAX_AGE = 48 * HOUR_MS;
const DELIVERY_RETENTION = 72 * HOUR_MS;
const MAX_TELEGRAM_BATCH = 100;
const DELIVERY_PRUNE_LIMIT = 1000;
const LEASE_MS = 60_000;

const retry = (reason) => ({ status: 'retryableFailure', reason });
const scopeOf = (ref) => {
  const { platform, accountId, tenantId } = readAccountRef(ref);
  return JSON.stringify([platform, accountId, tenantId]);
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbox_messages (
    seq INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,
    business_key TEXT NOT NULL,
    message_key TEXT NOT NULL,
    decision TEXT NOT NULL,
    event TEXT,
    UNIQUE (scope, business_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_pending
    ON inbox_messages (scope, message_key) WHERE event IS NOT NULL;
  CREATE INDEX IF NOT EXISTS inbox_pending_order
    ON inbox_messages (scope, seq) WHERE event IS NOT NULL;
  CREATE TABLE IF NOT EXISTS inbox_deliveries (
    scope TEXT NOT NULL,
    delivery_ref TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    PRIMARY KEY (scope, delivery_ref)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS inbox_delivery_age
    ON inbox_deliveries (recorded_at);
  CREATE TABLE IF NOT EXISTS telegram_poll_state (
    scope TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    next_offset INTEGER,
    saved_at INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS inbox_execution (
    seq INTEGER PRIMARY KEY,
    dialogue_id TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    projected INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS inbox_projection_intents (
    seq INTEGER PRIMARY KEY,
    start_offset INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inbox_archive_mode (
    enabled INTEGER PRIMARY KEY CHECK (enabled = 1)
  );
`;

function checkpointOf(state, now) {
  const age = now - state.saved_at;
  const fresh = state.next_offset !== null && age >= 0 && age < CHECKPOINT_MAX_AGE;
  return { scope: state.scope, generation: state.generation, revision: state.revision, offset: fresh ? state.next_offset : null };
}

function orderedTelegramBatch(events, offset) {
  let next = offset ?? 0;
  for (const event of events) {
    if (!validDeliveryRef('telegram', event?.deliveryRef)) continue;
    const id = Number(event.deliveryRef);
    if (id < next) return false;
    next = id + 1;
  }
  return true;
}

function taskPayload(event, mapping) {
  const taskId = `task_${createHash('sha256').update(event.messageKey).digest('hex')}`;
  return { taskId, ...mapping, event };
}

function readTask({ decision, event: stored }) {
  const payload = JSON.parse(stored);
  // Before mapping was introduced, the payload was the normalized event alone.
  // Those rows were admitted in their original scope even if now bound.
  const task = Object.hasOwn(payload, 'event') ? payload : taskPayload(payload, isolatedMapping(payload));
  return { ...task, decision };
}

// The caller provides a trusted file path in its private state directory (with
// restricted ACLs on Windows). Neither transports nor user input choose the path.
export function openChannelInbox(file, { capacity = 1000, now = Date.now, leaseMs = LEASE_MS, archive = null } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid inbox capacity');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > HOUR_MS) throw new RangeError('Invalid execution lease duration');
  try {
    // Opening and closing an existing inode outside SQLite can release its
    // POSIX locks, including locks held by another connection in this process.
    closeSync(openSync(file, 'ax', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const db = new DatabaseSync(file);
  let archiveMode;
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA secure_delete = ON;');
    db.exec(SCHEMA);
    db.exec(PRIVATE_BINDING_SCHEMA);
    archiveMode = db.prepare('SELECT enabled FROM inbox_archive_mode WHERE enabled = 1');
    if (archive && !archiveMode.get()) db.exec('INSERT OR IGNORE INTO inbox_archive_mode VALUES (1)');
    const hasDialogue = () => db.prepare('PRAGMA table_info(inbox_messages)').all().some(({ name }) => name === 'dialogue_id');
    if (!hasDialogue()) transact(() => {
      if (hasDialogue()) return;
      db.exec('ALTER TABLE inbox_messages ADD COLUMN dialogue_id TEXT');
      const saveDialogue = db.prepare('UPDATE inbox_messages SET dialogue_id = ? WHERE seq = ?');
      for (const row of db.prepare('SELECT seq, event, decision FROM inbox_messages WHERE event IS NOT NULL').all()) {
        saveDialogue.run(readTask(row).dialogueId, row.seq);
      }
      db.exec('CREATE INDEX inbox_dialogue_order ON inbox_messages (dialogue_id, seq) WHERE event IS NOT NULL');
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const expire = db.prepare(`
    DELETE FROM inbox_deliveries WHERE (scope, delivery_ref) IN (
      SELECT scope, delivery_ref FROM inbox_deliveries
      WHERE recorded_at <= ? ORDER BY recorded_at LIMIT ?
    )
  `);
  const findDelivery = db.prepare(
    'SELECT 1 FROM inbox_deliveries WHERE scope = ? AND delivery_ref = ? AND recorded_at > ?',
  );
  const saveDelivery = db.prepare(`
    INSERT INTO inbox_deliveries VALUES (?, ?, ?, ?)
    ON CONFLICT (scope, delivery_ref) DO UPDATE SET recorded_at = excluded.recorded_at, outcome = excluded.outcome
  `);
  const findMessage = db.prepare('SELECT 1 FROM inbox_messages WHERE scope = ? AND business_key = ?');
  const countPending = db.prepare('SELECT count(*) AS count FROM inbox_messages WHERE scope = ? AND event IS NOT NULL');
  const saveMessage = db.prepare(
    'INSERT INTO inbox_messages (scope, business_key, message_key, decision, event, dialogue_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const listPending = db.prepare(
    'SELECT decision, event FROM inbox_messages WHERE scope = ? AND event IS NOT NULL ORDER BY seq LIMIT ?',
  );
  const findPending = db.prepare(
    'SELECT seq, decision, event, dialogue_id FROM inbox_messages WHERE scope = ? AND message_key = ? AND event IS NOT NULL',
  );
  const clearPayload = db.prepare('UPDATE inbox_messages SET event = NULL, dialogue_id = NULL WHERE seq = ?');
  const firstInDialogue = db.prepare(`
    SELECT seq FROM inbox_messages WHERE dialogue_id = ? AND event IS NOT NULL ORDER BY seq LIMIT 1
  `);
  const dialogueLease = db.prepare('SELECT * FROM inbox_execution WHERE dialogue_id = ?');
  const taskLease = db.prepare('SELECT * FROM inbox_execution WHERE seq = ?');
  const saveLease = db.prepare('INSERT INTO inbox_execution (seq, dialogue_id, token, expires_at) VALUES (?, ?, ?, ?)');
  const removeLease = db.prepare('DELETE FROM inbox_execution WHERE seq = ?');
  const extendLease = db.prepare('UPDATE inbox_execution SET expires_at = ? WHERE seq = ?');
  const saveProjection = db.prepare('UPDATE inbox_execution SET projected = ? WHERE seq = ?');
  const findIntent = db.prepare('SELECT start_offset FROM inbox_projection_intents WHERE seq = ?');
  const saveIntent = db.prepare('INSERT INTO inbox_projection_intents VALUES (?, ?)');
  const removeIntent = db.prepare('DELETE FROM inbox_projection_intents WHERE seq = ?');
  const advanceGeneration = db.prepare(`
    INSERT INTO telegram_poll_state (scope, generation, revision) VALUES (?, 1, 0)
    ON CONFLICT (scope) DO UPDATE SET generation = generation + 1, revision = 0
    RETURNING generation
  `);
  const readPollState = db.prepare('SELECT * FROM telegram_poll_state WHERE scope = ?');
  const saveCheckpoint = db.prepare(
    'UPDATE telegram_poll_state SET revision = ?, next_offset = ?, saved_at = ? WHERE scope = ?',
  );

  function transact(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLite may already have rolled back on an I/O error or full disk.
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function write(work) {
    try { return transact(work); }
    catch (error) {
      if (error.code !== 'ERR_SQLITE_ERROR') throw error;
      return retry('storage_unavailable');
    }
  }

  function archiveWrite(work) {
    if (!archive) return retry('archive_unavailable');
    try { return work(); }
    catch (error) {
      // Filesystem errors and validation failures must leave the task retryable.
      if (error.code === 'ERR_CHANNEL_ARCHIVE' || error.syscall) return retry('archive_unavailable');
      throw error;
    }
  }

  const privateBindings = createPrivateBindings(db, transact);

  function mappingFor(event) {
    const { chatType, threadId } = event.conversation;
    return chatType === 'private' && threadId === null ? privateBindings.resolve(event) : isolatedMapping(event);
  }

  function completeTask(seq) {
    removeLease.run(seq);
    removeIntent.run(seq);
    clearPayload.run(seq);
  }

  function bind(account, getPolicy) {
    const { platform } = readAccountRef(account);
    if (platform === 'qq' || typeof getPolicy !== 'function') throw new TypeError('Invalid inbox binding');
    const scope = scopeOf(account);

    function readPolicy() {
      try {
        const policy = getPolicy();
        return scopeOf(policy) === scope ? policy : null;
      } catch {
        return null;
      }
    }

    function record(input, policy, receivedAt) {
      const deliveryRef = input?.deliveryRef;
      if (!validDeliveryRef(platform, deliveryRef)) return retry('invalid_delivery');
      if (findDelivery.get(scope, deliveryRef, receivedAt - DELIVERY_RETENTION)) return { status: 'duplicate' };
      if (!policy) return retry('policy_unavailable');

      const { decision, event, reason } = routeChannelMessage(policy, input);
      if (reason === 'invalid_policy') return retry('policy_unavailable');
      if (decision === 'drop') {
        saveDelivery.run(scope, deliveryRef, receivedAt, reason);
        return { status: 'durableFiltered', reason };
      }

      const businessKey = platform === 'feishu' ? event.message.messageId : event.messageKey;
      if (findMessage.get(scope, businessKey)) {
        saveDelivery.run(scope, deliveryRef, receivedAt, 'duplicate');
        return { status: 'duplicate' };
      }
      if (countPending.get(scope).count >= capacity) return retry('queue_full');
      const task = taskPayload(event, mappingFor(event));
      saveMessage.run(scope, businessKey, event.messageKey, decision, JSON.stringify(task), task.dialogueId);
      saveDelivery.run(scope, deliveryRef, receivedAt, 'accepted');
      return { status: 'durableAccepted' };
    }

    function accept(event) {
      const receivedAt = now();
      const policy = readPolicy();
      return write(() => {
        expire.run(receivedAt - DELIVERY_RETENTION, DELIVERY_PRUNE_LIMIT);
        return record(event, policy, receivedAt);
      });
    }

    function checkTask(messageKey, policy, row) {
      if (!row) return { status: 'not_pending' };
      if (!policy) return { status: 'policy_unavailable' };
      const task = readTask(row);
      const { decision, reason, event, isAdmin } = routeChannelMessage(policy, task.event);
      if (reason === 'invalid_policy') return { status: 'policy_unavailable' };
      if (decision === 'drop' || event.messageKey !== messageKey) return { status: 'unauthorized' };

      const { principalId, dialogueId, bindingRevision } = mappingFor(event);
      if (principalId !== task.principalId || dialogueId !== task.dialogueId || bindingRevision !== task.bindingRevision) {
        return { status: 'binding_changed' };
      }
      return { status: 'ready', task: { ...task, decision, event, isAdmin } };
    }

    function checkOrCancel(messageKey, policy, row) {
      const result = checkTask(messageKey, policy, row);
      if (result.status === 'unauthorized' || result.status === 'binding_changed') {
        if (archive) {
          const failed = archiveWrite(() => archive.discardTail(readTask(row).event));
          if (failed) return failed;
        }
        completeTask(row.seq);
      }
      return result;
    }

    function claim(messageKey) {
      return write(() => {
        if (!archive && archiveMode.get()) return retry('archive_unavailable');
        const row = findPending.get(scope, messageKey);
        if (!row) return { status: 'not_pending' };
        const existing = dialogueLease.get(row.dialogue_id);
        if (existing?.seq === row.seq && existing.expires_at > now()) return { status: 'busy' };
        const checked = checkOrCancel(messageKey, readPolicy(), row);
        if (checked.status !== 'ready') return checked;
        if (firstInDialogue.get(row.dialogue_id).seq !== row.seq) return { status: 'out_of_order' };
        const time = now();
        if (existing?.expires_at > time) return { status: 'busy' };
        if (existing) removeLease.run(existing.seq);
        const token = randomUUID();
        const expiresAt = time + leaseMs;
        saveLease.run(row.seq, row.dialogue_id, token, expiresAt);
        return { status: 'claimed', token, expiresAt };
      });
    }

    function withLease(messageKey, token, work) {
      return write(() => {
        if (!archive && archiveMode.get()) return retry('archive_unavailable');
        const row = findPending.get(scope, messageKey);
        const lease = row && taskLease.get(row.seq);
        if (!lease || lease.token !== token || lease.expires_at <= now()) return { status: 'stale_lease' };
        return work(row, lease);
      });
    }

    function project(messageKey, token) {
      const reserveOrProject = (row, lease) => {
        const checked = checkOrCancel(messageKey, readPolicy(), row);
        if (checked.status !== 'ready') return checked;
        if (lease.expires_at <= now()) return { status: 'stale_lease' };
        return archiveWrite(() => {
          const event = checked.task.event;
          const intent = findIntent.get(row.seq);
          if (!intent) {
            // Commit the earliest possible offset before the first filesystem
            // mutation. Recovery only needs to inspect records after this point.
            saveIntent.run(row.seq, archive.position(event));
            return { status: 'reserved' };
          }
          const projected = lease.projected ? archive.recordAt(event, lease.projected - 1) : archive.project(event, intent.start_offset);
          if (projected.deleted) {
            completeTask(row.seq);
            return { status: 'forgotten' };
          }
          if (!lease.projected) saveProjection.run(projected.offset + 1, row.seq);
          return { status: 'projected', recordId: projected.recordId };
        });
      };
      const result = withLease(messageKey, token, reserveOrProject);
      return result.status === 'reserved' ? withLease(messageKey, token, reserveOrProject) : result;
    }

    function recheckLease(messageKey, token) {
      return withLease(messageKey, token, (row, lease) => {
        const checked = checkOrCancel(messageKey, readPolicy(), row);
        if (checked.status !== 'ready') return checked;
        if (lease.expires_at <= now()) return { status: 'stale_lease' };
        if (!lease.projected) return { status: 'not_projected' };
        return archiveWrite(() => {
          const projected = archive.recordAt(checked.task.event, lease.projected - 1);
          if (!projected.deleted) {
            if (lease.expires_at <= now()) return { status: 'stale_lease' };
            return { ...checked, recordId: projected.recordId, expiresAt: lease.expires_at };
          }
          completeTask(row.seq);
          return { status: 'forgotten' };
        });
      });
    }

    // Management callers supply an already authorized original conversation.
    function forgetRecord(conversationKey, recordId) {
      try {
        if (!conversationKey.startsWith('c1_') || scopeOf(decodeIdentityKey(conversationKey)) !== scope) {
          return { status: 'invalid_scope' };
        }
      } catch { return { status: 'invalid_scope' }; }
      return write(() => archiveWrite(() => {
        const messageKey = archive.forget(conversationKey, recordId);
        if (!messageKey) return { status: 'not_found' };
        const row = findPending.get(scope, messageKey);
        if (row) completeTask(row.seq);
        return { status: 'forgotten' };
      }));
    }

    function startPolling() {
      const { generation } = advanceGeneration.get(scope);
      return {
        readCheckpoint() {
          const state = readPollState.get(scope);
          return state.generation === generation ? checkpointOf(state, now()) : null;
        },
        // Only call after getUpdates succeeds, using the token issued before the
        // request. No local checkpoint is consumed on a network error.
        acceptBatch(events, expected) {
          if (!Array.isArray(events) || events.length > MAX_TELEGRAM_BATCH) return retry('invalid_batch');
          const receivedAt = now();
          const policy = readPolicy();
          return write(() => {
            const state = readPollState.get(scope);
            const current = checkpointOf(state, receivedAt);
            // A request issued just before expiry can still return successfully.
            const expectedOffset = expected?.offset;
            if (state.generation !== generation || expected?.scope !== scope || expected.generation !== generation ||
                expected.revision !== state.revision ||
                (expectedOffset !== current.offset && expectedOffset !== state.next_offset)) {
              return retry('stale_checkpoint');
            }
            if (!orderedTelegramBatch(events, expectedOffset)) return retry('invalid_batch');

            expire.run(receivedAt - DELIVERY_RETENTION, DELIVERY_PRUNE_LIMIT);
            const results = [];
            let blocked = null;
            let offset = null;
            for (const event of events) {
              const result = record(event, policy, receivedAt);
              if (result.status === 'retryableFailure') {
                blocked = result.reason;
                break;
              }
              results.push(result);
              offset = Number(event.deliveryRef) + 1;
            }
            const revision = state.revision + 1;
            saveCheckpoint.run(revision, offset, offset === null ? null : receivedAt, scope);
            return { status: 'committed', results, blocked, checkpoint: { scope, generation, revision, offset } };
          });
        },
      };
    }

    return {
      ...(platform === 'feishu' ? { accept } : { startPolling }),
      // The durable consumer gets source metadata for recovery. Only a checked,
      // projected lease can return the body when archive support is enabled.
      pending: (limit = 100) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid inbox limit');
        const rows = listPending.all(scope, limit);
        const omitBody = !!archiveMode.get();
        return rows.map((row) => {
          const task = readTask(row);
          if (omitBody) delete task.event.text;
          return task;
        });
      },
      recheckTask: (messageKey) => {
        const checked = checkTask(messageKey, readPolicy(), findPending.get(scope, messageKey));
        return checked.status === 'ready' && archiveMode.get() ? { status: 'lease_required' } : checked;
      },
      claim,
      project,
      recheckLease,
      forgetRecord,
      renew: (messageKey, token) => withLease(messageKey, token, (row, lease) => {
        const checked = checkOrCancel(messageKey, readPolicy(), row);
        if (checked.status !== 'ready') return checked;
        const time = now();
        if (lease.expires_at <= time) return { status: 'stale_lease' };
        const expiresAt = time + leaseMs;
        extendLease.run(expiresAt, row.seq);
        return { status: 'renewed', expiresAt };
      }),
      release: (messageKey, token) => withLease(messageKey, token, (row) => {
        removeLease.run(row.seq);
        return { status: 'released' };
      }),
      finish: (messageKey, token) => withLease(messageKey, token, (row, lease) => {
        if (!lease.projected) return { status: 'not_projected' };
        completeTask(row.seq);
        return { status: 'completed' };
      }),
      complete: (messageKey) => transact(() => {
        if (archiveMode.get()) return false;
        const row = findPending.get(scope, messageKey);
        if (!row || taskLease.get(row.seq)) return false;
        completeTask(row.seq);
        return true;
      }),
    };
  }

  return { bind, privateBindings, close: () => db.close() };
}
