import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateBindings, isolatedMapping, PRIVATE_BINDING_SCHEMA } from './channel-bindings.mjs';
import { routeChannelMessage, validDeliveryRef } from './channel-intake.mjs';
import { readAccountRef } from './identity.mjs';

const HOUR_MS = 60 * 60 * 1000;
const CHECKPOINT_MAX_AGE = 48 * HOUR_MS;
const DELIVERY_RETENTION = 72 * HOUR_MS;
const MAX_TELEGRAM_BATCH = 100;
const DELIVERY_PRUNE_LIMIT = 1000;

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
export function openChannelInbox(file, { capacity = 1000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid inbox capacity');
  try {
    // Opening and closing an existing inode outside SQLite can release its
    // POSIX locks, including locks held by another connection in this process.
    closeSync(openSync(file, 'ax', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA secure_delete = ON;');
    db.exec(SCHEMA);
    db.exec(PRIVATE_BINDING_SCHEMA);
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
    'INSERT INTO inbox_messages (scope, business_key, message_key, decision, event) VALUES (?, ?, ?, ?, ?)',
  );
  const listPending = db.prepare(
    'SELECT decision, event FROM inbox_messages WHERE scope = ? AND event IS NOT NULL ORDER BY seq LIMIT ?',
  );
  const findPending = db.prepare(
    'SELECT decision, event FROM inbox_messages WHERE scope = ? AND message_key = ? AND event IS NOT NULL',
  );
  const clearPayload = db.prepare('UPDATE inbox_messages SET event = NULL WHERE scope = ? AND message_key = ? AND event IS NOT NULL');
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

  const privateBindings = createPrivateBindings(db, transact);

  function mappingFor(event) {
    const { chatType, threadId } = event.conversation;
    return chatType === 'private' && threadId === null ? privateBindings.resolve(event) : isolatedMapping(event);
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
      saveMessage.run(scope, businessKey, event.messageKey, decision, JSON.stringify(task));
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

    function recheckTask(messageKey) {
      const policy = readPolicy();
      const row = findPending.get(scope, messageKey);
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
      // Internal recovery view. The consumer must recheck the task and acquire
      // an execution lease before projecting or running it.
      pending: (limit = 100) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid inbox limit');
        return listPending.all(scope, limit).map(readTask);
      },
      recheckTask,
      complete: (messageKey) => clearPayload.run(scope, messageKey).changes > 0,
    };
  }

  return { bind, privateBindings, close: () => db.close() };
}
