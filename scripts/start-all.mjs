#!/usr/bin/env node
// 一键启动的顺序与旧 start-all.sh 一致：DSH → QQ → SnowLuma → 等 OneBot → qq-bridge。
// 具体实现见 src/runtime/orchestrator.mjs（Linux systemd / Windows PID 两条路）。
//
// 用法：
//   node scripts/start-all.mjs                  # 全部启动（RAG 按 config.json 的 memoryRag.enabled）
//   START_RAG=1 node scripts/start-all.mjs      # 打开 RAG 并一起启动
//   node scripts/start-all.mjs --rag            # 只起向量记忆并打开开关
import { runStart } from '../src/runtime/orchestrator.mjs';

runStart()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`[start] 启动失败：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
