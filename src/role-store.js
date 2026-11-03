// UPGRADE_PATCH：角色卡覆盖层（docs/design/UPGRADE_SPEC.md §3、接口约定 §1.1）。
//
// 为什么要覆盖层：roles/*.md 被 git 跟踪，用户在控制台改过之后，`git pull` 要么冲突、要么把
// 用户的卡覆盖掉。现在出厂卡（roles/）程序**永远不写**，用户的修改 / 新建一律写 state/roles/；
// 读的时候「有用户版就用用户版」，列表 = 两边并集 − hidden。
//
// 关键保证：state/roles/ 与 hidden.json 都不存在时，list / read / exists / path 的结果与改动前
// 直接读 roles/ 完全一致（线上合入后不跑迁移，靠这一条保证零变化）。
//
// 名字合法性（中文 / 字母 / 数字 / 横线、长度、保留名）由桥接的 validateRoleName 负责；
// 这里只做路径层面的兜底：不含分隔符、解析后仍在各自目录内。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HIDDEN_FILE = 'hidden.json';

export function createRoleStore({ root, stateDir, log = () => {} } = {}) {
  const factoryDir = path.join(root, 'roles');
  const userDir = path.join(stateDir, 'roles');
  const hiddenFile = path.join(userDir, HIDDEN_FILE);
  const warned = new Set();
  const warnOnce = (msg) => { if (!warned.has(msg)) { warned.add(msg); try { log(msg); } catch {} } };

  /** 名字 → 目录内的文件路径；越界或带分隔符返回 null（调用方当「不存在」或抛错）。 */
  function fileIn(dir, name) {
    const n = String(name ?? '');
    if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.includes('\0')) return null;
    const file = path.resolve(dir, n + '.md');
    if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
    return file;
  }

  function mustFile(dir, name) {
    const file = fileIn(dir, name);
    if (!file) throw new Error(`人格名不合法：${String(name ?? '').slice(0, 40)}`);
    return file;
  }

  // 与改动前 listRoles() 同一套过滤：*.md、排除 README.md。
  function namesIn(dir) {
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .map((f) => f.slice(0, -3));
    } catch {
      return [];
    }
  }

  const isFile = (file) => { try { return !!file && fs.statSync(file).isFile(); } catch { return false; } };
  const hasFactory = (name) => isFile(fileIn(factoryDir, name));
  const hasUser = (name) => isFile(fileIn(userDir, name));

  function ensureUserDir() {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(userDir, 0o700); } catch {}
  }

  function atomicWrite(file, text) {
    ensureUserDir();
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch {}
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  // hidden.json 坏了：告警一次、按「没有隐藏」处理（接口约定 §0 第 4 条）。
  function readHidden() {
    let raw;
    try { raw = fs.readFileSync(hiddenFile, 'utf8'); } catch { return new Set(); }
    try {
      const doc = JSON.parse(raw);
      const names = Array.isArray(doc?.names) ? doc.names.filter((n) => typeof n === 'string' && n) : [];
      return new Set(names);
    } catch {
      warnOnce('⚠️ state/roles/hidden.json 读不懂，按没有隐藏处理');
      return new Set();
    }
  }

  function writeHidden(set) {
    if (set.size === 0) {
      // 没有隐藏项就删文件：让「全部恢复」之后的状态和从没用过覆盖层一样干净。
      try { fs.rmSync(hiddenFile, { force: true }); } catch {}
      return;
    }
    const names = [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    atomicWrite(hiddenFile, JSON.stringify({ version: 1, names }, null, 2) + '\n');
  }

  function list() {
    const hidden = readHidden();
    const user = new Set(namesIn(userDir));
    const all = new Set(user);
    // hidden 只隐藏**没有用户版**的出厂卡
    for (const name of namesIn(factoryDir)) {
      if (user.has(name) || !hidden.has(name)) all.add(name);
    }
    return [...all].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function exists(name) {
    return list().includes(String(name ?? ''));
  }

  function origin(name) {
    if (!exists(name)) return null;
    const u = hasUser(name);
    const f = hasFactory(name);
    if (u && f) return 'modified';
    if (u) return 'user';
    return f ? 'factory' : null;
  }

  /** 实际读的那个文件的绝对路径；不存在（含被隐藏）返回 null。 */
  function filePath(name) {
    if (!exists(name)) return null;
    if (hasUser(name)) return fileIn(userDir, name);
    return fileIn(factoryDir, name);
  }

  function read(name) {
    const file = filePath(name);
    if (!file) throw new Error(`人格「${name}」不存在`);
    return fs.readFileSync(file, 'utf8');
  }

  function write(name, content) {
    const file = mustFile(userDir, name);
    mustFile(factoryDir, name);
    atomicWrite(file, String(content ?? ''));
    const hidden = readHidden();
    if (hidden.delete(String(name))) writeHidden(hidden);
  }

  function create(name, content) {
    if (exists(name)) throw new Error(`人格「${name}」已存在`);
    write(name, content);
  }

  function rename(from, to) {
    if (!exists(from)) throw new Error(`人格「${from}」不存在`);
    if (exists(to)) throw new Error(`人格「${to}」已存在`);
    mustFile(userDir, to);
    write(to, read(from));
    if (hasUser(from)) fs.rmSync(fileIn(userDir, from), { force: true });
    if (hasFactory(from)) {
      const hidden = readHidden();
      hidden.add(String(from));
      writeHidden(hidden);
    }
  }

  // 控制台「删除」= 这张卡从列表里消失；出厂文件本身不动，只是记进 hidden。
  function remove(name) {
    if (!exists(name)) throw new Error(`人格「${name}」不存在`);
    if (hasUser(name)) fs.rmSync(fileIn(userDir, name), { force: true });
    if (hasFactory(name)) {
      const hidden = readHidden();
      hidden.add(String(name));
      writeHidden(hidden);
    }
  }

  function reset(name) {
    if (origin(name) !== 'modified') throw new Error(`人格「${name}」没有可恢复的出厂版本（不是「已修改」）`);
    fs.rmSync(fileIn(userDir, name), { force: true });
  }

  return { list, origin, exists, read, path: filePath, write, create, rename, remove, reset, factoryDir, userDir };
}
