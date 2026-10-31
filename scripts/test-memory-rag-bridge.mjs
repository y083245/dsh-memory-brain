// memory-rag 桥接接入（P1）的测试：
//   ① src/memory-rag-client.js 的纯函数与 HTTP 客户端（本地假服务，随机端口）
//   ② bridge.js 的 /api/socialV2/history-search（rag 路径 / 降级 / 参数校验 / 隔离）
//
// 全部用临时目录 + 合成数据：不碰真实 state/，不连线上桥接，不依赖真的 memory-rag。
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createMemoryRagClient, normalizeDateRange, normalizeKeywords } from '../src/memory-rag-client.js';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const KEY = 'private:123';
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

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

const archiveRow = (iso, text, { dir = 'in', userId = '123', name = '小明' } = {}) => JSON.stringify({ t: iso, dir, userId, name, text, msgId: 'fixture' });

// ── 客户端 ────────────────────────────────────────────────────────────────
await test('客户端：成功时只保留白名单字段（剥掉 file/line/ids/score）', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, {
    key: entry.body.key,
    semantic: 'ok',
    hint: '服务端提示',
    items: [{
      ids: ['chunk-1'], score: 0.91, title: '吃火锅', day: '2026-10-27', sources: ['vector', 'bm25'],
      text: '2026-10-27 20:00 我：今晚吃火锅',
      file: 'private_123/2026-10.jsonl', file_end: 'private_123/2026-10.jsonl', line_start: 3, line_end: 5
    }]
  }));
  try {
    const client = createMemoryRagClient({ url: rag.url });
    const r = await client.search({ key: KEY, query: '晚上吃了什么', keywords: ['火锅', '火锅', '麻辣'], k: 3, expand: 2 });
    assert.ok(r, '应返回结果');
    assert.equal(r.semantic, 'ok');
    assert.equal(r.hint, '服务端提示');
    assert.equal(r.items.length, 1);
    assert.deepEqual(Object.keys(r.items[0]).sort(), ['day', 'sources', 'text', 'title']);
    assert.deepEqual(r.items[0].sources, ['vector', 'bm25']);
    const json = JSON.stringify(r);
    assert.ok(!json.includes('private_123'), '不得带出存档文件名');
    assert.ok(!json.includes('/home/'), '不得带出本机绝对路径');
    assert.ok(!json.includes('score'), '不得带出打分字段');
    const sent = rag.requests[0].body;
    assert.equal(rag.requests[0].path, '/search');
    assert.equal(sent.key, KEY);
    assert.deepEqual(sent.keywords, ['火锅', '麻辣'], '客户端也要去重');
    assert.equal(sent.k, 3);
    assert.equal(sent.expand, 2);
  } finally { await rag.close(); }
});

await test('客户端：超时返回 null，且按 timeoutMs 及时放弃', async () => {
  const rag = await startRagServer(() => { /* 永不响应 */ });
  try {
    const client = createMemoryRagClient({ url: rag.url, timeoutMs: 150 });
    const startedAt = Date.now();
    const r = await client.search({ key: KEY, query: '随便问问' });
    const elapsed = Date.now() - startedAt;
    assert.equal(r, null);
    assert.ok(elapsed < 2000, `超时应远快于测试上限，实际 ${elapsed}ms`);
  } finally { await rag.close(); }
});

await test('客户端：400 / 503 / 坏 JSON / 连接拒绝 都返回 null', async () => {
  const statuses = [400, 500, 503];
  for (const status of statuses) {
    const rag = await startRagServer((entry, req, res) => replyJson(res, status, { error: 'fixture' }));
    try {
      const client = createMemoryRagClient({ url: rag.url });
      assert.equal(await client.search({ key: KEY, query: 'x' }), null, `HTTP ${status} 应降级`);
    } finally { await rag.close(); }
  }
  const bad = await startRagServer((entry, req, res) => replyJson(res, 200, 'not-json'));
  try {
    const client = createMemoryRagClient({ url: bad.url });
    assert.equal(await client.search({ key: KEY, query: 'x' }), null, '坏 JSON 应降级');
  } finally { await bad.close(); }
  const port = await freePort();
  const offline = createMemoryRagClient({ url: `http://127.0.0.1:${port}`, timeoutMs: 500 });
  assert.equal(await offline.search({ key: KEY, query: 'x' }), null, '连接拒绝应降级');
  assert.equal(await offline.health(), null, 'health 连接拒绝返回 null');
});

await test('客户端：503 的日志 10 分钟内只打一次', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 503, { error: 'mismatch' }));
  try {
    const logs = [];
    const client = createMemoryRagClient({ url: rag.url, log: (line) => logs.push(line) });
    assert.equal(await client.search({ key: KEY, query: 'a' }), null);
    assert.equal(await client.search({ key: KEY, query: 'b' }), null);
    assert.equal(logs.filter((l) => l.includes('503')).length, 1, `应只提示一次，实际：${logs.join(' | ')}`);
  } finally { await rag.close(); }
});

await test('客户端：响应 key 与请求不一致时返回 null 并告警', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, {
    key: 'private:999', semantic: 'ok', items: [{ day: '2026-10-27', title: '', sources: ['bm25'], text: '别人的私聊' }]
  }));
  try {
    const logs = [];
    const client = createMemoryRagClient({ url: rag.url, log: (line) => logs.push(line) });
    assert.equal(await client.search({ key: KEY, query: 'x' }), null);
    assert.ok(logs.some((l) => l.includes('key')), '应留下警告');
  } finally { await rag.close(); }
});

await test('客户端：非回环地址创建时抛错', async () => {
  for (const url of ['http://10.1.2.3:8093', 'http://example.com', 'http://0.0.0.0:8093']) {
    assert.throws(() => createMemoryRagClient({ url }), /回环/, `应拒绝 ${url}`);
  }
  assert.throws(() => createMemoryRagClient({ url: 'ftp://127.0.0.1:8093' }), /http/);
  // 允许的三种回环写法不应抛错
  for (const url of ['http://127.0.0.1:8093', 'http://localhost:8093', 'http://[::1]:8093']) {
    assert.doesNotThrow(() => createMemoryRagClient({ url }), `应允许 ${url}`);
  }
});

await test('客户端：不合法的会话 key 直接返回 null，不发请求', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { key: KEY, semantic: 'ok', items: [] }));
  try {
    const client = createMemoryRagClient({ url: rag.url });
    assert.equal(await client.search({ key: 'private:abc', query: 'x' }), null);
    assert.equal(rag.requests.length, 0);
  } finally { await rag.close(); }
});

await test('客户端：空字段不发送；expand 不传就不发', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { key: entry.body.key, semantic: 'ok', items: [] }));
  try {
    const client = createMemoryRagClient({ url: rag.url });
    await client.search({ key: KEY, query: '', keywords: [], from: '', to: '', speaker: '' });
    const sent = rag.requests[0].body;
    assert.deepEqual(Object.keys(sent).sort(), ['k', 'key']);
    assert.equal(sent.k, 5, 'k 默认 5');
  } finally { await rag.close(); }
});

await test('normalizeKeywords：切分、去空、去重、截断、上限 12', () => {
  assert.deepEqual(normalizeKeywords(' 火锅，火锅 、 麻辣 ; 烫 '), ['火锅', '麻辣', '烫']);
  assert.deepEqual(normalizeKeywords(['火锅', '', ' 火锅 ', '麻辣']), ['火锅', '麻辣']);
  assert.deepEqual(normalizeKeywords(''), []);
  assert.deepEqual(normalizeKeywords(null), []);
  assert.deepEqual(normalizeKeywords(123), []);
  const thirteen = Array.from({ length: 13 }, (_, i) => `词${i}`);
  assert.equal(normalizeKeywords(thirteen).length, 12);
  assert.deepEqual(normalizeKeywords(thirteen)[11], '词11', '保留最先出现的 12 个');
  const long = normalizeKeywords(['字'.repeat(50)])[0];
  assert.equal([...long].length, 40, '每个关键词最多 40 字');
});

// ── normalizeDateRange ────────────────────────────────────────────────────
await test('normalizeDateRange：固定 now=2026-10-28（周三）的常见说法', () => {
  const now = new Date(2026, 9, 28, 15, 30);
  const range = (from, to) => normalizeDateRange({ from, to }, now);
  assert.deepEqual(range('今天'), { from: '2026-10-28', to: '2026-10-28' });
  assert.deepEqual(range('昨天'), { from: '2026-10-27', to: '2026-10-27' });
  assert.deepEqual(range('前天'), { from: '2026-10-26', to: '2026-10-26' });
  assert.deepEqual(range('大前天'), { from: '2026-10-25', to: '2026-10-25' });
  assert.deepEqual(range('上周'), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(range('本周'), { from: '2026-10-26', to: '2026-10-28' });
  assert.deepEqual(range('上个月'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(range('本月'), { from: '2026-10-01', to: '2026-10-28' });
  // 绝对日期只写一端时不强行补另一端
  assert.deepEqual(range('2026-10-20', ''), { from: '2026-10-20', to: '' });
  assert.deepEqual(range('', '2026-10-20'), { from: '', to: '2026-10-20' });
  assert.deepEqual(range('2026-10-20', '2026-10-22'), { from: '2026-10-20', to: '2026-10-22' });
  // 相对说法写在 to 里：补上区间开始
  assert.deepEqual(range('', '上周'), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(range('上周', '昨天'), { from: '2026-10-19', to: '2026-10-27' });
  // from > to 交换
  assert.deepEqual(range('2026-10-25', '2026-10-20'), { from: '2026-10-20', to: '2026-10-25' });
  // 空值
  assert.deepEqual(normalizeDateRange({}, now), { from: '', to: '' });
  assert.deepEqual(normalizeDateRange({ from: '  ', to: null }, now), { from: '', to: '' });
});

await test('normalizeDateRange：非法写法抛错（信息里要包含 YYYY-MM-DD）', () => {
  const now = new Date(2026, 9, 28);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '大概上周吧', '2026-1-5']) {
    assert.throws(() => normalizeDateRange({ from: bad }, now), /YYYY-MM-DD/, `应拒绝「${bad}」`);
  }
});

await test('normalizeDateRange：跨年（1 月里算上个月/上周）', () => {
  const now = new Date(2026, 0, 15, 9, 0); // 2026-01-15 周四
  assert.deepEqual(normalizeDateRange({ from: '上个月' }, now), { from: '2025-12-01', to: '2025-12-31' });
  // 2026-01-15 是周四 → 本周一 01-12，上周一 01-05，上周日 01-11
  assert.deepEqual(normalizeDateRange({ from: '上周' }, now), { from: '2026-01-05', to: '2026-01-11' });
});

// ── 桥接端点 ──────────────────────────────────────────────────────────────
await test('bridge：rag 路径返回 source=rag，key/日期/关键词都按请求送达', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, {
    key: entry.body.key,
    semantic: 'ok',
    items: [
      { day: '2026-10-27', title: '吃火锅', sources: ['vector', 'bm25'], text: '2026-10-27 20:00 我：今晚吃火锅' },
      { day: '2026-10-26', title: '火锅店', sources: ['bm25'], text: '2026-10-26 12:00 小明：那家火锅店不错' }
    ]
  }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url, timeoutMs: 1000 } } });
  try {
    const expected = normalizeDateRange({ from: '昨天', to: '' });
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/history-search', {
        method: 'POST',
        body: { key: KEY, query: '上次说的那家吃的', keywords: '火锅，麻辣锅', from: '昨天', limit: 6, context: 2, mode: 'auto' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'rag');
      assert.equal(res.json.semantic, 'ok');
      assert.equal(res.json.key, KEY);
      assert.equal(res.json.items.length, 2);
      assert.equal(res.json.hint, undefined, '结果够多时不给重试提示');
      assert.ok(res.json.items.every((it) => !('file' in it) && !('score' in it)), '不得带内部字段');
    });
    assert.equal(rag.requests.length, 1);
    const sent = rag.requests[0].body;
    assert.equal(sent.key, KEY, '只允许用校验过的 key');
    assert.equal(sent.from, expected.from, '「昨天」应换算成具体日期');
    assert.equal(sent.to, expected.to);
    assert.deepEqual(sent.keywords, ['火锅', '麻辣锅']);
    assert.equal(sent.k, 6);
    assert.equal(sent.expand, 2);
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：memory-rag 返回 503 时降级为关键词，semantic=unavailable', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 503, { error: 'rebuild needed' }));
  const h = await bridgeHarness({
    config: { memoryRag: { url: rag.url, timeoutMs: 1000 } },
    files: {
      'state/long-memory/archive/private_123/2026-10.jsonl': `${archiveRow('2026-10-27T20:00:00.000Z', '今天晚上吃火锅')}\n`
    }
  });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/history-search', {
        method: 'POST', body: { key: KEY, query: '火锅', keywords: ['火锅'] }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'keyword');
      assert.equal(res.json.semantic, 'unavailable');
      assert.ok(Array.isArray(res.json.lines), 'lines 必须是数组');
      assert.equal(res.json.key, KEY);
      assert.ok(res.json.matched >= 1, `夹具里有一条「火锅」，应能命中：${res.body}`);
      assert.match(String(res.json.hint ?? ''), /结果很少/, '只命中 1 条时给重试提示');
    });
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：memory-rag 没起（连接拒绝）时照常降级', async () => {
  const port = await freePort();
  const h = await bridgeHarness({
    config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } },
    files: {
      'state/long-memory/archive/private_123/2026-10.jsonl': `${archiveRow('2026-10-27T20:00:00.000Z', '今天晚上吃火锅')}\n`
    }
  });
  try {
    await withServer(h, async (consolePort) => {
      const res = await call(consolePort, '/api/socialV2/history-search', {
        method: 'POST', body: { key: KEY, query: '火锅' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'keyword');
      assert.equal(res.json.semantic, 'unavailable');
      assert.ok(Array.isArray(res.json.lines));
    });
  } finally { await h.close(); }
});

await test('bridge：mode=keyword 时不发给 memory-rag，semantic=off', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { key: entry.body.key, semantic: 'ok', items: [] }));
  const h = await bridgeHarness({
    config: { memoryRag: { url: rag.url } },
    files: {
      'state/long-memory/archive/private_123/2026-10.jsonl': `${archiveRow('2026-10-27T20:00:00.000Z', '今天晚上吃火锅')}\n`
    }
  });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/history-search', {
        method: 'POST', body: { key: KEY, query: '火锅', mode: 'keyword' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'keyword');
      assert.equal(res.json.semantic, 'off');
      assert.ok(Array.isArray(res.json.lines));
    });
    assert.equal(rag.requests.length, 0, 'keyword 模式不得请求 memory-rag');
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：只给 from/to（按日期翻）不调 memory-rag，走 browse 且 semantic=off', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { key: entry.body.key, semantic: 'ok', items: [] }));
  // 存档里放一条「昨天中午」的消息；请求只给 from=昨天、不带 query/keywords。
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const h = await bridgeHarness({
    config: { memoryRag: { url: rag.url } },
    files: {
      'state/long-memory/archive/private_123/2026-10.jsonl': `${archiveRow(yesterday.toISOString(), '昨天晚上吃火锅')}\n`
    }
  });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/history-search', {
        method: 'POST', body: { key: KEY, from: '昨天' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'keyword', '按日期翻不该走 memory-rag');
      assert.equal(res.json.semantic, 'off', '服务没坏，只是没用上语义检索');
      assert.ok(Array.isArray(res.json.lines), 'lines 必须是数组');
      assert.ok(res.json.matched >= 1, `昨天那条应能翻到：${res.body}`);
      assert.ok(res.json.lines.some((line) => String(line).includes('火锅')), '按日期翻要能拿到当天的原话');
    });
    assert.equal(rag.requests.length, 0, '没有检索词时不得请求 memory-rag');
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：非法 from/to → 400，且不请求 memory-rag', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { key: entry.body.key, semantic: 'ok', items: [] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } } });
  try {
    await withServer(h, async (port) => {
      for (const bad of ['2026-13-01', '大概上周吧']) {
        const res = await call(port, '/api/socialV2/history-search', {
          method: 'POST', body: { key: KEY, query: '火锅', from: bad }
        });
        assert.equal(res.status, 400, `「${bad}」应回 400，实际 ${res.status} ${res.body}`);
        assert.match(String(res.json?.error ?? ''), /YYYY-MM-DD|日期/, '错误信息要告诉 AI 怎么改');
      }
    });
    assert.equal(rag.requests.length, 0);
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：rag 结果少于 2 段时 hint 带重试建议，并拼接服务端提示', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, {
    key: entry.body.key, semantic: 'ok', hint: '（服务端：索引可能落后）',
    items: [{ day: '2026-10-27', title: '', sources: ['bm25'], text: '2026-10-27 20:00 我：今晚吃火锅' }]
  }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/history-search', { method: 'POST', body: { key: KEY, query: '火锅' } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'rag');
      assert.match(String(res.json.hint ?? ''), /结果很少/);
      assert.match(String(res.json.hint ?? ''), /索引可能落后/, '服务端 hint 要拼在后面');
    });
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：不匹配的 x-agent-token 仍然 403（公共校验没被破坏）', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { key: entry.body.key, semantic: 'ok', items: [] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/history-search', {
        method: 'POST', headers: { 'x-agent-token': 'not-the-right-token' }, body: { key: KEY, query: '火锅' }
      });
      assert.equal(res.status, 403, res.body);
    });
    assert.equal(rag.requests.length, 0, '鉴权失败不得触达 memory-rag');
  } finally { await h.close(); await rag.close(); }
});

await test('bridge：payload 里另给 key 也不会被使用（会话隔离）', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, { key: entry.body.key, semantic: 'ok', items: [] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/history-search', {
        method: 'POST', body: { key: KEY, key2: 'group:456', target: 'group:456', query: '火锅' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.key, KEY);
    });
    assert.equal(rag.requests[0].body.key, KEY, '只能把校验过的 key 传出去');
  } finally { await h.close(); await rag.close(); }
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
