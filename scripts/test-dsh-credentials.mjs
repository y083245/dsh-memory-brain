// src/dsh-credentials.js 的单测（APIHUB_PATCH；规格 docs/design/API_CONSOLE_SPEC.md §8、约定 §3.1）。
//
// 全部在系统临时目录下的临时 DSH_HOME 里跑：不读真的 ~/.dsh、不联网、不碰任何 state/。
// 重点钉住：只改 refs 里 DEEPSEEK_API_KEY 那一行（其它字节逐行相同）、records 深相等、
// 备份 / 还原、与 DSH 同一套 wx 锁协议（等锁超时 + 接管死锁）、格式不认与非法密钥时一个字节都不写、
// 任何返回值里都没有密钥原文。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dshCredentialsPath,
  keyHint,
  readDshKeyStatus,
  writeDshKey,
} from '../src/dsh-credentials.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 每次运行一个新的系统临时目录（os.tmpdir()），不和别的测试 / worker 共用。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-dsh-credentials-'));
const TMP_DIRS = [];
function tempHome(name) {
  const dir = fs.mkdtempSync(path.join(ROOT, `dshc-${name}-`));
  TMP_DIRS.push(dir);
  return dir;
}

// 夹具：结构照 DSH 的 .credentials.yaml（version / records / refs），值全是假的。
const FIXTURE = `# 夹具：结构照 DSH 的 .credentials.yaml，值是假的
version: 1

refs:
  # 她聊天用的那把
  DEEPSEEK_API_KEY: "sk-fake-old-0000000000"
  OTHER_REF: 'another-fake-value'

records:
  deepseek-official/api-key:
    kind: api-key
    key: "fake-record-key-value"
  anthropic/grant:
    kind: grant
    payload:
      access_token: "fake-grant-token"
      expires_at: 1767225600000
`;

function writeFixture(dir, text = FIXTURE, mode = 0o600) {
  const file = path.join(dir, '.credentials.yaml');
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const modeOf = (file) => fs.statSync(file).mode & 0o777;

// 所有用例的返回值都收进来，最后统一确认里面没有密钥原文。
const ALL_RESULTS = [];

// ── 1. dshCredentialsPath / keyHint ─────────────────────────────────────
await test('dshCredentialsPath 认 DSH_HOME，缺省 ~/.dsh', () => {
  assert.equal(dshCredentialsPath({ DSH_HOME: '/tmp/worker-D/x' }), '/tmp/worker-D/x/.credentials.yaml');
  assert.equal(dshCredentialsPath({ DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh', '.credentials.yaml'));
  assert.equal(dshCredentialsPath({}), path.join(os.homedir(), '.dsh', '.credentials.yaml'));
  assert.equal(dshCredentialsPath(), path.join(os.homedir(), '.dsh', '.credentials.yaml'));
});

await test('keyHint：≥12 位露前 4 后 4，短的不露，空串空', () => {
  assert.equal(keyHint('sk-1234567890abcdef'), 'sk-1…cdef（19 位）');
  assert.equal(keyHint('123456789012'), '1234…9012（12 位）');
  assert.equal(keyHint('12345678901'), '（11 位）');
  assert.equal(keyHint(''), '');
  assert.equal(keyHint(undefined), '');
  assert.equal(keyHint('sk-1234567890abcdef').includes('567890'), false);
});

// ── 2. readDshKeyStatus ────────────────────────────────────────────────
await test('读状态：文件不存在 → 可写、无密钥', () => {
  const dir = tempHome('missing');
  const status = readDshKeyStatus({ file: path.join(dir, '.credentials.yaml') });
  assert.deepEqual(status, { hasKey: false, keyHint: '', writable: true, reason: null });
});

await test('读状态：有 key → hasKey + 只露前 4 后 4', () => {
  const file = writeFixture(tempHome('has'));
  const status = readDshKeyStatus({ file });
  assert.equal(status.hasKey, true);
  assert.equal(status.writable, true);
  assert.equal(status.reason, null);
  assert.equal(status.keyHint, 'sk-f…0000（22 位）');
  assert.equal(status.keyHint.includes('sk-fake-old'), false);
});

await test('读状态：没有这个 ref → 可写、无密钥', () => {
  const file = writeFixture(tempHome('nokey'), 'version: 1\nrefs:\n  OTHER_REF: "x"\n');
  const status = readDshKeyStatus({ file });
  assert.deepEqual(status, { hasKey: false, keyHint: '', writable: true, reason: null });
});

await test('读状态：权限 644 → 不可写并说明原因', () => {
  const file = writeFixture(tempHome('perm'), FIXTURE, 0o644);
  const status = readDshKeyStatus({ file });
  assert.equal(status.writable, false);
  assert.equal(status.reason, '凭据文件权限不是 600');
  assert.equal(status.hasKey, false);
});

await test('读状态：乱码 → 不可写、格式不认识', () => {
  const file = writeFixture(tempHome('garbage'), 'version: [1\n  : : :\n');
  const status = readDshKeyStatus({ file });
  assert.equal(status.writable, false);
  assert.equal(status.reason, '凭据文件格式不认识');
});

await test('读状态：refs 是列表 → 不可写、格式不认识', () => {
  const file = writeFixture(tempHome('list'), 'version: 1\nrefs:\n  - DEEPSEEK_API_KEY\n');
  const status = readDshKeyStatus({ file });
  assert.equal(status.writable, false);
  assert.equal(status.reason, '凭据文件格式不认识');
});

// ── 3. 写：替换已有的键，其它行逐行相同 ────────────────────────────────
const NEW_KEY = 'sk-fake-new-1111222233334444';

await test('写：替换已有键后，整份文件除那一行外逐行相同', async () => {
  const file = writeFixture(tempHome('replace'));
  const before = fs.readFileSync(file, 'utf8');
  const result = await writeDshKey(NEW_KEY, { file });
  ALL_RESULTS.push(result);
  assert.deepEqual(result, { ok: true, keyHint: 'sk-f…4444（28 位）' });

  const after = fs.readFileSync(file, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length, '行数不变');
  let changed = 0;
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (beforeLines[i] === afterLines[i]) continue;
    changed += 1;
    assert.match(afterLines[i], /^\s+DEEPSEEK_API_KEY: "sk-fake-new-1111222233334444"$/);
  }
  assert.equal(changed, 1, '只有一行变了');
  assert.equal(after.includes('sk-fake-old-0000000000'), false);
  assert.equal(after.includes('another-fake-value'), true);
  assert.equal(after.includes('# 她聊天用的那把'), true, '注释原样保留');
});

await test('写：行尾注释保留', async () => {
  const dir = tempHome('comment');
  const file = writeFixture(dir, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "old" # 我的 key\n');
  const result = await writeDshKey(NEW_KEY, { file });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${NEW_KEY}" # 我的 key\n`);
});

// ── 4. 写：插入 / 追加 / 新建 ──────────────────────────────────────────
await test('写：refs 段里没有这个键 → 插在 refs: 下一行，缩进沿用', async () => {
  const dir = tempHome('insert');
  const text = 'version: 1\nrefs:\n    OTHER_REF: "x"\nrecords:\n  a/key:\n    kind: api-key\n';
  const file = writeFixture(dir, text);
  const result = await writeDshKey(NEW_KEY, { file });
  assert.equal(result.ok, true);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 4), ['version: 1', 'refs:', `    DEEPSEEK_API_KEY: "${NEW_KEY}"`, '    OTHER_REF: "x"']);
  assert.deepEqual(lines.slice(4), ['records:', '  a/key:', '    kind: api-key', '']);
});

await test('写：没有 refs: 段 → 文末追加', async () => {
  const dir = tempHome('append');
  const file = writeFixture(dir, 'version: 1\nrecords:\n  a/key:\n    kind: api-key\n');
  const result = await writeDshKey(NEW_KEY, { file });
  assert.equal(result.ok, true);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    `version: 1\nrecords:\n  a/key:\n    kind: api-key\nrefs:\n  DEEPSEEK_API_KEY: "${NEW_KEY}"\n`,
  );
});

await test('写：文件不存在 → 新建、权限 600、内容合法', async () => {
  const dir = tempHome('create');
  const file = path.join(dir, '.credentials.yaml');
  const result = await writeDshKey(NEW_KEY, { file });
  ALL_RESULTS.push(result);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${NEW_KEY}"\n`);
  assert.equal(modeOf(file), 0o600);
  assert.equal(fs.existsSync(`${file}.bak-apihub`), false, '原来没有文件就不备份');
  assert.equal(fs.existsSync(`${file}.lock`), false, '写完了锁要删掉');
});

// ── 5. records 深相等 / 权限 / 备份 ────────────────────────────────────
await test('写：records 深相等、权限保持 600、备份是原文', async () => {
  const file = writeFixture(tempHome('records'));
  const before = fs.readFileSync(file, 'utf8');
  const result = await writeDshKey(NEW_KEY, { file });
  assert.equal(result.ok, true);
  assert.equal(modeOf(file), 0o600);

  const YAML = (await import('js-yaml')).default;
  const beforeDoc = YAML.load(before);
  const afterDoc = YAML.load(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(afterDoc.records, beforeDoc.records);
  assert.equal(afterDoc.version, beforeDoc.version);
  assert.deepEqual(Object.keys(afterDoc.refs).sort(), Object.keys(beforeDoc.refs).sort());
  assert.equal(afterDoc.refs.OTHER_REF, beforeDoc.refs.OTHER_REF);

  const backup = `${file}.bak-apihub`;
  assert.equal(fs.readFileSync(backup, 'utf8'), before, '备份是写之前的原文');
  assert.equal(modeOf(backup), 0o600);
});

// ── 6. 锁 ──────────────────────────────────────────────────────────────
await test('锁：被当前进程占着 → 等 300ms 后回 locked，原文件没变', async () => {
  const file = writeFixture(tempHome('lock'));
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  const before = fs.readFileSync(file, 'utf8');
  const startedAt = Date.now();
  const result = await writeDshKey(NEW_KEY, { file, lockWaitMs: 300, pollMs: 50 });
  const elapsed = Date.now() - startedAt;
  ALL_RESULTS.push(result);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'locked');
  assert.match(result.error, /稍后再试/);
  assert.ok(elapsed >= 250, `至少要等一会儿（实际 ${elapsed}ms）`);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '原文件一个字节都没变');
  assert.equal(fs.readFileSync(lock, 'utf8'), `${process.pid}\n`, '别人的锁不能删');
  fs.rmSync(lock, { force: true });
});

await test('锁：持有者进程已不存在 → 接管并写入，写完锁没了', async () => {
  const file = writeFixture(tempHome('takeover'));
  fs.writeFileSync(`${file}.lock`, '2147480000\n', { mode: 0o600 });
  const result = await writeDshKey(NEW_KEY, { file, lockWaitMs: 2000, pollMs: 20 });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8').includes(NEW_KEY), true);
  assert.equal(fs.existsSync(`${file}.lock`), false, '写完锁要删掉');
});

// ── 7. 非法密钥 ────────────────────────────────────────────────────────
await test('非法密钥（空 / 换行 / 中文 / 300 字 / 带空格）→ invalid，文件没变', async () => {
  const file = writeFixture(tempHome('invalid'));
  const before = fs.readFileSync(file, 'utf8');
  const bad = ['', '   ', 'sk-abc\ndef', 'sk-中文密钥', 'x'.repeat(300), 'sk-abc def'];
  for (const value of bad) {
    const result = await writeDshKey(value, { file });
    ALL_RESULTS.push(result);
    assert.equal(result.ok, false, `应该拒绝：${JSON.stringify(value.slice(0, 12))}`);
    assert.equal(result.code, 'invalid');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  assert.deepEqual(bad.map((value) => String(value).length > 0), [false, true, true, true, true, true]);
});

// ── 8. 流式写法 ────────────────────────────────────────────────────────
await test('流式 refs: {…} → unrecognized，文件没变', async () => {
  const dir = tempHome('flow');
  const text = 'version: 1\nrefs: {DEEPSEEK_API_KEY: "sk-old-flow"}\n';
  const file = writeFixture(dir, text);
  const result = await writeDshKey(NEW_KEY, { file });
  ALL_RESULTS.push(result);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unrecognized');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  // 备份在「结构检查通过」之后、「文本最小修改」之前写（规格 §8 的步骤顺序），内容就是原文。
  assert.equal(fs.readFileSync(`${file}.bak-apihub`, 'utf8'), text);
});

// ── 9. 写入后校验失败 → 用备份还原 ─────────────────────────────────────
await test('rename 之后文件被写坏 → 回读校验失败、还原成备份原文', async () => {
  const file = writeFixture(tempHome('restore'));
  const before = fs.readFileSync(file, 'utf8');
  const result = await writeDshKey(NEW_KEY, {
    file,
    __testHooks: {
      afterRename(target) {
        fs.writeFileSync(target, 'version: 1\nrefs: {broken\n');
      },
    },
  });
  ALL_RESULTS.push(result);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'verify');
  assert.match(result.error, /还原/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '还原成写之前的原文');
  assert.equal(modeOf(file), 0o600);
});

// ── 10. 返回值里没有密钥原文 ────────────────────────────────────────────
await test('所有返回值里都没有测试密钥原文（只有 keyHint 的前 4 / 后 4 位）', () => {
  const joined = JSON.stringify(ALL_RESULTS);
  for (const secret of [NEW_KEY, 'sk-fake-old-0000000000', 'fake-record-key-value', 'fake-grant-token']) {
    assert.equal(joined.includes(secret), false, `返回值里出现了 ${secret.slice(0, 8)}…`);
  }
});

for (const dir of TMP_DIRS) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
}

if (failures) {
  console.error(`\n${failures} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
