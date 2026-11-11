const ASCII_ID = /^[A-Za-z0-9_-]{1,128}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,15}$/;
const SIGNED_ID = /^-?[1-9][0-9]{0,15}$/;
const TELEGRAM_ID_MAX = 2 ** 52 - 1;

function requireId(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`Invalid ${field}`);
  return value;
}

function numericId(value, field, { signed = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  const id = requireId(value, signed ? SIGNED_ID : POSITIVE_ID, field);
  if (Math.abs(Number(id)) > max) throw new TypeError(`Invalid ${field}`);
  return id;
}

export function readAccountRef({ platform, accountId, tenantId = null } = {}) {
  switch (platform) {
    case 'qq':
    case 'telegram':
      if (tenantId !== null) throw new TypeError('Invalid tenantId');
      numericId(accountId, 'accountId', { max: platform === 'telegram' ? TELEGRAM_ID_MAX : undefined });
      break;
    case 'feishu':
      requireId(accountId, /^cli_[A-Za-z0-9_-]{1,124}$/, 'accountId');
      requireId(tenantId, ASCII_ID, 'tenantId');
      break;
    default:
      throw new TypeError('Invalid platform');
  }
  return { platform, accountId, tenantId };
}

export function sameAccount(a, b) {
  return a.platform === b.platform && a.accountId === b.accountId && a.tenantId === b.tenantId;
}

function requireChatId({ platform, chatType }, chatId, field) {
  if (platform === 'feishu') return requireId(chatId, /^oc_[A-Za-z0-9_-]{1,125}$/, field);
  if (platform === 'qq') return numericId(chatId, field);
  numericId(chatId, field, { signed: chatType === 'group', max: TELEGRAM_ID_MAX });
  if (chatType === 'group' && !chatId.startsWith('-')) throw new TypeError(`Invalid ${field}`);
  return chatId;
}

export function readConversationRef(ref) {
  const account = readAccountRef(ref);
  const { chatType, chatId, threadId = null } = ref;
  if (chatType !== 'private' && chatType !== 'group') throw new TypeError('Invalid chatType');
  const conversation = { ...account, chatType, chatId, threadId };
  requireChatId(conversation, chatId, 'chatId');
  if (threadId !== null) {
    if (account.platform === 'qq') throw new TypeError('Invalid threadId');
    if (account.platform === 'feishu') requireId(threadId, ASCII_ID, 'threadId');
    else numericId(threadId, 'threadId');
  }
  return conversation;
}

export function readPersonRef(ref) {
  const account = readAccountRef(ref);
  const { userId } = ref;
  if (account.platform === 'feishu') requireId(userId, /^ou_[A-Za-z0-9_-]{1,125}$/, 'userId');
  else numericId(userId, 'userId', { max: account.platform === 'telegram' ? TELEGRAM_ID_MAX : undefined });
  return { ...account, userId };
}

export function readMessageRef({ conversation: input, platformChatId, messageId } = {}) {
  const conversation = readConversationRef(input);
  requireChatId(conversation, platformChatId, 'platformChatId');
  if (conversation.platform === 'feishu') requireId(messageId, /^om_[A-Za-z0-9_-]{1,125}$/, 'messageId');
  else numericId(messageId, 'messageId', { signed: conversation.platform === 'qq' });
  return { conversation, platformChatId, messageId };
}

const conversationTuple = ({ platform, accountId, tenantId, chatType, chatId, threadId }) =>
  [platform, accountId, tenantId, chatType, chatId, threadId];
const conversationFromTuple = ([platform, accountId, tenantId, chatType, chatId, threadId]) =>
  ({ platform, accountId, tenantId, chatType, chatId, threadId });

function encode(prefix, tuple) {
  return `${prefix}_${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}`;
}

export function encodeConversationKey(ref) {
  return encode('c1', conversationTuple(readConversationRef(ref)));
}

export function encodePersonKey(ref) {
  const { platform, accountId, tenantId, userId } = readPersonRef(ref);
  return encode('p1', [platform, accountId, tenantId, userId]);
}

export function encodeMessageKey(ref) {
  const { conversation, platformChatId, messageId } = readMessageRef(ref);
  return encode('m1', [conversationTuple(conversation), platformChatId, messageId]);
}

export function decodeIdentityKey(key) {
  const match = typeof key === 'string' && /^(c1|p1|m1)_([A-Za-z0-9_-]{1,2048})$/.exec(key);
  if (!match) throw new TypeError('Invalid identity key');
  try {
    const [, prefix, payload] = match;
    const tuple = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    let ref;
    if (prefix === 'c1' && Array.isArray(tuple) && tuple.length === 6) {
      ref = readConversationRef(conversationFromTuple(tuple));
    } else if (prefix === 'p1' && Array.isArray(tuple) && tuple.length === 4) {
      const [platform, accountId, tenantId, userId] = tuple;
      ref = readPersonRef({ platform, accountId, tenantId, userId });
    } else if (prefix === 'm1' && Array.isArray(tuple) && tuple.length === 3 &&
      Array.isArray(tuple[0]) && tuple[0].length === 6) {
      const [conversation, platformChatId, messageId] = tuple;
      ref = readMessageRef({ conversation: conversationFromTuple(conversation), platformChatId, messageId });
    }
    if (ref && encode(prefix, tuple) === key) return ref;
  } catch {
    // Do not echo untrusted input in validation errors.
  }
  throw new TypeError('Invalid identity key');
}

// Only for existing QQ callers. New references require an explicit account.
export function canonicalLegacyQQKey(key) {
  const match = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!match) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) && id > 0 ? `${match[1]}:${id}` : null;
}
