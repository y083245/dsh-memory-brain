// 端口探测与等待 —— 跨平台，只用 node:net。
//
// 不调 `ss` / `netstat`：Windows 原生没有 ss，netstat 的输出格式和权限要求又随版本变化；
// Node 自己连一下回环地址既能判断「有没有人在监听」，也不会被系统命令的本地化输出影响。
import net from 'node:net';

/** 连一次回环端口；连上 = 有人在监听。超时/拒绝都按「没在监听」处理。 */
export function isPortOpen(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 已经关了 */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 端口空着 = 没人在监听。注意 EACCES 等错误也按「空着」处理，和旧脚本的 ss 判断一致。 */
export async function isPortFree(port, options) {
  return !(await isPortOpen(port, options));
}

/**
 * 轮询直到端口被监听或超时。
 * @param {number} port
 * @param {number} seconds 最长等待秒数（与旧脚本的 wait_port 参数一致）
 * @param {{host?:string, intervalMs?:number, isOpen?:Function}} [options]
 * @returns {Promise<boolean>}
 */
export async function waitForPort(port, seconds, { host = '127.0.0.1', intervalMs = 1000, isOpen = isPortOpen } = {}) {
  const deadline = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  for (;;) {
    if (await isOpen(port, { host })) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }
}

/** 同时等多个端口（OneBot 的 3000/3001 要一起就绪）。 */
export async function waitForPorts(ports, seconds, options = {}) {
  const deadline = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  for (;;) {
    const results = await Promise.all(ports.map((port) => isPortOpen(port, options)));
    if (results.every(Boolean)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs ?? 1000, left)));
  }
}
