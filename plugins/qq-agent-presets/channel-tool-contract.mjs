export const CHANNEL_TOOL_MAX_RESULT_BYTES = 16 * 1024;
export const CHANNEL_TOOL_MAX_WAIT_MS = 30_000;
export const CHANNEL_TOOL_REQUEST_TIMEOUT_MS = 5_000;
export const CHANNEL_TOOL_WAIT_REQUEST_TIMEOUT_MS = 32_000;

export const channelTextToolNames = Object.freeze(['channel_send_text', 'channel_reply_text']);
export const channelTextToolStatuses = Object.freeze([
  'invalid', 'denied', 'sensitive', 'unavailable', 'queued', 'existing', 'conflict', 'full',
]);
export const channelCommonToolStatuses = Object.freeze(['ok', 'invalid', 'denied', 'unavailable']);
export const channelToolDenial = '该渠道会话未开放此工具';

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringField(maxBytes, { allowEmpty = false, description } = {}) {
  return {
    schema: { type: 'string', ...(description ? { description } : {}) },
    valid: value => typeof value === 'string' && value.length <= maxBytes && value.isWellFormed() &&
      !value.includes('\0') && (Boolean(value.trim()) || (allowEmpty && value === '')) &&
      Buffer.byteLength(value) <= maxBytes,
  };
}

function integerField(min, max, description) {
  return {
    schema: { type: 'integer', description },
    valid: value => Number.isSafeInteger(value) && value >= min && value <= max,
  };
}

function choiceField(values, description) {
  return {
    schema: { type: 'string', enum: values, description },
    valid: value => values.includes(value),
  };
}

function arrayField(field, maxLength, description) {
  return {
    schema: { type: 'array', items: field.schema, description },
    valid(value) {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength ||
          Reflect.ownKeys(value).length !== value.length + 1) return false;
      for (let i = 0; i < value.length; i += 1) {
        const item = Object.getOwnPropertyDescriptor(value, i);
        if (!item?.enumerable || !field.valid(item.value)) return false;
      }
      return true;
    },
  };
}

const text = stringField(1024 * 1024);
const memoryText = stringField(4096, { description: '一件值得记住的具体事情' });
const date = stringField(96, { description: 'YYYY-MM-DD 或可换算的相对日期，如昨天、上周、明天' });
const clearableDate = stringField(96, { allowEmpty: true, description: '到期日，传空字符串清除' });
const category = choiceField(['trait', 'fact', 'event', 'pending', 'note'], '记忆类别，pending 用于约定');
const boolean = { schema: { type: 'boolean' }, valid: value => typeof value === 'boolean' };
const itemId = { schema: { type: 'string', description: '从记忆读取结果获得的条目编号' },
  valid: value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) };
const afterSeq = integerField(0, Number.MAX_SAFE_INTEGER, '从这个本地消息水位之后读取');
const throughSeq = integerField(0, Number.MAX_SAFE_INTEGER, '使用读取结果中已经查看的 readThroughSeq');
const limit = integerField(1, 100, '最多返回 1 至 100 条');

const argumentsByTool = Object.freeze({
  channel_send_text: [{ text }, ['text']],
  channel_reply_text: [{ text }, ['text']],
  channel_get_unread: [{ afterSeq, limit }, []],
  channel_history_search: [{
    query: stringField(512, { description: '用一句话描述要查找的历史内容' }),
    keywords: arrayField(stringField(512), 12, '最多 12 个可能出现在原话中的关键词'),
    from: date, to: date, limit,
  }, []],
  channel_memory_recall: [{}, []],
  channel_memory_remember: [{
    cat: category, text: memoryText, due: date, by: choiceField(['me', 'them'], '谁答应的，me 是你，them 是对方'),
    core: boolean, replaces: itemId,
  }, ['cat', 'text']],
  channel_memory_update: [{
    itemId, text: memoryText, cat: category, due: clearableDate,
    by: choiceField(['me', 'them', ''], '谁答应的，传空字符串清除'),
    core: boolean, status: choiceField(['open', 'done', 'missed', 'cancelled'], '约定状态'),
    archived: boolean, outdated: boolean,
  }, ['itemId']],
  channel_memory_forget: [{ itemId }, ['itemId']],
  channel_wait_for_messages: [{
    afterSeq, timeoutMs: integerField(1, CHANNEL_TOOL_MAX_WAIT_MS, '最长等待时间，1 至 30000 毫秒'),
  }, []],
  channel_mark_read: [{ throughSeq }, ['throughSeq']],
  channel_set_wake_config: [{
    throughSeq, groupPolicy: choiceField(['directed', 'observe'], '定向消息唤醒或观察当前群聊'),
  }, ['throughSeq', 'groupPolicy']],
  channel_feedback: [{ message: stringField(4096) }, ['message']],
});

export const channelToolNames = Object.freeze(Object.keys(argumentsByTool));
export const channelCommonToolNames = Object.freeze(channelToolNames.filter(name => !channelTextToolNames.includes(name)));

export function channelToolParameters(name) {
  const [fields, required] = argumentsByTool[name];
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema])),
    required: [...required], additionalProperties: false,
  };
}

export function validChannelToolArgs(name, args) {
  if (typeof name !== 'string' || !Object.hasOwn(argumentsByTool, name) || !isRecord(args)) return false;
  const [fields, required] = argumentsByTool[name];
  return required.every(key => Object.hasOwn(args, key)) &&
    Reflect.ownKeys(args).every(key => {
      if (!Object.hasOwn(fields, key)) return false;
      const field = Object.getOwnPropertyDescriptor(args, key);
      return field.enumerable && fields[key].valid(field.value);
    });
}

// Count the UTF-8 JSON size as the tree is validated. An oversized string or
// container is stopped before JSON.stringify builds an unbounded response.
function boundedResultData(data) {
  let remaining = CHANNEL_TOOL_MAX_RESULT_BYTES - Buffer.byteLength('{"status":"ok","data":}');
  function use(bytes) {
    remaining -= bytes;
    return remaining >= 0;
  }
  function visit(value, depth) {
    if (typeof value === 'string') {
      return value.length <= remaining && value.isWellFormed() && use(Buffer.byteLength(JSON.stringify(value)));
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) && !Object.is(value, -0) && use(Buffer.byteLength(JSON.stringify(value)));
    }
    if (typeof value === 'boolean') return use(value ? 4 : 5);
    if (value === null) return use(4);
    if (depth > 12 || !use(2)) return false;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > remaining ||
          Reflect.ownKeys(value).length !== value.length + 1) return false;
      for (let i = 0; i < value.length; i += 1) {
        const item = Object.getOwnPropertyDescriptor(value, i);
        if ((i > 0 && !use(1)) || !item?.enumerable || !visit(item.value, depth + 1)) return false;
      }
      return true;
    }
    if (!isRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    for (const [i, key] of keys.entries()) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) ||
          (i > 0 && !use(1)) || !use(1) || !visit(key, depth + 1)) return false;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field.enumerable || !visit(field.value, depth + 1)) return false;
    }
    return true;
  }
  return isRecord(data) && visit(data, 1);
}

export function validChannelToolResult(name, value) {
  if (!isRecord(value)) return false;
  const status = Object.getOwnPropertyDescriptor(value, 'status');
  if (!status?.enumerable) return false;
  const keys = Reflect.ownKeys(value).length;
  if (channelTextToolNames.includes(name)) return keys === 1 && channelTextToolStatuses.includes(status.value);
  if (!channelCommonToolNames.includes(name) || !channelCommonToolStatuses.includes(status.value)) return false;
  if (status.value !== 'ok') return keys === 1;
  const data = Object.getOwnPropertyDescriptor(value, 'data');
  return keys === 2 && Boolean(data?.enumerable) && boundedResultData(data.value);
}
