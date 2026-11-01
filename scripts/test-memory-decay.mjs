// src/memory-decay.js 的单测（DECAY_PATCH，子项目 2 · 规格 docs/design/MEMORY_DECAY_SPEC.md §2～§6）。
//
// 全用假时钟 + 临时目录：不读 state/、不联网、不依赖项目里其它模块。
// 重点钉住：公式（t = S 时 R = 0.9、§2 示例表的数字、顺利 / 费劲后 S 的增长与夹紧、难度更新）、
// 冻结线与豁免、冷却、状态文件的原子写 / 600 / 不带原文、坏文件与写不进去时不抛异常。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMemoryDecay,
  retrievability,
  nextStability,
  nextDifficulty,
  initialStability,
  initialDifficulty,
  ltmUnitMeta,
  msgUnitMeta,
  diaryUnitMeta,
} from '../src/memory-decay.js';
import { assertPosixMode } from './test-mode.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const MIN = 60000;
const DAY = 86400000;
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const near = (actual, expected, msg = '', eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `${msg} 实际 ${actual}，期望 ${expected}`);

const TMP_DIRS = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decay-test-'));
  TMP_DIRS.push(dir);
  return dir;
}

// 所有实例的日志汇总：最后一条用例要确认里面没有任何原文。
const ALL_LOG_LINES = [];

/** 临时 statePath 的实例 + 可拨的假时钟。 */
function make({ logs = [], options = {}, statePath = null } = {}) {
  const clock = { t: NOW };
  const sp = statePath ?? path.join(tempDir(), 'memory-decay.json');
  const decay = createMemoryDecay({
    statePath: sp,
    now: () => clock.t,
    log: (line) => { logs.push(line); ALL_LOG_LINES.push(line); },
    options,
  });
  return { decay, clock, statePath: sp, logs };
}

// ── 1. 可提取度 ─────────────────────────────────────────────────────────────
await test('retrievability：t = S 时 R = 0.9；0 天 = 1；负数 / 非有限当 0', async () => {
  for (const S of [3, 7, 14, 30]) near(retrievability(S, S), 0.9, `S=${S}`);
  assert.equal(retrievability(0, 7), 1);
  assert.equal(retrievability(-5, 7), 1);
  assert.equal(retrievability(NaN, 7), 1);
  assert.equal(retrievability(undefined, 7), 1);
  // S 不合法按 S_MIN
  near(retrievability(0.5, 0), retrievability(0.5, 0.5), 'S=0 当 S_MIN');
  near(retrievability(0.5, NaN), retrievability(0.5, 0.5), 'S=NaN 当 S_MIN');
});

// ── 2. 规格 §2 的示例表 ────────────────────────────────────────────────────
await test('规格 §2 示例表：30 / 90 天后的 R 与冻结天数', async () => {
  const round2 = (x) => Math.round(x * 100) / 100;
  const after30 = { 3: 0.55, 7: 0.71, 14: 0.82, 30: 0.9 };
  const after90 = { 3: 0.35, 7: 0.5, 14: 0.63, 30: 0.77 };
  for (const [S, want] of Object.entries(after30)) {
    assert.equal(round2(retrievability(30, Number(S))), want, `S=${S} 30 天`);
    assert.equal(round2(retrievability(90, Number(S))), after90[S], `S=${S} 90 天`);
  }
  const freezeDay = (S) => {
    let d = 0;
    while (retrievability(d, S) >= 0.5 && d < 5000) d += 1;
    return d;
  };
  const ranges = { 3: [38, 39], 7: [89, 90], 14: [179, 180], 30: [383, 384] };
  for (const [S, [lo, hi]] of Object.entries(ranges)) {
    const d = freezeDay(Number(S));
    assert.ok(d >= lo && d <= hi, `S=${S} 冻结在第 ${d} 天，期望 ${lo}～${hi}`);
  }
});

// ── 3. 顺利 / 费劲想起后的牢固度 ──────────────────────────────────────────
await test('nextStability：§2 的数字、R = 1 不变、夹紧到 3650', async () => {
  const R60 = retrievability(60, 7);
  near(R60, 0.576, '第 60 天 R', 1e-3);
  near(nextStability(7, 5.5, R60, 'good'), 84.4, 'D=5.5 good', 0.2);
  near(nextStability(7, 5.5, R60, 'hard'), 24.9, 'D=5.5 hard', 0.2);
  near(nextStability(7, 3.2, R60, 'good'), 116.7, 'D=3.2 good', 0.2);
  near(nextStability(7, 3.2, R60, 'hard'), 32.4, 'D=3.2 hard', 0.2);
  near(nextStability(7, 5.5, 1, 'good'), 7, 'R = 1 不增长');
  near(nextStability(7, 5.5, 1, 'hard'), 7, 'R = 1 不增长（费劲）');
  assert.equal(nextStability(3000, 5.5, 0.3, 'good'), 3650);
});

// ── 4. 难度更新 ───────────────────────────────────────────────────────────
await test('nextDifficulty：费劲变大、顺利基本不变、夹在 [1, 10]', async () => {
  near(nextDifficulty(5, 'hard'), 5.7994, 'hard', 1e-3);
  near(nextDifficulty(5, 'good'), 4.9918, 'good', 1e-3);
  assert.ok(nextDifficulty(9.99, 'hard') <= 10);
  assert.ok(nextDifficulty(1, 'good') >= 1);
  assert.ok(nextDifficulty(10, 'hard') <= 10);
});

// ── 5. 起点牢固度 ─────────────────────────────────────────────────────────
await test('initialStability：类别、主人加成、消息按判读、日记', async () => {
  assert.equal(initialStability({ kind: 'ltm', cat: 'event', owner: true }), 21);
  assert.equal(initialStability({ kind: 'ltm', cat: 'fact', owner: false }), 7);
  assert.equal(initialStability({ kind: 'ltm', cat: 'trait' }), 7);
  assert.equal(initialStability({ kind: 'ltm', cat: 'pending' }), 14);
  assert.equal(initialStability({ kind: 'ltm', cat: 'event' }), 14);
  assert.equal(initialStability({ kind: 'ltm', cat: 'note' }), 3);
  assert.equal(initialStability({ kind: 'ltm', cat: 'unknown' }), 7);
  near(initialStability({ kind: 'msg' }), 8.67, '没有判读');
  assert.equal(initialStability({ kind: 'msg', salience: 1, intensity: 1 }), 30);
  assert.equal(initialStability({ kind: 'msg', salience: 0, intensity: 0 }), 3);
  assert.equal(initialStability({ kind: 'diary' }), 7);
  assert.equal(initialStability({}), 7);
});

// ── 6. 起点难度 ───────────────────────────────────────────────────────────
await test('initialDifficulty：按亲密度，没有数据 5.5，日记 5', async () => {
  near(initialDifficulty({ kind: 'ltm', intimacy: 72 }), 3.2, 'ltm 72');
  near(initialDifficulty({ kind: 'msg', intimacy: 72 }), 3.2, 'msg 72');
  assert.equal(initialDifficulty({ kind: 'ltm', intimacy: 0 }), 8);
  assert.equal(initialDifficulty({ kind: 'ltm', intimacy: 100 }), 2);
  assert.equal(initialDifficulty({ kind: 'ltm' }), 5.5);
  assert.equal(initialDifficulty({ kind: 'msg', intimacy: undefined }), 5.5);
  assert.equal(initialDifficulty({ kind: 'diary' }), 5);
  assert.equal(initialDifficulty({}), 5.5);
});

// ── 7. meta 构造函数 ──────────────────────────────────────────────────────
await test('ltmUnitMeta：豁免规则、owner 判断、不带原文', async () => {
  const at = iso(NOW);
  assert.equal(ltmUnitMeta({ cat: 'fact', core: true, at }).exempt, true, 'core');
  assert.equal(ltmUnitMeta({ cat: 'pending', at }).exempt, true, 'pending 缺省 open');
  assert.equal(ltmUnitMeta({ cat: 'pending', status: 'open', at }).exempt, true, 'pending open');
  assert.equal(ltmUnitMeta({ cat: 'pending', status: 'done', at }).exempt, false, 'pending done');
  assert.equal(ltmUnitMeta({ cat: 'fact', at }).exempt, false);

  assert.equal(ltmUnitMeta({ cat: 'fact', at }, { ownerQQ: '2001', userId: '2001' }).owner, true);
  assert.equal(ltmUnitMeta({ cat: 'fact', at }, { ownerQQ: '2001', userId: 2001 }).owner, true, '数字 QQ 号');
  assert.equal(ltmUnitMeta({ cat: 'fact', at }, { ownerQQ: '2001', userId: '3003' }).owner, false);
  assert.equal(ltmUnitMeta({ cat: 'fact', at }, {}).owner, false);
  assert.equal(ltmUnitMeta({ cat: 'fact', at }, { userId: '2001' }).owner, false, '没有 ownerQQ');

  const secret = '那天晚上在海边捡到一只小螃蟹';
  const meta = ltmUnitMeta({ id: 'a1', cat: 'fact', core: true, at, text: secret }, { intimacy: 72 });
  assert.ok(!('text' in meta), '不能带 text 键');
  assert.doesNotMatch(JSON.stringify(meta), /螃蟹/);
  assert.equal(meta.kind, 'ltm');
  assert.equal(meta.createdAt, NOW);
  assert.equal(meta.cat, 'fact');
  assert.equal(meta.intimacy, 72);
  assert.equal(ltmUnitMeta({ cat: 'fact', at }, { intimacy: '' }).intimacy, undefined);
  assert.equal(ltmUnitMeta({ cat: 'fact', at }, { intimacy: null }).intimacy, undefined);
  assert.equal(ltmUnitMeta({ cat: 'fact', at }, { intimacy: 'abc' }).intimacy, undefined);
  assert.equal(ltmUnitMeta(null, {}).createdAt, NaN);
});

await test('msgUnitMeta / diaryUnitMeta：起点时间、默认值', async () => {
  const row = { t: iso(NOW - DAY), dir: 'in', text: '今天很想你' };
  const m = msgUnitMeta(row, { salience: 0.8, intensity: 0.4, intimacy: 30 });
  assert.equal(m.kind, 'msg');
  assert.equal(m.createdAt, NOW - DAY);
  assert.equal(m.exempt, false);
  assert.equal(m.salience, 0.8);
  assert.equal(m.intensity, 0.4);
  assert.equal(m.intimacy, 30);
  assert.ok(!('text' in m));
  const d = msgUnitMeta(row);
  assert.equal(d.salience, undefined);
  assert.equal(d.intensity, undefined);
  assert.equal(d.intimacy, undefined);
  const dm = diaryUnitMeta({ t: NOW, text: '日记正文' });
  assert.deepEqual(dm, { kind: 'diary', createdAt: NOW, exempt: false });
});

// ── 8. 没有记录时的 state：不写盘、冻结线、豁免 ───────────────────────────
await test('state 没有记录：不创建文件；89 天不冻结、91 天冻结；core 永不冻结', async () => {
  const { decay, statePath } = make();
  const fact89 = decay.ltmMeta({ cat: 'fact', at: iso(NOW - 89 * DAY) }, {});
  const s89 = decay.state('ltm:f89', fact89);
  assert.ok(s89);
  assert.equal(s89.frozen, false);
  assert.equal(s89.exempt, false);
  assert.equal(s89.reps, 0);
  assert.equal(s89.D, 5.5);
  assert.ok(!fs.existsSync(statePath), 'state 不该写盘');

  const s91 = decay.state('ltm:f91', decay.ltmMeta({ cat: 'fact', at: iso(NOW - 91 * DAY) }, {}));
  assert.equal(s91.frozen, true);

  const s400 = decay.state('ltm:c1', decay.ltmMeta({ cat: 'fact', core: true, at: iso(NOW - 400 * DAY) }, {}));
  assert.equal(s400.frozen, false);
  assert.equal(s400.exempt, true);
  assert.ok(s400.R < 0.5, 'R 已经掉到冻结线以下，但豁免');
  assert.ok(!fs.existsSync(statePath), '仍然是 state，不写盘');
});

// ── 9. review：解冻、写盘、600、冷却 ──────────────────────────────────────
await test('review：冻结后复习解冻，文件 600 且无原文，1 小时内冷却', async () => {
  const { decay, clock, statePath } = make();
  const secret = '那天晚上在海边捡到一只小螃蟹';
  const meta = decay.ltmMeta({ id: 'r1', cat: 'fact', at: iso(NOW - 200 * DAY), text: secret }, {});
  assert.equal(decay.state('ltm:r1', meta).frozen, true);

  const after = decay.review('ltm:r1', meta, 'hard');
  assert.ok(after);
  assert.equal(after.R, 1);
  assert.equal(after.frozen, false);
  assert.equal(after.reps, 1);
  assert.ok(fs.existsSync(statePath), '第一次复习要落盘');
  assertPosixMode(statePath, 0o600, '权限 600');
  const raw = fs.readFileSync(statePath, 'utf8');
  assert.doesNotMatch(raw, /螃蟹/);
  assert.match(raw, /"version":1/);
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved.units), ['ltm:r1']);
  assert.deepEqual(Object.keys(saved.units['ltm:r1']).sort(), ['D', 'S', 'hard', 'last', 'reps']);

  const S = after.S;
  clock.t = NOW + 30 * MIN;
  assert.equal(decay.review('ltm:r1', meta, 'good'), false, '30 分钟内冷却');
  assert.equal(decay.state('ltm:r1', meta).S, S, '冷却时 S 不变');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).units['ltm:r1'].S, S);

  clock.t = NOW + 61 * MIN;
  const again = decay.review('ltm:r1', meta, 'good');
  assert.ok(again);
  assert.equal(again.reps, 2);
  assert.ok(again.S > S, '顺利想起后更牢');
});

// ── 10. 非法输入 ──────────────────────────────────────────────────────────
await test('非法 rating / unitId：返回 false / null，绝不抛异常', async () => {
  const { decay, statePath } = make();
  const meta = decay.ltmMeta({ cat: 'fact', at: iso(NOW) }, {});
  for (const rating of ['again', 'easy', '', null, undefined, 3]) {
    assert.equal(decay.review('ltm:ok', meta, rating), false, `rating=${String(rating)}`);
  }
  const badIds = ['', 'foo:1', `ltm:${'x'.repeat(197)}`]; // 201 字
  for (const id of badIds) {
    assert.equal(decay.state(id, meta), null, `state(${id.length} 字)`);
    assert.equal(decay.review(id, meta, 'good'), false);
    assert.equal(decay.drop(id), false);
  }
  assert.equal(decay.state(null, meta), null);
  assert.equal(decay.state(123, meta), null);
  assert.equal(decay.state({}, meta), null);
  // 边界：正好 200 字是合法的
  assert.ok(decay.state(`ltm:${'x'.repeat(196)}`, meta));
  assert.ok(!fs.existsSync(statePath), '全都没写成记录');
});

// ── 11. 持久化 ────────────────────────────────────────────────────────────
await test('持久化：第二个实例读回同样的 S / D / reps', async () => {
  const a = make();
  const meta = a.decay.ltmMeta({ cat: 'event', at: iso(NOW - 30 * DAY) }, { intimacy: 40 });
  const first = a.decay.review('ltm:p1', meta, 'good');
  assert.ok(first);
  const b = make({ statePath: a.statePath });
  const back = b.decay.state('ltm:p1', meta);
  assert.equal(back.S, first.S);
  assert.equal(back.D, first.D);
  assert.equal(back.reps, 1);
  near(back.R, 1, '同一时刻读回 R = 1');
});

// ── 12. 坏状态文件 ────────────────────────────────────────────────────────
await test('坏文件当空状态；单条坏记录只丢这一条', async () => {
  const broken = path.join(tempDir(), 'memory-decay.json');
  fs.writeFileSync(broken, '{bad json');
  const b = make({ statePath: broken });
  assert.equal(b.decay.snapshot().units, 0);
  assert.deepEqual(b.decay.snapshot().byKind, { ltm: 0, msg: 0, diary: 0 });
  // 空状态仍然能算（用 meta 现算）
  assert.ok(b.decay.state('ltm:x', b.decay.ltmMeta({ cat: 'fact', at: iso(NOW) }, {})));

  const mixed = path.join(tempDir(), 'memory-decay.json');
  fs.writeFileSync(mixed, JSON.stringify({
    version: 1,
    units: {
      'ltm:ok': { S: 10, D: 5, last: NOW, reps: 1, hard: 0 },
      'ltm:bad': { S: 'x', D: 5, last: NOW, reps: 1 },
      'msg:bad2': { S: 10, D: 'y', last: NOW, reps: 1 },
      'diary:bad3': { S: 10, D: 5, last: null, reps: 1 },
      'nope': { S: 10, D: 5, last: NOW },
    },
  }));
  const m = make({ statePath: mixed });
  assert.equal(m.decay.snapshot().units, 1);
  assert.equal(m.decay.state('ltm:ok', m.decay.ltmMeta({ cat: 'fact', at: iso(NOW) }, {})).S, 10);
});

// ── 13. 写不进去 ──────────────────────────────────────────────────────────
await test('父路径是普通文件：review 不抛异常，只记一行 [decay] 日志', async () => {
  const dir = tempDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const logs = [];
  const decay = createMemoryDecay({
    statePath: path.join(blocker, 'memory-decay.json'),
    now: () => NOW,
    log: (line) => { logs.push(line); ALL_LOG_LINES.push(line); },
  });
  const meta = decay.ltmMeta({ cat: 'fact', at: iso(NOW) }, {});
  let out;
  assert.doesNotThrow(() => { out = decay.review('ltm:w1', meta, 'good'); });
  assert.ok(out === false || (out && typeof out === 'object'), '返回状态对象或 false');
  assert.equal(typeof out, 'object', '本实现返回状态对象（内存更新保留）');
  assert.match(logs.join('\n'), /\[decay\]/);
  // 内存里的记录仍在：再读状态是复习过的
  assert.equal(decay.state('ltm:w1', meta).reps, 1);
});

// ── 14. drop 与 snapshot ──────────────────────────────────────────────────
await test('drop：删记录、写盘、byKind 计数', async () => {
  const { decay, statePath } = make();
  const ltm = decay.ltmMeta({ cat: 'fact', at: iso(NOW) }, {});
  const msg = decay.msgMeta({ t: iso(NOW) }, {});
  const diary = decay.diaryMeta({ t: NOW });
  assert.ok(decay.review('ltm:a', ltm, 'good'));
  assert.ok(decay.review('msg:b', msg, 'good'));
  assert.ok(decay.review('diary:c', diary, 'good'));
  assert.deepEqual(decay.snapshot(), { units: 3, byKind: { ltm: 1, msg: 1, diary: 1 }, freezeBelow: 0.5 });

  assert.equal(decay.drop('ltm:a'), true);
  assert.equal(decay.snapshot().units, 2);
  assert.deepEqual(decay.snapshot().byKind, { ltm: 0, msg: 1, diary: 1 });
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(!('ltm:a' in saved.units), '文件里也不该有这条');
  assert.deepEqual(Object.keys(saved.units).sort(), ['diary:c', 'msg:b']);
  assert.equal(decay.drop('ltm:a'), false, '已经删了');
  assert.equal(decay.drop('ltm:never'), false);
});

// ── 15. options ───────────────────────────────────────────────────────────
await test('options：freezeBelow 可调、非法值回退、reviewCooldownMs = 0 连评两次都生效', async () => {
  const high = make({ options: { freezeBelow: 0.7 } });
  const meta40 = high.decay.ltmMeta({ cat: 'fact', at: iso(NOW - 40 * DAY) }, {});
  const s = high.decay.state('ltm:h1', meta40);
  assert.ok(s.R > 0.6 && s.R < 0.7, `40 天 R ≈ 0.65，实际 ${s.R}`);
  assert.equal(s.frozen, true);
  assert.equal(high.decay.freezeBelow, 0.7);

  const fallback = make({ options: { freezeBelow: 2 } });
  assert.equal(fallback.decay.freezeBelow, 0.5);
  assert.equal(make({ options: { freezeBelow: 0 } }).decay.freezeBelow, 0.5);
  assert.equal(make({ options: { freezeBelow: NaN } }).decay.freezeBelow, 0.5);
  assert.equal(make({ options: { freezeBelow: 1 } }).decay.freezeBelow, 0.5);

  const noCooldown = make({ options: { reviewCooldownMs: 0 } });
  const meta = noCooldown.decay.ltmMeta({ cat: 'fact', at: iso(NOW) }, {});
  const r1 = noCooldown.decay.review('ltm:n1', meta, 'good');
  const r2 = noCooldown.decay.review('ltm:n1', meta, 'hard');
  assert.ok(r1 && r2, '冷却 0 时两次都生效');
  assert.equal(r2.reps, 2);

  // 非法冷却值回退 1 小时
  const badCool = make({ options: { reviewCooldownMs: -1 } });
  const m2 = badCool.decay.ltmMeta({ cat: 'fact', at: iso(NOW) }, {});
  assert.ok(badCool.decay.review('ltm:n2', m2, 'good'));
  assert.equal(badCool.decay.review('ltm:n2', m2, 'good'), false);
  assert.equal(badCool.decay.review('ltm:n3', m2, 'good') && badCool.decay.review('ltm:n3', m2, 'good'), false,
    '默认冷却 1 小时：同一单元连着两次只算一次');
});

// ── 16. 日志里没有原文 ────────────────────────────────────────────────────
await test('所有日志都是 [decay] 开头，且不含任何原文', async () => {
  const joined = ALL_LOG_LINES.join('\n');
  assert.ok(ALL_LOG_LINES.length > 0, '至少有一条日志（写不进去那条）');
  for (const line of ALL_LOG_LINES) assert.match(line, /^\[decay\]/, `日志前缀：${line}`);
  assert.doesNotMatch(joined, /螃蟹/);
  assert.doesNotMatch(joined, /那天晚上在海边/);
  assert.doesNotMatch(joined, /今天很想你/);
  assert.doesNotMatch(joined, /日记正文/);
});

for (const dir of TMP_DIRS) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
}

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
