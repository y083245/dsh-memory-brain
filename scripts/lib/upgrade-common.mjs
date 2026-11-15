// UPGRADE_PATCH：scripts/update.mjs 与 scripts/rollback.mjs 共用的部分（Linux / Windows）。
//
// 只用 Node 内置模块：第一次升级时仓库里还没装新依赖，rollback 回到的老提交里也可能没有这些文件。
// ESM 在进程启动时就读完了，所以运行中 git 把这几个文件换掉、甚至删掉都不影响这次执行，
// 不再需要 bash 版的「自复制到临时目录」。
//
// 硬规矩（与 bash 版相同）：
// - 永远不碰 QQ、SnowLuma；DSH 只按 PID 逐个停，绝不按进程组。
// - 不打印任何令牌：state/console-token 只在本进程里读，不进命令行参数。
// - 测试保险：QQB_UPDATE_TEST=1 时仓库必须在临时目录下，外部命令只走 QQB_FAKE_BIN，健康检查只打 QQB_HEALTH_BASE。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const DERIVED = [
  'plugins/qq-agent-presets/presets/qq-chat.patch.yml',
  'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml'
];
export const ORIG_UMASK = process.umask();

/** 带退出码的「正常结束」：main 外层统一接住。 */
export class Exit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

const color = process.stdout.isTTY && process.platform !== 'win32';
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
export const info = (msg) => console.log(`  ${msg}`);
export const ok = (msg) => console.log(`${paint('1;32', '  ok  ')} ${msg}`);
export const warn = (msg) => console.log(`${paint('1;33', '[warn]')} ${msg}`);
export const err = (msg) => console.error(`${paint('1;31', '[fail]')} ${msg}`);
export const stepper = (total) => (n, msg) => console.log(`\n${paint('1;36', `[${n}/${total}]`)} ${msg}`);

function isUnderTmp(real) {
  const roots = ['/tmp/', '/private/tmp/'];
  if (process.platform === 'win32') roots.push(`${fs.realpathSync(os.tmpdir())}${path.sep}`);
  return roots.some((root) => `${real}${path.sep}`.startsWith(root));
}

/** 读仓库路径并建上下文；测试保险不满足直接退出 1。 */
export function createContext(repoGuess) {
  const repo = path.resolve(process.env.QQB_UPDATE_REPO || repoGuess);
  const isTest = process.env.QQB_UPDATE_TEST === '1';
  if (isTest) {
    let real;
    try { real = fs.realpathSync(repo); } catch { err('QQB_UPDATE_TEST=1：仓库路径不存在'); throw new Exit(1); }
    if (!isUnderTmp(real)) { err(`QQB_UPDATE_TEST=1 但仓库不在 /tmp/ 下（${real}），拒绝运行`); throw new Exit(1); }
    const bin = process.env.QQB_FAKE_BIN;
    if (!bin || !fs.existsSync(bin)) { err('QQB_UPDATE_TEST=1 但没有 QQB_FAKE_BIN'); throw new Exit(1); }
    if (!process.env.QQB_HEALTH_BASE) { err('QQB_UPDATE_TEST=1 但没有 QQB_HEALTH_BASE'); throw new Exit(1); }
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  }
  // 只有 Linux 才由 start-all 替用户拉起 QQ / SnowLuma，也只有 Linux 有 systemd。
  // Windows 上这两个归用户自己管，start-all 不会动它们。测试的假世界按 Linux 走。
  const linuxFlow = isTest ? process.env.QQB_TEST_LINUX_FLOW !== '0' : process.platform !== 'win32';
  return { repo, isTest, linuxFlow, yes: false, testAnswers: isTest && process.env.QQB_TEST_ANSWERS !== undefined ? process.env.QQB_TEST_ANSWERS.split(',') : null };
}

/** 跑外部命令。.cmd / .bat 在 Windows 上要走 cmd.exe（Node 不允许直接 spawn）。 */
export function run(command, args = [], { cwd, env = process.env, capture = false, orig = false } = {}) {
  let cmd = command;
  let argv = args;
  let extra = {};
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    cmd = process.env.ComSpec || 'cmd.exe';
    argv = ['/d', '/s', '/c', `"${[`"${command}"`, ...args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a))].join(' ')}"`];
    extra = { windowsVerbatimArguments: true };
  }
  if (orig) process.umask(ORIG_UMASK);
  try {
    const r = spawnSync(cmd, argv, {
      cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...extra
    });
    return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    if (orig) process.umask(0o077);
  }
}

export function git(ctx, args, opts = {}) {
  return run('git', ['-C', ctx.repo, '-c', 'core.quotepath=false', ...args], { capture: true, ...opts });
}
export const gitOut = (ctx, args) => git(ctx, args).stdout.trim();
export const gitOk = (ctx, args) => git(ctx, args).code === 0;

function isExecutable(file) {
  try {
    if (process.platform === 'win32') return fs.statSync(file).isFile();
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 外部命令：测试时只认替身目录里的，绝不落到真命令上；找不到返回 ''。 */
export function binOf(ctx, name) {
  if (ctx.isTest) {
    const fake = path.join(process.env.QQB_FAKE_BIN, name);
    if (isExecutable(fake)) return fake;
    return process.platform === 'win32' && isExecutable(`${fake}.cmd`) ? `${fake}.cmd` : '';
  }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, `${name}${ext}`);
      if (isExecutable(file)) return file;
    }
  }
  return '';
}

export function sdctl(ctx, args, opts = {}) {
  const b = binOf(ctx, 'systemctl');
  if (!b) { err('找不到命令 systemctl'); return { code: 127, stdout: '', stderr: '' }; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}` };
  return run(b, ['--user', ...args], { env, ...opts });
}

/** 只认正整数 PID，绝不发给进程组。sig=0 用来探活。 */
export function sendSignal(ctx, sig, pid) {
  if (!/^\d+$/.test(String(pid)) || Number(pid) <= 1) { warn(`跳过不合法的 PID：${pid}`); return false; }
  if (ctx.isTest) return run(binOf(ctx, 'kill'), [`-${sig}`, String(pid)], { capture: true }).code === 0;
  try { process.kill(Number(pid), sig === 0 || sig === '0' ? 0 : `SIG${sig}`); return true; } catch { return false; }
}

export function pgrepF(ctx, pattern) {
  const b = binOf(ctx, 'pgrep');
  if (!b) return [];
  return run(b, ['-f', pattern], { capture: true }).stdout.split(/\s+/).filter(Boolean);
}
function psField(ctx, field, pid) {
  const b = binOf(ctx, 'ps');
  if (!b) return '';
  return run(b, ['-o', `${field}=`, '-p', String(pid)], { capture: true }).stdout.trim();
}

const useProc = (ctx) => !ctx.isTest && fs.existsSync('/proc/self');
const qqBin = () => process.env.QQ_BIN || '/opt/QQ/qq';

// 只用 pgrep -x / ps 的输出 + /proc 核对，绝不 pgrep -f（pgrep -f 会匹配到自己）。
function qqRunning(ctx) {
  const b = binOf(ctx, 'pgrep');
  if (!b) return false;
  const bin = qqBin();
  let realBin = bin;
  try { realBin = fs.realpathSync(bin); } catch { /* 还没装 */ }
  for (const pid of run(b, ['-x', 'qq'], { capture: true }).stdout.split(/\s+/).filter((p) => /^\d+$/.test(p))) {
    if (useProc(ctx)) {
      try {
        const exe = fs.readlinkSync(`/proc/${pid}/exe`);
        if (exe === bin || exe === realBin) return true;
        continue;
      } catch { /* 读不了就看 ps */ }
    }
    const args = psField(ctx, 'args', pid);
    if ([bin, realBin].some((b2) => args === b2 || args.startsWith(`${b2} `))) return true;
  }
  return false;
}
function snowlumaRunning(ctx) {
  const b = binOf(ctx, 'ps');
  if (!b) return false;
  for (const line of run(b, ['-eo', 'pid=,args='], { capture: true }).stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].includes('index.mjs')) continue;
    const first = path.basename(m[2].split(' ')[0]);
    if (!/^node\d*$/.test(first)) continue;
    if (useProc(ctx)) {
      try {
        if (/\/SnowLuma-[^/]*$/.test(fs.readlinkSync(`/proc/${m[1]}/cwd`))) return true;
        continue;
      } catch { /* 读不了就算在跑 */ }
    }
    return true;
  }
  return false;
}
/** 要不要担心 start-all 替用户拉起 QQ / SnowLuma：只有 Linux 流程才会。 */
export const hostRunning = (ctx) => !ctx.linuxFlow ||
  (!needsQqHost(ctx.repo) || (qqRunning(ctx) && snowlumaRunning(ctx)));
export function hostMissing(ctx) {
  if (!needsQqHost(ctx.repo)) return '';
  const missing = [];
  if (!qqRunning(ctx)) missing.push('QQ');
  if (!snowlumaRunning(ctx)) missing.push('SnowLuma');
  return missing.join('/');
}

/** --yes 直接是；不是终端又没 --yes 当作「否」并退出 3。 */
export async function ask(ctx, question) {
  if (ctx.yes) return true;
  if (ctx.testAnswers) {
    const a = ctx.testAnswers.shift() ?? '';
    console.log(`${question} [y/N] ${a}`);
    return /^([yY]|yes|是)$/.test(a);
  }
  if (!process.stdin.isTTY) {
    console.log(question);
    err('不是终端、也没有 --yes，按「否」处理');
    throw new Exit(3);
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^([yY]|yes|是)$/.test((await rl.question(`${question} [y/N] `)).trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

export function readConfig(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
// Upgrade bootstraps into older checkouts that may not honor channels.qq.enabled.
// Detect support on disk after checkout so rollback keeps the legacy process guard.
export const needsQqHost = (repo) => readConfig(repo)?.channels?.qq?.enabled !== false ||
  !fs.existsSync(path.join(repo, 'src', 'runtime', 'channel-config.mjs'));
export const ragEnabled = (repo) => readConfig(repo)?.memoryRag?.enabled === true;
export function consolePort(repo) {
  const p = Number(readConfig(repo)?.consolePort);
  return p > 0 ? p : 3100;
}

export const unitInstalled = (name) => fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', name));

/** DSH：node … apps/cli/src/bin.ts web 进程，加上它父链上的 pnpm / sh；外层在前。 */
export function dshPids(ctx) {
  const seen = new Set();
  // 源码跑的 DSH 和 npm 全局装的 DSH 都认。
  for (const pid of pgrepF(ctx, '(apps/cli/src/bin\\.ts|@deepseek-ai/dsh/lib/bin\\.js) web')) {
    if (!/^\d+$/.test(pid) || Number(pid) <= 1) continue;
    const chain = [pid];
    let cur = pid;
    for (let i = 0; i < 4; i += 1) {
      const ppid = psField(ctx, 'ppid', cur).trim();
      if (!/^\d+$/.test(ppid) || Number(ppid) <= 1) break;
      const args = psField(ctx, 'args', ppid);
      if (!args.includes('pnpm') && !args.includes('bin.ts web')) break;
      chain.unshift(ppid);
      cur = ppid;
    }
    for (const p of chain) seen.add(p);
  }
  return [...seen];
}

export async function waitGone(ctx, pids) {
  for (const pid of pids) {
    for (let i = 0; i < 20; i += 1) {
      if (!sendSignal(ctx, 0, pid)) break;
      await sleep(1000);
    }
  }
}

/** 拉起 / 停止：Linux 走根目录脚本（回滚到的老版本也认识），Windows 直接跑 Node 实现。 */
export function startAll(ctx, args = []) {
  if (process.platform === 'win32') {
    return run(process.execPath, [path.join(ctx.repo, 'scripts', 'start-all.mjs'), ...args], { cwd: ctx.repo, orig: true }).code === 0;
  }
  return run(path.join(ctx.repo, 'start-all.sh'), args, { cwd: ctx.repo, orig: true }).code === 0;
}
export function stopAll(ctx, args = []) {
  if (process.platform === 'win32') {
    return run(process.execPath, [path.join(ctx.repo, 'scripts', 'stop-all.mjs'), ...args], { cwd: ctx.repo, orig: true }).code === 0;
  }
  return run(path.join(ctx.repo, 'stop-all.sh'), args, { cwd: ctx.repo, orig: true }).code === 0;
}

async function probe(ctx, kind) {
  const bridge = ctx.isTest ? process.env.QQB_HEALTH_BASE : `http://127.0.0.1:${consolePort(ctx.repo)}`;
  const rag = ctx.isTest ? process.env.QQB_HEALTH_BASE : 'http://127.0.0.1:8093';
  const headers = {};
  let url;
  if (kind === 'bridge') {
    url = `${bridge}/api/status`;
    try { headers['x-console-token'] = fs.readFileSync(path.join(ctx.repo, 'state', 'console-token'), 'utf8').trim(); } catch { /* 没令牌也探一下 */ }
  } else {
    url = `${rag}/health`;
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!res.ok) return false;
    if (kind === 'rag') {
      const body = await res.json().catch(() => null);
      if (!body || body?.schema?.readonly === true) return false;
    }
    return true;
  } catch {
    return false;
  }
}
export const healthWaitSeconds = () => Number(process.env.QQB_HEALTH_WAIT) || 60;
export async function waitHealthy(ctx, kind) {
  const deadline = Date.now() + healthWaitSeconds() * 1000;
  for (;;) {
    if (await probe(ctx, kind)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

// ── 备份（tar）──────────────────────────────────────────────────────────
function tarBin() {
  if (process.platform !== 'win32') return 'tar';
  // Windows 10+ 自带 bsdtar。Git 带的 GNU tar 会把 C:\ 的冒号当远程主机，所以固定用系统的。
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(system) ? system : 'tar';
}
export const RAG_EXCLUDES = ['--exclude=state/long-memory/rag/chroma', '--exclude=state/long-memory/rag/rag.sqlite3*', '--exclude=state/long-memory/rag/watermarks.json'];

/** 打包 state/ 与 config.json；返回 { ok, changing }。changing = 打包时有文件在变，备份仍可用。 */
export function tarCreate(repo, file, excludes) {
  const items = [];
  if (fs.existsSync(path.join(repo, 'state'))) items.push('state');
  if (fs.existsSync(path.join(repo, 'config.json'))) items.push('config.json');
  if (!items.length) {
    fs.writeFileSync(file, zlib.gzipSync(Buffer.alloc(1024)), { mode: 0o600 });
    return { ok: true, changing: false, code: 0 };
  }
  const r = run(tarBin(), ['czf', file, '-C', repo, ...excludes, ...items]);
  // GNU tar 的 1 = 打包时有文件在变（桥接还在写日志）；bsdtar 的 1 是出错，再读一遍确认包是好的。
  const readable = r.code === 0 || (r.code === 1 && run(tarBin(), ['tzf', file], { capture: true }).code === 0);
  return { ok: readable, changing: r.code === 1 && readable, code: r.code };
}
export const tarList = (file) => run(tarBin(), ['tzf', file], { capture: true }).stdout.split(/\r?\n/).filter(Boolean);
export const tarExtract = (file, repo) => run(tarBin(), ['xzf', file, '-C', repo]).code === 0;

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
export function ensureBackupDir() {
  const dir = path.join(os.homedir(), 'qq-bridge-backups');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows 上没有这一套 */ }
  return dir;
}

// ── state/upgrade.json：原子写、600、state/ 700 ──────────────────────────────
const ujFile = (repo) => path.join(repo, 'state', 'upgrade.json');
export function ujRead(repo) {
  if (!fs.existsSync(ujFile(repo))) return { version: 1 };
  const doc = JSON.parse(fs.readFileSync(ujFile(repo), 'utf8'));
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : { version: 1 };
}
export function ujWrite(repo, doc) {
  const file = ujFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...doc, version: 1 }, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
  fs.renameSync(tmp, file);
}
export function ujAppend(repo, entry) {
  const doc = ujRead(repo);
  doc.history = [...(Array.isArray(doc.history) ? doc.history : []), entry];
  ujWrite(repo, doc);
}
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** 找记录：给了备份路径就找最后一条 backup 相同的；否则最后一条。 */
export function ujFind(repo, backupArg) {
  const history = Array.isArray(ujRead(repo).history) ? ujRead(repo).history : [];
  return backupArg ? [...history].reverse().find((h) => h?.backup && realOf(h.backup) === realOf(backupArg)) : history.at(-1);
}
/** 解包后 upgrade.json 是升级前的版本：把这次的记录补回去，标成 rolled-back。 */
export function ujPutRolledBack(repo, entry, { preBackup, health, skipped }) {
  const doc = ujRead(repo);
  const history = Array.isArray(doc.history) ? doc.history : [];
  const next = { ...entry, result: 'rolled-back', rolledBackAt: new Date().toISOString() };
  if (preBackup) next.rollbackPreBackup = preBackup;
  if (health === 'fail') next.rollbackHealth = 'failed';
  if (skipped.length) next.rollbackSkipped = skipped;
  const i = history.findIndex((h) => h?.at === entry.at && h?.backup === entry.backup);
  if (i >= 0) history[i] = next; else history.push(next);
  ujWrite(repo, { ...doc, history });
}
/** 保留规则：三类备份各只留最新 3 份（按文件名里的时间排序）；只认这三种文件名，目录里别的东西一概不碰。 */
export function pruneBackups(repo, dir, protectList) {
  const KEEP = 3;
  const protect = new Set(protectList.filter(Boolean).map((x) => path.resolve(x)));
  const kinds = [
    { re: /^update-\d{8}-\d{6}-.+\.tar\.gz$/, dir: false },
    { re: /^rollback-pre-\d{8}-\d{6}(-\d+)?\.tar\.gz$/, dir: false },
    { re: /^first-run-\d{8}-\d{6}$/, dir: true }
  ];
  const removed = new Set();
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const kind of kinds) {
    const hits = names.filter((n) => {
      if (!kind.re.test(n)) return false;
      const st = fs.lstatSync(path.join(dir, n));
      return kind.dir ? st.isDirectory() : st.isFile();
    }).sort().reverse();
    for (const n of hits.slice(KEEP)) {
      const abs = path.resolve(dir, n);
      if (protect.has(abs)) continue;
      fs.rmSync(abs, { recursive: kind.dir, force: true });
      removed.add(abs);
    }
  }
  if (removed.size && fs.existsSync(ujFile(repo))) {
    const doc = ujRead(repo);
    const gone = (x) => typeof x === 'string' && x !== '' && removed.has(path.resolve(x));
    for (const h of Array.isArray(doc.history) ? doc.history : []) {
      if (!h || typeof h !== 'object') continue;
      if (gone(h.backup)) h.backupPruned = true;
      if (gone(h.firstRunBackup)) h.firstRunBackupPruned = true;
      if (gone(h.rollbackPreBackup)) h.rollbackPreBackupPruned = true;
    }
    if (doc.firstRun && gone(doc.firstRun.backup)) doc.firstRun.backupPruned = true;
    ujWrite(repo, doc);
  }
  return removed.size;
}
/** 首次迁移挪进覆盖层的文件放回原处（老版本程序只读 roles/ 和出厂文件），并删掉迁移新建的覆盖层文件。 */
export function restoreFirstRun(repo, dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const inside = (rel) => {
    const abs = path.resolve(repo, rel);
    if (!abs.startsWith(path.resolve(repo) + path.sep)) throw new Error(`路径越界：${rel}`);
    return abs;
  };
  let n = 0;
  for (const item of manifest.items ?? []) {
    const abs = inside(item.path);
    const saved = path.join(dir, 'files', item.path);
    if (['role-modified', 'role-untracked', 'preset', 'rag-config'].includes(item.kind) && fs.existsSync(saved)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(saved, abs);
      n += 1;
    } else if (item.kind === 'role-deleted') {
      fs.rmSync(abs, { force: true });
      n += 1;
    }
    if (item.created) fs.rmSync(inside(item.created), { force: true });
  }
  if (manifest.hidden?.created) fs.rmSync(path.join(repo, 'state', 'roles', 'hidden.json'), { force: true });
  return n;
}

export const updateCommand = () => (process.platform === 'win32' ? 'update.bat' : 'bash scripts/update.sh');
export const rollbackCommand = () => (process.platform === 'win32' ? 'rollback.bat' : 'bash scripts/rollback.sh');
export const startCommand = () => (process.platform === 'win32' ? 'start-all.bat' : './start-all.sh');
