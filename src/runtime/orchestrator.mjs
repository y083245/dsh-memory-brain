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
import {
  EMBED_PORT,
  RAG_PORT,
  fetchHealth,
  gpuFreeMiB,
  startEmbeddingService,
  startMemoryRagService
} from './rag-services.mjs';

const DSH_PORT = 3080;
const ONEBOT_PORTS = [3000, 3001];
const SNOW_PORT = 5099;
const BRIDGE_PORT = 3100;
const GSV_PORT = 9880;
const SYSTEMD_TIMEOUT_MS = 180000;
const STOP_TIMEOUT_MS = 60000;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  const out = { ragOnly: false, stopDsh: false, startRag: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--rag') {
      out.ragOnly = true;
      out.startRag = true;
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
    if (result.ok) {
      if (!result.missing && !result.stale) ok(`${label} 已停止`);
      else ok(`${label} 未运行`);
      return result.ok;
    }
    warn(result.reason || `${label} 未停止（PID ${pid}）`);
    return false;
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

async function spawnService({ spec, cwd, logFile, label, log, err, platform }) {
  try {
    log(`启动 ${label}：${describeCommand(spec)}`);
    const spawned = await spawnDetached({ ...spec, cwd, logFile, platform });
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
        else if (await waitForPort(EMBED_PORT, embedWaitSeconds)) ok(`embedding 已就绪（${EMBED_PORT}）`);
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
      else if (await waitForPort(RAG_PORT, ragWaitSeconds)) ok(`memory-rag 已就绪（${RAG_PORT}）`);
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
  }

  if (await isPortOpen(RAG_PORT)) {
    ok(`memory-rag 已在运行（${RAG_PORT}）`);
  } else {
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

async function startDsh({ paths, log, ok, err, platform }) {
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
  const pid = await spawnService({
    spec,
    cwd,
    logFile: path.join(paths.runDir, 'dsh.log'),
    label: 'DSH',
    log, err, platform
  });
  if (!pid) return false;
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
  const pid = await spawnService({
    spec,
    cwd: paths.home,
    logFile: path.join(paths.runDir, 'qq.log'),
    label: 'QQ',
    log, err, platform
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
  try {
    const real = fs.realpathSync(nodeBin);
    const r = await execFileP('getcap', [real], { timeout: 5000 });
    if (String(r.stdout ?? '').includes('cap_sys_ptrace')) return true;
  } catch { /* 下面统一报错 */ }
  err('node 缺少 cap_sys_ptrace，SnowLuma 无法注入 QQ。先执行：');
  try {
    const real = fs.realpathSync(nodeBin);
    err(`  sudo setcap cap_sys_ptrace=ep "${real}"`);
  } catch {
    err(`  sudo setcap cap_sys_ptrace=ep "${nodeBin}"`);
  }
  return false;
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
  const pid = await spawnService({
    spec,
    cwd: launch.cwd,
    logFile: path.join(paths.runDir, 'snowluma.log'),
    label: 'SnowLuma',
    log, err, platform
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

async function startBridge({ paths, log, ok, err, platform }) {
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
  const spec = commandSpec(paths.nodeBin, [path.join(paths.root, 'src', 'bridge.js')], { platform, env: paths.env, nodeBin: paths.nodeBin });
  const pid = await spawnService({
    spec,
    cwd: paths.root,
    logFile: bridgeLog,
    label: 'qq-bridge',
    log, err, platform
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
    log, err: warn, platform
  });
  if (!pid) return;
  writePidFile(path.join(paths.runDir, 'gsv.pid'), pid);
  if (await waitForPort(GSV_PORT, 120)) ok(`GPT-SoVITS API 已就绪（${GSV_PORT}）`);
  else warn(`GPT-SoVITS 没起来，语音生成暂时不可用；看日志：${path.join(paths.runDir, 'gsv.log')}`);
}

function printStartSummary({ paths, ragEnabled, managed, startGsv, platform }) {
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
  out(`  桥接控制台       http://127.0.0.1:${BRIDGE_PORT}/`);
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
  const { log, ok, warn, err } = logger;
  const args = parseArgs(argv);
  for (const unknown of args.unknown) warn(`未知参数：${unknown}（可用：--rag）`);

  const paths = resolveOrchestratorPaths({ root, env, platform });
  paths.env = env;
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
  ok(`node: ${paths.nodeBin}`);
  ok(`日志目录: ${paths.runDir}`);

  await startGsv({ paths, log, ok, warn, platform });
  await startRagSection({ paths, ragEnabled, log, ok, warn, platform });

  log('启动 DSH...');
  if (!(await startDsh({ paths, log, ok, err, platform }))) return 1;

  if (!(await startQq({ paths, log, ok, err, platform }))) return 1;
  if (!(await startSnowLuma({ paths, log, ok, err, platform }))) return 1;

  log('等待 QQ 登录并打开 OneBot（最多 180 秒）...');
  log('  如果 QQ 弹出扫码窗口，请现在扫码');
  if (!(await waitForPorts(ONEBOT_PORTS, 180))) {
    err('OneBot 没起来，通常是 QQ 还没登录完');
    console.error('  1) 看一下 QQ 窗口，扫码/确认登录');
    console.error('  2) 登录完成后重新运行本脚本（已启动的会自动跳过）');
    console.error(`  3) SnowLuma 日志：${path.join(paths.runDir, 'snowluma.log')}`);
    for (const line of tailLines(path.join(paths.runDir, 'snowluma.log'))) console.error(`     ${line}`);
    return 1;
  }
  ok('OneBot 已就绪（3000/3001）');

  if (!(await startBridge({ paths, log, ok, err, platform }))) return 1;
  printStartSummary({ paths, ragEnabled, managed: isEmbeddingManaged(root), startGsv: paths.startGsv, platform });
  return 0;
}

async function stopDshIfRequested({ paths, log, ok, warn, platform }) {
  const pidFile = path.join(paths.runDir, 'dsh.pid');
  return stopService({
    pidFile,
    label: 'DSH',
    patterns: platform === 'win32' ? ['node.exe', 'cmd.exe'] : ['apps/cli/src/bin.ts web', 'pnpm dsh web'],
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

  await stopService({
    pidFile: path.join(paths.runDir, 'snowluma.pid'),
    label: 'SnowLuma',
    patterns: platform === 'win32' ? ['node.exe', 'cmd.exe', 'SnowLuma.exe'] : ['SnowLuma-[^/]*/index\\.mjs'],
    image: paths.snowLaunch?.kind === 'exe' ? 'SnowLuma.exe' : null,
    port: SNOW_PORT,
    platform, log, ok, warn
  });

  await stopService({
    pidFile: path.join(paths.runDir, 'qq.pid'),
    label: 'QQ',
    patterns: platform === 'win32' ? [path.basename(paths.qqBin)] : [`^${escapeRegExp(paths.qqBin)}( |$)`],
    image: path.basename(paths.qqBin),
    platform, log, ok, warn
  });

  if (args.stopDsh) {
    await stopDshIfRequested({ paths, log, ok, warn, platform });
  } else {
    log('DSH 保留运行；要一起停：--all');
  }

  return 0;
}
