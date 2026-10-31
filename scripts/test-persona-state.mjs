// src/persona-state.js 的单测（PERSONA_PATCH，子项目 1 任务 1～3 + 人格档案 v2 §10）。纯函数，不碰 state/。
import assert from 'node:assert/strict';
import {
  TRAITS, TRAIT_NAMES, CHAR_TRAITS, CHAR_NAMES, ALL_TRAITS, TRAIT_PHRASES, mergeSettings, clamp, band, halfLifeFactor,
  newCore, upgradeCore, traitValues, padBaseline, modulation, newEmotion, decayEmotion, applyImpulse, soothe,
  impulseFromAppraisal, expressedPad, tierWord, renderNow, newPerson, stageOf, applyRelation, renderCore, traitView, renderRelation,
  normalizePrefs, inQuiet
} from '../src/persona-state.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const near = (actual, expected, msg = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} 实际 ${actual}，期望 ${expected}`);

const S = mergeSettings({});
const T0 = Date.parse('2026-11-01T12:00:00');
const MIN = 60000;

// ── 任务 1：设置、核心性格、基线、调制 ───────────────────────────────────
await test('mergeSettings 两层深合并，不改默认值对象', () => {
  const s = mergeSettings({ appraisal: { dailyLimit: 10, groupBatch: { minutes: 9 } }, inject: false });
  assert.equal(s.appraisal.dailyLimit, 10);
  assert.equal(s.appraisal.groupBatch.minutes, 9);
  assert.equal(s.appraisal.groupBatch.messages, 20);
  assert.equal(s.inject, false);
  assert.equal(mergeSettings({}).appraisal.dailyLimit, 400);
});

await test('clamp / halfLifeFactor', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(Number.NaN, 0, 1), 0);
  assert.equal(halfLifeFactor(45 * MIN, 45), 0.5);
  assert.equal(halfLifeFactor(-1, 45), 1);
});

await test('newCore 出厂值夹到 0～100，当前值等于出厂值', () => {
  const c = newCore({ O: 120, C: -5, E: 40 });
  assert.equal(c.traits.O.factory, 100);
  assert.equal(c.traits.C.value, 0);
  assert.equal(c.traits.A.value, 50);
  assert.deepEqual(Object.keys(traitValues(c)), [...ALL_TRAITS]);
});

await test('newCore（v2）：6 项后天性格缺省 50，带 manifests / prefs', () => {
  const c = newCore({ O: 50 }, { grudge: 80, empathy: -20 });
  assert.equal(c.version, 2);
  assert.deepEqual(Object.keys(c.character), [...CHAR_TRAITS]);
  assert.equal(c.character.grudge.factory, 80);
  assert.equal(c.character.empathy.value, 0);
  assert.equal(c.character.pride.value, 50);
  assert.deepEqual(c.manifests, {});
  assert.deepEqual(c.prefs, []);
  assert.equal(newCore({}).version, 2);
});

await test('upgradeCore：v1 → v2；幂等；null 原样返回；补齐残缺的 character', () => {
  const v1 = { version: 1, traits: newCore({ O: 70 }).traits, beliefs: [{ type: 'prior', text: '我嘴硬', status: 'accepted', prior: true }], confirmedAt: 123 };
  const v2 = upgradeCore(v1);
  assert.equal(v2.version, 2);
  assert.equal(v2.confirmedAt, 123);
  assert.equal(v2.beliefs[0].text, '我嘴硬');
  assert.deepEqual(Object.keys(v2.character), [...CHAR_TRAITS]);
  for (const k of CHAR_TRAITS) assert.deepEqual(v2.character[k], { factory: 50, value: 50, locked: false });
  assert.deepEqual(v2.manifests, {});
  assert.deepEqual(v2.prefs, []);
  assert.equal(v2.traits.O.value, 70);
  assert.deepEqual(upgradeCore(v2), v2, '幂等');
  assert.equal(upgradeCore(null), null);
  const partial = upgradeCore({ version: 2, traits: v1.traits, character: { pride: { factory: 74, value: 66, locked: true } }, manifests: { O: { band: '高', text: 'x' } } });
  assert.deepEqual(partial.character.pride, { factory: 74, value: 66, locked: true });
  assert.equal(partial.character.grudge.value, 50);
  assert.deepEqual(partial.manifests.O, { band: '高', text: 'x' });
  assert.deepEqual(partial.prefs, []);
});

await test('traitValues：扁平含 11 项，缺省 50（v1 core 的后天性格也是 50）', () => {
  const vals = traitValues({ version: 1, traits: { O: { value: 80 } } });
  assert.deepEqual(Object.keys(vals), [...ALL_TRAITS]);
  assert.equal(vals.O, 80);
  assert.equal(vals.C, 50);
  assert.equal(vals.grudge, 50);
  assert.equal(traitValues(newCore({}, { empathy: 90 })).empathy, 90);
});

await test('band：≥60 高、≤40 低、其余中', () => {
  assert.equal(band(60), '高');
  assert.equal(band(59.9), '中');
  assert.equal(band(40), '低');
  assert.equal(band(40.1), '中');
  assert.equal(band(undefined), '中');
});

await test('padBaseline：全 50 为 0；宜人高 → 愉悦高；神经质高 → 唤醒高', () => {
  const mid = padBaseline({ O: 50, C: 50, E: 50, A: 50, N: 50 });
  assert.deepEqual(mid, { p: 0, a: 0, d: 0 });
  assert.ok(padBaseline({ A: 90 }).p > 0);
  assert.ok(padBaseline({ N: 90 }).a > 0);
  // 后天性格不进心情基线
  assert.deepEqual(padBaseline({ O: 50, C: 50, E: 50, A: 50, N: 50, grudge: 100, guarded: 100 }), mid);
});

await test('modulation：11 项全 50 时与原值一致；旧键仍由大五决定', () => {
  assert.deepEqual(modulation({}), {
    negGain: 1, negHalfLifeMul: 1, soothe: 0.5, missGain: 1, noveltyGain: 1,
    teaseNegMul: 1, insultGain: 1, praiseGain: 1, empathyGain: 1, expectMul: 1, expressThreshold: -0.15
  });
  // 大五非 50、后天性格 50：negGain / noveltyGain 与 v1 公式完全一致
  const m = modulation({ O: 70, C: 50, E: 90, A: 10, N: 80 });
  near(m.negGain, 1 + 0.5 * 0.6, 'negGain');
  near(m.noveltyGain, 1 + 0.5 * 0.4, 'noveltyGain');
});

await test('modulation：新系数在 0 / 50 / 100 下的值', () => {
  const at = (key, trait, x) => modulation({ [trait]: x })[key];
  const cases = [
    ['negHalfLifeMul', 'grudge', [0.4, 1, 1.6]],
    ['soothe', 'guarded', [0.9, 0.5, 0.1]],
    ['expressThreshold', 'guarded', [0, -0.15, -0.3]],
    ['missGain', 'clingy', [0.5, 1, 1.5]],
    ['expectMul', 'clingy', [1.4, 1, 0.6]],
    ['teaseNegMul', 'playful', [1.5, 1, 0.5]],
    ['insultGain', 'pride', [1.4, 1, 0.6]],
    ['praiseGain', 'pride', [1.3, 1, 0.7]],
    ['empathyGain', 'empathy', [0.4, 1, 1.6]],
    ['negGain', 'N', [0.5, 1, 1.5]],
    ['noveltyGain', 'O', [0.5, 1, 1.5]]
  ];
  for (const [key, trait, [lo, mid, hi]] of cases) {
    near(at(key, trait, 0), lo, `${key}@0`);
    near(at(key, trait, 50), mid, `${key}@50`);
    near(at(key, trait, 100), hi, `${key}@100`);
  }
});

await test('modulation：负面半衰期由记仇、安抚由嘴硬决定（不再看神经质 / 宜人）', () => {
  assert.ok(modulation({ grudge: 90 }).negHalfLifeMul > 1);
  assert.equal(modulation({ N: 90 }).negHalfLifeMul, 1);
  assert.ok(modulation({ guarded: 90 }).soothe < 0.5, '嘴硬高 → 削得少');
  assert.ok(modulation({ guarded: 10 }).soothe > 0.5, '不嘴硬 → 削得多');
  assert.equal(modulation({ A: 20 }).soothe, 0.5);
  assert.ok(modulation({ clingy: 90 }).missGain > 1);
  assert.equal(modulation({ E: 90 }).missGain, 1);
});

// ── 任务 2：情绪 ────────────────────────────────────────────────────────
await test('applyImpulse：单步限幅 0.12，scene 全额、core 只吃四成', () => {
  const em = newEmotion(T0);
  applyImpulse(em, { key: 'private:1', delta: { p: -1 } }, T0, S);
  assert.equal(em.scenes['private:1'].p, -0.12);
  assert.ok(Math.abs(em.core.p - (-0.12 * 0.4)) < 1e-9);
});

await test('applyImpulse：core 每小时预算用完后不再变（防刷）', () => {
  const em = newEmotion(T0);
  for (let i = 0; i < 50; i++) applyImpulse(em, { key: 'group:9', delta: { p: -1, a: 1, d: -1 } }, T0, S);
  const coreMag = Math.abs(em.core.p) + Math.abs(em.core.a) + Math.abs(em.core.d);
  assert.ok(coreMag <= S.emotion.coreHourlyBudget + 1e-9, `core 累计 ${coreMag}`);
});

await test('标签：同名同会话叠加、封顶 0.6，最多 3 个', () => {
  const em = newEmotion(T0);
  for (let i = 0; i < 5; i++) applyImpulse(em, { key: 'k', label: { name: '委屈', v: 0.3, cause: '阿青说你菜' } }, T0, S);
  assert.equal(em.labels.length, 1);
  assert.equal(em.labels[0].v, 0.6);
  for (const n of ['开心', '得意', '感动']) applyImpulse(em, { key: 'k', label: { name: n, v: 0.1 } }, T0, S);
  assert.equal(em.labels.length, 3);
  assert.equal(em.labels[0].name, '委屈');
});

await test('decayEmotion：scene 45 分钟减半，过小的 scene 删除', () => {
  const em = newEmotion(T0);
  applyImpulse(em, { key: 'k', delta: { p: 0.1 } }, T0, S);
  decayEmotion(em, T0 + 45 * MIN, S);
  assert.ok(Math.abs(em.scenes.k.p - 0.05) < 1e-9);
  decayEmotion(em, T0 + 600 * MIN, S);
  assert.equal(em.scenes.k, undefined);
});

await test('soothe：嘴硬高只削一点', () => {
  const em = newEmotion(T0);
  applyImpulse(em, { key: 'k', label: { name: '生气', v: 0.6 } }, T0, S);
  soothe(em, 'k', T0, S, modulation({ guarded: 90 }));
  assert.ok(em.labels[0].v > 0.5, `剩 ${em.labels[0].v}`);
  const em2 = newEmotion(T0);
  applyImpulse(em2, { key: 'k', label: { name: '生气', v: 0.6 } }, T0, S);
  soothe(em2, 'k', T0, S, modulation({ guarded: 10 }));
  assert.ok(em2.labels[0].v < 0.5, `剩 ${em2.labels[0].v}`);
});

await test('impulseFromAppraisal：冲着她的真骂比冲别人的强；神经质高更强', () => {
  const a = { kind: 'insult', target: 'me', intensity: 0.8, pad: { p: -1, a: 1, d: -1 }, emotion: { label: '生气' }, cause: '阿青骂你' };
  const me = impulseFromAppraisal(a, modulation({}), S);
  const other = impulseFromAppraisal({ ...a, target: 'other' }, modulation({}), S);
  const neurotic = impulseFromAppraisal(a, modulation({ N: 100 }), S);
  assert.ok(me.delta.p < other.delta.p);
  assert.ok(neurotic.delta.p < me.delta.p);
  assert.equal(me.label.name, '生气');
  assert.equal(me.label.strong, true);
});

await test('impulseFromAppraisal：不传 prefs 时与 v1 结果逐项相同', () => {
  const a = { kind: 'praise', target: 'me', intensity: 0.6, pad: { p: 1, a: 1, d: 0 }, emotion: { label: '得意' } };
  const m = modulation({ O: 70, C: 50, E: 60, A: 40, N: 30 });
  const got = impulseFromAppraisal(a, m, S);
  const k = S.emotion.stepClamp * 0.6;
  const delta = { p: 1 * k, a: 1 * k, d: 0 };
  if (delta.p < 0) delta.p *= m.negGain;
  near(got.delta.p, delta.p, 'delta.p');
  near(got.delta.a, delta.a, 'delta.a');
  near(got.label.v, 0.6 * 0.6, 'label.v');
  assert.equal(got.label.name, '得意');
  assert.equal(got.label.strong, false);
});

await test('impulseFromAppraisal：玩笑损 × 爱玩梗（越高越不往心里去）', () => {
  const a = { kind: 'tease', target: 'me', intensity: 0.5, pad: { p: -1, a: 0, d: 0 }, emotion: { label: '生气' } };
  const fun = impulseFromAppraisal(a, modulation({ playful: 100 }), S);
  const hurt = impulseFromAppraisal(a, modulation({ playful: 0 }), S);
  assert.ok(fun.delta.p > hurt.delta.p, '爱玩梗高 → 负得更少');
  assert.ok(fun.label.v < hurt.label.v);
  near(fun.delta.p, -0.12 * 0.5 * 0.5);
  near(hurt.delta.p, -0.12 * 0.5 * 1.5);
});

await test('impulseFromAppraisal：被真骂 × 自尊（越高冲量越小），被夸同理', () => {
  const insult = { kind: 'insult', target: 'me', intensity: 0.5, pad: { p: -1, a: 0, d: 0 }, emotion: { label: '生气' } };
  const proud = impulseFromAppraisal(insult, modulation({ pride: 100 }), S);
  const shy = impulseFromAppraisal(insult, modulation({ pride: 0 }), S);
  assert.ok(proud.delta.p > shy.delta.p);
  near(proud.delta.p, -0.12 * 0.5 * 0.6);
  near(shy.delta.p, -0.12 * 0.5 * 1.4);
  const praise = { kind: 'praise', target: 'me', intensity: 0.5, pad: { p: 1, a: 0, d: 0 }, emotion: { label: '得意' } };
  assert.ok(impulseFromAppraisal(praise, modulation({ pride: 100 }), S).delta.p < impulseFromAppraisal(praise, modulation({ pride: 0 }), S).delta.p);
});

await test('impulseFromAppraisal：有人倾诉 × 共情（整个冲量一起放大）', () => {
  const a = { kind: 'vent', target: 'me', intensity: 0.5, pad: { p: -0.3, a: 0.1, d: 0 }, emotion: { label: '' } };
  const high = impulseFromAppraisal(a, modulation({ empathy: 100 }), S);
  const low = impulseFromAppraisal(a, modulation({ empathy: 0 }), S);
  near(high.delta.p, low.delta.p * 4); // 1.6 / 0.4
  near(high.delta.a, low.delta.a * 4);
});

await test('impulseFromAppraisal：戳中雷点 → 强度放大、p 强制为负、标签改生气 / strong', () => {
  const a = { kind: 'tease', target: 'me', intensity: 0.5, pad: { p: 1, a: 1, d: 0 }, emotion: { label: '开心' }, trigger: 'p1' };
  const prefs = [{ id: 'p1', text: '被叫大肥鱼', valence: 'dislike', strength: 1 }];
  const hit = impulseFromAppraisal(a, modulation({}), S, prefs);
  const miss = impulseFromAppraisal({ ...a, trigger: '' }, modulation({}), S, prefs);
  assert.ok(hit.delta.p < 0, 'p 方向被强制为负');
  assert.equal(hit.label.name, '生气');
  assert.equal(hit.label.strong, true, '强度 ≥ 0.8 的雷点用 labelCapStrong');
  near(hit.label.v, 0.6 * Math.min(1, 0.5 * 1.5));
  assert.ok(miss.delta.p > 0);
  assert.equal(miss.label.name, '开心');
});

await test('impulseFromAppraisal：戳中萌点 → p 强制为正、标签改开心；未知编号忽略', () => {
  const a = { kind: 'tease', target: 'me', intensity: 0.4, pad: { p: -1, a: 0, d: 0 }, emotion: { label: '难过' }, trigger: 'p2' };
  const prefs = [{ id: 'p2', text: '被认真夸', valence: 'like', strength: 0.6 }];
  const hit = impulseFromAppraisal(a, modulation({}), S, prefs);
  assert.ok(hit.delta.p > 0);
  assert.equal(hit.label.name, '开心');
  near(hit.label.v, 0.6 * Math.min(1, 0.4 * 1.24));
  const unknown = impulseFromAppraisal({ ...a, trigger: 'p9' }, modulation({}), S, prefs);
  assert.equal(unknown.label.name, '难过');
  assert.ok(unknown.delta.p < 0);
});

await test('impulseFromAppraisal：不改动传进来的 pad', () => {
  const pad = { p: 1, a: 1, d: 0 };
  const a = { kind: 'tease', target: 'me', intensity: 0.5, pad, emotion: { label: '' }, trigger: 'p1' };
  impulseFromAppraisal(a, modulation({}), S, [{ id: 'p1', valence: 'dislike', strength: 1 }]);
  assert.deepEqual(pad, { p: 1, a: 1, d: 0 });
});

await test('renderNow：强度分档；别的会话的标签串过来时不带原因', () => {
  const em = newEmotion(T0);
  applyImpulse(em, { key: 'group:1', label: { name: '委屈', v: 0.6, cause: '阿青说你菜' } }, T0, S);
  assert.match(renderNow(em, 'group:1', {}, S, T0), /很委屈（阿青说你菜，刚刚）/);
  // 5 分钟后 0.6 → 0.555，落到「有点」这一档
  assert.match(renderNow(em, 'group:1', {}, S, T0 + 5 * MIN), /有点委屈（阿青说你菜，刚刚）/);
  const elsewhere = renderNow(em, 'private:2', {}, S, T0 + 5 * MIN);
  assert.doesNotMatch(elsewhere, /阿青/);
  assert.equal(tierWord(0.1), '');
});

await test('renderNow：几分钟内的小衰减不改文字（不让 DSH 每步追加快照）', () => {
  const em = newEmotion(T0);
  applyImpulse(em, { key: 'k', label: { name: '开心', v: 0.5 } }, T0, S);
  assert.equal(renderNow(em, 'k', {}, S, T0 + MIN), renderNow(em, 'k', {}, S, T0 + 3 * MIN));
});

await test('expressedPad：会话残留只影响本会话', () => {
  const em = newEmotion(T0);
  applyImpulse(em, { key: 'a', delta: { p: -0.12 } }, T0, S);
  assert.ok(expressedPad(em, 'a', {}, S).p < expressedPad(em, 'b', {}, S).p);
});

await test('inQuiet：默认 0～8 点', () => {
  assert.equal(inQuiet(Date.parse('2026-11-01T03:00:00'), S), true);
  assert.equal(inQuiet(Date.parse('2026-11-01T09:00:00'), S), false);
});

// ── 任务 3：关系与渲染 ──────────────────────────────────────────────────
await test('stageOf：熟悉度不够算陌生，之后按亲密分档', () => {
  assert.equal(stageOf(newPerson()), '陌生');
  assert.equal(stageOf({ familiarity: 20, intimacy: 50 }), '朋友');
});

await test('applyRelation：真骂扣信任，玩笑损不扣；每天扣分封顶 12', () => {
  const p = newPerson(T0);
  applyRelation(p, { kind: 'tease', target: 'me', intensity: 0.5 }, T0);
  assert.equal(p.trust, 30);
  for (let i = 0; i < 5; i++) applyRelation(p, { kind: 'insult', target: 'me', intensity: 0.9 }, T0 + i);
  assert.equal(p.trust, 18);
});

await test('applyRelation：隔天回来 +2，每天加分封顶 4', () => {
  const p = newPerson(T0);
  p.lastSeenAt = T0 - 30 * 3600000;
  applyRelation(p, { kind: 'vent', target: 'me', intensity: 0.5 }, T0);
  assert.equal(p.trust, 33);
  for (let i = 1; i < 5; i++) applyRelation(p, { kind: 'share', target: 'me', intensity: 0.5 }, T0 + i);
  assert.equal(p.trust, 34);
});

await test('renderCore：分档文字 + 已采纳的自我信念', () => {
  const c = newCore({ A: 80, N: 20 });
  c.beliefs = [{ type: 'prior', text: '我嘴硬但其实在意', status: 'accepted', prior: true }, { type: 'x', text: '候选不出现', status: 'candidate' }];
  const out = renderCore(c);
  assert.match(out, /宜人很高/);
  assert.match(out, /神经质很低/);
  assert.match(out, /我嘴硬但其实在意/);
  assert.doesNotMatch(out, /候选不出现/);
});

await test('renderCore：大五 5 项都列；manifest 档一致时用 manifest，跨档回退到一般表现', () => {
  const c = newCore({ O: 70, C: 50, E: 40, A: 40, N: 50 });
  c.manifests = { A: { band: '低', text: '被怼会顶回去但不刻薄' }, O: { band: '中', text: '这个档不该生效' } };
  const out = renderCore(c);
  assert.match(out, /^- 开放偏高：对新鲜东西好奇，爱聊没聊过的话题$/m);
  assert.match(out, /^- 尽责中等$/m);
  assert.match(out, /^- 外向偏低：话少，不太主动开口，更爱在旁边看$/m);
  assert.match(out, /^- 宜人偏低：被怼会顶回去但不刻薄$/m);
  assert.doesNotMatch(out, /这个档不该生效/);
  // 档跨越（低 → 中）后回退：中档没有一般表现，只写「X中等」
  const crossed = newCore({ A: 55 });
  crossed.manifests = { A: { band: '低', text: '被怼会顶回去但不刻薄' } };
  assert.match(renderCore(crossed), /^- 宜人中等$/m);
  assert.doesNotMatch(renderCore(crossed), /被怼会顶回去/);
  // 中档的 manifest 会显示出来
  const mid = newCore({ A: 55 });
  mid.manifests = { A: { band: '中', text: '看情况，熟人面前好说话' } };
  assert.match(renderCore(mid), /^- 宜人中等：看情况，熟人面前好说话$/m);
});

await test('renderCore：相处习惯只列非中档，按偏离 50 从大到小', () => {
  const c = newCore({}, { grudge: 70, clingy: 30, guarded: 90, playful: 55 });
  c.manifests = { guarded: { band: '高', text: '嘴上说没事' } };
  const out = renderCore(c);
  const habits = out.split('\n').filter((l) => /^- (记仇|黏人|嘴硬|爱玩梗|自尊|共情)/.test(l));
  assert.equal(habits.length, 3);
  assert.match(habits[0], /嘴硬很高：嘴上说没事/, '偏离 40 的最大，先列');
  assert.match(habits[1], /记仇偏高/, '偏离 20，按 CHAR_TRAITS 顺序排在黏人前');
  assert.match(habits[2], /黏人偏低/);
  assert.doesNotMatch(out, /爱玩梗/);
  assert.match(out, /相处习惯：/);
});

await test('renderCore：好恶各取前 3，雷点标注，不渲染 hits', () => {
  const c = newCore({});
  c.prefs = [
    ...['A', 'B', 'C', 'D'].map((t, i) => ({ id: `p${i + 1}`, text: `喜欢${t}`, valence: 'like', strength: 0.3 + i * 0.1, keywords: [], hits: 99, lastHitAt: 1 })),
    { id: 'p5', text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'], hits: 7, lastHitAt: 2 },
    { id: 'p6', text: '被催', valence: 'dislike', strength: 0.4, keywords: [], hits: 0, lastHitAt: 0 }
  ];
  const out = renderCore(c);
  assert.match(out, /^你喜欢：喜欢D、喜欢C、喜欢B$/m);
  assert.doesNotMatch(out, /喜欢A/);
  assert.match(out, /^你讨厌：被叫大肥鱼（雷点）、被催$/m);
  assert.doesNotMatch(out, /p5|p6|99|hits/);
});

await test('renderCore：没有任何好恶 / 信念时省略对应段', () => {
  const out = renderCore(newCore({}));
  assert.doesNotMatch(out, /你喜欢|你讨厌|你对自己的看法/);
  assert.match(out, /^【你现在的性格】/);
  assert.doesNotMatch(out, /相处习惯/);
});

await test('traitView：11 项顺序、字段齐全、phraseSource 区分 manifest / generic / 无', () => {
  const c = newCore({ O: 70, A: 40, N: 50 }, { grudge: 55, guarded: 50 });
  c.manifests = { A: { band: '低', text: '被怼会顶回去' }, grudge: { band: '中', text: '偶尔记一下' }, O: { band: '中', text: '档不一致，不生效' } };
  const view = traitView(c);
  assert.deepEqual(view.map((x) => x.key), [...ALL_TRAITS]);
  assert.deepEqual(view.map((x) => x.group), ['big5', 'big5', 'big5', 'big5', 'big5', 'char', 'char', 'char', 'char', 'char', 'char']);
  const byKey = Object.fromEntries(view.map((x) => [x.key, x]));
  assert.deepEqual(byKey.O, {
    key: 'O', name: '开放', group: 'big5', factory: 70, value: 70, locked: false,
    level: '偏高', band: '高', phrase: TRAIT_PHRASES.O.高, phraseSource: 'generic'
  });
  assert.equal(byKey.A.phrase, '被怼会顶回去');
  assert.equal(byKey.A.phraseSource, 'manifest');
  assert.equal(byKey.C.phrase, '');
  assert.equal(byKey.C.phraseSource, '');
  assert.equal(byKey.grudge.phraseSource, 'manifest', '中档 manifest 也生效');
  assert.equal(byKey.grudge.band, '中');
  assert.equal(byKey.guarded.phraseSource, '', '嘴硬 50 无 manifest、中档无一般表现');
  assert.equal(byKey.guarded.level, '中等');
  assert.equal(byKey.empathy.name, '共情');
  c.traits.N.locked = true;
  c.traits.N.factory = 80;
  c.traits.N.value = 66;
  const n = traitView(c).find((x) => x.key === 'N');
  assert.deepEqual({ factory: n.factory, value: n.value, locked: n.locked, level: n.level, band: n.band }, { factory: 80, value: 66, locked: true, level: '偏高', band: '高' });
});

await test('renderCore：输出与抽 traitView 之前逐字一致', () => {
  const c = newCore({ O: 65, C: 55, E: 40, A: 40, N: 35 }, { grudge: 62, clingy: 55, guarded: 78, playful: 45, pride: 50, empathy: 66 });
  c.manifests = {
    O: { band: '高', text: '看到新模型会拉着人聊半天' },
    A: { band: '低', text: '被怼会顶回去但不刻薄' },
    grudge: { band: '高', text: '生气会闷半天，嘴上说没事' },
    empathy: { band: '高', text: '别人难受她会先递台阶' }
  };
  c.prefs = normalizePrefs([
    { text: '被认真夸', valence: 'like', strength: 0.7, keywords: ['夸', '厉害'] },
    { text: '聊新出的模型', valence: 'like', strength: 0.6, keywords: ['模型'] },
    { text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'] }
  ]);
  c.beliefs = [{ text: '我嘴硬但其实在意', status: 'accepted', prior: true }, { text: '候选不出现在这里', status: 'candidate' }];
  const expected = [
    '【你现在的性格】（会随经历慢慢变化；按它自然表现，不要说出来）',
    '- 开放偏高：看到新模型会拉着人聊半天',
    '- 尽责中等',
    '- 外向偏低：话少，不太主动开口，更爱在旁边看',
    '- 宜人偏低：被怼会顶回去但不刻薄',
    '- 神经质偏低：情绪稳，不容易被一句话带跑',
    '相处习惯：',
    '- 嘴硬很高：心软但嘴上不承认，被哄了也装作没事，不轻易示弱',
    '- 共情偏高：别人难受她会先递台阶',
    '- 记仇偏高：生气会闷半天，嘴上说没事',
    '你喜欢：被认真夸、聊新出的模型',
    '你讨厌：被叫大肥鱼（雷点）',
    '你对自己的看法：',
    '- 我嘴硬但其实在意'
  ].join('\n');
  assert.equal(renderCore(c), expected);
});

await test('normalizePrefs：校验 text / valence / strength / keywords', () => {
  const out = normalizePrefs([
    { text: '  被认真夸  ', valence: 'like' },
    { text: '', valence: 'like' },
    { text: '被叫大肥鱼被叫大肥鱼被叫大肥鱼被叫大肥鱼', valence: 'dislike' },
    { text: '随便', valence: 'neutral' },
    { text: '怕吵', valence: 'dislike', strength: 0.05, keywords: ['!!!', '书', '大声一点的话真的呀', '第二', '第三'] },
    { text: '爱吃辣', valence: 'like', strength: 9 },
    null,
    'not-an-object'
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { id: 'p1', text: '被认真夸', valence: 'like', strength: 0.6, keywords: [], hits: 0, lastHitAt: 0 });
  assert.equal(out[1].text, '怕吵');
  assert.equal(out[1].strength, 0.3, '夹到 0.3');
  assert.deepEqual(out[1].keywords, ['第二', '第三'], '单字、纯标点、超过 8 字、第 4 个都丢掉');
  assert.equal(out[2].strength, 1, '夹到 1');
});

await test('normalizePrefs：单字关键词被丢掉（「书 / 矮 / 雨」会误伤），最多留 3 个', () => {
  const out = normalizePrefs([{ text: '碰我的书', valence: 'dislike', keywords: ['书', '碰我的书', '矮', '小矮子', '大肥鱼', '雨'] }]);
  assert.deepEqual(out[0].keywords, ['碰我的书', '小矮子', '大肥鱼']);
});

await test('normalizePrefs：去掉「喜欢 / 讨厌」这类前缀；整条就是「喜欢」时保留', () => {
  const out = normalizePrefs([
    { text: '喜欢雨天', valence: 'like' },
    { text: '最讨厌被叫小矮子', valence: 'dislike' },
    { text: '很讨厌香菜', valence: 'dislike' },
    { text: '不喜欢早起', valence: 'dislike' },
    { text: '最恨被催', valence: 'dislike' },
    { text: ' 讨厌  ', valence: 'dislike' },
    { text: '喜欢', valence: 'like' }
  ]);
  assert.deepEqual(out.map((p) => p.text), ['雨天', '被叫小矮子', '香菜', '早起', '被催', '讨厌', '喜欢']);
  // 先去前缀再看长度：原文 19 字、去掉「最讨厌」后 16 字，应当保留
  const long = normalizePrefs([{ text: '最讨厌' + '被催早睡'.repeat(4), valence: 'dislike' }]);
  assert.equal(long.length, 1, '先去前缀再看长度');
  assert.equal(long[0].text, '被催早睡'.repeat(4));
  assert.equal(normalizePrefs([{ text: '被催早睡'.repeat(5), valence: 'like' }]).length, 0, '超过 16 字仍然丢');
});

await test('normalizePrefs：保留合法且不重复的 id，其余自动分配（先占住显式 id）', () => {
  const out = normalizePrefs([
    { id: 'p2', text: '一', valence: 'like' },
    { id: 'p2', text: '二', valence: 'like' },
    { id: 'x9', text: '三', valence: 'like' },
    { id: 'p1', text: '四', valence: 'like' }
  ]);
  assert.deepEqual(out.map((p) => p.id), ['p2', 'p3', 'p4', 'p1']);
  const hits = normalizePrefs([{ text: 'a', valence: 'like', hits: 5, lastHitAt: 123 }, { text: 'b', valence: 'like', hits: 'x' }]);
  assert.equal(hits[0].hits, 5);
  assert.equal(hits[0].lastHitAt, 123);
  assert.equal(hits[1].hits, 0);
  assert.equal(hits[1].lastHitAt, 0);
});

await test('normalizePrefs：最多 12 条，超出丢掉末尾；非数组返回 []', () => {
  const list = Array.from({ length: 15 }, (_, i) => ({ text: `第${i}条`, valence: 'like' }));
  const out = normalizePrefs(list);
  assert.equal(out.length, 12);
  assert.equal(out[11].text, '第11条');
  assert.deepEqual(normalizePrefs(null), []);
  assert.deepEqual(normalizePrefs(undefined), []);
});

await test('renderRelation：私聊来源的信念不进群聊', () => {
  const p = { ...newPerson(), familiarity: 30, intimacy: 50, trust: 75 };
  p.beliefs = [{ text: '他难受的时候会来找我', status: 'accepted', keys: ['private:2001'] }];
  assert.match(renderRelation(p, '小满', { key: 'private:2001' }), /他难受的时候会来找我/);
  assert.doesNotMatch(renderRelation(p, '小满', { key: 'group:9' }), /难受/);
  assert.match(renderRelation(p, '小满', { key: 'group:9' }), /【你和小满】朋友；信任高/);
});

await test('TRAIT_PHRASES / CHAR_NAMES：11 项齐全，大五与后天性格都能查到', () => {
  assert.deepEqual(Object.keys(TRAIT_PHRASES).sort(), [...ALL_TRAITS].sort());
  assert.deepEqual(Object.keys(CHAR_NAMES), [...CHAR_TRAITS]);
  assert.deepEqual([...TRAITS], ['O', 'C', 'E', 'A', 'N']);
  assert.deepEqual(Object.keys(TRAIT_NAMES), ['O', 'C', 'E', 'A', 'N']);
  for (const k of ALL_TRAITS) assert.ok(TRAIT_PHRASES[k].高 && TRAIT_PHRASES[k].低, `${k} 缺档`);
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
