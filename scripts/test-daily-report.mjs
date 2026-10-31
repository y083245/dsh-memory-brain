// src/daily-report.js 的单测（REPORT_PATCH，子项目 4 v1）。
//
// 全部用 fs.mkdtempSync 造出来的临时 stateDir + 假时钟：不读 state/、不联网、不碰服务。
// 覆盖：存档 / 说话习惯 / 工具调用 / 花费 / 生活回路与影子 / 计数与心跳 / 快照 /
// 折线 / live / 健壮性；并逐字节确认快照里没有任何聊天原文。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeUsage, priceUsage } from '../src/model-prices.js';
import {
  createDailyReport,
  dayOf,
  isErrorLine,
  speechStats,
  SPEECH
} from '../src/daily-report.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const TMP_DIRS = [];
const ALL_LOGS = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  TMP_DIRS.push(dir);
  return dir;
}

/** 每个用例一个独立的 state/ 目录。 */
function newState() {
  return path.join(tempDir(), 'state');
}

/** 本地时间戳。 */
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const iso = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString();

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2) + '\n');
}
function writeJsonl(file, rows) {
  writeText(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

/** 造实例；now 可以是数字或函数。 */
function make(state, now, extra = {}) {
  const logs = [];
  const report = createDailyReport({
    stateDir: state,
    now: typeof now === 'function' ? now : () => now,
    log: (line) => { logs.push(line); ALL_LOGS.push(line); },
    ...extra
  });
  return { report, logs };
}

function archivePath(state, sessionDir, month) {
  return path.join(state, 'long-memory', 'archive', sessionDir, `${month}.jsonl`);
}

function walkFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ── 1. 存档：条数、墓碑、跨日、时区边界 ────────────────────────────────────
await test('存档：两个会话的 in/out 条数、墓碑跳过、跨日与时区边界', async () => {
  const state = newState();
  writeJsonl(archivePath(state, 'private_111', '2026-10'), [
    { t: iso(2026, 10, 30, 23, 59, 30), dir: 'in', text: '在吗' },
    { t: iso(2026, 10, 30, 8, 0, 0), dir: 'out', text: '在的' },
    { t: iso(2026, 10, 29, 23, 0, 0), dir: 'out', text: '昨天的' },
    '{"deleted":true}                        ',
    { t: iso(2026, 9, 30, 12, 0, 0), dir: 'in', text: '上个月的' },
    { t: iso(2026, 10, 31, 0, 0, 10), dir: 'out', text: '第二天的' }
  ]);
  writeJsonl(archivePath(state, 'group_222', '2026-10'), [
    { t: iso(2026, 10, 30, 9, 0, 0), dir: 'in', text: '群消息' },
    { t: iso(2026, 10, 30, 9, 1, 0), dir: 'in', text: '[图片]' }
  ]);

  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const today = await report.compute('2026-10-30');
  assert.equal(today.sessions['private:111'].in, 1);
  assert.equal(today.sessions['private:111'].out, 1);
  assert.equal(today.sessions['group:222'].in, 2);
  assert.equal(today.sessions['group:222'].out, 0);
  // 纯图片不算文字消息
  assert.equal(today.sessions['group:222'].speech.theirTextCount, 1);
  assert.equal(today.sessions['group:222'].speech.herTextCount, 0);

  const next = await report.compute('2026-10-31');
  assert.equal(next.sessions['private:111'].in, 0);
  assert.equal(next.sessions['private:111'].out, 1, '00:00:10 属于第二天');

  // 本地时区边界
  assert.equal(dayOf(at(2026, 10, 30, 23, 59, 30)), '2026-10-30');
  assert.equal(dayOf(at(2026, 10, 31, 0, 0, 10)), '2026-10-31');
});

// ── 2. 说话习惯 ───────────────────────────────────────────────────────────
await test('speechStats：中位数、逗号、语气词、「行」开头、劝睡劝吃、阈值、表情包', async () => {
  const hers = ['好的呢', '行，知道了', '早点睡吧', '吃饭了吗', '今天好累啊', '[图片]'];
  const theirs = ['嗯嗯', '哈哈', '好吧', '你说呢', '去吗'];
  const stats = speechStats(hers, theirs, [
    '[表情包:笑哭]', '好的', '[表情包:笑哭]', '[表情包:猫猫]', '[图片]'
  ]);

  assert.equal(stats.herTextCount, 5, '[图片] 不算文字');
  assert.equal(stats.theirTextCount, 5);
  // 字数：3,5,4,4,5 → 中位数 4
  assert.equal(stats.herMedianLen, 4);
  assert.equal(stats.theirMedianLen, 2); // 2,2,2,3,2
  assert.equal(stats.herCommas, 0.2);    // 1 / 5
  assert.equal(stats.theirCommas, 0);
  assert.equal(stats.herParticleEnd, 0.6);  // 呢 / 吧 / 啊
  assert.equal(stats.theirParticleEnd, 0.4); // 吧 / 呢（「吗」不在语气词名单里）
  assert.equal(stats.xingOpen, 0.2);        // 只有「行，知道了」
  assert.equal(stats.care, 0.4);            // 睡 / 吃饭
  assert.deepEqual(stats.stickers, [['笑哭', 2]]);

  // 少于 5 条：比例与中位数都是 null，计数照常
  const few = speechStats(['好的呢', '行，知道了', '早点睡吧', '吃饭了吗'], ['嗯'], []);
  assert.equal(few.herTextCount, 4);
  assert.equal(few.herMedianLen, null);
  assert.equal(few.herCommas, null);
  assert.equal(few.herParticleEnd, null);
  assert.equal(few.xingOpen, null);
  assert.equal(few.care, null);
  assert.equal(few.theirMedianLen, null);
  assert.equal(few.theirParticleEnd, null);
  assert.deepEqual(few.stickers, []);

  // 常量对接口约定是公开的
  assert.equal(SPEECH.MIN_TEXTS, 5);
});

// ── 3. 工具调用 ───────────────────────────────────────────────────────────
await test('工具调用：只数 result+ok，call 单独计，args 原文不外泄', async () => {
  const state = newState();
  writeJsonl(archivePath(state, 'private_111', '2026-10'), [
    { t: iso(2026, 10, 30, 9, 0, 0), dir: 'out', text: '好的' }
  ]);
  writeJsonl(path.join(state, 'tool-calls.jsonl'), [
    {
      type: 'call', time: iso(2026, 10, 30, 9, 1), key: 'private:111', sessionId: 's1',
      tool: 'mcp__snowluma__qq_ltm_remember', args: { note: '紫色长颈鹿' }
    },
    {
      type: 'call', time: iso(2026, 10, 30, 9, 2), key: 'private:111', sessionId: 's1',
      tool: 'mcp__snowluma__qq_history_search'
    },
    { type: 'result', ok: true, time: iso(2026, 10, 30, 9, 1), key: 'private:111', sessionId: 's1', tool: 'mcp__snowluma__qq_ltm_remember' },
    { type: 'result', ok: false, time: iso(2026, 10, 30, 9, 1), key: 'private:111', sessionId: 's1', tool: 'mcp__snowluma__qq_ltm_update' },
    { type: 'result', ok: true, time: iso(2026, 10, 30, 9, 3), key: 'private:111', sessionId: 's1', tool: 'mcp__snowluma__qq_ltm_update' },
    { type: 'result', ok: true, time: iso(2026, 10, 30, 9, 4), key: 'private:111', sessionId: 's1', tool: 'mcp__snowluma__qq_ltm_forget' },
    { type: 'result', ok: true, time: iso(2026, 10, 30, 9, 5), key: 'private:111', sessionId: 's1', tool: 'mcp__snowluma__qq_history_search' },
    { type: 'result', ok: true, time: iso(2026, 10, 30, 9, 6), key: 'private:111', sessionId: 's1', tool: 'mcp__snowluma__qq_ltm_recall' },
    // 昨天的结果不算
    { type: 'result', ok: true, time: iso(2026, 10, 29, 9, 0), key: 'private:111', sessionId: 's1', tool: 'mcp__snowluma__qq_ltm_remember' }
  ]);

  const { report, logs } = make(state, at(2026, 10, 30, 12, 0));
  const rep = await report.compute('2026-10-30');
  assert.equal(rep.memory.ltmRemember, 1);
  assert.equal(rep.memory.ltmUpdate, 1);
  assert.equal(rep.memory.ltmForget, 1);
  assert.equal(rep.memory.queries, 2);
  assert.equal(rep.sessions['private:111'].toolCalls, 2);

  const serialized = JSON.stringify(rep);
  assert.ok(!serialized.includes('紫色长颈鹿'), '工具参数原文不能出现在结果里');
  assert.ok(!logs.join('\n').includes('紫色长颈鹿'), '工具参数原文不能进日志');
});

// ── 4. 花费 ───────────────────────────────────────────────────────────────
await test('花费：turn 去重后计价、base 不算、turns 去重、人格与提炼加总', async () => {
  const state = newState();
  const t1 = at(2026, 10, 30, 10, 0, 0);
  writeJsonl(path.join(state, 'token-usage.jsonl'), [
    // 会话基线：不算当天花费
    { k: 'base', t: t1, sid: 's1', key: 'private:111', seq: 1, model: 'deepseek-flash', b: { cacheMiss: 999999, cacheHit: 0, cacheWrite: 0, output: 999999 } },
    // 同一 (sid, turn, step, retry) 出现两次：只算后一条
    { k: 'turn', t: t1, sid: 's1', key: 'private:111', seq: 2, turn: 1, step: 1, retry: 0, model: 'deepseek-flash', b: { cacheMiss: 100, cacheHit: 50, cacheWrite: 0, output: 20 } },
    { k: 'turn', t: t1 + 1000, sid: 's1', key: 'private:111', seq: 3, turn: 1, step: 1, retry: 0, model: 'deepseek-flash', b: { cacheMiss: 200, cacheHit: 60, cacheWrite: 0, output: 30 } },
    // 同一回合的另一步：不增加回合数
    { k: 'turn', t: t1 + 2000, sid: 's1', key: 'private:111', seq: 4, turn: 1, step: 2, retry: 0, model: 'deepseek-flash', b: { cacheMiss: 10, cacheHit: 0, cacheWrite: 0, output: 5 } },
    { k: 'turn', t: t1 + 3000, sid: 's1', key: 'private:111', seq: 5, turn: 2, step: 1, retry: 0, model: 'deepseek-pro', b: { cacheMiss: 7, cacheHit: 3, cacheWrite: 0, output: 2 } },
    // 昨天的不算
    { k: 'turn', t: at(2026, 10, 29, 10, 0, 0), sid: 's1', key: 'private:111', seq: 6, turn: 3, step: 1, retry: 0, model: 'deepseek-flash', b: { cacheMiss: 1, cacheHit: 0, cacheWrite: 0, output: 1 } }
  ]);
  writeJson(path.join(state, 'persona', 'usage.json'), {
    version: 1,
    days: {
      '2026-10-30': {
        runA: { calls: 2, rules: 1, failures: 0, cost: 0.01, updatedAt: t1 },
        runB: { calls: 3, rules: 0, failures: 1, cost: 0.02, updatedAt: t1 }
      },
      '2026-10-29': { runC: { calls: 9, rules: 9, failures: 9, cost: 9 } }
    }
  });
  writeJson(path.join(state, 'long-memory', 'rag', 'distill-usage.json'), {
    version: 1,
    days: {
      '2026-10-30': { calls: 4, ok: 3, failed: 1, cacheHit: 1, cacheMiss: 2, output: 3, cost: 0.0045 }
    }
  });

  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const rep = await report.compute('2026-10-30');

  const price = (b, model, t) => priceUsage(normalizeUsage(b), { model, at: t }).cost.total;
  const expected = price({ cacheMiss: 200, cacheHit: 60, cacheWrite: 0, output: 30 }, 'deepseek-flash', t1 + 1000) +
    price({ cacheMiss: 10, cacheHit: 0, cacheWrite: 0, output: 5 }, 'deepseek-flash', t1 + 2000) +
    price({ cacheMiss: 7, cacheHit: 3, cacheWrite: 0, output: 2 }, 'deepseek-pro', t1 + 3000);

  assert.equal(rep.cost.dsh, Math.round(expected * 1e4) / 1e4);
  assert.equal(rep.cost.persona, 0.03);
  assert.equal(rep.cost.distill, 0.0045);
  assert.equal(rep.cost.total, Math.round((expected + 0.03 + 0.0045) * 1e4) / 1e4);
  assert.equal(rep.cost.personaCalls, 5);
  assert.equal(rep.cost.personaRules, 1);
  assert.equal(rep.cost.personaFailures, 1);
  // 「被唤醒」：turn 1（两个 step）与 turn 2 → 2 个回合
  assert.equal(rep.sessions['private:111']?.turns ?? 0, 0, '没有存档行就不会出现在 sessions 里');
});

await test('花费：回合数按会话统计（有存档行时）', async () => {
  const state = newState();
  const t1 = at(2026, 10, 30, 10, 0, 0);
  writeJsonl(archivePath(state, 'private_111', '2026-10'), [
    { t: iso(2026, 10, 30, 9, 0, 0), dir: 'out', text: '好' }
  ]);
  writeJsonl(path.join(state, 'token-usage.jsonl'), [
    { k: 'turn', t: t1, sid: 's1', key: 'private:111', turn: 1, step: 1, retry: 0, model: 'deepseek-flash', b: { output: 1 } },
    { k: 'turn', t: t1 + 1, sid: 's1', key: 'private:111', turn: 1, step: 2, retry: 0, model: 'deepseek-flash', b: { output: 1 } },
    { k: 'turn', t: t1 + 2, sid: 's1', key: 'private:111', turn: 2, step: 1, retry: 0, model: 'deepseek-flash', b: { output: 1 } }
  ]);
  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const rep = await report.compute('2026-10-30');
  assert.equal(rep.sessions['private:111'].turns, 2);
});

// ── 5. 生活回路与影子 ─────────────────────────────────────────────────────
await test('生活回路 / 自动想起（影子）：计数、pass、skipped、坏行跳过', async () => {
  const state = newState();
  writeJson(path.join(state, 'life-loop.json'), {
    history: [
      { at: at(2026, 10, 30, 9, 0), kind: 'recall' },
      { at: at(2026, 10, 30, 10, 0), kind: 'recall' },
      { at: at(2026, 10, 30, 11, 0), kind: 'associate' },
      { at: at(2026, 10, 30, 12, 0), kind: 'promise-wake', items: [1, 2, 3] },
      { at: at(2026, 10, 29, 9, 0), kind: 'recall' }
    ]
  });
  writeJsonl(path.join(state, 'long-memory', 'recall-shadow', '2026-10.jsonl'), [
    {
      id: 'a', at: at(2026, 10, 30, 8, 0), key: 'private:111', mode: 'auto', skipped: null,
      tau: 0.5, ms: 12, msgs: 3, candidates: [{ summary_id: 1, pass: true }, { summary_id: 2, pass: false }], inject: false
    },
    {
      id: 'b', at: at(2026, 10, 30, 8, 5), key: 'private:111', mode: 'auto', skipped: 'tau',
      tau: 0.5, ms: 11, msgs: 3, candidates: [{ pass: false }], inject: false
    },
    {
      id: 'c', at: at(2026, 10, 30, 8, 10), key: 'private:111', mode: 'auto', skipped: null,
      tau: 0.5, ms: 10, msgs: 3, candidates: [{ pass: false }], inject: false
    },
    '{坏行',
    { id: 'd', at: at(2026, 10, 30, 8, 15), key: 'private:111' }, // 没有 candidates
    { id: 'e', label: '标注行' },                                  // 没有 at
    { id: 'f', at: at(2026, 10, 29, 8, 0), candidates: [] }        // 昨天
  ]);

  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const rep = await report.compute('2026-10-30');
  assert.equal(rep.memory.recalls, 2);
  assert.equal(rep.memory.associations, 1);
  assert.equal(rep.memory.promiseWakes, 1);
  assert.equal(rep.memory.shadow, 3);
  assert.equal(rep.memory.shadowPass, 1);
  assert.equal(rep.memory.shadowSkipped, 1);
});

// ── 6. 计数与心跳落盘 ─────────────────────────────────────────────────────
await test('计数：flush 后新实例读回并继续累加、未知名字忽略、权限与 30 天保留', async () => {
  const state = newState();
  const clock = at(2026, 10, 30, 12, 0);
  const first = make(state, clock).report;
  first.count('ownLifeDay');
  first.count('ownLifeDay', 2);
  first.count('ownLifeMidnight');
  first.count('error', 3);
  first.count('injectOn');
  first.count('unknown', 5);
  first.flush();

  const countersFile = path.join(state, 'daily-report', 'counters.json');
  assert.equal(fs.statSync(countersFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(countersFile)).mode & 0o777, 0o700);
  const saved = JSON.parse(fs.readFileSync(countersFile, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.days['2026-10-30'].ownLifeDay, 3);
  assert.equal(saved.days['2026-10-30'].ownLifeMidnight, 1);
  assert.equal(saved.days['2026-10-30'].error, 3);
  assert.equal(saved.days['2026-10-30'].injectOn, 1);
  assert.ok(!('unknown' in saved.days['2026-10-30']), '未知名字被忽略');

  const second = make(state, clock).report;
  const rep = await second.compute('2026-10-30');
  assert.equal(rep.partial, false);
  assert.equal(rep.memory.ownLifeDay, 3);
  assert.equal(rep.memory.ownLifeMidnight, 1);
  assert.equal(rep.service.errors, 3);

  second.count('ownLifeDay');
  second.flush();
  const saved2 = JSON.parse(fs.readFileSync(countersFile, 'utf8'));
  assert.equal(saved2.days['2026-10-30'].ownLifeDay, 4, '新实例接着累加');

  // 只保留最近 30 天：旧日期在下次写盘时被清掉
  const state2 = newState();
  const old = '2026-08-01';
  writeJson(path.join(state2, 'daily-report', 'counters.json'), {
    version: 1,
    days: { [old]: { error: 9 } },
    heartbeats: { [old]: [at(2026, 8, 1, 10, 0)] }
  });
  const third = make(state2, clock).report;
  third.heartbeat();
  const saved3 = JSON.parse(fs.readFileSync(path.join(state2, 'daily-report', 'counters.json'), 'utf8'));
  assert.ok(!(old in saved3.days));
  assert.ok(!(old in saved3.heartbeats));
});

// ── 7. 心跳与中断 ─────────────────────────────────────────────────────────
await test('心跳：10:10 → 10:40 的中断为 29 分钟', async () => {
  const state = newState();
  let clock = at(2026, 10, 30, 10, 0);
  const { report } = make(state, () => clock);
  for (let m = 0; m <= 10; m++) { clock = at(2026, 10, 30, 10, m); report.heartbeat(); }
  for (let m = 40; m <= 45; m++) { clock = at(2026, 10, 30, 10, m); report.heartbeat(); }
  const rep = await report.compute('2026-10-30');
  assert.equal(rep.service.longestGapMin, 29);
});

await test('心跳：跨午夜那段只数落在当天里的分钟（20）', async () => {
  const state = newState();
  let clock = at(2026, 10, 29, 23, 50);
  const { report } = make(state, () => clock);
  report.heartbeat();
  for (const m of [20, 21, 22]) { clock = at(2026, 10, 30, 0, m); report.heartbeat(); }
  const rep = await report.compute('2026-10-30');
  assert.equal(rep.service.longestGapMin, 20);
  // 没有任何心跳的过去日子 → null
  const older = await report.compute('2026-10-28');
  assert.equal(older.partial, true);
  assert.equal(older.service.longestGapMin, null);
  assert.equal(older.service.errors, null);
  assert.equal(older.memory.ownLifeDay, null);
});

// ── 8. 报错判定 ───────────────────────────────────────────────────────────
await test('isErrorLine：真报错为 true，已知无害的日志为 false', async () => {
  assert.equal(isErrorLine('[media] 表情获取失败'), true);
  assert.equal(isErrorLine('请求超时了'), true);
  assert.equal(isErrorLine('Error: boom'), true);
  assert.equal(isErrorLine('SnowLuma 错误：{}'), false);
  assert.equal(isErrorLine('自愈完成'), false);
  assert.equal(isErrorLine('qq-tool-restrict restrict 失败 78/82'), false);
  assert.equal(isErrorLine('首次连接未成功'), false);
  assert.equal(isErrorLine('SnowLuma 连接断开（code=1006）'), false);
  assert.equal(isErrorLine('WS 同步不可用'), false);
  assert.equal(isErrorLine('一切正常'), false);
  assert.equal(isErrorLine(null), false);
  assert.equal(isErrorLine(123), false);
});

// ── 9. 快照 ───────────────────────────────────────────────────────────────
await test('快照：昨天完整 + 更早的 partial；不重写、无原文、无 live', async () => {
  const state = newState();
  writeJsonl(archivePath(state, 'private_111', '2026-10'), [
    { t: iso(2026, 10, 30, 9, 0, 0), dir: 'out', text: '今天紫色长颈鹿' },
    { t: iso(2026, 10, 29, 9, 0, 0), dir: 'in', text: '昨天的紫色长颈鹿' },
    { t: iso(2026, 10, 29, 9, 1, 0), dir: 'out', text: '嗯嗯[表情包:笑哭]' },
    { t: iso(2026, 10, 28, 9, 0, 0), dir: 'in', text: '前天的紫色长颈鹿' }
  ]);
  writeJsonl(path.join(state, 'tool-calls.jsonl'), [
    {
      type: 'call', time: iso(2026, 10, 28, 10, 0), key: 'private:111', sessionId: 's1',
      tool: 'mcp__snowluma__qq_ltm_remember', args: { note: '蓝色独角兽' }
    }
  ]);

  // 先用「昨天」的时钟造出昨天的计数与心跳（这样昨天不是 partial）
  const previous = make(state, at(2026, 10, 29, 12, 0)).report;
  previous.count('ownLifeDay', 2);
  previous.count('ownLifeMidnight', 1);
  previous.heartbeat();
  previous.flush();

  const { report } = make(state, at(2026, 10, 30, 12, 0), {
    getLive: () => ({ ltmTotals: { total: 14, faded: 1, outdated: 2 } })
  });
  const written = await report.snapshotDue();
  assert.deepEqual(written, ['2026-10-28', '2026-10-29']);

  const snapDir = path.join(state, 'daily-report');
  const yesterday = JSON.parse(fs.readFileSync(path.join(snapDir, '2026-10-29.json'), 'utf8'));
  assert.equal(yesterday.partial, false);
  assert.equal(yesterday.memory.ltmTotal, 14);
  assert.equal(yesterday.memory.ltmFaded, 1);
  assert.equal(yesterday.memory.ltmOutdated, 2);
  assert.equal(yesterday.memory.ownLifeDay, 2);
  assert.equal(yesterday.memory.ownLifeMidnight, 1);
  assert.equal(yesterday.service.errors, 0);
  assert.equal(yesterday.service.longestGapMin, 0);
  assert.ok(!('live' in yesterday));

  const older = JSON.parse(fs.readFileSync(path.join(snapDir, '2026-10-28.json'), 'utf8'));
  assert.equal(older.partial, true);
  assert.equal(older.memory.ltmTotal, null);
  assert.equal(older.memory.ownLifeDay, null);
  assert.equal(older.service.errors, null);
  assert.equal(older.service.longestGapMin, null);
  assert.ok(!fs.existsSync(path.join(snapDir, '2026-10-27.json')), '没有数据的日子不写');

  // 第二次调用什么都不写，已有文件逐字节不变
  const before = walkFiles(snapDir).map((file) => [file, fs.readFileSync(file)]);
  assert.deepEqual(await report.snapshotDue(), []);
  for (const [file, bytes] of before) {
    assert.ok(fs.readFileSync(file).equals(bytes), `${file} 被重写了`);
  }

  // 快照里不能有聊天原文 / 工具参数原文 / live
  const joined = walkFiles(snapDir).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.ok(!joined.includes('紫色长颈鹿'));
  assert.ok(!joined.includes('蓝色独角兽'));
  assert.ok(!joined.includes('"live"'));
  assert.ok(!joined.includes('"openers"'));
});

// ── 10. 折线 ──────────────────────────────────────────────────────────────
await test('series：长度、最后一天、没数据为 null、events 来自 injectOn', async () => {
  const state = newState();
  writeJsonl(archivePath(state, 'private_111', '2026-10'), [
    { t: iso(2026, 10, 30, 9, 0, 0), dir: 'out', text: '今天好呀' },
    { t: iso(2026, 10, 28, 9, 0, 0), dir: 'out', text: '前天好呀' }
  ]);
  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const series = await report.series(14);
  assert.equal(series.days.length, 14);
  assert.equal(series.days[0], '2026-10-17');
  assert.equal(series.days[13], '2026-10-30');
  assert.equal(series.speechAll.length, 14);
  assert.equal(series.totals.length, 14);
  assert.ok(series.speechAll[13] && series.speechAll[13].herTextCount === 1);
  assert.ok(series.totals[13] && series.totals[13].out === 1);
  assert.ok(series.speechAll[11] && series.speechAll[11].herTextCount === 1, '10-28 有数据');
  assert.equal(series.speechAll[12], null, '10-29 没有数据');
  assert.equal(series.totals[12], null);
  assert.deepEqual(series.events, []);

  report.count('injectOn');
  const withEvent = await report.series(14);
  assert.deepEqual(withEvent.events, [{ day: '2026-10-30', kind: 'injectOn', label: '人格开注入' }]);

  // 夹到 1～60
  assert.equal((await report.series(0)).days.length, 1);
  assert.equal((await report.series(999)).days.length, 60);
});

// ── 11. 今天的 live ───────────────────────────────────────────────────────
await test('compute(今天, { live })：原样挂 live + openers，账本现状来自 ltmTotals', async () => {
  const state = newState();
  writeJsonl(archivePath(state, 'private_111', '2026-10'), [
    { t: iso(2026, 10, 30, 9, 0, 0), dir: 'out', text: '行，好的' },
    { t: iso(2026, 10, 30, 9, 1, 0), dir: 'out', text: '行，知道了' },
    { t: iso(2026, 10, 30, 9, 2, 0), dir: 'out', text: '行，你说' },
    { t: iso(2026, 10, 30, 9, 3, 0), dir: 'out', text: '不过我觉得' },
    { t: iso(2026, 10, 30, 9, 4, 0), dir: 'out', text: '不过也行' },
    { t: iso(2026, 10, 30, 9, 5, 0), dir: 'in', text: '好' }
  ]);
  const live = {
    startedAt: 111,
    lastIncomingAt: 222,
    snowluma: { connected: true, downSinceMs: null },
    dsh: { ready: true, downSinceMs: null },
    ragConfigured: true,
    rag: { ok: true, embedding: true, distill: { pending: 0, failed: 0, lastError: null } },
    recentErrors: [{ at: 333, text: '一次报错' }],
    ltmTotals: { total: 14, faded: 1, outdated: 2 }
  };
  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const rep = await report.compute('2026-10-30', { live });

  assert.equal(rep.live.startedAt, 111);
  assert.equal(rep.live.lastIncomingAt, 222);
  assert.equal(rep.live.snowluma.connected, true);
  assert.equal(rep.live.dsh.ready, true);
  assert.equal(rep.live.rag.ok, true);
  assert.deepEqual(rep.live.recentErrors, [{ at: 333, text: '一次报错' }]);
  assert.ok(!('ltmTotals' in rep.live), 'ltmTotals 不进 live');
  assert.deepEqual(rep.live.openers['private:111'], [['行，', 3], ['不过', 2]]);
  assert.equal(rep.memory.ltmTotal, 14);
  assert.equal(rep.memory.ltmFaded, 1);
  assert.equal(rep.memory.ltmOutdated, 2);

  // 不传 live 时没有 live 键，三个账本字段为 null
  const plain = await report.compute('2026-10-30');
  assert.ok(!('live' in plain));
  assert.equal(plain.memory.ltmTotal, null);
});

// ── 12. 健壮性 ────────────────────────────────────────────────────────────
await test('健壮性：空目录、坏 JSON、同名目录都不抛', async () => {
  const now = at(2026, 10, 30, 12, 0);

  // 空目录 + getLive 自己抛错
  const empty = newState();
  fs.mkdirSync(empty, { recursive: true });
  const r1 = make(empty, now, { getLive: () => { throw new Error('boom'); } }).report;
  const today = await r1.compute('2026-10-30');
  assert.deepEqual(today.sessions, {});
  assert.equal(today.cost.total, 0);
  assert.equal(today.service.errors, 0);
  assert.equal(today.partial, false);
  const past = await r1.compute('2026-10-01');
  assert.equal(past.partial, true);
  assert.equal(past.service.errors, null);
  assert.equal(r1.read('2026-10-01'), null);
  assert.deepEqual(r1.days(), []);
  assert.equal((await r1.series(14)).days.length, 14);
  r1.count('error');
  r1.heartbeat();
  r1.flush();
  // 空目录也会写昨天那份（规格 §3：前一天没有快照就写）
  assert.deepEqual(await r1.snapshotDue(), ['2026-10-29']);

  // 各文件是坏 JSON / 坏 JSONL
  const bad = newState();
  writeText(path.join(bad, 'tool-calls.jsonl'), '{不是 json\n');
  writeText(path.join(bad, 'token-usage.jsonl'), 'nope\n');
  writeText(path.join(bad, 'persona', 'usage.json'), '{');
  writeText(path.join(bad, 'long-memory', 'rag', 'distill-usage.json'), '[]');
  writeText(path.join(bad, 'life-loop.json'), 'null');
  writeText(path.join(bad, 'long-memory', 'recall-shadow', '2026-10.jsonl'), 'oops\n');
  writeText(path.join(bad, 'long-memory', 'archive', 'private_1', '2026-10.jsonl'), 'oops\n');
  writeText(path.join(bad, 'daily-report', 'counters.json'), 'garbage');
  const r2 = make(bad, now).report;
  const rep2 = await r2.compute('2026-10-30');
  assert.deepEqual(rep2.sessions, {});
  assert.equal(rep2.cost.total, 0);
  assert.equal((await r2.series(3)).days.length, 3);
  assert.doesNotThrow(() => r2.heartbeat());

  // 该是文件的地方是目录
  const dirs = newState();
  const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
  mkdir(path.join(dirs, 'tool-calls.jsonl'));
  mkdir(path.join(dirs, 'token-usage.jsonl'));
  mkdir(path.join(dirs, 'persona', 'usage.json'));
  mkdir(path.join(dirs, 'long-memory', 'rag', 'distill-usage.json'));
  mkdir(path.join(dirs, 'life-loop.json'));
  mkdir(path.join(dirs, 'long-memory', 'recall-shadow', '2026-10.jsonl'));
  mkdir(path.join(dirs, 'long-memory', 'archive', 'private_1', '2026-10.jsonl'));
  mkdir(path.join(dirs, 'daily-report', 'counters.json'));
  mkdir(path.join(dirs, 'daily-report', '2026-10-29.json'));
  const r3 = make(dirs, now).report;
  const rep3 = await r3.compute('2026-10-30');
  assert.deepEqual(rep3.sessions, {});
  assert.equal(r3.read('2026-10-29'), null);
  assert.deepEqual(r3.days(), [], '目录不算快照');
  assert.equal((await r3.series(3)).days.length, 3);
  assert.doesNotThrow(() => r3.flush());
  await r3.snapshotDue();
});

// ── 13. 心跳的区间存储 ────────────────────────────────────────────────────
await test('心跳：连续 120 分钟后只存 1 个区间，文件仍然很小', async () => {
  const state = newState();
  const base = at(2026, 10, 30, 10, 0);
  let clock = base;
  const { report } = make(state, () => clock);
  for (let i = 0; i < 120; i++) {
    clock = base + i * 60000;
    report.heartbeat();
  }
  const countersFile = path.join(state, 'daily-report', 'counters.json');
  const saved = JSON.parse(fs.readFileSync(countersFile, 'utf8'));
  const list = saved.heartbeats['2026-10-30'];
  assert.equal(list.length, 1, '连续心跳只应是一个区间');
  assert.deepEqual(list[0], [base, base + 119 * 60000], '区间两端都含');
  assert.ok(fs.statSync(countersFile).size < 2048, `counters.json 应该只有几百字节，实际 ${fs.statSync(countersFile).size}`);
  const rep = await report.compute('2026-10-30');
  assert.equal(rep.service.longestGapMin, 0);
});

await test('心跳：同一分钟内第二次不写盘，下一分钟才写', async () => {
  const state = newState();
  let clock = at(2026, 10, 30, 10, 0);
  const { report } = make(state, () => clock);
  const original = fs.renameSync;
  let writes = 0;
  try {
    // 打桩 fs.renameSync：原子的写盘最后一步是 rename，用它数写盘次数。
    fs.renameSync = (...args) => { writes++; return original.apply(fs, args); };
    report.heartbeat();
    assert.equal(writes, 1, '第一次心跳要写盘');
    writes = 0;
    report.heartbeat();
    assert.equal(writes, 0, '同一分钟不应再写盘');
    clock += 60000;
    report.heartbeat();
    assert.equal(writes, 1, '下一分钟延区间时要写盘');
  } finally {
    fs.renameSync = original;
  }
});

await test('心跳：旧格式（每分钟一个点）也能读并算对中断', async () => {
  const state = newState();
  const points = [];
  for (let m = 0; m <= 10; m++) points.push(at(2026, 10, 30, 10, m));
  for (let m = 40; m <= 45; m++) points.push(at(2026, 10, 30, 10, m));
  writeJson(path.join(state, 'daily-report', 'counters.json'), {
    version: 1,
    days: { '2026-10-30': { error: 2, ownLifeDay: 3, ownLifeMidnight: 0, injectOn: 0 } },
    heartbeats: { '2026-10-30': points }
  });
  const { report } = make(state, at(2026, 10, 30, 10, 45));
  const rep = await report.compute('2026-10-30');
  assert.equal(rep.partial, false);
  assert.equal(rep.service.errors, 2);
  assert.equal(rep.service.longestGapMin, 29, '旧格式的 10:10 → 10:40 同样是 29');
});

// ── 14. 过去日子的结果缓存 ────────────────────────────────────────────────
await test('过去日子缓存：第二次 series 不再扫文件，11 分钟后重新扫', async () => {
  const state = newState();
  const today = '2026-10-30';
  let clock = at(2026, 10, 30, 12, 0);
  writeJsonl(archivePath(state, 'private_111', '2026-10'), [
    { t: iso(2026, 10, 30, 9, 0, 0), dir: 'out', text: '今天好呀' },
    { t: iso(2026, 10, 28, 9, 0, 0), dir: 'out', text: '前天好呀' }
  ]);
  writeJsonl(path.join(state, 'tool-calls.jsonl'), [
    {
      type: 'call', time: iso(2026, 10, 28, 10, 0), key: 'private:111', sessionId: 's1',
      tool: 'mcp__snowluma__qq_ltm_remember'
    }
  ]);
  writeJsonl(path.join(state, 'token-usage.jsonl'), [
    {
      k: 'turn', t: at(2026, 10, 28, 10, 0), sid: 's1', key: 'private:111',
      turn: 1, step: 1, retry: 0, model: 'deepseek-flash', b: { output: 1 }
    }
  ]);

  let scans = 0;
  const { report } = make(state, () => clock, {
    onScan: (kind, day) => {
      if (day !== today && (kind === 'tool-calls' || kind === 'token-usage')) scans++;
    }
  });

  await report.series(14);
  assert.ok(scans > 0, '第一次要扫过去日子的文件');

  scans = 0;
  await report.series(14);
  assert.equal(scans, 0, '10 分钟内第二次不再扫过去日子的文件');

  clock += 11 * 60000;
  scans = 0;
  await report.series(14);
  assert.ok(scans > 0, '过了 10 分钟缓存失效，重新扫');
});

// ── 15. SUGGEST_PATCH：账本建议（contract §4）───────────────────────────────
await test('账本建议：suggestCreated 读 distill-usage 的 notes，没这个键是 null', async () => {
  const state = newState();
  writeJson(path.join(state, 'long-memory', 'rag', 'distill-usage.json'), {
    version: 1,
    days: {
      '2026-10-30': { calls: 40, ok: 39, failed: 1, cost: 0.1, notes: 9, notes_dropped: 2, backfill_calls: 3 },
      '2026-10-29': { calls: 10, ok: 10, failed: 0, cost: 0.02 },
      '2026-10-27': { calls: 1, ok: 1, failed: 0, cost: 0, notes: null }
    }
  });
  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const today = await report.compute('2026-10-30');
  assert.equal(today.memory.suggestCreated, 9);
  const yesterday = await report.compute('2026-10-29');
  assert.equal(yesterday.memory.suggestCreated, null, '老日期没有 notes 键 → null，不是 0');
  const older = await report.compute('2026-10-28');
  assert.equal(older.memory.suggestCreated, null, '那天没有条目 → null');
  const nullNotes = await report.compute('2026-10-27');
  assert.equal(nullNotes.memory.suggestCreated, null, 'notes 明写 null → null，不是 0');
});

await test('账本建议：状态文件按 statusAt 的本地自然日分天计数（23:59 / 00:01 边界）', async () => {
  const state = newState();
  writeJson(path.join(state, 'long-memory', 'suggest-state.json'), {
    version: 1,
    items: {
      a1: { key: 'private:111', who: '111', cat: 'fact', shown: 1, status: 'adopted', firstSeenAt: at(2026, 10, 30, 9, 0), lastShownAt: at(2026, 10, 30, 9, 0), statusAt: at(2026, 10, 30, 23, 59, 30) },
      a2: { key: 'private:111', who: '111', cat: 'fact', shown: 1, status: 'adopted', firstSeenAt: at(2026, 10, 30, 9, 0), lastShownAt: at(2026, 10, 30, 9, 0), statusAt: at(2026, 10, 31, 0, 1, 0) },
      d1: { key: 'group:222', who: '222', cat: 'trait', shown: 2, status: 'duplicate', firstSeenAt: at(2026, 10, 30, 9, 0), lastShownAt: at(2026, 10, 30, 9, 0), statusAt: at(2026, 10, 30, 12, 0) },
      e1: { key: 'group:222', who: '222', cat: 'trait', shown: 2, status: 'expired', firstSeenAt: at(2026, 10, 30, 9, 0), lastShownAt: at(2026, 10, 30, 9, 0), statusAt: at(2026, 10, 30, 23, 59, 59) },
      e2: { key: 'group:222', who: '222', cat: 'trait', shown: 2, status: 'expired', firstSeenAt: at(2026, 10, 28, 9, 0), lastShownAt: at(2026, 10, 28, 9, 0), statusAt: at(2026, 10, 28, 9, 0) },
      x1: { key: 'private:111', who: '111', cat: 'event', shown: 1, status: 'dismissed', firstSeenAt: at(2026, 10, 30, 9, 0), lastShownAt: at(2026, 10, 30, 9, 0), statusAt: at(2026, 10, 30, 23, 59, 59) },
      o1: { key: 'private:111', who: '111', cat: 'event', shown: 0, status: 'open', firstSeenAt: at(2026, 10, 30, 9, 0), lastShownAt: null, statusAt: null }
    }
  });
  // 状态文件不是数据来源：没有存档 / 工具调用，也照样能算出来源是它自己的字段。
  const { report } = make(state, at(2026, 10, 31, 12, 0));
  const d30 = await report.compute('2026-10-30');
  assert.equal(d30.memory.suggestAdopted, 1, '23:59:30 算 10-30');
  assert.equal(d30.memory.suggestDuplicate, 1);
  assert.equal(d30.memory.suggestExpired, 1, '23:59:59 算 10-30，00:01 那条不算');
  assert.equal(d30.memory.suggestDismissed, 1);
  const d31 = await report.compute('2026-10-31');
  assert.equal(d31.memory.suggestAdopted, 1, '00:01 算第二天');
  assert.equal(d31.memory.suggestDuplicate, 0);
  assert.equal(d31.memory.suggestExpired, 0);
  assert.equal(d31.memory.suggestDismissed, 0);
  const d28 = await report.compute('2026-10-28');
  assert.equal(d28.memory.suggestExpired, 1);
  assert.equal(d28.memory.suggestAdopted, 0);
  // 「待处理」没有 statusAt，不计在任何一天
  assert.equal(d30.memory.suggestAdopted + d30.memory.suggestDuplicate + d30.memory.suggestExpired + d30.memory.suggestDismissed, 4);
});

await test('账本建议：状态文件不存在 / 坏 JSON / 没有 items → 四个计数都是 null', async () => {
  const state = newState();
  const file = path.join(state, 'long-memory', 'suggest-state.json');

  let { report } = make(state, at(2026, 10, 30, 12, 0));
  let rep = await report.compute('2026-10-30');
  assert.equal(rep.memory.suggestAdopted, null, '文件不存在');
  assert.equal(rep.memory.suggestDuplicate, null);
  assert.equal(rep.memory.suggestExpired, null);
  assert.equal(rep.memory.suggestDismissed, null);

  writeText(file, '{ this is not json');
  ({ report } = make(state, at(2026, 10, 30, 12, 0)));
  rep = await report.compute('2026-10-30');
  assert.equal(rep.memory.suggestAdopted, null, '坏 JSON');
  assert.equal(rep.memory.suggestDismissed, null);

  writeJson(file, { version: 1 });
  ({ report } = make(state, at(2026, 10, 30, 12, 0)));
  rep = await report.compute('2026-10-30');
  assert.equal(rep.memory.suggestAdopted, null, '没有 items');
  assert.equal(rep.memory.suggestExpired, null);

  writeJson(file, { version: 1, items: {} });
  ({ report } = make(state, at(2026, 10, 30, 12, 0)));
  rep = await report.compute('2026-10-30');
  assert.equal(rep.memory.suggestAdopted, 0, '文件在、但没有条目 → 0 而不是 null');

  // 什么都读不到的空 state 目录：同样是 null，不是 0
  const blank = newState();
  const rep0 = await make(blank, at(2026, 10, 30, 12, 0)).report.compute('2026-10-30');
  assert.equal(rep0.memory.suggestCreated, null);
  assert.equal(rep0.memory.suggestAdopted, null);
  assert.equal(rep0.memory.suggestExpired, null);
});

await test('账本建议：快照里只有数字，没有候选原文', async () => {
  const state = newState();
  writeJson(path.join(state, 'long-memory', 'suggest-state.json'), {
    version: 1,
    items: {
      s1: {
        key: 'private:111', who: '111', cat: 'fact', shown: 1, status: 'adopted',
        firstSeenAt: at(2026, 10, 29, 9, 0), lastShownAt: at(2026, 10, 29, 9, 0), statusAt: at(2026, 10, 29, 10, 0),
        // 状态文件本来就不该有原文；这里故意混进去一条，确认报表没有把任何多出来的字段抄进快照。
        text: '紫色长颈鹿说的秘密'
      }
    }
  });
  writeJson(path.join(state, 'long-memory', 'rag', 'distill-usage.json'), {
    days: { '2026-10-29': { calls: 2, ok: 2, failed: 0, cost: 0.01, notes: 1 } }
  });

  const { report } = make(state, at(2026, 10, 30, 12, 0));
  const written = await report.snapshotDue();
  assert.ok(written.includes('2026-10-29'), '昨天那份要写出来');

  const raw = fs.readFileSync(path.join(state, 'daily-report', '2026-10-29.json'), 'utf8');
  assert.ok(!raw.includes('紫色长颈鹿'), '快照里不能有候选原文');
  assert.ok(!raw.includes('"text"'));
  const snap = JSON.parse(raw);
  assert.equal(snap.memory.suggestCreated, 1);
  assert.equal(snap.memory.suggestAdopted, 1);
  assert.equal(snap.memory.suggestDuplicate, 0);
  assert.deepEqual(Object.keys(snap.memory).filter((k) => k.startsWith('suggest')).sort(), [
    'suggestAdopted', 'suggestCreated', 'suggestDismissed', 'suggestDuplicate', 'suggestExpired'
  ]);
});

// ── 收尾 ──────────────────────────────────────────────────────────────────
// 日志里不应该出现聊天原文（测试里用到的独特词）
await test('全部日志都不带聊天原文', async () => {
  const joined = ALL_LOGS.join('\n');
  assert.ok(!joined.includes('紫色长颈鹿'));
  assert.ok(!joined.includes('蓝色独角兽'));
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
