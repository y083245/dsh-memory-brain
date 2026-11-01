// APIHUB_PATCH：控制台「API 管理」页直接写 DSH 的凭据文件（`$DSH_HOME/.credentials.yaml`）。
//
// 为什么单独一个模块：DSH 自己（`dsh-credentials-local`）也会写这个文件，两边必须用同一套
// 写锁协议和「只改自己那一项、其它字节不动」的规矩，否则谁后写谁就会把对方刚加的键抹掉。
// 这里照 DSH 的 `@deepseek-ai/dsh-atomic-write` 实现：`<文件>.lock` 用 `wx` 创建、内容 `<pid>\n`、
// 权限 600；持有者进程已退出（ESRCH）时用 `<lock>.takeover-<内容哈希>` 声明接管。DSH 能认得我们
// 留下的锁，我们也能接管 DSH 崩溃后留下的死锁。
//
// 写文件的顺序（规格 docs/design/API_CONSOLE_SPEC.md §8）：
//   抢锁 → 读原文 → 查权限与结构 → 备份到 `<文件>.bak-apihub` → 按文本最小修改只换 `refs` 里
//   `DEEPSEEK_API_KEY` 那一行 → 用 js-yaml 解析新文本核对（records 深相等、其它 refs 没动）→
//   同目录临时文件（wx、600）+ rename → 回读再核一遍；这一步不过就用备份还原。
//
// 安全边界：
// - 密钥只在这里短暂出现；返回值只有 `keyHint`（前 4 / 后 4 位），错误信息与日志里都没有原文。
// - 不读 `records` 的值（只做深相等比较），也不写它。
// - 文件有组 / 其他权限位、结构不认识、解析失败一律拒绝写，交给 DSH 自己的「模型」页处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import YAML from 'js-yaml';

/** 我们要维护的 ref 名称（DSH 的 `deepseek-official` 提供方读它）。 */
const REF_NAME = 'DEEPSEEK_API_KEY';
/** 写前备份的文件后缀（只留最近一份）。 */
const BACKUP_SUFFIX = '.bak-apihub';
/** owner 之外的权限位；凭据文件必须一个都没有。 */
const GROUP_OTHER_BITS = 0o077;
const MAX_KEY_LENGTH = 256;
/** 与 DSH `DOCUMENT_LOCK_WAIT_MS` 同量级：DSH 写记录时可能持锁做一次网络往返。 */
const DEFAULT_LOCK_WAIT_MS = 30000;
const DEFAULT_POLL_MS = 100;

/** DSH home：`DSH_HOME` 优先，缺省 `~/.dsh`（与 web-search.js 的 resolveDshHome 一致）。 */
export function dshCredentialsPath(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim();
  const base = home || path.join(os.homedir(), '.dsh');
  return path.join(base, '.credentials.yaml');
}

/** 密钥提示：与 persona / tts 的 apiKeyHint 同一格式，只露前 4 / 后 4 位。 */
export function keyHint(key) {
  const value = typeof key === 'string' ? key : '';
  if (!value) return '';
  if (value.length >= 12) return `${value.slice(0, 4)}…${value.slice(-4)}（${value.length} 位）`;
  return `（${value.length} 位）`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 空文档（文件不存在、或只有注释 / 空白）。 */
function emptyDocument() {
  return { version: 1, refs: {}, records: {} };
}

/**
 * 解析并校验一份凭据文档。只认 DSH 的 version 1 布局：
 * 顶层 `{ version, refs?, records? }`，`refs` 是「非空字符串 → 非空字符串」的映射，`records` 是对象。
 * 空文档（DSH 把它当空仓库）也算认识。任何拿不准的都返回 `{ ok:false }`，调用方据此拒写。
 */
function parseDocumentText(text) {
  let raw;
  try {
    raw = YAML.load(text);
  } catch {
    return { ok: false };
  }
  if (raw === undefined || raw === null) return { ok: true, doc: emptyDocument() };
  if (!isPlainObject(raw)) return { ok: false };
  if (Object.keys(raw).length === 0) return { ok: true, doc: emptyDocument() };
  if (raw.version !== 1) return { ok: false };
  const refs = raw.refs === undefined || raw.refs === null ? {} : raw.refs;
  if (!isPlainObject(refs)) return { ok: false };
  for (const value of Object.values(refs)) {
    if (typeof value !== 'string' || value.length === 0) return { ok: false };
  }
  const records = raw.records === undefined || raw.records === null ? {} : raw.records;
  if (!isPlainObject(records)) return { ok: false };
  return { ok: true, doc: { version: 1, refs: { ...refs }, records } };
}

/** 结构相等（忽略键序）：`records` 只做比较，不读它的值。 */
function sameJsonValue(left, right) {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && sameJsonValue(left[key], right[key]));
}

/**
 * 核对新文本确实只改了 `refs.DEEPSEEK_API_KEY`：version 不变、records 深相等、其它 refs 一个不变。
 * 这是「按文本最小修改」之后唯一能证明没改坏别的行的办法。
 */
function verifyChange(before, after, key) {
  if (after.version !== before.version) return false;
  if (!sameJsonValue(after.records, before.records)) return false;
  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  for (const name of names) {
    if (name === REF_NAME) {
      if (after.refs[name] !== key) return false;
    } else if (before.refs[name] !== after.refs[name]) {
      return false;
    }
  }
  return after.refs[REF_NAME] === key;
}

/**
 * 只解析 `KEY:` 之后那一小段的值，判断它是不是「单行的普通标量 / 单双引号字符串」。
 * 块标量（| >）、锚点 / 别名（& *）、空值（值在下一行）都会被拒——这些都是「拿不准」的情况，
 * 宁可让用户去 DSH 自己的页面填，也不能猜着改。
 * @returns {{ ok:true, comment:string } | { ok:false }}
 */
function parseSingleLineValue(rest) {
  const value = String(rest).replace(/^[ \t]+/, '');
  if (value === '') return { ok: false };
  const first = value[0];
  if (first === '|' || first === '>' || first === '&' || first === '*' || first === '!') return { ok: false };
  if (first === '"') {
    let i = 1;
    for (; i < value.length; i += 1) {
      if (value[i] === '\\') { i += 1; continue; }
      if (value[i] === '"') break;
    }
    if (i >= value.length) return { ok: false };
    const tail = value.slice(i + 1).trim();
    if (tail && !tail.startsWith('#')) return { ok: false };
    return { ok: true, comment: tail };
  }
  if (first === "'") {
    let i = 1;
    for (; i < value.length; i += 1) {
      if (value[i] !== "'") continue;
      if (value[i + 1] === "'") { i += 1; continue; }
      break;
    }
    if (i >= value.length) return { ok: false };
    const tail = value.slice(i + 1).trim();
    if (tail && !tail.startsWith('#')) return { ok: false };
    return { ok: true, comment: tail };
  }
  // 普通标量：`空格 + #` 开始的是行尾注释，其余整段都是值。
  const at = value.search(/[ \t]#/);
  return { ok: true, comment: at === -1 ? '' : value.slice(at).trim() };
}

/**
 * 按文本最小修改，渲染出只换了一行的新文档。
 *
 * 规则（规格 §8 第 4 步）：
 * - 文档不存在 / 只有空白：新建 `version: 1` + `refs`（两格缩进）。
 * - 有顶层 `refs:` 段、里面有 `DEEPSEEK_API_KEY`：整行重写（保留行尾注释）。
 * - 有顶层 `refs:` 段、没有这个键：插在 `refs:` 行的下一行，缩进跟段里已有条目一致。
 * - 没有 `refs:` 段：在文末追加。此时 version 一定在（结构校验过了），追加后仍然是合法文档。
 * - 流式写法（`refs: {...}`）、重复的 `refs:`、更深的同名键、多行值：返回 `{ ok:false }`，不写。
 *
 * @param {string|undefined} text 原文（不存在时 undefined）
 * @param {string} key 新密钥（已校验过）
 * @returns {{ ok:true, text:string } | { ok:false }}
 */
function renderKeyText(text, key) {
  const literal = JSON.stringify(key); // JSON 双引号串同时是合法的 YAML 双引号串
  if (text === undefined || text.trim() === '') {
    return { ok: true, text: `version: 1\nrefs:\n  ${REF_NAME}: ${literal}\n` };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  let refsIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^refs:/.test(lines[i])) continue;
    if (refsIndex !== -1) return { ok: false }; // 顶层重复的 refs（正常解析会先报错，这里兜底）
    refsIndex = i;
  }

  if (refsIndex === -1) {
    const base = text.endsWith('\n') ? text : `${text}${eol}`;
    return { ok: true, text: `${base}refs:${eol}  ${REF_NAME}: ${literal}${eol}` };
  }

  if (!/^refs:[ \t]*(#.*)?$/.test(lines[refsIndex])) return { ok: false }; // refs: {…} 之类的流式写法

  // `refs:` 段的结束：第一个顶格的、非空非注释的行。
  let end = lines.length;
  for (let i = refsIndex + 1; i < lines.length; i += 1) {
    if (/^\s*$/.test(lines[i]) || /^[ \t]*#/.test(lines[i])) continue;
    if (/^[ \t]/.test(lines[i])) continue;
    end = i;
    break;
  }

  // 段里第一条条目的缩进；段是空的就两格。
  let indent = '  ';
  for (let i = refsIndex + 1; i < end; i += 1) {
    if (/^\s*(#.*)?$/.test(lines[i])) continue;
    indent = /^[ \t]+/.exec(lines[i])?.[0] ?? '  ';
    break;
  }

  let keyIndex = -1;
  for (let i = refsIndex + 1; i < end; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const lineIndent = /^[ \t]+/.exec(line)?.[0] ?? '';
    if (!line.trimStart().startsWith(`${REF_NAME}:`)) continue;
    // 缩进比段里其它条目更深 = 嵌在别的条目下面，不是 refs 的直接一层：拿不准，不写。
    if (lineIndent !== indent) return { ok: false };
    if (keyIndex !== -1) return { ok: false }; // 同名键出现两次
    keyIndex = i;
  }

  if (keyIndex !== -1) {
    const line = lines[keyIndex];
    const parsed = parseSingleLineValue(line.slice(line.indexOf(':') + 1));
    if (!parsed.ok) return { ok: false };
    const comment = parsed.comment ? ` ${parsed.comment}` : '';
    lines[keyIndex] = `${indent}${REF_NAME}: ${literal}${comment}`;
    return { ok: true, text: lines.join(eol) };
  }

  lines.splice(refsIndex + 1, 0, `${indent}${REF_NAME}: ${literal}`);
  return { ok: true, text: lines.join(eol) };
}

/** 读锁文件内容；读不到（已被释放 / 正在删）返回 undefined。 */
function readLockRecord(lockPath) {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * 锁文件记录的进程是否确定已经退出。与 DSH `holderExited` 同一条判定：内容必须正好是
 * `<pid>\n`，pid 在 int32 范围内且不是自己；`kill(pid, 0)` 抛 ESRCH 才算退出
 * （EPERM 是别的用户的进程，还活着）。
 */
function holderExited(record) {
  if (!/^\d+\n$/.test(record)) return false;
  const pid = Number(record.trim());
  if (pid === 0 || pid > 0x7fffffff) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

/**
 * 接管一个持有者已经退出的锁。先按内容哈希建 `<lock>.takeover-<哈希前 16 位>` 声明，
 * 在声明下重新确认锁没变、pid 仍然不在，才删掉旧锁；这样多个竞争者不会互相删掉对方刚拿到的锁。
 * @returns 是否由本次调用删除了死锁（true 时调用方立刻重试抢锁）
 */
function takeOverExitedLock(lockPath) {
  const record = readLockRecord(lockPath);
  if (record === undefined || !holderExited(record)) return false;
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`;
  try {
    fs.writeFileSync(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') return false;
    throw error;
  }
  try {
    if (readLockRecord(lockPath) !== record || !holderExited(record)) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(claim, { force: true }); } catch { /* 声明留着也挡不住后续接管 */ }
  }
}

/** 抢锁：`wx` 创建、写自己的 pid；被占就每 pollMs 重试，直到 lockWaitMs。 */
async function acquireLock(lockPath, { lockWaitMs, pollMs }) {
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      const code = error?.code;
      if (code === 'EEXIST' || code === 'EPERM') {
        if (takeOverExitedLock(lockPath)) continue;
      } else {
        throw error;
      }
    }
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/** 释放锁：只删内容还是自己 pid 的那份（避免删掉刚被别人接管的锁）。 */
function releaseLock(lockPath) {
  try {
    if (fs.readFileSync(lockPath, 'utf8') === `${process.pid}\n`) fs.rmSync(lockPath, { force: true });
  } catch { /* 锁已经不在了 */ }
}

/** 同目录临时文件（`wx`、600）+ rename 覆盖，读的人只会看到完整的旧内容或新内容。 */
function writeTextAtomic(file, text) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeSync(fd, text, null, 'utf8');
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 已经关了 */ }
    }
    try { fs.rmSync(temp, { force: true }); } catch { /* 临时文件可能没建出来 */ }
    throw error;
  }
}

/**
 * 写后校验失败时的还原：有备份就用备份原文盖回去；原来没有文件就把新文件删掉。
 * 还原本身失败也只能算了——返回的错误码已经说明文件状态需要人看一眼。
 */
function restoreBackup(file, backupPath, originalText) {
  try {
    if (backupPath === null) fs.rmSync(file, { force: true });
    else writeTextAtomic(file, originalText);
  } catch { /* 还原失败：交给用户检查 .bak-apihub */ }
}

function isValidKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH
    && /^[\x21-\x7e]+$/.test(value);
}

/**
 * 读 DSH 密钥的状态（同步、不抛）。
 * 文件不存在 → 可写、没有密钥（写的时候新建）。文件有组 / 其他权限位时**不读内容**
 * （与 DSH 的 `assertOwnerOnly` 同一条规矩：全世界可读的凭据文件不该再被服务）。
 * Windows 上 `stat.mode` 恒为 0666（chmod 只切只读位、不反映 ACL），所以不做这条
 * POSIX 权限判断；文件保护由目录 ACL / DSH 自身负责，否则控制台在 Windows 上永远写不了密钥。
 *
 * @param {{ file?: string }} [options]
 * @returns {{ hasKey: boolean, keyHint: string, writable: boolean, reason: string|null }}
 */
export function readDshKeyStatus({ file = dshCredentialsPath() } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { hasKey: false, keyHint: '', writable: true, reason: null };
    return { hasKey: false, keyHint: '', writable: false, reason: '读不了凭据文件' };
  }
  if (process.platform !== 'win32' && (stat.mode & GROUP_OTHER_BITS) !== 0) {
    return { hasKey: false, keyHint: '', writable: false, reason: '凭据文件权限不是 600' };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { hasKey: false, keyHint: '', writable: false, reason: '读不了凭据文件' };
  }
  const parsed = parseDocumentText(text);
  if (!parsed.ok) return { hasKey: false, keyHint: '', writable: false, reason: '凭据文件格式不认识' };
  const value = parsed.doc.refs[REF_NAME];
  if (typeof value === 'string' && value.length > 0) {
    return { hasKey: true, keyHint: keyHint(value), writable: true, reason: null };
  }
  return { hasKey: false, keyHint: '', writable: true, reason: null };
}

/**
 * 把 DSH 的 `refs.DEEPSEEK_API_KEY` 换成新密钥（不抛；失败返回带 `code` 的对象）。
 *
 * 只改那一行，其它字节不动；写前备份、写前写后都拿 js-yaml 核对，写后核对不过就用备份还原。
 * 锁协议见文件头注释，与 DSH 的 `withFileLock` 兼容（我们能接管 DSH 的死锁，DSH 也能接管我们的）。
 *
 * @param {string} apiKey 新密钥（可见 ASCII，1～256 字节）
 * @param {{ file?: string, lockWaitMs?: number, pollMs?: number, __testHooks?: { afterRename?: (file: string) => void } }} [options]
 * @returns {Promise<{ ok: true, keyHint: string } | { ok: false, error: string, code: string }>}
 */
export async function writeDshKey(apiKey, {
  file = dshCredentialsPath(),
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  __testHooks,
} = {}) {
  // trim 掉粘贴时常见的首尾空白；内部空白 / 换行 / 非 ASCII 一律拒（密钥不该有这些）。
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!isValidKey(key)) {
    return { ok: false, code: 'invalid', error: '密钥只能由可见 ASCII 字符组成，长度 1～256' };
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, code: 'io', error: '建不了凭据文件所在目录' };
  }

  const lockPath = `${file}.lock`;
  try {
    if (!await acquireLock(lockPath, { lockWaitMs, pollMs })) {
      return { ok: false, code: 'locked', error: 'DSH 正在写凭据，稍后再试' };
    }
  } catch {
    return { ok: false, code: 'io', error: '拿不到凭据写锁' };
  }

  try {
    let statMode = null;
    try {
      statMode = fs.statSync(file).mode;
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, code: 'io', error: '读不了凭据文件' };
    }
    // Windows 的 mode 位不代表 ACL（chmod 只切只读位），不能拿它拒绝写入。
    if (statMode !== null && process.platform !== 'win32' && (statMode & GROUP_OTHER_BITS) !== 0) {
      return { ok: false, code: 'perm', error: '凭据文件权限不是 600，先 chmod 600 再写' };
    }

    let text;
    if (statMode !== null) {
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return { ok: false, code: 'io', error: '读不了凭据文件' };
      }
    }

    const before = text === undefined ? { ok: true, doc: emptyDocument() } : parseDocumentText(text);
    if (!before.ok) return { ok: false, code: 'unrecognized', error: '凭据文件格式不认识' };

    // 备份原文：写坏了能还原，也给人留一份对照。
    let backupPath = null;
    if (text !== undefined) {
      backupPath = `${file}${BACKUP_SUFFIX}`;
      try {
        fs.writeFileSync(backupPath, text, { mode: 0o600 });
        fs.chmodSync(backupPath, 0o600); // 覆盖已有备份时 writeFileSync 的 mode 不生效
      } catch {
        return { ok: false, code: 'io', error: '备份凭据文件失败' };
      }
    }

    const rendered = renderKeyText(text, key);
    if (!rendered.ok) return { ok: false, code: 'unrecognized', error: '凭据文件格式不认识' };

    const after = parseDocumentText(rendered.text);
    if (!after.ok || !verifyChange(before.doc, after.doc, key)) {
      return { ok: false, code: 'verify', error: '写入前的校验没通过，没有改文件' };
    }

    try {
      writeTextAtomic(file, rendered.text);
    } catch {
      return { ok: false, code: 'io', error: '写凭据文件失败' };
    }

    // 仅测试用：模拟「rename 之后文件被写坏」，用来覆盖还原分支。公开语义不变。
    if (typeof __testHooks?.afterRename === 'function') {
      try { __testHooks.afterRename(file); } catch { /* 钩子自己出错按校验失败处理 */ }
    }

    let readBack = null;
    try {
      readBack = fs.readFileSync(file, 'utf8');
    } catch {
      readBack = null;
    }
    const check = readBack === null ? { ok: false } : parseDocumentText(readBack);
    if (!check.ok || !verifyChange(before.doc, check.doc, key)) {
      restoreBackup(file, backupPath, text);
      return { ok: false, code: 'verify', error: '写入后校验失败，已还原备份' };
    }

    return { ok: true, keyHint: keyHint(key) };
  } finally {
    releaseLock(lockPath);
  }
}
