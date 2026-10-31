// re-export 壳：qq-persona-context 的权威实现在 plugins/qq-agent-presets/qq-persona-context.mjs（bundle 内）。
// 与同目录 qq-tool-restrict.mjs 的做法一致：preset 源里写相对名，build-agent-preset-patches.mjs 改写成裸说明符。
export * from '../../../plugins/qq-agent-presets/qq-persona-context.mjs'
