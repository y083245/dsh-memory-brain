#!/usr/bin/env node
// 一键启动的跨平台实现（入口：start-all.sh / start-all.bat，它们只是一层转发）。
// Linux：DSH → QQ → SnowLuma → 等 OneBot → qq-bridge，装了 systemd 用户服务就走 systemctl。
// Windows：QQ / SnowLuma 由用户自己打开，
// 本脚本负责 config、DSH 预设 / MCP、连 DSH、等 OneBot、起桥接。具体实现见 src/runtime/orchestrator.mjs。
//
// 用法：
//   node scripts/start-all.mjs                  # 全部启动（RAG 按 config.json 的 memoryRag.enabled）
//   START_RAG=1 node scripts/start-all.mjs      # 打开 RAG 并一起启动
//   node scripts/start-all.mjs --rag            # 只起向量记忆并打开开关
//   node scripts/start-all.mjs --desktop        # 指定连 DSH 桌面版（默认自动：已打开的桌面版优先，否则 dsh web）
//   node scripts/start-all.mjs --web            # 指定用 dsh web（3080）
//
// 这个入口**只用 Node 内置模块**：刚 clone 下来还没装依赖时，编排器的 import（js-yaml 等）
// 会直接抛 ERR_MODULE_NOT_FOUND。所以先在这里补一次 npm ci，再动态加载编排器。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIN_NODE_VERSION, checkNodeVersion, mirrorOutputToLog } from './lib/entry-guard.mjs';
import { planStartNode } from '../src/runtime/node-select.mjs';
import { readRuntimeConfig } from '../src/runtime/paths.mjs';
import { isQqEnabled } from '../src/runtime/channel-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function dependenciesInstalled() {
  return [
    'js-yaml', '@deepseek-ai/dsh-host-apiproxy', '@larksuiteoapi/node-sdk',
    'grammy', 'https-proxy-agent', 'socks-proxy-agent',
  ]
    .every((name) => fs.existsSync(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json')));
}

function installDependencies() {
  const args = ['ci', '--no-audit', '--no-fund'];
  if (!isQqEnabled(readRuntimeConfig(ROOT))) args.push('--omit=optional');
  console.log(`[start] 首次运行：安装依赖（npm ${args.join(' ')}）...`);
  // npm 在 Windows 上是 npm.cmd；Node 18.20+/20.12+ 不允许不经 shell 直接 spawn .cmd，
  // 所以走 cmd.exe（命令行是固定字符串，不拼任何外部输入）。
  const r = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0 || !dependenciesInstalled()) {
    console.error('[fail] npm ci 失败：请确认已安装 Node.js（自带 npm）且能联网，然后在本目录手动运行 npm ci');
    return false;
  }
  console.log('  ok   依赖安装完成');
  return true;
}

/**
 * 当前 node 不合适、nvm 里有合适的，就用那个 node 把本脚本再跑一遍，返回它的退出码；不用换返回 null。
 * 换完后 process.execPath 和 PATH 都对了，npm ci、setup-dsh、DSH、SnowLuma、桥接拿到的是同一个 node。
 */
function rerunWithBetterNode() {
  if (process.env.QQB_NODE_SWITCH_NOTE !== undefined) return null; // 已经换过一次，不再换
  let target = null;
  try {
    target = planStartNode({ root: ROOT, entryMin: MIN_NODE_VERSION });
  } catch (error) {
    console.error(`[start] 检查 node 版本时出错，继续用当前的 node：${error?.message ?? error}`);
  }
  if (!target) return null;
  const r = spawnSync(target.path, process.argv.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${path.dirname(target.path)}${path.delimiter}${process.env.PATH ?? ''}`,
      QQB_NODE_SWITCH_NOTE: target.note
    }
  });
  if (r.error) {
    console.error(`[start] 换不到 ${target.path}（${r.error.message}），继续用当前的 node`);
    return null;
  }
  return r.status ?? 1;
}

async function main() {
  const rerunStatus = rerunWithBetterNode();
  if (rerunStatus !== null) return rerunStatus;
  // 换 node 的说明在子进程里打，才会进 start-all.log（日志文件每次运行都从头写）。
  const switchNote = process.env.QQB_NODE_SWITCH_NOTE;
  delete process.env.QQB_NODE_SWITCH_NOTE; // 别让后面拉起的服务继承
  mirrorOutputToLog('start-all');
  if (switchNote) console.log(`[start] ${switchNote}`);
  if (!checkNodeVersion()) return 1;
  if (!dependenciesInstalled() && !installDependencies()) return 1;
  // 编排器的 import 失败（依赖残缺、Node 太旧）也要留下可读的报错，不能只闪一下。
  const { runStart } = await import(pathToFileURL(path.join(ROOT, 'src', 'runtime', 'orchestrator.mjs')).href);
  return runStart();
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`[start] 启动失败：${error?.stack ?? error}`);
  process.exitCode = 1;
});
