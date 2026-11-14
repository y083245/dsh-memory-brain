import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SENSITIVE_RE } from '../sensitive.js';
import { createPrivateBindings, isolatedMapping, PRIVATE_BINDING_SCHEMA } from './channel-bindings.mjs';
import { resolveTextTarget, routeChannelMessage, validDeliveryRef } from './channel-intake.mjs';
import { decodeIdentityKey, encodeConversationKey, encodePersonKey, readAccountRef, sameAccount } from './identity.mjs';

const HOUR_MS = 60 * 60 * 1000;
const CHECKPOINT_MAX_AGE = 48 * HOUR_MS;
const DELIVERY_RETENTION = 72 * HOUR_MS;
const MAX_TELEGRAM_BATCH = 100;
const DELIVERY_PRUNE_LIMIT = 1000;
const LEASE_MS = 60_000;
const DEFAULT_ACTIVE_TURNS = 4;
const MAX_TOOL_OBSERVATIONS = 256;
const MAX_TOOL_FEEDBACK = 100;
const MAX_TOOL_FEEDBACK_LENGTH = 4096;
const UNRESOLVED_TURNS = "state IN ('submitting', 'accepted', 'uncertain', 'retiring')";
const TURN_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

const retry = (reason) => ({ status: 'retryableFailure', reason });
const validTurnIdentifier = (id) => typeof id === 'string' && TURN_IDENTIFIER.test(id);
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
  CREATE TABLE IF NOT EXISTS inbox_turn_journal (
    seq INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,
    task_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    dialogue_id TEXT NOT NULL,
    binding_revision TEXT,
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    request_id TEXT NOT NULL UNIQUE,
    turn_id TEXT,
    state TEXT NOT NULL CHECK (${UNRESOLVED_TURNS} OR state IN ('completed', 'retired'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_turn_active_source
    ON inbox_turn_journal (conversation_key) WHERE ${UNRESOLVED_TURNS};
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_turn_active_dialogue
    ON inbox_turn_journal (dialogue_id) WHERE ${UNRESOLVED_TURNS};
  CREATE INDEX IF NOT EXISTS inbox_turn_active_scope
    ON inbox_turn_journal (scope, seq) WHERE ${UNRESOLVED_TURNS};
  CREATE TABLE IF NOT EXISTS inbox_text_turn_projection (
    seq INTEGER PRIMARY KEY,
    occurred_at INTEGER NOT NULL,
    projected_offset INTEGER NOT NULL CHECK (projected_offset >= 0)
  );
  CREATE TABLE IF NOT EXISTS inbox_tool_state (
    conversation_key TEXT PRIMARY KEY,
    read_through_seq INTEGER NOT NULL,
    group_policy TEXT NOT NULL DEFAULT 'observe' CHECK (group_policy IN ('directed', 'observe'))
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS inbox_tool_observations (
    conversation_key TEXT NOT NULL,
    seq INTEGER NOT NULL REFERENCES inbox_messages(seq),
    occurred_at INTEGER NOT NULL,
    projected_offset INTEGER NOT NULL,
    PRIMARY KEY (conversation_key, seq)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS inbox_tool_feedback (
    seq INTEGER PRIMARY KEY,
    conversation_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (conversation_key, request_id, call_id)
  );
  CREATE INDEX IF NOT EXISTS inbox_tool_feedback_order ON inbox_tool_feedback (conversation_key, seq);
  CREATE TABLE IF NOT EXISTS inbox_tool_feedback_receipts (
    call_key TEXT PRIMARY KEY
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

const taskIdFor = (messageKey) => `task_${createHash('sha256').update(messageKey).digest('hex')}`;

function taskPayload(event, mapping) {
  return { taskId: taskIdFor(event.messageKey), ...mapping, event };
}

function readTask({ decision, event: stored }) {
  const payload = JSON.parse(stored);
  // Before mapping was introduced, the payload was the normalized event alone.
  // Those rows were admitted in their original scope even if now bound.
  const task = Object.hasOwn(payload, 'event') ? payload : taskPayload(payload, isolatedMapping(payload));
  return { ...task, decision };
}

function turnMetadata(row) {
  return {
    taskId: row.task_id,
    conversationKey: row.conversation_key,
    dialogueId: row.dialogue_id,
    bindingRevision: row.binding_revision,
    sessionId: row.session_id,
    generation: row.generation,
    requestId: row.request_id,
    turnId: row.turn_id,
    state: row.state,
  };
}

// The caller provides a trusted file path in its private state directory (with
// restricted ACLs on Windows). Neither transports nor user input choose the path.
export function openChannelInbox(file, { capacity = 1000, now = Date.now, leaseMs = LEASE_MS, archive = null, outbox = null } = {}) {
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
  const toolPending = db.prepare(`
    SELECT m.seq, m.decision, m.event, m.message_key, execution.projected, intent.start_offset
    FROM inbox_messages AS m LEFT JOIN inbox_execution AS execution USING (seq)
    LEFT JOIN inbox_projection_intents AS intent USING (seq)
    WHERE m.scope = ? AND m.event IS NOT NULL AND m.seq > ? ORDER BY m.seq
  `);
  const toolObservations = db.prepare(`
    SELECT observed.seq, observed.occurred_at, observed.projected_offset, m.message_key
    FROM inbox_tool_observations AS observed JOIN inbox_messages AS m USING (seq)
    WHERE observed.conversation_key = ? AND observed.seq > ? ORDER BY observed.seq
  `);
  const toolState = db.prepare('SELECT * FROM inbox_tool_state WHERE conversation_key = ?');
  const groupWake = db.prepare("SELECT 1 FROM inbox_tool_state WHERE conversation_key = ? AND group_policy = 'directed'");
  const saveToolState = db.prepare(`
    INSERT INTO inbox_tool_state (conversation_key, read_through_seq, group_policy) VALUES (?, ?, coalesce(?, 'observe'))
    ON CONFLICT(conversation_key) DO UPDATE SET read_through_seq = max(read_through_seq, excluded.read_through_seq),
      group_policy = coalesce(?, group_policy) RETURNING read_through_seq
  `);
  const saveObservation = db.prepare('INSERT INTO inbox_tool_observations VALUES (?, ?, ?, ?)');
  const pruneObservations = db.prepare('DELETE FROM inbox_tool_observations WHERE conversation_key = ? AND seq <= ?');
  const oldestObservation = db.prepare('SELECT seq FROM inbox_tool_observations WHERE conversation_key = ? ORDER BY seq DESC LIMIT 1 OFFSET ?');
  const findObservation = db.prepare(`
    SELECT observed.seq FROM inbox_tool_observations AS observed JOIN inbox_messages AS m USING (seq)
    WHERE observed.conversation_key = ? AND m.scope = ? AND m.message_key = ?
  `);
  const removeObservation = db.prepare('DELETE FROM inbox_tool_observations WHERE conversation_key = ? AND seq = ?');
  const findFeedback = db.prepare('SELECT 1 FROM inbox_tool_feedback WHERE conversation_key = ? AND request_id = ? AND call_id = ?');
  const saveFeedbackReceipt = db.prepare('INSERT INTO inbox_tool_feedback_receipts VALUES (?) ON CONFLICT DO NOTHING');
  const saveFeedback = db.prepare('INSERT INTO inbox_tool_feedback (conversation_key, request_id, call_id, message, created_at) VALUES (?, ?, ?, ?, ?)');
  const pruneFeedback = db.prepare(`
    DELETE FROM inbox_tool_feedback WHERE conversation_key = ? AND seq <= (
      SELECT seq FROM inbox_tool_feedback WHERE conversation_key = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
    )
  `);
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
  const findTurn = db.prepare('SELECT * FROM inbox_turn_journal WHERE seq = ?');
  const requestExists = db.prepare('SELECT 1 FROM inbox_turn_journal WHERE request_id = ?');
  const findTextTurn = db.prepare(`
    SELECT journal.*, message.event, message.decision, message.message_key, projection.occurred_at, projection.projected_offset
    FROM inbox_turn_journal AS journal JOIN inbox_messages AS message USING (seq)
    LEFT JOIN inbox_text_turn_projection AS projection USING (seq)
    WHERE journal.scope = ? AND journal.request_id = ?
  `);
  const saveTextProjection = db.prepare('INSERT INTO inbox_text_turn_projection VALUES (?, ?, ?)');
  const removeTextProjection = db.prepare('DELETE FROM inbox_text_turn_projection WHERE seq = ?');
  const forgetTextProjection = db.prepare(`
    DELETE FROM inbox_text_turn_projection WHERE seq = (SELECT seq FROM inbox_turn_journal WHERE scope = ? AND request_id = ?)
  `);
  const unresolvedBySource = db.prepare(
    `SELECT * FROM inbox_turn_journal WHERE conversation_key = ? AND ${UNRESOLVED_TURNS}`,
  );
  const unresolvedByDialogue = db.prepare(
    `SELECT * FROM inbox_turn_journal WHERE dialogue_id = ? AND ${UNRESOLVED_TURNS}`,
  );
  const activeTurnAt = db.prepare(`
    SELECT 1 FROM inbox_turn_journal INDEXED BY inbox_turn_active_scope
    WHERE ${UNRESOLVED_TURNS} LIMIT 1 OFFSET ?
  `);
  const saveTurn = db.prepare(`
    INSERT INTO inbox_turn_journal (
      seq, scope, task_id, conversation_key, dialogue_id, binding_revision, session_id, generation, request_id, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting') RETURNING *
  `);
  const saveTurnState = db.prepare(`
    UPDATE inbox_turn_journal SET state = ?, turn_id = ? WHERE seq = ? RETURNING *
  `);
  const removeTurn = db.prepare('DELETE FROM inbox_turn_journal WHERE seq = ?');
  const listOrphanedTurns = db.prepare(`
    SELECT journal.* FROM inbox_turn_journal AS journal JOIN inbox_messages AS message USING (seq)
    WHERE journal.scope = ? AND message.event IS NULL AND ${UNRESOLVED_TURNS} ORDER BY journal.seq LIMIT ?
  `);
  const findOrphanedTurn = db.prepare(`
    SELECT journal.* FROM inbox_turn_journal AS journal JOIN inbox_messages AS message USING (seq)
    WHERE journal.scope = ? AND request_id = ? AND message.event IS NULL AND ${UNRESOLVED_TURNS}
  `);
  const listRecoveryScopes = db.prepare(`
    SELECT scope FROM inbox_messages WHERE event IS NOT NULL
    UNION
    SELECT scope FROM inbox_turn_journal WHERE ${UNRESOLVED_TURNS}
  `);

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

  function completeTask(seq, retainTextSource = false) {
    // Cancellation clears the body and lease while the journal still tracks remote work.
    removeLease.run(seq);
    removeIntent.run(seq);
    if (!retainTextSource) removeTextProjection.run(seq);
    clearPayload.run(seq);
  }

  function blockingTurn({ dialogueId, event: { conversationKey } }) {
    return unresolvedBySource.get(conversationKey) ?? unresolvedByDialogue.get(dialogueId);
  }

  function recordTurnEvidence(row, { state, turnId }) {
    // Remote retirement can outlive a lease. Hold its blockers until retirement
    // is confirmed, even when a concurrent reader has exact completion evidence.
    if ((row.state === 'retiring' && state !== 'retiring' && state !== 'retired') ||
        (state === 'retired' && row.state !== 'retiring')) return { status: 'turn_conflict' };
    if (turnId != null && !validTurnIdentifier(turnId)) return { status: 'invalid_turn' };
    if (turnId != null && row.turn_id !== null && row.turn_id !== turnId) return { status: 'turn_conflict' };
    const exactTurnId = turnId ?? row.turn_id;
    if (state === 'completed' && exactTurnId === null) return { status: 'turn_conflict' };
    const unchanged = row.state === state && row.turn_id === exactTurnId;
    const turn = turnMetadata(unchanged ? row : saveTurnState.get(state, exactTurnId, row.seq));
    return { status: state === 'completed' || state === 'retired' ? state : 'updated', turn };
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

    function route(policy, input, sourceKey) {
      const routed = routeChannelMessage(policy, input);
      if (routed.decision === 'observe' && groupWake.get(sourceKey ?? routed.event.conversationKey)) {
        return { decision: 'drop', reason: 'not_triggered' };
      }
      return routed;
    }

    function record(input, policy, receivedAt) {
      const deliveryRef = input?.deliveryRef;
      if (!validDeliveryRef(platform, deliveryRef)) return retry('invalid_delivery');
      if (findDelivery.get(scope, deliveryRef, receivedAt - DELIVERY_RETENTION)) return { status: 'duplicate' };
      if (!policy) return retry('policy_unavailable');

      const { decision, event, reason } = route(policy, input);
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
      const { decision, reason, event, isAdmin } = route(policy, task.event, task.event.conversationKey);
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

    function checkProjectedTask(messageKey, row, lease) {
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
    }

    function recheckLease(messageKey, token) {
      return withLease(messageKey, token, (row, lease) => checkProjectedTask(messageKey, row, lease));
    }

    function readTurn(messageKey, token) {
      return withLease(messageKey, token, (row) => {
        const turn = findTurn.get(row.seq);
        if (turn) return { status: 'turn', turn: turnMetadata(turn) };
        if (row.decision === 'directed' && blockingTurn(readTask(row))) return { status: 'blocked_turn' };
        return { status: 'no_turn' };
      });
    }

    // Tool callbacks can arrive after the dispatch lease is released. They may
    // check the exact durable turn and its source without obtaining the body.
    function readTextTurn({ requestId, conversationKey, bindingRevision, sessionId, generation }, { source, allowCompleted = false } = {}) {
      return write(() => {
        const row = findTextTurn.get(scope, requestId);
        const denied = { status: 'denied' };
        if (!archive || !row || row.projected_offset === null || row.task_id !== requestId || row.conversation_key !== conversationKey ||
            row.binding_revision !== bindingRevision || row.session_id !== sessionId || row.generation !== generation) return denied;
        const completed = row.state === 'completed';
        if (completed ? (!allowCompleted || !source) :
          (row.event === null || !['submitting', 'accepted', 'uncertain'].includes(row.state))) return denied;

        const projected = archiveWrite(() => archive.recordAt({
          conversationKey, messageKey: row.message_key, occurredAt: row.occurred_at,
        }, row.projected_offset));
        if (projected.status === 'retryableFailure') return projected;
        if (projected.deleted) return denied;

        if (completed) {
          const { conversation, actor } = source;
          const personKey = encodePersonKey(actor);
          if (encodeConversationKey(conversation) !== conversationKey || projected.personKey !== personKey) return denied;
          const policy = readPolicy();
          if (!policy) return denied;
          if (!resolveTextTarget(policy, conversation, { source }) ||
              mappingFor({ conversation, actor, conversationKey, personKey }).bindingRevision !== bindingRevision) {
            return { status: 'revoked' };
          }
          return { status: 'completed' };
        }
        const checked = checkTask(row.message_key, readPolicy(), row);
        if (checked.status === 'unauthorized' || checked.status === 'binding_changed') return { status: 'revoked' };
        if (checked.status !== 'ready' || checked.task.decision !== 'directed' ||
            checked.task.taskId !== requestId || checked.task.bindingRevision !== bindingRevision ||
            checked.task.dialogueId !== row.dialogue_id) return denied;
        const { event } = checked.task;
        if (event.conversationKey !== conversationKey || event.personKey !== projected.personKey ||
            (source && (encodeConversationKey(source.conversation) !== conversationKey ||
            encodePersonKey(source.actor) !== event.personKey))) return denied;
        return { status: 'active', source: { conversation: event.conversation, actor: event.actor }, message: event.message };
      });
    }

    function beginTurn(messageKey, token, intent) {
      return withLease(messageKey, token, (row, lease) => {
        const checked = checkProjectedTask(messageKey, row, lease);
        if (checked.status !== 'ready') return checked;
        const { task } = checked;
        if (task.decision !== 'directed') return { status: 'not_directed' };
        const existing = findTurn.get(row.seq);
        if (existing) return { status: 'turn', turn: turnMetadata(existing) };
        const { sessionId, generation, requestId, retainTextSource, maxActiveTurns = DEFAULT_ACTIVE_TURNS } = intent ?? {};
        if (!validTurnIdentifier(sessionId) || !validTurnIdentifier(requestId) ||
            !Number.isSafeInteger(generation) || generation < 0 ||
            !Number.isSafeInteger(maxActiveTurns) || maxActiveTurns < 1) {
          return { status: 'invalid_turn' };
        }
        const { taskId, dialogueId, bindingRevision, event: { conversationKey } } = task;
        const blocked = blockingTurn(task);
        if (blocked) return { status: 'blocked_turn', turn: turnMetadata(blocked) };
        if (requestExists.get(requestId)) return { status: 'turn_conflict' };
        if (activeTurnAt.get(maxActiveTurns - 1)) return { status: 'turn_capacity' };
        if (lease.expires_at <= now()) return { status: 'stale_lease' };
        const turn = saveTurn.get(row.seq, scope, taskId, conversationKey, dialogueId, bindingRevision,
          sessionId, generation, requestId);
        if (retainTextSource === true) saveTextProjection.run(row.seq, task.event.occurredAt, lease.projected - 1);
        return { status: 'started', turn: turnMetadata(turn) };
      });
    }

    // Evidence refers to an already journaled request. It can be recorded under
    // the current lease even when a separate authorization check must cancel the body.
    function withLeasedTurn(messageKey, token, requestId, work) {
      return withLease(messageKey, token, ({ seq }) => {
        const turn = findTurn.get(seq);
        if (!turn) return { status: 'no_turn' };
        if (turn.request_id !== requestId) return { status: 'turn_conflict' };
        return work(turn);
      });
    }

    function updateTurn(messageKey, token, requestId, evidence) {
      return withLeasedTurn(messageKey, token, requestId, (turn) => {
        const { state, turnId } = evidence ?? {};
        if (state === 'retry') {
          if (turn.state !== 'submitting' || turn.turn_id !== null || turnId != null) {
            return { status: 'turn_conflict' };
          }
          removeTextProjection.run(turn.seq);
          removeTurn.run(turn.seq);
          return { status: 'retry_ready' };
        }
        if (state !== 'accepted' && state !== 'uncertain' && state !== 'retiring') return { status: 'invalid_turn' };
        return recordTurnEvidence(turn, { state, turnId });
      });
    }

    function finishTurn(messageKey, token, requestId, evidence) {
      const { state, turnId } = evidence ?? {};
      if (state !== 'completed' && state !== 'retired') return { status: 'invalid_turn' };
      return withLeasedTurn(messageKey, token, requestId, (turn) => {
        const result = recordTurnEvidence(turn, { state, turnId });
        // Only a normal leased completion retains the source projection.
        if (result.status === state) completeTask(turn.seq, state === 'completed');
        return result;
      });
    }

    function orphanedTurns(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid inbox limit');
      return listOrphanedTurns.all(scope, limit).map(turnMetadata);
    }

    function readOrphanedTurn(requestId) {
      if (!validTurnIdentifier(requestId)) return { status: 'invalid_turn' };
      const turn = findOrphanedTurn.get(scope, requestId);
      return turn ? { status: 'turn', turn: turnMetadata(turn) } : { status: 'no_turn' };
    }

    function withOrphanedTurn(requestId, work) {
      if (!validTurnIdentifier(requestId)) return { status: 'invalid_turn' };
      return write(() => {
        const turn = findOrphanedTurn.get(scope, requestId);
        return turn ? work(turn) : { status: 'no_turn' };
      });
    }

    function updateOrphanedTurn(requestId, evidence) {
      const { state, turnId } = evidence ?? {};
      if (state !== 'accepted' || !validTurnIdentifier(turnId)) return { status: 'invalid_turn' };
      return withOrphanedTurn(requestId, (turn) => recordTurnEvidence(turn, { state, turnId }));
    }

    function beginOrphanedRetirement(requestId) {
      return withOrphanedTurn(requestId, (turn) => {
        const result = recordTurnEvidence(turn, { state: 'retiring' });
        return result.status === 'updated' ? { status: 'turn', turn: result.turn } : result;
      });
    }

    function finishOrphanedTurn(requestId, evidence) {
      const { state, turnId } = evidence ?? {};
      if (state !== 'completed' && state !== 'retired') return { status: 'invalid_turn' };
      return withOrphanedTurn(requestId, (turn) => {
        const result = recordTurnEvidence(turn, { state, turnId });
        if (result.status === state) removeTextProjection.run(turn.seq);
        return result;
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
        outbox?.clearConfirmation(account, messageKey);
        const row = findPending.get(scope, messageKey);
        if (row) completeTask(row.seq);
        forgetTextProjection.run(scope, taskIdFor(messageKey));
        const observation = findObservation.get(conversationKey, scope, messageKey);
        if (observation) removeObservation.run(conversationKey, observation.seq);
        return { status: 'forgotten' };
      }));
    }

    function toolTarget(conversationKey, policy) {
      try {
        if (!conversationKey.startsWith('c1_') || policy?.enabled !== true) return null;
        const conversation = decodeIdentityKey(conversationKey);
        if (scopeOf(conversation) !== scope) return null;
        // The host proves the active private actor through readTextTurn on entry
        // and before returning results. Group eligibility can be checked here.
        if (conversation.chatType === 'group' && !resolveTextTarget(policy, conversation)) return null;
        return conversation;
      } catch { return null; }
    }

    function toolReadCursor(conversationKey) {
      if (!toolTarget(conversationKey, readPolicy())) return null;
      return toolState.get(conversationKey)?.read_through_seq ?? 0;
    }

    function readToolInbox(conversationKey, afterSeq = 0, limit = 20) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
      return write(() => {
        const policy = readPolicy();
        const conversation = toolTarget(conversationKey, policy);
        if (!conversation) return null;
        const readThroughSeq = toolState.get(conversationKey)?.read_through_seq ?? 0;
        const cursor = Math.max(afterSeq, readThroughSeq);
        const planned = toolPending.all(scope, cursor)
          .filter((row) => readTask(row).event.conversationKey === conversationKey);
        const observed = archive && policy.groupPolicy === 'observe' && policy.observationVerified && !groupWake.get(conversationKey)
          ? toolObservations.all(conversationKey, cursor) : [];
        const messages = [];
        for (const row of [...planned, ...observed].sort((a, b) => a.seq - b.seq)) {
          let text, occurredAt;
          if (row.event !== undefined) {
            const result = checkTask(row.message_key, policy, row);
            if (result.status !== 'ready') continue;
            const { event } = result.task;
            ({ text, occurredAt } = event);
            if (archive && row.start_offset !== null) {
              const saved = archiveWrite(() => row.projected ? archive.recordAt(event, row.projected - 1)
                : archive.findRecord(event, row.start_offset));
              if (saved?.status === 'retryableFailure') return saved;
              if (saved?.deleted) continue;
              if (saved) text = saved.text;
            }
          } else {
            occurredAt = row.occurred_at;
            const saved = archiveWrite(() => archive.recordAt({ conversationKey, messageKey: row.message_key, occurredAt }, row.projected_offset));
            if (saved.status === 'retryableFailure') return saved;
            if (saved.deleted || saved.dir !== 'in') continue;
            const actor = decodeIdentityKey(saved.personKey);
            if (!resolveTextTarget(policy, conversation, { source: { conversation, actor } })) continue;
            text = saved.text;
          }
          messages.push({ seq: row.seq, text, occurredAt });
          if (messages.length > limit) break;
        }
        const hasMore = messages.length > limit;
        if (hasMore) messages.pop();
        // The tool caller derives the visible cursor from rows it actually emits.
        return { messages, readThroughSeq, hasMore };
      });
    }

    function markToolRead(conversationKey, throughSeq, groupPolicy) {
      if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 ||
          (groupPolicy !== undefined && !['directed', 'observe'].includes(groupPolicy))) return { status: 'invalid' };
      return write(() => {
        const policy = readPolicy();
        const conversation = toolTarget(conversationKey, policy);
        if (!conversation || (groupPolicy !== undefined && conversation.chatType !== 'group') ||
            (groupPolicy === 'observe' && (policy.groupPolicy !== 'observe' || policy.observationVerified !== true))) {
          return { status: 'denied' };
        }
        // The host bounds throughSeq to a cursor it exposed for the active turn.
        const groupSetting = groupPolicy ?? null;
        const { read_through_seq: readThroughSeq } = saveToolState.get(conversationKey, throughSeq, groupSetting, groupSetting);
        pruneObservations.run(conversationKey, readThroughSeq);
        return { status: 'ok', readThroughSeq, ...(groupPolicy === undefined ? {} : { groupPolicy }) };
      });
    }

    function saveToolFeedback(conversationKey, { requestId, callId, message } = {}) {
      if (!validTurnIdentifier(requestId) || !validTurnIdentifier(callId) || typeof message !== 'string' ||
          message.length > MAX_TOOL_FEEDBACK_LENGTH || !message.trim() || !message.isWellFormed() || message.includes('\0')) {
        return { status: 'invalid' };
      }
      return write(() => {
        if (!toolTarget(conversationKey, readPolicy())) return { status: 'denied' };
        const callKey = createHash('sha256').update(JSON.stringify([conversationKey, requestId, callId])).digest('hex');
        const { changes } = saveFeedbackReceipt.run(callKey);
        if (!changes) return { status: 'ok', duplicate: true };
        // Existing rows can predate receipts. Preserve their deduplication once encountered.
        if (findFeedback.get(conversationKey, requestId, callId)) return { status: 'ok', duplicate: true };
        saveFeedback.run(conversationKey, requestId, callId, SENSITIVE_RE.test(message) ? '***' : message, now());
        pruneFeedback.run(conversationKey, conversationKey, MAX_TOOL_FEEDBACK);
        return { status: 'ok' };
      });
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
      readTurn,
      readTextTurn,
      beginTurn,
      updateTurn,
      finishTurn,
      orphanedTurns,
      readOrphanedTurn,
      updateOrphanedTurn,
      beginOrphanedRetirement,
      finishOrphanedTurn,
      forgetRecord,
      readToolInbox,
      toolReadCursor,
      markToolRead,
      saveToolFeedback,
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
        if (findTurn.get(row.seq)) return { status: 'unresolved_turn' };
        if (!lease.projected) return { status: 'not_projected' };
        if (row.decision === 'observe') {
          const { event: { conversationKey, occurredAt } } = readTask(row);
          if (row.seq > (toolState.get(conversationKey)?.read_through_seq ?? 0)) {
            saveObservation.run(conversationKey, row.seq, occurredAt, lease.projected - 1);
            const oldest = oldestObservation.get(conversationKey, MAX_TOOL_OBSERVATIONS);
            if (oldest) pruneObservations.run(conversationKey, oldest.seq);
          }
        }
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

  function recoveryAccounts() {
    return listRecoveryScopes.all().map(({ scope }) => {
      const [platform, accountId, tenantId] = JSON.parse(scope);
      return readAccountRef({ platform, accountId, tenantId });
    });
  }

  function projectNextConfirmation(account) {
    if (!outbox) return { status: 'idle' };
    return write(() => archiveWrite(() => {
      const confirmation = outbox.nextConfirmation(account);
      if (!confirmation) return { status: 'idle' };
      const conversation = decodeIdentityKey(confirmation.conversationKey);
      if (!sameAccount(conversation, readAccountRef(account))) throw new TypeError('Invalid confirmation account');
      const offset = confirmation.startOffset ?? archive.position(confirmation);
      // Lock order is inbox then outbox. The separate durable offset survives
      // either transaction failing after the watermark was published.
      if (confirmation.startOffset === null && !outbox.reserveConfirmation(account, confirmation.sendId, offset)) {
        return { status: 'idle' };
      }
      const projected = archive.project(confirmation, offset);
      outbox.clearConfirmation(account, confirmation.messageKey);
      return { status: projected.deleted ? 'forgotten' : 'projected', recordId: projected.recordId };
    }));
  }

  return { bind, privateBindings, recoveryAccounts, projectNextConfirmation, close: () => db.close() };
}
