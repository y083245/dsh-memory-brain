// 约定兑现 / 爽约的情绪联动（LIFE_LOOP_PATCH，子项目 3 · 规格 docs/design/LIFE_LOOP_SPEC.md §7）的单测。
//
// 覆盖：persona.js 的 onPromise / relationOf / salienceByMsg，persona-store.js 的 readAppraisals，
// 以及 persona-state.js 的 applyRelation 新增一句（只认规则来源的 trustDelta）。
// 临时目录 + 假 fetch + 可控时钟，不碰 state/、不联网。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersona } from '../src/persona.js';
import { applyRelation, newPerson } from '../src/persona-state.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const FACTORY = { traits: { O: 70, C: 45, E: 35, A: 30, N: 55 }, beliefs: ['我嘴硬但其实在意'] };
const OWNER = '2001';
const KEY = `private:${OWNER}`;
const ROLE = '小鲸鱼';

async function withPersona(run, { start = Date.parse('2026-11-02T12:00:00'), initialized = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-promise-'));
  const clock = { t: start };
  const logs = [];
  const persona = createPersona({
    stateDir: dir,
    roleName: () => ROLE,
    roleCard: () => '# 角色卡\n傲娇嘴硬，心软。',
    sessions: () => ({}),
    ownerQQ: () => OWNER,
    fetchImpl: async () => { throw new Error('不该联网'); },
    now: () => clock.t,
    log: (m) => logs.push(String(m)),
  });
  if (initialized) persona.console.confirmFactory(FACTORY);
  try {
    await run({ persona, dir, clock, logs });
  } finally {
    persona.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const peopleOf = (persona) => Object.fromEntries(persona.console.people().map((p) => [p.userId, p]));
const labelsOf = (persona) => persona.console.status().emotion.labels.map((l) => l.name);
const sceneOf = (persona, key = KEY) => persona.console.status().emotion.scenes[key] ?? null;
const appraisalDir = (dir) => path.join(dir, ROLE, 'appraisals', 'private_2001');

await test('四种组合：标签、愉悦方向、信任变化（对方兑现 +2 / 对方爽约 −3 / 自己兑现得意 / 自己爽约内疚）', async () => {
  await withPersona(async ({ persona }) => {
    // 对方兑现：开心、愉悦为正、信任 +2
    persona.onPromise({ key: KEY, userId: '3001', name: '阿青', by: 'them', outcome: 'done' });
    assert.deepEqual(labelsOf(persona), ['开心']);
    const s1 = sceneOf(persona);
    assert.ok(s1.p > 0, '愉悦方向为正');
    assert.equal(peopleOf(persona)['3001'].trust, 32);
    assert.match(persona.console.status().emotion.labels[0].cause, /阿青说到做到了/);

    // 对方爽约：委屈、愉悦为负、信任 −3
    persona.onPromise({ key: KEY, userId: '3002', name: '小满', by: 'them', outcome: 'missed' });
    assert.ok(labelsOf(persona).includes('委屈'));
    assert.ok(sceneOf(persona).p < 0);
    assert.equal(peopleOf(persona)['3002'].trust, 27);

    // 她兑现：得意、愉悦为正、信任不动
    persona.onPromise({ key: KEY, userId: '3003', name: '小满', by: 'me', outcome: 'done' });
    assert.ok(labelsOf(persona).includes('得意'));
    assert.ok(sceneOf(persona).p > 0);
    assert.equal(peopleOf(persona)['3003'].trust, 30);

    // 她爽约：难过、愉悦为负、信任不动
    persona.onPromise({ key: KEY, userId: '3004', name: '小满', by: 'me', outcome: 'missed' });
    assert.ok(labelsOf(persona).includes('难过'));
    assert.ok(sceneOf(persona).p < 0);
    assert.equal(peopleOf(persona)['3004'].trust, 30);
  });
});

await test('cancelled / 非法参数一律不生效（情绪、关系、判读日志都不动）', async () => {
  await withPersona(async ({ persona, dir }) => {
    const before = JSON.stringify(persona.console.status().emotion);
    for (const args of [
      { outcome: 'cancelled', by: 'them' },
      { outcome: 'open', by: 'them' },
      { outcome: 'done', by: 'someone' },
    ]) {
      persona.onPromise({ key: KEY, userId: OWNER, name: '主人', ...args });
    }
    assert.equal(JSON.stringify(persona.console.status().emotion), before, '情绪没动');
    assert.deepEqual(persona.console.people(), [], '关系也没建出人来');
    assert.equal(fs.existsSync(appraisalDir(dir)), false, '不写判读日志');
  });
});

await test('未初始化（出厂值没确认）时 onPromise / relationOf / salienceByMsg 都不动', async () => {
  await withPersona(async ({ persona, dir }) => {
    persona.onPromise({ key: KEY, userId: OWNER, name: '主人', by: 'them', outcome: 'done' });
    assert.equal(persona.relationOf(OWNER), null);
    assert.equal(persona.salienceByMsg(KEY).size, 0);
    assert.equal(persona.console.status().initialized, false);
    assert.equal(fs.existsSync(appraisalDir(dir)), false);
  }, { initialized: false });
});

await test('applyRelation：不带 trustDelta 的旧输入结果完全不变', () => {
  const base = { source: 'rules', target: 'me', intensity: 0.5, relation: { intimacy: 0, trust: 0 } };

  const p1 = newPerson(0);
  applyRelation(p1, { ...base, kind: 'normal' }, 1000);
  assert.equal(p1.trust, 30, '普通消息不动信任');
  assert.ok(Math.abs(p1.intimacy - 10.2) < 1e-9, '亲密度 +0.2（normal × 强度 0.5）');

  const p2 = newPerson(0);
  applyRelation(p2, { ...base, kind: 'insult' }, 1000);
  assert.equal(p2.trust, 24, '被骂 −6');
  assert.ok(Math.abs(p2.intimacy - 7) < 1e-9);

  const p3 = newPerson(0);
  applyRelation(p3, { ...base, kind: 'ignore' }, 1000);
  assert.equal(p3.trust, 30, '被忽略不动信任');
  assert.ok(Math.abs(p3.intimacy - 9.5) < 1e-9);

  const p4 = newPerson(0);
  p4.lastSeenAt = 1000 - 30 * 3600000;
  applyRelation(p4, { ...base, kind: 'normal' }, 1000);
  assert.equal(p4.trust, 32, '隔了 20 小时以上又回来 +2（旧规则照旧）');

  const p5 = newPerson(0);
  applyRelation(p5, { ...base, kind: 'normal', trustDelta: 0 }, 1000);
  assert.equal(p5.trust, 30, 'trustDelta 为 0 时和没有一样');
});

await test('applyRelation：模型来源带的 trustDelta 被忽略', () => {
  const p = newPerson(0);
  applyRelation(p, { source: 'model', target: 'me', kind: 'normal', intensity: 0.5, relation: { intimacy: 0, trust: 0 }, trustDelta: 4 }, 1000);
  assert.equal(p.trust, 30);
});

await test('applyRelation：规则来源的 trustDelta 夹到 [−6, 4]，并仍受每日 +4 / −12 封顶', () => {
  const up = newPerson(0);
  applyRelation(up, { source: 'rules', target: 'me', kind: 'normal', intensity: 0.5, relation: { intimacy: 0, trust: 0 }, trustDelta: 99 }, 1000);
  assert.equal(up.trust, 34, '单次最多 +4');

  const down = newPerson(0);
  applyRelation(down, { source: 'rules', target: 'me', kind: 'normal', intensity: 0.5, relation: { intimacy: 0, trust: 0 }, trustDelta: -99 }, 1000);
  assert.equal(down.trust, 24, '单次最多 −6');

  // 同一天第二次 +4：当天已经 +4，封顶后不再涨
  applyRelation(up, { source: 'rules', target: 'me', kind: 'normal', intensity: 0.5, relation: { intimacy: 0, trust: 0 }, trustDelta: 4 }, 2000);
  assert.equal(up.trust, 34, '每日涨幅封顶 4');

  // 隔天再算一次
  applyRelation(up, { source: 'rules', target: 'me', kind: 'normal', intensity: 0.5, relation: { intimacy: 0, trust: 0 }, trustDelta: 4 }, 1000 + 86400000);
  assert.equal(up.trust, 38);
});

await test('relationOf：返回四项、不认识的人 / 未初始化返回 null，且不写盘', async () => {
  await withPersona(async ({ persona, dir }) => {
    assert.equal(persona.relationOf(OWNER), null, '还没聊过的人');
    persona.onPromise({ key: KEY, userId: OWNER, name: '主人', by: 'them', outcome: 'done' });
    const rel = persona.relationOf(OWNER);
    assert.deepEqual(Object.keys(rel).sort(), ['familiarity', 'intimacy', 'stage', 'trust']);
    assert.equal(rel.trust, 32);
    assert.equal(rel.stage, '陌生');
    const before = fs.readFileSync(path.join(dir, ROLE, 'people.json'), 'utf8');
    persona.relationOf(OWNER);
    assert.equal(fs.readFileSync(path.join(dir, ROLE, 'people.json'), 'utf8'), before, '只读不写');
  });
});

await test('salienceByMsg：按 msgId 取最大值、忽略空 msgId、sinceMs 之前的不算、坏行跳过', async () => {
  await withPersona(async ({ persona, dir, clock }) => {
    const store = persona._store;
    const t = clock.t;
    store.appendAppraisal(ROLE, KEY, { at: t, msgId: 'm1', salience: 0.2 });
    store.appendAppraisal(ROLE, KEY, { at: t, msgId: 'm1', salience: 0.6 });
    store.appendAppraisal(ROLE, KEY, { at: t, msgId: 'm2', salience: 0.5 });
    store.appendAppraisal(ROLE, KEY, { at: t, msgId: null, salience: 0.9 });
    store.appendAppraisal(ROLE, KEY, { at: t - 40 * 86400000, msgId: 'm3', salience: 0.7 }); // 上个月
    fs.appendFileSync(path.join(appraisalDir(dir), '2026-11.jsonl'), '这不是 json\n');

    const all = persona.salienceByMsg(KEY);
    assert.equal(all.size, 3, '空 msgId 跳过；m1 只留最大值一条');
    assert.equal(all.get('m1'), 0.6);
    assert.equal(all.get('m2'), 0.5);
    assert.equal(all.get('m3'), 0.7);

    const recent = persona.salienceByMsg(KEY, { sinceMs: t });
    assert.deepEqual([...recent.keys()].sort(), ['m1', 'm2'], 'sinceMs 之前的那条不算');
    assert.equal(persona.salienceByMsg('private:9999').size, 0, '别的会话读不到');
  });
});

await test('onPromise 在状态目录写不动时只记日志、不抛（桥接主路径不能被带崩）', async () => {
  await withPersona(async ({ persona, dir, logs }) => {
    fs.rmSync(path.join(dir, ROLE), { recursive: true, force: true });
    fs.chmodSync(dir, 0o500);
    try {
      if (process.getuid?.() === 0) console.log('SKIP 状态目录 0o500 对 root 不生效');
      else {
        assert.doesNotThrow(() => persona.onPromise({ key: KEY, userId: OWNER, name: '主人', by: 'them', outcome: 'done' }));
        assert.match(logs.join('\n'), /\[persona\] onPromise 失败/);
      }
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
