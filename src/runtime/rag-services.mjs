// 向量记忆两个本地服务（embedding :8091 / memory-rag :8093）的跨平台启停。
//
// 供 Windows 的 PID 进程管理器与 scripts/start-all.mjs 复用；Linux systemd 模式仍由
// systemd 单元负责，不走这里。
import fs from 'node:fs';
import path from 'node:path';
import { commandSpec } from './commands.mjs';
import { isPortOpen } from './ports.mjs';
import { execFileP, readPidFile, isPidAlive, spawnDetached, stopPidFile, writePidFile } from './process.mjs';

export const EMBED_PORT = 8091;
export const RAG_PORT = 8093;
export const EMBED_PID = 'embed.pid';
export const RAG_PID = 'memory-rag.pid';

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** 读 /health；连不上或非 2xx 返回 null（不会抛）。 */
export async function fetchHealth(port, { timeoutMs = 10000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response?.ok) return null;
    const data = await response.json().catch(() => null);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return null;
  }
}

/**
 * 轮询 /health 直到 accept(data) 为真或超时。
 * 为什么不是只等端口：llama-server 刚监听时模型可能还没加载完（/health 503），
 * memory-rag 也可能先起来、embedding 还没就绪。
 */
export async function waitForHealth(port, seconds, { fetchImpl, accept = (data) => !!data, intervalMs = 1000, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  for (;;) {
    const data = await fetchHealth(port, { timeoutMs, fetchImpl });
    if (data && accept(data)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }
}

export async function embeddingReady({ timeoutMs = 5000, fetchImpl } = {}) {
  const data = await fetchHealth(EMBED_PORT, { timeoutMs, fetchImpl });
  return !!data;
}

export async function memoryRagReady({ timeoutMs = 3000, fetchImpl } = {}) {
  return !!(await fetchHealth(RAG_PORT, { timeoutMs, fetchImpl }));
}

/** nvidia-smi 空闲显存（MiB）；查不到返回 null。 */
export async function gpuFreeMiB({ execImpl = execFileP } = {}) {
  const r = await execImpl('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 5000 });
  if (r.code !== 0) return null;
  const first = String(r.stdout ?? '').split(/\r?\n/)[0].trim();
  return /^\d+$/.test(first) ? Number(first) : null;
}

/**
 * 启动 embedding（仅 managed=true 时）。
 * @returns {Promise<{started:boolean, pid?:number, healthy?:boolean, skipped?:string, freeMiB?:number}>}
 */
export async function startEmbeddingService({
  runDir,
  embedBin,
  embedModel,
  managed,
  log = () => {},
  platform = process.platform,
  waitSeconds = 60,
  cwd,
  deps = {}
} = {}) {
  if (!managed) return { started: false, skipped: 'not-managed' };
  const portOpen = deps.isPortOpen ?? isPortOpen;
  if (await portOpen(EMBED_PORT)) return { started: false, skipped: 'already-running' };
  const freeMiB = await (deps.gpuFreeMiB ?? gpuFreeMiB)();
  if (freeMiB === null) return { started: false, skipped: 'no-gpu-info' };
  if (freeMiB < 10000) return { started: false, skipped: 'low-vram', freeMiB };
  if (!(deps.isFile ?? isFile)(embedBin) || !(deps.isFile ?? isFile)(embedModel)) {
    return { started: false, skipped: 'missing-files' };
  }
  const spec = (deps.commandSpec ?? commandSpec)(embedBin, [
    '-m', embedModel,
    '--embedding', '--pooling', 'last',
    '--host', '127.0.0.1', '--port', String(EMBED_PORT),
    '-ngl', '99', '-c', '8192', '-ub', '8192'
  ], { platform });
  const spawned = await (deps.spawnDetached ?? spawnDetached)({
    ...spec,
    cwd: cwd ?? path.dirname(embedBin),
    logFile: path.join(runDir, 'embed.log'),
    platform
  });
  (deps.writePidFile ?? writePidFile)(path.join(runDir, EMBED_PID), spawned.pid);
  const healthy = await (deps.waitForHealth ?? waitForHealth)(EMBED_PORT, waitSeconds, {
    fetchImpl: deps.fetchImpl,
    accept: (data) => data && (data.status === 'ok' || data.ok === true)
  });
  log(`[rag] embedding 已启动（PID ${spawned.pid}）${healthy ? '，端口已就绪' : '，端口未就绪'}`);
  return { started: true, pid: spawned.pid, healthy };
}

/**
 * 启动 memory-rag。python 是 resolvePython() 的返回值（{command,args}）。
 * @returns {Promise<{started:boolean, pid?:number, healthy?:boolean, skipped?:string}>}
 */
export async function startMemoryRagService({
  runDir,
  ragDir,
  python,
  log = () => {},
  platform = process.platform,
  waitSeconds = 60,
  deps = {}
} = {}) {
  const portOpen = deps.isPortOpen ?? isPortOpen;
  if (await portOpen(RAG_PORT)) return { started: false, skipped: 'already-running' };
  if (!python?.command) return { started: false, skipped: 'missing-python' };
  const spec = (deps.commandSpec ?? commandSpec)(python.command, [
    ...(python.args ?? []),
    '-W', 'ignore::SyntaxWarning',
    '-m', 'memory_rag.app'
  ], { platform });
  const spawned = await (deps.spawnDetached ?? spawnDetached)({
    ...spec,
    cwd: ragDir,
    logFile: path.join(runDir, 'memory-rag.log'),
    platform
  });
  (deps.writePidFile ?? writePidFile)(path.join(runDir, RAG_PID), spawned.pid);
  const healthy = await (deps.waitForHealth ?? waitForHealth)(RAG_PORT, waitSeconds, {
    fetchImpl: deps.fetchImpl,
    accept: (data) => data && Object.prototype.hasOwnProperty.call(data, 'embedding')
  });
  log(`[rag] memory-rag 已启动（PID ${spawned.pid}）${healthy ? '，端口已就绪' : '，端口未就绪'}`);
  return { started: true, pid: spawned.pid, healthy };
}

/** 只按 PID 文件停止一个服务；没有 PID 文件但端口被占时返回 not-managed，不乱杀。 */
export async function stopRagService({
  runDir,
  name,
  patterns,
  platform = process.platform,
  log = () => {},
  deps = {}
} = {}) {
  const pidFile = path.join(runDir, name === 'embedding' ? EMBED_PID : RAG_PID);
  const stop = deps.stopPidFile ?? stopPidFile;
  const result = await stop({ pidFile, patterns, platform, label: name });
  if (result.ok && !result.missing && !result.stale) log(`[rag] ${name} 已停止${result.forced ? '（强制）' : ''}`);
  return result;
}

/** 停止 memory-rag，managed 时再停 embedding（顺序与旧脚本一致）。 */
export async function stopRagServices({
  runDir,
  managed,
  platform = process.platform,
  log = () => {},
  deps = {}
} = {}) {
  const results = {};
  results.memoryRag = await stopRagService({
    runDir, name: 'memory-rag', patterns: [platform === 'win32' ? 'python' : 'memory_rag.app'], platform, log, deps
  });
  if (managed) {
    results.embedding = await stopRagService({
      runDir, name: 'embedding', patterns: [platform === 'win32' ? 'llama-server' : 'llama-server'], platform, log, deps
    });
  }
  return results;
}

/** 当前 PID 文件对应的进程是否存活。 */
export function ragPidStatus(runDir) {
  return {
    memoryRagPid: readPidFile(path.join(runDir, RAG_PID)),
    embeddingPid: readPidFile(path.join(runDir, EMBED_PID)),
    memoryRagAlive: isPidAlive(readPidFile(path.join(runDir, RAG_PID))),
    embeddingAlive: isPidAlive(readPidFile(path.join(runDir, EMBED_PID)))
  };
}
