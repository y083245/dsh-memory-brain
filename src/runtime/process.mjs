// 后台进程管理 —— PID 文件、detached 启动、整棵子进程树停止。
//
// 为什么 Windows 要单独走一套：systemd 只在 Linux 有；Windows 上没有优雅的 SIGTERM，
// 停一个由 npm / pnpm / python 拉起的进程必须连子进程一起收掉（taskkill /T），否则
// 父进程死了、真正占端口的孙进程还在。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** 读 PID 文件；不存在/内容不是正整数返回 null。 */
export function readPidFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(file, pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`无效 PID：${pid}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${pid}\n`, 'utf8');
}

export function removePidFile(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* 删不掉也不影响后续判断 */ }
}

/** 进程是否还活着。EPERM 表示「存在但没权限探测」，按活着处理。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 跑一条命令，永不抛；返回 { code, stdout, stderr, error }。 */
export function execFileP(command, args = [], options = {}) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, ...options }, (error, stdout, stderr) => {
        const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
      });
    } catch (error) {
      resolve({ code: 1, stdout: '', stderr: '', error });
    }
  });
}

/** 读 /proc/<pid>/stat 的 pgrp 字段，确认 PID 是不是自己的进程组长。 */
function isProcessGroupLeader(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end === -1) return false;
    // comm 之后依次是 state、ppid、pgrp；pgrp 是第 3 个字段（下标 2）。
    const pgrp = Number(stat.slice(end + 2).split(' ')[2]);
    return Number.isInteger(pgrp) && pgrp === pid;
  } catch {
    return false;
  }
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** Windows：taskkill /PID <pid> /T（/F 强制）。 */
async function taskkill(pid, { force = false, timeoutMs = 15000 } = {}) {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  return execFileP('taskkill', args, { timeout: timeoutMs });
}

/**
 * 停止一个进程及其子进程树。
 * - Windows：taskkill /T，先温和后 /F。
 * - Linux/macOS：先杀进程组（detached spawn 的 pid 是组长），失败再杀单进程；SIGTERM → SIGKILL。
 * @returns {Promise<{ok:boolean, alreadyStopped?:boolean, forced?:boolean, reason?:string}>}
 */
export async function stopPid(pid, { platform = process.platform, timeoutMs = 10000, label = '进程' } = {}) {
  if (!isPidAlive(pid)) return { ok: true, alreadyStopped: true };
  if (platform === 'win32') {
    await taskkill(pid, { force: false });
    if (await waitGone(pid, Math.min(3000, timeoutMs))) return { ok: true };
    await taskkill(pid, { force: true });
    if (await waitGone(pid, Math.max(1000, timeoutMs - 3000))) return { ok: true, forced: true };
    return { ok: false, reason: `${label} 仍在运行（PID ${pid}）` };
  }
  const signalTree = (signal) => {
    // 只有确认 pid 是进程组长时才用负 PID；否则 kill(-pid) 可能命中一个碰巧同号的
    // 其它进程组（PID 复用 / 旧脚本起的进程不是组长）。
    if (isProcessGroupLeader(pid)) {
      try { process.kill(-pid, signal); return true; } catch { /* 组长已退出，退回单进程 */ }
    }
    try { process.kill(pid, signal); return true; } catch { return false; }
  };
  signalTree('SIGTERM');
  if (await waitGone(pid, Math.min(10000, timeoutMs))) return { ok: true };
  signalTree('SIGKILL');
  if (await waitGone(pid, 3000)) return { ok: true, forced: true };
  return { ok: false, reason: `${label} 仍在运行（PID ${pid}）` };
}

/**
 * detached 启动一个后台进程，stdout/stderr 追加到日志文件。
 * 父进程退出后子进程继续运行；Windows 上 detached 子进程有自己的进程组，配合 taskkill /T。
 */
export async function spawnDetached({
  command,
  args = [],
  cwd,
  logFile,
  env = process.env,
  windowsHide = true,
  windowsVerbatimArguments = false,
  spawnImpl = spawn,
  fsImpl = fs
} = {}) {
  if (!command) throw new Error('spawnDetached: command 为空');
  if (!logFile) throw new Error('spawnDetached: logFile 为空');
  fsImpl.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fsImpl.openSync(logFile, 'a');
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env,
      detached: true,
      windowsHide,
      windowsVerbatimArguments,
      stdio: ['ignore', fd, fd]
    });
  } catch (error) {
    try { fsImpl.closeSync(fd); } catch { /* 已经关了 */ }
    throw error;
  }
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* 子进程已继承 */ }
  }
  child.unref();
  return { pid: child.pid, child };
}

/** Linux 下按命令行正则找 PID（保留旧 stop-all.sh 的 pgrep 兜底能力）。 */
export async function findPidsByPattern(pattern, { platform = process.platform } = {}) {
  if (platform === 'win32') return [];
  const r = await execFileP('pgrep', ['-f', pattern], { timeout: 5000 });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0
    && pid !== process.pid && pid !== process.ppid);
}

/** 按镜像名找 PID（Windows tasklist / Linux pgrep -x）。 */
export async function findPidsByImage(image, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    const r = await execFileP('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { timeout: 8000 });
    if (r.code !== 0) return [];
    const out = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const match = /^"([^"]+)","(\d+)"/.exec(line);
      if (match && match[1].toLowerCase() === String(image).toLowerCase()) out.push(Number(match[2]));
    }
    return out;
  }
  const r = await execFileP('pgrep', ['-x', image], { timeout: 5000 });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * 核对 PID 的身份，防止 PID 被系统回收后误杀别的进程。
 * Linux 读 /proc/<pid>/cmdline；Windows 用 tasklist 比对镜像名（patterns 里可以写 node.exe 等）。
 */
export async function pidMatches(pid, patterns = [], { platform = process.platform } = {}) {
  const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean).map(String);
  if (!list.length) return true;
  if (platform === 'win32') {
    const r = await execFileP('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 8000 });
    const match = /^"([^"]+)"/.exec(r.stdout ?? '');
    if (!match) return false;
    const image = match[1].toLowerCase();
    return list.some((pattern) => image.includes(String(pattern).toLowerCase()));
  }
  let cmdline = '';
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return false;
  }
  return list.some((pattern) => cmdline.includes(pattern));
}

/**
 * 按 PID 文件停止服务：文件里的进程已经不在 → 删文件并返回；身份对不上 → 不杀。
 */
export async function stopPidFile({
  pidFile,
  patterns = [],
  platform = process.platform,
  timeoutMs = 10000,
  label = '进程'
} = {}) {
  const pid = readPidFile(pidFile);
  if (!pid) {
    removePidFile(pidFile);
    return { ok: true, missing: true };
  }
  if (!isPidAlive(pid)) {
    removePidFile(pidFile);
    return { ok: true, stale: true, pid };
  }
  if (!(await pidMatches(pid, patterns, { platform }))) {
    return { ok: false, mismatch: true, pid, reason: `PID ${pid} 不是预期的 ${label}，没有停它` };
  }
  const result = await stopPid(pid, { platform, timeoutMs, label });
  if (result.ok) removePidFile(pidFile);
  return { ...result, pid };
}
