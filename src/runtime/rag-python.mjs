import fs from 'node:fs';
import path from 'node:path';
import { findExecutable } from './commands.mjs';
import { execFileP } from './process.mjs';

const IMPORT_CHECK = [
  'import sys',
  'if sys.version_info < (3, 12):',
  '    sys.exit(1)',
  'import chromadb, fastapi, httpx, jieba, numpy, uvicorn, yaml',
].join('\n');

export class MemoryRagStartError extends Error {}

/** Prefer a working interpreter. Only install packages into the project's Windows venv. */
export async function prepareWindowsRagPython({ ragDir, python, log, deps }) {
  const venvDir = path.join(ragDir, '.venv');
  const venvPython = path.join(venvDir, 'Scripts', 'python.exe');
  const isFile = deps.isFile ?? ((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true);
  const exec = deps.execFile ?? execFileP;
  const venv = { command: venvPython, args: [] };
  const selected = isFile(venvPython) ? venv : python;
  const probe = async ({ command, args = [] }) => {
    const result = await exec(command, [...args, '-c', IMPORT_CHECK], { cwd: ragDir, timeout: 15000 });
    return result.code === 0;
  };
  if (selected?.command && await probe(selected)) return selected;

  const uv = (deps.findExecutable ?? findExecutable)('uv.exe', { platform: 'win32' });
  if (!uv) {
    throw new MemoryRagStartError('找不到可用的 Python 3.12+ 环境或 RAG 依赖。请安装 uv，重新打开启动终端后重试。');
  }
  log('[rag] 正在准备 Windows RAG 的 Python 3.12 环境和依赖…');
  if (!isFile(venvPython)) {
    const created = await exec(uv, ['venv', '--allow-existing', '--python', '3.12', venvDir], { cwd: ragDir, timeout: 180000 });
    if (created.code !== 0 || !isFile(venvPython)) {
      throw new MemoryRagStartError('创建 RAG 的 Python 3.12 环境失败。请检查 uv、网络和项目目录写入权限后重试。');
    }
  }
  const installed = await exec(uv, ['pip', 'install', '--python', venvPython, '-e', '.'], { cwd: ragDir, timeout: 300000 });
  if (installed.code !== 0) {
    throw new MemoryRagStartError('安装 RAG 的 Python 依赖失败。请检查 Python 包下载网络和项目目录写入权限后重试。');
  }
  if (!(await probe(venv))) {
    throw new MemoryRagStartError('RAG 依赖已安装，但项目 Python 无法加载。请核对 Windows RAG 安装步骤。');
  }
  return venv;
}
