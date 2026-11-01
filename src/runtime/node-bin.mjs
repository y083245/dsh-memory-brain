// 为「长期写进配置」的场景挑一个靠得住的 node 可执行文件。
//
// 为什么需要它：MCP server 的 command 会被 setup-dsh.mjs 写进 DSH 的
// cordis.patch.yml，之后每次 DSH 启动都按这个绝对路径拉进程。如果写进去的是
// **临时目录里的 node**（WorkBuddy/豆包沙箱的便携 node、pnpm 的 .pnpm 目录、
// node_modules/.bin 垫片、Windows 的 %TEMP%），宿主一升级或会话一结束，那个
// 路径就消失，DSH 里所有 MCP 同时挂掉 —— 而日志只会说「MCP 启动失败」，
// 极难查到根因。这里把「临时 node」识别出来，优先换成系统安装的 node。
import fs from 'node:fs';
import path from 'node:path';
import { findExecutable } from './commands.mjs';

function isFile(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

// 会被宿主回收/升级覆盖的路径特征。
const EPHEMERAL_PATTERNS = [
  /[\\/]Temp[\\/]/i,
  /[\\/]\.tmp[\\/]/i,
  /sandbox_runtime/i,
  /[\\/]\.workbuddy[\\/]binaries[\\/]/i,
  /[\\/]node_modules[\\/]\.bin[\\/]/i,
  /[\\/]\.pnpm[\\/]/i,
  /[\\/]pnpm[\\/]store[\\/]/i,
  /[\\/]\.cache[\\/]/i,
  /[\\/]var[\\/]folders[\\/]/i,
  /^[\\/](?:tmp|var[\\/]tmp)[\\/]/i
];

/** 这个 node 路径是不是「随时可能消失」的临时/沙箱安装。 */
export function looksEphemeralNode(file, { platform = process.platform } = {}) {
  const value = String(file ?? '').trim();
  if (!value) return false;
  const normalized = platform === 'win32' ? value.replace(/\//g, '\\') : value;
  return EPHEMERAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 各平台常见的「正经装过」的 node 位置。 */
function systemNodeCandidates(env, platform) {
  if (platform === 'win32') {
    const out = [];
    for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
      if (env[key]) out.push(path.win32.join(env[key], 'nodejs', 'node.exe'));
    }
    if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
    // nvm-windows：NVM_SYMLINK 指向当前启用版本的软链，升版本后仍然有效。
    for (const key of ['NVM_SYMLINK', 'NVM_HOME']) {
      if (env[key]) out.push(path.win32.join(env[key], 'node.exe'));
    }
    return out;
  }
  return ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node', '/snap/bin/node'];
}

/**
 * 解析一个适合写进配置的 node。
 *
 * 优先级：QQ_BRIDGE_NODE_BIN > PATH 里的 node（非临时） > 系统安装位置 > 当前进程的 node。
 * 最后一档只是兜底：调用方应当根据 `ephemeral` 提示用户显式指定。
 *
 * @returns {{command:string, source:'explicit'|'path'|'system'|'execPath', ephemeral:boolean}}
 */
export function resolveStableNode({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fsImpl = fs
} = {}) {
  const explicit = String(env.QQ_BRIDGE_NODE_BIN ?? '').trim();
  if (explicit && isFile(explicit, fsImpl)) {
    return { command: explicit, source: 'explicit', ephemeral: looksEphemeralNode(explicit, { platform }) };
  }

  const fromPath = findExecutable('node', { env, platform, fsImpl });
  if (fromPath && !looksEphemeralNode(fromPath, { platform })) {
    return { command: fromPath, source: 'path', ephemeral: false };
  }

  for (const candidate of systemNodeCandidates(env, platform)) {
    if (isFile(candidate, fsImpl)) {
      return { command: candidate, source: 'system', ephemeral: false };
    }
  }

  // 兜底：优先用当前进程的 node（一定跑得起来），临时与否如实回报。
  const fallback = [execPath, fromPath].find((candidate) => candidate && !looksEphemeralNode(candidate, { platform }))
    || execPath || fromPath;
  return { command: fallback, source: 'execPath', ephemeral: looksEphemeralNode(fallback, { platform }) };
}
