import { setTimeout as sleep } from 'node:timers/promises';
import {
  CHANNEL_TOOL_MAX_RESULT_BYTES, CHANNEL_TOOL_MAX_WAIT_MS, channelCommonToolNames,
  validChannelToolArgs, validChannelToolResult,
} from '../../plugins/qq-agent-presets/channel-tool-contract.mjs';
import { normalizeDateRange } from '../memory-rag-client.js';
import { sanitizeUntrustedText } from '../qq-model-view.js';
import { encodeConversationKey, encodePersonKey, sameAccount } from './identity.mjs';

const DEFAULT_PAGE_SIZE = 20;
const WAIT_POLL_MS = 200;
const MAX_TEXT_BYTES = 4096;
const MEMORY_ACTIONS = {
  channel_memory_recall: 'recall', channel_memory_remember: 'remember',
  channel_memory_update: 'update', channel_memory_forget: 'forget',
};
const MEMORY_ID = /^[a-f0-9]{32}$/;
const DATE = /^(?:\d{4}|\+\d{6})-\d{2}-\d{2}$/;
const TIMESTAMP = /^(?:\d{4}|\+\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const invalid = () => ({ status: 'invalid' });
const denied = () => ({ status: 'denied' });
const unavailable = () => ({ status: 'unavailable' });
const ok = (data) => ({ status: 'ok', data });
const sequence = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const time = (value) => sequence(value) && value <= 8.64e15;

function statusOnly(result) {
  if (result?.status === 'denied') return denied();
  if (result?.status === 'invalid') return invalid();
  return unavailable();
}

function clippedText(text) {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text;
  const bytes = Buffer.from(text);
  let end = MAX_TEXT_BYTES - Buffer.byteLength('…');
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}

function appendRows(data, key, values, view, { reserve = 0 } = {}) {
  const list = data[key];
  let remaining = CHANNEL_TOOL_MAX_RESULT_BYTES - Buffer.byteLength(JSON.stringify(ok(data))) - reserve;
  for (const value of values) {
    const row = view(value);
    if (!row) continue;
    remaining -= Buffer.byteLength(JSON.stringify(row)) + Number(list.length > 0);
    if (remaining < 0) return true;
    list.push(row);
  }
  return false;
}

function validContext(context) {
  if (!context) return false;
  const { conversationKey, source: { conversation, actor } } = context;
  return conversation.platform !== 'qq' && sameAccount(conversation, actor) &&
    encodeConversationKey(conversation) === conversationKey &&
    !(conversation.platform === 'telegram' && conversation.chatType === 'private' && actor.userId !== conversation.chatId);
}

export function createChannelCommonTools({ longMemory, rag, redact, now = Date.now } = {}) {
  if (![longMemory?.channelMemory, longMemory?.searchChannelHistory, redact, now].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Invalid channel common tool dependencies');
  }

  function modelText(text) {
    // Redact complete text before clipping and after flattening structural characters.
    const safe = redact(sanitizeUntrustedText(text));
    if (typeof safe !== 'string') throw new TypeError('Invalid channel tool redaction');
    return clippedText(sanitizeUntrustedText(safe).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').toWellFormed());
  }

  function memoryView(item) {
    if (!MEMORY_ID.test(item?.id) || typeof item.text !== 'string' || !Object.hasOwn(longMemory.CATEGORIES, item.cat)) return null;
    return {
      id: item.id, cat: item.cat, text: modelText(item.text),
      ...(TIMESTAMP.test(item.at) && { at: item.at }),
      ...(DATE.test(item.due) && { due: item.due }),
      ...(['me', 'them'].includes(item.by) && { by: item.by }),
      ...(['open', 'done', 'missed', 'cancelled'].includes(item.status) && { status: item.status }),
      ...(item.core === true && { core: true }),
      ...(TIMESTAMP.test(item.closedAt) && { closedAt: item.closedAt }),
      ...(TIMESTAMP.test(item.archivedAt) && { archivedAt: item.archivedAt }),
      ...(TIMESTAMP.test(item.outdatedAt) && { outdatedAt: item.outdatedAt }),
      ...(MEMORY_ID.test(item.outdatedBy) && { outdatedBy: item.outdatedBy }),
    };
  }

  function readablePage(result, afterSeq, limit, waiting, timedOut) {
    if (result?.status && result.status !== 'ok') return statusOnly(result);
    if (!Array.isArray(result?.messages) || !sequence(result.readThroughSeq) ||
        result.messages.length > limit || typeof result.hasMore !== 'boolean') return unavailable();
    const { readThroughSeq } = result;
    const data = { messages: [], readThroughSeq, hasMore: result.hasMore, ...(waiting && { timedOut }) };
    let cursor = Math.max(readThroughSeq, afterSeq ?? 0);
    // The final cursor can have up to 16 decimal digits.
    if (appendRows(data, 'messages', result.messages, (message) => {
      const { seq, text, occurredAt } = message;
      if (!sequence(seq) || seq <= cursor || typeof text !== 'string' || !time(occurredAt)) {
        throw new TypeError('Invalid channel inbox row');
      }
      cursor = seq;
      return { seq, text: modelText(text), occurredAt };
    }, { reserve: 16 })) data.hasMore = true;
    data.readThroughSeq = data.messages.at(-1)?.seq ?? readThroughSeq;
    return ok(data);
  }

  async function readInbox(args, current, signal, waiting) {
    const { afterSeq, limit = DEFAULT_PAGE_SIZE, timeoutMs = CHANNEL_TOOL_MAX_WAIT_MS } = args;
    const deadline = now() + timeoutMs;
    const monotonicDeadline = performance.now() + timeoutMs;
    for (;;) {
      const context = current();
      if (!context) return denied();
      const result = context.binding.readToolInbox(context.conversationKey, afterSeq, limit);
      const remaining = Math.min(deadline - now(), monotonicDeadline - performance.now());
      if (!waiting || remaining <= 0 || !Array.isArray(result?.messages) || result.messages.length || result.status && result.status !== 'ok') {
        return readablePage(result, afterSeq, limit, waiting, remaining <= 0 && !result?.messages?.length);
      }
      await sleep(Math.min(WAIT_POLL_MS, Math.max(1, Math.ceil(remaining))), undefined, { signal });
    }
  }

  async function searchHistory(args, context, current, signal) {
    let dates;
    try { dates = normalizeDateRange(args, new Date(now())); }
    catch { return invalid(); }
    if (!current()) return denied();
    const options = { ...args, ...dates, limit: args.limit ?? DEFAULT_PAGE_SIZE };
    const history = await longMemory.searchChannelHistory(context.conversationKey, options, { rag, modelView: true, isCurrent: current, signal });
    if (!current()) return denied();
    if (!['rag', 'keyword'].includes(history?.via) || !Array.isArray(history.result?.rows)) return unavailable();
    const { rows, truncated } = history.result;
    const data = { via: history.via, lines: [], truncated: truncated === true || rows.length > options.limit };
    if (appendRows(data, 'lines', rows.slice(0, options.limit), (row) => {
      const occurredAt = Date.parse(row.t);
      if (!time(occurredAt) || typeof row.text !== 'string' || !['in', 'out'].includes(row.dir)) return null;
      return { text: modelText(row.text), occurredAt, direction: row.dir };
    })) data.truncated = true;
    return ok(data);
  }

  function applyMemory(action, args, current) {
    if (args.text !== undefined) {
      const text = modelText(args.text).trim();
      if (!text) return invalid();
      args = { ...args, text };
    }
    const context = current();
    if (!context) return denied();
    const result = longMemory.channelMemory(action, context, args);
    if (result?.status !== 'ok') return statusOnly(result);
    const { items, item, duplicate, replaced } = result.data;
    if (action === 'recall') {
      const data = { items: [], truncated: false };
      data.truncated = appendRows(data, 'items', items.slice().reverse(), memoryView);
      return ok(data);
    }
    if (action === 'forget') return MEMORY_ID.test(item?.id) ? ok({ itemId: item.id }) : unavailable();
    const data = memoryView(item);
    if (!data) return unavailable();
    return ok({ item: data, ...(typeof duplicate === 'boolean' && { duplicate }),
      ...(MEMORY_ID.test(replaced?.id) && { replaced: { id: replaced.id } }) });
  }

  function markRead(name, args, context) {
    const { conversationKey, source, binding } = context;
    const { throughSeq, groupPolicy } = args;
    if (name === 'channel_set_wake_config' && source.conversation.chatType !== 'group') return denied();
    const result = binding.markToolRead(conversationKey, throughSeq, groupPolicy);
    if (result?.status !== 'ok') return statusOnly(result);
    if (!sequence(result.readThroughSeq)) return unavailable();
    return ok({ readThroughSeq: result.readThroughSeq,
      ...(['directed', 'observe'].includes(result.groupPolicy) && { groupPolicy: result.groupPolicy }) });
  }

  async function invoke({ name, args, readContext, signal } = {}) {
    try {
      if (!channelCommonToolNames.includes(name) || !validChannelToolArgs(name, args) || typeof readContext !== 'function') return invalid();
      let origin;
      function current() {
        if (signal?.aborted) return null;
        const context = readContext();
        if (typeof context?.then === 'function') {
          void Promise.resolve(context).catch(() => {});
          return null;
        }
        if (!validContext(context)) return null;
        const { conversationKey, source, requestId, callId, binding } = context;
        const actorKey = encodePersonKey(source.actor);
        if (!origin) origin = { conversationKey, actorKey, requestId, callId, binding };
        if (origin.conversationKey !== conversationKey || origin.actorKey !== actorKey || origin.requestId !== requestId ||
            origin.callId !== callId || origin.binding !== binding) return null;
        return context;
      }

      const context = current();
      if (!context) return denied();
      let result;
      switch (name) {
        case 'channel_get_unread':
        case 'channel_wait_for_messages':
          result = await readInbox(args, current, signal, name === 'channel_wait_for_messages');
          break;
        case 'channel_history_search':
          result = await searchHistory(args, context, current, signal);
          break;
        case 'channel_mark_read':
        case 'channel_set_wake_config':
          result = markRead(name, args, context);
          break;
        case 'channel_feedback': {
          const message = modelText(args.message).trim();
          if (!message) return invalid();
          const authorized = current();
          if (!authorized) return denied();
          const { conversationKey, binding, requestId, callId } = authorized;
          const saved = binding.saveToolFeedback(conversationKey, { requestId, callId, message });
          result = saved?.status === 'ok' ? ok(saved.duplicate === true ? { duplicate: true } : {}) : statusOnly(saved);
          break;
        }
        default:
          result = applyMemory(MEMORY_ACTIONS[name], args, current);
      }
      if (!current()) return denied();
      return validChannelToolResult(name, result) ? result : unavailable();
    } catch {
      return signal?.aborted ? denied() : unavailable();
    }
  }

  return { invoke };
}
