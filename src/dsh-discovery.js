// DSH 端点发现：同时适配 `dsh web`（固定端口，默认 3080）与 DeepSeek Harness 桌面版。
//
// 桌面版和 `dsh web` 跑的是同一个 Web Host（同一套 /api、同一份 ~/.dsh/.credentials.yaml
// 签名密钥），区别只有两点（实测 0.2.1-rc.5）：
//   1. 端口：桌面版以 `--host 127.0.0.1 --port 0` 启动，**每次随机**；URL 只经 IPC 交给
//      Electron 主进程，不落盘。
//   2. profile：桌面版固定用 `profiles/desktop`，`dsh web` 默认用 `profiles/web`。
// 所以桥接不能写死 3080：这里按进程找到桌面版的 Host 子进程
// （命令行含 `dsh-desktop-host/lib/index.js`，第 2 个参数就是它的 profile 目录），
// 再列出它在监听的回环端口，逐个用铸造的 Cookie 调一次 `settings/describe` 确认。
//
// 进程列表与端口都用系统自带命令取（Windows: PowerShell CIM + Get-NetTCPConnection，
// 退回 netstat；macOS/Linux: ps + lsof），只走 execFile 数组参数，不经 shell。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, resolveDshHome } from './dsh-client.js';

export const DEFAULT_WEB_URL = 'http://127.0.0.1:3080';
const DESKTOP_HOST_MARKER = /dsh-desktop-host[\\/]+lib[\\/]+index\.js/i;

function run(command, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(error && !stdout ? '' : String(stdout ?? ''));
      });
    } catch {
      resolve('');
    }
  });
}

/** 按 Windows 命令行规则（CommandLineToArgvW 的常用子集）拆参数。 */
export function splitWindowsCommandLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  const s = String(line ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {
      let n = 0;
      while (s[i + n] === '\\') n += 1;
      if (s[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) { cur += '"'; i += n; } else { i += n - 1; }
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
      has = true;
    } else if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && (ch === ' ' || ch === '\t')) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * 从桌面版 Host 子进程的命令行里取出 profile 目录与 DSH home。
 * 形如：`DeepSeek Harness.exe --expose-internals <…>/dsh-desktop-host/lib/index.js <runtimeDir> <profileDir> …`
 */
export function parseDesktopHostCommandLine(commandLine, { platform = process.platform } = {}) {
  if (!DESKTOP_HOST_MARKER.test(String(commandLine ?? ''))) return null;
  const argv = platform === 'win32'
    ? splitWindowsCommandLine(commandLine)
    : String(commandLine).split(/\s+/).filter(Boolean);
  const index = argv.findIndex((arg) => DESKTOP_HOST_MARKER.test(arg));
  if (index < 0) return { profileDir: '', dshHome: '' };
  const profileDir = argv[index + 2] ?? '';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dshHome = profileDir && p.basename(p.dirname(profileDir)).toLowerCase() === 'profiles'
    ? p.dirname(p.dirname(profileDir))
    : '';
  return { profileDir, dshHome };
}

const WINDOWS_SCAN = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$procs = @(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%dsh-desktop-host%' AND ProcessId <> $PID\")",
  '$out = @()',
  'foreach ($p in $procs) {',
  '  $ports = @()',
  '  try { $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction Stop | Select-Object -ExpandProperty LocalPort) } catch { $ports = @() }',
  '  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"',
  '  $out += [pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; appExe = [string]$parent.ExecutablePath; cmd = [string]$p.CommandLine; ports = @($ports | ForEach-Object { [int]$_ }) }',
  '}',
  'ConvertTo-Json -InputObject @($out) -Compress -Depth 4'
].join('\n');

/** 解析 `netstat -ano -p tcp`：返回 pid -> 回环/任意地址上的监听端口。 */
export function parseNetstatListening(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue;
    // 状态列会被本地化（德语 ABHÖREN 等），所以不看文字：监听行的对端一定是 :0。
    if (!/:0$/.test(cols[2])) continue;
    const match = /^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)$/.exec(cols[1]);
    const pid = Number(cols[cols.length - 1]);
    if (!match || !Number.isInteger(pid)) continue;
    if (!map.has(pid)) map.set(pid, new Set());
    map.get(pid).add(Number(match[2]));
  }
  return map;
}

async function scanWindows() {
  const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCAN], { timeout: 15000 });
  let rows = [];
  try {
    const parsed = JSON.parse(raw.trim() || '[]');
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = [];
  }
  const hosts = rows.filter((row) => row && Number.isInteger(row.pid));
  // Get-NetTCPConnection 在精简系统 / 无 NetTCPIP 模块时拿不到端口：退回 netstat。
  if (hosts.some((host) => !Array.isArray(host.ports) || host.ports.length === 0)) {
    const netstat = parseNetstatListening(await run('netstat', ['-ano', '-p', 'tcp']));
    for (const host of hosts) {
      if (!host.ports?.length) host.ports = [...(netstat.get(host.pid) ?? [])];
    }
  }
  // 查询用的 PowerShell 自己的命令行也含 'dsh-desktop-host'：解析不出 Host 形状的一律丢掉。
  return hosts
    .map((host) => ({ host, parsed: parseDesktopHostCommandLine(host.cmd, { platform: 'win32' }) }))
    .filter(({ parsed }) => parsed)
    .map(({ host, parsed }) => ({ pid: host.pid, ppid: host.ppid, appExe: host.appExe || '', ports: host.ports ?? [], ...parsed }));
}

async function scanPosix(platform) {
  const ps = await run('ps', ['-axww', '-o', 'pid=,command=']);
  const hosts = [];
  for (const line of ps.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !DESKTOP_HOST_MARKER.test(match[2])) continue;
    const pid = Number(match[1]);
    const lsof = await run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
    const ports = [...lsof.matchAll(/^n.*:(\d+)$/gm)].map((m) => Number(m[1]));
    hosts.push({ pid, ports, ...parseDesktopHostCommandLine(match[2], { platform }) });
  }
  return hosts;
}

/** 列出正在运行的桌面版 Host：[{ pid, ports, profileDir, dshHome }]。 */
export async function findDesktopHosts({ platform = process.platform } = {}) {
  try {
    return platform === 'win32' ? await scanWindows() : await scanPosix(platform);
  } catch {
    return [];
  }
}

function sameDir(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const norm = (value) => path.resolve(String(value)).replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** 用铸造 Cookie 调一次 settings/describe；能答就是一个可用的 DSH。 */
export async function probeDsh(baseUrl, { timeoutMs = 4000, auth } = {}) {
  try {
    const api = new NodeApiClient(baseUrl, timeoutMs, auth ?? {});
    const response = await api.callUnary('settings/describe', {}, AbortSignal.timeout(timeoutMs));
    return response?.result?.ok === true;
  } catch {
    return false;
  }
}

/**
 * 决定桥接该连哪一个 DSH。
 *
 * target：
 *   - 'web'     只用 baseUrl（`dsh web`）；
 *   - 'desktop' 只用桌面版（找不到就返回 null）；
 *   - 'auto'    （默认）baseUrl 能答就用它，否则找桌面版。
 * @returns {Promise<{ baseUrl:string, kind:'web'|'desktop', pid?:number, profileDir?:string,
 *                     dshHome?:string, homeMismatch?:boolean } | null>}
 */
export async function resolveDshEndpoint({
  baseUrl = DEFAULT_WEB_URL,
  target = 'auto',
  auth,
  platform = process.platform,
  timeoutMs = 4000,
  findHosts = findDesktopHosts,
  probe = probeDsh
} = {}) {
  const mode = ['web', 'desktop'].includes(target) ? target : 'auto';
  const web = String(baseUrl || DEFAULT_WEB_URL).replace(/\/+$/, '');
  if (mode !== 'desktop' && await probe(web, { timeoutMs, auth })) return { baseUrl: web, kind: 'web' };
  if (mode === 'web') return null;
  const ourHome = resolveDshHome();
  const hosts = await findHosts({ platform });
  // 与本进程同一个 DSH_HOME 的桌面版排前面：签名密钥只对它有效。
  hosts.sort((a, b) => Number(sameDir(b.dshHome, ourHome, platform)) - Number(sameDir(a.dshHome, ourHome, platform)));
  for (const host of hosts) {
    for (const port of host.ports ?? []) {
      const url = `http://127.0.0.1:${port}`;
      if (await probe(url, { timeoutMs, auth })) {
        return {
          baseUrl: url,
          kind: 'desktop',
          pid: host.pid,
          appPid: host.ppid,
          appExe: host.appExe,
          profileDir: host.profileDir,
          dshHome: host.dshHome,
          homeMismatch: Boolean(host.dshHome) && !sameDir(host.dshHome, ourHome, platform)
        };
      }
    }
  }
  return null;
}

/** 给日志用的一句话描述。 */
export function describeEndpoint(endpoint) {
  if (!endpoint) return '未找到可用的 DSH';
  return endpoint.kind === 'desktop'
    ? `DSH 桌面版 ${endpoint.baseUrl}（PID ${endpoint.pid}，profile: desktop）`
    : `dsh web ${endpoint.baseUrl}（profile: web）`;
}

/**
 * DSH 里有没有能用的模型（登录了 DeepSeek 账号或填了 API Key）。
 * 全新安装的 DSH 模型目录是空的（routableProviders: []），QQ 消息会全部以
 * `session/model-unavailable` 失败——这一步要在启动时就说清楚。
 * @returns {Promise<{ ok:boolean|null, providers:string[] }>} ok=null 表示查不到（不下结论）。
 */
export async function checkDshModels(baseUrl, { timeoutMs = 8000, auth } = {}) {
  try {
    const api = new NodeApiClient(baseUrl, timeoutMs, auth ?? {});
    const response = await api.callUnary('session/modelCatalog', {}, AbortSignal.timeout(timeoutMs));
    const providers = response?.result?.value?.routableProviders;
    if (!Array.isArray(providers)) return { ok: null, providers: [] };
    return { ok: providers.length > 0, providers };
  } catch {
    return { ok: null, providers: [] };
  }
}

/** 桥接依赖的两个预设；缺了就拒绝建群聊 / 仿真会话。 */
export const REQUIRED_PRESETS = ['qq-chat', 'qq-chat-v2'];

/** 问 DSH：预设注册上了没有。ok=null 表示查询本身失败（不等于没注册）。 */
export async function checkDshPresets(baseUrl, { timeoutMs = 8000, auth, requiredPresets = REQUIRED_PRESETS } = {}) {
  try {
    const api = new NodeApiClient(baseUrl, timeoutMs, auth ?? {});
    const response = await api.callUnary('agentPresets/list', {}, AbortSignal.timeout(timeoutMs));
    const presets = response?.result?.value?.presets;
    if (!Array.isArray(presets)) return { ok: null, ids: [], missing: [] };
    const ids = presets.map((p) => String(p?.id ?? ''));
    const missing = requiredPresets.filter((id) => !ids.includes(id));
    return { ok: missing.length === 0, ids, missing };
  } catch {
    return { ok: null, ids: [], missing: [] };
  }
}

/**
 * 预设没注册时看磁盘：把 DSH 跳过 bundle 的几种常见原因逐条查一遍（只读）。
 * 桌面版的「恢复」会把第三方 bundle 从 profile 里摘掉；更新也可能让链接失效。
 * @returns 给用户看的若干行诊断。
 */
export function diagnosePresetProfile({ home, profile, fsImpl = fs }) {
  const dir = path.join(home, 'profiles', profile);
  const lines = [`profile：${dir}`];
  const manifestFile = path.join(dir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    lines.push(`读不了 package.json（${error?.code ?? error?.message}）：重新运行 node scripts/setup-dsh.mjs ${profile}`);
    return lines;
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes('qq-agent-presets')) {
    lines.push('dsh.profile.bundles 里没有 qq-agent-presets（桌面版的「恢复 / 禁用插件」会把它摘掉）：重新运行 node scripts/setup-dsh.mjs，再完全重启 DSH');
  }
  const link = path.join(dir, 'node_modules', 'qq-agent-presets');
  const pkgFile = path.join(link, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fsImpl.readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    lines.push(`${link} 读不到 package.json（${error?.code ?? error?.message}）：链接失效或 DSH 更新时被清掉了，重新运行 node scripts/setup-dsh.mjs`);
  }
  const patches = pkg?.dsh?.bundle?.patch;
  if (pkg && !Array.isArray(patches)) lines.push('qq-agent-presets/package.json 里没有 dsh.bundle.patch');
  for (const rel of Array.isArray(patches) ? patches : []) {
    if (!fsImpl.existsSync(path.join(link, rel))) lines.push(`bundle patch 不存在：${rel}（运行 node scripts/build-agent-preset-patches.mjs）`);
  }
  if (pkg?.engines?.dsh || Object.keys(pkg?.peerDependencies ?? {}).some((name) => name.startsWith('@deepseek-ai/dsh'))) {
    lines.push('qq-agent-presets 声明了 dsh 版本要求：版本不符时 DSH 会跳过它');
  }
  if (lines.length === 1) lines.push('磁盘上看 bundle 都正常：DSH 可能还没重启，或启动时跳过了它（看 DSH 的启动日志里 disabling / skipped 的行）');
  return lines;
}

/** 没有可用模型时给用户的操作提示（按 DSH 版本区分）。 */
export function modelSetupHint(endpoint) {
  return endpoint?.kind === 'desktop'
    ? '在 DSH 桌面版里登录 DeepSeek 账号，或在「设置 → 模型」里填 DeepSeek API Key（填完不用重启）'
    : `浏览器打开 ${endpoint?.baseUrl ?? DEFAULT_WEB_URL}，在「设置 → 模型」里登录 DeepSeek 账号或填 API Key（填完不用重启）`;
}
