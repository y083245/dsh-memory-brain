import {
  channelCommonToolStatuses, channelTextToolNames, channelTextToolStatuses, channelToolDenial,
  channelToolNames, channelToolParameters, validChannelToolArgs, validChannelToolResult,
} from './channel-tool-contract.mjs';

export const name = 'channel-native-text-tools';
export const inject = ['tools', 'channelToolGuard'];

const descriptions = Object.freeze({
  channel_send_text: '在当前来信所属的会话中发送纯文本。',
  channel_reply_text: '在当前来信所属的会话中发送纯文本并引用当前来信。',
  channel_get_unread: '查看当前会话的未读消息。用上次返回的 readThroughSeq 作为 afterSeq 继续读取。',
  channel_history_search: '搜索当前会话的历史消息。可以提供关键词与日期范围。',
  channel_memory_recall: '查看当前回合获准访问的记忆。私密条目可更新和遗忘，标为 shared 的条目可遗忘。',
  channel_memory_remember: '默认记为本会话私密条目。替换私密旧条目时传 replaces。用户在本次私聊直接发送 /share_memory 内容时，可传 share: true 并逐字提交命令中的内容。',
  channel_memory_update: '更新当前回合获准访问的本会话私密记忆。',
  channel_memory_forget: '从当前回合获准访问的记忆中删除指定条目。',
  channel_wait_for_messages: '等待当前会话到达新消息，最长等待 30 秒。可以从上次读取的 readThroughSeq 之后等候。',
  channel_mark_read: '标记当前会话中已经看过的消息。throughSeq 使用已查看结果的 readThroughSeq。',
  channel_set_wake_config: '确认当前群聊的已读水位并设置群聊唤醒策略。',
  channel_feedback: '记录关于当前会话的反馈，供本地维护时查看。',
});

function statusSchema(statuses) {
  return {
    type: 'object', properties: { status: { type: 'string', enum: statuses } },
    required: ['status'], additionalProperties: false,
  };
}

const textOutput = statusSchema(channelTextToolStatuses);
const commonOutput = {
  oneOf: [
    statusSchema(channelCommonToolStatuses.filter(status => status !== 'ok')),
    { type: 'object', properties: { status: { type: 'string', const: 'ok' }, data: { type: 'object' } },
      required: ['status', 'data'], additionalProperties: false },
  ],
};

function renderResult(name, value) {
  const result = validChannelToolResult(name, value) ? value : { status: 'denied' };
  return [{ type: 'text', text: JSON.stringify(result) }];
}

export function apply(ctx) {
  const guard = ctx.channelToolGuard;
  if (!guard?.requestFor) throw new Error('Missing global channel tool guard');
  if (!guard.enabled) throw new Error('Channel tool endpoint is unavailable');
  ctx.tools.restrict({ allow: [] });
  const dispose = ctx.tools.guard(exec => {
    if (!guard.requestFor(exec) || !validChannelToolArgs(exec.name, exec.arguments)) return channelToolDenial;
  });
  if (typeof dispose !== 'function') throw new Error('DSH channel tool guard registration failed');

  const mounted = new WeakSet();
  const definitions = channelToolNames.map(toolName => ({
    name: toolName,
    description: descriptions[toolName],
    parameters: channelToolParameters(toolName),
    output: {
      schema: channelTextToolNames.includes(toolName) ? textOutput : commonOutput,
      render: (_args, value) => renderResult(toolName, value),
    },
    finalizeContent(exec, result) {
      if (result.value?.status === 'ok' && !guard.requestFor(exec)) return renderResult(toolName, { status: 'denied' });
      return renderResult(toolName, result.value);
    },
    async execute(args, exec) {
      if (exec?.name !== toolName) return { status: 'denied' };
      return guard.submit(exec, args);
    },
  }));
  for (const definition of definitions) guard.registerChannelTool(definition);
  // This scoped hook runs before tool assembly. Agent-owned definitions survive the
  // inherited-tool filter, and a blank session can change its preset before this hook runs.
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    if (mounted.has(agent) || !guard.isTextAgent(agent)) return;
    for (const definition of definitions) {
      if (typeof agent.ctx.tools.register(definition) !== 'function') throw new Error('DSH channel tool registration failed');
    }
    mounted.add(agent);
  });
}
