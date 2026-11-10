import {
  encodeConversationKey, encodeMessageKey, encodePersonKey,
  readAccountRef, readConversationRef, readMessageRef, readPersonRef,
} from './identity.mjs';

function sameAccount(a, b) {
  return a.platform === b.platform && a.accountId === b.accountId && a.tenantId === b.tenantId;
}

function readIds(ids = [], validate) {
  if (!Array.isArray(ids)) throw new TypeError('Invalid channel access list');
  for (const id of ids) validate(id);
  return new Set(ids);
}

function readPolicy(channel) {
  const account = readAccountRef(channel);
  const { enabled = false, allow = {}, deny = {}, admins, groupPolicy = 'directed', observationVerified = false } = channel;
  if (typeof enabled !== 'boolean' || !['directed', 'observe'].includes(groupPolicy) ||
    typeof observationVerified !== 'boolean') throw new TypeError('Invalid channel policy');

  const validatePerson = (userId) => readPersonRef({ ...account, userId });
  const validateGroup = (chatId) => readConversationRef({ ...account, chatType: 'group', chatId });
  const readLists = (lists, fields) => {
    const prototype = lists != null && Object.getPrototypeOf(lists);
    if ((prototype !== Object.prototype && prototype !== null) ||
      Object.keys(lists).some((key) => !fields.includes(key))) throw new TypeError('Invalid channel access lists');
    return {
      private: readIds(lists.private, validatePerson),
      groups: readIds(lists.groups, validateGroup),
      senders: readIds(lists.senders, validatePerson),
    };
  };
  return {
    account, enabled, groupPolicy, observationVerified,
    allow: readLists(allow, ['private', 'groups']),
    deny: readLists(deny, ['private', 'groups', 'senders']),
    admins: readIds(admins, validatePerson),
  };
}

// Only the new transports use this policy. The QQ bridge still owns its legacy allow/deny rules.
function isAuthorized({ account, enabled, allow, deny }, conversation, actor) {
  if (account.platform === 'qq' || !enabled || !sameAccount(account, conversation)) return false;
  if (actor && (!sameAccount(account, actor) || deny.senders.has(actor.userId))) return false;
  if (account.platform === 'telegram' && actor?.userId === account.accountId) return false;
  if (conversation.chatType === 'group') {
    return !deny.groups.has(conversation.chatId) && allow.groups.has(conversation.chatId);
  }
  if (!actor || (account.platform === 'telegram' && actor.userId !== conversation.chatId)) return false;
  return !deny.private.has(actor.userId) && allow.private.has(actor.userId);
}

function messageInConversation(input, conversation, conversationKey) {
  const message = readMessageRef(input);
  if (message.platformChatId !== conversation.chatId || encodeConversationKey(message.conversation) !== conversationKey) {
    throw new TypeError('Message belongs to another target');
  }
  return message;
}

const drop = (reason) => ({ decision: 'drop', reason });

function validDeliveryRef(platform, value) {
  if (typeof value !== 'string') return false;
  if (platform === 'telegram') {
    // The poller's checkpoint is update_id + 1, so leave room for that increment.
    return /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value) + 1);
  }
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// The transport verifies sender type, platform identity and trigger facts. A caller may
// persist this decision, but must recheck the current policy before doing any work.
export function routeChannelMessage(channel, input) {
  if (input?.kind !== 'message') return drop('unsupported_event');
  if (input.senderType !== 'human') return drop('unsupported_sender');
  let policy;
  try { policy = readPolicy(channel); }
  catch { return drop('invalid_policy'); }
  try {
    const conversation = readConversationRef(input.conversation);
    const actor = readPersonRef(input.actor);
    if (!isAuthorized(policy, conversation, actor)) return drop('unauthorized');
    const { occurredAt, deliveryRef, trigger, text } = input;
    if (!Number.isInteger(occurredAt) || occurredAt < 0 || occurredAt > 8.64e15 ||
      !validDeliveryRef(conversation.platform, deliveryRef) ||
      typeof text !== 'string' || !text.trim() || !['directed', 'ambient'].includes(trigger)) return drop('invalid_event');

    const conversationKey = encodeConversationKey(conversation);
    const message = messageInConversation(input.message, conversation, conversationKey);
    const replyTo = input.replyTo == null ? null : messageInConversation(input.replyTo, conversation, conversationKey);
    const directed = conversation.chatType === 'private' || trigger === 'directed';
    if (!directed && (policy.groupPolicy !== 'observe' || !policy.observationVerified)) {
      return drop('not_triggered');
    }
    return {
      decision: directed ? 'directed' : 'observe',
      isAdmin: policy.admins.has(actor.userId),
      event: {
        kind: 'message', senderType: 'human', actor, conversation, message, replyTo, occurredAt, deliveryRef, trigger, text,
        conversationKey, personKey: encodePersonKey(actor), messageKey: encodeMessageKey(message),
      },
    };
  } catch {
    return drop('invalid_event');
  }
}

// A private target or reply requires the actor and conversation paired in trusted
// task or history state. A standalone group target must also come from trusted state.
// Only the current platform chat can be addressed. Chat migration needs an explicit mapping.
export function resolveTextTarget(channel, target, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  try {
    const { source, replyTo } = options;
    const conversation = readConversationRef(target);
    const conversationKey = encodeConversationKey(conversation);
    if (source != null && encodeConversationKey(source.conversation) !== conversationKey) return null;
    const actor = source == null ? null : readPersonRef(source.actor);
    if ((replyTo != null && !actor) || !isAuthorized(readPolicy(channel), conversation, actor)) return null;
    const message = replyTo == null ? null : messageInConversation(replyTo, conversation, conversationKey);
    return { conversation, replyToMessageId: message?.messageId ?? null };
  } catch {
    return null;
  }
}
