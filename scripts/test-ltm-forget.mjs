// 存档删除（墓碑）+ 遗忘请求 + memory-rag 管理接口（RAG P2）的测试：
//   ① src/long-memory.js：墓碑跳过、按行 / 按范围删除、请求文件
//   ② src/memory-rag-client.js：health / indexRun / rebuild / forget
//   ③ bridge.js：/api/ltm/archive/rows、/api/ltm/archive/delete、/api/ltm/rag/*
//
// 全部用临时目录 + 合成数据 + 本地假 memory-rag：不碰真实 state/，不连线上 :8093。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createLongMemory } from '../src/long-memory.js';
import { createMemoryRagClient } from '../src/memory-rag-client.js';
import { assertPosixMode } from './test-mode.mjs';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const KEY = 'private:123';
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
/** 建一个临时 stateDir 跑一段，跑完删掉。 */
async function withMemory(run, { log } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-forget-'));
  const lm = createLongMemory({ stateDir: dir, ...(log ? { log } : {}) });
  try { return await run({ lm, dir }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function seed(lm, key, rows) {
  for (const r of rows) {
    lm.archive(key, {
      dir: r.dir ?? 'in',
      name: r.name ?? '阿明',
      userId: r.userId ?? '2001',
      text: r.text,
      at: r.at
    });
  }
}

const MSGS = [
  { at: '2026-10-01T10:00:00', text: '第一条：今天讨论甲项目' },
  { at: '2026-10-01T10:01:00', text: '第二条：银河邮局第七号' },
  { at: '2026-10-01T10:02:00', text: '第三条：中午吃什么' },
  { at: '2026-10-01T10:03:00', text: '第四条：下午改代码' },
  { at: '2026-10-01T10:04:00', text: '第五条：晚上散步' }
];

function replyJson(res, status, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/** 起一个本地假 memory-rag；handler(entry, req, res) 决定响应。 */
async function startRagServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const entry = { method: req.method, path: req.url, body };
      requests.push(entry);
      Promise.resolve(handler(entry, req, res)).catch(() => { try { res.destroy(); } catch {} });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function call(port, pathname, { method = 'GET', headers = {}, body, token } = {}) {
  const h = { 'content-type': 'application/json', ...CONSOLE, ...headers };
  if (token) h['x-agent-token'] = token;
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: response.statusCode, json, body: data });
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

// ── ① 墓碑 ────────────────────────────────────────────────────────────────
await test('墓碑：按行删后字节数不变，且所有读取路径都跳过它', async () => {
  await withMemory(async ({ lm, dir }) => {
    seed(lm, KEY, MSGS);
    const file = path.join(dir, 'archive', 'private_123', '2026-10.jsonl');
    const before = fs.readFileSync(file);
    const beforeLines = before.toString('utf8').split('\n');

    const listed = lm.listArchiveRows(KEY);
    assert.equal(listed.total, 5);
    assert.deepEqual(listed.rows.map((r) => r.line), [5, 4, 3, 2, 1], 'rows 要从新到旧');
    const target = listed.rows.find((r) => r.line === 2);
    assert.equal(target.file, 'private_123/2026-10.jsonl', 'file 是相对 archive/ 的路径');
    assert.equal(lm.archiveStats(KEY).messages, 5);

    const del = lm.deleteArchiveRows(KEY, { rows: [{ file: target.file, line: 2, t: target.t }] });
    assert.deepEqual(del, { matched: 1, deleted: 1, skipped: 0 });

    const after = fs.readFileSync(file);
    assert.equal(after.length, before.length, '文件字节数必须不变');
    const afterLines = after.toString('utf8').split('\n');
    assert.equal(afterLines.length, beforeLines.length);
    // 墓碑那一行：JSON 解析出 deleted === true，后面是 ASCII 空格补到原来那一行的字节数
    assert.equal(JSON.parse(afterLines[1]).deleted, true);
    const pad = Buffer.byteLength(beforeLines[1]) - Buffer.byteLength('{"deleted":true}');
    assert.equal(afterLines[1], '{"deleted":true}' + ' '.repeat(pad));
    // 其它行逐字未变
    for (const i of [0, 2, 3, 4]) assert.equal(afterLines[i], beforeLines[i], `第 ${i + 1} 行不应被改`);

    // search：browse 与有检索词两条路径都看不到墓碑
    const browse = lm.search(KEY, {});
    assert.equal(browse.total, 4, 'total 不含墓碑');
    assert.equal(browse.matched, 4);
    assert.ok(!browse.lines.some((l) => l.includes('银河邮局')));
    const scored = lm.search(KEY, { query: '银河邮局' });
    assert.equal(scored.matched, 0);
    assert.deepEqual(scored.lines, []);

    // archiveRows / listArchiveRows / archiveStats 也都看不到
    assert.equal(lm.archiveRows(KEY).length, 4);
    assert.ok(!lm.archiveRows(KEY).some((r) => r.text.includes('银河邮局')));
    const listed2 = lm.listArchiveRows(KEY);
    assert.equal(listed2.total, 4);
    assert.equal(listed2.rows.length, 4);
    assert.ok(!listed2.rows.some((r) => r.text.includes('银河邮局')));
    assert.equal(lm.archiveStats(KEY).messages, 4);

    // 行号不变：第五条仍在第 5 行
    const dbg = lm.search(KEY, { query: '散步', debug: true });
    assert.equal(dbg.hits[0].line, 5, '其它行的行号不能被墓碑影响');

    // 删完后照常追加
    lm.archive(KEY, { dir: 'out', name: '', userId: null, text: '第六条：新追加的消息', at: '2026-10-01T10:05:00' });
    const dbg2 = lm.search(KEY, { query: '新追加的消息', debug: true });
    assert.equal(dbg2.hits[0].line, 6, '追加的新消息接在第 6 行');
    assert.equal(lm.listArchiveRows(KEY).total, 5);

    // firstAt 取「第一条非墓碑行」的时间
    const key2 = 'private:456';
    seed(lm, key2, [
      { at: '2026-10-02T09:00:00', text: '开头的一条' },
      { at: '2026-10-02T09:01:00', text: '第二条' }
    ]);
    const firstBefore = lm.archiveStats(key2).firstAt;
    const r2 = lm.listArchiveRows(key2).rows.find((r) => r.line === 1);
    lm.deleteArchiveRows(key2, { rows: [{ file: r2.file, line: 1, t: r2.t }] });
    const stats2 = lm.archiveStats(key2);
    assert.equal(stats2.messages, 1);
    assert.notEqual(stats2.firstAt, firstBefore, '第一条被删后 firstAt 应换成下一条');
    assert.equal(stats2.firstAt, lm.listArchiveRows(key2).rows[0].t);
  });
});

// ── ② 按行删的保护 ────────────────────────────────────────────────────────
await test('按行删的保护：t 不符 / 墓碑 / 非法文件 / 行号 / 超过 500 条', async () => {
  await withMemory(async ({ lm, dir }) => {
    seed(lm, KEY, MSGS.slice(0, 3));
    const file = path.join(dir, 'archive', 'private_123', '2026-10.jsonl');
    const before = fs.readFileSync(file);
    const line2 = lm.listArchiveRows(KEY).rows.find((r) => r.line === 2);

    // t 不对 → skipped，文件不动
    const wrong = lm.deleteArchiveRows(KEY, { rows: [{ file: line2.file, line: 2, t: '1999-01-01T00:00:00.000Z' }] });
    assert.deepEqual(wrong, { matched: 1, deleted: 0, skipped: 1 });
    assert.deepEqual(fs.readFileSync(file), before);

    // 正常删一次
    assert.deepEqual(
      lm.deleteArchiveRows(KEY, { rows: [{ file: line2.file, line: 2, t: line2.t }] }),
      { matched: 1, deleted: 1, skipped: 0 }
    );

    // 已经是墓碑 → skipped
    assert.deepEqual(
      lm.deleteArchiveRows(KEY, { rows: [{ file: line2.file, line: 2, t: line2.t }] }),
      { matched: 1, deleted: 0, skipped: 1 }
    );

    // 行不存在 → skipped（不抛错）
    assert.deepEqual(
      lm.deleteArchiveRows(KEY, { rows: [{ file: line2.file, line: 99, t: line2.t }] }),
      { matched: 1, deleted: 0, skipped: 1 }
    );

    // 文件必须逐字等于本会话现有的文件：.. / 绝对路径 / 别的会话都不接受
    for (const bad of ['private_123/../private_123/2026-10.jsonl', path.resolve(file), 'private_999/2026-10.jsonl', '2026-10.jsonl']) {
      assert.throws(() => lm.deleteArchiveRows(KEY, { rows: [{ file: bad, line: 1, t: 'x' }] }), /文件不属于这个会话/, `应拒绝 ${bad}`);
    }
    // 行号必须是正整数
    assert.throws(() => lm.deleteArchiveRows(KEY, { rows: [{ file: line2.file, line: 0, t: 'x' }] }), /行号/);
    assert.throws(() => lm.deleteArchiveRows(KEY, { rows: [{ file: line2.file, line: 1.5, t: 'x' }] }), /行号/);

    // 一次最多 500 条
    const many = Array.from({ length: 501 }, () => ({ file: line2.file, line: 1, t: line2.t }));
    assert.throws(() => lm.deleteArchiveRows(KEY, { rows: many }), /500/);

    // 这些失败调用都不能改动文件
    assert.equal(fs.readFileSync(file).length, before.length);
  });
});

// ── ③ 按范围删 ────────────────────────────────────────────────────────────
await test('按范围删：跨月份只删范围内的行，dryRun 不写文件', async () => {
  await withMemory(async ({ lm, dir }) => {
    seed(lm, KEY, [
      { at: '2026-09-15T10:00:00', text: '九月一' },
      { at: '2026-09-20T10:00:00', text: '九月二' },
      { at: '2026-10-05T10:00:00', text: '十月一' },
      { at: '2026-10-20T10:00:00', text: '十月二' }
    ]);
    const sep = path.join(dir, 'archive', 'private_123', '2026-09.jsonl');
    const oct = path.join(dir, 'archive', 'private_123', '2026-10.jsonl');
    const sepBefore = fs.readFileSync(sep);
    const octBefore = fs.readFileSync(oct);

    const dry = lm.deleteArchiveRows(KEY, { from: '2026-10-01', to: '2026-10-10', dryRun: true });
    assert.deepEqual(dry, { matched: 1, deleted: 0, skipped: 0 });
    assert.deepEqual(fs.readFileSync(oct), octBefore, 'dryRun 不能改文件');
    assert.deepEqual(fs.readFileSync(sep), sepBefore, 'dryRun 不能改文件');

    const real = lm.deleteArchiveRows(KEY, { from: '2026-10-01' });
    assert.deepEqual(real, { matched: 2, deleted: 2, skipped: 0 });
    assert.deepEqual(fs.readFileSync(sep), sepBefore, '九月不在范围里，不能动');
    const octAfter = fs.readFileSync(oct);
    assert.equal(octAfter.length, octBefore.length, '墓碑不改变文件大小');
    const octLines = octAfter.toString('utf8').split('\n');
    assert.equal(JSON.parse(octLines[0]).deleted, true);
    assert.equal(JSON.parse(octLines[1]).deleted, true);

    // 日期规则：真实日期 / from <= to
    assert.throws(() => lm.listArchiveRows(KEY, { from: '2026-02-30' }), /日期不存在/);
    assert.throws(() => lm.deleteArchiveRows(KEY, { from: '2026-1-5' }), /YYYY-MM-DD/);
    assert.throws(() => lm.deleteArchiveRows(KEY, { from: '2026-13-01' }), /日期不存在/);
    assert.throws(() => lm.deleteArchiveRows(KEY, { from: '2026-10-10', to: '2026-10-01' }), /from 不能晚于 to/);
    // 两种模式都给 / 都不给
    assert.throws(
      () => lm.deleteArchiveRows(KEY, { rows: [{ file: 'private_123/2026-10.jsonl', line: 1, t: 'x' }], from: '2026-10-01' }),
      /二选一/
    );
    assert.throws(() => lm.deleteArchiveRows(KEY, {}), /要么给 rows/);
  });
});

// ── ④ 遗忘请求文件 ────────────────────────────────────────────────────────
await test('遗忘请求文件：目录 700、文件 600；dryRun / 0 条删除不写', async () => {
  await withMemory(async ({ lm, dir }) => {
    seed(lm, KEY, MSGS.slice(0, 3));
    const forgetDir = path.join(dir, 'forget-requests');
    const forgetFile = path.join(forgetDir, 'private_123.json');
    const line1 = lm.listArchiveRows(KEY).rows.find((r) => r.line === 1);

    // 目录还不存在时返回空数组
    assert.deepEqual(lm.pendingForgetKeys(), []);

    lm.deleteArchiveRows(KEY, { rows: [{ file: line1.file, line: 1, t: line1.t }], dryRun: true });
    assert.equal(fs.existsSync(forgetFile), false, 'dryRun 不写请求文件');

    lm.deleteArchiveRows(KEY, { rows: [{ file: line1.file, line: 1, t: '1999-01-01T00:00:00.000Z' }] });
    assert.equal(fs.existsSync(forgetFile), false, '一条都没删掉时不写请求文件');

    const r = lm.deleteArchiveRows(KEY, { rows: [{ file: line1.file, line: 1, t: line1.t }] });
    assert.equal(r.deleted, 1);
    assert.equal(fs.existsSync(forgetFile), true);
    assertPosixMode(forgetFile, 0o600, '请求文件必须是 600');
    assertPosixMode(forgetDir, 0o700, '请求目录必须是 700');
    const content = JSON.parse(fs.readFileSync(forgetFile, 'utf8'));
    assert.equal(content.key, KEY);
    assert.equal(typeof content.at, 'number');
    assert.ok(content.at <= Date.now());
    assert.deepEqual(lm.pendingForgetKeys(), [KEY]);
  });
});

// ── ⑤ 日志不含原文 ────────────────────────────────────────────────────────
await test('日志只记会话与条数，不含消息原文', async () => {
  const logs = [];
  await withMemory(async ({ lm }) => {
    seed(lm, KEY, [
      { at: '2026-10-01T10:00:00', text: '前一条' },
      { at: '2026-10-01T10:01:00', text: '独角兽披萨店' },
      { at: '2026-10-01T10:02:00', text: '后一条' }
    ]);
    const row = lm.listArchiveRows(KEY).rows.find((r) => r.line === 2);
    lm.deleteArchiveRows(KEY, { rows: [{ file: row.file, line: 2, t: row.t }] });
  }, { log: (line) => logs.push(line) });
  assert.ok(logs.some((l) => l.includes('存档删除')), `应留下删除日志：${logs.join(' | ')}`);
  assert.ok(logs.some((l) => l.includes(KEY)), '删除日志要带会话');
  assert.ok(logs.every((l) => !l.includes('独角兽')), `日志不得包含消息原文：${logs.join(' | ')}`);
});

// ── ⑤-b 写入失败 ──────────────────────────────────────────────────────────
await test('写入失败：只读文件时 deleted=0、skipped 记满、日志不含原文、不写遗忘请求', async () => {
  const logs = [];
  await withMemory(async ({ lm, dir }) => {
    seed(lm, KEY, [
      { at: '2026-10-01T10:00:00', text: '前一条' },
      { at: '2026-10-01T10:01:00', text: '蓝鲸邮票册的那条' },
      { at: '2026-10-01T10:02:00', text: '后一条' }
    ]);
    const file = path.join(dir, 'archive', 'private_123', '2026-10.jsonl');
    const row = lm.listArchiveRows(KEY).rows.find((r) => r.line === 2);
    fs.chmodSync(file, 0o400); // 只读：openSync(file, 'r+') 会 EACCES
    try {
      const r = lm.deleteArchiveRows(KEY, { rows: [{ file: row.file, line: 2, t: row.t }] });
      assert.deepEqual(r, { matched: 1, deleted: 0, skipped: 1 }, '写失败要按 skipped 上报，不能算删掉');
    } finally {
      fs.chmodSync(file, 0o600);
    }
    const forgetFile = path.join(dir, 'forget-requests', 'private_123.json');
    assert.equal(fs.existsSync(forgetFile), false, '一条都没删掉时不得写遗忘请求');
  }, { log: (line) => logs.push(line) });
  assert.ok(logs.some((l) => l.includes('存档删除写入失败')), `应留下写入失败日志：${logs.join(' | ')}`);
  assert.ok(logs.some((l) => l.includes('2026-10.jsonl')), '失败日志要带文件名');
  assert.ok(logs.every((l) => !l.includes('蓝鲸邮票册')), `日志不得包含消息原文：${logs.join(' | ')}`);
});

// ── ⑥ 客户端 ──────────────────────────────────────────────────────────────
await test('客户端：forget 非法 key 不发请求；成功返回 { ok, status, data }', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { ok: true, key: entry.body?.key, removed_chunks: 2 }));
  try {
    const client = createMemoryRagClient({ url: rag.url });
    assert.equal(await client.forget('private:abc'), null);
    assert.equal(await client.forget(''), null);
    assert.equal(rag.requests.length, 0, '非法 key 不得发请求');

    const r = await client.forget(KEY);
    assert.deepEqual(r, { ok: true, status: 200, data: { ok: true, key: KEY, removed_chunks: 2 } });
    assert.equal(rag.requests[0].path, '/forget');
    assert.deepEqual(rag.requests[0].body, { key: KEY });
  } finally { await rag.close(); }
});

await test('客户端：indexRun / rebuild 的请求形状', async () => {
  const rag = await startRagServer((entry, req, res) => {
    if (entry.path === '/rebuild') return replyJson(res, 202, { ok: true, job: { kind: 'rebuild' } });
    return replyJson(res, 200, { ok: true, indexed: 3 });
  });
  try {
    const client = createMemoryRagClient({ url: rag.url });
    assert.deepEqual(await client.indexRun(), { ok: true, status: 200, data: { ok: true, indexed: 3 } });
    assert.equal(rag.requests[0].method, 'POST');
    assert.equal(rag.requests[0].path, '/index/run');
    assert.deepEqual(await client.rebuild(), { ok: true, status: 202, data: { ok: true, job: { kind: 'rebuild' } } });
    assert.equal(rag.requests[1].path, '/rebuild');
    assert.deepEqual(rag.requests[1].body, {});
  } finally { await rag.close(); }
});

await test('客户端：409 原样透传；网络失败返回 null', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 409, { detail: '索引正忙，稍后重试' }));
  try {
    const client = createMemoryRagClient({ url: rag.url });
    const r = await client.forget(KEY);
    assert.deepEqual(r, { ok: false, status: 409, data: { detail: '索引正忙，稍后重试' } });
  } finally { await rag.close(); }

  const port = await freePort();
  const offline = createMemoryRagClient({ url: `http://127.0.0.1:${port}`, timeoutMs: 500 });
  assert.equal(await offline.forget(KEY), null);
  assert.equal(await offline.indexRun(), null);
  assert.equal(await offline.rebuild(), null);
  assert.equal(await offline.health(), null);
});

await test('客户端：health 成功返回原对象，失败返回 null', async () => {
  const ok = await startRagServer((entry, req, res) => replyJson(res, 200, { ok: true, forget_requests: [], job: null }));
  try {
    const client = createMemoryRagClient({ url: ok.url });
    assert.deepEqual(await client.health(), { ok: true, forget_requests: [], job: null });
  } finally { await ok.close(); }

  const bad = await startRagServer((entry, req, res) => replyJson(res, 500, 'not-json'));
  try {
    const client = createMemoryRagClient({ url: bad.url });
    assert.equal(await client.health(), null);
  } finally { await bad.close(); }
});

await test('客户端：非回环地址创建时抛错', () => {
  for (const url of ['http://10.1.2.3:8093', 'http://example.com']) {
    assert.throws(() => createMemoryRagClient({ url }), /回环/);
  }
});

// ── ⑦ 桥接接口 ────────────────────────────────────────────────────────────
const archiveRow = (iso, text) => JSON.stringify({ t: iso, dir: 'in', userId: '123', name: '小明', text, msgId: 'fixture' });
const ARCHIVE_FILE = 'state/long-memory/archive/private_123/2026-10.jsonl';
const ARCHIVE_FIXTURE = [
  archiveRow('2026-10-01T10:00:00.000Z', '第一条消息'),
  archiveRow('2026-10-02T10:00:00.000Z', '第二条消息：银河邮局'),
  archiveRow('2026-10-03T10:00:00.000Z', '第三条消息')
].join('\n') + '\n';

await test('bridge：/api/ltm/archive/rows 正常返回，key 不在存档里 → 400', async () => {
  const h = await bridgeHarness({ files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, `/api/ltm/archive/rows?key=${encodeURIComponent(KEY)}&limit=2`);
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.key, KEY);
      assert.equal(res.json.total, 3);
      assert.equal(res.json.rows.length, 2, 'limit 生效');
      assert.deepEqual(res.json.rows.map((r) => r.line), [3, 2], '从新到旧');
      assert.equal(res.json.rows[0].file, 'private_123/2026-10.jsonl');
      assert.equal(res.json.rows[0].text, '第三条消息');

      const bad = await call(port, '/api/ltm/archive/rows?key=private:999');
      assert.equal(bad.status, 400, bad.body);
      assert.equal(bad.json.ok, false);

      const bad2 = await call(port, '/api/ltm/archive/rows?key=not-a-key');
      assert.equal(bad2.status, 400, bad2.body);
    });
  } finally { await h.close(); }
});

await test('bridge：删存档 → memory-rag 正常时 forget=done，并真的发了 POST /forget', async () => {
  const rag = await startRagServer((entry, req, res) => {
    if (entry.path === '/forget') return replyJson(res, 200, { ok: true, key: entry.body.key, removed_chunks: 7 });
    return replyJson(res, 404, { detail: 'nope' });
  });
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url, timeoutMs: 1000 } }, files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE } });
  try {
    await withServer(h, async (port) => {
      const rows = (await call(port, `/api/ltm/archive/rows?key=${encodeURIComponent(KEY)}`)).json.rows;
      const target = rows.find((r) => r.line === 2);
      const res = await call(port, '/api/ltm/archive/delete', {
        method: 'POST', body: { key: KEY, rows: [{ file: target.file, line: 2, t: target.t }] }
      });
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(
        { matched: res.json.matched, deleted: res.json.deleted, skipped: res.json.skipped, forget: res.json.forget, removedChunks: res.json.removedChunks },
        { matched: 1, deleted: 1, skipped: 0, forget: 'done', removedChunks: 7 }
      );
    });
    assert.equal(rag.requests.length, 1);
    assert.equal(rag.requests[0].path, '/forget');
    assert.deepEqual(rag.requests[0].body, { key: KEY });
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：memory-rag 不可达时 forget=queued，请求文件留着', async () => {
  const port = await freePort();
  const h = await bridgeHarness({
    config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } },
    files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE }
  });
  try {
    await withServer(h, async (consolePort) => {
      const res = await call(consolePort, '/api/ltm/archive/delete', {
        method: 'POST', body: { key: KEY, from: '2026-10-02', to: '2026-10-02' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.deleted, 1);
      assert.equal(res.json.forget, 'queued');
      assert.equal(res.json.removedChunks, null);
    });
    const f = path.join(h.temp, 'state/long-memory/forget-requests/private_123.json');
    assert.equal(fs.existsSync(f), true, '请求文件要留着等 memory-rag 起来处理');
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).key, KEY);
  } finally { await h.close(); }
});

await test('bridge：dryRun 时 forget=none，不改文件也不请求 memory-rag', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { ok: true, removed_chunks: 1 }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE } });
  try {
    const file = path.join(h.temp, ARCHIVE_FILE);
    const before = fs.readFileSync(file);
    await withServer(h, async (port) => {
      const res = await call(port, '/api/ltm/archive/delete', {
        method: 'POST', body: { key: KEY, from: '2026-10-01', to: '2026-10-31', dryRun: true }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.matched, 3);
      assert.equal(res.json.deleted, 0);
      assert.equal(res.json.forget, 'none');
    });
    assert.deepEqual(fs.readFileSync(file), before, 'dryRun 不能改文件');
    assert.equal(rag.requests.length, 0, 'dryRun 不得请求 memory-rag');
    assert.equal(fs.existsSync(path.join(h.temp, 'state/long-memory/forget-requests')), false);
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：/api/ltm/rag/status 的可达 / 不可达与 pendingForget', async () => {
  // 可达：health 200，但 /forget 忙（409）⇒ 请求文件留着，pendingForget 能看到。
  const rag = await startRagServer((entry, req, res) => {
    if (entry.path === '/health') return replyJson(res, 200, { ok: true, forget_requests: [], job: null });
    if (entry.path === '/forget') return replyJson(res, 409, { detail: '索引正忙，稍后重试' });
    return replyJson(res, 404, {});
  });
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE } });
  try {
    await withServer(h, async (port) => {
      const del = await call(port, '/api/ltm/archive/delete', { method: 'POST', body: { key: KEY, from: '2026-10-01', to: '2026-10-03' } });
      assert.equal(del.status, 200, del.body);
      assert.equal(del.json.deleted, 3);
      assert.equal(del.json.forget, 'queued');

      const st = await call(port, '/api/ltm/rag/status');
      assert.equal(st.status, 200, st.body);
      assert.equal(st.json.configured, true);
      assert.equal(st.json.reachable, true);
      assert.deepEqual(st.json.health, { ok: true, forget_requests: [], job: null });
      assert.deepEqual(st.json.pendingForget, [KEY]);
    });
  } finally { await h.close(); await rag.close(); }

  // 不可达：连接拒绝
  const port = await freePort();
  const h2 = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } }, files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE } });
  try {
    await withServer(h2, async (consolePort) => {
      const st = await call(consolePort, '/api/ltm/rag/status');
      assert.equal(st.status, 200, st.body);
      assert.equal(st.json.configured, true);
      assert.equal(st.json.reachable, false);
      assert.equal(st.json.health, null);
      assert.deepEqual(st.json.pendingForget, []);
    });
  } finally { await h2.close(); }

  // 没配置（地址不是回环，客户端构造失败 ⇒ rag 为空）：不发任何请求
  const h3 = await bridgeHarness({ config: { memoryRag: { url: 'http://10.1.2.3:8093' } }, files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE } });
  try {
    await withServer(h3, async (consolePort) => {
      const st = await call(consolePort, '/api/ltm/rag/status');
      assert.equal(st.json.configured, false);
      assert.equal(st.json.reachable, false);
      assert.equal(st.json.health, null);
      const idx = await call(consolePort, '/api/ltm/rag/index', { method: 'POST', body: {} });
      assert.equal(idx.status, 503, idx.body);
      assert.equal(idx.json.error, '向量索引没有配置');
    });
  } finally { await h3.close(); }
});

await test('bridge：/api/ltm/rag/rebuild 把 409 与 detail 透传；index 成功返回 result', async () => {
  const rag = await startRagServer((entry, req, res) => {
    if (entry.path === '/rebuild') return replyJson(res, 409, { detail: '已有重建任务在进行' });
    if (entry.path === '/index/run') return replyJson(res, 200, { ok: true, indexed: 2 });
    return replyJson(res, 404, {});
  });
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/ltm/rag/rebuild', { method: 'POST', body: {} });
      assert.equal(res.status, 409, res.body);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error, '已有重建任务在进行');

      const idx = await call(port, '/api/ltm/rag/index', { method: 'POST', body: {} });
      assert.equal(idx.status, 200, idx.body);
      assert.deepEqual(idx.json, { ok: true, result: { ok: true, indexed: 2 } });
    });
    assert.deepEqual(rag.requests.map((r) => r.path), ['/rebuild', '/index/run']);
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：带 agent 令牌访问 /api/ltm/archive/delete 被拒，存档没被改', async () => {
  const h = await bridgeHarness({ files: { [ARCHIVE_FILE]: ARCHIVE_FIXTURE } });
  try {
    const file = path.join(h.temp, ARCHIVE_FILE);
    const before = fs.readFileSync(file);
    await withServer(h, async (port) => {
      const res = await call(port, '/api/ltm/archive/delete', {
        method: 'POST', token: 'fixture-agent-token', body: { key: KEY, from: '2026-10-01' }
      });
      assert.notEqual(res.status, 200, `agent 令牌必须被拒，实际 ${res.status} ${res.body}`);
    });
    assert.deepEqual(fs.readFileSync(file), before, '被拒的请求不得改动存档');
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
