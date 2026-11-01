// 外部命令定位 —— 只负责「找到可执行文件」，不负责启动。
//
// Windows 的 npm / pnpm / dsh 入口通常是 .cmd 垫片，Node 的 spawn 不能直接执行 .cmd
// （没有 shell 会 EINVAL）。这里优先把垫片里的 JS 入口解析出来，用 process.execPath
// 直接跑；解析不出来才退回 cmd.exe（固定参数、不拼用户输入）。
import fs from 'node:fs';
import path from 'node:path';

function isFile(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

function pathValue(env) {
  return env?.PATH ?? env?.Path ?? env?.path ?? '';
}

/** 在 PATH 里找命令（Windows 按 PATHEXT 补扩展名）。找不到返回 null。 */
export function findExecutable(name, { env = process.env, platform = process.platform, fsImpl = fs } = {}) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return isFile(raw, fsImpl) ? raw : null;
  const exts = platform === 'win32'
    ? (path.extname(raw) ? [''] : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : [''];
  for (const dir of pathValue(env).split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, raw + ext);
      if (isFile(candidate, fsImpl)) return candidate;
    }
  }
  return null;
}

/**
 * 从 npm / corepack 生成的 .cmd 垫片里解析真正的 JS 入口。
 *
 * 典型垫片：
 *   "%_prog%"  "%dp0%\node_modules\@deepseek-ai\dsh\bin.js" %*
 *   "%~dp0\node_modules\corepack\dist\pnpm.js" %*
 * 只认相对垫片目录的一段路径；解析不到就返回 null（交给 cmd.exe 兜底）。
 */
export function resolveShimScript(shimPath, { fsImpl = fs } = {}) {
  let text;
  try { text = fsImpl.readFileSync(shimPath, 'utf8'); } catch { return null; }
  const patterns = [
    /%dp0%\\([^"\r\n]+?\.(?:js|cjs|mjs))/i,
    /%~dp0\\([^"\r\n]+?\.(?:js|cjs|mjs))/i,
    /%~dp0\/([^"\r\n]+?\.(?:js|cjs|mjs))/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const candidate = path.resolve(path.dirname(shimPath), match[1].replace(/\\/g, '/'));
    if (isFile(candidate, fsImpl)) return candidate;
  }
  return null;
}

/** cmd.exe 的保守引用：只在有空白/特殊字符时加引号；路径里的 `"` 直接拒绝。 */
function quoteForCmd(value) {
  const s = String(value);
  if (/["\r\n]/.test(s)) throw new Error(`命令参数里不能有双引号或换行：${JSON.stringify(s)}`);
  if (!/[\s&|<>^()]/.test(s)) return s;
  return `"${s}"`;
}

/**
 * 把「命令 + 参数数组」变成 spawn/execFile 能直接用的形态。
 *
 * @returns {{command:string,args:string[],windowsVerbatimArguments?:boolean,resolved?:string,via?:string}}
 */
export function commandSpec(command, args = [], {
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  nodeBin = process.execPath
} = {}) {
  const raw = String(command ?? '').trim();
  if (!raw) throw new Error('命令为空');
  const resolved = path.isAbsolute(raw) ? raw : (findExecutable(raw, { env, platform, fsImpl }) || raw);
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    const shimScript = resolveShimScript(resolved, { fsImpl });
    const node = findExecutable(nodeBin, { env, platform, fsImpl }) || (isFile(nodeBin, fsImpl) ? nodeBin : null);
    if (shimScript && node) {
      return { command: node, args: [shimScript, ...args], resolved, via: 'node-shim' };
    }
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const line = [resolved, ...args].map(quoteForCmd).join(' ');
    return {
      command: comspec,
      args: ['/d', '/v:off', '/s', '/c', line],
      windowsVerbatimArguments: true,
      resolved,
      via: 'cmd-shim'
    };
  }
  return { command: resolved, args: [...args], resolved, via: resolved === raw ? 'direct' : 'path' };
}

/** 子进程的可读展示（日志用）。 */
export function describeCommand(spec) {
  const parts = [spec.command, ...(spec.args ?? [])].map((part) => {
    const s = String(part);
    return /\s/.test(s) ? JSON.stringify(s) : s;
  });
  return parts.join(' ');
}
