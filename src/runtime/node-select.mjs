// 一键启动该用哪个 node（只用 Node 内置模块：入口要在依赖装好之前就调用它）。
//
// 为什么需要它：start-all.sh 是 `exec node`，而 ssh 执行命令、cron 这类非交互 shell 不加载
// ~/.bashrc，用 nvm 的人拿到的是系统 node。系统版只要 >= 22.13 就能过入口的版本检查，
// 可编排器拿 process.execPath 去起服务：DSH 要更新的版本，SnowLuma 要带 cap_sys_ptrace 的 node，
// 于是服务起到一半才失败。这里在起任何服务之前挑好 node，挑不到就说清楚。
//
// Windows 不走这里：QQ、SnowLuma 由用户自己管，桌面版 DSH 自带运行时，也没有 nvm 目录这回事。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOrchestratorPaths } from './paths.mjs';
import { isQqEnabled } from './channel-config.mjs';

// DSH 源码版的 engines 读不到时用的值。npm 全局版的 package.json 本来就不声明 engines。
const DSH_NODE_FALLBACK = '24.9.0';

function isFile(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

/** 'v24.22.1' / '24.22' → [24, 22, 1] / [24, 22, 0]；不是版本号返回 null。 */
export function parseNodeVersion(text) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function compareVersions(a, b) {
  const [x, y] = [parseNodeVersion(a), parseNodeVersion(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

export function versionAtLeast(version, min) {
  if (!parseNodeVersion(version) || !parseNodeVersion(min)) return false;
  return compareVersions(version, min) >= 0;
}

/**
 * nvm 目录里装的 node，好的在前：`nvm alias default` 指向的版本优先（和交互 shell 看到的一致），
 * 其余从新到旧。alias 是 lts/* 这类写法时认不出，就只按新旧排。
 *
 * @returns {{path:string, version:string}[]}
 */
export function listNvmNodes({ env = process.env, home = os.homedir(), fsImpl = fs } = {}) {
  const nvmDir = String(env.NVM_DIR ?? '').trim() || path.join(home, '.nvm');
  let names = [];
  try { names = fsImpl.readdirSync(path.join(nvmDir, 'versions', 'node')); } catch { return []; }
  let alias = '';
  try { alias = fsImpl.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf8').trim().replace(/^v/, ''); } catch { /* 没设默认版本 */ }
  const isDefault = (version) => /^\d/.test(alias) && (version === alias || version.startsWith(`${alias}.`));

  return names
    .filter((name) => parseNodeVersion(name))
    .map((name) => ({ path: path.join(nvmDir, 'versions', 'node', name, 'bin', 'node'), version: name.replace(/^v/, '') }))
    .filter((node) => isFile(node.path, fsImpl))
    .sort((a, b) => (isDefault(b.version) - isDefault(a.version)) || compareVersions(b.version, a.version));
}

function enginesMin(file, fsImpl) {
  let doc;
  try { doc = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return ''; }
  const match = />=\s*v?(\d+\.\d+(?:\.\d+)?)/.exec(String(doc?.engines?.node ?? ''));
  return match ? match[1] : '';
}

/**
 * DSH 对 node 的要求。strict 表示确实知道要这个版本，不满足就不启动；
 * 不 strict 只是尽量满足，不满足时告警：npm 全局版没声明 engines，不能凭猜测拦住用户。
 *
 * @returns {{min:string, source:string, strict:boolean}|null} null 表示 DSH 不用这个 node
 *   （config.json 自定义的启动命令、桌面版自带的运行时）。
 */
export function dshNodeRequirement(paths, { fsImpl = fs } = {}) {
  const { kind, command } = paths.dshCommand;
  if (kind === 'source') {
    const file = path.join(paths.dshDir, 'package.json');
    return { min: enginesMin(file, fsImpl) || DSH_NODE_FALLBACK, source: file, strict: true };
  }
  if (kind !== 'cli') return null;
  if (path.isAbsolute(command) && isFile(command, fsImpl)) {
    let real = command;
    try { real = fsImpl.realpathSync(command); } catch { /* 用原路径 */ }
    if (/[\\/]resources[\\/]runtime[\\/]/.test(real)) return null;
  }
  return { min: DSH_NODE_FALLBACK, source: 'DSH 的一般要求', strict: false };
}

/** 这个 node 有没有 cap_sys_ptrace（SnowLuma 靠它注入 QQ）。 */
export function hasPtraceCap(nodeBin, { exec = execFileSync, fsImpl = fs } = {}) {
  let real;
  try { real = fsImpl.realpathSync(nodeBin); } catch { return false; }
  // Debian 普通用户的 PATH 里没有 /usr/sbin，找不到 getcap 不等于没有权限。
  for (const getcap of ['getcap', '/usr/sbin/getcap', '/sbin/getcap']) {
    try {
      return String(exec(getcap, [real], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })).includes('cap_sys_ptrace');
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
  }
  return false;
}

/**
 * 在当前 node 和候选里挑最合适的：版本够比有权限重要，都一样时留在当前这个，
 * 候选之间取靠前的。低于 entryMin 的跑不了编排器，不考虑。
 *
 * @returns {{path:string, version:string}|null} null 表示不用换。
 */
export function pickStartNode({ current, candidates, minVersion, entryMin, hasCap }) {
  const score = (node) => (!minVersion || versionAtLeast(node.version, minVersion) ? 2 : 0) + (hasCap(node.path) ? 1 : 0);
  let best = null;
  let bestScore = versionAtLeast(current.version, entryMin) ? score(current) : -1;
  if (bestScore === 3) return null;
  for (const node of candidates) {
    if (!versionAtLeast(node.version, entryMin)) continue;
    const value = score(node);
    if (value > bestScore) {
      best = node;
      bestScore = value;
    }
  }
  return best;
}

/**
 * 入口用：当前 node 不合适、nvm 里有更合适的，就返回要换成哪个。
 * 用 NODE_BIN / orchestrator.nodeBin 指定过的不替用户改，由 nodeVersionProblem 检查。
 *
 * @returns {{path:string, version:string, note:string}|null}
 */
export function planStartNode({
  root,
  entryMin,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  execPath = process.execPath,
  version = process.versions.node,
  fsImpl = fs,
  hasCap = (file) => hasPtraceCap(file, { fsImpl })
} = {}) {
  if (platform === 'win32') return null;
  const paths = resolveOrchestratorPaths({ root, env, platform, home, fsImpl, execPath });
  if (paths.nodeBinExplicit) return null;
  const requirement = dshNodeRequirement(paths, { fsImpl });
  const preferCap = isQqEnabled(paths.config);
  const picked = pickStartNode({
    current: { path: execPath, version },
    candidates: listNvmNodes({ env, home, fsImpl }),
    minVersion: requirement?.min ?? '',
    entryMin,
    hasCap: preferCap ? hasCap : () => false
  });
  if (!picked) return null;
  const reasons = [];
  if (requirement && !versionAtLeast(version, requirement.min)) reasons.push(`DSH 要 >= ${requirement.min}`);
  if (!versionAtLeast(version, entryMin)) reasons.push(`本项目至少要 ${entryMin}`);
  if (preferCap && !hasCap(execPath) && hasCap(picked.path)) reasons.push('它没有 cap_sys_ptrace');
  return {
    ...picked,
    note: `当前 node 是 v${version}（${execPath}），${reasons.join('、')}，改用 nvm 里的 v${picked.version}（${picked.path}）`
  };
}

/** 起服务要用的 node 能不能跑 DSH；返回要报给用户的错误行，空数组表示没问题。 */
export function nodeVersionProblem({
  paths,
  requirement,
  execPath = process.execPath,
  version = process.versions.node,
  exec = execFileSync
}) {
  if (!requirement) return [];
  let actual = version;
  if (paths.nodeBin !== execPath) {
    try {
      actual = String(exec(paths.nodeBin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch {
      return [`这个 node 跑不起来：${paths.nodeBin}（检查 NODE_BIN 或 config.json 的 orchestrator.nodeBin）`];
    }
  }
  if (versionAtLeast(actual, requirement.min)) return [];
  const where = paths.nodeBinExplicit
    ? '它是 NODE_BIN / orchestrator.nodeBin 指定的，换一个版本够的再重新运行。'
    : 'ssh 执行命令、cron 这类非交互 shell 不加载 nvm，拿到的常常是系统 node，nvm 目录里也没找到合适的版本。';
  return [
    `node v${actual}（${paths.nodeBin}）不满足 DSH 的要求：至少 v${requirement.min}（${requirement.source}）。`,
    `  ${where}`,
    '  装一个新版（nvm install 24），或用 NODE_BIN=/path/to/node（config.json 的 orchestrator.nodeBin）指定。'
  ];
}
