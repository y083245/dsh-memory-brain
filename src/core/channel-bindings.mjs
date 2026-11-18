import { createHash, randomUUID } from 'node:crypto';
import {
  decodeIdentityKey, encodeConversationKey, encodePersonKey, readConversationRef, readPersonRef, sameAccount,
} from './identity.mjs';

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
  CREATE TABLE IF NOT EXISTS channel_legacy_qq_profile_sharing (
    principal_id TEXT PRIMARY KEY,
    conversation_key TEXT NOT NULL UNIQUE
  ) WITHOUT ROWID;
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

const PRINCIPAL_PREFIX = 'principal_shared_';
const DIALOGUE_PREFIX = 'dialogue_shared_';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

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
  const findMembers = db.prepare(`
    SELECT member.*, sharing.conversation_key AS shared_qq_profile_key
    FROM channel_private_bindings AS source
    JOIN channel_private_bindings AS member ON member.principal_id = source.principal_id
    LEFT JOIN channel_legacy_qq_profile_sharing AS sharing
      ON sharing.principal_id = member.principal_id AND sharing.conversation_key = member.conversation_key
    WHERE source.conversation_key = ? AND source.person_key = ?
    ORDER BY member.conversation_key
  `);
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
  const findSharing = db.prepare('SELECT conversation_key FROM channel_legacy_qq_profile_sharing WHERE principal_id = ?');
  const grantSharing = db.prepare('INSERT INTO channel_legacy_qq_profile_sharing (principal_id, conversation_key) VALUES (?, ?)');
  const revokeSharing = db.prepare('DELETE FROM channel_legacy_qq_profile_sharing WHERE principal_id = ?');
  const revokeDetachedSharing = db.prepare(`
    DELETE FROM channel_legacy_qq_profile_sharing WHERE principal_id = ? AND (conversation_key = ? OR (
      SELECT COUNT(*) FROM channel_private_bindings WHERE principal_id = ?
    ) < 2)
  `);

  function resolveKeys(keys) {
    const row = find.get(keys.conversationKey);
    if (row?.person_key !== keys.personKey) return isolatedMapping(keys);
    const mapping = row.principal_id === null ? isolatedMapping(keys) : {
      principalId: row.principal_id, dialogueId: row.dialogue_id,
    };
    return { ...mapping, bindingRevision: row.binding_revision };
  }

  function members(endpoint, expectedMapping = null) {
    let keys;
    try { keys = endpointKeys(endpoint); }
    catch { return null; }
    // Read the source and its peers in one snapshot so a concurrent unlink
    // cannot pair an old authorization with a new set of members.
    const rows = findMembers.all(keys.conversationKey, keys.personKey);
    if (rows.length < 2) return null;
    const { principal_id: principalId, dialogue_id: dialogueId, binding_revision: bindingRevision } = rows[0];
    if (typeof principalId !== 'string' || typeof dialogueId !== 'string' || typeof bindingRevision !== 'string' ||
        !principalId.startsWith(PRINCIPAL_PREFIX) || !UUID.test(principalId.slice(PRINCIPAL_PREFIX.length)) ||
        !dialogueId.startsWith(DIALOGUE_PREFIX) || !UUID.test(dialogueId.slice(DIALOGUE_PREFIX.length)) ||
        !UUID.test(bindingRevision)) return null;
    if (expectedMapping !== null && (expectedMapping.principalId !== principalId ||
        expectedMapping.dialogueId !== dialogueId || expectedMapping.bindingRevision !== bindingRevision)) return null;
    const endpoints = [];
    const sharedQqKeys = [];
    for (const row of rows) {
      if (row.dialogue_id !== dialogueId || row.binding_revision !== bindingRevision) return null;
      try {
        const actor = decodeIdentityKey(row.person_key);
        const conversation = decodeIdentityKey(row.conversation_key);
        const memberKeys = endpointKeys({ actor, conversation });
        if (memberKeys.personKey !== row.person_key || memberKeys.conversationKey !== row.conversation_key) return null;
        endpoints.push({ actor, conversation });
        if (actor.platform === 'qq' && row.shared_qq_profile_key === row.conversation_key) sharedQqKeys.push(row.conversation_key);
      } catch { return null; }
    }
    const sharedQqProfileKey = sharedQqKeys.length === 1 ? sharedQqKeys[0] : null;
    return { principalId, dialogueId, bindingRevision, members: endpoints, sharedQqProfileKey };
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
      const principalId = group?.principal_id ?? PRINCIPAL_PREFIX + randomUUID();
      const dialogueId = group?.dialogue_id ?? DIALOGUE_PREFIX + randomUUID();
      if (group) reviseMembers.run(bindingRevision, principalId);
      for (const { conversationKey, personKey } of keys) {
        save.run(conversationKey, personKey, principalId, dialogueId, bindingRevision);
      }
      return { status: 'linked' };
    });
  }

  // Binding a person does not grant access to legacy QQ data. The trusted
  // caller confirms the QQ profile separately against the current revision.
  function setLegacyQqProfileSharing(endpoint, enabled) {
    const { personKey, conversationKey } = endpointKeys(endpoint);
    if (endpoint.actor.platform !== 'qq' || typeof enabled !== 'boolean') throw new TypeError('Invalid QQ profile sharing request');
    return transact(() => {
      const row = find.get(conversationKey);
      if ((row?.binding_revision ?? null) !== endpoint.bindingRevision || (row && row.person_key !== personKey)) {
        return { status: 'stale_binding' };
      }
      const scope = members(endpoint);
      if (!scope) return { status: 'binding_conflict' };
      const existing = findSharing.get(scope.principalId)?.conversation_key;
      if (enabled) {
        if (existing === conversationKey) return { status: 'updated' };
        if (existing) return { status: 'binding_conflict' };
        grantSharing.run(scope.principalId, conversationKey);
      } else {
        if (existing !== conversationKey) return { status: 'updated' };
        revokeSharing.run(scope.principalId);
      }
      reviseMembers.run(randomUUID(), scope.principalId);
      return { status: 'updated' };
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
      revokeDetachedSharing.run(row.principal_id, conversationKey, row.principal_id);
      return { status: 'unlinked' };
    });
  }

  return {
    resolve: (endpoint) => resolveKeys(endpointKeys(endpoint)),
    members,
    setLegacyQqProfileSharing,
    revisionForConversation: (conversationKey) => find.get(conversationKey)?.binding_revision ?? null,
    link,
    unlink,
  };
}
