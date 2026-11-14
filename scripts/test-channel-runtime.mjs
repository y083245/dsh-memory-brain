import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import yaml from 'js-yaml';
import { openChannelOutbox } from '../src/core/outbox-store.mjs';
import { encodeConversationKey } from '../src/core/identity.mjs';
import { createLongMemory } from '../src/long-memory.js';

import { startChannelHost } from '../src/runtime/channel-host.mjs';

const FEISHU = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_fixture' };
const TELEGRAM = { platform: 'telegram', accountId: '41', tenantId: null };
const success = (value) => ({ result: { ok: true, value } });

function makeEvent(id = 1, account = FEISHU, chatType = 'group') {
  const feishu = account.platform === 'feishu';
  const actor = { ...account, userId: feishu ? 'ou_fixture' : '42' };
  const conversation = {
    ...account, chatType,
    chatId: chatType === 'private' ? (feishu ? 'oc_private' : '42') : (feishu ? 'oc_fixture' : '-100123'),
    threadId: chatType === 'private' ? null : (feishu ? 'topic_a' : '7'),
  };
  return {
    actor, conversation, kind: 'message', senderType: 'human', trigger: 'directed', text: 'incoming fixture',
    occurredAt: Date.UTC(2026, 10, 1), deliveryRef: feishu ? `evt_${id}` : String(id),
    message: { conversation, platformChatId: conversation.chatId, messageId: feishu ? `om_${id}` : String(id) },
  };
}

async function eventually(read, predicate = Boolean) {
  const deadline = performance.now() + 5_000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await pause(10);
  } while (performance.now() < deadline);
  assert.fail('Fixture condition did not become true');
}

async function signedTool({ port, secret }, prompt, callId, text = 'fixture reply', signed = true) {
  return signedChannelCall({ port, secret }, prompt, callId, 'channel_reply_text', { text }, { signed });
}

async function signedChannelCall({ port, secret }, prompt, callId, name, args, { signed = true } = {}) {
  const body = JSON.stringify({
    sessionId: prompt.sessionId, requestId: prompt.requestId, callId,
    name, args,
  });
  const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest('hex');
  const response = await fetch(`http://127.0.0.1:${port}/channel/text-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signed && { authorization: `Bearer ${signature}` }) },
    body, signal: AbortSignal.timeout(2_000),
  });
  return response.json();
}

async function fixture(t, { enableTextTools = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-runtime-'));
  const stateDir = join(dir, 'channels');
  const longMemory = createLongMemory({ stateDir: join(dir, 'memory') });
  const channels = {
    textTools: enableTextTools,
    feishu: { enabled: true, appId: FEISHU.accountId, allow: { private: ['ou_fixture'], groups: ['oc_fixture'], senders: ['ou_fixture'] } },
    telegram: { enabled: true, allow: { private: ['42'], groups: ['-100123'], senders: ['42'] } },
  };
  const prompts = [];
  const sessions = new Map();
  const completed = new Set();
  const reconciled = new Set();
  const sent = [];
  const controls = { ready: true, current: true, mute: false, onSend: null, onProjection: null };
  const api = {
    workspace: {
      create: async () => success({ workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async () => success({}),
    },
    sessions: {
      create: async ({ sessionId, agentPreset }) => {
        sessions.set(sessionId, agentPreset);
        return success({ sessionId, agentPreset });
      },
      prompt: async (params) => {
        prompts.push(params);
        return success({ accepted: true });
      },
    },
    stopSessionWork: async () => ({}),
    async callUnary(method, params) {
      if (method === 'agentPresets/list') return success({ presets: [{ id: 'channel-chat-v2' }, { id: 'channel-chat-v2-text' }] });
      if (method === 'agentPresets/read') {
        const patch = yaml.load(readFileSync(new URL(`../plugins/qq-agent-presets/presets/${params.agentPreset}.patch.yml`, import.meta.url), 'utf8'));
        const preset = patch[0].insert.find((row) => row.config?.id === params.agentPreset).config;
        return success({ agentPreset: params.agentPreset, content: yaml.dump(preset.plugins) });
      }
      const sessionId = params.sessionId ?? params.address?.sessionId;
      const prompt = prompts.findLast((candidate) => candidate.sessionId === sessionId);
      if (method === 'session/projections') {
        if (prompt) await controls.onProjection?.(prompt);
        return success({ asOfSeq: completed.has(prompt?.requestId) ? 2 : -1, values: { agentPreset: sessions.get(sessionId) } });
      }
      if (method === 'session/page') {
        if (params.throughSeq === -1) return success({ records: [], hasMore: false });
        reconciled.add(prompt.requestId);
        return success({ records: [
          { type: 'event', event: { seq: 0, type: 'turn/start', data: { turn: 1 } } },
          { type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: {
            id: 'fixture-message', role: 'user', content: [], source: { kind: 'user', rpcId: prompt.requestId },
          } } },
          { type: 'event', event: { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ], hasMore: false });
      }
      throw new Error('Unexpected fixture RPC');
    },
  };
  let host;
  t.after(async () => {
    await host?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  host = await startChannelHost({
    api, workspacePath: dir, stateDir, longMemory,
    readConfig: () => ({ channels }), canRunTurns: () => controls.ready,
    readRoleState: () => ({ role: 'Fixture Role', mode: controls.mute ? 'silent' : 'active' }),
    readRoleCard: () => 'Speak in a concise fixture style.',
    isSensitive: (text) => text === 'do not send fixture',
    enableTextTools, intervalMs: 15,
  });
  const feishu = host.registerAccount(FEISHU, {
    isCurrent: () => controls.current,
    adapter: {
      splitText: (text) => [text],
      async sendText(request) {
        sent.push(request);
        await controls.onSend?.(request);
        return { status: 'sent', platformMessageId: 'om_sent_fixture' };
      },
    },
  });
  return { host, feishu, channels, controls, prompts, sessions, completed, reconciled, sent, stateDir, longMemory, dir, api };
}

test('live disabling text tools selects the zero-tool preset for new turns', async (t) => {
  const { host, feishu, channels, prompts, sessions } = await fixture(t);
  channels.textTools = false;
  host.reload();
  assert.equal(feishu.accept(makeEvent()).status, 'durableAccepted');
  const prompt = await eventually(() => prompts[0]);
  assert.equal(sessions.get(prompt.sessionId), 'channel-chat-v2');
});

test('verified account replacement reconciles the retired account journal without redispatch', async (t) => {
  const { host, feishu, channels, prompts, completed, reconciled, sent, stateDir } = await fixture(t);
  assert.equal(feishu.accept(makeEvent()).status, 'durableAccepted');
  const original = await eventually(() => prompts[0]);
  // Seed the existing durable queue directly so the test does not race the
  // current account's outbound interval before replacement.
  const outbox = openChannelOutbox(join(stateDir, 'outbox.sqlite'));
  try {
    const { conversation, actor } = makeEvent();
    assert.equal(outbox.enqueue({
      operationId: 'retired_send', authorizationId: 'revoked_grant', conversation,
      source: { conversation, actor }, segments: ['old reply'],
    }).status, 'queued');
    const account = { ...FEISHU, accountId: 'cli_replacement' };
    channels.feishu.appId = account.accountId;
    const replacement = host.registerAccount(account);
    assert.equal(feishu.accept(makeEvent(2)).status, 'retryableFailure');
    assert.deepEqual(await signedTool(host.toolCredentials, original, 'replaced_account_call'), { status: 'denied' });
    assert.equal(replacement.accept(makeEvent(1, account)).status, 'durableAccepted');
    const next = await eventually(() => prompts[1]);
    assert.notEqual(next.sessionId, original.sessionId);
    completed.add(original.requestId);
    await eventually(() => reconciled.has(original.requestId));
    await eventually(() => outbox.get(FEISHU, 'retired_send').status, (status) => status === 'cancelled');
    assert.equal(prompts.length, 2);
    assert.deepEqual(sent, []);
  } finally {
    outbox.close();
  }
});

test('a busy dialogue leaves another platform and a later dialogue available', async (t) => {
  const { host, feishu, prompts, controls } = await fixture(t);
  const { promise: hold, resolve: release } = Promise.withResolvers();
  const { promise: started, resolve: startedBusy } = Promise.withResolvers();
  assert.equal(feishu.accept(makeEvent()).status, 'durableAccepted');
  const first = await eventually(() => prompts[0]);
  controls.onProjection = (prompt) => {
    if (prompt !== first) return;
    startedBusy();
    return hold;
  };
  await started;
  try {
    assert.equal(feishu.accept(makeEvent(2)).status, 'durableAccepted');
    assert.equal(feishu.accept(makeEvent(3, FEISHU, 'private')).status, 'durableAccepted');
    const poller = host.registerAccount(TELEGRAM).startPolling();
    assert.equal(poller.acceptBatch([makeEvent(1, TELEGRAM)], poller.readCheckpoint()).results[0].status, 'durableAccepted');
    await eventually(() => prompts.length === 3);
    assert.ok(prompts.some(({ content }) => content[0].text.includes('飞书私聊')));
    assert.ok(prompts.some(({ content }) => content[0].text.includes('Telegram群聊话题')));
  } finally {
    release();
  }
});

test('signed DSH tool requests are delivered by the production worker to the original topic', async (t) => {
  const { host, feishu, prompts, controls, sent, longMemory } = await fixture(t);
  const source = makeEvent();
  assert.equal(feishu.accept(source).status, 'durableAccepted');
  const prompt = await eventually(() => prompts[0]);
  assert.match(prompt.content[0].text, /Speak in a concise fixture style\./);
  assert.deepEqual(await signedTool(host.toolCredentials, prompt, 'call_unauth', 'ignored', false), { status: 'denied' });
  assert.deepEqual(await signedTool(host.toolCredentials, prompt, 'call_sensitive', 'do not send fixture'), { status: 'sensitive' });
  assert.deepEqual(await signedTool(host.toolCredentials, prompt, 'call_secret', host.toolCredentials.secret), { status: 'sensitive' });
  controls.ready = false;
  assert.deepEqual(await signedTool(host.toolCredentials, prompt, 'call_fixture'), { status: 'queued' });
  await eventually(() => sent[0]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'fixture reply');
  assert.equal(sent[0].replyToMessageId, 'om_1');
  assert.deepEqual(sent[0].conversation, source.conversation);
  const [reply] = await eventually(() => longMemory.archiveRows(encodeConversationKey(source.conversation), { dir: 'out' }), (rows) => rows.length === 1);
  assert.equal(reply.sendId, sent[0].sendId);
  assert.equal(reply.msgId, 'om_sent_fixture');
  assert.equal(host.getConversationDeliveryStats(source.conversation).confirmedCount, 1);
});

test('a restarted worker recovers confirmations with no registered account and text tools disabled', async (t) => {
  const { host, stateDir, longMemory, dir, api } = await fixture(t);
  await host.close();
  const outbox = openChannelOutbox(join(stateDir, 'outbox.sqlite'));
  const { conversation, actor, message: replyTo } = makeEvent();
  try {
    outbox.enqueue({
      operationId: 'restart_reply', authorizationId: 'revoked_grant', conversation, replyTo,
      source: { conversation, actor }, segments: ['confirmed while authorized'],
    });
    outbox.settle(FEISHU, outbox.claim(FEISHU), { status: 'sent', platformMessageId: 'om_already_sent' });
  } finally {
    outbox.close();
  }
  const recovered = await startChannelHost({
    api, workspacePath: dir, stateDir, longMemory, readConfig: () => ({}),
    canRunTurns: () => false, enableTextTools: false, intervalMs: 15,
  });
  try {
    assert.equal(recovered.toolCredentials, null);
    const [row] = await eventually(() => longMemory.archiveRows(encodeConversationKey(conversation)), (rows) => rows.length === 1);
    assert.equal(row.text, 'confirmed while authorized');
    assert.equal(row.msgId, 'om_already_sent');
  } finally {
    await recovered.close();
  }
});

test('production common tools isolate topics and reject a fabricated read cursor', async (t) => {
  const { host, feishu, controls, prompts, longMemory } = await fixture(t);
  const source = makeEvent();
  assert.equal(feishu.accept(source).status, 'durableAccepted');
  const prompt = await eventually(() => prompts[0]);
  controls.ready = false;
  const otherTopic = { ...source.conversation, threadId: 'topic_b' };
  const otherMessage = makeEvent(2);
  assert.equal(feishu.accept({ ...otherMessage, text: 'other topic fixture', conversation: otherTopic,
    message: { ...otherMessage.message, conversation: otherTopic } }).status, 'durableAccepted');
  assert.equal(feishu.accept({ ...makeEvent(3), text: 'same topic followup' }).status, 'durableAccepted');

  const call = (id, name, args) => signedChannelCall(host.toolCredentials, prompt, id, name, args);
  assert.equal((await call('call_ahead', 'channel_mark_read', { throughSeq: Number.MAX_SAFE_INTEGER })).status, 'denied');
  const page = await call('call_read', 'channel_get_unread', {});
  assert.equal(page.status, 'ok');
  assert.deepEqual(page.data.messages.map(({ text }) => text), [source.text, 'same topic followup']);
  assert.equal((await call('call_mark', 'channel_mark_read', { throughSeq: page.data.readThroughSeq })).status, 'ok');
  assert.deepEqual((await call('call_read_again', 'channel_get_unread', {})).data?.messages, []);

  const history = await call('call_history', 'channel_history_search', { query: source.text });
  assert.equal(history.status, 'ok');
  assert.match(JSON.stringify(history.data), /incoming fixture/);
  assert.doesNotMatch(JSON.stringify(history.data), /other topic fixture|ou_fixture/);
  const saved = await call('call_remember', 'channel_memory_remember', { cat: 'fact', text: 'A scoped fixture memory' });
  assert.equal(saved.status, 'ok');
  const recalled = await call('call_recall', 'channel_memory_recall', {});
  assert.match(JSON.stringify(recalled.data), /A scoped fixture memory/);
  assert.deepEqual(longMemory.listPeople(), []);
});

test('a common wait loses access if its active channel generation is revoked', async (t) => {
  const { host, feishu, channels, controls, prompts } = await fixture(t);
  assert.equal(feishu.accept(makeEvent()).status, 'durableAccepted');
  const prompt = await eventually(() => prompts[0]);
  controls.ready = false;
  const call = (id, name, args) => signedChannelCall(host.toolCredentials, prompt, id, name, args);
  const page = await call('call_read_before_wait', 'channel_get_unread', {});
  assert.equal(page.status, 'ok');
  const waiting = call('call_wait', 'channel_wait_for_messages', { afterSeq: page.data.readThroughSeq, timeoutMs: 1_500 });
  await pause(100);
  channels.feishu.deny = { senders: ['ou_fixture'] };
  host.reload();
  assert.deepEqual(await waiting, { status: 'denied' });
  channels.feishu.deny = {};
  host.reload();
  assert.deepEqual(await call('call_stale', 'channel_get_unread', {}), { status: 'denied' });
});

test('a linked state directory cannot redirect channel database creation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-runtime-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'linked-target');
  const stateDir = join(dir, 'channels');
  mkdirSync(target);
  symlinkSync(target, stateDir, process.platform === 'win32' ? 'junction' : 'dir');
  const longMemory = createLongMemory({ stateDir: join(dir, 'memory') });
  await assert.rejects(startChannelHost({ workspacePath: dir, stateDir, longMemory, readConfig: () => ({}) }),
    /Unsafe channel state directory/);
});

test('disabled, revoked, or reconfigured accounts cannot revive existing DSH tool grants', async (t) => {
  for (const change of ['disabled', 'revoked', 'verification', 'text tools', 'DSH restart']) {
    await t.test(change, async (subtest) => {
      const { host, feishu, channels, controls, prompts, sent } = await fixture(subtest);
      assert.equal(feishu.accept(makeEvent()).status, 'durableAccepted');
      const prompt = await eventually(() => prompts[0]);
      if (change === 'disabled') channels.feishu.enabled = false;
      if (change === 'revoked') channels.feishu.deny = { senders: ['ou_fixture'] };
      if (change === 'verification') controls.current = false;
      if (change === 'text tools') channels.textTools = false;
      if (change === 'DSH restart') host.invalidateAll();
      host.reload();
      channels.feishu.enabled = true;
      delete channels.feishu.deny;
      controls.current = true;
      channels.textTools = true;
      host.reload();
      assert.deepEqual(await signedTool(host.toolCredentials, prompt, 'stale_call'), { status: 'denied' });
      assert.deepEqual(sent, []);
    });
  }
});

test('unlinking another private endpoint invalidates the remaining members of that binding', async (t) => {
  const { host, feishu, prompts, sent } = await fixture(t);
  const f = makeEvent(1, FEISHU, 'private');
  const g = makeEvent(1, TELEGRAM, 'private');
  const endpoint = ({ actor, conversation }) => ({ actor, conversation, bindingRevision: null });
  assert.equal(host.privateBindings.link([endpoint(f), endpoint(g)]).status, 'linked');
  assert.equal(feishu.accept(f).status, 'durableAccepted');
  const prompt = await eventually(() => prompts[0]);
  const removal = { ...endpoint(g), ...host.privateBindings.resolve(endpoint(g)) };
  assert.equal(host.privateBindings.unlink(removal).status, 'unlinked');
  assert.deepEqual(await signedTool(host.toolCredentials, prompt, 'stale_binding_call'), { status: 'denied' });
  assert.deepEqual(sent, []);
});

test('an old Telegram poller cannot accept a response after account disable and re-enable', async (t) => {
  const { host, channels, controls } = await fixture(t, { enableTextTools: false });
  controls.ready = false;
  assert.equal(host.toolCredentials, null);
  const telegram = host.registerAccount(TELEGRAM);
  const poller = telegram.startPolling();
  const checkpoint = poller.readCheckpoint();
  channels.telegram.enabled = false;
  host.reload();
  assert.equal(poller.readCheckpoint(), null);
  channels.telegram.enabled = true;
  host.reload();
  assert.equal(poller.acceptBatch([makeEvent(7, TELEGRAM)], checkpoint).status, 'retryableFailure');
  const replacement = telegram.startPolling();
  const current = replacement.readCheckpoint();
  assert.equal(current.offset, null);
  assert.deepEqual(replacement.acceptBatch([makeEvent(7, TELEGRAM)], current).results, [{ status: 'durableAccepted' }]);
});

test('shutdown fences new requests and waits for an already-started platform send to settle', async (t) => {
  const { host, feishu, controls, prompts, sent, stateDir } = await fixture(t);
  let release;
  controls.onSend = () => new Promise((resolve) => { release = resolve; });
  assert.equal(feishu.accept(makeEvent()).status, 'durableAccepted');
  const prompt = await eventually(() => prompts[0]);
  assert.deepEqual(await signedTool(host.toolCredentials, prompt, 'call_fixture'), { status: 'queued' });
  await eventually(() => sent[0]);
  let closed = false;
  const close = host.close().then(() => { closed = true; });
  try {
    assert.equal(feishu.accept(makeEvent(2)).status, 'retryableFailure');
    await assert.rejects(signedTool(host.toolCredentials, prompt, 'call_after_close'));
    assert.equal(closed, false);
  } finally {
    release();
  }
  await close;
  const operationId = 'tool_' + createHash('sha256')
    .update(JSON.stringify([prompt.sessionId, prompt.requestId, 'call_fixture'])).digest('hex');
  const outbox = openChannelOutbox(join(stateDir, 'outbox.sqlite'));
  try {
    assert.equal(outbox.get(FEISHU, operationId).status, 'sent');
  } finally {
    outbox.close();
  }
});
