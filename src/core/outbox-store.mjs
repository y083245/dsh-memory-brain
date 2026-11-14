import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeIdentityKey, encodeConversationKey, encodeMessageKey, readAccountRef, readConversationRef, readMessageRef, readPersonRef, sameAccount,
} from './identity.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MAX_RETRY_MS = 24 * HOUR_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_SEGMENTS = 256;
const MAX_TEXT_BYTES = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACTIVE = "status IN ('pending', 'sending')";
const STATES = "('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')";
const CONFIRMED = "s.status = 'sent' AND s.platform_message_id IS NOT NULL";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox_operations (
    seq INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    source TEXT,
    reply_to TEXT,
    authorization_id TEXT,
    status TEXT NOT NULL CHECK (status IN ${STATES}),
    next_position INTEGER,
    UNIQUE (scope, operation_id)
  );
  CREATE INDEX IF NOT EXISTS outbox_active_order
    ON outbox_operations (scope, seq) WHERE ${ACTIVE};
  CREATE INDEX IF NOT EXISTS outbox_conversation_order
    ON outbox_operations (scope, conversation_key, seq) WHERE ${ACTIVE};
  CREATE TABLE IF NOT EXISTS outbox_segments (
    operation_seq INTEGER NOT NULL REFERENCES outbox_operations(seq),
    position INTEGER NOT NULL,
    send_id TEXT NOT NULL,
    text TEXT,
    status TEXT NOT NULL CHECK (status IN ${STATES}),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT 0,
    token TEXT,
    expires_at INTEGER,
    platform_message_id TEXT,
    PRIMARY KEY (operation_seq, position)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS outbox_confirmations (
    send_id TEXT PRIMARY KEY,
    operation_seq INTEGER NOT NULL REFERENCES outbox_operations(seq),
    scope TEXT NOT NULL,
    message_key TEXT NOT NULL UNIQUE,
    confirmed_at INTEGER NOT NULL,
    reply_to TEXT,
    text TEXT,
    start_offset INTEGER
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS outbox_unprojected
    ON outbox_confirmations (scope, operation_seq, send_id) WHERE text IS NOT NULL;
`;

export function isChannelOutboxId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export function isChannelOutboxText(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_TEXT_BYTES &&
    text.isWellFormed() && !text.includes('\0') && Buffer.byteLength(text) <= MAX_TEXT_BYTES;
}

export function validateChannelOutboxSegments(segments) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > MAX_SEGMENTS) {
    throw new TypeError('Invalid outbox segment count');
  }
  const count = segments.length;
  const texts = [];
  let bytes = 0;
  for (let i = 0; i < count; i += 1) {
    const text = segments[i];
    if (!Object.hasOwn(segments, i) || !isChannelOutboxText(text)) throw new TypeError('Invalid outbox segment');
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_TEXT_BYTES) throw new TypeError('Invalid outbox text size');
    texts.push(text);
  }
  return texts;
}

function scopeOf(ref) {
  const { platform, accountId, tenantId } = readAccountRef(ref);
  if (platform === 'qq') throw new TypeError('Invalid outbox platform');
  return JSON.stringify([platform, accountId, tenantId]);
}

function canonicalSource(input, conversation, conversationKey) {
  if (input == null) {
    if (conversation.chatType === 'private') throw new TypeError('Outbox source required');
    return null;
  }
  const actor = readPersonRef(input.actor);
  if (encodeConversationKey(input.conversation) !== conversationKey || !sameAccount(actor, conversation) ||
    (conversation.platform === 'telegram' && conversation.chatType === 'private' && actor.userId !== conversation.chatId)) {
    throw new TypeError('Invalid outbox source');
  }
  return { conversation, actor };
}

function canonicalReply(input, source, conversation, conversationKey) {
  if (input == null) return null;
  const reply = readMessageRef(input);
  if (!source || reply.platformChatId !== conversation.chatId ||
    encodeConversationKey(reply.conversation) !== conversationKey) {
    throw new TypeError('Invalid outbox reply');
  }
  return reply;
}

function hash(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function readChannelSendReceipt(conversation, result) {
  if ((result.platformChatId !== undefined && result.platformChatId !== conversation.chatId) ||
      (result.threadId !== undefined && result.threadId !== conversation.threadId)) {
    throw new TypeError('Invalid channel send receipt scope');
  }
  return readMessageRef({ conversation, platformChatId: conversation.chatId, messageId: result.platformMessageId });
}

// The caller supplies a trusted path inside its private state directory.
export function openChannelOutbox(file, { now = Date.now, capacity = 1000, leaseMs = 60_000 } = {}) {
  if (typeof now !== 'function') throw new TypeError('Invalid outbox clock');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid outbox capacity');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > HOUR_MS) {
    throw new RangeError('Invalid outbox lease duration');
  }
  try {
    // Opening and closing an existing SQLite file outside SQLite can release POSIX locks.
    closeSync(openSync(file, 'ax', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA secure_delete = ON;');
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }

  const getOperation = db.prepare(`
    SELECT o.conversation_key, o.status AS operation_status,
      s.send_id, s.status, s.attempts, s.platform_message_id
    FROM outbox_operations o JOIN outbox_segments s ON s.operation_seq = o.seq
    WHERE o.scope = ? AND o.operation_id = ? ORDER BY s.position
  `);
  const getHash = db.prepare('SELECT plan_hash FROM outbox_operations WHERE scope = ? AND operation_id = ?');
  const activeCount = db.prepare(`SELECT count(*) AS count FROM outbox_operations WHERE scope = ? AND ${ACTIVE}`);
  const terminalProjectionCount = db.prepare(`
    SELECT count(DISTINCT c.operation_seq) AS count
    FROM outbox_confirmations c JOIN outbox_operations o ON o.seq = c.operation_seq
    WHERE c.scope = ? AND c.text IS NOT NULL AND NOT (o.${ACTIVE})
  `);
  const activeScopes = db.prepare(`SELECT DISTINCT scope FROM outbox_operations WHERE ${ACTIVE}`);
  const confirmationScopes = db.prepare('SELECT DISTINCT scope FROM outbox_confirmations WHERE text IS NOT NULL');
  const deliveryStatus = db.prepare(`
    SELECT o.status, count(*) AS segmentCount, count(*) FILTER (WHERE ${CONFIRMED}) AS confirmedCount,
      max(c.confirmed_at) AS lastSentAt
    FROM outbox_operations o JOIN outbox_segments s ON s.operation_seq = o.seq
      LEFT JOIN outbox_confirmations c ON c.send_id = s.send_id
    WHERE o.scope = ? AND o.operation_id = ? GROUP BY o.seq
  `);
  const conversationStats = db.prepare(`
    SELECT count(*) AS confirmedCount, max(c.confirmed_at) AS lastSentAt
    FROM outbox_operations o JOIN outbox_segments s ON s.operation_seq = o.seq
      LEFT JOIN outbox_confirmations c ON c.send_id = s.send_id
    WHERE o.scope = ? AND o.conversation_key = ? AND ${CONFIRMED}
  `);
  const saveOperation = db.prepare(`
    INSERT INTO outbox_operations (scope, operation_id, conversation_key, plan_hash, source, reply_to,
      authorization_id, status, next_position)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)
  `);
  const saveSegment = db.prepare(`
    INSERT INTO outbox_segments (operation_seq, position, send_id, text, status) VALUES (?, ?, ?, ?, 'pending')
  `);
  const nextToClaim = db.prepare(`
    SELECT o.seq, o.operation_id, o.conversation_key, o.source, o.reply_to, o.authorization_id,
      s.position, s.send_id, s.text, s.attempts
    FROM outbox_operations o JOIN outbox_segments s ON s.operation_seq = o.seq AND s.position = o.next_position
    WHERE o.scope = ? AND o.${ACTIVE} AND o.status = 'pending' AND s.available_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM outbox_operations prior
        WHERE prior.scope = o.scope AND prior.conversation_key = o.conversation_key AND prior.seq < o.seq
          AND prior.${ACTIVE}
      )
    ORDER BY o.seq LIMIT 1
  `);
  const expiredClaims = db.prepare(`
    SELECT o.seq, s.position
    FROM outbox_operations o JOIN outbox_segments s ON s.operation_seq = o.seq AND s.position = o.next_position
    WHERE o.scope = ? AND o.${ACTIVE} AND o.status = 'sending' AND s.expires_at <= ?
  `);
  const findClaim = db.prepare(`
    SELECT o.seq, o.conversation_key, o.reply_to, s.position, s.expires_at, s.text
    FROM outbox_operations o JOIN outbox_segments s ON s.operation_seq = o.seq AND s.position = o.next_position
    WHERE o.scope = ? AND o.operation_id = ? AND o.status = 'sending' AND s.send_id = ? AND s.token = ?
  `);
  const markSending = db.prepare(`
    UPDATE outbox_segments SET status = 'sending', attempts = attempts + 1, token = ?, expires_at = ?
    WHERE operation_seq = ? AND position = ?
  `);
  const retrySegment = db.prepare(`
    UPDATE outbox_segments SET status = 'pending', token = NULL, expires_at = NULL, available_at = ?
    WHERE operation_seq = ? AND position = ?
  `);
  const finishSegment = db.prepare(`
    UPDATE outbox_segments SET status = ?, token = NULL, expires_at = NULL, platform_message_id = ?, text = NULL
    WHERE operation_seq = ? AND position = ?
  `);
  const nextSegmentExists = db.prepare('SELECT 1 FROM outbox_segments WHERE operation_seq = ? AND position = ?');
  const cancelPending = db.prepare(`
    UPDATE outbox_segments SET status = 'cancelled', text = NULL WHERE operation_seq = ? AND status = 'pending'
  `);
  const markActive = db.prepare('UPDATE outbox_operations SET status = ?, next_position = ? WHERE seq = ?');
  const markTerminal = db.prepare(`
    UPDATE outbox_operations SET status = ?, next_position = NULL, source = NULL, reply_to = NULL, authorization_id = NULL
    WHERE seq = ?
  `);
  const saveConfirmation = db.prepare(`
    INSERT INTO outbox_confirmations (send_id, operation_seq, scope, message_key, confirmed_at, reply_to, text)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message_key) DO NOTHING
  `);
  const hasConfirmation = db.prepare('SELECT 1 FROM outbox_confirmations WHERE scope = ? AND text IS NOT NULL LIMIT 1');
  const findConfirmation = db.prepare(`
    SELECT c.send_id, c.message_key, c.confirmed_at, c.reply_to, c.text, c.start_offset, o.conversation_key
    FROM outbox_confirmations c JOIN outbox_operations o ON o.seq = c.operation_seq
    JOIN outbox_segments s ON s.operation_seq = o.seq AND s.send_id = c.send_id
    WHERE c.scope = ? AND c.text IS NOT NULL ORDER BY o.seq, s.position LIMIT 1
  `);
  const reserveConfirmationOffset = db.prepare(`
    UPDATE outbox_confirmations SET start_offset = ? WHERE scope = ? AND send_id = ? AND start_offset IS NULL AND text IS NOT NULL
  `);
  const clearConfirmationPayload = db.prepare(`
    UPDATE outbox_confirmations SET text = NULL, reply_to = NULL, start_offset = NULL
    WHERE scope = ? AND message_key = ? AND text IS NOT NULL
  `);

  function transact(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLite may have rolled back automatically on a storage failure.
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function readTime() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) {
      throw new RangeError('Invalid outbox clock');
    }
    return timestamp;
  }

  function view(scope, operationId) {
    const segments = getOperation.all(scope, operationId);
    if (!segments.length) return null;
    const [operation] = segments;
    return {
      operationId,
      conversation: decodeIdentityKey(operation.conversation_key),
      status: operation.operation_status,
      segments: segments.map((segment) => ({
        sendId: segment.send_id,
        status: segment.status,
        attempts: segment.attempts,
        platformMessageId: segment.platform_message_id,
      })),
    };
  }

  function stopOperation({ seq, position }, status) {
    finishSegment.run(status, null, seq, position);
    cancelPending.run(seq);
    markTerminal.run(status, seq);
  }

  function readAccounts(rows) {
    return rows.map(({ scope }) => {
      const [platform, accountId, tenantId] = JSON.parse(scope);
      return readAccountRef({ platform, accountId, tenantId });
    });
  }

  return {
    recoveryAccounts() {
      return readAccounts(activeScopes.all());
    },
    hasActive(account) {
      return activeCount.get(scopeOf(account)).count > 0;
    },
    confirmationAccounts() {
      return readAccounts(confirmationScopes.all());
    },
    hasPendingConfirmation(account) {
      return !!hasConfirmation.get(scopeOf(account));
    },
    // The trusted inbox calls these under its archive write lock. Saving the
    // offset commits before touching the file, including before a crash.
    nextConfirmation(account) {
      const row = findConfirmation.get(scopeOf(account));
      if (!row) return null;
      return {
        sendId: row.send_id, conversationKey: row.conversation_key, messageKey: row.message_key,
        replyTo: JSON.parse(row.reply_to), occurredAt: row.confirmed_at, text: row.text, startOffset: row.start_offset,
      };
    },
    reserveConfirmation(account, sendId, offset) {
      return reserveConfirmationOffset.run(offset, scopeOf(account), sendId).changes === 1;
    },
    clearConfirmation(account, messageKey) {
      clearConfirmationPayload.run(scopeOf(account), messageKey);
    },
    enqueue({ operationId, conversation: input, source: sourceInput, replyTo: replyInput, authorizationId, segments }) {
      if (!isChannelOutboxId(operationId) || !isChannelOutboxId(authorizationId)) {
        throw new TypeError('Invalid outbox operation or authorization ID');
      }
      const conversation = readConversationRef(input);
      const scope = scopeOf(conversation);
      const conversationKey = encodeConversationKey(conversation);
      const source = canonicalSource(sourceInput, conversation, conversationKey);
      const replyTo = canonicalReply(replyInput, source, conversation, conversationKey);
      const texts = validateChannelOutboxSegments(segments);
      const planHash = hash([conversationKey, source, replyTo, authorizationId, texts]);

      return transact(() => {
        const existing = getHash.get(scope, operationId);
        if (existing) {
          if (existing.plan_hash !== planHash) return { status: 'conflict' };
          return { status: 'existing', operation: view(scope, operationId) };
        }
        // Confirmed bodies still occupy queue space until their archive write completes.
        if (activeCount.get(scope).count + terminalProjectionCount.get(scope).count >= capacity) return { status: 'full' };
        const { lastInsertRowid: seq } = saveOperation.run(scope, operationId, conversationKey, planHash,
          source && JSON.stringify(source), replyTo && JSON.stringify(replyTo), authorizationId);
        for (const [position, text] of texts.entries()) {
          saveSegment.run(seq, position, `send_${hash([scope, operationId, position])}`, text);
        }
        return { status: 'queued', operation: view(scope, operationId) };
      });
    },
    get(account, operationId) {
      if (!isChannelOutboxId(operationId)) throw new TypeError('Invalid outbox operation ID');
      return view(scopeOf(account), operationId);
    },
    getDeliveryStatus(account, operationId) {
      if (!isChannelOutboxId(operationId)) throw new TypeError('Invalid outbox operation ID');
      const result = deliveryStatus.get(scopeOf(account), operationId);
      if (!result) return null;
      const { status, confirmedCount, lastSentAt, segmentCount } = result;
      return { status, confirmedCount, lastSentAt, complete: status === 'sent' && confirmedCount === segmentCount };
    },
    getConversationDeliveryStats(conversation) {
      const { confirmedCount, lastSentAt } = conversationStats.get(scopeOf(conversation), encodeConversationKey(conversation));
      return { confirmedCount, lastSentAt };
    },
    claim(account) {
      const scope = scopeOf(account);
      return transact(() => {
        const timestamp = readTime();
        // An expired sender may have reached the platform. Record the ambiguity durably.
        for (const expired of expiredClaims.all(scope, timestamp)) stopOperation(expired, 'unknown');
        const next = nextToClaim.get(scope, timestamp);
        if (!next) return null;
        const token = randomUUID();
        const expiresAt = timestamp + leaseMs;
        markSending.run(token, expiresAt, next.seq, next.position);
        markActive.run('sending', next.position, next.seq);
        return {
          operationId: next.operation_id,
          conversation: decodeIdentityKey(next.conversation_key),
          source: JSON.parse(next.source),
          replyTo: JSON.parse(next.reply_to),
          authorizationId: next.authorization_id,
          sendId: next.send_id,
          text: next.text,
          attempt: next.attempts + 1,
          token,
          expiresAt,
        };
      });
    },
    claimRemainingMs(claim) {
      // The sender checks its own claim immediately before invoking the platform.
      const expiresAt = claim?.expiresAt;
      return Number.isSafeInteger(expiresAt) ? Math.max(0, expiresAt - readTime()) : 0;
    },
    settle(account, claim, result) {
      const scope = scopeOf(account);
      const { operationId, sendId, token } = claim ?? {};
      if (![operationId, sendId, token].every(isChannelOutboxId)) return null;
      return transact(() => {
        const current = findClaim.get(scope, operationId, sendId, token);
        if (!current) return null;
        const timestamp = readTime();
        if (current.expires_at <= timestamp) {
          stopOperation(current, 'unknown');
          return null;
        }

        const { seq, position } = current;
        const status = result?.status;
        switch (status) {
          case 'sent': {
            const conversation = decodeIdentityKey(current.conversation_key);
            const message = readChannelSendReceipt(conversation, result);
            const saved = saveConfirmation.run(sendId, seq, scope, encodeMessageKey(message), timestamp, current.reply_to, current.text);
            if (saved.changes !== 1) {
              // A receipt already attributed to a different send is ambiguous.
              stopOperation(current, 'unknown');
              break;
            }
            finishSegment.run('sent', message.messageId, seq, position);
            if (nextSegmentExists.get(seq, position + 1)) markActive.run('pending', position + 1, seq);
            else markTerminal.run('sent', seq);
            break;
          }
          case 'retry': {
            const { delayMs } = result;
            if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_RETRY_MS) {
              throw new TypeError('Invalid outbox retry delay');
            }
            retrySegment.run(timestamp + delayMs, seq, position);
            markActive.run('pending', position, seq);
            break;
          }
          case 'failed':
          case 'unknown':
          case 'cancelled':
            stopOperation(current, status);
            break;
          default:
            throw new TypeError('Invalid outbox result');
        }
        return view(scope, operationId);
      });
    },
    close() {
      db.close();
    },
  };
}
