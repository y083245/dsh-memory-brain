// Python 解释器解析。
//
// 优先用项目自己的 venv（Windows: .venv\Scripts\python.exe，其它: .venv/bin/python）；
// venv 不存在时按平台回退到系统解释器：Windows 依次 py、python、python3，其它系统
// 依次 python3、python、py。py 启动器统一带 -3，避免落到 Python 2。
import fs from 'node:fs';
import path from 'node:path';
import { findExecutable } from './commands.mjs';

function isFile(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

/**
 * @param {{venvDir?:string, platform?:string, env?:object, fsImpl?:object}} [options]
 * @returns {{command:string, args:string[], source:'venv'|'system', name?:string}|null}
 */
export function resolvePython({
  venvDir,
  platform = process.platform,
  env = process.env,
  fsImpl = fs
} = {}) {
  if (venvDir) {
    const candidate = path.join(
      venvDir,
      platform === 'win32' ? 'Scripts' : 'bin',
      platform === 'win32' ? 'python.exe' : 'python'
    );
    if (isFile(candidate, fsImpl)) return { command: candidate, args: [], source: 'venv', name: 'venv-python' };
  }
  // 与需求一致的回退顺序：py → python → python3。
  const names = ['py', 'python', 'python3'];
  for (const name of names) {
    const command = findExecutable(name, { env, platform, fsImpl });
    if (!command) continue;
    // py 是 Windows 启动器，显式选 Python 3；python/python3 已是解释器本身。
    return { command, args: name === 'py' && platform === 'win32' ? ['-3'] : [], source: 'system', name };
  }
  return null;
}
