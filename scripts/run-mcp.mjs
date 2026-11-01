// MCP 包装脚本的公共启动器：用当前 Node 可执行文件（process.execPath）跑外部工具，
// 不再写死 nvm 路径。stdio 直接继承，MCP 的 JSON-RPC 才能原样走通。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * @param {{entry:string, env?:object, label?:string}} options
 */
export function runMcp({ entry, env = {}, label = 'MCP' } = {}) {
  if (!entry || !fs.existsSync(entry)) {
    console.error(`[${label}] 找不到入口：${entry || '(空)'}`);
    console.error('  可用 AI_COMPANION_KIT_DIR 指向 ai-companion-kit 的目录。');
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    windowsHide: false
  });
  const forward = (signal) => {
    try { child.kill(signal); } catch { /* 子进程可能已退出 */ }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.on(signal, () => forward(signal)); } catch { /* Windows 不支持的信号 */ }
  }
  child.on('error', (error) => {
    console.error(`[${label}] 启动失败：${error?.message ?? error}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); return; } catch { /* 退回退出码 */ }
    }
    process.exitCode = code ?? 0;
  });
}

export function kitDir(env = process.env) {
  return env.AI_COMPANION_KIT_DIR || path.join(os.homedir(), 'ai-companion-kit', 'ai-companion-kit-main');
}
