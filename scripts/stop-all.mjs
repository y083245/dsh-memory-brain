#!/usr/bin/env node
// 按反序停止：qq-bridge → memory-rag → embedding → SnowLuma → QQ → DSH（DSH 默认保留）。
//
// 用法：
//   node scripts/stop-all.mjs          # 停桥接、向量记忆、SnowLuma、QQ（不改 RAG 开关）
//   node scripts/stop-all.mjs --all    # 连 DSH 一起停
//   node scripts/stop-all.mjs --rag    # 关掉向量记忆：写 enabled=false，再停 memory-rag（自带时连 embedding）
import { runStop } from '../src/runtime/orchestrator.mjs';

runStop()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`[stop] 停止失败：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
