// 编排脚本的路径解析 —— 平台默认值 + config.json 的 orchestrator 段 + 环境变量。
//
// 优先级：环境变量 > config.json.orchestrator > 平台默认值。所有路径都用
// os.homedir()/path.join 拼，不写死 ~、/opt 或 nvm 目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from './commands.mjs';
import { resolvePython } from './python.mjs';

function isFile(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

function isDir(dir, fsImpl = fs) {
  try { return fsImpl.statSync(dir).isDirectory(); } catch { return false; }
}

function readConfig(root, fsImpl = fs) {
  try {
    const text = fsImpl.readFileSync(path.join(root, 'config.json'), 'utf8');
    const doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

function cfgString(oc, key) {
  const value = oc?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** 版本号自然排序（SnowLuma-v2.10 排在 v2.9 后面）。 */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/** 一个 SnowLuma 目录是否可启动；返回启动方式或 null。 */
export function inspectSnowLuma(dir, { platform = process.platform, fsImpl = fs } = {}) {
  if (!dir || !isDir(dir, fsImpl)) return null;
  const index = path.join(dir, 'index.mjs');
  if (isFile(index, fsImpl)) return { kind: 'node', cwd: dir, args: ['./index.mjs'] };
  if (platform === 'win32') {
    const exe = path.join(dir, 'SnowLuma.exe');
    if (isFile(exe, fsImpl)) return { kind: 'exe', cwd: dir, args: [] };
    const launcher = path.join(dir, 'launcher.bat');
    if (isFile(launcher, fsImpl)) return { kind: 'cmd', cwd: dir, args: [] };
  }
  return null;
}

/**
 * 在 ~/snowluma、~/SnowLuma 下找最新的可启动目录。
 * 版本升级后目录名会变，所以不依赖固定版本号。
 */
export function findSnowLumaDir({ home = os.homedir(), platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  const bases = [];
  if (env.SNOWLUMA_HOME) bases.push(env.SNOWLUMA_HOME);
  bases.push(path.join(home, 'snowluma'), path.join(home, 'SnowLuma'));
  const found = [];
  for (const base of bases) {
    if (inspectSnowLuma(base, { platform, fsImpl })) found.push(base);
    let entries = [];
    try { entries = fsImpl.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      if (inspectSnowLuma(dir, { platform, fsImpl })) found.push(dir);
    }
  }
  if (!found.length) return '';
  return found.sort((a, b) => naturalCompare(path.basename(a), path.basename(b))).at(-1);
}

/** Windows 上 QQNT 的常见安装位置；找不到也返回第一个候选，交给调用方报错。 */
export function defaultQqBin({ platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  if (platform !== 'win32') return '/opt/QQ/qq';
  const candidates = [];
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    if (env[key]) candidates.push(path.join(env[key], 'Tencent', 'QQNT', 'QQ.exe'));
  }
  if (env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Tencent', 'QQNT', 'QQ.exe'));
    candidates.push(path.join(env.LOCALAPPDATA, 'Tencent', 'QQNT', 'QQ.exe'));
  }
  return candidates.find((file) => isFile(file, fsImpl)) || candidates[0] || '';
}

function defaultEmbedBin({ platform, home, fsImpl }) {
  const exe = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const candidates = [
    path.join(home, 'llama.cpp', 'build', 'bin', exe),
    path.join(home, 'llama.cpp', exe)
  ];
  return candidates.find((file) => isFile(file, fsImpl)) || candidates[0];
}

/**
 * @returns {object} 编排所需的全部路径与启动方式。
 */
export function resolveOrchestratorPaths({
  root,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  fsImpl = fs,
  execPath = process.execPath
} = {}) {
  const config = readConfig(root, fsImpl);
  const oc = config.orchestrator && typeof config.orchestrator === 'object' && !Array.isArray(config.orchestrator)
    ? config.orchestrator
    : {};
  const pick = (envName, cfgKey, fallback) => {
    const fromEnv = typeof env[envName] === 'string' && env[envName].trim() ? env[envName].trim() : '';
    return fromEnv || cfgString(oc, cfgKey) || fallback;
  };

  const runDir = pick('QQB_RUN_DIR', 'runDir', path.join(home, '.ai-companion-run'));
  const dshDir = pick('DSH_DIR', 'dshDir', path.join(home, 'deepseek-harness'));
  const snowDir = pick('SNOW_DIR', 'snowDir', findSnowLumaDir({ home, platform, env, fsImpl }));
  const qqBin = pick('QQ_BIN', 'qqBin', defaultQqBin({ platform, env, fsImpl }));
  const gsvDir = pick('GSV_DIR', 'gsvDir', path.join(home, 'gpt-sovits'));
  const embedBin = pick('EMBED_BIN', 'embedBin', defaultEmbedBin({ platform, home, fsImpl }));
  const embedModel = pick('EMBED_MODEL', 'embedModel', path.join(home, 'models', 'Qwen3-Embedding-8B-Q8_0.gguf'));
  const nodeBin = pick('NODE_BIN', 'nodeBin', execPath);
  const pnpmBin = pick('PNPM_BIN', 'pnpmBin', findExecutable('pnpm', { env, platform, fsImpl }) || 'pnpm');
  const ragDir = path.join(root, 'sidecars', 'memory-rag');

  const snowLaunch = inspectSnowLuma(snowDir, { platform, fsImpl });
  const qqArgs = platform === 'win32'
    ? []
    : ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing'];

  let dshCommand;
  const custom = Array.isArray(oc.dshCommand) ? oc.dshCommand.filter((item) => typeof item === 'string' && item.trim()) : [];
  if (custom.length) {
    dshCommand = { command: custom[0], args: custom.slice(1), cwd: isDir(dshDir, fsImpl) ? dshDir : root };
  } else if (isFile(path.join(dshDir, 'package.json'), fsImpl)) {
    dshCommand = { command: pnpmBin, args: ['dsh', 'web'], cwd: dshDir };
  } else {
    // 全局安装的 dsh（Windows 上通常是 dsh.cmd；commandSpec 会解析成 node + JS 入口）。
    dshCommand = { command: 'dsh', args: ['web'], cwd: root };
  }

  return {
    platform,
    root,
    home,
    config,
    runDir,
    dshDir,
    dshCommand,
    snowDir,
    snowLaunch,
    qqBin,
    qqArgs,
    gsvDir,
    gsvPython: resolvePython({ venvDir: gsvDir, platform, env, fsImpl }),
    embedBin,
    embedModel,
    nodeBin,
    pnpmBin,
    ragDir,
    ragPython: resolvePython({ venvDir: ragDir, platform, env, fsImpl }),
    startRag: env.START_RAG === '1',
    startGsv: env.START_GSV === '1'
  };
}

export const __test = { readConfig, defaultEmbedBin };
