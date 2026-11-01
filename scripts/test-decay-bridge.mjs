// 记忆代谢（子项目 2）第二批：桥接接线 + AI 工具参数 + 「检索命中算费劲想起」的测试。
// DECAY_PATCH
//
// 用 audit-bridge-harness 在临时目录里跑真实的 bridge.js：不碰真实 state/，不联网
// （memory-rag 一律指向本地假服务或一个没人监听的端口），不启任何线上服务。
//
// 覆盖：
//   ① 启动时创建遗忘模块；没有复习时不写状态文件
//   ② ltm-remember 的 replaces / similar 提示；唤醒提示不再带已过时的条目
//   ③ ltm-update / outdated / ltm-forget 的复习与删除
//   ④ ltm-recall 的 memory 标签、query 命中复习（最多 5 条）
//   ⑤ history-search：只在主人私聊里按存档命复习（关键词路 + memory-rag 路），响应逐字不变
//   ⑥ 控制台 /api/ltm/person、/api/ltm/review、/api/memory-decay，以及 agent 令牌被拒
//   ⑦ 唤醒提示的 replaces 用法句
//   ⑧ 遗忘模块写不进去时工具调用照常成功
//   ⑨ MCP 工具的三个新参数（schema + 透传）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { linkDir } from './test-links.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const OWNER = '123';
const KEY = `private:${OWNER}`;
const DAY = 86400000;

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

/** 一个人的账本；条目字段与 long-memory.js 落盘的一致。 */
function peopleFixture(people) {
  const out = {};
  for (const [id, entry] of Object.entries(people)) {
    out[id] = { name: '', names: [], items: [], firstSeenAt: daysAgo(30), lastSeenAt: daysAgo(0), messages: 1, ...entry };
  }
  return { 'state/long-memory/people.json': JSON.stringify({ version: 1, people: out }) };
}

const ltmItem = (id, text, { cat = 'fact', at = daysAgo(0), sourceKey = 'private:456', scope = 'private', extra = {} } = {}) =>
  ({ id, cat, text, at, sourceKey, scope, ...extra });

const archiveRow = (iso, text, { dir = 'in', userId = OWNER, name = '主人', msgId = null } = {}) =>
  JSON.stringify({ t: iso, dir, userId, name, text, msgId });

const archiveFile = (key, rows) => ({
  [`state/long-memory/archive/${key.replace(':', '_')}/2026-10.jsonl`]: rows.join('\n') + '\n'
});

/** 读遗忘状态文件；不存在返回 null。 */
function decayUnits(h) {
  const file = path.join(h.temp, 'state/memory-decay.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).units ?? {};
}

const unitIds = (h, prefix) => Object.keys(decayUnits(h) ?? {}).filter((id) => id.startsWith(prefix));

function replyJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
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

/** 一个没人监听的端口：memory-rag 连接会被立刻拒绝，走关键词降级。 */
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

// ── ① 启动与「不复习就不写盘」 ─────────────────────────────────────────────
await test('启动：遗忘模块已创建；没有任何复习时 state/memory-decay.json 不存在', async () => {
  const h = await bridgeHarness();
  try {
    assert.ok(h.getDecay(), 'getDecay() 应该拿到实例');
    assert.equal(h.getDecay().snapshot().units, 0);
    assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-decay.json')), false);
  } finally { await h.close(); }
});

// ── ② replaces / similar / 唤醒提示 ────────────────────────────────────────
await test('replaces：旧条目标成过时、响应带 replaced、唤醒提示不再带旧内容', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const oldRes = await call(port, '/api/socialV2/ltm-remember', {
        method: 'POST', body: { key: KEY, category: 'fact', content: '他以前在银行做柜员' }
      });
      assert.equal(oldRes.status, 200, oldRes.body);
      const oldId = oldRes.json.item.id;

      const newRes = await call(port, '/api/socialV2/ltm-remember', {
        method: 'POST', body: { key: KEY, category: 'fact', content: '他现在在一家设计公司上班', replaces: oldId }
      });
      assert.equal(newRes.status, 200, newRes.body);
      assert.deepEqual(newRes.json.replaced, { id: oldId }, '响应要带被替换的旧条目编号');
      assert.notEqual(newRes.json.item.id, oldId);

      const person = await call(port, `/api/ltm/person?userId=${OWNER}`);
      const oldItem = person.json.person.items.find((x) => x.id === oldId);
      assert.ok(oldItem.outdatedAt, '旧条目要被标成过时');
      assert.equal(oldItem.outdatedBy, newRes.json.item.id);
    });

    const prompt = h.buildWakePromptV2(KEY, 'timeout');
    assert.ok(prompt.includes('他现在在一家设计公司上班'), '唤醒提示要带新条目');
    assert.ok(!prompt.includes('他以前在银行做柜员'), '已过时的条目不该再注入');
  } finally { await h.close(); }
});

await test('similar：记一条和已有的很像 → 给 similar 与 outdated=true 提示；重复记同一条 → 复习一次', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const first = await call(port, '/api/socialV2/ltm-remember', {
        method: 'POST', body: { key: KEY, category: 'fact', content: '他养了一只橘猫叫团子' }
      });
      assert.equal(first.status, 200, first.body);

      const second = await call(port, '/api/socialV2/ltm-remember', {
        method: 'POST', body: { key: KEY, category: 'fact', content: '她养的那只橘猫叫团子' }
      });
      assert.equal(second.status, 200, second.body);
      assert.ok(Array.isArray(second.json.similar) && second.json.similar.length >= 1, `应有相似提示：${second.body}`);
      assert.equal(second.json.similar[0].id, first.json.item.id);
      assert.ok(second.json.hint.includes('outdated=true'), second.json.hint);
      assert.ok(second.json.hint.includes(`〔${first.json.item.id}〕`), second.json.hint);

      const dup = await call(port, '/api/socialV2/ltm-remember', {
        method: 'POST', body: { key: KEY, category: 'fact', content: '他养了一只橘猫叫团子' }
      });
      assert.equal(dup.status, 200, dup.body);
      assert.equal(dup.json.duplicate, true);

      const units = decayUnits(h);
      assert.ok(units, '复习之后状态文件应写出来');
      const rec = units[`ltm:${first.json.item.id}`];
      assert.ok(rec, `应出现 ltm:${first.json.item.id}`);
      assert.equal(rec.reps, 1, '没有复习记录时第一次想起就是 1');
    });
  } finally { await h.close(); }
});

// ── ③ update / outdated / forget ──────────────────────────────────────────
await test('update 改内容 → 复习 1 次；标过时 → 不复习；forget → 删除记录', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const add = await call(port, '/api/socialV2/ltm-remember', {
        method: 'POST', body: { key: KEY, category: 'fact', content: '他住在城南' }
      });
      const id = add.json.item.id;

      const upd = await call(port, '/api/socialV2/ltm-update', {
        method: 'POST', body: { key: KEY, itemId: id, content: '他搬到了城北' }
      });
      assert.equal(upd.status, 200, upd.body);
      assert.equal(decayUnits(h)?.[`ltm:${id}`]?.reps, 1, '改内容算顺利想起一次');

      const outdated = await call(port, '/api/socialV2/ltm-update', {
        method: 'POST', body: { key: KEY, itemId: id, outdated: true }
      });
      assert.equal(outdated.status, 200, outdated.body);
      assert.ok(outdated.json.item.outdatedAt);
      assert.equal(decayUnits(h)?.[`ltm:${id}`]?.reps, 1, '标过时不该复习');

      const gone = await call(port, '/api/socialV2/ltm-forget', { method: 'POST', body: { key: KEY, itemId: id } });
      assert.equal(gone.status, 200, gone.body);
      assert.equal(decayUnits(h)?.[`ltm:${id}`], undefined, '删除后遗忘记录也要删掉');
    });
  } finally { await h.close(); }
});

// ── ④ ltm-recall 的 memory 标签与「费劲想起」 ──────────────────────────────
await test('recall：不带 query 只打标签不复习；带 query 只复习命中的未过时条目（最多 5 条）', async () => {
  const h = await bridgeHarness({
    files: peopleFixture({
      456: {
        items: [
          ltmItem('oldfact001', '他以前在银行做柜员', { at: daysAgo(100), sourceKey: 'private:456' }),
          ltmItem('newfact001', '他最近养了一只橘猫叫团子', { at: daysAgo(0), sourceKey: 'private:456' })
        ]
      }
    })
  });
  try {
    await withServer(h, async (port) => {
      const all = await call(port, '/api/socialV2/ltm-recall', { method: 'POST', body: { key: 'private:456' } });
      assert.equal(all.status, 200, all.body);
      const labels = Object.fromEntries(all.json.person.items.map((it) => [it.id, it.memory]));
      assert.deepEqual(labels, { oldfact001: '已淡忘', newfact001: '清楚' });
      assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-decay.json')), false, '整本翻看不复习');

      const hit = await call(port, '/api/socialV2/ltm-recall', { method: 'POST', body: { key: 'private:456', query: '柜员' } });
      assert.equal(hit.status, 200, hit.body);
      assert.equal(hit.json.query, '柜员');
      assert.equal(hit.json.matched, 1);
      assert.equal(hit.json.person.items.length, 1);
      assert.equal(hit.json.person.items[0].id, 'oldfact001');
      assert.equal(hit.json.person.items[0].memory, '已淡忘', '标签是想起之前的状态');
      assert.ok(hit.json.hint.includes('另有 1 条'), hit.json.hint);
      assert.equal(decayUnits(h)?.['ltm:oldfact001']?.hard, 1, '费劲想起记 hard');

      const again = await call(port, '/api/socialV2/ltm-recall', { method: 'POST', body: { key: 'private:456' } });
      const oldNow = again.json.person.items.find((it) => it.id === 'oldfact001');
      assert.equal(oldNow.memory, '清楚', '查过一次就解冻');

      const miss = await call(port, '/api/socialV2/ltm-recall', { method: 'POST', body: { key: 'private:456', query: '完全不存在zzz' } });
      assert.equal(miss.status, 200, miss.body);
      assert.equal(miss.json.matched, 0);
      assert.deepEqual(miss.json.person.items, []);
      assert.ok(miss.json.hint.includes('不带 query'), miss.json.hint);
    });
  } finally { await h.close(); }

  // 7 条命中只复习 5 条（另放 2 条不相干的，好让「另有 N 条」也算到）
  const many = peopleFixture({
    789: {
      items: [
        ...Array.from({ length: 7 }, (_, i) =>
          ltmItem(`star000${i}`, `星星计划第${i + 1}号文件`, { sourceKey: 'private:789' })),
        ltmItem('other001', '周末要去趟超市', { sourceKey: 'private:789' }),
        ltmItem('other002', '楼下新开了一家面馆', { sourceKey: 'private:789' })
      ]
    }
  });
  const h2 = await bridgeHarness({ files: many });
  try {
    await withServer(h2, async (port) => {
      const r = await call(port, '/api/socialV2/ltm-recall', { method: 'POST', body: { key: 'private:789', query: '星星' } });
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.matched, 7);
      assert.ok(r.json.hint.includes('另有 2 条'), r.json.hint);
      assert.equal(unitIds(h2, 'ltm:').length, 5, `最多复习 5 条，实际 ${unitIds(h2, 'ltm:').length}`);
    });
  } finally { await h2.close(); }
});

// ── ⑤ history-search：只在主人私聊里按命中复习 ─────────────────────────────
const HISTORY_ROWS = [
  archiveRow('2026-10-20T10:00:00.000Z', '今天去看了一场关于星云的电影', { msgId: 'm1' }),
  archiveRow('2026-10-20T10:01:00.000Z', '星云', { msgId: 'm2' }),
  archiveRow('2026-10-20T10:02:00.000Z', '我也觉得星云那部电影很好看', { dir: 'out', userId: null, name: '', msgId: 'm3' }),
  archiveRow('2026-10-21T10:00:00.000Z', '星云计划下周就要开始评审了', { msgId: 'm4' }),
  archiveRow('2026-10-22T10:00:00.000Z', '他说星云的照片拍得很有感觉', { msgId: 'm5' })
];

await test('history-search（关键词路）：主人私聊复习 3 条长消息；别人私聊 / 群聊不复习；响应不含内部字段', async () => {
  const port = await freePort();
  const h = await bridgeHarness({
    config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } },
    files: archiveFile(KEY, HISTORY_ROWS)
  });
  try {
    await withServer(h, async (p) => {
      const res = await call(p, '/api/socialV2/history-search', {
        method: 'POST', body: { key: KEY, query: '星云', mode: 'keyword' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'keyword');
      assert.deepEqual(Object.keys(res.json).sort(), ['key', 'lines', 'matched', 'ok', 'semantic', 'source', 'total']);
      assert.ok(!res.body.includes('hits') && !res.body.includes('refs') && !res.body.includes('.jsonl'), `响应不得带内部字段：${res.body}`);

      const ids = unitIds(h, 'msg:').sort();
      assert.deepEqual(ids, ['msg:m1', 'msg:m4', 'msg:m5'], `只复习 in + ≥12 字的消息：${ids}`);
      for (const id of ids) assert.equal(decayUnits(h)[id].hard, 1);

      // 别人的私聊 / 群聊：即使能查到，也不算她「想起」主人。
      for (const other of ['private:456', 'group:456']) {
        const r = await call(p, '/api/socialV2/history-search', { method: 'POST', body: { key: other, query: '星云', mode: 'keyword' } });
        assert.equal(r.status, 200, r.body);
      }
      assert.deepEqual(unitIds(h, 'msg:').sort(), ['msg:m1', 'msg:m4', 'msg:m5'], '非主人私聊不得新增 msg: 记录');
    });
  } finally { await h.close(); }
});

await test('history-search（memory-rag 路）：按 refs 复习，响应 items 白名单字段不变', async () => {
  const rag = await startRagServer((entry, req, res) => replyJson(res, 200, {
    key: entry.body.key,
    semantic: 'ok',
    items: [{
      day: '2026-10-20', title: '星云电影', sources: ['vector', 'bm25'], text: '2026-10-20 10:00 主人：今天去看了一场关于星云的电影',
      file: 'private_123/2026-10.jsonl', file_end: 'private_123/2026-10.jsonl', line_start: 1, line_end: 5
    }]
  }));
  const h = await bridgeHarness({
    config: { memoryRag: { url: rag.url, timeoutMs: 1000 } },
    files: archiveFile(KEY, HISTORY_ROWS)
  });
  try {
    await withServer(h, async (p) => {
      const res = await call(p, '/api/socialV2/history-search', { method: 'POST', body: { key: KEY, query: '星云', keywords: ['星云'] } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'rag');
      assert.deepEqual(Object.keys(res.json.items[0]).sort(), ['day', 'sources', 'text', 'title']);
      for (const bad of ['refs', 'line_start', '.jsonl', 'private_123']) {
        assert.ok(!res.body.includes(bad), `响应不得带 ${bad}：${res.body}`);
      }
      const ids = unitIds(h, 'msg:').sort();
      assert.deepEqual(ids, ['msg:m1', 'msg:m4', 'msg:m5'], `应按 refs 命中并过滤：${ids}`);
    });
    assert.equal(rag.requests.length, 1);
  } finally { await h.close(); await rag.close(); }
});

// ── ⑥ 控制台接口 ──────────────────────────────────────────────────────────
await test('控制台：person 带 decay、review 解冻且 1 小时内不重复、已过时 400、update 取消过时、memory-decay 汇总', async () => {
  const h = await bridgeHarness({
    files: peopleFixture({
      456: {
        items: [
          ltmItem('oldfact002', '他以前在银行做柜员', { at: daysAgo(100), sourceKey: 'private:456' }),
          ltmItem('newfact002', '他最近养了一只橘猫叫团子', { at: daysAgo(0), sourceKey: 'private:456' })
        ]
      }
    })
  });
  try {
    await withServer(h, async (p) => {
      const person = await call(p, `/api/ltm/person?userId=456`);
      assert.equal(person.status, 200, person.body);
      const oldItem = person.json.person.items.find((x) => x.id === 'oldfact002');
      const newItem = person.json.person.items.find((x) => x.id === 'newfact002');
      assert.equal(oldItem.decay.frozen, true);
      assert.equal(typeof oldItem.decay.R, 'number');
      assert.equal(typeof oldItem.decay.S, 'number');
      assert.equal(oldItem.decay.exempt, false);
      assert.equal(newItem.decay.frozen, false);

      const wake = await call(p, '/api/ltm/review', { method: 'POST', body: { userId: '456', itemId: 'oldfact002' } });
      assert.equal(wake.status, 200, wake.body);
      assert.equal(wake.json.reviewed, true);
      const woke = wake.json.person.items.find((x) => x.id === 'oldfact002');
      assert.equal(woke.decay.frozen, false, '唤醒后应解冻');

      const again = await call(p, '/api/ltm/review', { method: 'POST', body: { userId: '456', itemId: 'oldfact002' } });
      assert.equal(again.status, 200, again.body);
      assert.equal(again.json.reviewed, false, '1 小时内再唤醒不再加固');

      const markOld = await call(p, '/api/ltm/update', { method: 'POST', body: { userId: '456', itemId: 'newfact002', outdated: true } });
      assert.equal(markOld.status, 200, markOld.body);
      assert.ok(markOld.json.person.items.find((x) => x.id === 'newfact002').outdatedAt);

      const bad = await call(p, '/api/ltm/review', { method: 'POST', body: { userId: '456', itemId: 'newfact002' } });
      assert.equal(bad.status, 400, bad.body);
      assert.match(String(bad.json.error), /取消过时/);

      const unmark = await call(p, '/api/ltm/update', { method: 'POST', body: { userId: '456', itemId: 'newfact002', outdated: false } });
      assert.equal(unmark.status, 200, unmark.body);
      assert.equal(unmark.json.person.items.find((x) => x.id === 'newfact002').outdatedAt, undefined);

      const stat = await call(p, '/api/memory-decay');
      assert.equal(stat.status, 200, stat.body);
      assert.equal(stat.json.ok, true);
      assert.equal(stat.json.enabled, undefined);
      assert.equal(typeof stat.json.units, 'number');
      assert.ok(stat.json.byKind && stat.json.freezeBelow);
      const row = stat.json.people.find((x) => x.userId === '456');
      assert.deepEqual(row, { userId: '456', name: '', total: 2, frozen: 0, outdated: 0 });

      // agent 令牌（AI 侧）不能碰这两个管理接口。
      for (const pathname of ['/api/memory-decay', '/api/ltm/review']) {
        const denied = pathname === '/api/ltm/review'
          ? await call(p, pathname, { method: 'POST', token: 'whatever', body: { userId: '456', itemId: 'oldfact002' } })
          : await call(p, pathname, { token: 'whatever' });
        assert.equal(denied.status, 403, `${pathname} 带 agent 令牌必须 403，实际 ${denied.status} ${denied.body}`);
      }
    });
  } finally { await h.close(); }
});

// ── ⑦ 唤醒提示的 replaces 用法句 ───────────────────────────────────────────
await test('唤醒提示 ltmLine 有 replaces 用法句', async () => {
  const h = await bridgeHarness();
  try {
    const prompt = h.buildWakePromptV2(KEY, 'timeout');
    assert.ok(prompt.includes('replaces=旧编号'), '唤醒提示要教她怎么更新旧条目');
  } finally { await h.close(); }
});

// ── ⑧ 遗忘模块写不进去 ────────────────────────────────────────────────────
await test('写盘失败（memory-decay.json 是目录）：remember / recall / history-search 照常 ok', async () => {
  const port = await freePort();
  const h = await bridgeHarness({
    config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } },
    files: archiveFile(KEY, [archiveRow('2026-10-20T10:00:00.000Z', '鲸鱼的照片洗出来了吗', { msgId: 'w1' })])
  });
  try {
    // 让所有写盘都失败：把状态路径做成目录。
    fs.mkdirSync(path.join(h.temp, 'state/memory-decay.json'));
    await withServer(h, async (p) => {
      const first = await call(p, '/api/socialV2/ltm-remember', { method: 'POST', body: { key: KEY, category: 'fact', content: '他喜欢鲸鱼' } });
      assert.equal(first.status, 200, first.body);
      const dup = await call(p, '/api/socialV2/ltm-remember', { method: 'POST', body: { key: KEY, category: 'fact', content: '他喜欢鲸鱼' } });
      assert.equal(dup.status, 200, dup.body, '复习写盘失败不能影响写入');
      assert.equal(dup.json.duplicate, true);

      const recall = await call(p, '/api/socialV2/ltm-recall', { method: 'POST', body: { key: KEY, query: '鲸鱼' } });
      assert.equal(recall.status, 200, recall.body);
      assert.equal(recall.json.matched, 1);

      const search = await call(p, '/api/socialV2/history-search', { method: 'POST', body: { key: KEY, query: '鲸鱼', mode: 'keyword' } });
      assert.equal(search.status, 200, search.body);
      assert.equal(search.json.ok, true);
    });
    assert.equal(fs.statSync(path.join(h.temp, 'state/memory-decay.json')).isDirectory(), true);
  } finally { await h.close(); }
});

// ── ⑨ MCP 工具的三个新参数 ────────────────────────────────────────────────
await test('MCP：replaces / outdated / query 出现在 schema 里并原样透传到桥接请求体', async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      seen.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, item: { id: 'a1b2c3d4' } }));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-decay-mcp-'));
  let client = null;
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    for (const file of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js']) {
      fs.copyFileSync(path.join(ROOT, 'src', file), path.join(tmp, 'src', file));
    }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'decay-mcp-probe', private: true, type: 'module' }));
    linkDir(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ consolePort: fake.address().port }));

    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(tmp, 'src', 'mcp-snowluma-safe.js')] });
    client = new Client({ name: 'decay-mcp-test', version: '0.1.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const remember = tools.find((t) => t.name === 'qq_ltm_remember');
    const recall = tools.find((t) => t.name === 'qq_ltm_recall');
    const update = tools.find((t) => t.name === 'qq_ltm_update');
    assert.ok(remember && recall && update, '三个工具都要注册');

    const rProps = remember.inputSchema?.properties ?? {};
    const cProps = recall.inputSchema?.properties ?? {};
    const uProps = update.inputSchema?.properties ?? {};
    assert.equal(rProps.replaces?.type, 'string', JSON.stringify(rProps.replaces));
    assert.ok((rProps.replaces?.description ?? '').includes('旧条目'));
    assert.equal(uProps.outdated?.type, 'boolean', JSON.stringify(uProps.outdated));
    assert.ok((uProps.outdated?.description ?? '').includes('过时'));
    assert.equal(cProps.query?.type, 'string', JSON.stringify(cProps.query));
    assert.ok((recall.description ?? '').includes('memory：清楚'), '工具描述要解释 memory 标签');

    await client.callTool({
      name: 'qq_ltm_remember',
      arguments: { key: KEY, token: 'probe-invalid', category: 'fact', content: '他搬到了城北', replaces: 'ab12cd34' }
    });
    assert.equal(seen.at(-1).body.replaces, 'ab12cd34', JSON.stringify(seen.at(-1).body));
    assert.equal(seen.at(-1).url, '/api/socialV2/ltm-remember');

    await client.callTool({
      name: 'qq_ltm_update',
      arguments: { key: KEY, token: 'probe-invalid', itemId: 'ab12cd34', outdated: true }
    });
    assert.equal(seen.at(-1).body.outdated, true, JSON.stringify(seen.at(-1).body));
    assert.equal(seen.at(-1).url, '/api/socialV2/ltm-update');

    await client.callTool({
      name: 'qq_ltm_recall',
      arguments: { key: KEY, token: 'probe-invalid', userId: OWNER, query: '猫 生日' }
    });
    assert.equal(seen.at(-1).body.query, '猫 生日', JSON.stringify(seen.at(-1).body));
    assert.equal(seen.at(-1).url, '/api/socialV2/ltm-recall');
  } finally {
    try { await client?.close(); } catch {}
    fake.closeAllConnections?.();
    await new Promise((resolve) => fake.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
