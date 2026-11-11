import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as identity from '../src/core/identity.mjs';
import * as intake from '../src/core/channel-intake.mjs';
import { canonicalConversationKey } from '../src/core/session-router.mjs';

const telegram = { platform: 'telegram', accountId: '41' };
const feishu = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const group = { ...telegram, chatType: 'group', chatId: '-100123', threadId: '7' };
const actor = { ...telegram, userId: '42' };
const privateChat = { ...telegram, chatType: 'private', chatId: '42' };
const message = { conversation: group, platformChatId: '-100123', messageId: '19' };
const event = {
  actor, conversation: group, message, text: 'fixture', occurredAt: 1794268800000,
  deliveryRef: '0', trigger: 'directed', kind: 'message', senderType: 'human',
};
const channel = { ...telegram, enabled: true, allow: { groups: ['-100123'], private: ['42'], senders: ['42'] } };

test('versioned identity keys match the shared protocol vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/channel-identity-vectors.json', import.meta.url), 'utf8'));
  const encoders = { conversation: identity.encodeConversationKey, person: identity.encodePersonKey, message: identity.encodeMessageKey };
  for (const { kind, key, ref } of vectors.valid) {
    assert.equal(encoders[kind](ref), key);
    assert.deepEqual(identity.decodeIdentityKey(key), ref);
  }
  for (const key of vectors.invalid) assert.throws(() => identity.decodeIdentityKey(key), TypeError);
});

test('conversation keys round-trip canonically and separate accounts, tenants, topics and chat types', () => {
  const fsGroup = { ...feishu, chatType: 'group', chatId: 'oc_fixture', threadId: 'omt_fixture' };
  const refs = [group, { ...group, accountId: '42' }, { ...group, threadId: '8' },
    { ...group, threadId: null }, privateChat, { ...privateChat, threadId: '7' }, { ...privateChat, platform: 'qq' },
    fsGroup, { ...fsGroup, tenantId: 'tenant_b' }, { ...fsGroup, accountId: 'cli_other' }];
  const keys = refs.map(identity.encodeConversationKey);
  assert.equal(new Set(keys).size, refs.length);
  assert.deepEqual(identity.decodeIdentityKey(keys[0]), { ...group, tenantId: null });
  assert.equal(identity.decodeIdentityKey(keys[4]).threadId, null);
});

test('person and message keys separate equal IDs by platform and retain original chat evidence', () => {
  assert.notEqual(identity.encodePersonKey(actor), identity.encodePersonKey({ ...actor, platform: 'qq' }));
  assert.notEqual(identity.encodePersonKey({ ...feishu, userId: 'ou_same' }),
    identity.encodePersonKey({ ...feishu, userId: 'ou_same', tenantId: 'tenant_b' }));
  const refs = [message, { ...message, platformChatId: '-123' },
    { ...message, conversation: { ...group, threadId: '8' } }];
  const keys = refs.map(identity.encodeMessageKey);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(identity.decodeIdentityKey(keys[1]), {
    ...refs[1], conversation: { ...group, tenantId: null },
  });
  assert.throws(() => identity.encodePersonKey({ ...feishu, userId: 'on_union_id' }), TypeError);
});

test('decoding rejects aliases, unsafe IDs and legacy QQ inputs', () => {
  const key = identity.encodeConversationKey(group);
  const fromJson = (json) => `c1_${Buffer.from(json).toString('base64url')}`;
  for (const invalid of [` ${key}`, key.replace('c1_', 'p1_'),
    fromJson('["telegram", "41",null,"group","-100123","7"]'),
    fromJson('["telegram","41",null,"group","-100123","7",null]'),
    fromJson('["telegram","41",null,"group","-100123","\\u0037"]')]) {
    assert.throws(() => identity.decodeIdentityKey(invalid), TypeError);
  }
  for (const chatId of [42, '-0', '42', '-00042', '-4503599627370496', '-42\n', '../42']) {
    assert.throws(() => identity.encodeConversationKey({ ...group, chatId }), TypeError);
  }
  assert.throws(() => identity.encodeConversationKey({ ...feishu, tenantId: undefined, chatType: 'private', chatId: 'oc_fixture' }), TypeError);
  assert.throws(() => identity.encodeConversationKey({ ...group, tenantId: 'tenant_a' }), TypeError);
  assert.equal(canonicalConversationKey(' private:00042 '), 'private:42');
  assert.equal(canonicalConversationKey(key), null);
});

test('intake accepts only authorized messages on the verified account and exact conversation', () => {
  const result = intake.routeChannelMessage(channel, event);
  assert.equal(result.decision, 'directed');
  assert.equal(result.event.conversationKey, identity.encodeConversationKey(group));
  assert.equal(result.event.personKey, identity.encodePersonKey(actor));
  assert.equal(result.event.messageKey, identity.encodeMessageKey(message));
  assert.equal(result.event.deliveryRef, '0');
  assert.equal(result.isAdmin, false);
  for (const filtered of [
    intake.routeChannelMessage({ ...channel, allow: {} }, event),
    intake.routeChannelMessage({ ...channel, deny: { senders: ['42'] }, admins: ['42'] }, event),
    intake.routeChannelMessage({ ...channel, deny: { groups: ['-100123'] } }, event),
    intake.routeChannelMessage({ ...channel, accountId: '42' }, event),
    intake.routeChannelMessage({ ...channel, enabled: false }, event),
    intake.routeChannelMessage(channel, { ...event, kind: 'edited_message' }),
    intake.routeChannelMessage(channel, { ...event, senderType: 'bot' }),
    intake.routeChannelMessage(channel, { ...event, senderType: undefined }),
    intake.routeChannelMessage(channel, { ...event, actor: { ...actor, userId: '41' } }),
    intake.routeChannelMessage(channel, { ...event, actor: { ...actor, accountId: '42' } }),
    intake.routeChannelMessage(channel, { ...event, message: { ...message, platformChatId: '-123' } }),
    intake.routeChannelMessage(channel, { ...event, message: { ...message, conversation: { ...group, threadId: '8' } } }),
  ]) {
    assert.equal(filtered.decision, 'drop');
    assert.equal(Object.hasOwn(filtered, 'event'), false);
  }
});

test('malformed channel settings cannot bypass deny rules or authorize a send', () => {
  for (const settings of [{ deny: null }, { deny: '42' }, { deny: new Map([['private', ['42']]]) }, { deny: { private: [42] } },
    { deny: { group: ['-100123'] } }, { allow: { ...channel.allow, groups: [-100123] } },
    { admins: [42] }, { groupPolicy: 'observ' }]) {
    const invalidChannel = { ...channel, ...settings };
    assert.deepEqual(intake.routeChannelMessage(invalidChannel, event), { decision: 'drop', reason: 'invalid_policy' });
    assert.equal(intake.resolveTextTarget(invalidChannel, group), null);
  }
});

test('group admission and source-bound sends require both the group and sender allowlists', () => {
  for (const allow of [{ groups: [group.chatId] }, { groups: [group.chatId], senders: [] },
    { groups: [group.chatId], senders: ['43'] }, { groups: [], senders: ['42'] }]) {
    const revoked = { ...channel, allow, admins: ['42'], groupPolicy: 'observe', observationVerified: true };
    assert.deepEqual(intake.routeChannelMessage(revoked, event), { decision: 'drop', reason: 'unauthorized' });
    assert.deepEqual(intake.routeChannelMessage(revoked, { ...event, trigger: 'ambient' }),
      { decision: 'drop', reason: 'unauthorized' });
    assert.equal(intake.resolveTextTarget(revoked, group, { source: event, replyTo: message }), null);
  }
  assert.deepEqual(intake.routeChannelMessage({ ...channel, allow: { ...channel.allow, senders: [42] } }, event),
    { decision: 'drop', reason: 'invalid_policy' });
  assert.ok(intake.resolveTextTarget(channel, group));
});

test('group observation requires verified permission and a nickname cannot grant admin access', () => {
  const ambient = { ...event, trigger: 'ambient', actor: { ...actor, name: '管理员', isAdmin: true } };
  assert.equal(intake.routeChannelMessage(channel, ambient).decision, 'drop');
  const observing = { ...channel, groupPolicy: 'observe' };
  assert.equal(intake.routeChannelMessage(observing, ambient).decision, 'drop');
  const result = intake.routeChannelMessage({ ...observing, observationVerified: true }, ambient);
  assert.equal(result.decision, 'observe');
  assert.equal(result.isAdmin, false);
  assert.equal(Object.hasOwn(result.event.actor, 'name'), false);
  assert.equal(intake.routeChannelMessage({ ...channel, admins: ['42'] }, event).isAdmin, true);
});

test('intake rejects Telegram update aliases and timestamps that cannot be archived', () => {
  for (const deliveryRef of ['00', '01', '-1', 'abc', '9007199254740992']) {
    assert.deepEqual(intake.routeChannelMessage(channel, { ...event, deliveryRef }), {
      decision: 'drop', reason: 'invalid_event',
    });
  }
  assert.equal(intake.routeChannelMessage(channel, { ...event, occurredAt: 8640000000000001 }).decision, 'drop');
  assert.equal(intake.routeChannelMessage(channel, { ...event, deliveryRef: '19' }).decision, 'directed');
});

test('private intake matches Telegram peer identity and Feishu tenant and user separately', () => {
  const privateMessage = { conversation: privateChat, platformChatId: '42', messageId: '19' };
  const otherPeer = { ...privateChat, chatId: '43' };
  const privateEvent = { ...event, conversation: privateChat, message: privateMessage };
  assert.equal(intake.routeChannelMessage(channel, privateEvent).decision, 'directed');
  assert.equal(intake.routeChannelMessage({ ...channel, allow: { private: ['42', '43'] } }, {
    ...privateEvent, conversation: otherPeer, message: { ...privateMessage, conversation: otherPeer, platformChatId: '43' },
  }).decision, 'drop');

  const conversation = { ...feishu, chatType: 'private', chatId: 'oc_fixture' };
  const feishuEvent = {
    ...event, conversation, actor: { ...feishu, userId: 'ou_same' }, deliveryRef: 'event_fixture',
    message: { conversation, platformChatId: 'oc_fixture', messageId: 'om_fixture' },
  };
  const feishuChannel = { ...feishu, enabled: true, allow: { private: ['ou_same'] } };
  const admitted = intake.routeChannelMessage(feishuChannel, feishuEvent);
  assert.equal(admitted.decision, 'directed');
  assert.equal(intake.routeChannelMessage({ ...feishuChannel, tenantId: 'tenant_b' }, feishuEvent).decision, 'drop');
  assert.equal(intake.resolveTextTarget(feishuChannel, { ...conversation, chatId: 'oc_other' }, { source: admitted.event }), null);
  assert.equal(intake.resolveTextTarget(feishuChannel, conversation, { source: admitted.event })?.conversation.chatId, 'oc_fixture');
  assert.equal(intake.resolveTextTarget(feishuChannel, conversation, { actor: feishuEvent.actor }), null);
});

test('a text target preserves the topic and refuses replies from other chats or topics', () => {
  const source = { conversation: group, actor };
  assert.deepEqual(intake.resolveTextTarget(channel, group, { source, replyTo: message }), {
    conversation: { ...group, tenantId: null }, replyToMessageId: '19',
  });
  assert.equal(intake.resolveTextTarget(channel, { ...group, accountId: '42' }), null);
  assert.equal(intake.resolveTextTarget({ ...channel, deny: { groups: [group.chatId] } }, group), null);
  assert.equal(intake.resolveTextTarget(channel, group, '19'), null);
  assert.equal(intake.resolveTextTarget(channel, group, { source, replyTo: '19' }), null);
  assert.equal(intake.resolveTextTarget(channel, group, { source, replyTo: { ...message, platformChatId: '-123' } }), null);
  assert.equal(intake.resolveTextTarget(channel, group, { source, replyTo: {
    ...message, conversation: { ...group, threadId: '8' },
  } }), null);
  assert.equal(intake.resolveTextTarget({ ...channel, deny: { senders: ['42'] } }, group, { source }), null);
  assert.equal(intake.resolveTextTarget(channel, privateChat), null);
  assert.deepEqual(intake.resolveTextTarget(channel, privateChat, { source: { conversation: privateChat, actor } }), {
    conversation: { ...privateChat, tenantId: null, threadId: null }, replyToMessageId: null,
  });
});
