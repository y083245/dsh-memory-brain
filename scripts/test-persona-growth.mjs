// src/persona-store.js + src/persona-growth.js 的单测（PERSONA_PATCH，子项目 1 任务 4、7、8）。
// 全部用临时目录，不碰 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeSettings, newCore, newPerson } from '../src/persona-state.js';
import { createPersonaStore } from '../src/persona-store.js';
import {
  EVIDENCE_TYPES, CHAR_EVENTS, charEventOf, updateBeliefs, driftCore, driftCharacter, driftOffsets, runNightly, rollbackTo,
  isoWeek, parseFactory, confirmFactory, factoryMessages, seedRelations, weeklyReport
} from '../src/persona-growth.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
async function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-'));
  try { await run(createPersonaStore({ rootDir: dir }), dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const S = mergeSettings({});
const DAY = 86400000;
const T0 = Date.parse('2026-11-01T03:30:00'); // 周日
const ev = (over) => ({ at: T0 - DAY / 2, day: '2026-10-31', about: 'self', type: 'praised', userId: '2001', key: 'private:2001', msgId: '1', gist: '', ...over });

// ── 任务 4：存储 ─────────────────────────────────────────────────────────
await test('store：未初始化时 core 为 null；save/load 往返；文件 600、目录 700', async () => {
  await withStore(async (store, dir) => {
    assert.equal(store.load('小鲸鱼').core, null);
    store.save('小鲸鱼', 'core', newCore({ A: 70 }));
    assert.equal(store.load('小鲸鱼').core.traits.A.value, 70);
    const f = path.join(dir, '小鲸鱼', 'core.json');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, '小鲸鱼')).mode & 0o777, 0o700);
    assert.throws(() => store.save('小鲸鱼', 'bogus', {}), /未知的状态分片/);
  });
});

await test('store：证据按时间过滤；判读日志按会话 / 月份分文件；角色名里的路径字符被替换', async () => {
  await withStore(async (store, dir) => {
    store.appendEvidence('r', ev({ at: 100 }));
    store.appendEvidence('r', ev({ at: 200 }));
    assert.equal(store.readEvidence('r', 150).length, 1);
    store.appendAppraisal('r', 'group:9', { at: Date.parse('2026-11-02T10:00:00'), kind: 'praise' });
    assert.ok(fs.existsSync(path.join(dir, 'r', 'appraisals', 'group_9', '2026-11.jsonl')));
    store.save('../evil', 'meta', {});
    assert.ok(fs.existsSync(path.join(dir, '_evil', 'meta.json')));
  });
});

// ── 任务 7：信念 ─────────────────────────────────────────────────────────
await test('自我信念：3 条、2 天、2 个人才采纳；只有 1 个人不采纳', () => {
  const one = [ev({ day: '2026-10-29' }), ev({ day: '2026-10-30' }), ev({ day: '2026-10-31' })];
  assert.equal(updateBeliefs([], one, { about: 'self', now: T0, settings: S, cap: 10 })[0].status, 'candidate');
  const two = [...one.slice(0, 2), ev({ day: '2026-10-31', userId: '2002', key: 'group:9' })];
  const b = updateBeliefs([], two, { about: 'self', now: T0, settings: S, cap: 10 })[0];
  assert.equal(b.status, 'accepted');
  assert.equal(b.text, EVIDENCE_TYPES.praised.text);
  assert.deepEqual(b.keys.sort(), ['group:9', 'private:2001']);
});

await test('对他的信念不要求多人；45 天没刷新会淡化；先验永不淡化', () => {
  const rows = ['2026-10-29', '2026-10-30', '2026-10-31'].map((day) => ev({ about: 'him', type: 'he_vents', day }));
  const accepted = updateBeliefs([], rows, { about: 'him', now: T0, settings: S, cap: 8 });
  assert.equal(accepted[0].status, 'accepted');
  const later = updateBeliefs([...accepted, { type: 'prior', text: 'x', status: 'accepted', prior: true, refreshedAt: 0 }], [], { about: 'him', now: T0 + 200 * DAY, settings: S, cap: 8 });
  assert.equal(later.find((b) => b.type === 'he_vents').status, 'faded');
  assert.equal(later.find((b) => b.prior).status, 'accepted');
});

await test('信念超出上限时淡化最久没刷新的', () => {
  const list = [1, 2, 3].map((i) => ({ type: `t${i}`, text: `t${i}`, status: 'accepted', prior: false, refreshedAt: T0 - i * DAY, keys: [] }));
  const out = updateBeliefs(list, [], { about: 'self', now: T0, settings: S, cap: 2 });
  assert.equal(out.find((b) => b.type === 't3').status, 'faded');
  assert.equal(out.filter((b) => b.status === 'accepted').length, 2);
});

// ── 任务 8：漂移、夜间结算、回滚、初始化 ──────────────────────────────────
await test('driftCore：每项每天最多 1；锁定不动；离出厂值最多 15', () => {
  const core = newCore({ N: 50, E: 50 });
  core.traits.E.locked = true;
  const people = { 2001: { ...newPerson(), familiarity: 50, intimacy: 80, trust: 100 }, 2002: { ...newPerson(), familiarity: 50, intimacy: 80, trust: 100 } };
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(ev({ userId: i % 2 ? '2001' : '2002' }));
  const r = driftCore(core, rows, people, S);
  assert.equal(r.changes.N, -1);
  assert.equal(r.changes.E, undefined);
  const far = newCore({ N: 50 });
  far.traits.N.value = 35;
  assert.equal(driftCore(far, rows, people, S).core.traits.N.value, 35);
});

await test('driftCore：同一个人一天的贡献最多占一半（单人刷不动太多）', () => {
  const people = { 2001: { ...newPerson(), familiarity: 50, intimacy: 80, trust: 100 } };
  const r = driftCore(newCore({}), [ev({}), ev({})], people, S);
  // 两条「被夸」：N −1×2×权重 1.2 = −2.4，单人减半 → −1.2，再 ×0.5 → −0.6
  assert.equal(r.changes.N, -0.6);
});

await test('driftOffsets：被某人骂，只降对他的宜人偏移', () => {
  const people = { 2001: newPerson(), 2002: newPerson() };
  const r = driftOffsets(people, [ev({ type: 'insulted' }), ev({ type: 'insulted' })], S);
  assert.equal(r.people['2001'].offsets.A, -1);
  assert.equal(r.people['2002'].offsets.A, 0);
});

await test('runNightly：写快照、推进 lastNightlyAt；周日出周报；可回滚', async () => {
  await withStore(async (store) => {
    const state = { core: confirmFactory({ traits: { O: 50, C: 50, E: 50, A: 50, N: 50 }, beliefs: ['我嘴硬'] }, T0 - 10 * DAY), people: { 2001: { ...newPerson(), name: '小满', familiarity: 50, intimacy: 50, trust: 80 } }, meta: { lastNightlyAt: T0 - DAY } };
    for (const day of ['2026-10-29', '2026-10-30', '2026-10-31']) store.appendEvidence('r', ev({ day, at: T0 - DAY / 2 }));
    const r = runNightly({ store, role: 'r', state, settings: S, now: T0 });
    assert.equal(state.meta.lastNightlyAt, T0);
    assert.ok(r.changes.core.N < 0);
    assert.ok(store.readSnapshot('r', r.day));
    assert.ok(r.report, '周日应出周报');
    assert.match(r.report.markdown, /被真心夸/);
    assert.deepEqual(store.listReports('r'), [isoWeek(T0)]);
    const back = rollbackTo({ store, role: 'r', day: r.day });
    assert.equal(back.core.traits.N.value, r.core.traits.N.value);
    assert.throws(() => rollbackTo({ store, role: 'r', day: '1999-01-01' }), /没有/);
  });
});

await test('parseFactory / confirmFactory / factoryMessages', () => {
  const f = parseFactory({ traits: { O: 70.4, C: 40, E: 30, A: 35, N: 120 }, beliefs: ['我嘴硬但其实在意', ''] });
  assert.deepEqual(f.traits, { O: 70, C: 40, E: 30, A: 35, N: 100 });
  assert.deepEqual(f.beliefs, ['我嘴硬但其实在意']);
  assert.throws(() => parseFactory({ traits: { O: 1 } }), /缺少 C/);
  const core = confirmFactory(f, T0);
  assert.equal(core.traits.N.factory, 100);
  assert.equal(core.beliefs[0].prior, true);
  assert.equal(factoryMessages('角色卡').length, 2);
});

// ── 人格档案 v2 §2.2：后天性格的事件与漂移 ────────────────────────────────
const charEv = (over) => ({ at: T0 - DAY / 2, day: '2026-10-31', about: 'char', type: 'praise', userId: '2001', key: 'private:2001', derived: true, ...over });
const me = (over) => ({ target: 'me', kind: 'normal', pad: { p: 0 }, emotion: { label: '' }, ...over });

await test('CHAR_EVENTS / charEventOf：各分支；target 不是 me 一律 null', () => {
  assert.deepEqual(Object.keys(CHAR_EVENTS).sort(), ['apology', 'care', 'ignored', 'insult', 'praise', 'tease_fun', 'tease_hurt', 'vent']);
  assert.equal(charEventOf(me({ kind: 'insult' })), 'insult');
  assert.equal(charEventOf(me({ kind: 'apology' })), 'apology');
  assert.equal(charEventOf(me({ kind: 'praise' })), 'praise');
  assert.equal(charEventOf(me({ kind: 'care' })), 'care');
  assert.equal(charEventOf(me({ kind: 'vent' })), 'vent');
  assert.equal(charEventOf(me({ kind: 'ignore' })), 'ignored');
  assert.equal(charEventOf(me({ kind: 'tease' })), 'tease_fun');
  assert.equal(charEventOf(me({ kind: 'tease', pad: { p: -1 } })), 'tease_hurt', 'p 为负算被戳到');
  assert.equal(charEventOf(me({ kind: 'tease', emotion: { label: '委屈' } })), 'tease_hurt', '负面标签算被戳到');
  assert.equal(charEventOf(me({ kind: 'tease', trigger: 'p2' }), [{ id: 'p2', valence: 'dislike' }]), 'tease_hurt', '戳中雷点算被戳到');
  assert.equal(charEventOf(me({ kind: 'tease', trigger: 'p2' }), [{ id: 'p2', valence: 'like' }]), 'tease_fun');
  assert.equal(charEventOf(me({ kind: 'share' })), null);
  assert.equal(charEventOf(me({ kind: 'normal' })), null);
  assert.equal(charEventOf({ ...me({ kind: 'insult' }), target: 'other' }), null);
  assert.equal(charEventOf({ ...me({ kind: 'insult' }), target: 'none' }), null);
  assert.equal(charEventOf(null), null);
});

await test('driftCharacter：每项每天最多 1；锁定不动；离出厂值最多 15；单人一天最多一半', () => {
  const people = { 2001: { ...newPerson(), familiarity: 50, intimacy: 80, trust: 100 } };
  const core = newCore({}, {});
  // 两条「被夸」：自尊 +1×2×权重 1.2 = 2.4，单人减半 → 1.2，再 ×0.5 → 0.6
  const half = driftCharacter(core, [charEv({}), charEv({})], people, S);
  assert.equal(half.changes.pride, 0.6);
  assert.equal(half.core.character.pride.value, 50.6);
  // 20 条、两个人：每天封顶 1
  const two = { 2001: people[2001], 2002: { ...newPerson(), familiarity: 50, intimacy: 80, trust: 100 } };
  const rows = Array.from({ length: 20 }, (_, i) => charEv({ userId: i % 2 ? '2001' : '2002' }));
  assert.equal(driftCharacter(core, rows, two, S).changes.pride, 1);
  // 锁定
  const locked = newCore({}, { pride: 50 });
  locked.character.pride.locked = true;
  assert.equal(driftCharacter(locked, rows, two, S).changes.pride, undefined);
  // 离出厂值最多 15（出厂 50，当前 64.5 → 封顶 65）
  const near = newCore({}, { pride: 50 });
  near.character.pride.value = 64.5;
  const capped = driftCharacter(near, rows, two, S);
  assert.equal(capped.core.character.pride.value, 65);
  assert.equal(capped.changes.pride, 0.5);
});

await test('driftCharacter：只读 about=char 的行；driftCore 不把 char 行当大五证据', () => {
  const people = { 2001: { ...newPerson(), familiarity: 50, intimacy: 80, trust: 100 } };
  const selfRows = [charEv({ about: 'self', type: 'praise' }), charEv({ about: 'him', type: 'insult' })];
  assert.deepEqual(driftCharacter(newCore({}, {}), selfRows, people, S).changes, {});
  // CHAR_EVENTS 的 ignored 与 EVIDENCE_TYPES 同名：char 行不能被当成本人的「说话没人接」
  assert.deepEqual(driftCore(newCore({}), [charEv({ type: 'ignored' })], people, S).changes, {});
  assert.ok(driftCore(newCore({}), [ev({ type: 'ignored', about: 'self' })], people, S).changes.E < 0, '真正的自证据仍然生效');
});

await test('driftCharacter：v1 core 也能漂移（先升级到 v2）', () => {
  const v1 = { version: 1, traits: newCore({}).traits, beliefs: [], confirmedAt: null };
  const r = driftCharacter(v1, [charEv({})], { 2001: { ...newPerson(), familiarity: 50, intimacy: 80, trust: 100 } }, S);
  assert.equal(r.core.version, 2);
  assert.ok(r.core.character.pride.value > 50);
  assert.equal(v1.version, 1, '不改传进来的对象');
});

await test('runNightly：快照里有 character 变化；周报有「相处习惯」', async () => {
  await withStore(async (store) => {
    const state = { core: confirmFactory({ traits: { O: 50, C: 50, E: 50, A: 50, N: 50 } }, T0 - 10 * DAY), people: { 2001: { ...newPerson(), name: '小满', familiarity: 50, intimacy: 80, trust: 100 } }, meta: { lastNightlyAt: T0 - DAY } };
    for (const at of [T0 - DAY / 2, T0 - DAY / 3]) store.appendEvidence('r', charEv({ at }));
    const r = runNightly({ store, role: 'r', state, settings: S, now: T0 });
    assert.equal(r.changes.character.pride, 0.6);
    assert.equal(r.core.character.pride.value, 50.6);
    const snap = store.readSnapshot('r', r.day);
    assert.equal(snap.changes.character.pride, 0.6);
    assert.equal(snap.core.character.pride.value, 50.6);
    assert.ok(r.report, '周日应出周报');
    assert.match(r.report.markdown, /## 相处习惯/);
    assert.match(r.report.markdown, /- 自尊：\+0\.60/);
  });
});

await test('weeklyReport：相处习惯用中文名；没有变化时写「这周没有变化」', () => {
  const empty = weeklyReport({ snapshots: [{ changes: { character: {} } }], evidence: [], names: {}, now: T0 });
  assert.match(empty, /## 相处习惯\n- 这周没有变化/);
  const moved = weeklyReport({ snapshots: [{ changes: { character: { grudge: -0.5, empathy: 0.5 } } }], evidence: [], names: {}, now: T0 });
  assert.match(moved, /## 相处习惯\n- 记仇：-0\.50\n- 共情：\+0\.50/);
});

await test('weeklyReport：证据段不列 about=char 的派生行', () => {
  const rows = [
    { about: 'char', type: 'ignored', userId: '2001', at: T0, day: '2026-10-31', derived: true },
    ev({ type: 'praised', gist: '夸她聪明' })
  ];
  const md = weeklyReport({ snapshots: [{ changes: {} }], evidence: rows, names: { 2001: '小满' }, now: T0 });
  assert.match(md, /被真心夸/);
  assert.doesNotMatch(md, /说话没人接/);
  assert.doesNotMatch(md, /2026-10-31 小满$/m);
  const onlyChar = weeklyReport({ snapshots: [{ changes: {} }], evidence: [rows[0]], names: { 2001: '小满' }, now: T0 });
  assert.match(onlyChar, /## 证据（每类最多 3 条）\n- 无/);
});

await test('factoryMessages（v2）：提示词写清强度分档、关键词规则与 text 不带前缀', () => {
  const system = factoryMessages('角色卡')[0].content;
  assert.match(system, /0\.85~1/);
  assert.match(system, /一般的讨厌给 0\.5~0\.7/);
  assert.match(system, /特别喜欢的给 0\.75~0\.85/);
  assert.match(system, /至少 2 个字/);
  assert.match(system, /写「小矮子」，不写「矮」/);
  assert.match(system, /不要放容易误伤的普通词或相反含义的词/);
  assert.match(system, /不要带「喜欢 \/ 讨厌」字样/);
  assert.match(system, /character 是后天性格：grudge 记仇（高：/);
});

// ── 人格档案 v2 §5：出厂提取扩展 ─────────────────────────────────────────
await test('parseFactory（v2）：character 缺项 / 非数字按 50；manifests 只留已知键并截到 40 字', () => {
  const f = parseFactory({
    traits: { O: 70, C: 50, E: 50, A: 50, N: 50 },
    character: { grudge: 80, pride: null, empathy: 120 },
    manifests: { O: `  ${'x'.repeat(50)}  `, grudge: 123, bogus: '不认识' },
    prefs: [{ text: '被认真夸', valence: 'like', strength: 0.6, keywords: ['夸'] }, { text: '', valence: 'like' }],
    beliefs: ['我嘴硬']
  });
  assert.deepEqual(f.character, { grudge: 80, clingy: 50, guarded: 50, playful: 50, pride: 50, empathy: 100 });
  assert.equal(f.manifests.O.length, 40);
  assert.equal(f.manifests.grudge, undefined, '非字符串丢掉');
  assert.equal(f.manifests.bogus, undefined, '未知键丢掉');
  assert.equal(f.prefs.length, 1);
  assert.equal(f.prefs[0].id, 'p1');
  assert.throws(() => parseFactory({ traits: { O: 1 }, character: {} }), /出厂值缺少 C/, 'traits 仍然强制');
});

await test('confirmFactory（v2）：manifests 存下出厂档位；prefs 走 normalizePrefs', () => {
  const core = confirmFactory({
    traits: { O: 50, C: 50, E: 50, A: 30, N: 50 },
    character: { grudge: 70, guarded: 50 },
    manifests: { A: '被怼会顶回去', grudge: '生气会闷半天', guarded: '嘴上说没事' },
    prefs: [{ text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'] }],
    beliefs: ['我嘴硬']
  }, T0);
  assert.equal(core.version, 2);
  assert.deepEqual(core.manifests.A, { band: '低', text: '被怼会顶回去' });
  assert.deepEqual(core.manifests.grudge, { band: '高', text: '生气会闷半天' });
  assert.deepEqual(core.manifests.guarded, { band: '中', text: '嘴上说没事' });
  assert.equal(core.prefs[0].id, 'p1');
  assert.equal(core.prefs[0].strength, 0.9);
  assert.equal(core.beliefs[0].prior, true);
  assert.equal(core.confirmedAt, T0);
});

// ── 人格档案 v2 §6.1：A1 关系冷启动 ─────────────────────────────────────
const SEED_STATS = [
  { userId: '2002', name: '小夏', messages: 32, firstSeenAt: '2026-10-20T00:00:00Z', lastSeenAt: '2026-10-21T12:00:00Z' },
  { userId: '100000001', name: '主人', messages: 53, firstSeenAt: '2026-10-20T00:00:00Z', lastSeenAt: '2026-10-22T00:00:00Z' },
  { userId: '3003', name: '路过', messages: 0, firstSeenAt: '2026-10-20T00:00:00Z', lastSeenAt: '2026-10-20T00:00:00Z' },
  { userId: 'abc', name: '不是数字', messages: 99, firstSeenAt: '', lastSeenAt: '' }
];

await test('seedRelations：§6.1 的两个例子算出精确值；主人排第一；跳过 0 条的非主人', () => {
  const out = seedRelations(SEED_STATS, { ownerQQ: 100000001, now: T0, people: {} });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.userId), ['100000001', '2002'], '主人排第一，其余按消息数降序');
  assert.equal(out[0].isOwner, true);
  assert.equal(out[0].messages, 53);
  assert.deepEqual(out[0].after, { familiarity: 60, intimacy: 72, trust: 72 }, '熟悉 46 → 60 保底');
  assert.equal(out[0].stageBefore, '陌生');
  assert.equal(out[0].stageAfter, '亲近');
  assert.equal(out[0].changed, true);
  assert.equal(out[0].before, null);
  assert.deepEqual(out[1].after, { familiarity: 40, intimacy: 26, trust: 38 }, '小夏 32 条');
  assert.equal(out[1].stageAfter, '熟人');
  assert.equal(out[1].isOwner, false);
});

await test('seedRelations：只往上补、不往下压；没有变化时 changed=false', () => {
  const people = { 2002: { ...newPerson(), name: '小夏', familiarity: 60, intimacy: 50, trust: 50 } };
  const out = seedRelations(SEED_STATS, { ownerQQ: 100000001, now: T0, people });
  const p = out.find((x) => x.userId === '2002');
  assert.deepEqual(p.before, { intimacy: 50, trust: 50, familiarity: 60 });
  assert.deepEqual(p.after, { intimacy: 50, trust: 50, familiarity: 60 });
  assert.equal(p.changed, false);
  assert.equal(p.stageBefore, '朋友');
  assert.equal(p.stageAfter, '朋友');
  // 现状更低时往上补
  const low = { 2002: { ...newPerson(), familiarity: 20, intimacy: 20, trust: 35.04 } };
  const up = seedRelations(SEED_STATS, { ownerQQ: 100000001, now: T0, people: low }).find((x) => x.userId === '2002');
  assert.deepEqual(up.before, { intimacy: 20, trust: 35, familiarity: 20 }, '现状四舍五入到 1 位小数');
  assert.deepEqual(up.after, { intimacy: 26, trust: 38, familiarity: 40 });
  assert.equal(up.changed, true);
});

await test('seedRelations：主人 0 条也保留；时间解析失败按 spanDays=0', () => {
  const out = seedRelations([
    { userId: '100000001', name: '', messages: 0, firstSeenAt: '坏时间', lastSeenAt: '坏时间' },
    { userId: '2004', name: '新人', messages: 20, firstSeenAt: undefined, lastSeenAt: undefined }
  ], { ownerQQ: 100000001, now: T0, people: {} });
  assert.equal(out.length, 2);
  const owner = out.find((x) => x.userId === '100000001');
  assert.deepEqual(owner.after, { familiarity: 60, intimacy: 72, trust: 72 });
  const fresh = out.find((x) => x.userId === '2004');
  assert.deepEqual(fresh.after, { familiarity: 35, intimacy: 24, trust: 35 }, '20 条、spanDays 0');
});

// ── HANDOFF §6-2 / §6-1：出厂提取提示词修正 + 用量统计 ─────────────────────

await test('factoryMessages（§6-2）：好恶只收外界引起的反应；说话守则、关心别人的情况不算好恶；禁用称呼做关键词', () => {
  const system = factoryMessages('角色卡')[0].content;
  assert.match(system, /由别人的言行或外界事物引起的/);
  assert.match(system, /说话守则/);
  assert.match(system, /不要用称呼/);
  assert.match(system, /会去关心的情况/);
  // 原有断言（逐条匹配的那几条）仍然成立
  assert.match(system, /0\.85~1/);
  assert.match(system, /不要带「喜欢 \/ 讨厌」字样/);
  assert.match(system, /character 是后天性格：grudge 记仇（高：/);
});

await test('parseFactory（§6-2）：关键词里的称呼被滤掉，pref 本身保留', () => {
  const f = parseFactory({
    traits: { O: 50, C: 50, E: 50, A: 50, N: 50 },
    prefs: [
      { text: '被叫小矮子', valence: 'dislike', strength: 0.7, keywords: ['小矮子', '主人', '叫主人女仆腔', '大家'] },
      { text: '被夸', valence: 'like', strength: 0.6, keywords: ['主人'] }
    ]
  });
  assert.equal(f.prefs.length, 2, 'pref 本身保留');
  assert.deepEqual(f.prefs[0].keywords, ['小矮子']);
  assert.equal(f.prefs[1].text, '被夸');
  assert.deepEqual(f.prefs[1].keywords, [], '关键词被滤空也保留这条');
});

await test('store 用量（§6-1）：没有文件时返回空表；writeUsage 文件 600；appraisalDayCounts 跨会话、跨天、按 sinceMs 过滤', async () => {
  await withStore(async (store, dir) => {
    assert.deepEqual(store.readUsage(), { version: 1, days: {} });
    const usage = { version: 1, days: { '2026-11-01': { run1: { calls: 2, rules: 0, failures: 0, cacheHit: 10, cacheMiss: 2, output: 30, cost: 0.0012, updatedAt: 1 } } } };
    store.writeUsage(usage);
    const f = path.join(dir, 'usage.json');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(store.readUsage(), usage);
    // 坏形状退回空表（不炸控制台）
    fs.writeFileSync(f, JSON.stringify({ version: 1, days: [] }));
    assert.deepEqual(store.readUsage(), { version: 1, days: {} });

    const d1 = Date.parse('2026-11-01T10:00:00');
    const d2 = Date.parse('2026-11-02T09:00:00');
    store.appendAppraisal('r', 'private:2001', { at: d1, source: 'model' });
    store.appendAppraisal('r', 'private:2001', { at: d1, source: 'rules' });
    store.appendAppraisal('r', 'group:9', { at: d1, source: 'model' });
    store.appendAppraisal('r', 'group:9', { at: d2, source: 'rules' });
    const all = store.appraisalDayCounts('r', 0);
    assert.deepEqual(all['2026-11-01'], { model: 2, rules: 1 });
    assert.deepEqual(all['2026-11-02'], { model: 0, rules: 1 });
    const since = store.appraisalDayCounts('r', d2);
    assert.equal(since['2026-11-01'], undefined, 'sinceMs 之前的行不计');
    assert.deepEqual(since['2026-11-02'], { model: 0, rules: 1 });
    // 没有判读目录的角色返回 {}
    assert.deepEqual(store.appraisalDayCounts('没有判读'), {});
  });
});

// ── HANDOFF §6-2 返工：称呼过滤放在归一化之前；用量统计越过旧月份文件 ─────────

await test('parseFactory（§6-2 返工）：先滤称呼再归一化——第 4 个关键词「小矮子」不该被截掉', () => {
  const f = parseFactory({
    traits: { O: 50, C: 50, E: 50, A: 50, N: 50 },
    prefs: [
      { text: '被叫小矮子', valence: 'dislike', keywords: ['主人', '大家', '群友', '小矮子'] },
      { text: '被夸', valence: 'like', keywords: [' 主人 '] },
      { text: '下雨天', valence: 'like', keywords: '下雨' }, // keywords 不是数组：不报错，交给 normalizePrefs 清空
      { text: '被吵', valence: 'dislike' } // 连 keywords 都没有
    ]
  });
  assert.equal(f.prefs.length, 4, '非数组 keywords 的项不报错，也不被丢掉');
  assert.deepEqual(f.prefs[0].keywords, ['小矮子'], '称呼在截断之前就被滤掉，后面的关键词才留得下来');
  assert.equal(f.prefs[1].text, '被夸', 'pref 本身保留');
  assert.deepEqual(f.prefs[1].keywords, [], '「 主人 」带空格也要被滤掉');
  assert.deepEqual(f.prefs[2].keywords, []);
  assert.deepEqual(f.prefs[3].keywords, []);
});

await test('appraisalDayCounts（§6-2 返工）：sinceMs 之前的月份文件整本跳过；行级 at 过滤保留', async () => {
  await withStore(async (store, dir) => {
    const since = new Date(2026, 9, 5, 0, 0, 0).getTime(); // 10 月 5 日本地 00:00
    const row = (at, source = 'model') => JSON.stringify({ at, source }) + '\n';
    const sepFile = path.join(dir, 'r', 'appraisals', 'group_9', '2026-09.jsonl');
    const octFile = path.join(dir, 'r', 'appraisals', 'group_9', '2026-10.jsonl');
    fs.mkdirSync(path.dirname(sepFile), { recursive: true });
    fs.writeFileSync(sepFile, row(new Date(2026, 8, 10, 12).getTime())
      + row(new Date(2026, 8, 30, 23).getTime(), 'rules')
      + row(new Date(2026, 9, 20, 12).getTime())); // 错放：at 在 10 月，却写在 9 月的文件里
    fs.writeFileSync(octFile, row(new Date(2026, 9, 4, 23, 59).getTime(), 'rules') // 早于 since，行级过滤掉
      + row(since) + row(new Date(2026, 9, 5, 9).getTime())
      + row(new Date(2026, 9, 6, 9).getTime(), 'rules'));
    assert.deepEqual(store.appraisalDayCounts('r', since), {
      '2026-10-05': { model: 2, rules: 0 },
      '2026-10-06': { model: 0, rules: 1 }
    }, '只统计 10 月 5 日及以后；9 月文件（含错放的 10 月行）整本没读');
    const all = store.appraisalDayCounts('r', 0);
    assert.deepEqual(all['2026-09-10'], { model: 1, rules: 0 }, 'sinceMs 为 0 时照旧读全部');
    assert.deepEqual(all['2026-10-20'], { model: 1, rules: 0 }, '不过滤时错放行也会被统计');
  });
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
