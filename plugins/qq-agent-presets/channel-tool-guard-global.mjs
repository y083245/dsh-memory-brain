export const name = 'channel-tool-guard-global';
export const inject = ['tools'];

export function apply(ctx) {
  const dispose = ctx.tools.guard(exec => {
    // Also protect channel IDs under a different preset, including blank
    // sessions whose preset changed after creation.
    if (typeof exec?.agent?.id === 'string' && exec.agent.id.startsWith('cb1-')) {
      return '该渠道会话未开放工具';
    }
  });
  if (typeof dispose !== 'function') throw new Error('DSH channel tool guard registration failed');
  ctx.provide('channelToolGuard', Object.freeze({}));
}
