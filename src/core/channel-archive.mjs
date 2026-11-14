import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeIdentityKey, encodeConversationKey, encodeMessageKey, sameAccount } from './identity.mjs';

const CHANNEL_ARCHIVE_MONTH = /^(?:\d{4}|\+\d{6})-\d{2}\.jsonl$/;
const RECORD_ID = /^record_[a-f0-9]{64}$/;
const SEND_ID = /^send_[a-f0-9]{64}$/;
const MAX_ROW_BYTES = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = (key) => createHash('sha256').update(key).digest('hex');
const recordIdFor = (key) => `record_${digest(key)}`;
const monthOf = (iso) => `${iso.slice(0, iso.indexOf('T') - 3)}.jsonl`;

function invalidArchive() {
  return Object.assign(new Error('Invalid channel archive'), { code: 'ERR_CHANNEL_ARCHIVE' });
}

function stat(file, directory = false) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (info && (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw invalidArchive();
  return info;
}

function parse(data) {
  try { return JSON.parse(utf8.decode(data)); }
  catch { throw invalidArchive(); }
}

function syncDirectory(dir) {
  // Node cannot open a directory for fsync on Windows. Files are flushed on both platforms.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function replaceFile(file, data) {
  // SQLite serializes writers. A stale temporary file is never a reader input.
  const tmp = `${file}.tmp`;
  if (stat(tmp)) fs.unlinkSync(tmp);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (stat(tmp)) fs.unlinkSync(tmp);
  }
}

function readBytes(fd, offset, size) {
  const data = Buffer.alloc(size);
  let received = 0;
  while (received < size) {
    const count = fs.readSync(fd, data, received, size - received, offset + received);
    if (!count) throw invalidArchive();
    received += count;
  }
  return data;
}

function readWatermark(file) {
  const marker = `${file}.watermark.json`;
  if (!stat(marker)) return 0;
  const data = parse(fs.readFileSync(marker));
  if (!Number.isSafeInteger(data?.bytes) || data.bytes <= 0) throw invalidArchive();
  return data.bytes;
}

function checkBoundary(fd, bytes) {
  if (fs.fstatSync(fd).size < bytes || (bytes && readBytes(fd, bytes - 1, 1)[0] !== 0x0a)) throw invalidArchive();
}

export function channelArchiveDirectory(key) {
  if (typeof key !== 'string' || !key.startsWith('c1_')) throw invalidArchive();
  const conversation = decodeIdentityKey(key);
  if (conversation.platform === 'qq') throw invalidArchive();
  return `c1_${digest(key)}`;
}

function readRecord(raw, key, month) {
  const row = parse(raw);
  try {
    if (row?.conversationKey !== key || row.recordId !== recordIdFor(row.messageKey) || !row.messageKey.startsWith('m1_')) {
      throw invalidArchive();
    }
    const message = decodeIdentityKey(row.messageKey);
    if (encodeConversationKey(message.conversation) !== key || message.platformChatId !== message.conversation.chatId) {
      throw invalidArchive();
    }
    if (row.deleted === true) {
      const hasSendId = Object.hasOwn(row, 'sendId');
      if (Object.keys(row).length !== (hasSendId ? 5 : 4) || (hasSendId && !validSendId(row.sendId))) {
        throw invalidArchive();
      }
      return row;
    }
    if (row.msgId !== message.messageId ||
        typeof row.text !== 'string' || new Date(row.t).toISOString() !== row.t || monthOf(row.t) !== month) {
      throw invalidArchive();
    }
    if (row.dir === 'out') {
      if (row.personKey !== null || row.userId !== message.conversation.accountId || !validSendId(row.sendId)) {
        throw invalidArchive();
      }
    } else {
      const person = decodeIdentityKey(row.personKey);
      if (row.dir !== 'in' || !row.personKey.startsWith('p1_') || !sameAccount(person, message.conversation) ||
          row.userId !== person.userId || Object.hasOwn(row, 'sendId')) throw invalidArchive();
    }
    if (row.replyToMessageKey !== null) {
      const reply = decodeIdentityKey(row.replyToMessageKey);
      if (!row.replyToMessageKey.startsWith('m1_') || encodeConversationKey(reply.conversation) !== key ||
          reply.platformChatId !== message.platformChatId) throw invalidArchive();
    }
    return row;
  } catch { throw invalidArchive(); }
}

function validSendId(value) {
  return typeof value === 'string' && SEND_ID.test(value);
}

function* records(data, key, month) {
  let start = 0;
  while (start < data.length) {
    const end = data.indexOf(0x0a, start);
    if (end < 0 || end - start >= MAX_ROW_BYTES) throw invalidArchive();
    const raw = data.subarray(start, end);
    yield { start, end, raw, row: readRecord(raw, key, month) };
    start = end + 1;
  }
}

function findPublishedRecord(fd, startOffset, bytes, key, month, event) {
  checkBoundary(fd, bytes);
  if (startOffset > bytes || (startOffset && startOffset !== bytes && readBytes(fd, startOffset - 1, 1)[0] !== 0x0a)) {
    throw invalidArchive();
  }
  const recordId = recordIdFor(event.messageKey);
  for (const { start, row } of records(readBytes(fd, startOffset, bytes - startOffset), key, month)) {
    if (row.recordId === recordId || (event.sendId && row.sendId === event.sendId)) {
      if (row.recordId !== recordId || row.sendId !== event.sendId) throw invalidArchive();
      return { row, offset: startOffset + start };
    }
  }
  return null;
}

// All mutations are called by the inbox under its SQLite write transaction.
// Readers use the atomically published byte watermark, including after a restart.
export function createChannelArchive(root, redact) {
  function directory(key, create = false) {
    const dir = path.join(root, channelArchiveDirectory(key));
    if (!stat(root, true)) {
      if (!create) return null;
      fs.mkdirSync(root, { mode: 0o700 });
      syncDirectory(path.dirname(root));
    }
    if (!stat(dir, true)) {
      if (!create) return null;
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    const file = path.join(dir, 'conversation.json');
    const conversation = decodeIdentityKey(key);
    if (!stat(file)) {
      if (fs.readdirSync(dir).some((name) => name !== 'conversation.json.tmp')) throw invalidArchive();
      if (!create) return null;
      syncDirectory(root);
      replaceFile(file, JSON.stringify({ version: 1, conversationKey: key, conversation }));
    }
    const meta = parse(fs.readFileSync(file));
    try {
      if (meta?.version !== 1 || meta.conversationKey !== key || encodeConversationKey(meta.conversation) !== key) {
        throw invalidArchive();
      }
    } catch { throw invalidArchive(); }
    return dir;
  }

  function files(key) {
    const dir = directory(key);
    if (!dir) return [];
    const months = fs.readdirSync(dir).filter((name) => CHANNEL_ARCHIVE_MONTH.test(name))
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    return months.flatMap((name) => {
      const file = path.join(dir, name);
      stat(file);
      return readWatermark(file) ? [file] : [];
    });
  }

  function readLines(key, file) {
    const month = path.basename(file);
    const dir = directory(key);
    if (!dir || !CHANNEL_ARCHIVE_MONTH.test(month) || path.join(dir, month) !== file) throw invalidArchive();
    const bytes = readWatermark(file);
    if (!bytes) return [];
    if (!stat(file)) throw invalidArchive();
    const fd = fs.openSync(file, 'r');
    try {
      checkBoundary(fd, bytes);
      return Array.from(records(readBytes(fd, 0, bytes), key, month), ({ raw }) => utf8.decode(raw));
    } finally { fs.closeSync(fd); }
  }

  function position(event) {
    const dir = directory(event.conversationKey);
    if (!dir) return 0;
    return readWatermark(path.join(dir, monthOf(new Date(event.occurredAt).toISOString())));
  }

  function project(event, startOffset) {
    const key = event.conversationKey;
    const t = new Date(event.occurredAt).toISOString();
    const month = monthOf(t);
    const file = path.join(directory(key, true), month);
    const bytes = readWatermark(file);
    const exists = stat(file);
    if (!exists && bytes) throw invalidArchive();
    const fd = fs.openSync(file, exists ? 'r+' : 'wx+', 0o600);
    try {
      const found = findPublishedRecord(fd, startOffset, bytes, key, month, event);
      if (found) {
        syncDirectory(path.dirname(file));
        return { recordId: found.row.recordId, offset: found.offset, deleted: found.row.deleted === true };
      }
      const recordId = recordIdFor(event.messageKey);
      const outbound = event.sendId !== undefined;
      const message = outbound ? decodeIdentityKey(event.messageKey) : event.message;
      const row = {
        recordId, conversationKey: key, personKey: outbound ? null : event.personKey, messageKey: event.messageKey,
        replyToMessageKey: event.replyTo ? encodeMessageKey(event.replyTo) : null,
        t, dir: outbound ? 'out' : 'in', userId: outbound ? message.conversation.accountId : event.actor.userId,
        name: '', text: redact(event.text).trim().slice(0, 4000), msgId: message.messageId,
        ...(outbound ? { sendId: event.sendId } : {}),
      };
      const payload = Buffer.from(`${JSON.stringify(row)}\n`);
      readRecord(payload.subarray(0, -1), key, month);
      const size = fs.fstatSync(fd).size;
      // Only the current authorized task may republish its tail. A torn or
      // unrelated tail is discarded so the owning task can replay independently.
      if (size !== bytes + payload.length || !readBytes(fd, bytes, payload.length).equals(payload)) {
        if (size !== bytes) fs.ftruncateSync(fd, bytes);
        let written = 0;
        while (written < payload.length) {
          const count = fs.writeSync(fd, payload, written, payload.length - written, bytes + written);
          if (!count) throw invalidArchive();
          written += count;
        }
      }
      fs.fsyncSync(fd);
      replaceFile(`${file}.watermark.json`, JSON.stringify({ bytes: bytes + payload.length }));
      return { recordId, offset: bytes, deleted: false };
    } finally { fs.closeSync(fd); }
  }

  // The inbox can lose a projection's lease while retaining the durable
  // intent. Consult only the published bytes after that intent's offset.
  function findRecord(event, startOffset) {
    const key = event.conversationKey;
    const month = monthOf(new Date(event.occurredAt).toISOString());
    const dir = directory(key);
    const file = dir ? path.join(dir, month) : null;
    const bytes = file ? readWatermark(file) : 0;
    if (!bytes && !startOffset) return null;
    if (!file || !stat(file)) throw invalidArchive();
    const fd = fs.openSync(file, 'r');
    try {
      return findPublishedRecord(fd, startOffset, bytes, key, month, event)?.row ?? null;
    } finally { fs.closeSync(fd); }
  }

  function discardTail(event) {
    const dir = directory(event.conversationKey);
    if (!dir) return;
    const file = path.join(dir, monthOf(new Date(event.occurredAt).toISOString()));
    const bytes = readWatermark(file);
    const info = stat(file);
    if (!info && !bytes) return;
    if (!info || info.size < bytes) throw invalidArchive();
    if (info.size === bytes) return;
    const fd = fs.openSync(file, 'r+');
    try {
      checkBoundary(fd, bytes);
      // The writer holds the SQLite transaction. Other tasks can replay any
      // unpublished rows in this file from their durable queue payloads.
      fs.ftruncateSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  function recordAt(event, offset) {
    const key = event.conversationKey;
    const month = monthOf(new Date(event.occurredAt).toISOString());
    const dir = directory(key);
    if (!dir) throw invalidArchive();
    const file = path.join(dir, month);
    const bytes = readWatermark(file);
    if (offset < 0 || offset >= bytes || !stat(file)) throw invalidArchive();
    const fd = fs.openSync(file, 'r');
    try {
      checkBoundary(fd, bytes);
      if (offset && readBytes(fd, offset - 1, 1)[0] !== 0x0a) throw invalidArchive();
      const chunk = readBytes(fd, offset, Math.min(bytes - offset, MAX_ROW_BYTES));
      const end = chunk.indexOf(0x0a);
      if (end < 0) throw invalidArchive();
      const row = readRecord(chunk.subarray(0, end), key, month);
      if (row.messageKey !== event.messageKey) throw invalidArchive();
      return row;
    } finally { fs.closeSync(fd); }
  }

  function forget(key, recordId) {
    if (typeof recordId !== 'string' || !RECORD_ID.test(recordId)) return null;
    for (const file of files(key)) {
      const bytes = readWatermark(file);
      const data = fs.readFileSync(file);
      if (data.length < bytes) throw invalidArchive();
      for (const { start, end, row } of records(data.subarray(0, bytes), key, path.basename(file))) {
        if (row.recordId !== recordId) continue;
        if (!row.deleted) {
          const marker = Buffer.from(JSON.stringify({
            deleted: true, recordId, conversationKey: key, messageKey: row.messageKey,
            ...(row.sendId === undefined ? {} : { sendId: row.sendId }),
          }));
          if (marker.length > end - start) throw invalidArchive();
          data.fill(0x20, start, end);
          marker.copy(data, start);
          replaceFile(file, data.subarray(0, bytes));
        } else syncDirectory(path.dirname(file));
        return row.messageKey;
      }
    }
    return null;
  }

  return { files, readLines, position, project, recordAt, findRecord, discardTail, forget };
}
