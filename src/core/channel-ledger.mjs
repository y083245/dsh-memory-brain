import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeConversationKey, encodePersonKey, readConversationRef, readPersonRef, sameAccount } from './identity.mjs';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS channel_people (
    conversation_key TEXT NOT NULL,
    person_key TEXT NOT NULL,
    ledger TEXT NOT NULL,
    PRIMARY KEY (conversation_key, person_key)
  ) WITHOUT ROWID;
`;

function stat(file) {
  try { return lstatSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function checkedDirectory(dir) {
  const state = stat(dir);
  if (state && !state.isDirectory()) throw new Error('Unsafe channel ledger directory');
  return state;
}

function checkedFile(file) {
  const state = stat(file);
  if (state && (!state.isFile() || state.nlink !== 1)) throw new Error('Unsafe channel ledger file');
  return state;
}

// Each transaction owns one scoped ledger. All writes load the current row
// under a SQLite lock so independently opened services cannot lose updates.
export function withChannelLedger(stateDir, { conversationKey, source }, write, run) {
  const conversation = readConversationRef(source.conversation);
  const actor = readPersonRef(source.actor);
  if (conversation.platform === 'qq' || !sameAccount(actor, conversation) ||
      encodeConversationKey(conversation) !== conversationKey ||
      (conversation.platform === 'telegram' && conversation.chatType === 'private' && actor.userId !== conversation.chatId)) {
    throw new TypeError('Invalid channel ledger scope');
  }
  const personKey = encodePersonKey(actor);
  const people = Object.create(null);
  const dir = join(stateDir, 'channel-people');
  const file = join(dir, 'people.sqlite');
  if (!checkedDirectory(stateDir)) throw new Error('Missing channel ledger parent directory');
  if (!checkedDirectory(dir) && write) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = checkedDirectory(dir);
  if (directory && process.platform !== 'win32' && (directory.mode & 0o077) !== 0) {
    throw new Error('Channel ledger directory must be private');
  }
  for (const suffix of ['-journal', '-wal', '-shm']) checkedFile(file + suffix);
  const current = checkedFile(file);
  if (!current && !write) return run({ personKey, people });
  if (!current) {
    try { closeSync(openSync(file, 'wx', 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkedFile(file);
  }

  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 500; PRAGMA synchronous = EXTRA; PRAGMA secure_delete = ON;');
    if (write) db.exec('BEGIN IMMEDIATE');
    // A first writer may have created the file before committing its schema.
    // Until then reads should treat it as an empty ledger.
    if (write) db.exec(SCHEMA);
    const hasTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'channel_people'").get();
    const stored = hasTable && db.prepare('SELECT ledger FROM channel_people WHERE conversation_key = ? AND person_key = ?')
      .get(conversationKey, personKey);
    if (stored) {
      const person = JSON.parse(stored.ledger);
      if (!Array.isArray(person?.items) || person.items.some((item) =>
        item?.scope !== 'private' || item.sourceKey !== conversationKey)) throw new Error('Invalid channel ledger row');
      people[personKey] = person;
    }
    const save = () => {
      const person = people[personKey];
      if (!person?.items.length) {
        db.prepare('DELETE FROM channel_people WHERE conversation_key = ? AND person_key = ?').run(conversationKey, personKey);
      } else {
        // A future reminder must resolve the original channel and topic even if
        // the actor's private binding or active DSH session changes later.
        for (const item of person.items) {
          if (item.cat === 'pending') item.targetConversationKey = conversationKey;
          else delete item.targetConversationKey;
        }
        db.prepare(`INSERT INTO channel_people (conversation_key, person_key, ledger) VALUES (?, ?, ?)
          ON CONFLICT (conversation_key, person_key) DO UPDATE SET ledger = excluded.ledger`)
          .run(conversationKey, personKey, JSON.stringify(person));
      }
    };
    const result = run({ personKey, people, save });
    if (write) db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}
