// src/persona.js（胶水层）的单测（PERSONA_PATCH，子项目 1 任务 9）。临时目录 + 假 fetch + 可控时钟。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersona } from '../src/persona.js';
import { assertPosixMode } from './test-mode.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const reply = (obj) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_cache_hit_tokens: 500, prompt_cache_miss_tokens: 100, completion_tokens: 60 } }) });
const INSULT = { target: 'me', kind: 'insult', emotion: { label: '委屈', intensity: 0.7 }, pad: { p: -1, a: 1, d: -1 }, relation: { intimacy: -1, trust: -1 }, evidence: [{ about: 'self', type: 'insulted', gist: '说她菜' }], salience: 0.6, cause: '阿青说你菜' };
const FACTORY = { traits: { O: 70, C: 45, E: 35, A: 30, N: 55 }, beliefs: ['我嘴硬但其实在意'] };

async function withPersona(run, { fetchQueue = [], sessions = { 'private:2001': 'session-aaa', 'group:9': 'session-bbb' }, start = Date.parse('2026-11-02T12:00:00'), peopleStats = () => [], files = {}, roleCard = () => '# 角色卡\n傲娇嘴硬，心软。' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-glue-'));
  const clock = { t: start };
  const calls = [];
  const logs = [];
  // 预置状态文件（v1 core、people.json 等）；路径相对 stateDir（角色目录是 <stateDir>/<角色名>/）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); const r = fetchQueue.shift(); if (!r) throw new Error('no more fake responses'); return r; };
  const weekly = [];
  const persona = createPersona({
    stateDir: dir, roleName: () => '小鲸鱼', roleCard, sessions: () => sessions, ownerQQ: () => '2001',
    peopleStats, fetchImpl, now: () => clock.t, onWeeklyReport: (r) => weekly.push(r), log: (m) => logs.push(String(m))
  });
  try { await run({ persona, dir, clock, calls, weekly, logs, live: () => JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')) }); }
  finally { persona.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

await test('未初始化（出厂值没确认）时不判读、不注入', async () => {
  await withPersona(async ({ persona, calls, live }) => {
    persona.console.saveConfig({ apiKey: 'sk-test' });
    await persona.onIncoming({ key: 'private:2001', kind: 'private', userId: '2001', name: '主人', text: '你好菜', directed: true });
    assert.equal(calls.length, 0);
    assert.equal(live().core, '');
    assert.deepEqual(live().byKey, {});
  });
});

await test('初始化：模型提议出厂值 → 确认 → live.json 出现性格与会话映射；密钥只回显提示', async () => {
  await withPersona(async ({ persona, live }) => {
    const cfg = persona.console.saveConfig({ apiKey: 'sk-1234567890' });
    assert.equal(cfg.apiKeyHint, 'sk-1…7890（13 位）');
    const proposal = await persona.console.proposeFactory();
    assert.equal(proposal.traits.O, 70);
    persona.console.confirmFactory(proposal);
    const l = live();
    assert.match(l.core, /【你现在的性格】/);
    assert.match(l.core, /我嘴硬但其实在意/);
    assert.equal(l.sessions['session-aaa'], 'private:2001');
    assert.match(l.byKey['group:9'], /^【你此刻】/);
  }, { fetchQueue: [reply(FACTORY)] });
});

await test('私聊被骂：情绪、关系、证据、判读日志都更新；快照出现原因；群里只串情绪不带原因', async () => {
  await withPersona(async ({ persona, dir, live }) => {
    persona.console.saveConfig({ apiKey: 'sk-test' });
    persona.console.confirmFactory(FACTORY);
    await persona.onIncoming({ key: 'private:2001', kind: 'private', userId: '2001', name: '阿青', text: '你好菜', directed: true, context: ['阿青：在吗'] });
    const l = live();
    assert.match(l.byKey['private:2001'], /委屈（阿青说你菜，刚刚）/);
    assert.doesNotMatch(l.byKey['group:9'], /阿青说你菜/);
    const people = persona.console.people();
    assert.equal(people[0].userId, '2001');
    assert.ok(people[0].trust < 30);
    // v2：除了判读证据，还会多一行代码派生的后天性格事件（§1.3），所以按 about 分开断言。
    const evidence = persona.console.evidence();
    assert.equal(evidence.filter((e) => e.about !== 'char').length, 1);
    const charRow = evidence.find((e) => e.about === 'char');
    assert.equal(charRow?.type, 'insult', '被真骂 → 派生「更记仇」事件');
    assert.equal(charRow?.derived, true);
    assert.equal(charRow?.gist, undefined, '派生行不存原文');
    assert.ok(fs.existsSync(path.join(dir, '小鲸鱼', 'appraisals', 'private_2001')));
    const appraisalLog = fs.readFileSync(path.join(dir, '小鲸鱼', 'appraisals', 'private_2001', '2026-11.jsonl'), 'utf8');
    assert.doesNotMatch(appraisalLog, /你好菜/, '判读日志不存原文');
  }, { fetchQueue: [reply(INSULT)] });
});

await test('群聊里和她无关的普通消息不逐条调模型，攒够 20 条合批一次', async () => {
  await withPersona(async ({ persona, calls }) => {
    persona.console.saveConfig({ apiKey: 'sk-test' });
    persona.console.confirmFactory(FACTORY);
    for (let i = 0; i < 19; i++) await persona.onIncoming({ key: 'group:9', kind: 'group', userId: String(3000 + i), name: `路人${i}`, text: `今天天气${i}`, directed: false });
    assert.equal(calls.length, 0);
    await persona.onIncoming({ key: 'group:9', kind: 'group', userId: '3999', name: '路人', text: '吃了吗', directed: false });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(calls[0].messages[1].content, /整体气氛/);
  }, { fetchQueue: [reply({ ...INSULT, target: 'none', kind: 'normal', evidence: [] })] });
});

await test('期望落空：她说完话 30 分钟私聊没人接 → 委屈 + 证据；对方回了就不算', async () => {
  await withPersona(async ({ persona, clock, live }) => {
    persona.console.confirmFactory(FACTORY);
    persona.console.saveConfig({ settings: { appraisal: { mode: 'rules' } } });
    persona.onOutgoing({ key: 'private:2001' });
    clock.t += 31 * 60000;
    persona.tick();
    assert.match(live().byKey['private:2001'], /委屈（说的话没人接/);
    // v2 的派生性格事件也叫 ignored（§2.2 CHAR_EVENTS），所以只数判读证据那一行。
    assert.equal(persona.console.evidence().filter((e) => e.type === 'ignored' && e.about !== 'char').length, 1);
    persona.onOutgoing({ key: 'group:9' });
    await persona.onIncoming({ key: 'group:9', kind: 'group', userId: '2002', name: '小满', text: '@她 哈哈', directed: true });
    clock.t += 11 * 60000;
    persona.tick();
    assert.equal(persona.console.evidence().filter((e) => e.type === 'ignored' && e.about !== 'char').length, 1);
  });
});

await test('拍一拍 → 害羞；inject=false 时 live.json 清空但状态照常更新（影子期）', async () => {
  await withPersona(async ({ persona, live }) => {
    persona.console.confirmFactory(FACTORY);
    persona.console.saveConfig({ settings: { inject: false } });
    persona.onPoke({ key: 'group:9', userId: '2002', name: '小满' });
    assert.equal(live().core, '');
    assert.match(persona.console.status().rendered.byKey['group:9'], /害羞（小满拍了拍你/);
  });
});

await test('ownLifeLine：心情低落时允许跟主人表达，每天最多 2 次；安静时段不允许', async () => {
  await withPersona(async ({ persona, clock }) => {
    persona.console.confirmFactory(FACTORY);
    persona.console.saveConfig({ settings: { appraisal: { mode: 'rules' } } });
    for (let i = 0; i < 6; i++) await persona.onIncoming({ key: 'private:2001', kind: 'private', userId: '2001', name: '主人', text: '你个废物！！', directed: true });
    assert.match(persona.ownLifeLine(), /可以直接给他发一句/);
    assert.match(persona.ownLifeLine(), /可以直接给他发一句/);
    assert.doesNotMatch(persona.ownLifeLine(), /可以直接给他发一句/);
    clock.t = Date.parse('2026-11-03T03:00:00');
    assert.doesNotMatch(persona.ownLifeLine(), /可以直接给他发一句/);
  });
});

await test('夜间结算按时触发一次、可锁定、可回滚；周日出周报并回调', async () => {
  await withPersona(async ({ persona, clock, weekly }) => {
    persona.console.confirmFactory(FACTORY);
    persona.console.saveConfig({ settings: { appraisal: { mode: 'rules' } } });
    persona.console.lock('N', true);
    clock.t = Date.parse('2026-11-08T03:31:00'); // 周日
    persona.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(persona.console.snapshots(), ['2026-11-08']);
    assert.equal(weekly.length, 1);
    persona.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(weekly.length, 1, '同一天只结算一次');
    assert.equal(persona.console.status().core.traits.N.locked, true);
    assert.equal(persona.console.rollback('2026-11-08').ok, true);
    assert.throws(() => persona.console.lock('X', true), /未知特质/);
  });
});

await test('状态目录写失败时，onPoke / onOutgoing / ownLifeLine 不抛异常、记日志（桥接主路径不能被带崩）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-broken-'));
  const logs = [];
  let roleName = '小鲸鱼';
  const persona = createPersona({
    stateDir: dir, roleName: () => roleName, roleCard: () => '# 角色卡\n傲娇嘴硬，心软。', sessions: () => ({}), ownerQQ: () => '2001',
    fetchImpl: async () => { throw new Error('不该联网'); }, now: () => Date.parse('2026-11-02T12:00:00'), log: (m) => logs.push(String(m))
  });
  try {
    persona.console.confirmFactory(FACTORY);
    // 模拟「目录被删 + 不可写」：POSIX 用 0o500；Windows 的 chmod 不阻止写入，
    // 改用「在角色目录的位置放一个文件」，mkdir 同样会失败。
    fs.rmSync(path.join(dir, '小鲸鱼'), { recursive: true, force: true });
    const blockedRoleDir = path.join(dir, '小鲸鱼2');
    const windowsBlock = process.platform === 'win32';
    if (windowsBlock) fs.writeFileSync(blockedRoleDir, 'block');
    else fs.chmodSync(dir, 0o500);
    if (!windowsBlock && process.getuid?.() === 0) {
      console.log('SKIP 状态目录 0o500 对 root 不生效，跳过写失败断言');
    } else {
      roleName = '小鲸鱼2'; // 换个角色名，逼 ready() 重新读盘，命中「目录建不出来」
      assert.doesNotThrow(() => persona.onOutgoing({ key: 'private:2001' }));
      assert.doesNotThrow(() => persona.onPoke({ key: 'group:9', userId: '2002', name: '小满' }));
      assert.equal(typeof persona.ownLifeLine(), 'string');
      assert.equal(logs.filter((l) => /失败/.test(l)).length, 3, logs.join('\n'));
      assert.match(logs.join('\n'), /\[persona\] onPoke 失败：/);
    }
  } finally {
    if (process.platform === 'win32') fs.rmSync(path.join(dir, '小鲸鱼2'), { force: true });
    else fs.chmodSync(dir, 0o700);
    persona.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('影子期（inject=false）：ownLifeLine 返回空串且不消耗表达次数；周日结算照常写周报但不回调', async () => {
  await withPersona(async ({ persona, clock, weekly }) => {
    persona.console.confirmFactory(FACTORY);
    persona.console.saveConfig({ settings: { inject: false, appraisal: { mode: 'rules' } } });
    for (let i = 0; i < 6; i++) await persona.onIncoming({ key: 'private:2001', kind: 'private', userId: '2001', name: '主人', text: '你个废物！！', directed: true });
    assert.equal(persona.ownLifeLine(), '', '影子期不给她任何心情文字');
    const meta = persona.console.status().meta;
    assert.equal(meta.expressCount ?? 0, 0, '影子期不消耗每天的表达次数');
    assert.notEqual(meta.expressDay, '2026-11-02', '影子期不写 expressDay');
    // 恢复注入后同样的状态能返回心情，证明不是一直返回空。
    persona.console.saveConfig({ settings: { inject: true } });
    assert.ok(persona.ownLifeLine().length > 0, '恢复注入后应能返回心情');
    // 周日结算：影子期照常写周报（控制台能看），但不回调给主人发提示。
    persona.console.saveConfig({ settings: { inject: false } });
    clock.t = Date.parse('2026-11-08T03:31:00'); // 周日
    persona.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(weekly.length, 0, '影子期不回调周报');
    const reports = persona.console.reports();
    assert.equal(reports.length, 1, '周报照常写盘');
    assert.match(persona.console.report(reports[0]), /她这周的变化/);
  });
});

// ── v2（A1 + B1 + B2 + B3）胶水层新增用例 ───────────────────────────────────

const V1_CORE = {
  version: 1,
  traits: {
    O: { factory: 70, value: 70, locked: false },
    C: { factory: 45, value: 45, locked: false },
    E: { factory: 35, value: 35, locked: false },
    A: { factory: 30, value: 30, locked: false },
    N: { factory: 55, value: 55, locked: false }
  },
  beliefs: [{ type: 'prior', text: '我嘴硬但其实在意', status: 'accepted', prior: true, acceptedAt: 0, refreshedAt: 0, keys: [] }],
  confirmedAt: Date.parse('2026-10-20T00:00:00')
};
// 雷点：模型判读说这条玩笑戳到了「被叫大肥鱼」，trigger 由归一化按 prefIds 校验后保留。
const PREF_TEASE = { target: 'me', kind: 'tease', emotion: { label: '', intensity: 0.6 }, pad: { p: -1, a: 1, d: 0 }, relation: { intimacy: 0, trust: 0 }, evidence: [], salience: 0.5, trigger: 'p1', cause: '被叫大肥鱼' };

await test('v1 core 读进来自动升级到 v2（后天性格补 50、manifests / prefs 补齐、traitView 11 项）', async () => {
  await withPersona(async ({ persona }) => {
    const st = persona.console.status();
    assert.equal(st.initialized, true);
    assert.equal(st.core.version, 2);
    assert.deepEqual(Object.keys(st.core.character), ['grudge', 'clingy', 'guarded', 'playful', 'pride', 'empathy']);
    assert.equal(st.core.character.grudge.value, 50);
    assert.deepEqual(st.core.manifests, {});
    assert.deepEqual(st.core.prefs, []);
    assert.match(st.rendered.core, /我嘴硬但其实在意/);
    assert.equal(st.traitView.length, 11);
    assert.deepEqual(st.traitView.map((t) => t.group), ['big5', 'big5', 'big5', 'big5', 'big5', 'char', 'char', 'char', 'char', 'char', 'char']);
    const grudge = st.traitView.find((t) => t.key === 'grudge');
    assert.equal(grudge.name, '记仇');
    assert.equal(grudge.level, '中等');
    assert.equal(grudge.band, '中');
    assert.equal(grudge.phrase, '', '中档没有一般表现');
    assert.equal(grudge.phraseSource, '');
  }, { files: { '小鲸鱼/core.json': V1_CORE } });
});

await test('雷点命中：好恶 hits +1 并落盘，同时写下派生的后天性格证据（tease_hurt）', async () => {
  await withPersona(async ({ persona, dir, clock }) => {
    persona.console.saveConfig({ apiKey: 'sk-test' });
    persona.console.confirmFactory({ ...FACTORY, prefs: [{ text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'] }] });
    const before = persona.console.status().core.prefs[0];
    assert.equal(before.id, 'p1');
    assert.equal(before.hits, 0);
    await persona.onIncoming({ key: 'private:2001', kind: 'private', userId: '2001', name: '阿青', text: '大肥鱼来啦', directed: true });
    const after = persona.console.status().core.prefs[0];
    assert.equal(after.hits, 1);
    assert.equal(after.lastHitAt, clock.t);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '小鲸鱼', 'core.json'), 'utf8'));
    assert.equal(saved.prefs[0].hits, 1, '命中次数要落盘（重启后不清零）');
    const charRow = persona.console.evidence().find((e) => e.about === 'char');
    assert.ok(charRow, '应写下派生性格证据');
    assert.equal(charRow.type, 'tease_hurt');
    assert.equal(charRow.derived, true);
    assert.equal(charRow.userId, '2001');
    assert.equal(charRow.key, 'private:2001');
    assert.equal(charRow.gist, undefined, '派生行没有原文');
    // 雷点把方向强制为负面，标签换成「生气」
    assert.ok(persona.console.status().emotion.labels.some((l) => l.name === '生气'));
  }, { fetchQueue: [reply(PREF_TEASE)] });
});

await test('期望落空：黏人越高越早觉得被晾着（等待分钟 × expectMul）', async () => {
  // 看证据比看渲染文字稳：黏人低时 missGain 也小，委屈标签可能小到不显示。
  const fired = (persona) => persona.console.evidence().some((e) => e.type === 'ignored' && e.about !== 'char');
  await withPersona(async ({ persona, clock }) => {
    persona.console.confirmFactory({ ...FACTORY, character: { clingy: 100 } }); // 30 × 0.6 = 18 分钟
    persona.console.saveConfig({ settings: { appraisal: { mode: 'rules' } } });
    persona.onOutgoing({ key: 'private:2001' });
    clock.t += 17 * 60000;
    persona.tick();
    assert.equal(fired(persona), false, '17 分钟还没到 18 分钟');
    clock.t += 2 * 60000;
    persona.tick();
    assert.equal(fired(persona), true, '19 分钟已经超过 18 分钟');
  });
  await withPersona(async ({ persona, clock }) => {
    persona.console.confirmFactory({ ...FACTORY, character: { clingy: 0 } }); // 30 × 1.4 = 42 分钟
    persona.console.saveConfig({ settings: { appraisal: { mode: 'rules' } } });
    persona.onOutgoing({ key: 'private:2001' });
    clock.t += 35 * 60000;
    persona.tick();
    assert.equal(fired(persona), false, '35 分钟还没到 42 分钟');
    clock.t += 8 * 60000;
    persona.tick();
    assert.equal(fired(persona), true, '43 分钟已经超过 42 分钟');
  });
});

await test('ownLifeLine 的表达门槛由嘴硬决定（原来写死 −0.15）', async () => {
  await withPersona(async ({ persona }) => {
    persona.console.saveConfig({ settings: { appraisal: { mode: 'rules' } } });
    persona.console.confirmFactory({ ...FACTORY, character: { guarded: 100 } }); // 门槛 −0.30
    await persona.onIncoming({ key: 'private:2001', kind: 'private', userId: '2001', name: '主人', text: '你个废物！！', directed: true });
    assert.doesNotMatch(persona.ownLifeLine(), /可以直接给他发一句/, '嘴硬高：还没低落到门槛');
    persona.console.confirmFactory({ ...FACTORY, character: { guarded: 0 } }); // 门槛 0
    assert.match(persona.ownLifeLine(), /可以直接给他发一句/, '嘴硬低：同样的心情就肯说');
  });
});

await test('关系冷启动：seedPreview 只往上补，seedApply 只写 changed（可过滤）、日志只记人数', async () => {
  const stats = [
    { userId: '2001', name: '主人', messages: 53, firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-31T00:00:00.000Z' },
    { userId: '2002', name: '小满', messages: 32, firstSeenAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-31T00:00:00.000Z' },
    { userId: '2003', name: '路人', messages: 0, firstSeenAt: '2026-10-31T00:00:00.000Z', lastSeenAt: '2026-10-31T00:00:00.000Z' },
    { userId: 'not-a-qq', name: '非数字', messages: 9 }
  ];
  // 已判读过的 2002：亲密 30、信任 50、熟悉 20 —— 播种值是 26 / 39 / 40，只有熟悉能往上补。
  const people = { 2002: { name: '小满', intimacy: 30, trust: 50, familiarity: 20, offsets: { O: 0, C: 0, E: 0, A: 0, N: 0 }, beliefs: [], nickname: '', jokes: [], trustDay: { day: '', gain: 0, loss: 0 }, lastSeenAt: 0, createdAt: 0 } };
  await withPersona(async ({ persona, dir, logs }) => {
    persona.console.confirmFactory(FACTORY);
    const { proposals } = persona.console.seedPreview();
    assert.equal(proposals.length, 2, '跳过 0 条消息的非主人和非数字 QQ');
    assert.equal(proposals[0].userId, '2001', '主人排第一');
    assert.equal(proposals[0].isOwner, true);
    assert.deepEqual(proposals[0].after, { intimacy: 72, trust: 72, familiarity: 60 });
    assert.equal(proposals[0].stageAfter, '亲近');
    const p2 = proposals.find((p) => p.userId === '2002');
    assert.deepEqual(p2.before, { intimacy: 30, trust: 50, familiarity: 20 });
    assert.deepEqual(p2.after, { intimacy: 30, trust: 50, familiarity: 40 });
    assert.equal(p2.changed, true);
    // 只启用了 2002：过滤生效，2001 不写
    assert.deepEqual(persona.console.seedApply(['2002']), { applied: ['2002'] });
    let saved = JSON.parse(fs.readFileSync(path.join(dir, '小鲸鱼', 'people.json'), 'utf8'));
    assert.equal(saved['2002'].familiarity, 40);
    assert.equal(saved['2002'].intimacy, 30, '只往上补，不往下压');
    assert.equal(saved['2002'].trust, 50, '只往上补，不往下压');
    assert.ok(saved['2002'].seededAt > 0);
    assert.equal(saved['2001'], undefined);
    // 再来一次：2002 已经没有变化，只写 2001
    assert.deepEqual(persona.console.seedApply(), { applied: ['2001'] });
    saved = JSON.parse(fs.readFileSync(path.join(dir, '小鲸鱼', 'people.json'), 'utf8'));
    assert.equal(saved['2001'].name, '主人');
    assert.equal(saved['2001'].intimacy, 72);
    const seedLogs = logs.filter((l) => /关系冷启动/.test(l));
    assert.equal(seedLogs.length, 2);
    assert.ok(seedLogs.every((l) => /写入 1 人/.test(l)));
    assert.ok(seedLogs.every((l) => !/2001|2002|主人|小满/.test(l)), `日志不能带名字或 QQ 号：${seedLogs.join(' / ')}`);
  }, { peopleStats: () => stats, files: { '小鲸鱼/people.json': people } });
});

await test('未初始化时 savePrefs / seedPreview / seedApply 都报「先确认出厂性格」', async () => {
  await withPersona(async ({ persona }) => {
    assert.throws(() => persona.console.savePrefs([]), /先确认出厂性格/);
    assert.throws(() => persona.console.seedPreview(), /先确认出厂性格/);
    assert.throws(() => persona.console.seedApply(), /先确认出厂性格/);
  });
});

await test('savePrefs：只改好恶不重提出厂，live.json 的性格文字里出现好恶与雷点', async () => {
  await withPersona(async ({ persona, live }) => {
    persona.console.confirmFactory(FACTORY);
    persona.console.savePrefs([
      { text: '被认真夸', valence: 'like', strength: 0.7, keywords: ['夸我'] },
      { text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'] }
    ]);
    const prefs = persona.console.status().core.prefs;
    assert.deepEqual(prefs.map((p) => p.id), ['p1', 'p2']);
    assert.deepEqual(prefs.map((p) => p.valence), ['like', 'dislike']);
    assert.match(live().core, /你喜欢：被认真夸/);
    assert.match(live().core, /你讨厌：被叫大肥鱼（雷点）/);
    // 坏数据整条丢掉，不会把半截好恶写进提示词
    persona.console.savePrefs([{ text: '淋雨', valence: 'like', strength: 0.6 }, { text: '没有类型', strength: 0.6 }]);
    assert.deepEqual(persona.console.status().core.prefs.map((p) => p.text), ['淋雨']);
  });
});

// 预置一个「已经养成过」的 v2 core：O 出厂 60 / 当前 63（偏移 +3）、guarded 出厂 50 / 当前 55（偏移 +5）、
// N 出厂 50 / 当前 80（偏移 +30，历史数据超出 maxDrift），其余项当前 = 出厂。
const CULTIVATED_CORE = {
  version: 2,
  traits: {
    O: { factory: 60, value: 63, locked: false },
    C: { factory: 50, value: 50, locked: false },
    E: { factory: 50, value: 50, locked: false },
    A: { factory: 50, value: 50, locked: false },
    N: { factory: 50, value: 80, locked: false }
  },
  character: {
    grudge: { factory: 50, value: 50, locked: true },
    clingy: { factory: 50, value: 50, locked: false },
    guarded: { factory: 50, value: 55, locked: false },
    playful: { factory: 50, value: 50, locked: false },
    pride: { factory: 50, value: 50, locked: false },
    empathy: { factory: 50, value: 50, locked: false }
  },
  manifests: {},
  prefs: [],
  beliefs: [{ type: 'praised', text: '我被人认真夸过', status: 'accepted', prior: false, acceptedAt: 0, refreshedAt: 0, keys: [] }],
  confirmedAt: Date.parse('2026-10-20T00:00:00')
};

await test('确认出厂性格：已养成的偏移跟着出厂值移动（没养成的正好等于新出厂值）、偏移超边界被夹住；可锁后天性格、表现与好恶整体替换', async () => {
  await withPersona(async ({ persona, live }) => {
    assert.equal(persona.console.lock('grudge', true).character.grudge.locked, true);
    assert.equal(persona.console.lock('O', true).traits.O.locked, true);
    assert.throws(() => persona.console.lock('nope', true), /未知特质/);
    persona.console.confirmFactory({
      traits: { O: 70, C: 50, E: 50, A: 50, N: 60 },
      character: { grudge: 86, guarded: 40 },
      manifests: { C: '答应的事会做到，做不到会先说', grudge: '生气能记三天' },
      prefs: [{ text: '被认真夸', valence: 'like', strength: 0.7 }],
      beliefs: ['我嘴硬但其实在意', '我其实很好哄']
    });
    const core = persona.console.status().core;
    // ① 没养成过（当前 = 旧出厂）：当前值正好等于新出厂值。
    //    v1 → v2 升级后 6 项后天性格补的 50/50，重新确认出厂 86 时必须还是 86，而不是被夹到 71。
    assert.equal(core.character.grudge.factory, 86);
    assert.equal(core.character.grudge.value, 86, '补出来的 50/50 重新确认后应等于新出厂值');
    assert.equal(core.traits.C.value, 50);
    // ② 养成过的项：偏移保留并跟着出厂值走（旧 60/63 → 新出厂 70 得 73；旧 50/55 → 新出厂 40 得 45）。
    assert.equal(core.traits.O.value, 73);
    assert.equal(core.character.guarded.value, 45);
    // ③ 偏移超出新边界：旧 50/80（+30）→ 新出厂 60 得 90，夹到 60 + maxDrift = 75。
    assert.equal(core.traits.N.value, 75);
    assert.equal(core.character.grudge.locked, true, '锁定状态保留');
    assert.equal(core.traits.O.locked, true, '大五的锁定也保留');
    assert.deepEqual(core.manifests.C, { band: '中', text: '答应的事会做到，做不到会先说' });
    assert.equal(core.prefs.length, 1);
    assert.match(live().core, /尽责中等：答应的事会做到，做不到会先说/);
    assert.equal(core.beliefs.filter((b) => b.prior).length, 2, '先验信念整体替换');
    assert.ok(core.beliefs.some((b) => b.text === '我被人认真夸过'), '养成出来的信念保留');
  }, { files: { '小鲸鱼/core.json': CULTIVATED_CORE } });
});

// ── v2 §12.1：角色卡变更提醒 ────────────────────────────────────────────────

await test('角色卡变更提醒：确认时记录版本；改卡 → changed，只改行尾/首尾空白 → 不算；ackCard 后恢复；重新确认按新卡记录', async () => {
  let card = '# 角色卡\n傲娇嘴硬，心软。';
  await withPersona(async ({ persona }) => {
    persona.console.confirmFactory(FACTORY);
    let c = persona.console.status().card;
    assert.equal(c.recorded, true);
    assert.equal(c.changed, false);
    assert.equal(c.recordedAt, Date.parse('2026-11-02T12:00:00'));
    // 只改行尾 CRLF 和首尾空白：归一化后哈希不变
    card = '\n# 角色卡\r\n傲娇嘴硬，心软。  \n';
    assert.equal(persona.console.status().card.changed, false);
    // 真改了文字
    card = '# 角色卡\n傲娇嘴硬，其实很黏人。';
    assert.equal(persona.console.status().card.changed, true);
    // 「不影响性格，忽略」→ 记成已同步
    const acked = persona.console.ackCard();
    assert.equal(acked.recorded, true);
    assert.equal(acked.changed, false);
    assert.equal(persona.console.status().card.changed, false, 'ack 之后不再提示');
    // 重新确认出厂性格：按当前（新）角色卡记录版本
    card = '# 角色卡\n完全换了个人。';
    assert.equal(persona.console.status().card.changed, true);
    persona.console.confirmFactory(FACTORY);
    assert.equal(persona.console.status().card.changed, false);
  }, { roleCard: () => card });
});

await test('角色卡变更提醒：没记录过版本（v2 之前确认的 core）→ recorded=false、changed=null，ackCard 补记录', async () => {
  await withPersona(async ({ persona }) => {
    let c = persona.console.status().card;
    assert.equal(c.recorded, false);
    assert.equal(c.changed, null);
    assert.equal(c.recordedAt, 0);
    const acked = persona.console.ackCard();
    assert.equal(acked.recorded, true);
    assert.equal(acked.changed, false);
    assert.ok(acked.recordedAt > 0);
  }, { files: { '小鲸鱼/core.json': V1_CORE } });
});

await test('角色卡变更提醒：未初始化时 card 为 null，ackCard 抛「先确认出厂性格」', async () => {
  await withPersona(async ({ persona }) => {
    assert.equal(persona.console.status().card, null);
    assert.throws(() => persona.console.ackCard(), /先确认出厂性格/);
  });
});

// ── HANDOFF §6-1 / §6-4：判读用量落盘 + 首次确认不跑空结算 ─────────────────
const todayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const incoming = (userId, text) => ({ key: `private:${userId}`, kind: 'private', userId, name: '阿青', text, directed: true });

await test('用量落盘（§6-1）：判读两次后 tick 写入 usage.json —— 1 条运行、calls 2、cost > 0、权限 600', async () => {
  await withPersona(async ({ persona, dir, clock }) => {
    persona.console.saveConfig({ apiKey: 'sk-test' });
    persona.console.confirmFactory(FACTORY);
    await persona.onIncoming(incoming('2001', '你好菜'));
    await persona.onIncoming(incoming('2001', '你真菜'));
    persona.tick();
    const f = path.join(dir, 'usage.json');
    assert.ok(fs.existsSync(f), 'tick 应把用量写盘');
    assertPosixMode(f, 0o600);
    const u = JSON.parse(fs.readFileSync(f, 'utf8'));
    const day = todayOf(clock.t);
    const runs = Object.values(u.days[day] ?? {});
    assert.equal(runs.length, 1, '同一次运行只占一条');
    assert.equal(runs[0].calls, 2);
    assert.ok(runs[0].cost > 0, `花费应大于 0：${runs[0].cost}`);
  }, { fetchQueue: [reply(INSULT), reply(INSULT)] });
});

await test('用量落盘（§6-1）：没有任何判读时 tick 不创建 usage.json', async () => {
  await withPersona(async ({ persona, dir }) => {
    persona.console.confirmFactory(FACTORY);
    persona.tick();
    assert.equal(fs.existsSync(path.join(dir, 'usage.json')), false, '全 0 时不建文件');
  });
});

await test('用量落盘（§6-1）：同一天重启两次，status().usage 把两次运行加起来（calls 3、runs 2）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-usage-'));
  const clock = { t: Date.parse('2026-11-02T12:00:00') };
  const make = (queue) => createPersona({
    stateDir: dir, roleName: () => '小鲸鱼', roleCard: () => '# 角色卡\n傲娇嘴硬，心软。', sessions: () => ({}), ownerQQ: () => '2001',
    fetchImpl: async (url, init) => { const r = queue.shift(); if (!r) throw new Error('no more fake responses'); return r; },
    now: () => clock.t, log: () => {}
  });
  const p1 = make([reply(INSULT), reply(INSULT)]);
  try {
    p1.console.saveConfig({ apiKey: 'sk-test' });
    p1.console.confirmFactory(FACTORY);
    await p1.onIncoming(incoming('2001', '你好菜'));
    await p1.onIncoming(incoming('2001', '你真菜'));
    p1.stop(); // 停桥接：stop 里落一次盘
    clock.t += 1000; // 「重启」后时钟往后挪 1 秒，运行标识不同
    const p2 = make([reply(INSULT)]);
    try {
      await p2.onIncoming(incoming('2001', '又来了'));
      p2.tick();
      const usage = p2.console.status().usage;
      assert.equal(usage.length, 7);
      const last = usage[usage.length - 1];
      assert.equal(last.day, todayOf(clock.t));
      assert.equal(last.calls, 3, '两次运行的 calls 相加');
      assert.equal(last.runs, 2, '同一天两次运行');
      assert.equal(last.recorded, true);
      assert.deepEqual(usage.map((r) => r.day), [...usage.map((r) => r.day)].sort(), '日期升序');
    } finally { p2.stop(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('status().usage（§6-1）：logged 与判读日志一致；没有记录的前几天 recorded=false、数值为 0', async () => {
  await withPersona(async ({ persona }) => {
    persona.console.saveConfig({ apiKey: 'sk-test' });
    persona.console.confirmFactory(FACTORY);
    await persona.onIncoming(incoming('2001', '你好菜'));
    await persona.onIncoming(incoming('2001', '你真菜'));
    persona.tick();
    const usage = persona.console.status().usage;
    assert.equal(usage.length, 7);
    const last = usage[usage.length - 1];
    assert.equal(last.day, '2026-11-02');
    assert.ok(last.logged.model >= 2, `今日模型判读日志应 ≥ 2，实际 ${last.logged.model}`);
    assert.equal(last.logged.rules, 0);
    for (const r of usage.slice(0, -1)) {
      assert.equal(r.recorded, false, `${r.day} 不应有用量记录`);
      assert.equal(r.calls, 0);
      assert.equal(r.rules, 0);
      assert.equal(r.cost, 0);
      assert.equal(r.runs, 0);
      assert.deepEqual(r.logged, { model: 0, rules: 0 });
    }
  }, { fetchQueue: [reply(INSULT), reply(INSULT)] });
});

await test('用量落盘（§6-1）：只保留最近 60 天，今天始终在内', async () => {
  const days = {};
  const base = new Date(2026, 3, 1); // 2026-04-01 起 61 天，全部早于今天（2026-11-02）
  for (let i = 0; i < 61; i++) {
    const ms = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).getTime();
    days[todayOf(ms)] = { 'old-run': { calls: 1, rules: 0, failures: 0, cacheHit: 0, cacheMiss: 0, output: 0, cost: 0.001, updatedAt: ms } };
  }
  assert.equal(Object.keys(days).length, 61);
  await withPersona(async ({ persona, dir, clock }) => {
    persona.console.saveConfig({ apiKey: 'sk-test' });
    persona.console.confirmFactory(FACTORY);
    await persona.onIncoming(incoming('2001', '你好菜'));
    persona.tick();
    const u = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
    const keys = Object.keys(u.days);
    assert.ok(keys.length <= 60, `保留天数应 ≤ 60，实际 ${keys.length}`);
    assert.ok(keys.includes(todayOf(clock.t)), '今天要在里面');
  }, { fetchQueue: [reply(INSULT)], files: { 'usage.json': { version: 1, days } } });
});

await test('首次确认出厂性格不跑空结算（§6-4）：当天 04:00 不结算，第二天 03:31 结算一次', async () => {
  await withPersona(async ({ persona, clock }) => {
    persona.console.confirmFactory(FACTORY);
    assert.equal(persona.console.status().meta.nightlyDay, '2026-11-02');
    clock.t = Date.parse('2026-11-02T04:00:00');
    persona.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(persona.console.snapshots(), [], '确认当天不跑夜间结算，不留空快照');
    clock.t = Date.parse('2026-11-03T03:31:00');
    persona.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(persona.console.snapshots(), ['2026-11-03'], '第一次夜间结算在下一个日历日');
  });
});

await test('重新确认出厂性格不动 nightlyDay（§6-4）', async () => {
  await withPersona(async ({ persona }) => {
    assert.equal(persona.console.status().initialized, true);
    persona.console.confirmFactory(FACTORY);
    assert.equal(persona.console.status().meta.nightlyDay, '2026-10-31', '已初始化分支不碰 nightlyDay');
  }, { files: { '小鲸鱼/core.json': V1_CORE, '小鲸鱼/meta.json': { nightlyDay: '2026-10-31' } } });
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
