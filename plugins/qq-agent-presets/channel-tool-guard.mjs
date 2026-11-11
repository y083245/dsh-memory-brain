export const name = 'channel-tool-guard';
export const inject = ['tools', 'channelToolGuard'];

export function apply(ctx) {
  if (!ctx.channelToolGuard) throw new Error('Missing global channel tool guard');
  ctx.tools.presentAs('native');
  ctx.tools.restrict({ allow: [] });
  const dispose = ctx.tools.guard(() => '该渠道会话未开放工具');
  if (typeof dispose !== 'function') throw new Error('DSH channel tool guard registration failed');
}
