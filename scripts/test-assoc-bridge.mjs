// 联想 v1（RAG P3）第二批 · 桥接接线测试（RAG_PATCH（P3））
//
// 用 audit-bridge-harness 在临时目录里跑真实的 bridge.js：不碰 state/，不联网，
// memory-rag 一律指向测试内起的本地假服务（随机端口，测完关掉）或一个没人监听的端口。
//
// 覆盖（任务书 B 第 1～9 条）：
//   ① 客户端 recall / associate / summaries / distillRetry：白名单、key 不一致、超时、非回环
//   ② shadow：提示词逐字不变、/recall 收到来信、影子日志权限 700/600 且不含任何原文
//   ③ 不查的情况：本地文案唤醒 / bootstrap / 群聊没开 / mode=off / 没有 memory-rag 客户端
//   ④ on：提示词里在【长期记忆】之后出现【可能相关的旧事】；超时则没有这块、日志记 unavailable
//   ⑤ memory-rag 不可达：影子日志记 unavailable，唤醒照常
//   ⑥ 控制台：现查来信与摘要、墓碑显示「已删除」、stats / byTau、标注写入与取消、400、agent 令牌被拒
//   ⑦ POST /api/ltm/rag/distill-retry：透传 retried；非 2xx 原样透传；不可达 503
//   ⑧ 生活回路接线：own-life 走 composeOwnLifeAsync、associate 用 private:<ownerQQ>、没客户端时照常
//   ⑨ buildWakePromptV2 不传第 4 个参数时等于传空串
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createMemoryRagClient } from '../src/memory-rag-client.js';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const OWNER = '123';
const KEY = `private:${OWNER}`;
const GROUP = 'group:456';
const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
function replyJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}

/** 起一个本地假 memory-rag；handler(entry, req, res, server) 决定响应。 */
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
      Promise.resolve(handler(entry, req, res, server)).catch(() => { try { res.destroy(); } catch {} });
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

/** 一个没人监听的端口：memory-rag 连接会被立刻拒绝。 */
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

/** 取最近一次投递给 DSH 的 prompt 全文。 */
function lastPrompt(h) {
  const entry = h.calls.prompts.at(-1);
  return (entry?.content ?? []).map((c) => String(c?.text ?? '')).join('\n');
}

async function waitFor(fn, { timeout = 3000, interval = 20 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** 冻结时钟的 Date（VM 里注入）：两次投递的提示词才可比（时间感 / 首回复节奏都是按 now 算的）。 */
function frozenDate(nowMs) {
  const RealDate = Date;
  return class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  };
}

const shadowDir = (h) => path.join(h.temp, 'state/long-memory/recall-shadow');
const shadowFiles = (h) => {
  try { return fs.readdirSync(shadowDir(h)).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)); }
  catch { return []; }
};
const shadowLines = (h) => shadowFiles(h).flatMap((name) => {
  try {
    return fs.readFileSync(path.join(shadowDir(h), name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
});

/** 一条合法的 /recall 响应；override 用来替换某个字段。 */
function recallResponse(key, override = {}) {
  return {
    key,
    skipped: null,
    tau: 0.55,
    candidates: [{
      summary_id: 'S0123456789abcdef', chunk_id: 'chunk-1', day: '2026-10-28', t_end: 1793300000000,
      title: '周末火锅', summary: '平安说周末想去吃那家重庆火锅', cosine: 0.61,
      bm25_rank: 2, graph: 1.39, signals: ['vector', 'bm25', 'graph'], pass: true
    }],
    inject: ['S0123456789abcdef'],
    ...override
  };
}

/** 让一次唤醒真的带上「来信」：先落一条对方消息，再按 private 原因投递。 */
async function privateWake(h, text, { msgId = 'fixture-msg-1', reason = 'private', localText } = {}) {
  h.setMode('reserved2');
  h.appendSocialV2Message(KEY, '主人', text, text, false, true, msgId, [], OWNER);
  return h.deliverPrompt(KEY, localText ?? text, { wakeReason: reason });
}

// ── ① 客户端 ──────────────────────────────────────────────────────────────
await test('客户端 recall：白名单字段、texts 只留最后 3 条且截 500 字、类型不对的候选丢掉', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse(entry.body.key, {
    candidates: [
      recallResponse(entry.body.key).candidates[0],
      { summary_id: 'Sbad1', chunk_id: 'c', day: '2026-10-01', t_end: 1, title: '', summary: '', cosine: 0.9, bm25_rank: null, graph: null, signals: ['vector'], pass: 'yes' },
      { summary_id: 'Sbad2', chunk_id: 'c', day: '2026-10-01', t_end: 1, title: '', summary: '', cosine: 'x', bm25_rank: null, graph: null, signals: ['vector'], pass: true },
      { chunk_id: 'c', day: '2026-10-01', t_end: 1, title: '', summary: '', cosine: 0.9, bm25_rank: null, graph: null, signals: [], pass: true }
    ]
  })));
  try {
    const client = createMemoryRagClient({ url: rag.url });
    const long = '字'.repeat(600);
    const r = await client.recall({ key: KEY, texts: ['一', '二', '三', long], k: 9 });
    assert.ok(r, '应返回结果');
    assert.equal(r.skipped, null);
    assert.equal(r.tau, 0.55);
    assert.deepEqual(r.inject, ['S0123456789abcdef']);
    assert.equal(r.candidates.length, 1, '类型不对的候选要整条丢掉');
    assert.deepEqual(Object.keys(r.candidates[0]).sort(), [
      'bm25_rank', 'chunk_id', 'cosine', 'day', 'graph', 'pass', 'signals', 'summary', 'summary_id', 't_end', 'title'
    ]);
    const sent = rag.requests[0].body;
    assert.equal(rag.requests[0].path, '/recall');
    assert.equal(sent.key, KEY);
    assert.equal(sent.k, 5, 'k 夹到 1～5');
    assert.equal(sent.texts.length, 3, '只留最后 3 条');
    assert.equal([...sent.texts[2]].length, 500, '每条截 500 字');
    assert.deepEqual(sent.texts.slice(0, 2), ['二', '三']);
  } finally { await rag.close(); }
});

await test('客户端 recall：key 不一致 / 超时 / 坏结构 都返回 null；非法 key 不发请求', async () => {
  const mismatch = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse('private:999')));
  try {
    const client = createMemoryRagClient({ url: mismatch.url });
    assert.equal(await client.recall({ key: KEY, texts: ['你好'] }), null, 'key 不一致整份丢掉');
  } finally { await mismatch.close(); }

  const slow = await startRagServer(() => { /* 永不响应 */ });
  try {
    const client = createMemoryRagClient({ url: slow.url, recallTimeoutMs: 100 });
    const startedAt = Date.now();
    assert.equal(await client.recall({ key: KEY, texts: ['你好'] }), null);
    assert.ok(Date.now() - startedAt < 2000, '超时后应立刻放弃');
  } finally { await slow.close(); }

  const bad = await startRagServer((entry, req, res) => replyJson(res, 200, { key: entry.body.key, candidates: {} }));
  try {
    const client = createMemoryRagClient({ url: bad.url });
    assert.equal(await client.recall({ key: KEY, texts: ['你好'] }), null, 'candidates 不是数组 → null');
  } finally { await bad.close(); }

  const none = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse(entry.body.key)));
  try {
    const client = createMemoryRagClient({ url: none.url });
    assert.equal(await client.recall({ key: 'private:abc', texts: ['你好'] }), null);
    assert.equal(none.requests.length, 0, '非法 key 不得发请求');
  } finally { await none.close(); }
});

await test('客户端 associate / summaries：白名单字段与参数归一（people 只留纯数字、min_age_days）', async () => {
  const rag = await startRagServer((entry, req, res) => {
    if (entry.path === '/associate') {
      return replyJson(res, 200, {
        key: entry.body.key,
        items: [
          { summary_id: 'S1', day: '2026-10-20', t_end: 1792500000000, title: '换工作', summary: '小夏说想换工作', score: 1.8, via: ['小夏'] },
          { summary_id: 'S2', day: '2026-10-21', t_end: 1792500000001, title: '', summary: '', score: 'x', via: [] }
        ]
      });
    }
    return replyJson(res, 200, {
      key: entry.body.key,
      items: [
        { summary_id: 'S1', day: '2026-10-28', title: '周末火锅', summary: '平安说想去吃火锅', chunk_id: 'internal' },
        { summary_id: 'S2', title: '缺日期' }
      ]
    });
  });
  try {
    const client = createMemoryRagClient({ url: rag.url });
    const assoc = await client.associate({ key: KEY, text: '换工作', people: ['123', 'abc', ' 456 '], exclude: ['S9'], minAgeDays: 3, k: 4 });
    assert.ok(assoc);
    assert.equal(assoc.items.length, 1, 'score 类型不对的条目丢掉');
    assert.deepEqual(Object.keys(assoc.items[0]).sort(), ['day', 'score', 'summary', 'summary_id', 't_end', 'title', 'via']);
    const sent = rag.requests.find((r) => r.path === '/associate').body;
    assert.deepEqual(sent.people, ['123', '456']);
    assert.equal(sent.min_age_days, 3);
    assert.deepEqual(sent.exclude, ['S9']);
    assert.equal(sent.k, 4);

    const sums = await client.summaries({ key: KEY, ids: ['S1', 'S2'] });
    assert.ok(sums);
    assert.deepEqual(sums.items, [{ summary_id: 'S1', day: '2026-10-28', title: '周末火锅', summary: '平安说想去吃火锅' }]);
    assert.deepEqual(await client.summaries({ key: KEY, ids: [] }), { items: [] }, '没有 id 不发请求，直接空数组');

    const badKey = await startRagServer((entry, req, res) => replyJson(res, 200, { key: 'private:999', items: [] }));
    try {
      assert.equal(await createMemoryRagClient({ url: badKey.url }).summaries({ key: KEY, ids: ['S1'] }), null, 'key 不一致 → null');
      assert.equal(await createMemoryRagClient({ url: badKey.url }).associate({ key: KEY, text: 'x' }), null, 'key 不一致 → null');
    } finally { await badKey.close(); }
  } finally { await rag.close(); }
});

await test('客户端：非回环地址构造即报错；distillRetry 透传 200 / 409 / 503', async () => {
  for (const url of ['http://10.1.2.3:8093', 'http://example.com']) {
    assert.throws(() => createMemoryRagClient({ url }), /回环/, `应拒绝 ${url}`);
  }
  const ok = await startRagServer((entry, req, res) => replyJson(res, 200, { ok: true, retried: 3 }));
  try {
    const r = await createMemoryRagClient({ url: ok.url }).distillRetry();
    assert.deepEqual(r, { ok: true, status: 200, data: { ok: true, retried: 3 } });
    assert.equal(ok.requests[0].path, '/distill/retry');
  } finally { await ok.close(); }
  for (const status of [409, 503]) {
    const busy = await startRagServer((entry, req, res) => replyJson(res, status, { detail: 'fixture' }));
    try {
      const r = await createMemoryRagClient({ url: busy.url }).distillRetry();
      assert.equal(r.ok, false);
      assert.equal(r.status, status);
    } finally { await busy.close(); }
  }
  const port = await freePort();
  assert.equal(await createMemoryRagClient({ url: `http://127.0.0.1:${port}`, log: () => {} }).distillRetry(), null, '不可达 → null');
});

// ── ② shadow：提示词逐字不变 + 影子日志 ────────────────────────────────────
await test('shadow：与 off 的提示词逐字相同；/recall 收到来信；影子日志 700/600 且不含任何原文', async () => {
  const uniqueText = '独角兽来信词汇QQQ今天加班到很晚';
  const uniqueSummary = '摘要独特词WWW平安说周末想去吃火锅';
  const now = Date.now();
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse(entry.body.key, {
    candidates: [{
      summary_id: 'S1', chunk_id: 'c1', day: '2026-10-28', t_end: 1, title: '火锅', summary: uniqueSummary,
      cosine: 0.7, bm25_rank: 1, graph: null, signals: ['vector', 'bm25'], pass: true
    }],
    inject: ['S1']
  })));
  const prompts = [];
  try {
    for (const mode of ['shadow', 'off']) {
      const h = await bridgeHarness({
        config: { memoryRag: { url: rag.url, recall: { mode } } },
        globals: { Date: frozenDate(now) }
      });
      try {
        const callsBefore = rag.requests.filter((r) => r.path === '/recall').length;
        await privateWake(h, uniqueText);
        prompts.push(lastPrompt(h).replace(/【会话令牌】[0-9a-f]{32}/, '【会话令牌】TOKEN'));
        if (mode === 'off') {
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(rag.requests.filter((r) => r.path === '/recall').length, callsBefore, 'off 不该请求 /recall');
          continue;
        }
        const call0 = await waitFor(() => rag.requests.find((r) => r.path === '/recall'));
        assert.ok(call0, 'shadow 应请求一次 /recall');
        assert.deepEqual(call0.body.texts, [uniqueText], 'texts 是来信原文');
        assert.equal(call0.body.key, KEY);
        assert.equal(call0.body.k, 2);

        const line = await waitFor(() => shadowLines(h)[0]);
        assert.ok(line, '影子日志应有一行');
        assert.equal(line.mode, 'shadow');
        assert.equal(line.key, KEY);
        assert.equal(line.reason, 'private');
        assert.equal(line.skipped, null);
        assert.equal(line.tau, 0.55);
        assert.deepEqual(line.msgs, [{ t: now, msgId: 'fixture-msg-1' }]);
        assert.equal(line.candidates.length, 1);
        assert.deepEqual(line.candidates[0].signals, ['vector', 'bm25']);
        assert.equal(line.candidates[0].pass, true);
        assert.deepEqual(line.inject, ['S1']);
        assert.match(line.id, /^r-\d+-[0-9a-f]{4}$/);

        const dir = shadowDir(h);
        const file = path.join(dir, shadowFiles(h)[0]);
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700, '目录权限 700');
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, '文件权限 600');
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!raw.includes('独角兽来信词汇QQQ'), '日志不得出现来信原文');
        assert.ok(!raw.includes('摘要独特词WWW'), '日志不得出现摘要原文');
      } finally { await h.close(); }
    }
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1], 'shadow 与 off 的提示词必须逐字相同');
  } finally { await rag.close(); }
});

// ── ③ 不该查的唤醒 ────────────────────────────────────────────────────────
await test('不查：本地文案唤醒 / bootstrap / 群聊没开 / mode=off → 假服务收到 0 次 /recall', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse(entry.body.key)));
  try {
    const h = await bridgeHarness({ config: { memoryRag: { url: rag.url, recall: { mode: 'shadow' } } } });
    try {
      h.setMode('reserved2');
      // 本地文案唤醒：这三种都在 LOCAL_TEXT_WAKES 里，再加首次引导。
      await h.deliverPrompt(KEY, '现在是你的时间。', { silent: true, wakeReason: 'own-life' });
      await h.deliverPrompt(KEY, '今天有到期的约定。', { silent: true, wakeReason: 'promise-due' });
      await h.deliverPrompt(KEY, '【这周的你】', { silent: true, wakeReason: 'persona-weekly' });
      await h.deliverPrompt(KEY, '引导。', { silent: true, wakeReason: 'bootstrap' });
      // 群聊：group 缺省 false（同一条来信在私聊里是会查的，见其它用例）。
      h.appendSocialV2Message(GROUP, '群友', '群里在聊火锅呢', '群里在聊火锅呢', false, false, 'g1', [], '789');
      await h.deliverPrompt(GROUP, '群里在聊火锅呢', { wakeReason: 'anyMessage' });

      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(rag.requests.filter((r) => r.path === '/recall').length, 0, '这些唤醒都不该查 /recall');

      // mode=off：改配置文件（桥接每次现读）。
      h.appendSocialV2Message(KEY, '主人', '在吗在吗', '在吗在吗', false, true, 'p1', [], OWNER);
      const cfgFile = path.join(h.temp, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      cfg.memoryRag.recall.mode = 'off';
      fs.writeFileSync(cfgFile, JSON.stringify(cfg));
      await h.deliverPrompt(KEY, '在吗在吗', { silent: true, wakeReason: 'private' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(rag.requests.filter((r) => r.path === '/recall').length, 0, 'mode=off 不该查');
    } finally { await h.close(); }

    // 私聊关了（private=false）：来信唤醒也不查。
    const noPrivate = await bridgeHarness({ config: { memoryRag: { url: rag.url, recall: { mode: 'shadow', private: false } } } });
    try {
      const before = rag.requests.filter((r) => r.path === '/recall').length;
      await privateWake(noPrivate, '在吗在吗');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(rag.requests.filter((r) => r.path === '/recall').length, before, 'private=false 不该查私聊');
    } finally { await noPrivate.close(); }

    // 没有 memory-rag 客户端（地址不是回环 → 启动时拒绝创建）。
    const noRag = await bridgeHarness({ config: { memoryRag: { url: 'http://10.9.9.9:8093' } } });
    try {
      await privateWake(noRag, '在吗在吗');
      assert.ok(lastPrompt(noRag).includes('在吗在吗'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(fs.existsSync(shadowDir(noRag)), false, '没有客户端时连影子日志都不该写');
    } finally { await noRag.close(); }
  } finally { await rag.close(); }
});

// ── ④ on ──────────────────────────────────────────────────────────────────
await test('on：提示词在【长期记忆】之后出现【可能相关的旧事】；超时则没有这块、日志记 unavailable', async () => {
  const summary = '平安说周末想去吃那家重庆火锅，排队也没关系';
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse(entry.body.key, {
    candidates: [{
      summary_id: 'S1', chunk_id: 'c1', day: '2026-10-20', t_end: 1, title: '火锅', summary,
      cosine: 0.66, bm25_rank: 3, graph: 1.2, signals: ['vector', 'bm25'], pass: true
    }],
    inject: ['S1']
  })));
  try {
    const h = await bridgeHarness({ config: { memoryRag: { url: rag.url, recall: { mode: 'on' } } } });
    try {
      await privateWake(h, '周末有空吗，想吃火锅');
      const prompt = lastPrompt(h);
      assert.ok(prompt.includes('【可能相关的旧事 —— 自动想起的，不一定准】'), '应有自动想起块');
      assert.ok(prompt.includes('· [10-20] ' + summary), '内容应是 inject 对应的摘要');
      assert.ok(prompt.includes('要原话或更多细节，用 qq_history_search 查'), '应有用法句');
      const memoryAt = prompt.indexOf('【长期记忆 —— 你一直记得的事】');
      const recallAt = prompt.indexOf('【可能相关的旧事');
      assert.ok(memoryAt >= 0 && recallAt > memoryAt, '必须在【长期记忆】块之后');
      const line = await waitFor(() => shadowLines(h)[0]);
      assert.ok(line);
      assert.equal(line.mode, 'on');
      assert.equal(line.skipped, null);
      assert.deepEqual(line.inject, ['S1']);
    } finally { await h.close(); }
  } finally { await rag.close(); }

  // 超时：/recall 永不响应，recallTimeoutMs=100 → 没有这块，唤醒照常。
  const slow = await startRagServer(() => { /* 永不响应 */ });
  try {
    const h = await bridgeHarness({ config: { memoryRag: { url: slow.url, recall: { mode: 'on', timeoutMs: 100 } } } });
    try {
      const r = await privateWake(h, '周末有空吗');
      assert.equal(r.ok, true, '唤醒照常');
      const prompt = lastPrompt(h);
      assert.ok(!prompt.includes('【可能相关的旧事'), '超时不该有自动想起块');
      assert.ok(prompt.includes('周末有空吗'));
      const line = await waitFor(() => shadowLines(h)[0]);
      assert.ok(line);
      assert.equal(line.skipped, 'unavailable');
      assert.equal(line.mode, 'on');
    } finally { await h.close(); }
  } finally { await slow.close(); }
});

// ── ⑤ memory-rag 不可达 ────────────────────────────────────────────────────
await test('shadow：memory-rag 不可达 → 日志记 unavailable，唤醒照常', async () => {
  const port = await freePort();
  const h = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } } });
  try {
    const r = await privateWake(h, '在吗，今天好累');
    assert.equal(r.ok, true);
    const prompt = lastPrompt(h);
    assert.ok(prompt.includes('在吗，今天好累'));
    assert.ok(!prompt.includes('【可能相关的旧事'));
    const line = await waitFor(() => shadowLines(h)[0]);
    assert.ok(line);
    assert.equal(line.skipped, 'unavailable');
    assert.deepEqual(line.candidates, []);
  } finally { await h.close(); }
});

// ── ⑥ 控制台接口 ──────────────────────────────────────────────────────────
await test('控制台：现查来信与摘要、墓碑显示已删除、stats 与 byTau、标注、400、agent 令牌被拒', async () => {
  const now = Date.now();
  const msgT = now - 60000;
  const entryNew = {
    id: 'r-1000-aaaa', at: now - 60000, key: KEY, reason: 'private', mode: 'shadow',
    msgs: [{ t: msgT, msgId: 'm1' }], skipped: null, tau: 0.55, ms: 30,
    candidates: [
      { summary_id: 'S1', chunk_id: 'c1', day: '2026-10-28', cosine: 0.61, signals: ['vector', 'graph'], pass: true },
      { summary_id: 'S2', chunk_id: 'c2', day: '2026-10-27', cosine: 0.3, signals: ['vector'], pass: false }
    ],
    inject: ['S1']
  };
  const entryOld = {
    id: 'r-999-bbbb', at: now - 120000, key: KEY, reason: 'private', mode: 'shadow',
    msgs: [], skipped: 'trivial', tau: 0.55, ms: 5, candidates: [], inject: []
  };
  const month = new Date(now);
  const monthRel = `state/long-memory/recall-shadow/${month.getFullYear()}-${pad2(month.getMonth() + 1)}.jsonl`;
  const archiveRel = `state/long-memory/archive/private_123/${month.getFullYear()}-${pad2(month.getMonth() + 1)}.jsonl`;
  const archiveRow = JSON.stringify({ t: new Date(msgT + 500).toISOString(), dir: 'in', userId: OWNER, name: '主人', text: '来信原文内容ABC', msgId: 'm1' });

  const rag = await startRagServer((entry, req, res) => {
    if (entry.path === '/summaries') {
      return replyJson(res, 200, {
        key: entry.body.key,
        items: [{ summary_id: 'S1', day: '2026-10-28', title: '周末火锅', summary: '摘要正文XYZ' }]
      });
    }
    if (entry.path === '/forget') return replyJson(res, 200, { ok: true, removed_chunks: 1 });
    return replyJson(res, 404, { detail: 'unknown' });
  });
  const h = await bridgeHarness({
    config: { memoryRag: { url: rag.url } },
    files: {
      [monthRel]: `${JSON.stringify(entryOld)}\n${JSON.stringify(entryNew)}\n`,
      [archiveRel]: `${archiveRow}\n`
    }
  });
  try {
    await withServer(h, async (port) => {
      const first = await call(port, '/api/ltm/recall-shadow');
      assert.equal(first.status, 200, first.body);
      // RAG_PATCH（P3）：config 带上最新条目里的 tau（控制台 τ 标定表要把「当前门槛」加粗）。
      assert.deepEqual(first.json.config, { mode: 'shadow', private: true, group: false, k: 2, timeoutMs: 400, tau: 0.55 });
      assert.deepEqual(first.json.entries.map((e) => e.id), ['r-1000-aaaa', 'r-999-bbbb'], '按时间倒序');
      const [nw, old] = first.json.entries;
      assert.equal(nw.msgs[0].text, '来信原文内容ABC', '来信原文现查存档');
      assert.equal(nw.candidates[0].title, '周末火锅');
      assert.equal(nw.candidates[0].summary, '摘要正文XYZ');
      assert.equal(nw.candidates[1].summary, '（已删除）', '服务不返回的摘要显示已删除');
      assert.equal(old.skipped, 'trivial');
      assert.equal(first.json.nextBefore, null);

      // 统计：最近 3 天 2 条；只有 S1 在日志的 τ 时 pass。
      assert.deepEqual(first.json.stats.skipped, { trivial: 1, unavailable: 0, no_summaries: 0 });
      assert.equal(first.json.stats.entries, 2);
      assert.equal(first.json.stats.withCandidates, 1);
      assert.equal(first.json.stats.withPass, 1);
      assert.equal(first.json.stats.labeled, 0);
      assert.equal(first.json.stats.rate, null, '没有标注时 rate 为 null');
      // RAG_PATCH（P3）：端到端实测后门槛档位整体下移（0.35～0.6）；用例里的余弦仍是 0.61 / 0.3，
      // 0.61 在六档上全部过线，所以 pass 从原来的 [1,1,1,0] 变成六个 1。
      assert.deepEqual(first.json.stats.byTau.map((r) => r.tau), [0.35, 0.4, 0.45, 0.5, 0.55, 0.6]);
      assert.deepEqual(first.json.stats.byTau.map((r) => r.pass), [1, 1, 1, 1, 1, 1]);
      for (const row of first.json.stats.byTau) assert.equal(row.rate, null);

      // 分页：limit=1 → 最近一条；before → 更早的一条。
      const page1 = await call(port, '/api/ltm/recall-shadow?limit=1');
      assert.equal(page1.json.entries.length, 1);
      assert.equal(page1.json.entries[0].id, 'r-1000-aaaa');
      assert.equal(page1.json.nextBefore, 'r-999-bbbb');
      const page2 = await call(port, '/api/ltm/recall-shadow?limit=1&before=r-1000-aaaa');
      assert.deepEqual(page2.json.entries.map((e) => e.id), ['r-999-bbbb']);
      assert.equal(page2.json.nextBefore, null);

      // 标注：写入 → 统计变化；再点一次（null）→ 取消。
      const label = await call(port, '/api/ltm/recall-shadow/label', {
        method: 'POST', body: { id: 'r-1000-aaaa', summary_id: 'S1', label: 'relevant' }
      });
      assert.equal(label.status, 200, label.body);
      assert.equal(label.json.label, 'relevant');
      const labeledResp = await call(port, '/api/ltm/recall-shadow');
      assert.equal(labeledResp.json.entries[0].candidates[0].label, 'relevant');
      assert.equal(labeledResp.json.stats.labeled, 1);
      assert.equal(labeledResp.json.stats.relevant, 1);
      assert.equal(labeledResp.json.stats.rate, 1);
      assert.deepEqual(labeledResp.json.stats.byTau.map((r) => r.rate), [1, 1, 1, 1, 1, 1]);

      const cancel = await call(port, '/api/ltm/recall-shadow/label', {
        method: 'POST', body: { id: 'r-1000-aaaa', summary_id: 'S1', label: null }
      });
      assert.equal(cancel.status, 200, cancel.body);
      assert.equal(cancel.json.label, null);
      const unlabeled = await call(port, '/api/ltm/recall-shadow');
      assert.equal(unlabeled.json.entries[0].candidates[0].label, null);
      assert.equal(unlabeled.json.stats.labeled, 0);

      // 400：记录不存在 / 摘要不是这条的候选。
      for (const body of [
        { id: 'r-nope', summary_id: 'S1', label: 'relevant' },
        { id: 'r-1000-aaaa', summary_id: 'S404', label: 'relevant' },
        { id: 'r-1000-aaaa', summary_id: 'S1', label: 'maybe' }
      ]) {
        const bad = await call(port, '/api/ltm/recall-shadow/label', { method: 'POST', body });
        assert.equal(bad.status, 400, `${JSON.stringify(body)} 应 400，实际 ${bad.status} ${bad.body}`);
      }

      // 把存档那一行删成墓碑（走控制台接口 → long-memory 的等长墓碑）。
      const rowsResp = await call(port, `/api/ltm/archive/rows?key=${encodeURIComponent(KEY)}`);
      assert.equal(rowsResp.status, 200, rowsResp.body);
      assert.equal(rowsResp.json.rows.length, 1);
      const row = rowsResp.json.rows[0];
      const del = await call(port, '/api/ltm/archive/delete', {
        method: 'POST', body: { key: KEY, rows: [{ file: row.file, line: row.line, t: row.t }] }
      });
      assert.equal(del.status, 200, del.body);
      assert.equal(del.json.deleted, 1);
      const afterDelete = await call(port, '/api/ltm/recall-shadow');
      assert.equal(afterDelete.json.entries[0].msgs[0].text, '（已删除）', '墓碑要显示已删除');

      // agent 令牌一律拒绝。
      for (const [pathname, opts] of [
        ['/api/ltm/recall-shadow', { method: 'GET' }],
        ['/api/ltm/recall-shadow/label', { method: 'POST', body: { id: 'r-1000-aaaa', summary_id: 'S1', label: 'relevant' } }],
        ['/api/ltm/rag/distill-retry', { method: 'POST', body: {} }]
      ]) {
        const denied = await call(port, pathname, { ...opts, token: 'whatever' });
        assert.equal(denied.status, 403, `${pathname} 带 agent 令牌必须 403，实际 ${denied.status}`);
      }
    });

    // 标注文件权限 600。
    const labelsFile = path.join(shadowDir(h), 'labels.json');
    assert.equal(fs.statSync(labelsFile).mode & 0o777, 0o600);
  } finally { await h.close(); await rag.close(); }
});

// ── ⑦ distill-retry ───────────────────────────────────────────────────────
await test('distill-retry：透传 retried；非 2xx 原样透传；不可达 503', async () => {
  const ok = await startRagServer((entry, req, res) => replyJson(res, 200, { ok: true, retried: 3 }));
  const h = await bridgeHarness({ config: { memoryRag: { url: ok.url } } });
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/ltm/rag/distill-retry', { method: 'POST', body: {} });
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(r.json, { ok: true, retried: 3 });
      assert.equal(ok.requests[0].path, '/distill/retry');
    });
  } finally { await h.close(); await ok.close(); }

  const busy = await startRagServer((entry, req, res) => replyJson(res, 409, { detail: 'distill running' }));
  const h2 = await bridgeHarness({ config: { memoryRag: { url: busy.url } } });
  try {
    await withServer(h2, async (port) => {
      const r = await call(port, '/api/ltm/rag/distill-retry', { method: 'POST', body: {} });
      assert.equal(r.status, 409, r.body);
      assert.match(String(r.json.error), /HTTP 409/);
    });
  } finally { await h2.close(); await busy.close(); }

  const port = await freePort();
  const h3 = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } } });
  try {
    await withServer(h3, async (p) => {
      const r = await call(p, '/api/ltm/rag/distill-retry', { method: 'POST', body: {} });
      assert.equal(r.status, 503, r.body);
      assert.equal(r.json.error, '向量索引服务不可达');
    });
  } finally { await h3.close(); }
});

// ── ⑧ 生活回路接线 ────────────────────────────────────────────────────────
await test('own-life 投递走 composeOwnLifeAsync（异步版的结果会进提示词）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const loop = h.getLifeLoop();
    assert.ok(loop, 'lifeLoop 应该已创建');
    let calls = 0;
    let seenArgs = null;
    loop.composeOwnLifeAsync = async (args) => { calls += 1; seenArgs = args; return '【测试】异步版内容'; };
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const r = await h.getOwnLife().tick(noon.getTime());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls, 1, 'own-life 应调用异步版');
    assert.equal(seenArgs.kind, 'day');
    const prompt = lastPrompt(h);
    assert.ok(prompt.includes('【测试】异步版内容'), '异步版结果要拼进 own-life 提示词');
  } finally { await h.close(); }
});

await test('联想链：associate 用 private:<ownerQQ>；没客户端时返回 null、【忽然想起】照常', async () => {
  const T = Date.now();
  const msgT = T - 4 * DAY;
  const month = new Date(msgT);
  const archiveRel = `state/long-memory/archive/private_123/${month.getFullYear()}-${pad2(month.getMonth() + 1)}.jsonl`;
  const row = JSON.stringify({
    t: new Date(msgT).toISOString(), dir: 'in', userId: OWNER, name: '主人',
    text: '今天加班到很晚，回来路上买了碗热汤面', msgId: 'assoc-1'
  });

  const rag = await startRagServer((entry, req, res) => {
    if (entry.path === '/associate') {
      return replyJson(res, 200, {
        key: entry.body.key,
        items: [{ summary_id: 'S9', day: '2026-10-20', t_end: 1792500000000, title: '换工作', summary: '小夏说想换工作，嫌夜班太累', score: 1.8, via: ['小夏'] }]
      });
    }
    return replyJson(res, 404, { detail: 'unknown' });
  });
  const h = await bridgeHarness({
    config: { memoryRag: { url: rag.url } },
    files: { [archiveRel]: `${row}\n` }
  });
  try {
    const text = await h.getLifeLoop().composeOwnLifeAsync({ kind: 'day', now: T, remainingSlots: 1 });
    assert.ok(text.includes('【忽然想起】'), `应抽中一条回忆：${text}`);
    assert.ok(text.includes('【顺着想到】'), '应顺着联想出一条');
    assert.ok(text.includes('小夏说想换工作'));
    const assoc = rag.requests.find((r) => r.path === '/associate');
    assert.ok(assoc, '应请求 /associate');
    assert.equal(assoc.body.key, 'private:123', '只查主人私聊');
    assert.equal(assoc.body.min_age_days, 2);
    assert.equal(h.getLifeLoop().snapshot().associateToday, 1);
  } finally { await h.close(); await rag.close(); }

  // 没有 memory-rag 客户端：associate 返回 null，【忽然想起】照常，没有【顺着想到】。
  const noRag = await bridgeHarness({ config: { memoryRag: { url: 'http://10.9.9.9:8093' } }, files: { [archiveRel]: `${row}\n` } });
  try {
    const text = await noRag.getLifeLoop().composeOwnLifeAsync({ kind: 'day', now: T, remainingSlots: 1 });
    assert.ok(text.includes('【忽然想起】'), `没有客户端时回忆照常：${text}`);
    assert.ok(!text.includes('【顺着想到】'));
    assert.equal(noRag.getLifeLoop().snapshot().associateToday, 0);
  } finally { await noRag.close(); }
});

// ── ⑨ buildWakePromptV2 的第 4 个参数 ─────────────────────────────────────
await test('buildWakePromptV2：不传第 4 个参数 === 传空串；传块时在【长期记忆】之后', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '主人', '你好呀', '你好呀', false, true, 'm1', [], OWNER);
    assert.equal(h.buildWakePromptV2(KEY, 'private', '来信'), h.buildWakePromptV2(KEY, 'private', '来信', ''));
    assert.equal(h.buildWakePromptV2(KEY, 'timeout'), h.buildWakePromptV2(KEY, 'timeout', '', ''));
    assert.equal(h.buildWakePromptV2(KEY, 'own-life', '正文'), h.buildWakePromptV2(KEY, 'own-life', '正文', ''));

    const block = '【可能相关的旧事 —— 自动想起的，不一定准】\n· [10-20] 一条旧事\n要原话或更多细节，用 qq_history_search 查；对不上就当没这回事，别硬提。';
    const withBlock = h.buildWakePromptV2(KEY, 'private', '来信', block);
    assert.ok(withBlock.includes(block));
    assert.ok(withBlock.indexOf('【长期记忆 —— 你一直记得的事】') < withBlock.indexOf('【可能相关的旧事'));
    assert.ok(withBlock.indexOf('【可能相关的旧事') < withBlock.indexOf('【参与度参考】'));
    // 本地文案分支同样带上块。
    assert.ok(h.buildWakePromptV2(KEY, 'own-life', '正文', block).includes(block));
  } finally { await h.close(); }
});

// ── ⑩ 返工 B2：同一批来信只查一次 ─────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const recallCount = (rag) => rag.requests.filter((r) => r.path === '/recall').length;

await test('同一批来信只查一次：换原因的第二次唤醒不再请求 /recall、影子日志只多一行；新来信后再查', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse(entry.body.key)));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url, recall: { mode: 'shadow' } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '主人', '今天加班到很晚', '今天加班到很晚', false, true, 'batch-1', [], OWNER);
    await h.deliverPrompt(KEY, '今天加班到很晚', { wakeReason: 'private' });
    assert.ok(await waitFor(() => shadowLines(h).length === 1), '第一次唤醒应查一次并记一行');
    assert.equal(recallCount(rag), 1);

    // 同一批来信、换成一个不是新来信的唤醒原因（回复检查）：不查、不记。
    await h.deliverPrompt(KEY, '继续', { wakeReason: 'replyCheck' });
    await sleep(250);
    assert.equal(recallCount(rag), 1, '同一批来信不该再请求 /recall');
    assert.equal(shadowLines(h).length, 1, '同一批来信不该再记一行');

    // 对方又发一条新消息：是新的一批，再查一次。
    h.appendSocialV2Message(KEY, '主人', '你在干嘛呢', '你在干嘛呢', false, true, 'batch-2', [], OWNER);
    await h.deliverPrompt(KEY, '你在干嘛呢', { wakeReason: 'private' });
    assert.ok(await waitFor(() => shadowLines(h).length === 2), '新来信应再记一行');
    assert.equal(recallCount(rag), 2, '新来信应再查一次');
    const last = rag.requests.filter((r) => r.path === '/recall').at(-1);
    assert.deepEqual(last.body.texts, ['今天加班到很晚', '你在干嘛呢'], '应带上最新的来信');
  } finally { await h.close(); await rag.close(); }
});

await test('同一批来信只查一次：上次查询时服务不可达（unavailable）也不重试', async () => {
  const port = await freePort();
  const h = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '主人', '在吗，今天好累', '在吗，今天好累', false, true, 'un-1', [], OWNER);
    await h.deliverPrompt(KEY, '在吗，今天好累', { wakeReason: 'private' });
    const line = await waitFor(() => shadowLines(h)[0]);
    assert.ok(line);
    assert.equal(line.skipped, 'unavailable');

    await h.deliverPrompt(KEY, '继续', { wakeReason: 'replyCheck' });
    await sleep(250);
    assert.equal(shadowLines(h).length, 1, '失败过的那批来信不该再查（免得反复打挂掉的服务）');
  } finally { await h.close(); }
});

await test('同一批来信只查一次：mode=on 第二次唤醒不再请求，提示词里也没有自动想起块', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, recallResponse(entry.body.key, {
    candidates: [{
      summary_id: 'S1', chunk_id: 'c1', day: '2026-10-20', t_end: 1, title: '火锅', summary: '平安说周末想去吃那家重庆火锅',
      cosine: 0.66, bm25_rank: 3, graph: 1.2, signals: ['vector', 'bm25'], pass: true
    }],
    inject: ['S1']
  })));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url, recall: { mode: 'on' } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '主人', '周末想吃火锅', '周末想吃火锅', false, true, 'on-1', [], OWNER);
    await h.deliverPrompt(KEY, '周末想吃火锅', { wakeReason: 'private' });
    assert.ok(lastPrompt(h).includes('【可能相关的旧事 —— 自动想起的，不一定准】'), '第一次应有自动想起块');
    assert.equal(recallCount(rag), 1);

    await h.deliverPrompt(KEY, '继续', { wakeReason: 'replyCheck' });
    assert.ok(!lastPrompt(h).includes('【可能相关的旧事'), '同一批来信已注入过，不该再拼一遍');
    await sleep(200);
    assert.equal(recallCount(rag), 1, '同一批来信不该再请求 /recall');
    assert.equal(shadowLines(h).length, 1, '同一批来信不该再记一行');
  } finally { await h.close(); await rag.close(); }
});

// ── ⑪ 返工 B2：GET /api/ltm/recall-shadow 的 config.tau ──────────────────
await test('控制台 config.tau：取全部日志里最新一条带数字 tau 的条目；日志为空时为 null', async () => {
  const now = Date.now();
  const month = new Date(now);
  const monthRel = `state/long-memory/recall-shadow/${month.getFullYear()}-${pad2(month.getMonth() + 1)}.jsonl`;
  const older = {
    id: 'r-1-aaaa', at: now - 120000, key: KEY, reason: 'private', mode: 'shadow',
    msgs: [], skipped: null, tau: 0.55, ms: 9, candidates: [], inject: []
  };
  const newer = {
    id: 'r-2-bbbb', at: now - 60000, key: KEY, reason: 'private', mode: 'shadow',
    msgs: [], skipped: 'trivial', tau: 0.6, ms: 5, candidates: [], inject: []
  };
  const h = await bridgeHarness({ files: { [monthRel]: `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n` } });
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/ltm/recall-shadow');
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(r.json.entries.map((e) => e.id), ['r-2-bbbb', 'r-1-aaaa'], '按时间倒序');
      assert.equal(r.json.config.tau, 0.6, '取最新一条的 tau');
      assert.equal(r.json.config.mode, 'shadow', 'config 的其它字段不变');
    });
  } finally { await h.close(); }

  const empty = await bridgeHarness();
  try {
    await withServer(empty, async (port) => {
      const r = await call(port, '/api/ltm/recall-shadow');
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(r.json.entries, []);
      assert.equal(r.json.config.tau, null, '没有日志时 tau 为 null');
    });
  } finally { await empty.close(); }
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
