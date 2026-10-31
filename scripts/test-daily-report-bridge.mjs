// 每日报表（子项目 4）W2：桥接接线 + 两个控制台接口 + 报错计数钩子。REPORT_PATCH
//
// 用 audit-bridge-harness 在临时目录里跑真实的 bridge.js：不碰真实 state/、不联网。
// memory-rag 一律指向**本进程刚释放的空闲端口**（连接会被立刻拒绝），
// 绝不访问线上 8093（CLAUDE.md 坑：线上服务只读不碰）。
//
// 覆盖（任务书 §测试 1～9）：
//   ① GET /api/report/daily → 200、today:true、live 字段与 version
//   ② agent 令牌 / 无令牌智能体调用 → 403
//   ③ day / days 参数校验（非法、未来、越界）
//   ④ 过去某天没有快照 → partial:true，且请求后不写快照文件
//   ⑤ 昨天的快照 → prev 就是该文件内容
//   ⑥ log 钩子：报错计数、benign 行不计数、钩子抛异常不影响 log
//   ⑦ 报表模块创建失败 → 桥接照常启动、接口 503
//   ⑧ 人格 inject false → true 计一次 injectOn，再存 true 不重复计
//   ⑨ own-life 投递成功按 day / midnight 计数
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { dayOf } from '../src/daily-report.js';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const OWNER = '123';
const KEY = `private:${OWNER}`;

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 日期与请求辅助 ────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
function shiftDay(day, delta) {
  const [y, m, d] = String(day).split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
const TODAY = dayOf(Date.now());

/** 本机时区某天某个小时的 ISO 时间（存档行的 t 用 ISO）。 */
function at(day, hour = 10) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d, hour, 0, 0, 0).toISOString();
}

/** 一个没人监听的端口：memory-rag 客户端连它会被立刻拒绝，绝不碰线上 8093。 */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const DEAD_PORT = await freePort();

/** 起 harness；config 里的 memoryRag 一律指向死端口。 */
function makeHarness(options = {}) {
  return bridgeHarness({
    ...options,
    config: {
      memoryRag: { url: `http://127.0.0.1:${DEAD_PORT}` },
      ...(options.config ?? {})
    }
  });
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
  try { return await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function counters(h) {
  h.getDailyReport().flush();
  const file = path.join(h.temp, 'state', 'daily-report', 'counters.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 存档行（字段与 long-memory.js 落盘的一致）。 */
const archiveRow = (iso, text, { dir = 'in', userId = OWNER, name = '主人' } = {}) =>
  JSON.stringify({ t: iso, dir, userId: String(userId), name, text, msgId: null });

const archiveFile = (key, rows) =>
  ({ [`state/long-memory/archive/${key.replace(':', '_')}/${rows.day.slice(0, 7)}.jsonl`]: rows.lines.join('\n') + '\n' });

// ── ① 今天的报表：200 + live 结构 ─────────────────────────────────────────
await test('daily：今天 → 200、today:true、live 有服务状态但没有 ltmTotals、version 1', async () => {
  const h = await makeHarness();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/report/daily');
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.day, TODAY);
      assert.equal(res.json.today, true);
      assert.deepEqual(res.json.snapshotDays, [], '还没写快照');
      const { report } = res.json;
      assert.equal(report.version, 1);
      assert.equal(report.day, TODAY);
      assert.ok(report.live, '今天必须带 live');
      for (const field of ['startedAt', 'snowluma', 'dsh', 'ragConfigured', 'recentErrors']) {
        assert.ok(field in report.live, `live 缺 ${field}`);
      }
      assert.equal('ltmTotals' in report.live, false, 'ltmTotals 只用于填账本字段，不能留在 live 里');
      assert.equal(typeof report.live.startedAt, 'number');
      assert.equal(typeof report.live.snowluma.connected, 'boolean');
      assert.equal(typeof report.live.dsh.ready, 'boolean');
      assert.equal(report.live.ragConfigured, true, '客户端创建了就算配置了');
      assert.equal(report.live.rag, null, '死端口 → health 失败 → rag 为 null');
      assert.ok(Array.isArray(report.live.recentErrors));
      assert.ok(report.live.openers && typeof report.live.openers === 'object', 'W1 要补 openers');
      assert.equal(res.json.prev.version, 1, 'prev 是昨天（没有数据也算一份 Report）');
    });
  } finally { await h.close(); }
});

// ── ② 令牌隔离 ───────────────────────────────────────────────────────────
await test('daily / series：agent 令牌与无令牌智能体调用一律 403', async () => {
  const h = await makeHarness();
  try {
    h.setMode('reserved2');
    const token = h.getSocialV2State(KEY).agentToken;
    assert.ok(token, 'reserved2 会话应该有 agentToken');
    await withServer(h, async (port) => {
      const daily = await call(port, '/api/report/daily', { token });
      assert.equal(daily.status, 403, daily.body);
      const series = await call(port, '/api/report/series?days=3', { token });
      assert.equal(series.status, 403, series.body);
      const tokenless = await call(port, '/api/report/daily', { headers: { 'x-agent-call': '1' } });
      assert.equal(tokenless.status, 403, tokenless.body);
      // 控制台令牌照常可用
      assert.equal((await call(port, '/api/report/daily')).status, 200);
    });
  } finally { await h.close(); }
});

// ── ③ 参数校验 ───────────────────────────────────────────────────────────
await test('daily / series：非法日期、未来日期、days 越界都 400；days=3 返回 3 天', async () => {
  const h = await makeHarness();
  try {
    await withServer(h, async (port) => {
      for (const day of ['2026-13-40', 'abc', shiftDay(TODAY, 1)]) {
        const res = await call(port, `/api/report/daily?day=${encodeURIComponent(day)}`);
        assert.equal(res.status, 400, `${day} 应该 400：${res.body}`);
        assert.equal(res.json.ok, false);
      }
      for (const days of ['0', '61', 'x', '3.5']) {
        const res = await call(port, `/api/report/series?days=${encodeURIComponent(days)}`);
        assert.equal(res.status, 400, `days=${days} 应该 400：${res.body}`);
      }
      const ok = await call(port, '/api/report/series?days=3');
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.days.length, 3);
      assert.equal(ok.json.days[2], TODAY);
      assert.equal(ok.json.speechAll.length, 3);
      assert.equal(ok.json.totals.length, 3);
      assert.ok(Array.isArray(ok.json.events));
    });
  } finally { await h.close(); }
});

// ── ④ 过去的日期：现算、标 partial、不写盘 ────────────────────────────────
await test('daily：过去某天没有快照 → 现算 partial:true，且请求后不写快照文件', async () => {
  const past = shiftDay(TODAY, -2);
  const h = await makeHarness({
    files: archiveFile(KEY, {
      day: past,
      lines: [
        archiveRow(at(past, 10), '今天吃了火锅', { dir: 'in' }),
        archiveRow(at(past, 10), '好吃吗', { dir: 'out' }),
        archiveRow(at(past, 11), '特别好吃', { dir: 'in' })
      ]
    })
  });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, `/api/report/daily?day=${past}`);
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.today, false);
      assert.equal(res.json.partial, true);
      assert.equal(res.json.report.live, undefined, '过去的日期不带 live');
      assert.equal(res.json.report.sessions[KEY].in, 2);
      assert.equal(res.json.report.sessions[KEY].out, 1);
      assert.equal(res.json.report.service.errors, null, '补算的 service 计数为 null');
      assert.deepEqual(res.json.snapshotDays, []);
    });
    assert.equal(fs.existsSync(path.join(h.temp, 'state', 'daily-report', `${past}.json`)), false,
      '过去的日期只现算，不写快照');
  } finally { await h.close(); }
});

// ── ⑤ prev 优先读昨天的快照 ──────────────────────────────────────────────
await test('daily：昨天的快照存在 → prev 就是该文件内容', async () => {
  const yesterday = shiftDay(TODAY, -1);
  const snapshot = {
    version: 1,
    day: yesterday,
    createdAt: 1793300000000,
    partial: false,
    sessions: { [KEY]: { in: 7, out: 9, turns: 3, toolCalls: 4, speech: null } },
    memory: { ltmRemember: 1, ltmUpdate: 0, ltmForget: 0, queries: 0, ltmTotal: 2, ltmFaded: 0, ltmOutdated: 0, ownLifeDay: 2, ownLifeMidnight: 0, recalls: 0, associations: 0, promiseWakes: 0, shadow: 0, shadowPass: 0, shadowSkipped: 0, distillCalls: 0, distillOk: 0, distillFailed: 0 },
    cost: { dsh: 0.1, persona: 0, distill: 0, total: 0.1, personaCalls: 0, personaRules: 0, personaFailures: 0 },
    service: { errors: 1, longestGapMin: 0 },
    speechAll: null
  };
  const h = await makeHarness({ files: { [`state/daily-report/${yesterday}.json`]: snapshot } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/report/daily');
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(res.json.prev, snapshot);
      assert.deepEqual(res.json.snapshotDays, [yesterday]);
    });
  } finally { await h.close(); }
});

// ── ⑥ 报错计数钩子 ───────────────────────────────────────────────────────
await test('log 钩子：发送失败计入今天的 service.errors 与 recentErrors（≤120 字）', async () => {
  const h = await makeHarness();
  try {
    const before = (await withServer(h, (port) => call(port, '/api/report/daily'))).json.report.service.errors;
    // 让 QQ 发送必然失败：sendToQQ 的 catch 会打「QQ 发送失败」。
    h.bot.sendPrivateMessage = async () => { throw new Error('boom'); };
    await h.sendToQQ(KEY, '测试');
    const logText = fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8')
      .split('\n').filter((line) => line.includes('QQ 发送失败')).pop();
    assert.ok(logText, 'bridge.log 里应该有发送失败的日志');
    await withServer(h, async (port) => {
      const res = await call(port, '/api/report/daily');
      assert.equal(res.json.report.service.errors, before + 1, '报错计数要 +1');
      assert.equal(res.json.report.live.recentErrors.length, 1);
      assert.equal(res.json.report.live.recentErrors[0].text, logText, '最近一条报错原文要进 live');
      assert.ok(res.json.report.live.recentErrors[0].text.length <= 120);
    });
  } finally { await h.close(); }
});

await test('log 钩子：benign 行（SnowLuma 错误：{}）不计数', async () => {
  const h = await makeHarness();
  try {
    const before = await withServer(h, (port) => call(port, '/api/report/daily'));
    const errorsBefore = before.json.report.service.errors;
    const recentBefore = before.json.report.live.recentErrors.length;
    h.bot.sendPrivateMessage = async () => { throw new Error('SnowLuma 错误：{}'); };
    await h.sendToQQ(KEY, '测试');
    await withServer(h, async (port) => {
      const res = await call(port, '/api/report/daily');
      assert.equal(res.json.report.service.errors, errorsBefore, '排除列表里的行不该计数');
      assert.equal(res.json.report.live.recentErrors.length, recentBefore, '也不该进 recentErrors');
    });
  } finally { await h.close(); }
});

await test('log 钩子：假报表实例的 count 抛异常时 log 照常工作、桥接照常启动', async () => {
  const fake = {
    compute: async () => ({ version: 1, day: TODAY }),
    snapshotDue: async () => [],
    read: () => null,
    days: () => [],
    series: async () => ({ days: [], speechAll: [], totals: [], events: [] }),
    count: () => { throw new Error('count boom'); },
    heartbeat: () => {},
    flush: () => {}
  };
  const h = await makeHarness({ globals: { createDailyReport: () => fake } });
  try {
    assert.ok(h.getDailyReport(), '假实例创建成功');
    h.bot.sendPrivateMessage = async () => { throw new Error('boom'); };
    await h.sendToQQ(KEY, '测试');
    const logText = fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8');
    assert.match(logText, /QQ 发送失败/, '钩子抛异常不影响 log() 写日志');
    await withServer(h, async (port) => {
      const res = await call(port, '/api/report/daily');
      assert.equal(res.status, 200, '桥接照常工作');
    });
  } finally { await h.close(); }
});

// ── ⑦ 报表模块创建失败 ───────────────────────────────────────────────────
await test('createDailyReport 构造时抛异常 → 桥接正常启动、两个接口 503', async () => {
  const h = await makeHarness({ globals: { createDailyReport: () => { throw new Error('no report'); } } });
  try {
    assert.equal(h.getDailyReport(), null);
    await withServer(h, async (port) => {
      for (const pathname of ['/api/report/daily', '/api/report/series?days=3']) {
        const res = await call(port, pathname);
        assert.equal(res.status, 503, `${pathname}：${res.body}`);
        assert.equal(res.json.ok, false);
        assert.match(String(res.json.error), /没有启动/);
      }
      // 桥接自己照常可用
      assert.equal((await call(port, '/api/status')).status, 200);
    });
  } finally { await h.close(); }
});

// ── ⑧ 人格开注入计数 ─────────────────────────────────────────────────────
await test('persona/config：inject 由 false 变 true 记一次 injectOn，再存 true 不重复计', async () => {
  const h = await makeHarness();
  const injectOn = () => {
    h.getDailyReport().flush();
    const file = path.join(h.temp, 'state', 'daily-report', 'counters.json');
    if (!fs.existsSync(file)) return 0;
    return JSON.parse(fs.readFileSync(file, 'utf8')).days?.[TODAY]?.injectOn ?? 0;
  };
  try {
    await withServer(h, async (port) => {
      const off = await call(port, '/api/persona/config', { method: 'POST', body: { settings: { inject: false } } });
      assert.equal(off.status, 200, off.body);
      assert.equal(off.json.settings.inject, false);
      assert.equal(injectOn(), 0, '关着的时候不计数');

      const on = await call(port, '/api/persona/config', { method: 'POST', body: { settings: { inject: true } } });
      assert.equal(on.status, 200, on.body);
      assert.equal(on.json.settings.inject, true);

      const again = await call(port, '/api/persona/config', { method: 'POST', body: { settings: { inject: true } } });
      assert.equal(again.status, 200, again.body);
    });
    assert.equal(injectOn(), 1, '只在 false → true 时记一次');
  } finally { await h.close(); }
});

// ── ⑨ own-life 投递成功计数 ──────────────────────────────────────────────
await test('own-life：投递成功按 day / midnight 分别计数', async () => {
  const h = await makeHarness();
  try {
    h.setMode('reserved2');
    const ownLife = h.getOwnLife();
    assert.ok(ownLife, 'own-life 应该在启动时创建');

    const day = await ownLife.fireNow();
    assert.equal(day.ok, true, `白天投递应该成功：${JSON.stringify(day)}`);
    const midnight = await ownLife.fireMidnightNow();
    assert.equal(midnight.ok, true, `半夜投递应该成功：${JSON.stringify(midnight)}`);

    const c = counters(h);
    assert.equal(c.days[TODAY].ownLifeDay, 1);
    assert.equal(c.days[TODAY].ownLifeMidnight, 1);
  } finally { await h.close(); }
});

// ── ⑩ 重启后 live.lastIncomingAt 从存档读回来（REPORT_PATCH 小返工）──────────
await test('live.lastIncomingAt：从存档的 ISO 时间读回最近的 dir:"in"，跳过 out 与墓碑', async () => {
  const now = Date.now();
  const olderIn = new Date(now - 5 * 3600 * 1000).toISOString();
  const newerIn = new Date(now - 3 * 3600 * 1000).toISOString();
  const laterOut = new Date(now - 1 * 3600 * 1000).toISOString();
  const h = await makeHarness({
    files: archiveFile(KEY, {
      day: TODAY,
      lines: [
        archiveRow(olderIn, '五小时前收到的', { dir: 'in' }),
        archiveRow(newerIn, '三小时前收到的', { dir: 'in' }),
        archiveRow(laterOut, '一小时前我发出的', { dir: 'out' }),
        // 墓碑行：等长改写的写法是 `{"deleted":true}` + 空格
        JSON.stringify({ deleted: true }) + ' '
      ]
    })
  });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/report/daily');
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.report.live.lastIncomingAt, Date.parse(newerIn),
        '要读回较新的 dir:"in" 的毫秒时间，不能是 out 那条，也不能是 null');
    });
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
