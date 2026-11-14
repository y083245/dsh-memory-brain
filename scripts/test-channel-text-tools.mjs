import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { createHostedChannelTurnRunner } from '../src/core/channel-turn-host.mjs';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { openChannelOutbox } from '../src/core/outbox-store.mjs';
import { createLongMemory } from '../src/long-memory.js';

const PRESET = 'channel-chat-v2-text';
const SEND = 'channel_send_text';
const REPLY = 'channel_reply_text';
const TELEGRAM = { platform: 'telegram', accountId: '41', tenantId: null };
const FEISHU = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_fixture' };
const success = (value) => ({ result: { ok: true, value } });

function fixture(t, account = TELEGRAM) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-text-tools-'));
  const longMemory = createLongMemory({ stateDir: dir });
  const inbox = openChannelInbox(join(dir, 'inbox.sqlite'), { archive: longMemory.channelArchive });
  const store = openChannelOutbox(join(dir, 'outbox.sqlite'));
  t.after(() => {
    store.close();
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const feishu = account.platform === 'feishu';
  const actor = { ...account, userId: feishu ? 'ou_fixture' : '42' };
  const conversation = { ...account, chatType: 'group', chatId: feishu ? 'oc_fixture' : '-100123', threadId: feishu ? 'topic_a' : '7' };
  const policy = {
    ...account, enabled: true, groupPolicy: 'observe', observationVerified: true,
    allow: { groups: [conversation.chatId], senders: [actor.userId], private: [actor.userId] },
  };
  const controls = { canSend: true, muted: false, onPrompt: null, onSplit: null, onReadInboundPolicy: null,
    onProjections: null, projectedPreset: null, scopeCurrent: true };
  const binding = inbox.bind(account, () => {
    controls.onReadInboundPolicy?.();
    return policy;
  });
  const poller = feishu ? null : binding.startPolling();
  const prompts = [];
  const sessions = new Map();
  const completed = new Set();
  const sent = [];
  let id = 0;

  const api = {
    workspace: {
      create: async () => success({ workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => success({ archivedSessionIds: [sessionId] }),
    },
    sessions: {
      create: async ({ sessionId, agentPreset }) => {
        sessions.set(sessionId, agentPreset);
        return success({ sessionId, agentPreset });
      },
      prompt: async ({ sessionId, requestId }) => {
        prompts.push({ sessionId, requestId });
        controls.onPrompt?.({ sessionId, requestId });
        return success({ accepted: true });
      },
    },
    stopSessionWork: async () => ({ removed: 0 }),
    async callUnary(method, params) {
      if (method === 'agentPresets/list') return success({ presets: [{ id: 'channel-chat-v2' }, { id: PRESET }] });
      if (method === 'agentPresets/read' && ['channel-chat-v2', PRESET].includes(params.agentPreset)) {
        const patch = yaml.load(readFileSync(new URL(`../plugins/qq-agent-presets/presets/${params.agentPreset}.patch.yml`, import.meta.url), 'utf8'));
        const plugins = patch[0].insert.find((row) => row.config?.id === params.agentPreset).config.plugins;
        return success({ agentPreset: params.agentPreset, content: yaml.dump(plugins) });
      }
      if (method === 'session/projections') {
        controls.onProjections?.();
        const prompt = prompts.findLast(({ sessionId }) => sessionId === params.sessionId);
        return success({ asOfSeq: completed.has(prompt?.requestId) ? 2 : -1,
          values: { agentPreset: controls.projectedPreset ?? sessions.get(params.sessionId) } });
      }
      if (method === 'session/page' && params.throughSeq === 2) {
        const { requestId } = prompts.findLast(({ sessionId }) => sessionId === params.address.sessionId);
        return success({ records: [
          { type: 'event', event: { seq: 0, type: 'turn/start', data: { turn: 1 } } },
          { type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: {
            id: 'fixture-message', role: 'user', content: [], source: { kind: 'user', rpcId: requestId },
          } } },
          { type: 'event', event: { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ], hasMore: false });
      }
      throw new Error('Unexpected fixture RPC');
    },
  };

  function enqueue({ threadId = conversation.threadId, privateChat = false, trigger = 'directed' } = {}) {
    const source = privateChat ? { ...conversation, chatType: 'private', chatId: feishu ? 'oc_private' : actor.userId, threadId: null } :
      { ...conversation, threadId };
    const messageId = feishu ? `om_${++id}` : String(++id);
    const deliveryRef = feishu ? `evt_${id}` : String(id);
    const event = {
      actor, conversation: source, kind: 'message', senderType: 'human', trigger,
      deliveryRef, text: 'incoming fixture', occurredAt: Date.UTC(2026, 10, 1),
      message: { conversation: source, platformChatId: source.chatId, messageId },
      replyTo: { conversation: source, platformChatId: source.chatId, messageId: feishu ? 'om_previous' : '99' },
    };
    const accepted = feishu ? binding.accept(event) : poller.acceptBatch([event], poller.readCheckpoint()).results[0];
    assert.equal(accepted.status, 'durableAccepted');
    return binding.pending().find((item) => item.event.deliveryRef === deliveryRef);
  }

  function hosted({ enabled = true } = {}) {
    return createHostedChannelTurnRunner({
      api, workspacePath: dir, longMemory, isScopeCurrent: () => controls.scopeCurrent,
      readRoleState: () => ({ mode: controls.muted ? 'silent' : 'active' }),
      textTools: enabled ? {
        store, isSensitive: (text) => text.includes('sensitive fixture'),
        authorizeSource: () => controls.canSend ? policy : null,
        adapterFor: () => ({
          splitText(text) {
            controls.onSplit?.();
            return text.split(/(?=世界)/u);
          },
          async sendText({ conversation: target, replyToMessageId, text }) {
            sent.push({ target, replyToMessageId, text });
            return { status: 'sent', platformMessageId: feishu ? `om_sent_${sent.length}` : String(90 + sent.length) };
          },
        }),
      } : undefined,
    });
  }

  async function start(runner, item) {
    assert.deepEqual(await runner.run(binding, item.event.messageKey), { status: 'accepted' });
    return prompts.at(-1);
  }

  async function finish(runner, item) {
    completed.add(item.taskId);
    assert.deepEqual(await runner.run(binding, item.event.messageKey), { status: 'completed' });
  }

  async function finishOrphan(runner, item) {
    completed.add(item.taskId);
    assert.deepEqual(await runner.reconcileOrphan(binding, item.taskId), { status: 'completed' });
  }

  return { account, actor, binding, controls, enqueue, finish, finishOrphan, hosted, inbox, longMemory, policy, sent, sessions, start };
}

function call(context, { callId = 'fixture-call', name = REPLY, args = { text: '你好，世界' } } = {}) {
  return { ...context, callId, name, args };
}

test('opens the exact directed capability before dispatch and quotes only the original message', async (t) => {
  for (const account of [TELEGRAM, FEISHU]) {
    await t.test(account.platform, async (subtest) => {
      const { controls, enqueue, finish, hosted, longMemory, sent, sessions, start } = fixture(subtest, account);
      const runner = hosted();
      const item = enqueue();
      let synchronous;
      controls.onPrompt = (context) => { synchronous = runner.invokeTextTool(call(context)); };
      const context = await start(runner, item);
      assert.deepEqual(synchronous, { status: 'queued' });
      assert.equal(sessions.get(context.sessionId), PRESET);
      assert.equal(longMemory.archiveRows(item.event.conversationKey)[0].text, 'incoming fixture');
      assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'existing' });
      assert.deepEqual(sent, []);
      await finish(runner, item);
      assert.deepEqual(runner.invokeTextTool(call(context, { callId: 'late-call' })), { status: 'denied' });
      assert.equal((await runner.deliverNextText(account)).status, 'pending');
      assert.equal((await runner.deliverNextText(account)).status, 'sent');
      assert.equal(await runner.deliverNextText(account), null);
      assert.deepEqual(sent, ['你好，', '世界'].map((text) => ({
        target: item.event.conversation, replyToMessageId: item.event.message.messageId, text,
      })));
    });
  }
});

test('rejects missing context, crossed session and request, model routing keys and changed duplicate plans', async (t) => {
  const { enqueue, hosted, sent, start } = fixture(t);
  const runner = hosted();
  assert.equal(typeof runner.invokeTextTool, 'function');
  assert.deepEqual(runner.invokeTextTool(call({})), { status: 'invalid' });
  const first = await start(runner, enqueue());
  const other = await start(runner, enqueue({ threadId: '8' }));
  assert.deepEqual(runner.invokeTextTool(call({ ...first, requestId: other.requestId })), { status: 'denied' });
  assert.deepEqual(runner.invokeTextTool(call(first, { args: { text: 'fixture', threadId: '8' } })), { status: 'invalid' });
  assert.deepEqual(runner.invokeTextTool(call(first, { args: { text: 'fixture', replyTo: '99' } })), { status: 'invalid' });
  assert.deepEqual(runner.invokeTextTool({ ...call(first), conversation: other }), { status: 'invalid' });
  assert.deepEqual(runner.invokeTextTool(call(first, { args: { text: 'sensitive fixture' } })), { status: 'sensitive' });
  const send = call(first, { name: SEND, args: { text: 'original fixture' } });
  assert.deepEqual(runner.invokeTextTool(send), { status: 'queued' });
  assert.deepEqual(runner.invokeTextTool({ ...send, name: REPLY }), { status: 'conflict' });
  assert.deepEqual(runner.invokeTextTool({ ...send, args: { text: 'different fixture' } }), { status: 'conflict' });
  assert.deepEqual(runner.invokeTextTool(send), { status: 'existing' });
  assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'sent');
  assert.equal(await runner.deliverNextText(TELEGRAM), null);
  assert.deepEqual(sent.map(({ target, replyToMessageId, text }) => [target.threadId, replyToMessageId, text]), [
    ['7', null, 'original fixture'],
  ]);
});

test('retains the current turn between leases and denies old requests after reusing its session', async (t) => {
  const { enqueue, finish, hosted, sent, start } = fixture(t);
  const runner = hosted();
  const first = enqueue();
  const prior = await start(runner, first);
  assert.deepEqual(runner.invokeTextTool(call(prior)), { status: 'queued' });
  await finish(runner, first);
  const current = await start(runner, enqueue());
  assert.equal(current.sessionId, prior.sessionId);
  assert.notEqual(current.requestId, prior.requestId);
  assert.deepEqual(runner.invokeTextTool(call(prior)), { status: 'denied' });
  assert.deepEqual(runner.invokeTextTool(call(current)), { status: 'queued' });
  assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'pending');
  assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'sent');
  assert.deepEqual(sent.map(({ replyToMessageId }) => replyToMessageId), ['1', '1']);
});

test('rechecks revocation before each segment and preserves the already confirmed message', async (t) => {
  const { controls, enqueue, finish, hosted, policy, sent, start } = fixture(t);
  const runner = hosted();
  const item = enqueue();
  const context = await start(runner, item);
  assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
  await finish(runner, item);
  assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'pending');
  policy.deny = { senders: ['42'] };
  const result = await runner.deliverNextText(TELEGRAM);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.segments.map(({ status, platformMessageId }) => [status, platformMessageId]), [
    ['sent', '91'], ['cancelled', null],
  ]);
  policy.deny = {};
  controls.canSend = true;
  assert.equal(await runner.deliverNextText(TELEGRAM), null);
  assert.equal(sent.length, 1);
});

test('denies new invokes and unsent messages after mute, send disable, scope invalidation or retirement', async (t) => {
  for (const cause of ['mute', 'send disable', 'scope revocation', 'scope invalidation', 'retirement', 'retiring intent']) {
    await t.test(cause, async (subtest) => {
      const { binding, controls, enqueue, hosted, sent, start } = fixture(subtest);
      const runner = hosted();
      const item = enqueue();
      const context = await start(runner, item);
      assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
      if (cause === 'mute') controls.muted = true;
      if (cause === 'send disable') controls.canSend = false;
      if (cause === 'scope revocation') controls.scopeCurrent = false;
      if (cause === 'scope invalidation') runner.invalidateSource(item.event.conversationKey);
      if (cause === 'retirement') assert.deepEqual(await runner.retire(binding, item.event.messageKey), { status: 'retired' });
      if (cause === 'retiring intent') {
        const { messageKey } = item.event;
        const claimed = binding.claim(messageKey);
        assert.equal(claimed.status, 'claimed');
        assert.equal(binding.updateTurn(messageKey, claimed.token, context.requestId, { state: 'retiring' }).status, 'updated');
        assert.equal(binding.release(messageKey, claimed.token).status, 'released');
      }
      assert.deepEqual(runner.invokeTextTool(call(context, { callId: 'fresh-call' })), { status: 'denied' });
      assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
      assert.deepEqual(sent, []);
    });
  }
});

test('rechecks the original private binding in SQLite for pending and completed turns', async (t) => {
  for (const stage of ['pending', 'completed']) {
    await t.test(stage, async (subtest) => {
      const { actor, enqueue, finish, hosted, inbox, start } = fixture(subtest);
      const runner = hosted();
      const item = enqueue({ privateChat: true });
      const context = await start(runner, item);
      assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
      if (stage === 'completed') {
        await finish(runner, item);
        assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'pending');
      }
      assert.equal(inbox.privateBindings.link([
        { conversation: item.event.conversation, actor, bindingRevision: null },
        { conversation: { ...FEISHU, chatType: 'private', chatId: 'oc_private' },
          actor: { ...FEISHU, userId: 'ou_fixture' }, bindingRevision: null },
      ]).status, 'linked');
      assert.deepEqual(runner.invokeTextTool(call(context, { callId: 'after-rebinding' })), { status: 'denied' });
      assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
    });
  }
});

test('denies new invokes when the source was forgotten and old outbox grants after a host restart', async (t) => {
  const { binding, enqueue, hosted, longMemory, sent, start } = fixture(t);
  const runner = hosted();
  const item = enqueue();
  const context = await start(runner, item);
  assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
  const [{ recordId }] = longMemory.archiveRows(item.event.conversationKey);
  assert.equal(binding.forgetRecord(item.event.conversationKey, recordId).status, 'forgotten');
  assert.deepEqual(runner.invokeTextTool(call(context, { callId: 'forgotten-call' })), { status: 'denied' });
  assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
  const other = await start(runner, enqueue({ threadId: '8' }));
  assert.deepEqual(runner.invokeTextTool(call(other)), { status: 'queued' });
  const restarted = hosted();
  assert.deepEqual(restarted.invokeTextTool(call(other)), { status: 'denied' });
  assert.equal((await restarted.deliverNextText(TELEGRAM)).status, 'cancelled');
  assert.deepEqual(sent, []);
});

test('forgetting the source permanently cancels queued output across normal and orphan completion', async (t) => {
  for (const completion of ['before forget', 'before archive tombstone', 'after forget as orphan']) {
    await t.test(completion, async (subtest) => {
      const { binding, enqueue, finish, finishOrphan, hosted, longMemory, sent, start } = fixture(subtest);
      const runner = hosted();
      const item = enqueue();
      const context = await start(runner, item);
      assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
      if (completion !== 'after forget as orphan') await finish(runner, item);
      const [{ recordId }] = longMemory.archiveRows(item.event.conversationKey);
      if (completion === 'before archive tombstone') {
        // Model a published tombstone with the inbox marker still present.
        assert.equal(longMemory.channelArchive.forget(item.event.conversationKey, recordId), item.event.messageKey);
      } else {
        assert.equal(binding.forgetRecord(item.event.conversationKey, recordId).status, 'forgotten');
      }
      if (completion === 'after forget as orphan') await finishOrphan(runner, item);
      assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
      assert.deepEqual(sent, []);
    });
  }
});

test('a published tombstone fences an active turn even if inbox cancellation was interrupted', async (t) => {
  const { enqueue, hosted, longMemory, sent, start } = fixture(t);
  const runner = hosted();
  const item = enqueue();
  const context = await start(runner, item);
  assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
  const [{ recordId }] = longMemory.archiveRows(item.event.conversationKey);
  assert.equal(longMemory.channelArchive.forget(item.event.conversationKey, recordId), item.event.messageKey);
  assert.deepEqual(runner.invokeTextTool(call(context, { callId: 'tombstoned-call' })), { status: 'denied' });
  assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
  assert.deepEqual(sent, []);
});

test('observed revocation cancels queued turns in the same session after policy is restored', async (t) => {
  for (const cause of ['send capability', 'actor policy']) {
    await t.test(cause, async (subtest) => {
      const { controls, enqueue, finish, hosted, policy, sent, start } = fixture(subtest);
      const runner = hosted();
      const earlier = enqueue();
      const prior = await start(runner, earlier);
      assert.deepEqual(runner.invokeTextTool(call(prior)), { status: 'queued' });
      await finish(runner, earlier);
      const item = enqueue();
      const context = await start(runner, item);
      assert.equal(context.sessionId, prior.sessionId);
      assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
      if (cause === 'send capability') controls.canSend = false;
      else policy.deny = { senders: ['42'] };
      assert.deepEqual(runner.invokeTextTool(call(context, { callId: 'revoked-call' })), { status: 'denied' });
      controls.canSend = true;
      policy.deny = {};
      await finish(runner, item);
      assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
      assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
      assert.deepEqual(sent, []);
      const next = await start(runner, enqueue());
      assert.equal(next.sessionId, context.sessionId);
      assert.deepEqual(runner.invokeTextTool(call(next)), { status: 'queued' });
    });
  }
});

test('revocation observed by the turn consumer cancels earlier queued replies after policy is restored', async (t) => {
  for (const stage of ['initial claim', 'lease recheck']) {
    await t.test(stage, async (subtest) => {
      const { binding, controls, enqueue, finish, hosted, policy, sent, start } = fixture(subtest);
      const runner = hosted();
      const prior = enqueue();
      const priorContext = await start(runner, prior);
      assert.deepEqual(runner.invokeTextTool(call(priorContext)), { status: 'queued' });
      await finish(runner, prior);

      const current = enqueue();
      const currentContext = await start(runner, current);
      assert.equal(currentContext.sessionId, priorContext.sessionId);
      const revoke = () => { policy.deny = { senders: ['42'] }; };
      if (stage === 'initial claim') revoke();
      else controls.onProjections = revoke;
      assert.deepEqual(await runner.run(binding, current.event.messageKey), { status: 'unauthorized' });
      assert.deepEqual(binding.pending(), []);
      controls.onProjections = null;
      policy.deny = {};
      assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
      assert.deepEqual(sent, []);
    });
  }
});

test('rechecks send permission after text segmentation and before the outbox commit', async (t) => {
  const { controls, enqueue, hosted, sent, start } = fixture(t);
  const runner = hosted();
  const context = await start(runner, enqueue());
  controls.onSplit = () => { controls.canSend = false; };
  assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'denied' });
  assert.equal(await runner.deliverNextText(TELEGRAM), null);
  assert.deepEqual(sent, []);
});

test('rechecks mute after reading the live inbound policy during delivery', async (t) => {
  const { controls, enqueue, hosted, sent, start } = fixture(t);
  const runner = hosted();
  const context = await start(runner, enqueue());
  assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'queued' });
  controls.onReadInboundPolicy = () => { controls.muted = true; };
  assert.equal((await runner.deliverNextText(TELEGRAM)).status, 'cancelled');
  assert.deepEqual(sent, []);
});

test('enabling send after dispatch cannot create a grant for an already-running turn', async (t) => {
  const { controls, enqueue, hosted, start } = fixture(t);
  const runner = hosted();
  controls.canSend = false;
  const context = await start(runner, enqueue());
  controls.canSend = true;
  assert.deepEqual(runner.invokeTextTool(call(context)), { status: 'denied' });
  assert.equal(await runner.deliverNextText(TELEGRAM), null);
});

test('retains the zero-tool default and refuses to dispatch a mismatched text preset', async (t) => {
  const { binding, controls, enqueue, hosted, sessions } = fixture(t);
  const zeroTool = hosted({ enabled: false });
  const defaultItem = enqueue({ threadId: '8' });
  assert.deepEqual(await zeroTool.run(binding, defaultItem.event.messageKey), { status: 'accepted' });
  assert.deepEqual([...sessions.values()], ['channel-chat-v2']);
  assert.equal(zeroTool.invokeTextTool, undefined);

  const textTool = hosted();
  controls.projectedPreset = 'channel-chat-v2';
  const item = enqueue();
  assert.deepEqual(await textTool.run(binding, item.event.messageKey), { status: 'session_unavailable' });
  assert.deepEqual([...sessions.values()], ['channel-chat-v2', PRESET]);
});
