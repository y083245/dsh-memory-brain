import { createHash, randomBytes } from 'node:crypto';
import { createChannelDshTransport } from './channel-dsh-transport.mjs';
import { decodeIdentityKey } from './identity.mjs';

const MODE = 'reserved2';
const PROMPT_PREFIX = 'Incoming channel message:\n';

function sessionPrefix(conversationKey) {
  const source = decodeIdentityKey(conversationKey);
  if (!conversationKey.startsWith('c1_') || source.platform === 'qq') throw new TypeError('Invalid channel conversation');
  return `cb1-${createHash('sha256').update(conversationKey).digest('hex').slice(0, 32)}-`;
}

// The trusted host creates a fresh ID for each generation of an original source.
export function createChannelSessionId(conversationKey) {
  return sessionPrefix(conversationKey) + randomBytes(16).toString('hex');
}

export function isChannelSessionId(conversationKey, sessionId) {
  if (typeof sessionId !== 'string') return false;
  try {
    const prefix = sessionPrefix(conversationKey);
    return sessionId.length === prefix.length + 32 && sessionId.startsWith(prefix) &&
      /^[0-9a-f]{32}$/.test(sessionId.slice(prefix.length));
  } catch {
    return false;
  }
}

function prepareSnapshot(prepared, conversationKey, bindingRevision) {
  if (!prepared) return null;
  const { sessionId, generation, mode, text } = prepared;
  if (prepared.conversationKey !== conversationKey || prepared.bindingRevision !== bindingRevision || mode !== MODE ||
      !Number.isSafeInteger(generation) || generation < 0 || typeof text !== 'string' || !text.trim() ||
      !isChannelSessionId(conversationKey, sessionId)) return null;
  return { snapshot: Object.freeze({ conversationKey, bindingRevision, sessionId, generation, mode }), text };
}

function currentSession(isCurrentSession, snapshot) {
  try {
    const current = isCurrentSession(snapshot);
    // A misconfigured async guard cannot authorize dispatch or leak a rejection.
    if (current instanceof Promise) void current.catch(() => {});
    return current === true;
  } catch {
    return false;
  }
}

function statusOnly({ status, reason }) {
  return status === 'retryableFailure' ? { status, reason } : { status };
}

function watchLease(binding, messageKey, token, now) {
  const controller = new AbortController();
  let timer;
  let failed;
  let closed = false;

  function stop(result) {
    failed = result;
    clearTimeout(timer);
    controller.abort();
    return result;
  }

  function check() {
    if (closed) return { status: 'stale_lease' };
    if (failed) return failed;
    const checked = binding.recheckLease(messageKey, token);
    return checked.status === 'ready' ? checked : stop(checked);
  }

  function schedule(expiresAt) {
    timer = setTimeout(() => {
      try {
        const renewed = binding.renew(messageKey, token);
        if (renewed.status !== 'renewed') stop(renewed);
        else if (check().status === 'ready') schedule(renewed.expiresAt);
      } catch {
        stop({ status: 'retryableFailure', reason: 'storage_unavailable' });
      }
    }, Math.max(1, Math.floor((expiresAt - now()) / 2)));
  }

  function close() {
    closed = true;
    clearTimeout(timer);
    binding.release(messageKey, token);
  }

  return { check, close, schedule, signal: controller.signal };
}

function matchesEvidence(turn, result) {
  if (!result || (result.requestId != null && result.requestId !== turn.requestId) ||
      (result.sessionId != null && result.sessionId !== turn.sessionId)) return false;
  const { turnId } = result;
  return turnId == null || (typeof turnId === 'string' && /^[1-9][0-9]*$/.test(turnId) &&
    String(Number(turnId)) === turnId && Number.isSafeInteger(Number(turnId)) &&
    (turn.turnId === null || turnId === turn.turnId));
}

async function transportResult(work) {
  try { return await work(); }
  catch { return null; }
}

/** A trusted host supplies a guarded DSH session and keeps its generation current. */
export function createChannelTurnRunner({ api, longMemory, rag, prepareTurn, isCurrentSession, invalidateSession,
  isSilent = () => false, maxConcurrent = 4, now = Date.now, transport = createChannelDshTransport(api) } = {}) {
  if (![prepareTurn, isCurrentSession, invalidateSession, isSilent, now, longMemory?.searchChannelHistory,
    transport?.submit, transport?.reconcile, transport?.retire].every((callback) => typeof callback === 'function')) {
    throw new TypeError('Invalid channel turn runner callbacks');
  }
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('Invalid channel turn concurrency');

  let active = 0;
  async function bounded(work) {
    if (active >= maxConcurrent) return { status: 'busy' };
    active++;
    try { return statusOnly(await work()); }
    finally { active--; }
  }

  async function withProjectedTask(binding, messageKey, work) {
    const claimed = binding.claim(messageKey);
    if (claimed.status !== 'claimed') return claimed;
    const { token } = claimed;
    const lease = watchLease(binding, messageKey, token, now);
    try {
      const journal = binding.readTurn(messageKey, token);
      if (journal.status !== 'turn' && journal.status !== 'no_turn') return journal;
      const projected = binding.project(messageKey, token);
      if (projected.status !== 'projected') return projected;
      const checked = lease.check();
      if (checked.status !== 'ready') return checked;
      lease.schedule(checked.expiresAt);
      return await work({ token, lease, checked, turn: journal.turn && Object.freeze(journal.turn) });
    } finally {
      lease.close();
    }
  }

  function recordEvidence(binding, messageKey, token, turn, result, recovery) {
    const { status, turnId } = result ?? {};
    const matched = matchesEvidence(turn, result);
    if (matched && status === 'not_submitted' && turn.state === 'submitting' && turn.turnId === null && turnId == null) {
      return binding.updateTurn(messageKey, token, turn.requestId, { state: 'retry' });
    }
    if (recovery && matched && status === 'completed' && turnId != null) {
      return binding.finishTurn(messageKey, token, turn.requestId, { state: 'completed', turnId });
    }
    const confirmed = matched && (status === 'accepted' || (recovery && status === 'pending'));
    const state = confirmed ? 'accepted' : 'uncertain';
    const saved = binding.updateTurn(messageKey, token, turn.requestId, { state, turnId: confirmed ? turnId : undefined });
    return saved.status === 'updated' ? { status: confirmed ? status : 'uncertain' } : saved;
  }

  async function submit(binding, messageKey, { token, lease, checked }) {
    const { task, recordId } = checked;
    const { taskId, bindingRevision, event: { conversationKey } } = task;
    function requireLease() {
      if (lease.check().status !== 'ready') throw new DOMException('Channel lease unavailable', 'AbortError');
    }
    async function searchHistory(options) {
      requireLease();
      const result = await longMemory.searchChannelHistory(conversationKey, options, { rag });
      requireLease();
      return result;
    }

    let value;
    let prepared;
    try {
      value = await prepareTurn({ task, recordId, searchHistory, signal: lease.signal });
      prepared = prepareSnapshot(value, conversationKey, bindingRevision);
    } catch {
      const latest = lease.check();
      return latest.status === 'ready' ? { status: 'preparation_failed' } : latest;
    }

    const latest = lease.check();
    if (latest.status !== 'ready') return latest;
    const finishSilent = () => {
      const result = binding.finish(messageKey, token);
      return result.status === 'completed' ? { status: 'silent' } : result;
    };
    if (value?.status === 'silent') return finishSilent();
    if (!prepared) return { status: 'session_unavailable' };
    const { snapshot, text } = prepared;
    const blocks = [{ type: 'text', text: PROMPT_PREFIX + text }];
    // beginTurn rechecks authorization and the archive atomically. Dispatch in
    // the same synchronous segment as the host guard and journal commit.
    if (!currentSession(isCurrentSession, snapshot)) return { status: 'stale_session' };
    try {
      const silent = isSilent();
      if (silent instanceof Promise) void silent.catch(() => {});
      if (silent === true) return finishSilent();
      if (silent !== false) return { status: 'preparation_failed' };
    } catch {
      return { status: 'preparation_failed' };
    }
    const started = binding.beginTurn(messageKey, token, {
      sessionId: snapshot.sessionId, generation: snapshot.generation, requestId: taskId, maxActiveTurns: maxConcurrent,
    });
    if (started.status !== 'started') return started;
    const turn = Object.freeze(started.turn);
    const result = await transportResult(() => transport.submit(turn, blocks, { signal: lease.signal }));
    const stillReady = lease.check();
    if (stillReady.status !== 'ready') return stillReady;
    return recordEvidence(binding, messageKey, token, turn, result, false);
  }

  async function reconcile(binding, messageKey, { token, lease, turn }) {
    const result = await transportResult(() => transport.reconcile(turn, { signal: lease.signal }));
    const latest = lease.check();
    if (latest.status !== 'ready') return latest;
    return recordEvidence(binding, messageKey, token, turn, result, true);
  }

  async function retireTurn(turn, signal, check, finish) {
    const invalidated = await transportResult(() => invalidateSession(turn, { signal }));
    const latest = check();
    if (latest.status !== 'ready') return latest;
    if (invalidated !== true) return { status: 'retirement_unconfirmed' };
    const result = await transportResult(() => transport.retire(turn, { signal }));
    const stillReady = check();
    if (stillReady.status !== 'ready') return stillReady;
    if (result?.status !== 'retired' || !matchesEvidence(turn, result)) return { status: 'retirement_unconfirmed' };
    return finish({ state: 'retired' });
  }

  return {
    run: (binding, messageKey) => bounded(() => withProjectedTask(binding, messageKey, (context) => {
      if (context.turn?.state === 'retiring') return { status: 'retirement_unconfirmed' };
      if (context.turn) return reconcile(binding, messageKey, context);
      if (context.checked.task.decision === 'observe') {
        const result = binding.finish(messageKey, context.token);
        return result.status === 'completed' ? { status: 'observed' } : result;
      }
      if (context.checked.task.decision !== 'directed') return { status: 'not_directed' };
      return submit(binding, messageKey, context);
    })),
    retire: (binding, messageKey) => bounded(() => withProjectedTask(binding, messageKey, ({ turn, token, lease }) => {
      if (!turn) return { status: 'no_turn' };
      const reserved = binding.updateTurn(messageKey, token, turn.requestId, { state: 'retiring' });
      if (reserved.status !== 'updated') return reserved;
      return retireTurn(Object.freeze(reserved.turn), lease.signal, lease.check,
        (evidence) => binding.finishTurn(messageKey, token, turn.requestId, evidence));
    })),
    reconcileOrphan: (binding, requestId, { retire: shouldRetire = false } = {}) => bounded(async () => {
      if (typeof requestId !== 'string') return { status: 'not_pending' };
      const persisted = shouldRetire === true ? binding.beginOrphanedRetirement(requestId) : binding.readOrphanedTurn(requestId);
      if (persisted.status === 'no_turn') return { status: 'not_pending' };
      if (persisted.status !== 'turn') return persisted;
      const turn = Object.freeze(persisted.turn);
      const { signal } = new AbortController();
      const finish = (evidence) => binding.finishOrphanedTurn(turn.requestId, evidence);
      if (shouldRetire === true) {
        function check() {
          const latest = binding.readOrphanedTurn(requestId);
          if (latest.status === 'no_turn') return { status: 'not_pending' };
          return latest.status === 'turn' ? { status: 'ready' } : latest;
        }
        return retireTurn(turn, signal, check, finish);
      }
      if (turn.state === 'retiring') return { status: 'retirement_unconfirmed' };
      const result = await transportResult(() => transport.reconcile(turn, { signal }));
      const { status, turnId } = result ?? {};
      if (matchesEvidence(turn, result)) {
        if (status === 'completed' && turnId != null) return finish({ state: 'completed', turnId });
        if (status === 'pending' || status === 'accepted') {
          if (turnId == null) return { status };
          const saved = binding.updateOrphanedTurn(requestId, { state: 'accepted', turnId });
          return saved.status === 'updated' ? { status } : saved;
        }
      }
      return { status: 'uncertain' };
    }),
  };
}
