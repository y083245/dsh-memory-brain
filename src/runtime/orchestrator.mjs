// 一键编排的跨平台实现：start-all.mjs / stop-all.mjs 都只是它的薄 CLI。
//
// 设计原则：
//   - Linux 装了 systemd 用户服务（qq-bridge / qq-memory-rag / qq-embedding）时，
//     这三个继续用 systemctl --user；没装时与旧脚本一样 detached 启动。
//   - Windows 没有 systemd：detached spawn + ~/.ai-companion-run/*.pid；停止时
//     taskkill /PID <pid> /T /F 收掉整棵子进程树。
//   - 端口一律用 node:net 探测；外部命令只通过 execFile/spawn 的数组参数调用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { commandSpec, describeCommand, findExecutable } from './commands.mjs';
import { isPortOpen, waitForPort, waitForPorts } from './ports.mjs';
import {
  execFileP,
  findPidsByImage,
  findPidsByPattern,
  isPidAlive,
  readPidFile,
  removePidFile,
  spawnDetached,
  stopPid,
  stopPidFile,
  writePidFile
} from './process.mjs';
import { isEmbeddingManaged, readRagEnabled, writeRagEnabled } from './rag-config.mjs';
import { resolveOrchestratorPaths } from './paths.mjs';
import { dshNodeRequirement, hasPtraceCap, nodeVersionProblem } from './node-select.mjs';
import { REQUIRED_PRESETS, checkDshModels, checkDshPresets, describeEndpoint, diagnosePresetProfile, findDesktopHosts, modelSetupHint, resolveDshEndpoint } from '../dsh-discovery.js';
import { NodeApiClient } from '../dsh-client.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint } from '../snowluma-conn.js';
import { locateSnowLumaHomes, probeOneBotWs, processChainForPort } from './snowluma-locate.mjs';
import { resolveElectronShim } from './commands.mjs';
import { findDshCli } from './paths.mjs';
import { channelTextToolsEnabled, channelToolDshEnv, launchChannelToolBridge, withoutChannelPlatformEnv, withoutChannelToolEnv } from './channel-tool-launch.mjs';
import {
  EMBED_PORT,
  RAG_PORT,
  gpuFreeMiB,
  startEmbeddingService,
  startMemoryRagService,
  waitForHealth
} from './rag-services.mjs';

const DSH_PORT = 3080;
const ONEBOT_PORTS = [3000, 3001];
const SNOW_PORT = 5099;
const BRIDGE_PORT = 3100;
const GSV_PORT = 9880;
const SYSTEMD_TIMEOUT_MS = 180000;
const STOP_TIMEOUT_MS = 60000;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entryName = (name, platform = process.platform) => (platform === 'win32' ? `${name}.bat` : `./${name}.sh`);

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createLogger(stream = process.stdout) {
  const color = process.platform !== 'win32' && stream.isTTY;
  const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    log: (msg) => stream.write(`${paint('1;36', '[start]')} ${msg}\n`),
    stopLog: (msg) => stream.write(`${paint('1;36', '[stop]')} ${msg}\n`),
    ok: (msg) => stream.write(`${paint('1;32', '  ok  ')} ${msg}\n`),
    warn: (msg) => stream.write(`${paint('1;33', '[warn]')} ${msg}\n`),
    err: (msg) => process.stderr.write(`${paint('1;31', '[fail]')} ${msg}\n`)
  };
}

function parseArgs(argv, { stop = false } = {}) {
  const out = { ragOnly: false, stopDsh: false, dshTarget: '', unknown: [] };
  for (const arg of argv) {
    if (arg === '--rag') {
      out.ragOnly = true;
    } else if (!stop && (arg === '--web' || arg === '--desktop')) {
      out.dshTarget = arg.slice(2);
    } else if (stop && arg === '--all') {
      out.stopDsh = true;
    } else {
      out.unknown.push(arg);
    }
  }
  return out;
}

function systemdEnv(env = process.env) {
  const out = { ...env };
  if (!out.XDG_RUNTIME_DIR && typeof process.getuid === 'function') out.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return out;
}

function systemdUnitFile(home, unit) {
  return path.join(home, '.config', 'systemd', 'user', unit);
}

async function systemctl(args, { env = process.env, timeout = 20000 } = {}) {
  return execFileP('systemctl', ['--user', ...args], { env: systemdEnv(env), timeout });
}

/** 单元文件装了且 systemd 认得它。 */
async function useUnit(unit, { home, env, warn }) {
  if (process.platform === 'win32') return false;
  if (!isFile(systemdUnitFile(home, unit))) return false;
  const r = await systemctl(['show', '-p', 'LoadState', '--value', unit], { env });
  if (String(r.stdout ?? '').trim() === 'loaded') return true;
  warn(`${unit} 已安装，但 systemctl --user 连不上或还没加载它，这次按旧方式处理`);
  return false;
}

/** unit 在跑 / 正在起 / 等着自动重启都算「已在运行」。 */
async function systemdRunning(unit, label, { env, ok }) {
  const r = await systemctl(['show', '-p', 'ActiveState', '--value', unit], { env });
  const state = String(r.stdout ?? '').trim();
  if (['active', 'activating', 'reloading'].includes(state)) {
    ok(`${label} 已在运行（systemd：${unit}）`);
    return true;
  }
  return false;
}

async function systemdStart(unit, { env, timeout = SYSTEMD_TIMEOUT_MS } = {}) {
  await systemctl(['reset-failed', unit], { env });
  return systemctl(['start', unit], { env, timeout });
}

async function systemdStop(unit, label, { env, log, ok, warn } = {}) {
  const r = await systemctl(['show', '-p', 'ActiveState', '--value', unit], { env });
  const state = String(r.stdout ?? '').trim();
  if (!state || state === 'inactive' || state === 'failed') {
    ok(`${label} 未运行（systemd：${unit}）`);
    return true;
  }
  log(`停止 ${label}（systemctl --user stop ${unit}）`);
  const stopped = await systemctl(['stop', unit], { env, timeout: STOP_TIMEOUT_MS });
  if (stopped.code === 0) {
    ok(`${label} 已停止`);
    return true;
  }
  warn(`systemctl --user stop ${unit} 失败，看：systemctl --user status ${unit}`);
  return false;
}

function readFromOffset(file, offset) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return '';
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function fileSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { return fs.fstatSync(fd).size; } finally { fs.closeSync(fd); }
  } catch {
    return 0;
  }
}

async function waitForLog(file, { seconds = 20, needle, offset = 0 } = {}) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (readFromOffset(file, offset).includes(needle)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

function tailLines(file, count = 8) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

async function stopPids(pids, label, { platform = process.platform, log, ok, warn } = {}) {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid);
  if (!unique.length) {
    ok(`${label} 未运行`);
    return true;
  }
  log(`停止 ${label}（PIDs: ${unique.join(', ')}）`);
  let allOk = true;
  for (const pid of unique) {
    const result = await stopPid(pid, { platform, timeoutMs: 10000, label });
    if (!result.ok) {
      allOk = false;
      warn(result.reason || `${label} 停止失败（PID ${pid}）`);
    }
  }
  if (allOk) ok(`${label} 已停止`);
  return allOk;
}

/**
 * 按 PID 文件优先、镜像名/命令行兜底停止一个服务。没有可信 PID 且端口还被占时，
 * 只提示「不是本脚本起的」，不误杀。
 */
async function stopService({
  pidFile,
  label,
  patterns = [],
  image = null,
  port = null,
  platform = process.platform,
  log,
  ok,
  warn
}) {
  const pid = readPidFile(pidFile);
  if (pid) {
    const result = await stopPidFile({ pidFile, patterns, platform, timeoutMs: 10000, label });
    if (result.ok && !result.missing && !result.stale) {
      ok(`${label} 已停止`);
      return true;
    }
    if (!result.ok) {
      warn(result.reason || `${label} 未停止（PID ${pid}）`);
      return false;
    }
    // PID 文件陈旧：已经删掉了，继续按端口 / 镜像名 / 命令行兜底。
  }
  // 没有 PID 文件时，先确认端口上确实有服务在监听，再按镜像名 / 命令行兜底。
  // 否则 Windows 上「按 python.exe 找 PID」会把用户其它 Python 进程一起杀掉。
  if (port !== null && !(await isPortOpen(port))) {
    ok(`${label} 未运行`);
    removePidFile(pidFile);
    return true;
  }
  if (platform === 'win32' && image) {
    const pids = await findPidsByImage(image);
    if (pids.length) return stopPids(pids, label, { platform, log, ok, warn });
  }
  if (platform !== 'win32' && patterns.length) {
    const pids = await findPidsByPattern(patterns[0]);
    if (pids.length) return stopPids(pids, label, { platform, log, ok, warn });
  }
  if (port !== null) {
    warn(`${label} 在运行（端口 ${port}），但不是本脚本起的，没有停它`);
    return false;
  }
  ok(`${label} 未运行`);
  removePidFile(pidFile);
  return true;
}

function spawnErrorHint(error) {
  if (error?.code === 'ENOENT') return '找不到可执行文件（检查路径或 PATH）';
  if (error?.code === 'EACCES') return '没有执行权限';
  return error?.message ?? String(error);
}

async function spawnService({ spec, cwd, logFile, label, log, err, platform, env = process.env, windowsHide = true }) {
  try {
    log(`启动 ${label}：${describeCommand(spec)}`);
    // commandSpec 可能带回必须的环境变量（桌面版 dsh.cmd → ELECTRON_RUN_AS_NODE=1）。
    const spawned = await spawnDetached({ ...spec, cwd, logFile, platform, env: spec.env ? { ...env, ...spec.env } : env, windowsHide });
    return spawned.pid;
  } catch (error) {
    err(`${label} 启动失败：${spawnErrorHint(error)}`);
    return null;
  }
}

function isExecutable(file) {
  if (process.platform === 'win32') return isFile(file);
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

async function setRagSwitch(root, value, { warn }) {
  try {
    await writeRagEnabled(root, value);
    return true;
  } catch (error) {
    warn(`没能把 RAG 开关写进 ${path.join(root, 'config.json')}：${error?.message ?? error}`);
    return false;
  }
}

async function summarizeRag({ paths, ragEnabled, managed, log, ok }) {
  log('向量记忆（可选）');
  if (!managed) {
    ok('向量模型：自己部署 / 云端，不由本脚本管理');
  } else if (await isPortOpen(EMBED_PORT)) {
    log(`  embedding        http://127.0.0.1:${EMBED_PORT}`);
  } else {
    log('  embedding        未运行（检索只走 BM25）');
  }
  if (await isPortOpen(RAG_PORT)) log(`  memory-rag       http://127.0.0.1:${RAG_PORT}`);
  else log('  memory-rag       未运行（检索降级为关键词）');
  log(`  日志目录         ${paths.runDir}`);
  if (!ragEnabled) log('  （本次没有启动：memoryRag.enabled 不是 true）');
}

/** 向量记忆：embedding :8091 → memory-rag :8093，任何一步失败都只 warn。 */
async function startRagSection({ paths, ragEnabled, log, ok, warn, platform = process.platform }) {
  const managed = isEmbeddingManaged(paths.root);
  const embedWaitSeconds = Number(paths.env.QQB_RAG_EMBED_WAIT_SECONDS) || 5;
  const ragWaitSeconds = Number(paths.env.QQB_RAG_WAIT_SECONDS) || 60;
  if (!ragEnabled) {
    const running = [];
    if (managed && await isPortOpen(EMBED_PORT)) running.push('8091');
    if (await isPortOpen(RAG_PORT)) running.push('8093');
    if (running.length) ok(`向量记忆没有开启，但检测到在运行（${running.join('/')}），本次不管它`);
    else ok('向量记忆已关闭，跳过（需要时 --rag，或在控制台打开 RAG 开关）');
    return;
  }

  log(`向量记忆：embedding（${EMBED_PORT}）→ memory-rag（${RAG_PORT}）`);
  const useBothUnits = platform !== 'win32'
    && await useUnit('qq-embedding.service', { home: paths.home, env: paths.env, warn })
    && await useUnit('qq-memory-rag.service', { home: paths.home, env: paths.env, warn });

  if (useBothUnits) {
    const env = paths.env;
    if (!managed) {
      ok('向量模型：自己部署 / 云端，不由本脚本管理');
    } else if (await systemdRunning('qq-embedding.service', 'embedding', { env, ok })) {
      // 已在运行
    } else if (await isPortOpen(EMBED_PORT)) {
      ok(`embedding 已在运行（${EMBED_PORT}，不是 systemd 起的，本次不管它）`);
    } else {
      const freeMiB = await gpuFreeMiB();
      if (freeMiB === null) warn('查不到显存空闲量（nvidia-smi 不可用），跳过 embedding；检索会自动只走 BM25');
      else if (freeMiB < 10000) warn(`显存空闲 ${freeMiB} MiB < 10000 MiB，跳过 embedding；检索会自动只走 BM25`);
      else if (!isExecutable(paths.embedBin) || !isFile(paths.embedModel)) warn('找不到 llama-server 或 embedding 模型，跳过 embedding');
      else {
        log('启动 embedding 服务（systemd：qq-embedding.service，约占用 9 GB 显存）...');
        const started = await systemdStart('qq-embedding.service', { env });
        if (started.code !== 0) warn('systemctl 启动 qq-embedding 失败，看：systemctl --user status qq-embedding');
        else if (await waitForHealth(EMBED_PORT, embedWaitSeconds, {
          accept: (data) => data && (data.status === 'ok' || data.ok === true)
        })) ok(`embedding 已就绪（${EMBED_PORT}）`);
        else warn(`embedding 没就绪，检索会自动降级为只走 BM25；看日志：${path.join(paths.runDir, 'embed.log')}`);
      }
    }
    if (await systemdRunning('qq-memory-rag.service', 'memory-rag', { env, ok })) {
      // 已在运行
    } else if (await isPortOpen(RAG_PORT)) {
      ok(`memory-rag 已在运行（${RAG_PORT}，不是 systemd 起的，本次不管它）`);
    } else if (!paths.ragPython) {
      warn('找不到 Python / memory-rag 虚拟环境，跳过；检索会自动降级');
    } else {
      log('启动 memory-rag 索引服务（systemd：qq-memory-rag.service）...');
      const started = await systemdStart('qq-memory-rag.service', { env });
      if (started.code !== 0) warn('systemctl 启动 qq-memory-rag 失败，看：systemctl --user status qq-memory-rag');
      else if (await waitForHealth(RAG_PORT, ragWaitSeconds, {
        accept: (data) => data && Object.prototype.hasOwnProperty.call(data, 'embedding')
      })) ok(`memory-rag 已就绪（${RAG_PORT}）`);
      else warn(`memory-rag 60s 内没就绪，检索会降级为关键词；看日志：${path.join(paths.runDir, 'memory-rag.log')}`);
    }
    return;
  }

  // 没有 systemd：detached spawn + PID 文件（Windows 与「Linux 没装 unit」同一条路）。
  if (!managed) {
    ok('向量模型：自己部署 / 云端，不由本脚本管理');
  } else if (await isPortOpen(EMBED_PORT)) {
    ok(`embedding 已在运行（${EMBED_PORT}）`);
  } else {
    try {
      const result = await startEmbeddingService({
        runDir: paths.runDir,
        embedBin: paths.embedBin,
        embedModel: paths.embedModel,
        managed: true,
        log,
        platform,
        cwd: paths.home,
        waitSeconds: ragWaitSeconds
      });
      if (result.skipped === 'no-gpu-info') warn('查不到显存空闲量（nvidia-smi 不可用），跳过 embedding；检索会自动只走 BM25');
      else if (result.skipped === 'low-vram') warn(`显存空闲 ${result.freeMiB} MiB < 10000 MiB，跳过 embedding；检索会自动只走 BM25`);
      else if (result.skipped === 'missing-files') warn('找不到 llama-server 或 embedding 模型，跳过 embedding；检索会自动只走 BM25');
      else if (result.healthy) ok(`embedding 已就绪（${EMBED_PORT}）`);
      else if (result.started) warn(`embedding 60s 内没就绪，检索会自动降级为只走 BM25；看日志：${path.join(paths.runDir, 'embed.log')}`);
    } catch (error) {
      warn(`embedding 启动失败：${error?.message ?? error}；检索会自动只走 BM25`);
    }
  }

  if (await isPortOpen(RAG_PORT)) {
    ok(`memory-rag 已在运行（${RAG_PORT}）`);
  } else {
    try {
      const result = await startMemoryRagService({
        runDir: paths.runDir,
        ragDir: paths.ragDir,
        python: paths.ragPython,
        log,
        platform,
        cwd: paths.ragDir,
        waitSeconds: ragWaitSeconds
      });
      if (result.skipped === 'missing-python') warn('找不到 Python / memory-rag 虚拟环境，跳过；检索会自动降级');
      else if (result.healthy) ok(`memory-rag 已就绪（${RAG_PORT}）`);
      else if (result.started) warn(`memory-rag 60s 内没就绪，检索会降级为关键词；看日志：${path.join(paths.runDir, 'memory-rag.log')}`);
    } catch (error) {
      warn(`memory-rag 启动失败：${error?.message ?? error}；检索会降级为关键词`);
    }
  }
}

async function stopRagSection({ paths, log, ok, warn, platform = process.platform }) {
  const managed = isEmbeddingManaged(paths.root);
  if (platform !== 'win32' && await useUnit('qq-memory-rag.service', { home: paths.home, env: paths.env, warn })) {
    await systemdStop('qq-memory-rag.service', 'memory-rag', { env: paths.env, log, ok, warn });
    if (await isPortOpen(RAG_PORT) || readPidFile(path.join(paths.runDir, 'memory-rag.pid'))) {
      await stopService({
        pidFile: path.join(paths.runDir, 'memory-rag.pid'),
        label: 'memory-rag（systemd 之外）',
        patterns: ['memory_rag.app'],
        port: RAG_PORT,
        platform, log, ok, warn
      });
    }
  } else {
    await stopService({
      pidFile: path.join(paths.runDir, 'memory-rag.pid'),
      label: 'memory-rag',
      patterns: platform === 'win32' ? ['python.exe'] : ['memory_rag.app'],
      image: 'python.exe',
      port: RAG_PORT,
      platform, log, ok, warn
    });
  }

  if (!managed) {
    ok('向量模型：自己部署 / 云端，不由本脚本管理');
    return;
  }
  if (platform !== 'win32' && await useUnit('qq-embedding.service', { home: paths.home, env: paths.env, warn })) {
    await systemdStop('qq-embedding.service', 'embedding', { env: paths.env, log, ok, warn });
    if (await isPortOpen(EMBED_PORT) || readPidFile(path.join(paths.runDir, 'embed.pid'))) {
      await stopService({
        pidFile: path.join(paths.runDir, 'embed.pid'),
        label: 'embedding（systemd 之外）',
        patterns: ['llama-server'],
        port: EMBED_PORT,
        platform, log, ok, warn
      });
    }
  } else {
    await stopService({
      pidFile: path.join(paths.runDir, 'embed.pid'),
      label: 'embedding',
      patterns: platform === 'win32' ? ['llama-server.exe'] : ['llama-server'],
      image: 'llama-server.exe',
      port: EMBED_PORT,
      platform, log, ok, warn
    });
  }
}

async function startDsh({ paths, log, ok, err, platform, onSpawn }) {
  if (await isPortOpen(DSH_PORT)) {
    ok(`DSH 已在运行（${DSH_PORT}）`);
    return true;
  }
  const { command, args, cwd } = paths.dshCommand;
  const resolved = path.isAbsolute(command)
    ? (isFile(command) ? command : null)
    : findExecutable(command, { env: paths.env, platform });
  if (!resolved && command !== paths.nodeBin) {
    err(`找不到 DSH 启动命令：${command}（可用 DSH_DIR 或 config.json 的 orchestrator.dshCommand 指定）`);
    return false;
  }
  const spec = commandSpec(command, args, { platform, env: paths.env, nodeBin: paths.nodeBin });
  // 与旧脚本一致：非交互环境（systemd / 远程 shell）不一定加载了 nvm 与 pnpm 的 PATH。
  const dshEnv = { ...paths.env };
  const extraPath = [];
  if (path.isAbsolute(paths.nodeBin)) extraPath.push(path.dirname(paths.nodeBin));
  if (dshEnv.PNPM_HOME) extraPath.push(path.join(dshEnv.PNPM_HOME, 'bin'), dshEnv.PNPM_HOME);
  extraPath.push(path.join(paths.home, '.local', 'share', 'pnpm', 'bin'));
  dshEnv.PATH = [...extraPath, dshEnv.PATH || ''].filter(Boolean).join(path.delimiter);
  const pid = await spawnService({
    spec,
    cwd,
    logFile: path.join(paths.runDir, 'dsh.log'),
    label: 'DSH',
    log, err, platform,
    env: dshEnv
  });
  if (!pid) return false;
  onSpawn?.(pid);
  writePidFile(path.join(paths.runDir, 'dsh.pid'), pid);
  if (!(await waitForPort(DSH_PORT, 45))) {
    err(`DSH 45s 内没有监听 ${DSH_PORT}；看日志：${path.join(paths.runDir, 'dsh.log')}`);
    return false;
  }
  ok(`DSH 已就绪（${DSH_PORT}）`);
  return true;
}

async function qqRunning(paths, platform) {
  if (!paths.qqBin) return false;
  if (isPidAlive(readPidFile(path.join(paths.runDir, 'qq.pid')))) return true;
  if (platform === 'win32') {
    return (await findPidsByImage(path.basename(paths.qqBin))).length > 0;
  }
  return (await findPidsByPattern(`^${escapeRegExp(paths.qqBin)}( |$)`)).length > 0;
}

async function startQq({ paths, log, ok, err, platform }) {
  if (await qqRunning(paths, platform)) {
    ok('QQ 已在运行');
    return true;
  }
  if (!isFile(paths.qqBin)) {
    err(`没找到 QQ：${paths.qqBin}（可用 QQ_BIN 或 config.json 的 orchestrator.qqBin 指定）`);
    return false;
  }
  const spec = commandSpec(paths.qqBin, paths.qqArgs, { platform, env: paths.env, nodeBin: paths.nodeBin });
  // 旧脚本在 Linux 上给 QQ 补了图形会话环境变量；从 systemd/非交互 shell 调起来时
  // DISPLAY / DBUS 可能不在环境里，这里保持同样的缺省。
  const qqEnv = { ...paths.env };
  if (platform !== 'win32') {
    qqEnv.DISPLAY = qqEnv.DISPLAY || ':0';
    if (typeof process.getuid === 'function') {
      qqEnv.XDG_RUNTIME_DIR = qqEnv.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
      qqEnv.DBUS_SESSION_BUS_ADDRESS = qqEnv.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`;
    }
  }
  const pid = await spawnService({
    spec,
    cwd: paths.home,
    logFile: path.join(paths.runDir, 'qq.log'),
    label: 'QQ',
    log, err, platform,
    env: qqEnv
  });
  if (!pid) return false;
  writePidFile(path.join(paths.runDir, 'qq.pid'), pid);
  await sleep(3000);
  if (!(await qqRunning(paths, platform))) {
    err(`QQ 没起来，看日志：${path.join(paths.runDir, 'qq.log')}`);
    return false;
  }
  ok('QQ 已启动');
  return true;
}

async function checkSnowLumaCap(nodeBin, { err, platform = process.platform }) {
  if (platform === 'win32') return true;
  if (hasPtraceCap(nodeBin)) return true;
  err('node 缺少 cap_sys_ptrace，SnowLuma 无法注入 QQ。先执行：');
  try {
    const real = fs.realpathSync(nodeBin);
    err(`  sudo setcap cap_sys_ptrace=ep "${real}"`);
  } catch {
    err(`  sudo setcap cap_sys_ptrace=ep "${nodeBin}"`);
  }
  return false;
}

/**
 * 起任何服务之前查一遍 node：只查这次真要起的服务。要等 DSH、QQ 都起来才发现 SnowLuma 不能用，
 * 用户就得面对一堆半启动的进程。
 */
export async function checkNodeForServices({
  paths,
  platform = process.platform,
  warn,
  err,
  portOpen = isPortOpen,
  capCheck = checkSnowLumaCap
}) {
  let good = true;
  if (!(await portOpen(DSH_PORT))) {
    const requirement = dshNodeRequirement(paths);
    const problem = nodeVersionProblem({ paths, requirement });
    if (problem.length && requirement.strict) {
      for (const line of problem) err(line);
      good = false;
    } else if (problem.length) {
      warn(problem[0]);
    }
  }
  if (!(await portOpen(SNOW_PORT)) && !(await capCheck(paths.nodeBin, { err, platform }))) good = false;
  return good;
}

/**
 * SnowLuma 启动环境：默认打开 SNOWLUMA_HOOK_AUTOLOAD，让它注入 start-all 刚拉起的 QQ。
 * 用户已在环境里显式设置（任意非空值）时原样保留。
 */
export function snowLumaEnv(env = process.env) {
  const out = { ...env };
  if (!String(out.SNOWLUMA_HOOK_AUTOLOAD ?? '').trim()) out.SNOWLUMA_HOOK_AUTOLOAD = '1';
  return out;
}

async function startSnowLuma({ paths, log, ok, err, platform }) {
  if (await isPortOpen(SNOW_PORT)) {
    ok(`SnowLuma 已在运行（${SNOW_PORT}）`);
    return true;
  }
  if (!paths.snowLaunch) {
    err(`找不到 SnowLuma 目录：${paths.snowDir || '(空)'}。可用 SNOW_DIR 或 config.json 的 orchestrator.snowDir 指定`);
    return false;
  }
  if (platform !== 'win32' && !(await checkSnowLumaCap(paths.nodeBin, { err, platform }))) return false;
  const launch = paths.snowLaunch;
  const command = launch.kind === 'node' ? paths.nodeBin : path.join(paths.snowDir,
    launch.kind === 'exe' ? 'SnowLuma.exe' : 'launcher.bat');
  const spec = commandSpec(command, launch.args, { platform, env: paths.env, nodeBin: paths.nodeBin });
  // 启动器要负责让 SnowLuma 注入刚起来的 QQ：`hookAutoLoad` 只看启动那一刻已经存在的
  // QQ 进程，而这里刚 spawn 的 QQ 往往还在登录窗口。SnowLuma 的 env 覆盖优先于
  // runtime.json，且不会被它启动时重写掉，所以用 env 打开自动注入；
  // 用户显式设了 SNOWLUMA_HOOK_AUTOLOAD 就尊重用户的值。
  const snowEnv = snowLumaEnv(paths.env);
  const pid = await spawnService({
    spec,
    cwd: launch.cwd,
    logFile: path.join(paths.runDir, 'snowluma.log'),
    label: 'SnowLuma',
    log, err, platform,
    env: snowEnv
  });
  if (!pid) return false;
  writePidFile(path.join(paths.runDir, 'snowluma.pid'), pid);
  if (!(await waitForPort(SNOW_PORT, 25))) {
    err(`SnowLuma 25s 内没有监听 ${SNOW_PORT}；看日志：${path.join(paths.runDir, 'snowluma.log')}`);
    return false;
  }
  ok(`SnowLuma 已就绪（${SNOW_PORT}）`);
  return true;
}

async function startBridge({ paths, log, ok, err, platform, env = paths.env }) {
  const bridgePid = path.join(paths.runDir, 'bridge.pid');
  const bridgeLog = path.join(paths.runDir, 'bridge.log');
  if (await isPortOpen(BRIDGE_PORT)) {
    ok(`qq-bridge 已在运行（${BRIDGE_PORT}）`);
    return true;
  }
  if (platform !== 'win32' && await useUnit('qq-bridge.service', { home: paths.home, env: paths.env, warn: (m) => log(`warn: ${m}`) })) {
    if (await systemdRunning('qq-bridge.service', 'qq-bridge', { env: paths.env, ok })) return true;
    const offset = fileSize(bridgeLog);
    log('启动 qq-bridge（systemd：qq-bridge.service）...');
    const started = await systemdStart('qq-bridge.service', { env: paths.env });
    if (started.code !== 0) {
      err('systemctl 启动 qq-bridge 失败，看：systemctl --user status qq-bridge');
      return false;
    }
    if (!(await waitForPort(BRIDGE_PORT, 40))) {
      err(`qq-bridge 40s 内没有监听 ${BRIDGE_PORT}；看日志：${bridgeLog}`);
      return false;
    }
    if (await waitForLog(bridgeLog, { seconds: 20, needle: 'SnowLuma 已连接', offset })) ok('qq-bridge 已连接 SnowLuma');
    else log(`warn: qq-bridge 已启动，但还没看到「SnowLuma 已连接」，看日志：${bridgeLog}`);
    ok(`qq-bridge 已就绪（${BRIDGE_PORT}）`);
    return true;
  }

  const offset = fileSize(bridgeLog);
  const spec = commandSpec(paths.nodeBin, [path.join(paths.root, 'src', 'bridge.js')], { platform, env, nodeBin: paths.nodeBin });
  const pid = await spawnService({
    spec,
    cwd: paths.root,
    logFile: bridgeLog,
    label: 'qq-bridge',
    log, err, platform,
    env
  });
  if (!pid) return false;
  writePidFile(bridgePid, pid);
  if (!(await waitForPort(BRIDGE_PORT, 40))) {
    err(`qq-bridge 40s 内没有监听 ${BRIDGE_PORT}；看日志：${bridgeLog}`);
    return false;
  }
  if (await waitForLog(bridgeLog, { seconds: 20, needle: 'SnowLuma 已连接', offset })) ok('qq-bridge 已连接 SnowLuma');
  else log(`warn: qq-bridge 已启动，但还没看到「SnowLuma 已连接」，看日志：${bridgeLog}`);
  ok(`qq-bridge 已就绪（${BRIDGE_PORT}）`);
  return true;
}

async function startGsv({ paths, log, ok, warn, platform }) {
  if (!paths.startGsv) {
    ok('GPT-SoVITS 已停用，跳过（需要时 START_GSV=1）');
    return;
  }
  if (await isPortOpen(GSV_PORT)) {
    ok(`GPT-SoVITS API 已在运行（${GSV_PORT}）`);
    return;
  }
  if (!paths.gsvPython || !isFile(path.join(paths.gsvDir, 'api_v2.py'))) {
    warn(`没找到 GPT-SoVITS（${paths.gsvDir}），跳过语音生成`);
    return;
  }
  const spec = commandSpec(paths.gsvPython.command, [
    ...paths.gsvPython.args,
    'api_v2.py', '-a', '127.0.0.1', '-p', String(GSV_PORT),
    '-c', 'GPT_SoVITS/configs/tts_infer.yaml'
  ], { platform, env: paths.env, nodeBin: paths.nodeBin });
  const pid = await spawnService({
    spec,
    cwd: paths.gsvDir,
    logFile: path.join(paths.runDir, 'gsv.log'),
    label: 'GPT-SoVITS API',
    log, err: warn, platform,
    env: paths.env
  });
  if (!pid) return;
  writePidFile(path.join(paths.runDir, 'gsv.pid'), pid);
  if (await waitForPort(GSV_PORT, 120)) ok(`GPT-SoVITS API 已就绪（${GSV_PORT}）`);
  else warn(`GPT-SoVITS 没起来，语音生成暂时不可用；看日志：${path.join(paths.runDir, 'gsv.log')}`);
}

// ── Windows 一键启动：用户自己用 SnowLuma 注入 QQ，本脚本只负责 DSH + 桥接 ──────────
//
// 约定（README.windows.md）：用户先打开 SnowLuma、注入 QQ、确认 OneBot 的 HTTP / WebSocket
// 服务已开启，然后双击 start-all.bat。这里依次：
//   ① config.json（没有就从示例生成，并在控制台问管理员 QQ；依赖由 scripts/start-all.mjs 先装好）；
//   ② 把 QQ 预设 / MCP 装进 DSH 的 web 与 desktop 两个 profile（scripts/setup-dsh.mjs，幂等）；
//   ③ DSH：桌面版已开就用桌面版（随机端口，按进程发现），否则用 / 起 `dsh web`（3080）；
//      ②改动了正在运行的那个 profile 时，必须重启 DSH 才加载得到；
//   ④ 等 OneBot：WS / HTTP 端口通了以后，自动从 SnowLuma 的 config 里找出能用的 token 写回 config.json；
//   ⑤ 起 qq-bridge，等到「SnowLuma 已连接」与「DSH 已就绪」都出现才算成功。

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const text = fs.readFileSync(file, 'utf8');
  const bom = text.charCodeAt(0) === 0xfeff ? String.fromCharCode(0xfeff) : '';
  fs.writeFileSync(file, `${bom}${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * 控制台交互：非交互环境（被别的程序调用、输出被重定向）直接返回 null。
 * yesNo 问题在 QQB_ASSUME_YES=1 时直接回答 y（无人值守 / 计划任务里跑 start-all）。
 */
async function ask(question, { yesNo = false } = {}) {
  if (yesNo && process.env.QQB_ASSUME_YES === '1') {
    process.stdout.write(`${question}y（QQB_ASSUME_YES=1）\n`);
    return 'y';
  }
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^\[|\]$/g, '') || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

function portOf(url, fallback) {
  try {
    const u = new URL(String(url));
    return Number(u.port) || fallback;
  } catch {
    return fallback;
  }
}

/** ① config.json：没有就从示例生成；没填管理员 QQ 时在控制台问一次。 */
async function ensureConfigFile({ root, log, ok, warn, err }) {
  const file = path.join(root, 'config.json');
  if (!isFile(file)) {
    const example = path.join(root, 'config.example.json');
    if (!isFile(example)) {
      err(`找不到 ${example}`);
      return false;
    }
    fs.copyFileSync(example, file);
    ok('已从 config.example.json 生成 config.json');
  }
  const cfg = readJson(file);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    err(`config.json 不是合法的 JSON：${file}（用记事本打开检查逗号 / 引号）`);
    return false;
  }
  const hasOwner = /^\d{5,12}$/.test(String(cfg.ownerQQ ?? ''));
  const allowCount = (cfg.allow?.private?.length ?? 0) + (cfg.allow?.groups?.length ?? 0);
  if (hasOwner && allowCount) {
    ok(`config.json：管理员 QQ ${cfg.ownerQQ}，白名单 ${allowCount} 项`);
    return true;
  }
  log('config.json 还没填管理员 QQ / 白名单：机器人只会回复白名单里的人。');
  const answer = await ask('  请输入你自己的 QQ 号（管理员，会加进私聊白名单；直接回车跳过）：');
  if (answer && /^\d{5,12}$/.test(answer)) {
    cfg.ownerQQ = Number(answer);
    cfg.allow = cfg.allow && typeof cfg.allow === 'object' ? cfg.allow : {};
    const list = Array.isArray(cfg.allow.private) ? cfg.allow.private.map(Number) : [];
    if (!list.includes(Number(answer))) list.push(Number(answer));
    cfg.allow.private = list;
    if (!Array.isArray(cfg.allow.groups)) cfg.allow.groups = [];
    writeJson(file, cfg);
    ok(`已写入 config.json：ownerQQ=${answer}，allow.private=[${list.join(', ')}]`);
  } else {
    warn('没有填写：白名单为空时机器人谁都不理。之后可编辑 config.json 的 ownerQQ / allow.private，或在控制台填写');
  }
  return true;
}

/** ② 跑 setup-dsh（幂等）；返回是否改动、改动了哪些 profile。 */
async function runSetupDsh({ paths, env, log, ok, warn }) {
  const logFile = path.join(paths.runDir, 'setup-dsh.log');
  const r = await execFileP(paths.nodeBin, [path.join(paths.root, 'scripts', 'setup-dsh.mjs')], {
    cwd: paths.root, env, timeout: 300000
  });
  const output = `${r.stdout}\n${r.stderr}`;
  try { fs.writeFileSync(logFile, output, 'utf8'); } catch { /* 日志写不了不影响结果 */ }
  const result = /RESULT changed=(\d) profiles=(\S*) changedProfiles=(\S*)/.exec(output);
  if (r.code !== 0 || !result) {
    warn(`把 QQ 预设 / MCP 装进 DSH 失败（完整输出：${logFile}）：`);
    for (const line of output.split(/\r?\n/).filter((l) => /ERROR|失败|failed/i.test(l)).slice(-6)) warn(`  ${line}`);
    return { ok: false, changed: false, changedProfiles: [] };
  }
  const changed = result[1] === '1';
  const changedProfiles = result[3] ? result[3].split(',').filter(Boolean) : [];
  ok(changed
    ? `QQ 预设 / MCP 已装进 DSH（profile：${result[2]}）`
    : `DSH 里的 QQ 预设 / MCP 已是最新（profile：${result[2]}）`);
  return { ok: true, changed, changedProfiles };
}

function profileOf(endpoint) {
  return endpoint?.kind === 'desktop' ? 'desktop' : 'web';
}

/** 桌面版 exe：从 dsh CLI（Electron 垫片）反推，找不到返回 ''。 */
function desktopExe(env) {
  const cli = findDshCli({ env });
  const shim = cli ? resolveElectronShim(cli) : null;
  return shim?.command ?? '';
}

async function waitForEndpoint(options, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const found = await resolveDshEndpoint(options).catch(() => null);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(2000);
  }
}

async function launchDesktop({ paths, env, log, ok, err, platform, dshOptions, onSpawn }) {
  const exe = desktopExe(env);
  if (!exe) {
    err(`找不到 DSH 桌面版。装了桌面版就先手动打开它；没装请用 ${entryName('start-all', platform)} --web`);
    return null;
  }
  const pid = await spawnService({
    spec: { command: exe, args: [] },
    cwd: path.dirname(exe),
    logFile: path.join(paths.runDir, 'dsh-desktop.log'),
    label: 'DSH 桌面版',
    log, err, platform, env,
    windowsHide: false
  });
  if (!pid) return null;
  onSpawn?.(pid);
  log('等待桌面版就绪（第一次打开可能要登录 DeepSeek 账号，最多 120 秒）...');
  const found = await waitForEndpoint({ ...dshOptions, target: 'desktop' }, 120);
  if (!found) err(`桌面版 120 秒内没有就绪；看日志：${path.join(paths.runDir, 'dsh-desktop.log')}`);
  if (onSpawn && found?.appPid !== pid) return null;
  return found;
}

async function startDshWeb({ paths, env, log, ok, err, platform, dshOptions }) {
  const started = await startDsh({ paths: { ...paths, env }, log, ok, err, platform });
  if (!started) return null;
  return waitForEndpoint({ ...dshOptions, target: 'web' }, 30);
}

/** 停掉正在运行的 DSH，用于「profile 改了必须重启」。 */
async function stopRunningDsh(endpoint, { paths, log, platform }) {
  if (endpoint.kind === 'desktop') {
    const pid = endpoint.appPid || endpoint.pid;
    log(`关闭 DSH 桌面版（PID ${pid}）...`);
    await stopPid(pid, { platform, timeoutMs: 15000, label: 'DSH 桌面版' });
    // 桌面版主进程退出后 Host 子进程会跟着退；保险起见再等端口释放。
    for (let i = 0; i < 20 && await isPortOpen(portOf(endpoint.baseUrl, 0)); i += 1) await sleep(500);
    return;
  }
  const pidFile = path.join(paths.runDir, 'dsh.pid');
  const own = readPidFile(pidFile);
  const pids = own && isPidAlive(own) ? [own] : (await processChainForPort(DSH_PORT, { platform })).slice(0, 1).map((p) => p.pid);
  for (const pid of pids) {
    log(`停止 dsh web（PID ${pid}）...`);
    await stopPid(pid, { platform, timeoutMs: 15000, label: 'dsh web' });
  }
  removePidFile(pidFile);
  for (let i = 0; i < 20 && await isPortOpen(DSH_PORT); i += 1) await sleep(500);
}

/** ③ 确保有一个可用的 DSH，并且它已经加载了本项目的 profile 改动。 */
async function ensureDshDetected({ paths, env, target, setup, log, ok, warn, err, platform, preserveRunning = false }) {
  const dshOptions = { baseUrl: paths.config?.dsh?.baseUrl || `http://127.0.0.1:${DSH_PORT}`, target, platform };
  let endpoint = await resolveDshEndpoint(dshOptions).catch(() => null);
  if (endpoint) {
    ok(`检测到正在运行的 ${describeEndpoint(endpoint)}`);
    if (endpoint.homeMismatch) warn(`桌面版的数据目录是 ${endpoint.dshHome}，与本脚本的 DSH_HOME 不同，桥接可能鉴权失败`);
    const profile = profileOf(endpoint);
    const needsRestart = setup.changed && (setup.changedProfiles.length === 0 || setup.changedProfiles.includes(profile));
    if (!needsRestart) return endpoint;
    warn(`刚把 QQ 预设 / MCP 装进 profile「${profile}」，正在运行的 DSH 要重启一次才会加载`);
    if (preserveRunning) return endpoint;
    const answer = await ask('  现在由脚本自动重启 DSH 吗？[Y/n]（DSH 里正在跑的任务会被中断）：', { yesNo: true });
    if (answer === null || /^n/i.test(answer)) {
      warn(`没有重启：请自己完全退出 DSH（桌面版要在托盘 / 菜单栏里退出）再打开，然后重新运行 ${entryName('start-all', platform)}`);
      return answer === null ? endpoint : null;
    }
    await stopRunningDsh(endpoint, { paths, log, platform });
    endpoint = endpoint.kind === 'desktop'
      ? await launchDesktop({ paths, env, log, ok, err, platform, dshOptions })
      : await startDshWeb({ paths, env, log, ok, err, platform, dshOptions });
  } else if (target === 'desktop') {
    log('没有检测到运行中的 DSH，按 --desktop 打开桌面版');
    endpoint = await launchDesktop({ paths, env, log, ok, err, platform, dshOptions });
  } else {
    log('没有检测到运行中的 DSH（桌面版没开、3080 也没有 dsh web），启动 dsh web');
    endpoint = await startDshWeb({ paths, env, log, ok, err, platform, dshOptions });
  }
  if (endpoint) ok(`DSH 已就绪：${describeEndpoint(endpoint)}`);
  return endpoint;
}

/** ④ 等用户开好 OneBot，再找出 HTTP / WS 各自能用的 token 写回 config.json。 */
async function ensureOneBotUserManaged({ paths, env, log, ok, warn, err, platform }) {
  const cfgFile = path.join(paths.root, 'config.json');
  const cfg = readJson(cfgFile) ?? {};
  const sl = cfg.snowluma ?? {};
  const wsUrl = String(env.SNOWLUMA_WS_URL || sl.wsUrl || 'ws://127.0.0.1:3001');
  const httpUrl = String(env.SNOWLUMA_HTTP_URL || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const wsPort = portOf(wsUrl, 3001);
  const httpPort = portOf(httpUrl, 3000);
  const wsHost = hostOf(wsUrl);
  const httpHost = hostOf(httpUrl);
  const waitSeconds = Number(env.QQB_ONEBOT_WAIT_SECONDS) || 300;

  log(`等待 SnowLuma 的 OneBot 服务（WebSocket ${wsHost}:${wsPort} / HTTP ${httpHost}:${httpPort}）...`);
  const deadline = Date.now() + waitSeconds * 1000;
  let hinted = 0;
  for (;;) {
    const [wsOpen, httpOpen] = await Promise.all([isPortOpen(wsPort, { host: wsHost }), isPortOpen(httpPort, { host: httpHost })]);
    if (wsOpen && httpOpen) break;
    if (Date.now() >= deadline) {
      err(`等了 ${waitSeconds} 秒，OneBot 仍未就绪（WebSocket ${wsPort}：${wsOpen ? '已开' : '未开'}，HTTP ${httpPort}：${httpOpen ? '已开' : '未开'}）`);
      err('  请在 SnowLuma 里确认：QQ 已注入并登录；OneBot 网络配置里 HTTP 服务端与 WebSocket 服务端都已启用');
      err('  端口不是 3000/3001 时，把 config.json 的 snowluma.httpUrl / snowluma.wsUrl 改成实际地址');
      return null;
    }
    if (Date.now() - hinted > 30000) {
      hinted = Date.now();
      log(`  WebSocket ${wsPort}：${wsOpen ? '已开' : '未开'}，HTTP ${httpPort}：${httpOpen ? '已开' : '未开'}`);
      log('  → 请打开 SnowLuma，注入 QQ 并登录，确认 OneBot 的 HTTP 服务端（3000）与 WebSocket 服务端（3001）已启用');
      // SnowLuma 2.3 起第一次运行要在 WebUI 里同意协议，没同意之前什么都不会开。这是用户本人的决定，脚本不替他同意。
      log('  → SnowLuma 2.3 及以上第一次运行时，要先打开它的 WebUI（默认 http://127.0.0.1:5099）同意用户协议与隐私政策');
      log(`  （最多再等 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒；Ctrl+C 可退出）`);
    }
    await sleep(2000);
  }
  ok(`OneBot 端口已开（WebSocket ${wsPort} / HTTP ${httpPort}）`);

  // token：先找 SnowLuma 目录（config / 进程 / 常见位置），再逐个试。
  let homes = await locateSnowLumaHomes({ config: cfg, env, wsPort, platform, home: paths.home });
  let http = await discoverSnowLumaConnection({ cfg, baseUrl: httpUrl, homeDirs: homes.map((h) => h.dir), timeoutMs: 5000 });
  if (!http.ok && !homes.length) {
    warn('没找到 SnowLuma 的安装目录，读不到它生成的 token');
    const answer = await ask('  请输入 SnowLuma 所在文件夹（含 config 子目录；直接回车跳过）：');
    if (answer) {
      homes = await locateSnowLumaHomes({ config: { snowluma: { homeDir: answer.replace(/^"|"$/g, '') } }, env: {}, platform, home: paths.home });
      http = await discoverSnowLumaConnection({ cfg, baseUrl: httpUrl, homeDirs: homes.map((h) => h.dir), timeoutMs: 5000 });
    }
  }
  if (!http.ok) {
    err(`OneBot HTTP 鉴权失败：${http.error}`);
    err('  解决：在 config.json 的 snowluma.homeDir 填 SnowLuma 文件夹，或把 SnowLuma 网络配置里 HTTP 服务端的 token 填进 snowluma.accessToken');
    return null;
  }
  const self = http.self ?? {};
  ok(`OneBot HTTP 可用（token 来源：${http.source}），QQ 账号：${self.nickname ?? '?'}（${self.user_id ?? '?'}）`);

  // 候选顺序：用户显式给的 → 与可用 HTTP token 同一文件里的 WS token → 其它 SnowLuma 目录里同账号的 →
  // config.json 里存过的（可能是旧安装的，放后面）→ 兜底用 HTTP token / 空 token。
  const wsCandidates = [...new Set([
    env.SNOWLUMA_WS_TOKEN,
    ...(http.wsCandidates ?? []).map((w) => w.token),
    http.wsToken,
    sl.wsAccessToken,
    sl.accessToken,
    http.token,
    ''
  ].filter((t) => t !== undefined && t !== null))];
  const wsTarget = http.wsUrl && sl.followDiscoveredEndpoint !== false ? http.wsUrl : wsUrl;
  let wsToken = null;
  for (const token of wsCandidates) {
    if ((await probeOneBotWs(wsTarget, token)).ok) { wsToken = token; break; }
  }
  if (wsToken === null) {
    err(`OneBot WebSocket（${wsTarget}）拒绝了所有候选 token（试了 ${wsCandidates.length} 个）`);
    err('  解决：把 SnowLuma 网络配置里 WebSocket 服务端的 token 填进 config.json 的 snowluma.wsAccessToken');
    return null;
  }
  ok(`OneBot WebSocket 可用（${wsTarget}）`);

  // homeDir 用「token 真的能用」的那份 SnowLuma；桥接换账号自愈时会先读它。
  const homeDir = http.homeDir || homes.find((h) => readOneBotTokensSafe(h.dir))?.dir || homes[0]?.dir || '';
  const stale = homes.filter((h) => homeDir && path.resolve(h.dir).toLowerCase() !== path.resolve(homeDir).toLowerCase());
  if (stale.length) {
    warn(`机器上还有别的 SnowLuma 目录（${stale.map((h) => h.dir).join('、')}），当前用的是 ${homeDir}；旧的不用了可以删掉`);
  }
  const write = persistSnowLumaEndpoint(cfgFile, {
    accessToken: http.token,
    wsAccessToken: wsToken,
    wsUrl: wsTarget,
    httpUrl: http.baseUrl
  });
  const homeChanged = Boolean(homeDir) && String(sl.homeDir ?? '') !== homeDir;
  if (homeChanged) {
    const next = readJson(cfgFile);
    next.snowluma = { ...(next.snowluma ?? {}), homeDir };
    writeJson(cfgFile, next);
  }
  if (write.updated || homeChanged) ok('已把可用的 OneBot 地址 / token 写回 config.json');
  return { self, homeDir };
}

function readOneBotTokensSafe(dir) {
  try { return fs.readdirSync(path.join(dir, 'config')).some((name) => /^onebot_\d+\.json$/i.test(name)); } catch { return false; }
}

/** ⑤ 起桥接，直到「SnowLuma 已连接」「DSH 已就绪」都出现；进程提前退出就把日志尾巴打出来。 */
async function startBridgeWatched({ paths, env, log, ok, warn, err, platform }) {
  const bridgePid = path.join(paths.runDir, 'bridge.pid');
  const bridgeLog = path.join(paths.runDir, 'bridge.log');
  if (await isPortOpen(BRIDGE_PORT)) {
    ok(`qq-bridge 已在运行（${BRIDGE_PORT}）`);
    return true;
  }
  const offset = fileSize(bridgeLog);
  const spec = commandSpec(paths.nodeBin, [path.join(paths.root, 'src', 'bridge.js')], { platform, env, nodeBin: paths.nodeBin });
  const pid = await spawnService({ spec, cwd: paths.root, logFile: bridgeLog, label: 'qq-bridge', log, err, platform, env });
  if (!pid) return false;
  writePidFile(bridgePid, pid);
  return waitForBridgeStartup({ pid, bridgePid, bridgeLog, offset, port: BRIDGE_PORT, ok, warn, err });
}

async function waitForBridgeStartup({ pid, bridgePid, bridgeLog, offset, port, ok, warn, err, managed = false }) {
  const deadline = Date.now() + 60000;
  const need = { dsh: 'DSH 已就绪' };
  if (managed) need.console = `本地控制台已启动：http://127.0.0.1:${port}`;
  else need.snow = 'SnowLuma 已连接';
  const seen = new Set();
  for (;;) {
    const text = readFromOffset(bridgeLog, offset);
    for (const [key, needle] of Object.entries(need)) if (text.includes(needle)) seen.add(key);
    if (!isPidAlive(pid)) {
      if (managed) err(`qq-bridge 启动后退出了；看日志：${bridgeLog}`);
      else {
        err('qq-bridge 启动后退出了，日志最后几行：');
        for (const line of text.split(/\r?\n/).filter(Boolean).slice(-12)) err(`  ${line}`);
      }
      removePidFile(bridgePid);
      return false;
    }
    if (seen.size === Object.keys(need).length && await isPortOpen(port)) {
      if (managed && !text.includes('SnowLuma 已连接')) warn(`SnowLuma 尚未连接，桥接会继续尝试；看日志：${bridgeLog}`);
      break;
    }
    if (Date.now() >= deadline) {
      if (!managed && !seen.has('snow')) warn(`qq-bridge 60 秒内没连上 SnowLuma；看日志：${bridgeLog}`);
      if (!seen.has('dsh')) warn(`qq-bridge 60 秒内没连上 DSH；看日志：${bridgeLog}`);
      if (managed) {
        if (!seen.has('console')) warn(`qq-bridge 控制台没有启动；看日志：${bridgeLog}`);
        return false;
      }
      return isPortOpen(port);
    }
    await sleep(1000);
  }
  ok(managed ? 'qq-bridge 已启动控制台并连接 DSH' : 'qq-bridge 已连接 SnowLuma 与 DSH');
  return true;
}

function managedWebBase(baseUrl) {
  return typeof baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:3080\/?$/.test(baseUrl);
}

async function verifyManagedTextPreset(endpoint) {
  const { CHANNEL_DSH_TEXT_PRESET, confirmChannelPreset } = await import('../core/channel-dsh-preset.mjs');
  return confirmChannelPreset(new NodeApiClient(endpoint.baseUrl, 8000), {
    preset: CHANNEL_DSH_TEXT_PRESET, signal: AbortSignal.timeout(8000),
  });
}

/** Return null to reuse existing services. A failed owned launch returns an explicit failure. */
export async function startManagedChannelServices({
  paths, env, bridgeEnv, target, platform, setup, log, ok, warn, err,
}, {
  portOpen = isPortOpen, discover = resolveDshEndpoint, listDesktopHosts = findDesktopHosts,
  findImage = findPidsByImage, startBridge = launchChannelToolBridge,
  startWeb = startDsh, startDesktop = launchDesktop, waitBridge = waitForBridgeStartup, stop = stopPid,
  verifyTextPreset = verifyManagedTextPreset,
  serviceRunning = async () => {
    const unit = 'qq-bridge.service';
    return platform !== 'win32' && await useUnit(unit, { home: paths.home, env, warn }) &&
      await systemdRunning(unit, 'qq-bridge', { env, ok });
  },
} = {}) {
  if (!channelTextToolsEnabled(paths.config)) return null;
  const port = Number(paths.config?.consolePort) || BRIDGE_PORT;
  const baseUrl = paths.config?.dsh?.baseUrl || `http://127.0.0.1:${DSH_PORT}`;
  const managedTarget = target === 'desktop' ? 'desktop' : 'web';
  const dshOptions = { baseUrl, target: 'auto', platform };
  const desktop = managedTarget === 'desktop' && platform === 'win32' ? desktopExe(env) : '';
  if (!setup.ok || !managedWebBase(baseUrl) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      (managedTarget === 'desktop' && !desktop)) {
    warn('渠道文本工具未启用：需要可由启动器管理的本机 DSH 与已安装的预设。');
    return null;
  }
  if (await portOpen(port) || await serviceRunning() || await portOpen(DSH_PORT) ||
      await discover(dshOptions).catch(() => null) ||
      (desktop && ((await listDesktopHosts({ platform })).length ||
        (await findImage(path.basename(desktop), { platform })).length))) {
    warn('检测到已运行的桥接或 DSH，本次沿用现有服务；渠道文本工具需要由启动器同时启动两个服务。');
    return null;
  }
  const bridgePid = path.join(paths.runDir, 'bridge.pid');
  const bridgeLog = path.join(paths.runDir, 'bridge.log');
  const offset = fileSize(bridgeLog);
  const bridgeEntry = path.join(paths.root, 'src', 'bridge.js');
  const spec = commandSpec(paths.nodeBin, [bridgeEntry], { platform, env: bridgeEnv, nodeBin: paths.nodeBin });
  let ownedBridge;
  let ownedDsh;
  let ready = false;
  const onSpawn = (pid) => { ownedDsh = pid; };
  async function stopOwned(pid, label) {
    if (!pid) return;
    const result = await stop(pid, { platform, timeoutMs: 15_000, label });
    if (!result.ok) warn(`${label} 启动失败后的停止操作未完成（PID ${pid}）`);
  }
  try {
    log('启动桥接，等待渠道文本工具回环服务...');
    const { pid, credentials } = await startBridge({
      ...spec, cwd: paths.root, logFile: bridgeLog,
      env: { ...bridgeEnv, ...spec.env, QQ_BRIDGE_DSH_TARGET: managedTarget },
    });
    ownedBridge = pid;
    writePidFile(bridgePid, pid);
    if (!credentials) warn('渠道文本工具回环服务不可用，本次以零工具模式启动。');

    const launchEnv = channelToolDshEnv(withoutChannelPlatformEnv(env, paths.config), credentials);
    const options = { paths: { ...paths, env: launchEnv }, env: launchEnv, log, ok, err, platform, onSpawn };
    const endpoint = managedTarget === 'desktop'
      ? await startDesktop({ ...options, dshOptions: { ...dshOptions, target: 'desktop' } })
      : await startWeb(options) && { baseUrl, kind: 'web' };
    if (!endpoint || (credentials && !ownedDsh) ||
        !await waitBridge({ pid, bridgePid, bridgeLog, offset, port, ok, warn, err, managed: true })) {
      return { ok: false };
    }
    if (credentials && !await verifyTextPreset(endpoint).catch(() => false)) {
      warn('DSH 未加载有效的 channel-chat-v2-text 预设，渠道文本工具暂不可用。');
    }
    if (managedTarget === 'desktop') writePidFile(path.join(paths.runDir, 'dsh.pid'), ownedDsh);
    ready = true;
    return { ok: true, endpoint, consolePort: port };
  } catch {
    err('渠道文本工具启动未完成，见桥接与 DSH 启动日志。');
    return { ok: false };
  } finally {
    if (!ready) {
      await stopOwned(ownedBridge, 'qq-bridge');
      await stopOwned(ownedDsh, 'DSH');
      if (ownedBridge && readPidFile(bridgePid) === ownedBridge && !isPidAlive(ownedBridge)) removePidFile(bridgePid);
      const dshPid = path.join(paths.runDir, 'dsh.pid');
      if (ownedDsh && readPidFile(dshPid) === ownedDsh && !isPidAlive(ownedDsh)) removePidFile(dshPid);
    }
  }
}

/**
 * 问 DSH 自己：QQ 预设到底注册上了没有。没注册时群聊 / 仿真会话会被拒绝（fail-closed），
 * 表现就是 QQ 上没反应，所以这里把能查到的原因都打出来，用户可以直接贴给别人看。
 */
async function reportPresetRegistration({ endpoint, paths, setup, log, ok, warn }) {
  const check = await checkDshPresets(endpoint.baseUrl);
  if (check.ok === null) {
    log('  没能向 DSH 查询预设清单（可能还在启动），跳过这项检查');
    return;
  }
  if (check.ok) {
    ok(`DSH 已注册 QQ 预设（${REQUIRED_PRESETS.join(', ')}）`);
    return;
  }
  warn(`DSH 里没有 QQ 预设（缺 ${check.missing.join(', ')}），群聊和仿真会话会被拒绝。DSH 现有：${check.ids.join(', ') || '（空）'}`);
  const profile = endpoint.profile || profileOf(endpoint);
  for (const line of diagnosePresetProfile({ home: endpoint.dshHome || paths.env?.DSH_HOME || path.join(paths.home, '.dsh'), profile })) warn(`  ${line}`);
  if (setup?.changed) warn('  刚写入过 profile：完全退出 DSH 再打开（桌面版要在托盘 / 菜单栏里退出），然后重新运行本脚本');
  else warn('  请把以上几行和 DSH 版本号一起反馈给我们');
}

async function runStartUserManaged({ args, paths, env, log, ok, warn, err, platform, ragEnabled }) {
  if (!(await ensureConfigFile({ root: paths.root, log, ok, warn, err }))) return 1;
  // config.json 可能刚生成 / 刚改过，重新解析一遍路径。
  Object.assign(paths, resolveOrchestratorPaths({ root: paths.root, env, platform }));
  const serviceEnv = withoutChannelPlatformEnv(env, paths.config);
  paths.env = serviceEnv;

  await startGsv({ paths, log, ok, warn, platform });
  await startRagSection({ paths, ragEnabled, log, ok, warn, platform });

  log('把 QQ 预设 / MCP 装进 DSH...');
  const setup = await runSetupDsh({ paths, env: serviceEnv, log, ok, warn });

  const target = args.dshTarget || String(env.QQ_BRIDGE_DSH_TARGET || paths.config?.dsh?.target || 'auto').toLowerCase();
  const managed = channelTextToolsEnabled(paths.config);
  const bridgeEnv = { ...env };
  if (args.dshTarget) bridgeEnv.QQ_BRIDGE_DSH_TARGET = args.dshTarget;

  async function prepareOneBot() {
    // 旧版 Windows 流程由用户管理 QQ / SnowLuma；START_SNOWLUMA=1 时仍可代为启动。
    if (serviceEnv.START_SNOWLUMA === '1') {
      if (!(await startQq({ paths, log, ok, err, platform }))) return null;
      if (!(await startSnowLuma({ paths, log, ok, err, platform }))) return null;
    }
    const result = await ensureOneBotUserManaged({ paths, env: serviceEnv, log, ok, warn, err, platform });
    if (result?.homeDir && !bridgeEnv.SNOWLUMA_HOME) bridgeEnv.SNOWLUMA_HOME = result.homeDir;
    return result;
  }

  let managedStartup;
  let onebot;
  if (managed) {
    onebot = await prepareOneBot();
    if (!onebot) return 1;
    managedStartup = await startManagedChannelServices({
      paths, env: serviceEnv, bridgeEnv, target, platform, setup, log, ok, warn, err,
    });
    if (managedStartup?.ok === false) return 1;
  }
  log(`连接 DSH（${target === 'auto' ? '自动：桌面版优先用已打开的，否则 dsh web' : target}）...`);
  const endpoint = managedStartup?.endpoint ?? await ensureDshDetected({
    paths, env: serviceEnv, target, setup, log, ok, warn, err, platform, preserveRunning: managed,
  });
  if (!endpoint) return 1;
  await reportPresetRegistration({ endpoint, paths, setup, log, ok, warn });
  const models = await checkDshModels(endpoint.baseUrl);
  if (models.ok === false) {
    warn('DSH 里还没有可用的模型（没登录 DeepSeek 账号，也没填 API Key），机器人收到消息也回不了');
    warn(`  → ${modelSetupHint(endpoint)}`);
  } else if (models.ok) {
    ok(`DSH 模型可用（${models.providers.join(', ')}）`);
  }

  if (!managed) onebot = await prepareOneBot();
  if (!onebot) return 1;
  if (!managedStartup && !(await startBridgeWatched({ paths, env: bridgeEnv, log, ok, warn, err, platform }))) return 1;

  const cfg = readJson(path.join(paths.root, 'config.json')) ?? {};
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out('');
  out('全部就绪');
  out(`  DSH              ${describeEndpoint(endpoint)}`);
  out(`  QQ 机器人账号    ${onebot.self?.nickname ?? '?'}（${onebot.self?.user_id ?? '?'}）`);
  out(`  桥接控制台       http://127.0.0.1:${managedStartup?.consolePort ?? BRIDGE_PORT}/`);
  out(`  控制台令牌       ${platform === 'win32' ? 'type' : 'cat'} "${path.join(paths.root, 'state', 'console-token')}"`);
  out(`  日志目录         ${paths.runDir}`);
  out('');
  if (cfg.ownerQQ) out(`现在用你的 QQ（${cfg.ownerQQ}）给机器人账号发一条私聊试试，例如「在吗」。`);
  else out(`还没配置管理员 QQ / 白名单：编辑 config.json 的 ownerQQ 和 allow.private 后，${entryName('stop-all', platform)} 再 ${entryName('start-all', platform)}。`);
  out('');
  return 0;
}

function printStartSummary({ paths, ragEnabled, managed, startGsv, platform, consolePort = BRIDGE_PORT }) {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  const title = platform === 'win32' ? '全部就绪' : '\u001b[1;32m全部就绪\u001b[0m';
  out('');
  out(title);
  out(`  DSH              http://127.0.0.1:${DSH_PORT}`);
  if (startGsv) out(`  GPT-SoVITS API   http://127.0.0.1:${GSV_PORT}/docs`);
  if (ragEnabled) {
    if (managed) out(`  embedding        http://127.0.0.1:${EMBED_PORT}`);
    else out('  向量模型         自己部署 / 云端，不由本脚本管理');
    out(`  memory-rag       http://127.0.0.1:${RAG_PORT}`);
  }
  out(`  SnowLuma WebUI   http://127.0.0.1:${SNOW_PORT}`);
  out(`  桥接控制台       http://127.0.0.1:${consolePort}/`);
  out(`  控制台令牌       ${platform === 'win32' ? 'type' : 'cat'} ${path.join(paths.root, 'state', 'console-token')}`);
  out(`  日志目录         ${paths.runDir}`);
  if (platform !== 'win32' && isFile(systemdUnitFile(paths.home, 'qq-bridge.service'))) {
    out('  systemd 服务     systemctl --user status qq-bridge qq-memory-rag qq-embedding');
  }
  out('');
}

/** start-all.mjs 入口。返回进程退出码。 */
export async function runStart({
  argv = process.argv.slice(2),
  root = DEFAULT_ROOT,
  env = process.env,
  platform = process.platform,
  logger = createLogger()
} = {}) {
  env = withoutChannelToolEnv(env);
  const { log, ok, warn, err } = logger;
  const args = parseArgs(argv);
  for (const unknown of args.unknown) warn(`未知参数：${unknown}（可用：--rag、--web、--desktop）`);

  const paths = resolveOrchestratorPaths({ root, env, platform });
  paths.env = withoutChannelPlatformEnv(env, paths.config);
  fs.mkdirSync(paths.runDir, { recursive: true });

  if (args.ragOnly) {
    await setRagSwitch(root, true, { warn });
    await startRagSection({ paths, ragEnabled: true, log, ok, warn, platform });
    await summarizeRag({ paths, ragEnabled: true, managed: isEmbeddingManaged(root), log, ok });
    return 0;
  }

  let ragEnabled = readRagEnabled(root);
  if (env.START_RAG === '1') {
    await setRagSwitch(root, true, { warn });
    ragEnabled = true;
  }

  log('检查基础依赖');
  if (!isFile(paths.nodeBin) && paths.nodeBin !== 'node') {
    err(`找不到 node：${paths.nodeBin}`);
    return 1;
  }
  if (!isFile(path.join(root, 'src', 'bridge.js'))) {
    err(`找不到桥接主程序：${path.join(root, 'src', 'bridge.js')}`);
    return 1;
  }
  // Windows：QQ、SnowLuma 由用户自己管。只有 Linux 才由本脚本替用户拉起它们，也只有 Linux 有 systemd。
  if (platform === 'win32') {
    ok(`node: ${paths.nodeBin}`);
    ok(`日志目录: ${paths.runDir}`);
    return runStartUserManaged({ args, paths, env, log, ok, warn, err, platform, ragEnabled });
  }
  // 与旧脚本一样尽早发现明显的路径错误：DSH / SnowLuma 没装时先别去起 QQ。
  if (!(await isPortOpen(DSH_PORT))) {
    const { command } = paths.dshCommand;
    const resolved = path.isAbsolute(command)
      ? (isFile(command) ? command : null)
      : findExecutable(command, { env, platform });
    if (!resolved && command !== paths.nodeBin) {
      err(`找不到 DSH 启动命令：${command}（可用 DSH_DIR 或 config.json 的 orchestrator.dshCommand 指定）`);
      return 1;
    }
  }
  if (!(await isPortOpen(SNOW_PORT)) && !paths.snowLaunch) {
    err(`找不到 SnowLuma 目录：${paths.snowDir || '(空)'}。可用 SNOW_DIR 或 config.json 的 orchestrator.snowDir 指定`);
    return 1;
  }
  if (!(await checkNodeForServices({ paths, platform, warn, err }))) return 1;
  ok(`node: ${paths.nodeBin}`);
  ok(`日志目录: ${paths.runDir}`);

  await startGsv({ paths, log, ok, warn, platform });
  await startRagSection({ paths, ragEnabled, log, ok, warn, platform });

  const managed = channelTextToolsEnabled(paths.config);
  if (!managed) {
    log('启动 DSH...');
    if (!(await startDsh({ paths, log, ok, err, platform }))) return 1;
  }

  if (!(await startQq({ paths, log, ok, err, platform }))) return 1;
  if (!(await startSnowLuma({ paths, log, ok, err, platform }))) return 1;

  log('等待 QQ 登录并打开 OneBot（最多 180 秒）...');
  log('  如果 QQ 弹出扫码窗口，请现在扫码');
  if (!(await waitForPorts(ONEBOT_PORTS, 180))) {
    err('OneBot 没起来：要么 QQ 还没登录完，要么 SnowLuma 没注入到 QQ 进程');
    console.error('  1) 看一下 QQ 窗口，扫码/确认登录');
    console.error('  2) 登录完成后重新运行本脚本（已启动的会自动跳过）');
    console.error('  3) 日志里没有 "[Hook] login detected" 说明 SnowLuma 没挂上 QQ：');
    console.error(`     ${entryName('stop-all', platform)} 后重新 ${entryName('start-all', platform)}（本脚本会用 SNOWLUMA_HOOK_AUTOLOAD=1 重启 SnowLuma）`);
    console.error(`  4) SnowLuma 日志：${path.join(paths.runDir, 'snowluma.log')}`);
    for (const line of tailLines(path.join(paths.runDir, 'snowluma.log'))) console.error(`     ${line}`);
    return 1;
  }
  ok('OneBot 已就绪（3000/3001）');

  let managedStartup;
  if (managed) {
    log('把 QQ 预设 / MCP 装进 DSH...');
    const setup = await runSetupDsh({ paths, env: paths.env, log, ok, warn });
    const target = args.dshTarget || String(env.QQ_BRIDGE_DSH_TARGET || paths.config?.dsh?.target || 'auto').toLowerCase();
    managedStartup = await startManagedChannelServices({ paths, env: paths.env, bridgeEnv: env, target, platform, setup, log, ok, warn, err });
    if (managedStartup?.ok === false) return 1;
    if (!managedStartup && !(await startDsh({ paths, log, ok, err, platform }))) return 1;
  }
  if (!managedStartup && !(await startBridge({ paths, env, log, ok, err, platform }))) return 1;
  printStartSummary({
    paths, ragEnabled, managed: isEmbeddingManaged(root), startGsv: paths.startGsv, platform,
    consolePort: managedStartup?.consolePort,
  });
  return 0;
}

async function stopDshIfRequested({ paths, log, ok, warn, platform }) {
  const pidFile = path.join(paths.runDir, 'dsh.pid');
  return stopService({
    pidFile,
    label: 'DSH',
    patterns: platform === 'win32' ? ['node.exe', 'cmd.exe', 'deepseek harness.exe', 'dsh.exe'] : ['apps/cli/src/bin.ts web', 'pnpm dsh web'],
    port: DSH_PORT,
    platform, log, ok, warn
  });
}

/** stop-all.mjs 入口。返回进程退出码。 */
export async function runStop({
  argv = process.argv.slice(2),
  root = DEFAULT_ROOT,
  env = process.env,
  platform = process.platform,
  logger = createLogger()
} = {}) {
  const { stopLog: log, ok, warn } = logger;
  const args = parseArgs(argv, { stop: true });
  for (const unknown of args.unknown) warn(`未知参数：${unknown}（可用：--all、--rag）`);

  const paths = resolveOrchestratorPaths({ root, env, platform });
  paths.env = env;

  if (args.ragOnly) {
    log('只停向量记忆（--rag）');
    await setRagSwitch(root, false, { warn });
    await stopRagSection({ paths, log, ok, warn, platform });
    return 0;
  }

  log('停止 qq-bridge');
  if (platform !== 'win32' && await useUnit('qq-bridge.service', { home: paths.home, env: paths.env, warn })) {
    await systemdStop('qq-bridge.service', 'qq-bridge', { env: paths.env, log, ok, warn });
    if (await isPortOpen(BRIDGE_PORT) || readPidFile(path.join(paths.runDir, 'bridge.pid'))) {
      await stopService({
        pidFile: path.join(paths.runDir, 'bridge.pid'),
        label: 'qq-bridge（systemd 之外）',
        patterns: platform === 'win32' ? ['node.exe'] : ['node src/bridge.js', 'src/bridge.js'],
        port: BRIDGE_PORT,
        platform, log, ok, warn
      });
    }
  } else {
    await stopService({
      pidFile: path.join(paths.runDir, 'bridge.pid'),
      label: 'qq-bridge',
      patterns: platform === 'win32' ? ['node.exe'] : ['node src/bridge.js', 'src/bridge.js'],
      port: BRIDGE_PORT,
      platform, log, ok, warn
    });
  }

  await stopRagSection({ paths, log, ok, warn, platform });

  await stopService({
    pidFile: path.join(paths.runDir, 'gsv.pid'),
    label: 'GPT-SoVITS API',
    patterns: platform === 'win32' ? ['python.exe'] : ['api_v2\\.py'],
    port: GSV_PORT,
    platform, log, ok, warn
  });

  // Windows 上 QQ / SnowLuma 默认由用户自己打开、注入（start-all 不再替你起它们）：
  // 只停本脚本用 START_SNOWLUMA=1 起过、留了 PID 文件的那份；否则按镜像名兜底会把用户自己的 QQ 关掉。
  const userManaged = (pidName) => platform === 'win32' && !readPidFile(path.join(paths.runDir, pidName));
  if (userManaged('snowluma.pid')) {
    ok('SnowLuma 由你自己管理，保留运行');
  } else {
    await stopService({
      pidFile: path.join(paths.runDir, 'snowluma.pid'),
      label: 'SnowLuma',
      patterns: platform === 'win32' ? ['node.exe', 'cmd.exe', 'SnowLuma.exe'] : ['SnowLuma-[^/]*/index\\.mjs'],
      image: platform !== 'win32' && paths.snowLaunch?.kind === 'exe' ? 'SnowLuma.exe' : null,
      port: SNOW_PORT,
      platform, log, ok, warn
    });
  }

  if (userManaged('qq.pid')) {
    ok('QQ 由你自己管理，保留运行');
  } else {
    await stopService({
      pidFile: path.join(paths.runDir, 'qq.pid'),
      label: 'QQ',
      patterns: platform === 'win32' ? [path.basename(paths.qqBin)] : [`^${escapeRegExp(paths.qqBin)}( |$)`],
      image: platform === 'win32' ? null : path.basename(paths.qqBin),
      platform, log, ok, warn
    });
  }

  if (args.stopDsh) {
    await stopDshIfRequested({ paths, log, ok, warn, platform });
  } else {
    log('DSH 保留运行；要一起停：--all');
  }

  return 0;
}
