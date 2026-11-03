// UPGRADE_PATCH：角色卡覆盖层（src/role-store.js，接口约定 §1.1）的单测。
// 全部在临时目录里跑；对开发副本的 roles/ 只读（逐项与旧函数比对 + 前后 sha256 断言）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoleStore } from '../src/role-store.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-role-store-'));
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function dirHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      h.update(path.relative(dir, p) + '\0');
      if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return h.digest('hex');
}

/** 一个临时仓库根：roles/ 放出厂卡，state/ 先不建。 */
function fixture(label, factory = { 甲: '# 甲\n出厂甲\n', 乙: '# 乙\n出厂乙\n', README: '说明\n' }) {
  const root = fs.mkdtempSync(path.join(BASE, `${label}-`));
  fs.mkdirSync(path.join(root, 'roles'));
  for (const [name, text] of Object.entries(factory)) fs.writeFileSync(path.join(root, 'roles', `${name}.md`), text);
  const stateDir = path.join(root, 'state');
  return { root, stateDir, store: createRoleStore({ root, stateDir }), factoryHash: () => dirHash(path.join(root, 'roles')) };
}

// ── 改动前 bridge.js 的旧函数（原样抄来，用于逐项比对） ──
function oldListRoles(root) {
  try {
    return fs.readdirSync(path.join(root, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}
const oldRoleFilePath = (root, name) => path.join(path.join(root, 'roles'), name + '.md');

function assertSameAsOld(root, store, probeNames) {
  assert.deepEqual(store.list(), oldListRoles(root));
  for (const name of [...oldListRoles(root), ...probeNames]) {
    const oldExists = fs.existsSync(oldRoleFilePath(root, name));
    assert.equal(store.exists(name), oldExists, `exists(${name})`);
    if (oldExists) {
      assert.equal(store.read(name), fs.readFileSync(oldRoleFilePath(root, name), 'utf8'), `read(${name})`);
      assert.equal(store.path(name), oldRoleFilePath(root, name), `path(${name})`);
      assert.equal(store.origin(name), 'factory');
    } else {
      assert.throws(() => store.read(name));
      assert.equal(store.path(name), null);
      assert.equal(store.origin(name), null);
    }
  }
}

await test('没有覆盖层：list / exists / read / path 与旧函数逐项一致（临时夹具，含 README、非 md、子目录）', () => {
  const f = fixture('same', { 小鲸鱼: '鲸\n', 傲娇助手: '傲\n', abc: 'a\n', README: 'r\n' });
  fs.writeFileSync(path.join(f.root, 'roles', 'notes.txt'), 'x');
  fs.mkdirSync(path.join(f.root, 'roles', 'sub'));
  // README 不在探测名里：桥接的 validateRoleName 把它当保留名先拒掉，到不了 exists；
  // 接口约定里 exists = list 里有，而 list 排除 README（下面「README 排除」单独测）。
  assertSameAsOld(f.root, f.store, ['不存在', 'sub', 'notes']);
  assert.equal(fs.existsSync(f.stateDir), false, '只读操作不得创建 state/');
});

await test('没有覆盖层：对开发副本真实的 roles/ 逐项一致，且 roles/ 前后 sha256 不变', () => {
  const before = dirHash(path.join(REPO, 'roles'));
  const emptyState = fs.mkdtempSync(path.join(BASE, 'repo-state-'));
  const store = createRoleStore({ root: REPO, stateDir: path.join(emptyState, 'state') });
  assertSameAsOld(REPO, store, ['不存在的人格']);
  assert.equal(dirHash(path.join(REPO, 'roles')), before);
});

await test('roles/ 目录不存在：list 为空（与旧函数一致）', () => {
  const root = fs.mkdtempSync(path.join(BASE, 'noroles-'));
  const store = createRoleStore({ root, stateDir: path.join(root, 'state') });
  assert.deepEqual(store.list(), oldListRoles(root));
  assert.deepEqual(store.list(), []);
});

await test('origin 三种组合 + read / path 走用户版优先', () => {
  const f = fixture('origin');
  const h = f.factoryHash();
  f.store.write('甲', '用户甲\n');
  f.store.write('丙', '用户丙\n');
  assert.equal(f.store.origin('甲'), 'modified');
  assert.equal(f.store.origin('乙'), 'factory');
  assert.equal(f.store.origin('丙'), 'user');
  assert.equal(f.store.origin('丁'), null);
  assert.equal(f.store.read('甲'), '用户甲\n');
  assert.equal(f.store.read('乙'), '# 乙\n出厂乙\n');
  assert.equal(f.store.path('甲'), path.join(f.stateDir, 'roles', '甲.md'));
  assert.equal(f.store.path('乙'), path.join(f.root, 'roles', '乙.md'));
  assert.deepEqual(f.store.list(), ['丙', '甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
  assert.equal(f.factoryHash(), h, '出厂目录不得被写');
});

await test('权限：state/roles/ 700、卡片 600、hidden.json 600', () => {
  const f = fixture('perm');
  f.store.write('甲', 'x\n');
  f.store.remove('乙');
  assert.equal(fs.statSync(path.join(f.stateDir, 'roles')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.stateDir, 'roles', '甲.md')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.stateDir, 'roles', 'hidden.json')).mode & 0o777, 0o600);
  // 原子写不留临时文件
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'roles')).filter((n) => n.endsWith('.tmp')), []);
});

await test('create：已存在（出厂或用户）抛错；新名写成用户版', () => {
  const f = fixture('create');
  assert.throws(() => f.store.create('甲', 'x'), /已存在/);
  f.store.create('新', '新卡\n');
  assert.equal(f.store.origin('新'), 'user');
  assert.throws(() => f.store.create('新', 'y'), /已存在/);
});

await test('remove：出厂卡 → 进 hidden、从列表消失、出厂文件仍在；用户卡 → 删文件；不存在抛错', () => {
  const f = fixture('remove');
  const h = f.factoryHash();
  f.store.remove('乙');
  assert.equal(f.store.exists('乙'), false);
  assert.equal(f.store.origin('乙'), null);
  assert.equal(f.store.path('乙'), null);
  assert.ok(fs.existsSync(path.join(f.root, 'roles', '乙.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'roles', 'hidden.json'), 'utf8')), { version: 1, names: ['乙'] });
  f.store.write('丙', 'c\n');
  f.store.remove('丙');
  assert.equal(f.store.exists('丙'), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'roles', '丙.md')), false);
  // 改过的出厂卡：删用户版 + 隐藏出厂版 → 整张卡消失
  f.store.write('甲', 'u\n');
  f.store.remove('甲');
  assert.equal(f.store.exists('甲'), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'roles', '甲.md')), false);
  assert.throws(() => f.store.remove('甲'), /不存在/);
  assert.equal(f.factoryHash(), h);
});

await test('hidden 只隐藏没有用户版的出厂卡；write 把名字移出 hidden', () => {
  const f = fixture('hidden');
  fs.mkdirSync(path.join(f.stateDir, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, 'roles', 'hidden.json'), JSON.stringify({ version: 1, names: ['甲', '乙'] }));
  fs.writeFileSync(path.join(f.stateDir, 'roles', '甲.md'), '用户甲\n');
  assert.deepEqual(f.store.list(), ['甲'], '甲有用户版 → 仍在；乙只有出厂 → 隐藏');
  assert.equal(f.store.origin('甲'), 'modified');
  f.store.write('乙', '回来了\n');
  assert.equal(f.store.exists('乙'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'roles', 'hidden.json'), 'utf8')).names, ['甲']);
});

await test('hidden.json 坏了：告警一次、按没有隐藏处理', () => {
  const root = fs.mkdtempSync(path.join(BASE, 'badhidden-'));
  fs.mkdirSync(path.join(root, 'roles'));
  fs.writeFileSync(path.join(root, 'roles', '甲.md'), 'a');
  fs.mkdirSync(path.join(root, 'state', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'roles', 'hidden.json'), '{坏');
  const logs = [];
  const store = createRoleStore({ root, stateDir: path.join(root, 'state'), log: (m) => logs.push(m) });
  assert.deepEqual(store.list(), ['甲']);
  store.list();
  assert.equal(logs.length, 1);
});

await test('rename：出厂卡 → 新名是用户版、旧名进 hidden；用户卡 → 文件改名；目标已存在抛错', () => {
  const f = fixture('rename');
  const h = f.factoryHash();
  f.store.rename('甲', '戊');
  assert.equal(f.store.origin('戊'), 'user');
  assert.equal(f.store.read('戊'), '# 甲\n出厂甲\n', '内容逐字搬过去');
  assert.equal(f.store.exists('甲'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'roles', 'hidden.json'), 'utf8')).names, ['甲']);
  f.store.rename('戊', '己');
  assert.equal(f.store.exists('戊'), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'roles', '戊.md')), false);
  assert.equal(f.store.read('己'), '# 甲\n出厂甲\n');
  assert.throws(() => f.store.rename('己', '乙'), /已存在/);
  assert.throws(() => f.store.rename('没有', '新'), /不存在/);
  // 改过的出厂卡改名：带走的是用户版内容，旧名的用户版删掉、出厂版隐藏
  f.store.write('乙', '改过的乙\n');
  f.store.rename('乙', '庚');
  assert.equal(f.store.read('庚'), '改过的乙\n');
  assert.equal(f.store.exists('乙'), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'roles', '乙.md')), false);
  assert.equal(f.factoryHash(), h);
});

await test('reset：只对「已修改」有效，删用户版回到出厂；factory / user / 不存在 抛错', () => {
  const f = fixture('reset');
  f.store.write('甲', '改\n');
  f.store.reset('甲');
  assert.equal(f.store.origin('甲'), 'factory');
  assert.equal(f.store.read('甲'), '# 甲\n出厂甲\n');
  assert.throws(() => f.store.reset('甲'));
  f.store.write('丙', 'c');
  assert.throws(() => f.store.reset('丙'));
  assert.throws(() => f.store.reset('没有'));
  assert.equal(f.store.read('丙'), 'c');
});

await test('README 排除：两边的 README.md 都不出现在列表里', () => {
  const f = fixture('readme');
  fs.mkdirSync(path.join(f.stateDir, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, 'roles', 'README.md'), 'x');
  assert.equal(f.store.list().includes('README'), false);
  assert.equal(f.store.exists('README'), false);
});

await test('越界名字被拒：写类方法抛错、读类方法当不存在；目录外文件不被创建', () => {
  const f = fixture('escape');
  fs.writeFileSync(path.join(f.root, 'outside.md'), 'secret');
  for (const bad of ['../outside', '..', '.', 'a/b', 'a\\b', '', '../../etc/passwd', 'x\0y']) {
    assert.equal(f.store.exists(bad), false, bad);
    assert.equal(f.store.path(bad), null, bad);
    assert.throws(() => f.store.read(bad), undefined, bad);
    assert.throws(() => f.store.write(bad, 'x'), undefined, bad);
    assert.throws(() => f.store.create(bad, 'x'), undefined, bad);
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'outside.md'), 'utf8'), 'secret');
  assert.equal(fs.existsSync(path.join(f.root, 'state', 'outside.md')), false);
});

fs.rmSync(BASE, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
console.log('\n全部通过');
