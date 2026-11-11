import { isAbsolute } from 'node:path';
import { unwrap } from '../dsh-client.js';
import { CHANNEL_DSH_PRESET, confirmChannelPreset } from './channel-dsh-preset.mjs';
import { createChannelSessionId, createChannelTurnRunner, isChannelSessionId } from './channel-turn-runner.mjs';
import { createChannelTurnPrompt } from './channel-turn-prompt.mjs';
import { decodeIdentityKey } from './identity.mjs';

const MODE = 'reserved2';

function validScope({ conversationKey, bindingRevision } = {}) {
  if (typeof conversationKey !== 'string' || !conversationKey.startsWith('c1_') ||
      (bindingRevision !== null && (typeof bindingRevision !== 'string' || !bindingRevision))) return false;
  try {
    return decodeIdentityKey(conversationKey).platform !== 'qq';
  } catch {
    return false;
  }
}

function validOriginalSession(turn) {
  return !!turn && validScope(turn) && Number.isSafeInteger(turn.generation) && turn.generation >= 0 &&
    isChannelSessionId(turn.conversationKey, turn.sessionId);
}

/**
 * Keep trusted dispatch grants in the bridge process. DSH journals remain the
 * authority for recovery and can retire an original session after a restart.
 */
export function createChannelTurnHost({
  api, workspacePath, confirmGuard = (_snapshot, options) => confirmChannelPreset(api, options), buildPrompt, isScopeCurrent,
} = {}) {
  if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath) ||
      ![api?.workspace?.create, api?.sessions?.create, confirmGuard, buildPrompt, isScopeCurrent]
        .every((callback) => typeof callback === 'function')) {
    throw new TypeError('Invalid channel turn host configuration');
  }

  const sessions = new Map();
  let generation = 0;

  function scopeCurrent(scope) {
    const entry = sessions.get(scope.conversationKey);
    try {
      const result = isScopeCurrent(scope);
      if (result instanceof Promise) void result.catch(() => {});
      if (result === true) return true;
    } catch {
      // Unavailable policy cannot preserve a dispatch grant.
    }
    if (entry && entry.snapshot.bindingRevision === scope.bindingRevision &&
        sessions.get(scope.conversationKey) === entry) sessions.delete(scope.conversationKey);
    return false;
  }

  function isCurrentSession(snapshot) {
    const entry = sessions.get(snapshot?.conversationKey);
    return !!entry?.ready && snapshot.mode === MODE && entry.snapshot.sessionId === snapshot.sessionId &&
      entry.snapshot.generation === snapshot.generation && entry.snapshot.bindingRevision === snapshot.bindingRevision &&
      scopeCurrent(entry.snapshot) && sessions.get(snapshot.conversationKey) === entry;
  }

  function invalidateSession(turn) {
    if (!validOriginalSession(turn)) return false;
    const entry = sessions.get(turn.conversationKey);
    if (entry?.snapshot.sessionId !== turn.sessionId) return true;
    if (entry.snapshot.generation !== turn.generation || entry.snapshot.bindingRevision !== turn.bindingRevision) return false;
    sessions.delete(turn.conversationKey);
    return true;
  }

  async function ensureSession(entry, signal) {
    const { snapshot } = entry;
    const { conversationKey, sessionId } = snapshot;
    const stillCurrent = () => !signal?.aborted && sessions.get(conversationKey) === entry &&
      scopeCurrent(snapshot) && sessions.get(conversationKey) === entry;
    let knownCreated = false;
    try {
      if (!stillCurrent()) return false;
      if (entry.ready) return await confirmGuard(snapshot, { signal, sessionId }) === true && stillCurrent();
      if (await confirmGuard(snapshot, { signal }) !== true || !stillCurrent()) return false;

      const ws = unwrap(await api.workspace.create({ path: workspacePath }, signal), 'workspace.create');
      const workspaceId = ws?.workspace?.workspaceId;
      if (!stillCurrent() || typeof workspaceId !== 'string' || !workspaceId.trim()) return false;
      const created = unwrap(await api.sessions.create({
        workspaceId, agentPreset: CHANNEL_DSH_PRESET, sessionId,
      }, signal), 'session.create');
      knownCreated = created?.sessionId === sessionId;
      if (!knownCreated || !stillCurrent() || created.agentPreset !== CHANNEL_DSH_PRESET) return false;
      if (await confirmGuard(snapshot, { signal, sessionId }) !== true || !stillCurrent()) return false;
      entry.ready = true;
      return true;
    } catch {
      return false;
    } finally {
      // A confirmed create with no published grant has never been prompted.
      // A lost create response can leave an inert session for manual cleanup.
      if (knownCreated && !entry.ready) {
        try {
          await api.workspace.archiveSession?.({ sessionId }, AbortSignal.timeout(2_000));
        } catch {
          // A failed cleanup must not publish the grant.
        }
      }
    }
  }

  async function prepareTurn(context) {
    const { task, signal } = context ?? {};
    const scope = { conversationKey: task?.event?.conversationKey, bindingRevision: task?.bindingRevision };
    if (signal?.aborted || !validScope(scope) || !scopeCurrent(scope)) return null;
    const { conversationKey, bindingRevision } = scope;
    let entry = sessions.get(conversationKey);
    if (!entry || entry.snapshot.bindingRevision !== bindingRevision) {
      const snapshot = Object.freeze({
        ...scope, sessionId: createChannelSessionId(conversationKey), generation: ++generation, mode: MODE,
      });
      entry = { snapshot, ready: false, checking: null };
      sessions.set(conversationKey, entry);
    }
    try {
      const text = await buildPrompt(context);
      if (signal?.aborted || sessions.get(conversationKey) !== entry || !scopeCurrent(scope)) return null;
      if (text?.status === 'silent') return { status: 'silent' };
      if (typeof text !== 'string' || !text.trim()) return null;
      if (!entry.checking) {
        const check = ensureSession(entry, signal);
        entry.checking = check.finally(() => { entry.checking = null; });
      }
      if (!await entry.checking) {
        if (sessions.get(conversationKey) === entry) sessions.delete(conversationKey);
        return null;
      }
      if (signal?.aborted || !isCurrentSession(entry.snapshot)) return null;
      return { ...entry.snapshot, text };
    } finally {
      if (!entry.ready && !entry.checking && sessions.get(conversationKey) === entry) sessions.delete(conversationKey);
    }
  }

  // Trusted lifecycle callers use this when policy changes between runs, so
  // disabling and re-enabling a source cannot restore its previous grant.
  const invalidateSource = (conversationKey) => sessions.delete(conversationKey);
  return { prepareTurn, isCurrentSession, invalidateSession, invalidateSource };
}

/** Bridge composition for adapter bindings opened with a scoped archive. */
export function createHostedChannelTurnRunner({
  api, workspacePath, longMemory, rag, isScopeCurrent, readRoleState = () => null, readRoleCard, maxConcurrent, now,
} = {}) {
  function readSynchronousRoleState() {
    const state = readRoleState();
    if (typeof state?.then === 'function') {
      void Promise.resolve(state).catch(() => {});
      throw new TypeError('Role state must be synchronous');
    }
    return state;
  }

  const host = createChannelTurnHost({
    api, workspacePath, isScopeCurrent,
    buildPrompt: createChannelTurnPrompt({ readRoleState: readSynchronousRoleState, readRoleCard, now }),
  });
  const runner = createChannelTurnRunner({
    api, longMemory, rag, maxConcurrent, now, ...host,
    isSilent: () => readSynchronousRoleState()?.mode === 'silent',
  });
  return { ...runner, invalidateSource: host.invalidateSource };
}
