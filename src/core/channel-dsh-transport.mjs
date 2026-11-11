import { inboxItemsOfProjections } from '../dsh-client.js';

const HISTORY_MESSAGES = 200;
const UNKNOWN = Object.freeze({ status: 'unknown' });
const TERMINAL_REASONS = new Set(['completed', 'blocked', 'max-tokens', 'interrupted']);
const CANCEL_CAUSES = new Set(['user', 'parent', 'disposed', 'legacy']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTurnNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function successfulValue(response) {
  const { result } = response ?? {};
  if (isRecord(result) && result.ok === true && !Object.hasOwn(result, 'error')) return result.value;
}

function isMissingSession(response, sessionId) {
  const { result } = response ?? {};
  return isRecord(result) && result.ok === false && !Object.hasOwn(result, 'value')
    && result.error?.code === 'session/not-found' && result.error?.details?.sessionId === sessionId;
}

function matchesRequest(message, requestId) {
  return message?.source?.kind === 'user' && message.source.rpcId === requestId;
}

function isUserMessage(message) {
  return message.role === 'user' && isId(message.id) && Array.isArray(message.content);
}

function isTerminal(reason) {
  if (TERMINAL_REASONS.has(reason?.kind)) return true;
  if (reason?.kind === 'aborted') {
    const cause = reason.reason;
    return CANCEL_CAUSES.has(cause?.kind) || (cause?.kind === 'hook' && typeof cause.reason === 'string');
  }
  return reason?.kind === 'error' && isId(reason.error?.code) && typeof reason.error.message === 'string';
}

function reconcilePage(page, cursor, requestId, storedTurn, queued) {
  if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean'
      || (Object.hasOwn(page, 'cursor') && page.cursor !== cursor)
      || (page.records.length === 0 && cursor !== -1)) return UNKNOWN;
  let seq = cursor - page.records.length;
  if (seq < -1 || page.hasMore !== (seq >= 0)) return UNKNOWN;

  // The journal records UserMessage without a turn field. A prompt's source
  // carries the SessionPromptRequest.requestId, and the Agent writes the
  // message between the explicit start and end of its turn.
  let leadingPartialTurn = page.hasMore;
  let openTurn;
  let lastClosedTurn = 0;
  let seenRequest = false;
  let matchedTurn;
  let closed = false;
  let reason;
  for (const record of page.records) {
    const event = record?.event;
    seq += 1;
    if (record?.type !== 'event' || event?.seq !== seq || typeof event.type !== 'string') return UNKNOWN;
    const { type, data, surfaceOp } = event;
    if (type === 'turn/start' || type === 'turn/end') {
      const id = data?.turn;
      if (!isTurnNumber(id) || id <= lastClosedTurn) return UNKNOWN;
      if (type === 'turn/start') {
        if (openTurn !== undefined || (leadingPartialTurn && seenRequest)) return UNKNOWN;
        openTurn = id;
      } else {
        if (openTurn !== id && !leadingPartialTurn) return UNKNOWN;
        if (leadingPartialTurn && seenRequest && storedTurn !== id) return UNKNOWN;
        // A bounded page may omit the start and user message. Only a
        // previously verified turn ID can establish ownership in that case.
        if (matchedTurn === id || (leadingPartialTurn && storedTurn === id)) {
          matchedTurn = id;
          closed = true;
          reason = data.reason;
        }
        openTurn = undefined;
        lastClosedTurn = id;
      }
      leadingPartialTurn = false;
    } else if (type === 'user/message' && matchesRequest(data, requestId)) {
      if (seenRequest || !isUserMessage(data) || surfaceOp !== 'append') return UNKNOWN;
      if (openTurn === undefined && !leadingPartialTurn) return UNKNOWN;
      seenRequest = true;
      matchedTurn = openTurn;
    }
  }

  if (queued) {
    return seenRequest || storedTurn !== undefined ? UNKNOWN : { status: 'pending' };
  }
  if (matchedTurn === undefined || (storedTurn !== undefined && storedTurn !== matchedTurn)) return UNKNOWN;
  const turnId = String(matchedTurn);
  if (closed) return isTerminal(reason) ? { status: 'completed', turnId } : UNKNOWN;
  return openTurn === matchedTurn ? { status: 'pending', turnId } : UNKNOWN;
}

/** Adapt the DSH RPCs for persisted channel work. Results contain execution evidence only. */
export function createChannelDshTransport(api) {
  return {
    async submit(turn, content, { signal } = {}) {
      const { sessionId, requestId } = turn ?? {};
      if (!isId(sessionId) || !isId(requestId) || !Array.isArray(content)) return UNKNOWN;
      try {
        signal?.throwIfAborted();
        const response = await api.sessions.prompt({ sessionId, mode: 'queue', content, requestId }, signal);
        if (successfulValue(response)?.accepted === true) return { status: 'accepted' };
        if (isMissingSession(response, sessionId)) return { status: 'not_submitted' };
      } catch {
        // The request may have reached the host before the carrier failed.
      }
      return UNKNOWN;
    },

    async reconcile(turn, { signal } = {}) {
      const { sessionId, requestId, turnId } = turn ?? {};
      if (!isId(sessionId) || !isId(requestId)) return UNKNOWN;
      let storedTurn;
      if (turnId !== undefined && turnId !== null) {
        if (typeof turnId !== 'string') return UNKNOWN;
        storedTurn = Number(turnId);
        if (!isTurnNumber(storedTurn) || String(storedTurn) !== turnId) return UNKNOWN;
      }
      try {
        signal?.throwIfAborted();
        // DSH 0.2.1 requires a pinned throughSeq on session/page. The passive
        // projection RPC supplies the journal cut, including for cold sessions.
        const projection = successfulValue(await api.callUnary('session/projections', { sessionId }, signal));
        const cursor = projection?.asOfSeq;
        if (!Number.isSafeInteger(cursor) || cursor < -1 || !isRecord(projection?.values)
            || (projection.kind !== undefined && projection.kind !== 'sequenced')) return UNKNOWN;
        const queued = inboxItemsOfProjections(projection.values).filter((item) => matchesRequest(item, requestId));
        if (queued.length > 1 || (queued.length === 1 && !isUserMessage(queued[0]))) return UNKNOWN;
        const page = successfulValue(await api.callUnary('session/page', {
          address: { kind: 'session', sessionId },
          throughSeq: cursor,
          maxMessages: HISTORY_MESSAGES,
        }, signal));
        return reconcilePage(page, cursor, requestId, storedTurn, queued.length === 1);
      } catch {
        return UNKNOWN;
      }
    },

    async retire(turn, { signal } = {}) {
      const { sessionId } = turn ?? {};
      if (!isId(sessionId)) return UNKNOWN;
      try {
        signal?.throwIfAborted();
        const stopped = await api.stopSessionWork(sessionId, { signal });
        if (!Number.isSafeInteger(stopped?.removed) || stopped.removed < 0) return UNKNOWN;
        signal?.throwIfAborted();
        const response = await api.workspace.archiveSession({ sessionId }, signal);
        const archived = successfulValue(response)?.archivedSessionIds;
        if (isMissingSession(response, sessionId)
            || (Array.isArray(archived) && archived.every(isId) && archived.includes(sessionId))) {
          return { status: 'retired' };
        }
      } catch {
        // Keep the previous generation blocked until retirement is confirmed.
      }
      return UNKNOWN;
    },
  };
}
