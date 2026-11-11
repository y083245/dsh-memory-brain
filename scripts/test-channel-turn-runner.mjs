import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { createChannelSessionId, createChannelTurnRunner } from '../src/core/channel-turn-runner.mjs';
import { encodeConversationKey } from '../src/core/identity.mjs';
import { createLongMemory } from '../src/long-memory.js';

const FEISHU = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const TELEGRAM = { platform: 'telegram', accountId: '41' };

function endpoint(account, { privateChat = false, threadId = null } = {}) {
  const feishu = account.platform === 'feishu';
  return {
    actor: { ...account, userId: feishu ? 'ou_fixture' : '42' },
    conversation: {
      ...account, threadId, chatType: privateChat ? 'private' : 'group',
      chatId: feishu ? (privateChat ? 'oc_direct' : 'oc_fixture') : (privateChat ? '42' : '-100123'),
    },
  };
}

function fixture(t, { now = Date.now, leaseMs, archive } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-runner-'));
  const longMemory = createLongMemory({ stateDir: dir });
  let store;
  function reopen() {
    store?.close();
    store = openChannelInbox(join(dir, 'inbox.sqlite'), { now, leaseMs, archive: archive ?? longMemory.channelArchive });
  }
  reopen();
  t.after(() => {
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  let id = 0;
  function enqueue(account = FEISHU, options = {}) {
    const ref = endpoint(account, options);
    const { actor, conversation } = ref;
    const { text = 'fixture message', trigger = 'directed' } = options;
    const policy = {
      ...account, enabled: true, groupPolicy: 'observe', observationVerified: true,
      allow: { groups: conversation.chatType === 'group' ? [conversation.chatId] : [],
        senders: [actor.userId], private: [actor.userId] },
    };
    const bind = () => store.bind(account, () => policy);
    const binding = bind();
    const feishu = account.platform === 'feishu';
    const deliveryRef = feishu ? `evt_${++id}` : String(++id);
    const event = {
      ...ref, kind: 'message', senderType: 'human', trigger, deliveryRef, text, occurredAt: Date.UTC(2026, 10, 1),
      message: { conversation, platformChatId: conversation.chatId, messageId: feishu ? `om_${id}` : String(id) },
    };
    if (feishu) assert.equal(binding.accept(event).status, 'durableAccepted');
    else {
      const poller = binding.startPolling();
      assert.equal(poller.acceptBatch([event], poller.readCheckpoint()).results[0].status, 'durableAccepted');
    }
    const task = binding.pending().find((item) => item.event.deliveryRef === deliveryRef);
    return { bind, binding, key: task.event.conversationKey, messageKey: task.event.messageKey, policy, taskId: task.taskId };
  }

  function runner(overrides = {}) {
    const { transport, ...host } = overrides;
    return createChannelTurnRunner({
      longMemory, now, prepareTurn: ({ task }) => prepared(task), isCurrentSession: () => true,
      invalidateSession: async () => true, ...host,
      transport: {
        submit: async () => ({ status: 'accepted' }),
        reconcile: async () => ({ status: 'unknown' }),
        retire: async () => ({ status: 'unknown' }),
        ...transport,
      },
    });
  }

  function linkPrivate() {
    assert.equal(store.privateBindings.link([FEISHU, TELEGRAM].map((account) => ({
      ...endpoint(account, { privateChat: true }), bindingRevision: null,
    }))).status, 'linked');
  }

  return { enqueue, reopen, runner, longMemory, linkPrivate };
}

function prepared(task) {
  return {
    sessionId: createChannelSessionId(task.event.conversationKey), generation: 1,
    conversationKey: task.event.conversationKey, bindingRevision: task.bindingRevision,
    mode: 'reserved2', text: task.event.text,
  };
}

function withClaimed(item, work) {
  const { status, token } = item.binding.claim(item.messageKey);
  assert.equal(status, 'claimed');
  try { return work(item.binding, item.messageKey, token); }
  finally { item.binding.release(item.messageKey, token); }
}

function persistSubmitting(item) {
  return withClaimed(item, (binding, messageKey, token) => {
    assert.equal(binding.project(messageKey, token).status, 'projected');
    const started = binding.beginTurn(messageKey, token, {
      sessionId: createChannelSessionId(item.key), generation: 1, requestId: item.taskId,
    });
    assert.equal(started.status, 'started');
    return started.turn;
  });
}

test('observations project to long memory and finish without preparing a DSH turn', async (t) => {
  const { enqueue, runner, longMemory } = fixture(t);
  const item = enqueue(FEISHU, { trigger: 'ambient' });
  let prepared = 0;
  let rpc = 0;
  const consumer = runner({ prepareTurn: () => { prepared++; }, transport: { submit: () => { rpc++; } } });
  assert.deepEqual(await consumer.run(item.binding, item.messageKey), { status: 'observed' });
  assert.equal(longMemory.archiveRows(item.key)[0].text, 'fixture message');
  assert.deepEqual(item.binding.pending(), []);
  assert.equal(prepared, 0);
  assert.equal(rpc, 0);
});

test('a directed turn is journaled before RPC and slash-prefixed chat reaches DSH as plain text', async (t) => {
  const { enqueue, runner, longMemory } = fixture(t);
  const item = enqueue(TELEGRAM, { text: '/quit fixture message' });
  let submitted;
  let current;
  const consumer = runner({
    isCurrentSession: (snapshot) => { current = snapshot; return true; },
    transport: { submit: async (turn, blocks) => {
      submitted = { turn, blocks, rows: longMemory.archiveRows(item.key) };
      return { status: 'accepted', output: 'must stay internal' };
    } },
  });
  assert.deepEqual(await consumer.run(item.binding, item.messageKey), { status: 'accepted' });
  assert.equal(current.mode, 'reserved2');
  assert.equal(current.conversationKey, item.key);
  assert.equal(current.bindingRevision, null);
  assert.equal(current.generation, 1);
  assert.equal(current.sessionId, submitted.turn.sessionId);
  assert.equal(submitted.turn.requestId, item.taskId);
  assert.equal(submitted.turn.state, 'submitting');
  assert.equal(submitted.rows[0].text, '/quit fixture message');
  assert.deepEqual(submitted.blocks.map((block) => block.type), ['text']);
  assert.match(submitted.blocks[0].text, /^[^/\s].*\n\/quit fixture message$/);
  assert.equal(item.binding.pending().length, 1);
});

test('rechecking after an awaited preparation catches account revocation before dispatch', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  let rpc = 0;
  const consumer = runner({
    prepareTurn: async ({ task }) => {
      await Promise.resolve();
      item.policy.enabled = false;
      return prepared(task);
    },
    transport: { submit: () => { rpc++; } },
  });
  assert.deepEqual(await consumer.run(item.binding, item.messageKey), { status: 'unauthorized' });
  assert.equal(rpc, 0);
  assert.deepEqual(item.binding.pending(), []);
});

test('missing safe capabilities and asynchronously stale session guards leave a task pending', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  let rpc = 0;
  const transport = { submit: () => { rpc++; } };
  const unavailable = runner({ transport, prepareTurn: async () => null });
  assert.equal((await unavailable.run(item.binding, item.messageKey)).status, 'session_unavailable');
  const asyncGuard = runner({ transport, isCurrentSession: async () => true });
  assert.equal((await asyncGuard.run(item.binding, item.messageKey)).status, 'stale_session');
  const stale = runner({ transport, isCurrentSession: () => false });
  assert.equal((await stale.run(item.binding, item.messageKey)).status, 'stale_session');
  assert.equal(rpc, 0);
  assert.equal(item.binding.pending().length, 1);
});

test('DSH session identifiers bind to canonical sources and preparation rejects crossed metadata', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  const other = enqueue({ ...FEISHU, tenantId: 'tenant_b' });
  const sessionId = createChannelSessionId(item.key);
  assert.match(sessionId, /^cb1-[a-f0-9]{32}-[a-f0-9]{32}$/);
  assert.notEqual(sessionId, createChannelSessionId(item.key));
  assert.throws(() => createChannelSessionId(item.messageKey), TypeError);
  assert.throws(() => createChannelSessionId(encodeConversationKey({ platform: 'qq', accountId: '1', chatType: 'group', chatId: '2' })), TypeError);
  let rpc = 0;
  for (const changes of [
    { sessionId: createChannelSessionId(other.key) }, { sessionId: `${sessionId}\n` },
    { conversationKey: other.key }, { bindingRevision: 'stale' }, { mode: 'closed-agent' }, { generation: undefined },
  ]) {
    const consumer = runner({ prepareTurn: ({ task }) => ({ ...prepared(task), ...changes }),
      transport: { submit: () => { rpc++; } } });
    assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'session_unavailable');
  }
  assert.equal(rpc, 0);
  assert.equal(item.binding.pending().length, 1);
});

test('history search keeps the task source even when options request a different source', async (t) => {
  const { enqueue, runner } = fixture(t);
  const other = enqueue(FEISHU, { threadId: '8', trigger: 'ambient', text: 'fixture topic other-source' });
  const item = enqueue(FEISHU, { threadId: '7', text: 'fixture topic only-this-source' });
  let history;
  const consumer = runner({ prepareTurn: async ({ task, searchHistory }) => {
    history = await searchHistory({ key: other.key, query: 'fixture topic' });
    return prepared(task);
  } });
  assert.equal((await consumer.run(other.binding, other.messageKey)).status, 'observed');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'accepted');
  assert.match(history.result.lines.join(''), /only-this-source/);
  assert.doesNotMatch(history.result.lines.join(''), /other-source/);
});

test('history data is withheld if the source loses authorization while the query is in flight', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  let rpc = 0;
  let rejected = false;
  let queryKey;
  const consumer = runner({
    rag: { search: async ({ key }) => {
      queryKey = key;
      item.policy.enabled = false;
      return { semantic: 'ok', items: [{ text: 'sensitive fixture data' }] };
    } },
    prepareTurn: async ({ task, searchHistory }) => {
      await assert.rejects(searchHistory({ query: 'fixture' }), { name: 'AbortError' });
      rejected = true;
      return prepared(task);
    },
    transport: { submit: () => { rpc++; } },
  });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'unauthorized');
  assert.equal(queryKey, item.key);
  assert.equal(rejected, true);
  assert.equal(rpc, 0);
});

test('a lost response and restart only reconcile the original session until exact completion', async (t) => {
  const { enqueue, runner, reopen, longMemory } = fixture(t);
  const item = enqueue();
  let original;
  const first = runner({ transport: { submit: async (turn) => {
    original = turn;
    throw new Error('RPC response lost');
  } } });
  assert.deepEqual(await first.run(item.binding, item.messageKey), { status: 'uncertain' });
  assert.equal(withClaimed(item, (binding, key, token) => binding.readTurn(key, token)).turn.state, 'uncertain');

  reopen();
  const binding = item.bind();
  let result = { status: 'pending', turnId: '17' };
  let preparedAgain = 0;
  let resubmitted = 0;
  const seen = [];
  const restarted = runner({ prepareTurn: () => { preparedAgain++; }, transport: {
    submit: () => { resubmitted++; },
    reconcile: async (turn) => { seen.push(turn); return result; },
  } });
  assert.equal((await restarted.run(binding, item.messageKey)).status, 'pending');
  result = { status: 'completed', turnId: '19' };
  assert.equal((await restarted.run(binding, item.messageKey)).status, 'uncertain');
  assert.equal(binding.pending().length, 1);
  result = { status: 'completed', turnId: '17', output: 'internal-only content' };
  assert.deepEqual(await restarted.run(binding, item.messageKey), { status: 'completed' });
  assert.deepEqual(binding.pending(), []);
  assert.equal(preparedAgain, 0);
  assert.equal(resubmitted, 0);
  assert.deepEqual(seen.map(({ requestId, sessionId }) => [requestId, sessionId]), Array(3).fill([original.requestId, original.sessionId]));
  assert.equal(longMemory.archiveRows(item.key).length, 1);
});

test('an explicit non-submission allows the same request ID to retry only from submitting', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  const original = persistSubmitting(item);
  const requests = [];
  const consumer = runner({ transport: {
    submit: async (turn) => { requests.push(turn.requestId); return { status: 'accepted' }; },
    reconcile: async () => ({ status: 'not_submitted' }),
  } });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'retry_ready');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'accepted');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'uncertain');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'uncertain');
  assert.deepEqual(requests, [original.requestId]);
});

test('a failed reconciliation persists uncertainty without preparing another session', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  const original = persistSubmitting(item);
  let attempts = 0;
  const consumer = runner({ transport: { reconcile: async (turn) => {
    assert.equal(turn.sessionId, original.sessionId);
    if (attempts++ === 0) throw new Error('carrier unavailable');
    return { status: 'not_submitted' };
  } } });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'uncertain');
  assert.equal(withClaimed(item, (binding, key, token) => binding.readTurn(key, token)).turn.state, 'uncertain');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'uncertain');
});

test('a single concurrency cap spans bindings while SQLite holds cross-platform dialogue order', async (t) => {
  const { enqueue, runner, linkPrivate } = fixture(t);
  linkPrivate();
  const first = enqueue(FEISHU, { privateChat: true });
  const next = enqueue(TELEGRAM, { privateChat: true });
  const independent = enqueue(TELEGRAM);
  const saturated = enqueue({ ...FEISHU, tenantId: 'tenant_b' });
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const consumer = runner({ maxConcurrent: 2, prepareTurn: async ({ task }) => {
    if (task.taskId === first.taskId) {
      entered.resolve();
      await resume.promise;
    }
    return prepared(task);
  }, transport: { reconcile: async () => ({ status: 'completed', turnId: '17' }) } });
  const active = consumer.run(first.binding, first.messageKey);
  await entered.promise;
  assert.equal((await consumer.run(next.binding, next.messageKey)).status, 'out_of_order');
  const unrelated = consumer.run(independent.binding, independent.messageKey);
  assert.equal((await consumer.run(saturated.binding, saturated.messageKey)).status, 'busy');
  resume.resolve();
  assert.equal((await active).status, 'accepted');
  assert.equal((await unrelated).status, 'accepted');
  assert.equal((await consumer.run(next.binding, next.messageKey)).status, 'out_of_order');
  assert.equal((await consumer.run(first.binding, first.messageKey)).status, 'completed');
  assert.equal((await consumer.run(next.binding, next.messageKey)).status, 'accepted');
});

test('the concurrency cap holds across accepted DSH work and releases after exact completion', async (t) => {
  const { enqueue, runner } = fixture(t);
  const first = enqueue();
  const other = enqueue(TELEGRAM);
  const submitted = [];
  const consumer = runner({ maxConcurrent: 1, transport: {
    submit: async (turn) => { submitted.push(turn.requestId); return { status: 'accepted' }; },
    reconcile: async () => ({ status: 'completed', turnId: '17' }),
  } });
  assert.equal((await consumer.run(first.binding, first.messageKey)).status, 'accepted');
  assert.deepEqual(await consumer.run(other.binding, other.messageKey), { status: 'turn_capacity' });
  assert.deepEqual(submitted, [first.taskId]);
  assert.equal((await consumer.run(first.binding, first.messageKey)).status, 'completed');
  assert.equal((await consumer.run(other.binding, other.messageKey)).status, 'accepted');
  assert.deepEqual(submitted, [first.taskId, other.taskId]);
});

test('an explicit initial refusal before submission frees the intent for the same request ID', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  const requests = [];
  const consumer = runner({ transport: { submit: async (turn) => {
    requests.push(turn.requestId);
    return { status: requests.length === 1 ? 'not_submitted' : 'accepted' };
  } } });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'retry_ready');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'accepted');
  assert.deepEqual(requests, [item.taskId, item.taskId]);
});

test('evidence of a queued request without a turn ID bars resubmission', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  persistSubmitting(item);
  let evidence = { status: 'pending' };
  let attempts = 0;
  const consumer = runner({ transport: {
    submit: () => { attempts++; throw new Error('response lost'); },
    reconcile: async () => evidence,
  } });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'pending');
  evidence = { status: 'not_submitted' };
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'uncertain');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'uncertain');
  assert.equal(attempts, 0);
});

test('lease heartbeat holds the task during preparation and aborts if policy is revoked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { enqueue, runner } = fixture(t, { leaseMs: 100 });
  const item = enqueue();
  const entered = Promise.withResolvers();
  let rpc = 0;
  const consumer = runner({ prepareTurn: async ({ task, signal }) => {
    const aborted = Promise.withResolvers();
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    entered.resolve(signal);
    await aborted.promise;
    return prepared(task);
  }, transport: { submit: () => { rpc++; } } });
  const active = consumer.run(item.binding, item.messageKey);
  const signal = await entered.promise;
  t.mock.timers.tick(50);
  t.mock.timers.tick(50);
  assert.equal(item.binding.claim(item.messageKey).status, 'busy');
  assert.equal(signal.aborted, false);
  item.policy.enabled = false;
  t.mock.timers.tick(50);
  assert.equal((await active).status, 'unauthorized');
  assert.equal(signal.aborted, true);
  assert.equal(rpc, 0);
});

test('explicit retirement requires invalidation before retiring the original session', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  let enabled = false;
  let retireStatus = 'unknown';
  let sessionId;
  const events = [];
  const consumer = runner({
    invalidateSession: async (turn) => { events.push(['invalidate', turn.sessionId]); return enabled; },
    transport: {
      submit: async (turn) => { sessionId = turn.sessionId; return { status: 'accepted' }; },
      retire: async (turn) => { events.push(['retire', turn.sessionId]); return { status: retireStatus }; },
    },
  });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'accepted');
  assert.equal((await consumer.retire(item.binding, item.messageKey)).status, 'retirement_unconfirmed');
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'retirement_unconfirmed');
  assert.deepEqual(events, [['invalidate', sessionId]]);
  enabled = true;
  assert.equal((await consumer.retire(item.binding, item.messageKey)).status, 'retirement_unconfirmed');
  assert.equal(item.binding.pending().length, 1);
  retireStatus = 'retired';
  assert.deepEqual(await consumer.retire(item.binding, item.messageKey), { status: 'retired' });
  assert.deepEqual(item.binding.pending(), []);
  assert.deepEqual(events, [['invalidate', sessionId], ['invalidate', sessionId], ['retire', sessionId],
    ['invalidate', sessionId], ['retire', sessionId]]);
});

test('orphan recovery uses the saved turn in the same account and releases blocked source work', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  const other = enqueue({ ...FEISHU, tenantId: 'tenant_b' });
  let original;
  let evidence = { status: 'completed' };
  const reconciled = [];
  const consumer = runner({ transport: {
    submit: async (turn) => { original = turn; return { status: 'accepted' }; },
    reconcile: async (turn) => { reconciled.push(turn); return evidence; },
  } });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'accepted');
  item.policy.enabled = false;
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'unauthorized');
  assert.equal(item.binding.pending().length, 0);
  const next = enqueue();
  assert.deepEqual(await consumer.run(next.binding, next.messageKey), { status: 'blocked_turn' });
  assert.equal((await consumer.reconcileOrphan(other.binding, item.taskId)).status, 'not_pending');
  assert.equal((await consumer.reconcileOrphan(item.binding, { requestId: item.taskId, sessionId: 'fake' })).status, 'not_pending');
  assert.deepEqual(reconciled, []);
  assert.deepEqual(await consumer.reconcileOrphan(item.binding, item.taskId), { status: 'uncertain' });
  assert.equal(item.binding.orphanedTurns()[0].requestId, item.taskId);
  evidence = { status: 'pending', turnId: '17' };
  assert.deepEqual(await consumer.reconcileOrphan(item.binding, item.taskId), { status: 'pending' });
  assert.equal(item.binding.orphanedTurns()[0].turnId, '17');
  evidence = { status: 'completed', turnId: '19' };
  assert.deepEqual(await consumer.reconcileOrphan(item.binding, item.taskId), { status: 'uncertain' });
  evidence = { status: 'completed', turnId: '17' };
  assert.deepEqual(await consumer.reconcileOrphan(item.binding, item.taskId), { status: 'completed' });
  assert.equal(reconciled[0].sessionId, original.sessionId);
  assert.equal(reconciled[0].requestId, original.requestId);
  assert.deepEqual(item.binding.orphanedTurns(), []);
  assert.equal((await consumer.run(next.binding, next.messageKey)).status, 'accepted');
});

test('orphan retirement reserves capacity before invalidation and fences concurrent completion', async (t) => {
  const { enqueue, runner } = fixture(t);
  const item = enqueue();
  const unrelated = enqueue(TELEGRAM);
  const reconciling = Promise.withResolvers();
  const completing = Promise.withResolvers();
  const invalidating = Promise.withResolvers();
  const invalidated = Promise.withResolvers();
  const consumer = runner({ maxConcurrent: 1, transport: {
    reconcile: async () => { reconciling.resolve(); return completing.promise; },
  } });
  const manager = runner({ maxConcurrent: 1, invalidateSession: async (turn) => {
    invalidating.resolve(turn);
    return invalidated.promise;
  }, transport: { retire: async () => ({ status: 'retired' }) } });
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'accepted');
  item.policy.enabled = false;
  assert.equal((await consumer.run(item.binding, item.messageKey)).status, 'unauthorized');
  const reconcilingOld = consumer.reconcileOrphan(item.binding, item.taskId);
  await reconciling.promise;
  const retirement = manager.reconcileOrphan(item.binding, item.taskId, { retire: true });
  assert.equal((await invalidating.promise).state, 'retiring');
  completing.resolve({ status: 'completed', turnId: '17' });
  assert.equal((await reconcilingOld).status, 'turn_conflict');
  assert.equal((await consumer.reconcileOrphan(item.binding, item.taskId)).status, 'retirement_unconfirmed');
  assert.equal((await consumer.run(unrelated.binding, unrelated.messageKey)).status, 'turn_capacity');
  invalidated.resolve(true);
  assert.equal((await retirement).status, 'retired');
  assert.equal((await consumer.run(unrelated.binding, unrelated.messageKey)).status, 'accepted');
});

test('archive failure leaves a task pending and prevents preparation and DSH work', async (t) => {
  const unavailable = Object.assign(new Error('fixture storage failure'), { code: 'ERR_CHANNEL_ARCHIVE' });
  const { enqueue, runner } = fixture(t, { archive: { position: () => { throw unavailable; } } });
  const item = enqueue();
  let prepare = 0;
  const consumer = runner({ prepareTurn: () => { prepare++; } });
  assert.deepEqual(await consumer.run(item.binding, item.messageKey), { status: 'retryableFailure', reason: 'archive_unavailable' });
  assert.equal(prepare, 0);
  assert.equal(item.binding.pending().length, 1);
});
