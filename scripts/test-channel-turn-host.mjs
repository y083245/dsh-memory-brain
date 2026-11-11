import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import yaml from 'js-yaml';
import { CHANNEL_DSH_PRESET } from '../src/core/channel-dsh-preset.mjs';
import { createChannelTurnHost, createHostedChannelTurnRunner } from '../src/core/channel-turn-host.mjs';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { createLongMemory } from '../src/long-memory.js';
import { encodeConversationKey } from '../src/core/identity.mjs';

const GROUP = { platform: 'telegram', accountId: '41', chatType: 'group', chatId: '-100123' };
const success = (value) => ({ result: { ok: true, value } });
const patch = yaml.load(readFileSync(new URL('../plugins/qq-agent-presets/presets/channel-chat-v2.patch.yml', import.meta.url), 'utf8'));
const guardedPlugins = patch[0].insert.find((row) => row.config?.id === CHANNEL_DSH_PRESET).config.plugins;

function task({ threadId = '7', bindingRevision = null } = {}) {
  return {
    bindingRevision,
    event: { conversationKey: encodeConversationKey({ ...GROUP, threadId }), text: 'fixture message' },
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const attestationCalls = [];
  const api = {
    async callUnary(method, input) {
      attestationCalls.push(method);
      if (method === 'agentPresets/list') return success({ presets: [{ id: CHANNEL_DSH_PRESET }] });
      if (method === 'agentPresets/read' && input.agentPreset === CHANNEL_DSH_PRESET) {
        return success({ agentPreset: CHANNEL_DSH_PRESET, content: yaml.dump(guardedPlugins) });
      }
      if (method === 'session/projections' && calls.some(({ sessionId }) => sessionId === input.sessionId)) {
        return success({ values: { agentPreset: CHANNEL_DSH_PRESET } });
      }
      throw new Error('Unexpected RPC');
    },
    workspace: { create: async () => success({ workspace: { workspaceId: 'fixture-workspace' } }) },
    sessions: { create: async (input) => {
      calls.push(input);
      return success({ sessionId: input.sessionId, agentPreset: input.agentPreset });
    } },
  };
  const options = {
    api, workspacePath: tmpdir(), isScopeCurrent: () => true,
    buildPrompt: async ({ task: input }) => input.event.text,
    ...overrides,
  };
  return { host: createChannelTurnHost(options), options, calls, attestationCalls, api };
}

test('missing dedicated preset prevents creation even if another simulation preset exists', async () => {
  const { host, calls, api } = fixture();
  api.callUnary = async () => success({ presets: [{ id: 'qq-chat-v2' }] });
  assert.equal(await host.prepareTurn({ task: task() }), null);
  assert.deepEqual(calls, []);
});

test('failed guard confirmation and mismatched create response withhold the prepared session', async () => {
  const { host, calls } = fixture({ confirmGuard: async () => false });
  assert.equal(await host.prepareTurn({ task: task() }), null);
  assert.equal(calls.length, 0);
  const other = fixture();
  other.api.sessions.create = async () => success({ sessionId: 'different-id' });
  assert.equal(await other.host.prepareTurn({ task: task() }), null);
  other.api.sessions.create = async (input) => success({ sessionId: input.sessionId, agentPreset: 'default' });
  assert.equal(await other.host.prepareTurn({ task: task() }), null);
});

test('a created session must attest its attached guard before dispatch', async () => {
  const { host, api, calls } = fixture({ confirmGuard: async (_snapshot, { sessionId }) => sessionId === undefined });
  const archived = [];
  api.workspace.archiveSession = async ({ sessionId }) => { archived.push(sessionId); };
  assert.equal(await host.prepareTurn({ task: task() }), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(archived, [calls[0].sessionId]);
});

test('scope, binding revision and generation protect reusable guarded sessions', async () => {
  const current = new Map();
  const { host, calls } = fixture({ isScopeCurrent: ({ conversationKey, bindingRevision }) =>
    current.has(conversationKey) && current.get(conversationKey) === bindingRevision });
  const first = task();
  current.set(first.event.conversationKey, null);
  const snapshot = await host.prepareTurn({ task: first });
  assert.equal(snapshot.text, first.event.text);
  assert.equal(snapshot.mode, 'reserved2');
  assert.deepEqual(calls, [{
    workspaceId: 'fixture-workspace', agentPreset: CHANNEL_DSH_PRESET, sessionId: snapshot.sessionId,
  }]);
  assert.equal(host.isCurrentSession(snapshot), true);
  assert.deepEqual(await host.prepareTurn({ task: first }), snapshot);
  assert.equal(calls.length, 1);
  assert.equal(host.isCurrentSession({ ...snapshot, generation: snapshot.generation + 1 }), false);

  const revised = task({ bindingRevision: 'new-binding' });
  current.set(first.event.conversationKey, revised.bindingRevision);
  assert.equal(host.isCurrentSession(snapshot), false);
  const next = await host.prepareTurn({ task: revised });
  assert.notEqual(next.sessionId, snapshot.sessionId);
  assert.ok(next.generation > snapshot.generation);
  assert.equal(await host.invalidateSession(snapshot), true);
  assert.equal(await host.invalidateSession(snapshot), true);
  assert.equal(host.isCurrentSession(next), true);

  const other = task({ threadId: '8', bindingRevision: 'new-binding' });
  current.set(other.event.conversationKey, other.bindingRevision);
  const topic = await host.prepareTurn({ task: other });
  assert.notEqual(topic.sessionId.split('-')[1], next.sessionId.split('-')[1]);
  assert.equal(await host.invalidateSession({ ...next, conversationKey: topic.conversationKey }), false);
  assert.equal(host.isCurrentSession(topic), true);
  assert.equal(await host.invalidateSession(next), true);
  assert.equal(host.isCurrentSession(next), false);
});

test('a restarted host cannot authorize old grants but can retire their original journal session', async () => {
  const { host, options } = fixture();
  const input = task();
  const old = await host.prepareTurn({ task: input });
  const restarted = createChannelTurnHost(options);
  assert.equal(restarted.isCurrentSession(old), false);
  assert.equal(await restarted.invalidateSession(old), true);
  const next = await restarted.prepareTurn({ task: input });
  assert.notEqual(next.sessionId, old.sessionId);
  assert.equal(await restarted.invalidateSession(old), true);
  assert.equal(restarted.isCurrentSession(next), true);
});

test('scope revocation and explicit source invalidation require a fresh session', async () => {
  let allowed = true;
  const { host } = fixture({ isScopeCurrent: () => allowed });
  const input = task();
  const old = await host.prepareTurn({ task: input });
  allowed = false;
  assert.equal(host.isCurrentSession(old), false);
  allowed = true;
  assert.equal(host.isCurrentSession(old), false);
  const next = await host.prepareTurn({ task: input });
  assert.notEqual(next.sessionId, old.sessionId);

  allowed = false;
  assert.equal(await host.prepareTurn({ task: input }), null);
  allowed = true;
  assert.equal(host.isCurrentSession(next), false);
  const fresh = await host.prepareTurn({ task: input });
  assert.equal(host.invalidateSource(fresh.conversationKey), true);
  assert.equal(host.isCurrentSession(fresh), false);
});

test('revocation during guard confirmation prevents publication', async () => {
  let release;
  let started;
  const enteringGuard = new Promise((resolve) => { started = resolve; });
  const { host } = fixture({ confirmGuard: async (snapshot) => {
    started(snapshot);
    return new Promise((resolve) => { release = resolve; });
  } });
  const preparing = host.prepareTurn({ task: task() });
  const snapshot = await enteringGuard;
  assert.equal(host.isCurrentSession(snapshot), false);
  assert.equal(await host.invalidateSession(snapshot), true);
  release(true);
  assert.equal(await preparing, null);
  assert.equal(host.isCurrentSession(snapshot), false);
});

test('explicit invalidation fences a prompt already in preparation', async () => {
  let release;
  let started;
  const enteringPrompt = new Promise((resolve) => { started = resolve; });
  const { host, calls } = fixture({ buildPrompt: async () => {
    started();
    return new Promise((resolve) => { release = resolve; });
  } });
  const input = task();
  const preparing = host.prepareTurn({ task: input });
  await enteringPrompt;
  host.invalidateSource(input.event.conversationKey);
  release(input.event.text);
  assert.equal(await preparing, null);
  assert.deepEqual(calls, []);
});

test('hosted runner sends scoped simulation prompts and archives quiet turns in the real inbox', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'channel-turn-host-'));
  const longMemory = createLongMemory({ stateDir });
  const inbox = openChannelInbox(join(stateDir, 'inbox.sqlite'), { archive: longMemory.channelArchive });
  t.after(() => {
    inbox.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  const account = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
  const actor = { ...account, userId: 'ou_fixture' };
  const conversation = { ...account, chatType: 'group', chatId: 'oc_fixture', threadId: 'topic_a' };
  const binding = inbox.bind(account, () => ({
    ...account, enabled: true, groupPolicy: 'observe', observationVerified: true,
    allow: { groups: [conversation.chatId], senders: [actor.userId] },
  }));
  function enqueue(id, text, threadId = conversation.threadId, trigger = 'directed') {
    const source = { ...conversation, threadId };
    const event = {
      conversation: source, actor, kind: 'message', senderType: 'human', trigger, text,
      occurredAt: Date.now(), deliveryRef: `evt_${id}`,
      message: { conversation: source, platformChatId: source.chatId, messageId: `om_${id}` },
    };
    assert.equal(binding.accept(event).status, 'durableAccepted');
    return binding.pending().find(({ event: { deliveryRef } }) => deliveryRef === event.deliveryRef);
  }

  const { options, calls, attestationCalls, api } = fixture();
  let roleState = { mode: 'silent' };
  const submitted = [];
  api.sessions.prompt = async (params) => {
    submitted.push(params);
    return success({ accepted: true });
  };
  let muteWhenCreated = false;
  const originalRpc = api.callUnary.bind(api);
  api.callUnary = async (method, input, signal) => {
    if (method === 'session/projections' && muteWhenCreated) roleState = { mode: 'silent' };
    return originalRpc(method, input, signal);
  };
  const hosted = createHostedChannelTurnRunner({
    api, workspacePath: options.workspacePath, longMemory, isScopeCurrent: options.isScopeCurrent,
    readRoleState: () => roleState,
  });
  const quiet = enqueue(1, 'quiet fixture');
  assert.deepEqual(await hosted.run(binding, quiet.event.messageKey), { status: 'silent' });
  assert.deepEqual(binding.pending(), []);
  assert.equal(calls.length, 0);
  assert.equal(longMemory.archiveRows(quiet.event.conversationKey)[0].text, 'quiet fixture');

  roleState = { mode: 'active' };
  const other = enqueue(2, 'cross-topic fixture', 'topic_b', 'ambient');
  assert.deepEqual(await hosted.run(binding, other.event.messageKey), { status: 'observed' });
  muteWhenCreated = true;
  const lateQuiet = enqueue(3, 'muted during session attestation');
  assert.deepEqual(await hosted.run(binding, lateQuiet.event.messageKey), { status: 'silent' });
  assert.deepEqual(binding.pending(), []);
  assert.deepEqual(submitted, []);

  muteWhenCreated = false;
  roleState = { mode: 'active' };
  const item = enqueue(4, 'directed fixture');
  assert.deepEqual(await hosted.run(binding, item.event.messageKey), { status: 'accepted' });
  assert.equal(calls.length, 1);
  assert.deepEqual(attestationCalls, [
    'agentPresets/list', 'agentPresets/read',
    'agentPresets/list', 'agentPresets/read', 'session/projections',
    'agentPresets/list', 'agentPresets/read', 'session/projections',
  ]);
  assert.equal(submitted.length, 1);
  const [prompt] = submitted;
  assert.equal(prompt.sessionId, calls[0].sessionId);
  assert.equal(prompt.requestId, item.taskId);
  assert.match(prompt.content[0].text, /二代仿真唤醒/);
  assert.match(prompt.content[0].text, /directed fixture/);
  assert.doesNotMatch(prompt.content[0].text, /cross-topic fixture/);
});
