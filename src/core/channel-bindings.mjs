import { createHash, randomUUID } from 'node:crypto';
import { encodeConversationKey, encodePersonKey, readConversationRef, readPersonRef, sameAccount } from './identity.mjs';

export const PRIVATE_BINDING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS channel_private_bindings (
    conversation_key TEXT PRIMARY KEY,
    person_key TEXT NOT NULL,
    principal_id TEXT,
    dialogue_id TEXT,
    binding_revision TEXT NOT NULL,
    CHECK ((principal_id IS NULL) = (dialogue_id IS NULL))
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX IF NOT EXISTS channel_bound_person
    ON channel_private_bindings (person_key) WHERE principal_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS channel_binding_members
    ON channel_private_bindings (principal_id) WHERE principal_id IS NOT NULL;
`;

function endpointKeys({ actor: inputActor, conversation: inputConversation }) {
  const actor = readPersonRef(inputActor);
  const conversation = readConversationRef(inputConversation);
  if (conversation.chatType !== 'private' || conversation.threadId !== null || !sameAccount(actor, conversation) ||
    (actor.platform !== 'feishu' && (actor.userId !== conversation.chatId || actor.userId === actor.accountId))) {
    throw new TypeError('Invalid private endpoint');
  }
  return { personKey: encodePersonKey(actor), conversationKey: encodeConversationKey(conversation) };
}

const digest = (key) => createHash('sha256').update(key).digest('hex');

export function isolatedMapping({ personKey, conversationKey, conversation }) {
  const personScope = digest(JSON.stringify([conversationKey, personKey]));
  const dialogueScope = conversation?.chatType === 'group' ? digest(conversationKey) : personScope;
  return { principalId: `principal_local_${personScope}`, dialogueId: `dialogue_local_${dialogueScope}`, bindingRevision: null };
}

// Both the administrator-facing caller and ingress must use verified endpoint
// pairs. Feishu open_id and chat_id are distinct identifiers and can only be
// paired by a trusted platform source. Binding never confers send permissions.
export function createPrivateBindings(db, transact) {
  const find = db.prepare('SELECT * FROM channel_private_bindings WHERE conversation_key = ?');
  const findBoundPerson = db.prepare(`
    SELECT conversation_key FROM channel_private_bindings WHERE person_key = ? AND principal_id IS NOT NULL
  `);
  const save = db.prepare(`
    INSERT INTO channel_private_bindings (conversation_key, person_key, principal_id, dialogue_id, binding_revision)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (conversation_key) DO UPDATE SET
      principal_id = excluded.principal_id, dialogue_id = excluded.dialogue_id, binding_revision = excluded.binding_revision
  `);
  const reviseMembers = db.prepare('UPDATE channel_private_bindings SET binding_revision = ? WHERE principal_id = ?');

  function resolveKeys(keys) {
    const row = find.get(keys.conversationKey);
    if (row?.person_key !== keys.personKey) return isolatedMapping(keys);
    const mapping = row.principal_id === null ? isolatedMapping(keys) : {
      principalId: row.principal_id, dialogueId: row.dialogue_id,
    };
    return { ...mapping, bindingRevision: row.binding_revision };
  }

  function link(endpoints) {
    if (!Array.isArray(endpoints) || endpoints.length < 2) throw new TypeError('A binding requires at least two endpoints');
    const keys = Array.from(endpoints, (endpoint) => ({ ...endpointKeys(endpoint), revision: endpoint.bindingRevision }));
    if (new Set(keys.map(({ personKey }) => personKey)).size !== keys.length ||
      new Set(keys.map(({ conversationKey }) => conversationKey)).size !== keys.length) {
      return { status: 'binding_conflict' };
    }
    return transact(() => {
      let group;
      let added = false;
      for (const { personKey, conversationKey, revision } of keys) {
        const row = find.get(conversationKey);
        const existing = findBoundPerson.get(personKey);
        if ((row && row.person_key !== personKey) || (existing && existing.conversation_key !== conversationKey)) {
          return { status: 'binding_conflict' };
        }
        if ((row?.binding_revision ?? null) !== revision) return { status: 'stale_binding' };
        if (!existing) {
          added = true;
          continue;
        }
        if (group && group.principal_id !== row.principal_id) return { status: 'binding_conflict' };
        group = row;
      }
      if (!added) return { status: 'linked' };
      const bindingRevision = randomUUID();
      const principalId = group?.principal_id ?? `principal_shared_${randomUUID()}`;
      const dialogueId = group?.dialogue_id ?? `dialogue_shared_${randomUUID()}`;
      if (group) reviseMembers.run(bindingRevision, principalId);
      for (const { conversationKey, personKey } of keys) {
        save.run(conversationKey, personKey, principalId, dialogueId, bindingRevision);
      }
      return { status: 'linked' };
    });
  }

  function unlink(endpoint) {
    const { personKey, conversationKey } = endpointKeys(endpoint);
    return transact(() => {
      const row = find.get(conversationKey);
      if ((row?.binding_revision ?? null) !== endpoint.bindingRevision || (row && row.person_key !== personKey)) {
        return { status: 'stale_binding' };
      }
      if (!row?.principal_id) return { status: 'unlinked' };
      const revision = randomUUID();
      reviseMembers.run(revision, row.principal_id);
      // The detached endpoint keeps a revision so pre-binding work stays stale.
      save.run(conversationKey, personKey, null, null, revision);
      return { status: 'unlinked' };
    });
  }

  return {
    resolve: (endpoint) => resolveKeys(endpointKeys(endpoint)),
    link,
    unlink,
  };
}
