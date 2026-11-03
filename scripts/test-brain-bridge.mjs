// 实时脑图（BRAIN_PATCH）：桥接接线测试（走 audit-bridge-harness，临时目录 + 夹具令牌）。
//
// 不碰真实 state/、不联网：memory-rag 一律是本进程起的假服务（随机回环端口）或一个没人监听的端口。
//
// 覆盖：各新路由要控制台令牌、agent 调用被拒；快照形状（含 rag 关着 / 不可用时降级）；
// SSE 收到 hello 和一条真实挂点产生的事件；history-search 给 AI 的响应在有页面连着 / 没连着 / 开关关着时逐字节相同；
// probe 不产生复习记录、2 秒限流；开关关掉后 /brain 404、SSE 断开、挂点不写轨迹，打开后恢复；
// decay-curve 366 个点、R 单调不增；唤醒的 wake / inject 事件；回放路由接线。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createLifeLoop } from '../src/life-loop.js';
import { createLedgerSuggest } from '../src/ledger-suggest.js';
import { createLongMemory } from '../src/long-memory.js';

const TOKEN = 'fixture-console-token';
const CONSOLE = { 'x-console-token': TOKEN };
const OWNER = '123';
const KEY = `private:${OWNER}`;

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
function peopleFixture() {
  return {
    'state/long-memory/people.json': JSON.stringify({
      version: 1,
      people: {
        [OWNER]: {
          name: '主人', names: ['主人'], firstSeenAt: nowIso(), lastSeenAt: nowIso(), messages: 3,
          items: [
            { id: 'aa11', cat: 'fact', text: '他养了一只橘猫叫团子', at: nowIso(), sourceKey: KEY, scope: 'private' },
            { id: 'bb22', cat: 'trait', text: '他不吃香菜', at: nowIso(), sourceKey: KEY, scope: 'private', core: true }
          ]
        }
      }
    })
  };
}
const archiveRow = (text, { dir = 'in', msgId = null } = {}) =>
  JSON.stringify({ t: nowIso(), dir, userId: dir === 'in' ? OWNER : null, name: dir === 'in' ? '主人' : '', text, msgId });
function archiveFixture() {
  const d = new Date();
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return {
    [`state/long-memory/archive/private_${OWNER}/${month}.jsonl`]: [
      archiveRow('我们周末去吃了重庆火锅，特别辣但是很好吃', { msgId: 'm1' }),
      archiveRow('好呀下次还去', { dir: 'out' }),
      archiveRow('火锅店在解放碑旁边那条街上，排了很久的队', { msgId: 'm2' })
    ].join('\n') + '\n'
  };
}
const diaryFixture = () => ({
  'state/diary/index.jsonl': JSON.stringify({ t: 1762070400000, title: '下雨天', mood: '平静', text: '今天下了一整天的雨。'.repeat(20) }) + '\n'
});
// harness 的 ROOT 是临时目录：放一份最小的页面（真页面由 worker C 维护，这里只测桥接把它送出去）。
const pageFixture = () => ({ 'public/brain.html': '<!doctype html><meta charset="utf-8"><title>脑图夹具</title>' });
const fixtures = () => ({ ...peopleFixture(), ...archiveFixture(), ...diaryFixture(), ...pageFixture() });

function replyJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}
/** 本地假 memory-rag：/search（带 debug 时多给 ranked / routes）、/graph、/chunk、/health。 */
async function startRagServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      requests.push({ method: req.method, path: req.url, body });
      if (req.url === '/search') {
        const out = {
          key: body.key, semantic: 'ok', tokens: ['火锅'],
          items: [{ day: '2026-10-26', title: '周末火锅', sources: ['vector', 'bm25'], text: '10-26 20:01 主人：我们周末去吃了重庆火锅\n10-26 20:02 我：好呀', file: `/home/x/state/long-memory/archive/private_${OWNER}/2026-10.jsonl`, line_start: 1, file_end: `/home/x/private_${OWNER}/2026-10.jsonl`, line_end: 2, ids: ['c1'], score: 0.9 }]
        };
        if (body.debug) {
          out.ranked = [{ id: 'c1', score: 0.03, sources: ['vector', 'bm25'], core: { file: '/home/x/a.jsonl', line_start: 1 } }, { id: 'pending:3', score: 0.01, sources: ['pending'] }];
          out.routes = { vector: 1, bm25: 1, pending: 1, summary: 0, graph: 0 };
        }
        replyJson(res, 200, out);
        return;
      }
      if (req.url === '/graph') {
        replyJson(res, 200, {
          ok: true,
          chunks: [{ chunk_id: 'c1', key: KEY, day: '2026-10-26', t_start: 1, t_end: 2, title: '周末火锅', n_msgs: 2, speakers: [OWNER], speaker_names: ['主人'], text: '不该出现的块原文' }],
          summaries: [{ summary_id: 's1', chunk_id: 'c1', key: KEY, day: '2026-10-26', t_start: 1, t_end: 2, title: '周末火锅', summary: '主人周末去吃了重庆火锅', importance: 0.6, valence: 0.5 }],
          entities: [{ entity_id: 'e1', type: 'place', name: '解放碑', qq: null, n: 1 }, { entity_id: 'e2', type: 'thing', name: '火锅', qq: null, n: 1 }],
          summary_entities: [{ summary_id: 's1', entity_id: 'e1', key: KEY }],
          relations: [{ summary_id: 's1', key: KEY, src_id: 'e1', dst_id: 'e2', relation: '附近' }],
          notes: [{ note_id: 'n1', summary_id: 's1', key: KEY, who: OWNER, who_name: '主人', cat: 'fact', text: '主人喜欢吃辣', due: null, created_at: 3 }],
          truncated: { chunks: 0, summaries: 0, entities: 0, notes: 0 }
        });
        return;
      }
      if (req.url === '/chunk') {
        if (body.key !== KEY || body.chunk_id !== 'c1') { replyJson(res, 404, { ok: false }); return; }
        replyJson(res, 200, { ok: true, chunk_id: 'c1', key: KEY, day: '2026-10-26', title: '周末火锅', t_start: 1, t_end: 2, n_msgs: 2, text: '10-26 20:01 主人：我们周末去吃了重庆火锅' });
        return;
      }
      if (req.url === '/health') { replyJson(res, 200, { ok: true, store: { chunks: 1 }, distill: { summaries: 1 } }); return; }
      replyJson(res, 404, { ok: false });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests,
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  };
}
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

function call(port, pathname, { method = 'GET', headers = CONSOLE, body } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (response) => {
      let data = '';
      response.on('data', (c) => { data += c; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, json, body: data });
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** 真 HTTP 的 SSE 客户端：收到的原文累积在 text 里；waitFor(pred) 等到满足为止。 */
function openSse(port, query = '') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/brain/events?token=${TOKEN}${query}` }, (res) => {
      const conn = { res, req, status: res.statusCode, headers: res.headers, text: '', ended: false };
      const waiters = [];
      res.setEncoding('utf8');
      res.on('data', (c) => { conn.text += c; for (const w of [...waiters]) if (w.pred(conn.text)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } });
      res.on('end', () => { conn.ended = true; for (const w of waiters) w.resolve(); });
      res.on('close', () => { conn.ended = true; for (const w of waiters) w.resolve(); });
      conn.waitFor = (pred, ms = 3000) => new Promise((ok, fail) => {
        if (pred(conn.text) || conn.ended) { ok(); return; }
        const timer = setTimeout(() => fail(new Error(`SSE 等待超时：${conn.text.slice(-300)}`)), ms);
        waiters.push({ pred, resolve: () => { clearTimeout(timer); ok(); } });
      });
      conn.events = () => conn.text.split('\n\n').filter((b) => b.includes('event: brain'))
        .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
      conn.close = () => { try { req.destroy(); } catch {} };
      resolve(conn);
    });
    req.on('error', reject);
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try { await run(server.address().port); }
  finally {
    h.getBrainFeed()?.closeAll();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** 直接挂一个假页面（不走 HTTP）：让 feed.active() 为真，好看缓冲里的事件。 */
function fakePage(feed) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writeHead = () => {}; res.write = () => true; res.end = () => {};
  feed.handleEvents(req, res);
  return { close: () => req.emit('close') };
}

const traceRows = (h) => {
  const dir = path.join(h.temp, 'state', 'brain', 'trace');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};

const ROUTES = [
  ['GET', '/brain'], ['GET', '/api/brain/control'], ['POST', '/api/brain/control'], ['GET', '/api/brain/snapshot'],
  ['GET', '/api/brain/events'], ['POST', '/api/brain/chunk'], ['POST', '/api/brain/probe'],
  ['GET', '/api/brain/replay?day=2026-11-03'], ['GET', '/api/brain/decay-curve?unit=ltm:aa11']
];

// ── 鉴权 ──────────────────────────────────────────────────────────────────
await test('鉴权：没令牌 401；agent 令牌 / 智能体调用头一律 403（开关接口也一样）', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    await withServer(h, async (port) => {
      for (const [method, p] of ROUTES) {
        const body = method === 'POST' ? { enabled: true } : undefined;
        const anon = await call(port, p, { method, headers: {}, body });
        assert.equal(anon.status, 401, `${method} ${p} 无令牌：${anon.status}`);
        const agent = await call(port, p, { method, headers: { ...CONSOLE, 'x-agent-token': 'whatever' }, body });
        assert.equal(agent.status, 403, `${method} ${p} agent 令牌：${agent.status}`);
        const agentCall = await call(port, p, { method, headers: { ...CONSOLE, 'x-agent-call': '1' }, body });
        assert.equal(agentCall.status, 403, `${method} ${p} 智能体调用：${agentCall.status}`);
      }
      const page = await call(port, '/brain');
      assert.equal(page.status, 200);
      assert.ok(page.body.includes('脑图夹具'));
      assert.ok(String(page.headers['content-type']).startsWith('text/html'));
      assert.equal(page.headers['content-security-policy'], "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
      assert.equal(page.headers['x-frame-options'], 'DENY');
    });
  } finally { await h.close(); }
});

// ── 快照 ──────────────────────────────────────────────────────────────────
await test('快照：rag 关着只有 ltm / diary（rag:off）；字段形状照约定 §5.4', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/brain/snapshot');
      assert.equal(r.status, 200, r.body);
      const s = r.json;
      assert.equal(s.ok, true);
      assert.equal(s.rag, 'off');
      assert.equal(typeof s.at, 'number');
      assert.equal(s.freezeBelow, 0.5);
      assert.deepEqual(Object.keys(s.truncated).sort(), ['chunk', 'diary', 'ent', 'ltm', 'note', 'sum']);
      assert.deepEqual(Object.keys(s.regions).length, 13);
      assert.ok(s.keys.some((k) => k.key === KEY && k.kind === 'private' && k.label.includes('主人')), JSON.stringify(s.keys));
      const ltmNode = s.nodes.find((n) => n.id === 'ltm:aa11');
      assert.ok(ltmNode, '账本条目成光点');
      for (const f of ['kind', 'key', 'at', 'label', 'text', 'cat', 'userId', 'name', 'scope', 'core', 'due', 'status', 'archivedAt', 'outdatedAt', 'decay']) assert.ok(f in ltmNode, `ltm 缺 ${f}`);
      assert.equal(ltmNode.key, KEY);
      assert.ok(ltmNode.decay && typeof ltmNode.decay.R === 'number');
      assert.equal(s.nodes.find((n) => n.id === 'ltm:bb22').decay.exempt, true);
      const diary = s.nodes.find((n) => n.kind === 'diary');
      assert.equal(diary.id, 'diary:1762070400000');
      assert.equal([...diary.excerpt].length, 120);
      assert.ok(!s.nodes.some((n) => ['chunk', 'sum', 'ent', 'note'].includes(n.kind)));
      const bad = await call(port, '/api/brain/snapshot?key=evil');
      assert.equal(bad.status, 400);
    });
  } finally { await h.close(); }
});

await test('快照：rag 开着取 /graph（块不带原文、连线四类）；rag 不可达 → unavailable', async () => {
  const rag = await startRagServer();
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const s = (await call(port, '/api/brain/snapshot')).json;
      assert.equal(s.rag, 'ok');
      const chunk = s.nodes.find((n) => n.id === 'chunk:c1');
      assert.deepEqual(chunk.speakers, ['主人']);
      assert.ok(!JSON.stringify(s).includes('不该出现的块原文'), '快照里没有块原文');
      assert.equal(s.nodes.find((n) => n.id === 'sum:s1').chunk, 'chunk:c1');
      assert.equal(s.nodes.find((n) => n.id === 'note:n1').state, 'pending');
      assert.ok(s.nodes.find((n) => n.id === 'ent:e1'));
      assert.deepEqual([...new Set(s.links.map((l) => l.kind))].sort(), ['note-sum', 'rel', 'sum-chunk', 'sum-ent']);
      assert.equal(s.links.find((l) => l.kind === 'rel').relation, '附近');
      const g = rag.requests.find((x) => x.path === '/graph');
      assert.deepEqual(g.body, { keys: null, limit: 2000 });
      await call(port, `/api/brain/snapshot?key=${KEY}`);
      assert.deepEqual(rag.requests.filter((x) => x.path === '/graph').at(-1).body.keys, [KEY]);
    });
  } finally { await h.close(); await rag.close(); }

  const port = await freePort();
  const h2 = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}` } }, files: fixtures() });
  try {
    await withServer(h2, async (p) => {
      const s = (await call(p, '/api/brain/snapshot')).json;
      assert.equal(s.rag, 'unavailable');
      assert.ok(s.nodes.some((n) => n.kind === 'ltm'));
    });
  } finally { await h2.close(); }
});

// ── SSE ───────────────────────────────────────────────────────────────────
await test('SSE：收到 retry / hello，调一次 ltm-remember 收到带原文的 remember 事件（轨迹里没有原文）', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const sse = await openSse(port);
      assert.equal(sse.status, 200);
      assert.ok(String(sse.headers['content-type']).startsWith('text/event-stream'));
      assert.equal(sse.headers['cache-control'], 'no-cache, no-transform');
      await sse.waitFor((t) => t.includes('event: hello'));
      assert.ok(sse.text.startsWith('retry: 3000\n\n'));
      const r = await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: { key: KEY, category: 'fact', content: '他周末喜欢去爬山' } });
      assert.equal(r.status, 200, r.body);
      await sse.waitFor((t) => t.includes('"type":"remember"'));
      const ev = sse.events().find((e) => e.type === 'remember');
      assert.equal(ev.key, KEY);
      assert.equal(ev.origin, 'ai');
      assert.equal(ev.region, 'hippo');
      assert.equal(ev.data.text, '他周末喜欢去爬山');
      assert.deepEqual(ev.nodes, [`ltm:${r.json.item.id}`]);
      const rows = traceRows(h);
      assert.ok(rows.some((x) => x.type === 'remember' && x.nodes[0] === `ltm:${r.json.item.id}`));
      assert.ok(!JSON.stringify(rows).includes('爬山'));
      // 第 5 个连接 429
      const more = [await openSse(port), await openSse(port), await openSse(port)];
      const fifth = await openSse(port);
      assert.equal(fifth.status, 429);
      for (const c of [sse, ...more, fifth]) c.close();
    });
  } finally { await h.close(); }
});

// ── history-search 逐字节不变 ─────────────────────────────────────────────
async function historyBodies(config) {
  const out = {};
  for (const mode of ['nopage', 'page', 'off']) {
    const h = await bridgeHarness({ config: { ...config, ...(mode === 'off' ? { brain: { enabled: false } } : {}) }, files: fixtures() });
    try {
      await withServer(h, async (port) => {
        const page = mode === 'page' ? await openSse(port) : null;
        if (page) await page.waitFor((t) => t.includes('event: hello'));
        const bodies = [];
        for (const body of [
          { key: KEY, query: '那次一起吃火锅', keywords: ['火锅', '重庆'] },
          { key: KEY, query: '火锅店在哪', mode: 'keyword' },
          { key: KEY, from: '今天' }
        ]) {
          const r = await call(port, '/api/socialV2/history-search', { method: 'POST', body });
          assert.equal(r.status, 200, r.body);
          bodies.push(r.body);
        }
        if (page) {
          await page.waitFor((t) => (t.match(/"type":"search"/g) ?? []).length >= 3);
          const searches = page.events().filter((e) => e.type === 'search');
          out.events = searches;
          page.close();
        }
        out[mode] = bodies;
      });
    } finally { await h.close(); }
  }
  return out;
}

await test('history-search：给 AI 的响应在页面连着 / 没连着 / 开关关着时逐字节相同（rag 路与关键词路）', async () => {
  const rag = await startRagServer();
  try {
    const r = await historyBodies({ memoryRag: { url: rag.url } });
    assert.deepEqual(r.page, r.nopage);
    assert.deepEqual(r.off, r.nopage);
    const first = JSON.parse(r.nopage[0]);
    assert.equal(first.source, 'rag');
    assert.deepEqual(Object.keys(first.items[0]).sort(), ['day', 'sources', 'text', 'title']);
    assert.ok(!r.nopage[0].includes('ranked') && !r.nopage[0].includes('routes'), '不带五路名次');
    // 页面收到的事件：五路名次、块编号、命中行
    const ev = r.events[0];
    assert.equal(ev.data.source, 'rag');
    assert.deepEqual(ev.nodes, ['chunk:c1']);
    assert.equal(ev.data.items[0].node, 'chunk:c1');
    assert.ok(ev.data.items[0].line.includes('火锅'));
    assert.deepEqual(ev.data.ranked, [{ node: 'chunk:c1', score: 0.03, sources: ['vector', 'bm25'] }]);
    assert.equal(ev.data.routes.vector, 1);
    assert.equal(ev.data.query, '那次一起吃火锅');
    assert.ok(!JSON.stringify(ev).includes('/home/'), '事件里不带存档路径');
    assert.equal(r.events[1].data.source, 'keyword');
    // 开关开着时才带 debug；关着时请求体与改动前一样
    const searches = rag.requests.filter((x) => x.path === '/search');
    assert.ok(searches.some((x) => x.body.debug === true));
    assert.ok(searches.some((x) => !('debug' in x.body)), '开关关着那一轮不带 debug');
  } finally { await rag.close(); }
});

// ── probe ─────────────────────────────────────────────────────────────────
await test('probe：不记复习（memory-decay.json 不变）、发 origin:console 的 search 事件、2 秒限流、rag 关着退回关键词', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const feed = h.getBrainFeed();
      const page = fakePage(feed);
      const decayFile = path.join(h.temp, 'state', 'memory-decay.json');
      const before = fs.existsSync(decayFile) ? fs.readFileSync(decayFile, 'utf8') : null;
      const r = await call(port, '/api/brain/probe', { method: 'POST', body: { key: KEY, query: '火锅', keywords: ['火锅'] } });
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.source, 'keyword');
      assert.equal(r.json.semantic, 'off');
      assert.ok(r.json.items.length >= 1 && r.json.items[0].line.includes('火锅'));
      assert.deepEqual(r.json.ranked, []);
      assert.deepEqual(r.json.routes, {});
      const after = fs.existsSync(decayFile) ? fs.readFileSync(decayFile, 'utf8') : null;
      assert.equal(after, before, 'probe 不产生复习记录');
      const ev = feed.bufferedEvents().filter((e) => e.type === 'search');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].origin, 'console');
      const again = await call(port, '/api/brain/probe', { method: 'POST', body: { key: KEY, query: '火锅' } });
      assert.equal(again.status, 429);
      // 对照：同样的查询走 AI 的 history-search（主人私聊）会记复习
      await call(port, '/api/socialV2/history-search', { method: 'POST', body: { key: KEY, query: '火锅', mode: 'keyword' } });
      assert.ok(fs.existsSync(decayFile), '对照组：history-search 会写复习记录');
      page.close();
    });
  } finally { await h.close(); }
});

await test('probe（rag 开着）：带 debug 跑真实检索，返回五路名次', async () => {
  const rag = await startRagServer();
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/brain/probe', { method: 'POST', body: { key: KEY, query: '火锅' } });
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.source, 'rag');
      assert.equal(r.json.ranked[0].node, 'chunk:c1');
      assert.equal(rag.requests.find((x) => x.path === '/search').body.debug, true);
      assert.ok(!fs.existsSync(path.join(h.temp, 'state', 'memory-decay.json')));
      const chunk = await call(port, '/api/brain/chunk', { method: 'POST', body: { node: 'chunk:c1', key: KEY } });
      assert.equal(chunk.status, 200, chunk.body);
      assert.equal(chunk.json.text, '10-26 20:01 主人：我们周末去吃了重庆火锅');
      const miss = await call(port, '/api/brain/chunk', { method: 'POST', body: { node: 'chunk:c1', key: 'private:999' } });
      assert.equal(miss.status, 404);
      assert.equal(miss.json.ok, false);
    });
  } finally { await h.close(); await rag.close(); }
});

// ── 开关 ──────────────────────────────────────────────────────────────────
await test('开关：关掉后 /brain 404、SSE 断开、挂点不写轨迹；config.json 只改 brain.enabled 且 600；打开后恢复', async () => {
  const h = await bridgeHarness({ config: { someUnknown: { keep: 1 } }, files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const sse = await openSse(port);
      await sse.waitFor((t) => t.includes('event: hello'));
      const off = await call(port, '/api/brain/control', { method: 'POST', body: { enabled: false } });
      assert.deepEqual(off.json, { ok: true, enabled: false });
      await sse.waitFor(() => false, 3000).catch(() => {});
      assert.equal(sse.ended, true, 'SSE 立刻断开');
      const cfgFile = path.join(h.temp, 'config.json');
      const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      assert.deepEqual(saved.brain, { enabled: false });
      assert.deepEqual(saved.someUnknown, { keep: 1 }, '其它字段原样保留');
      assert.equal(saved.consoleToken, TOKEN);
      assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);
      assert.equal((await call(port, '/brain')).status, 404);
      assert.equal((await call(port, '/api/brain/snapshot')).status, 404);
      assert.equal((await call(port, '/api/brain/events')).status, 404);
      assert.deepEqual((await call(port, '/api/brain/control')).json, { ok: true, enabled: false });
      const before = traceRows(h).length;
      const r = await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: { key: KEY, category: 'fact', content: '关着时记的事' } });
      assert.equal(r.status, 200);
      assert.equal(traceRows(h).length, before, '关着时挂点不写轨迹');
      const bad = await call(port, '/api/brain/control', { method: 'POST', body: { enabled: 'yes' } });
      assert.equal(bad.status, 400);
      const on = await call(port, '/api/brain/control', { method: 'POST', body: { enabled: true } });
      assert.deepEqual(on.json, { ok: true, enabled: true });
      assert.equal((await call(port, '/brain')).status, 200);
      await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: { key: KEY, category: 'fact', content: '打开后记的事' } });
      assert.equal(traceRows(h).length, before + 1, '打开后恢复写轨迹');
    });
  } finally { await h.close(); }
});

await test('开关：手改 config.json（不走接口）2 秒内生效，不用重启', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    await withServer(h, async (port) => {
      assert.equal((await call(port, '/brain')).status, 200);
      const cfgFile = path.join(h.temp, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, brain: { enabled: false } }));
      await new Promise((r) => setTimeout(r, 2100));
      assert.equal((await call(port, '/brain')).status, 404);
    });
  } finally { await h.close(); }
});

// ── decay-curve ───────────────────────────────────────────────────────────
await test('decay-curve：366 个点、R 单调不增；不存在的单元 404', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/brain/decay-curve?unit=ltm:aa11');
      assert.equal(r.status, 200, r.body);
      const c = r.json;
      assert.equal(c.ok, true);
      assert.equal(c.unit, 'ltm:aa11');
      assert.equal(c.points.length, 366);
      assert.deepEqual(c.points.map((p) => p.day), Array.from({ length: 366 }, (_, i) => i));
      for (let i = 1; i < 366; i += 1) assert.ok(c.points[i].R <= c.points[i - 1].R, `第 ${i} 天变大了`);
      assert.equal(c.R0, 1, '没有复习记录 → R0 = 1');
      assert.equal(c.freezeBelow, 0.5);
      assert.equal(c.exempt, false);
      assert.ok(Number.isInteger(c.frozenAtDay));
      for (const f of ['S', 'D']) assert.equal(typeof c[f], 'number');
      const core = (await call(port, '/api/brain/decay-curve?unit=ltm:bb22')).json;
      assert.equal(core.exempt, true);
      assert.equal(core.frozenAtDay, null);
      assert.equal((await call(port, '/api/brain/decay-curve?unit=ltm:nope')).status, 404);
      assert.equal((await call(port, '/api/brain/decay-curve?unit=junk')).status, 404);
    });
  } finally { await h.close(); }
});

// ── 唤醒 / 注入 / 工具 / 回放 ──────────────────────────────────────────────
await test('唤醒：投递被接受后发 wake（reason=message）与 inject（注入的账本编号），不带提示词原文', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    const feed = h.getBrainFeed();
    const page = fakePage(feed);
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '主人', '在吗', '在吗', false, true, 'w1', [], OWNER);
    const r = await h.deliverPrompt(KEY, '在吗', { wakeReason: 'private' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const evs = feed.bufferedEvents();
    const wake = evs.find((e) => e.type === 'wake');
    assert.ok(wake, JSON.stringify(evs.map((e) => e.type)));
    assert.deepEqual(wake.data, { reason: 'message' });
    const inject = evs.find((e) => e.type === 'inject');
    assert.ok(inject);
    assert.deepEqual(inject.nodes.sort(), ['ltm:aa11', 'ltm:bb22']);
    assert.equal(inject.data.recall, false);
    assert.ok(inject.data.chars > 0);
    assert.ok(!JSON.stringify(evs).includes('【会话令牌】'), '不带提示词');
    const rows = traceRows(h);
    assert.ok(rows.some((x) => x.type === 'wake' && x.e?.reason === 'message'));
    assert.ok(rows.some((x) => x.type === 'inject' && x.nodes.length === 2));
    page.close();
  } finally { await h.close(); }
});

await test('回放路由：只认最近 7 天（含今天）；今天的回放走 R 的模块，形状 { ok, day, partial, notes, events }', async () => {
  const h = await bridgeHarness({ files: fixtures() });
  try {
    await withServer(h, async (port) => {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      const old = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
      const oldDay = `${old.getFullYear()}-${p2(old.getMonth() + 1)}-${p2(old.getDate())}`;
      assert.equal((await call(port, `/api/brain/replay?day=${oldDay}`)).status, 400);
      assert.equal((await call(port, '/api/brain/replay?day=2026-13-40')).status, 400);
      assert.equal((await call(port, `/api/brain/replay?day=${today}&key=evil`)).status, 400);
      const r = await call(port, `/api/brain/replay?day=${today}&key=${KEY}`);
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.day, today);
      assert.equal(typeof r.json.partial, 'boolean');
      assert.ok(Array.isArray(r.json.notes));
      assert.ok(Array.isArray(r.json.events));
      assert.ok(r.json.events.every((e) => e.replay === true && /^r\d+$/.test(String(e.id))));
    });
  } finally { await h.close(); }
});

await test('createBrainFeed 构造时抛异常 → 桥接照常启动、记账本照常、脑图接口 503（开关接口仍可用）', async () => {
  const h = await bridgeHarness({ files: fixtures(), globals: { createBrainFeed: () => { throw new Error('boom'); } } });
  try {
    assert.equal(h.getBrainFeed(), null);
    await withServer(h, async (port) => {
      const r = await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: { key: KEY, category: 'fact', content: '照常能记' } });
      assert.equal(r.status, 200, r.body);
      assert.equal((await call(port, '/api/brain/snapshot')).status, 503);
      assert.equal((await call(port, '/api/brain/control')).status, 200);
    });
  } finally { await h.close(); }
});

// ── 回调挂点（约定 §8）：缺省不调；回调抛错不影响原逻辑 ─────────────────────
await test('life-loop / ledger-suggest 的 onEvent：照常产出事件；回调抛错时返回值不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-brain-cb-'));
  try {
    const ltm = createLongMemory({ stateDir: path.join(dir, 'ltm') });
    const seen = [];
    const mkLoop = (onEvent) => createLifeLoop({ ltm, statePath: path.join(dir, `life-${seen.length}-${Math.random()}.json`), ownerQQ: () => OWNER, deliverPromiseWake: async () => {}, rng: () => 0.99, onEvent });
    const a = mkLoop((type, p) => seen.push([type, p]));
    const b = mkLoop(() => { throw new Error('脑图坏了'); });
    const c = mkLoop(undefined);
    const args = { kind: 'day', now: Date.now(), remainingSlots: 3 };
    const ra = a.composeOwnLife(args);
    assert.equal(b.composeOwnLife(args), ra);
    assert.equal(c.composeOwnLife(args), ra);
    assert.equal(seen[0][0], 'life.ownLife');
    assert.equal(seen[0][1].key, KEY);
    assert.deepEqual(seen[0][1].data, { kind: 'day', remainingSlots: 3 });

    const note = { note_id: 'a1b2c3d4e5f60718', summary_id: 's1', day: '2026-11-01', t_end: Date.now(), who: OWNER, who_name: '主人', cat: 'fact', text: '主人喜欢吃辣', due: null, importance: 0.5, created_at: Date.now(), source: 'distill' };
    const rag = { notes: async () => ({ key: KEY, items: [note] }) };
    const events = [];
    const s1 = createLedgerSuggest({ rag, ltm, statePath: path.join(dir, 's1.json'), onEvent: (t, p) => events.push([t, p]) });
    const s2 = createLedgerSuggest({ rag, ltm, statePath: path.join(dir, 's2.json'), onEvent: () => { throw new Error('x'); } });
    const p1 = await s1.plan(KEY);
    const p2 = await s2.plan(KEY);
    assert.deepEqual(p1, p2);
    s1.markShown(KEY, p1.ids);
    s2.markShown(KEY, p2.ids);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 's1.json'), 'utf8')).items[note.note_id].shown, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 's2.json'), 'utf8')).items[note.note_id].shown, 1);
    assert.equal(events[0][0], 'suggest.shown');
    assert.deepEqual(events[0][1].nodes, [`note:${note.note_id}`]);
    assert.deepEqual(events[0][1].data().items, [{ node: `note:${note.note_id}`, text: '主人喜欢吃辣' }]);
    const r = ltm.remember({ userId: OWNER, cat: 'fact', text: '主人喜欢吃辣', sourceKey: KEY });
    s1.onRemember(KEY, OWNER, r.item.id);
    assert.equal(events[1][0], 'suggest.adopted');
    assert.deepEqual(events[1][1].data, { node: `note:${note.note_id}`, ltm: `ltm:${r.item.id}` });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
