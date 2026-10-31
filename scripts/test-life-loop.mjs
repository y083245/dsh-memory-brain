// src/life-loop.js 的单测（LIFE_LOOP_PATCH，子项目 3 · 规格 docs/design/LIFE_LOOP_SPEC.md §6）。
//
// 假 ltm（严格按规格 §4.6 的签名和返回形状造）+ 假 persona + 临时日记目录 + 固定本地时刻。
// 重点钉住：素材范围（不读群聊、别人私聊不进池、open 约定不进池）、回忆额度与冷却、
// 到期唤醒的门槛 / 可见性 / 每人每天一次 / 全局上限 / 先记后投，以及状态文件坏了不崩。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLifeLoop } from '../src/life-loop.js';
import { createLongMemory } from '../src/long-memory.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const MIN = 60000;
const DAY = 86400000;
const NOW = new Date(2026, 9, 30, 12, 0).getTime(); // 2026-10-30 12:00 本地
const iso = (ms) => new Date(ms).toISOString();
const mmddOf = (ms) => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const near = (actual, expected, msg = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} 实际 ${actual}，期望 ${expected}`);

const OWNER = '2001';
const OWNER_KEY = `private:${OWNER}`;

/**
 * 假账本：严格的 §4.6 形状。
 * people: { [uid]: { name, items: [{ id, cat, text, at(ISO), scope, sourceKey, core, archivedAt, due, by, status }] } }
 * archives: { [key]: [{ t(ISO), dir, userId, name, text, msgId }] }
 */
function fakeLtm({ people = {}, archives = {} } = {}) {
  const calls = { personView: [], archiveRows: [], duePromises: [] };
  const visible = (item, viewerKey) => item.scope !== 'private' || !viewerKey || item.sourceKey === viewerKey;
  return {
    calls,
    visibleTo: visible,
    personView(uid, viewerKey = null) {
      calls.personView.push([String(uid), viewerKey]);
      const p = people[String(uid)];
      if (!p) return null;
      return { userId: String(uid), name: p.name ?? '', items: (p.items ?? []).filter((x) => visible(x, viewerKey)) };
    },
    listPeople() {
      return Object.keys(people).map((id) => ({ userId: id, name: people[id].name ?? '' }));
    },
    duePromises(day) {
      calls.duePromises.push(day);
      return Object.entries(people)
        .map(([uid, p]) => ({
          userId: uid,
          name: p.name ?? '',
          items: (p.items ?? []).filter((x) => x.cat === 'pending' && !x.archivedAt && (x.status ?? 'open') === 'open' && x.due === day),
        }))
        .filter((e) => e.items.length);
    },
    archiveRows(key, { sinceMs = 0, untilMs = Infinity, dir = null, limit = 2000 } = {}) {
      calls.archiveRows.push({ key, sinceMs, untilMs, dir });
      if (String(key).startsWith('group:')) throw new Error('life-loop 不该读群聊存档');
      const rows = (archives[key] ?? []).filter((r) => {
        const t = Date.parse(r.t);
        return t >= sinceMs && t < untilMs && (dir == null || r.dir === dir);
      });
      return rows.slice(-limit);
    },
  };
}

/** 建临时目录 + 生活回路实例；rngValues 按顺序喂，用完后一直返回最后一个值。 */
function withLifeLoop(run, {
  ltm = fakeLtm(), persona = null, diary = [], options = {}, rngValues = [1], nowMs = NOW,
  state = null, isAllowed = () => true, deliverPromiseWake = null, logs = [], ownerQQ = () => OWNER,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-loop-'));
  const diaryDir = path.join(dir, 'diary');
  fs.mkdirSync(diaryDir, { recursive: true });
  if (diary.length) fs.writeFileSync(path.join(diaryDir, 'index.jsonl'), diary.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const statePath = path.join(dir, 'life-loop.json');
  if (state !== null) fs.writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state));
  let ri = 0;
  const rng = () => (ri < rngValues.length ? rngValues[ri++] : rngValues[rngValues.length - 1]);
  const delivered = [];
  const ll = createLifeLoop({
    ltm, persona, diaryDir, statePath,
    ownerQQ,
    deliverPromiseWake: deliverPromiseWake ?? (async (key, text) => { delivered.push({ key, text }); }),
    isAllowed,
    options: {
      recallPerDay: 2, cooldownDays: 7, quiet: [3, 8],
      ...options,
      promiseWake: { enabled: true, at: '10:00', maxPerDay: 5, ...(options.promiseWake ?? {}) },
    },
    now: () => nowMs,
    rng,
    log: (m) => logs.push(String(m)),
  });
  return run({ ll, dir, diaryDir, statePath, delivered, logs }).finally(() => {
    ll.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const item = (o) => ({ scope: 'private', sourceKey: OWNER_KEY, ...o });
const diaryRow = (t, { title = '', mood = '', text = '' } = {}) => {
  const d = new Date(t);
  return { t, day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, title, mood, tags: [], text };
};

// ── 素材池 ───────────────────────────────────────────────────────────────────

const POOL_PEOPLE = {
  [OWNER]: {
    name: '主人',
    items: [
      item({ id: 'e1', cat: 'event', text: '一起去看了海', at: iso(NOW - 3 * DAY) }),
      item({ id: 'f1', cat: 'fact', text: '他怕辣', at: iso(NOW - 5 * DAY) }),
      item({ id: 'n1', cat: 'note', text: '他喜欢下雨天', at: iso(NOW - 4 * DAY) }),
      item({ id: 'n2', cat: 'note', text: '刚记下的', at: iso(NOW - 1 * DAY) }),
      item({ id: 'n3', cat: 'note', text: '已经归档的', at: iso(NOW - 4 * DAY), archivedAt: iso(NOW - 2 * DAY) }),
      item({ id: 'p1', cat: 'pending', text: '周末一起看电影', at: iso(NOW - 3 * DAY), due: '2026-10-31', by: 'them', status: 'open' }),
      item({ id: 'pc', cat: 'pending', text: '答应给他带伞', at: iso(NOW - 3 * DAY), due: '2026-10-31', by: 'me', status: 'open', core: true }),
      item({ id: 'pd', cat: 'pending', text: '曾经答应的事', at: iso(NOW - 3 * DAY), by: 'me', status: 'done', core: true }),
      item({ id: 't1', cat: 'trait', text: '怕冷', at: iso(NOW - 4 * DAY) }),
    ],
  },
  '2002': {
    name: '小满',
    items: [
      { id: 'pub1', cat: 'fact', text: '养了一只猫', at: iso(NOW - 3 * DAY), scope: 'public', sourceKey: 'group:9' },
      { id: 'priv1', cat: 'fact', text: '私下说的话', at: iso(NOW - 3 * DAY), scope: 'private', sourceKey: OWNER_KEY },
      { id: 'pub2', cat: 'event', text: '搬家了', at: iso(NOW - 10 * DAY), scope: 'public', sourceKey: 'group:9' },
      { id: 'pub3', cat: 'note', text: '别的 note', at: iso(NOW - 10 * DAY), scope: 'public', sourceKey: 'group:9' },
      { id: 'pub4', cat: 'fact', text: '刚说的', at: iso(NOW - 1 * DAY), scope: 'public', sourceKey: 'group:9' },
      { id: 'pub5', cat: 'fact', text: '归档的公开条目', at: iso(NOW - 10 * DAY), scope: 'public', sourceKey: 'group:9', archivedAt: iso(NOW) },
    ],
  },
  '2003': { name: '路人', items: [] },
};

const POOL_ARCHIVES = {
  [OWNER_KEY]: [
    { t: iso(NOW - 5 * DAY), dir: 'in', userId: OWNER, name: '主人', text: '今天下班路上看到一只很胖的橘猫，蹲在便利店门口', msgId: 'm1' },
    { t: iso(NOW - 5 * DAY + 5 * MIN), dir: 'out', userId: OWNER, name: '小鲸鱼', text: '橘猫是不是在蹭空调呀哈哈哈', msgId: 'm2' },
    { t: iso(NOW - 5 * DAY + 10 * MIN), dir: 'in', userId: OWNER, name: '主人', text: '[图片]', msgId: 'm3' },
    { t: iso(NOW - 1 * DAY), dir: 'in', userId: OWNER, name: '主人', text: '这是最近一两天说的话，不该进素材池的', msgId: 'm4' },
    { t: iso(NOW - 70 * DAY), dir: 'in', userId: OWNER, name: '主人', text: '很久以前说的话也在素材池外面', msgId: 'm5' },
  ],
  'group:9': [
    { t: iso(NOW - 5 * DAY), dir: 'in', userId: '2002', name: '小满', text: '群聊里说的话绝对不能进素材池', msgId: 'g1' },
  ],
};

const POOL_DIARY = [diaryRow(NOW - 5 * DAY, { title: '那天很热', mood: '踏实', text: '今天把窗台的花搬出去晒了一下午' })];

await test('素材池：主人账本 / 别人公开条目 / 主人私聊 / 旧日记；不含群聊存档、别人 private、open 约定、归档、太新的', async () => {
  const logs = [];
  const ltm = fakeLtm({ people: POOL_PEOPLE, archives: POOL_ARCHIVES });
  await withLifeLoop(async ({ ll }) => {
    const pool = ll.candidates(NOW);
    const ids = pool.map((c) => c.candId).sort();
    assert.deepEqual(ids, [
      'ltm:e1', 'ltm:f1', 'ltm:n1', 'ltm:pd', 'ltm:pub1', 'ltm:pub2', 'msg:m1', `diary:${NOW - 5 * DAY}`,
    ].sort());
    const by = Object.fromEntries(pool.map((c) => [c.candId, c]));
    assert.equal(by['ltm:e1'].text, `${mmddOf(NOW - 3 * DAY)} 那天：一起去看了海`);
    assert.equal(by['ltm:f1'].text, `${mmddOf(NOW - 5 * DAY)} 记下的：他怕辣`);
    assert.equal(by['ltm:pd'].text, `${mmddOf(NOW - 3 * DAY)} 记下的：曾经答应的事`);
    assert.equal(by['ltm:pub1'].text, '关于小满：养了一只猫');
    assert.equal(by['ltm:pub2'].text, '关于小满：搬家了');
    assert.equal(
      by['msg:m1'].text,
      `${mmddOf(NOW - 5 * DAY)} 他说：「今天下班路上看到一只很胖的橘猫，蹲在便利店门口」，你回：「橘猫是不是在蹭空调呀哈哈哈」`
    );
    assert.equal(by[`diary:${NOW - 5 * DAY}`].text, `${mmddOf(NOW - 5 * DAY)} 你写过日记《那天很热》：今天把窗台的花搬出去晒了一下午`);
    // 显著度
    near(by['ltm:e1'].salience, 0.7);
    near(by['ltm:f1'].salience, 0.5);
    near(by['ltm:n1'].salience, 0.4);
    near(by['ltm:pd'].salience, 0.9, 'core 条目最高');
    near(by['ltm:pub1'].salience, 0.4, '别人的公开条目 × 0.8');
    near(by['ltm:pub2'].salience, 0.56, '别人的公开条目 × 0.8');
    near(by['msg:m1'].salience, 0.3, '没有判读显著度时用默认值');
    near(by[`diary:${NOW - 5 * DAY}`].salience, 0.5);
    // 素材范围：只问主人私聊这一个 key
    assert.ok(ltm.calls.archiveRows.length > 0);
    assert.ok(ltm.calls.archiveRows.every((c) => c.key === OWNER_KEY), '只读主人私聊存档');
    assert.ok(ltm.calls.archiveRows.some((c) => c.dir === 'in'), '按 dir=in 取他说的话');
    // 文案里不能出现别人的私聊内容、群聊内容
    const all = pool.map((c) => c.text).join('\n');
    assert.doesNotMatch(all, /私下说的话|群聊里说的话|别的 note|归档|刚说的|刚记下的|怕冷/);
    assert.doesNotMatch(logs.join('\n'), /橘猫|一起看了海|养了一只猫/, '日志不写素材原文');
  }, { ltm, diary: POOL_DIARY, logs });
});

await test('素材池：没有 owner 时返回空数组，一次存档都不读', async () => {
  const ltm = fakeLtm({ people: POOL_PEOPLE, archives: POOL_ARCHIVES });
  await withLifeLoop(async ({ ll }) => {
    assert.deepEqual(ll.candidates(NOW), []);
    assert.equal(ltm.calls.archiveRows.length, 0);
  }, { ltm, ownerQQ: () => '' });
});

await test('素材池：只读主人私聊存档，group: 一次都不碰', async () => {
  const ltm = fakeLtm({ people: POOL_PEOPLE, archives: POOL_ARCHIVES });
  await withLifeLoop(async ({ ll }) => {
    assert.deepEqual(ll.candidates(NOW).map((c) => c.candId).filter((id) => id.startsWith('msg:')), ['msg:m1']);
    assert.ok(ltm.calls.archiveRows.every((c) => !c.key.startsWith('group:')));
  }, { ltm });
});

await test('判读显著度：< 0.3 的那句话不进池、高的用判读值', async () => {
  const archives = { [OWNER_KEY]: POOL_ARCHIVES[OWNER_KEY] };
  const lowPersona = { salienceByMsg: () => new Map([['m1', 0.15]]) };
  await withLifeLoop(async ({ ll }) => {
    assert.deepEqual(ll.candidates(NOW).filter((c) => c.source === 'msg'), []);
  }, { ltm: fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives }), persona: lowPersona });

  const highPersona = { salienceByMsg: () => new Map([['m1', 0.8]]) };
  await withLifeLoop(async ({ ll }) => {
    const msg = ll.candidates(NOW).filter((c) => c.source === 'msg');
    assert.equal(msg.length, 1);
    near(msg[0].salience, 0.8);
  }, { ltm: fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives }), persona: highPersona });
});

await test('素材池：别人公开条目里 status 缺省（=open）的核心约定不进池，已结束的进池', async () => {
  const people = {
    [OWNER]: { name: '主人', items: [] },
    '2002': {
      name: '小满',
      items: [
        // 未完成的核心约定：不算「忽然想起」的旧事（规格 §6.3：两行都排除 open 的约定）。
        { id: 'pubopen', cat: 'pending', text: '说好一起去看展', at: iso(NOW - 4 * DAY), scope: 'public', sourceKey: 'group:9', core: true, due: '2026-11-02' },
        { id: 'pubdone', cat: 'pending', text: '说好帮他搬家', at: iso(NOW - 4 * DAY), scope: 'public', sourceKey: 'group:9', core: true, status: 'done' },
      ],
    },
  };
  await withLifeLoop(async ({ ll }) => {
    const pool = ll.candidates(NOW);
    const ids = pool.map((c) => c.candId);
    assert.ok(!ids.includes('ltm:pubopen'), 'open 的约定不进池');
    assert.ok(ids.includes('ltm:pubdone'), '已经结束的约定可以进池');
    const done = pool.find((c) => c.candId === 'ltm:pubdone');
    assert.equal(done.text, '关于小满：说好帮他搬家');
    near(done.salience, 0.9 * 0.8);
  }, { ltm: fakeLtm({ people }) });
});

await test('账本 renderFor：event 的日期前缀用本地日期（凌晨记的事不会显示成前一天）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-tz-'));
  try {
    const lm = createLongMemory({ stateDir: dir });
    const { item } = lm.remember({ userId: OWNER, name: '主人', cat: 'event', text: '凌晨一起看流星', sourceKey: OWNER_KEY, scope: 'private' });
    // remember 写的 at 是「现在」；改成测试要的本地时刻 2026-10-25 01:30（东八区下 UTC 日期是 10-24）。
    const ledgerFile = path.join(dir, 'people.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    ledger.people[OWNER].items.find((x) => x.id === item.id).at = new Date(2026, 9, 25, 1, 30).toISOString();
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    const lm2 = createLongMemory({ stateDir: dir });
    const out = lm2.renderFor([OWNER], OWNER_KEY, { today: '2026-10-30' });
    assert.match(out, /2026-10-25 凌晨一起看流星/, `要按本地日期显示：${out}`);
    assert.doesNotMatch(out, /2026-10-24/, `不能再出现 UTC 那天：${out}`);
    // at 不是合法时间时退回原来的 slice(0, 10)，不炸
    const bad = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    bad.people[OWNER].items.find((x) => x.id === item.id).at = '不是时间戳';
    fs.writeFileSync(ledgerFile, JSON.stringify(bad));
    const lm3 = createLongMemory({ stateDir: dir });
    assert.match(lm3.renderFor([OWNER], OWNER_KEY, { today: '2026-10-30' }), /不是时间戳 凌晨一起看流星/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 回忆 ─────────────────────────────────────────────────────────────────────

const TWO_FACTS = {
  [OWNER]: {
    name: '主人',
    items: [
      item({ id: 'a1', cat: 'fact', text: '他小时候养过一只金毛', at: iso(NOW - 3 * DAY) }),
      item({ id: 'a2', cat: 'fact', text: '他高中去爬过泰山', at: iso(NOW - 3 * DAY) }),
    ],
  },
};

await test('回忆：每个活动日最多 2 条，第 3 次不再抽；跨活动日额度重置但 7 天内抽过的还会冷却', async () => {
  await withLifeLoop(async ({ ll }) => {
    const first = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(first, /【忽然想起】.*他小时候养过一只金毛/);
    assert.equal(ll.snapshot().recallToday, 1);
    const second = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(second, /【忽然想起】.*他高中去爬过泰山/);
    assert.equal(ll.snapshot().recallToday, 2);
    assert.equal(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }), '', '当天额度用完');
    // 换活动日：额度重置，但两条都在 7 天冷却里
    assert.equal(ll.composeOwnLife({ kind: 'day', now: NOW + DAY, remainingSlots: 1 }), '');
    // 8 天后：冷却过了，又能抽
    assert.match(ll.composeOwnLife({ kind: 'day', now: NOW + 8 * DAY, remainingSlots: 1 }), /【忽然想起】/);
    const history = ll.snapshot().history.filter((h) => h.kind === 'recall');
    assert.equal(history.length, 3);
    assert.equal(history[0].source, 'ltm');
    assert.ok(history[0].preview.length <= 20);
  }, { ltm: fakeLtm({ people: TWO_FACTS }), rngValues: [0] });
});

await test('回忆：rng 决定抽不抽（quota / remainingSlots 是门槛）', async () => {
  // quota 2 / remainingSlots 4 = 0.5
  await withLifeLoop(async ({ ll }) => {
    assert.match(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 4 }), /【忽然想起】/);
  }, { ltm: fakeLtm({ people: TWO_FACTS }), rngValues: [0.49, 0] });
  await withLifeLoop(async ({ ll }) => {
    assert.equal(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 4 }), '');
    assert.equal(ll.snapshot().recallToday, 0);
  }, { ltm: fakeLtm({ people: TWO_FACTS }), rngValues: [0.51] });
});

await test('权重公式：显著度 × 陈旧度 × 亲密度决定谁被抽到', async () => {
  // 账本条目（亲密度取 relationOf 的 40 → 0.7）vs 旧日记（亲密度 0.8），陈旧度按 4 天 / 10 天算。
  const people = { [OWNER]: { name: '主人', items: [item({ id: 'w1', cat: 'fact', text: '他喜欢在阳台发呆', at: iso(NOW - 4 * DAY) })] } };
  const diary = [diaryRow(NOW - 10 * DAY, { title: '旧日记', text: '那天什么都没干，就坐在窗边发呆' })];
  const wA = 0.5 * (4 / 14) * (0.5 + 40 / 200);
  const wB = 0.5 * (10 / 14) * 0.8;
  const cut = wA / (wA + wB);

  await withLifeLoop(async ({ ll }) => {
    assert.match(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }), /记下的：他喜欢在阳台发呆/);
  }, { ltm: fakeLtm({ people }), diary, persona: { relationOf: () => null }, rngValues: [0, cut - 0.01] });

  await withLifeLoop(async ({ ll }) => {
    assert.match(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }), /你写过日记《旧日记》/);
  }, { ltm: fakeLtm({ people }), diary, persona: { relationOf: () => null }, rngValues: [0, cut + 0.01] });
});

// ── 日记 ─────────────────────────────────────────────────────────────────────

await test('日记：白天只出现一次、半夜可以再看一眼、超过 3 天不出现；没心情就不写括号', async () => {
  const text = '今天把窗台的花搬出去晒了一下午，晚上收回来的时候叶子都挺起来了，看着特别舒服，'
    + '想起来他说的那句「浇花的时候别想工作」，就真的坐在那儿看了一会儿，什么也没干。';
  const diary = [diaryRow(NOW - DAY, { title: '窗台的花', mood: '踏实', text })];
  await withLifeLoop(async ({ ll }) => {
    const day = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 3 });
    assert.match(day, /^【你最近的日记】\d{2}-\d{2} \d{2}:\d{2}《窗台的花》（心情：踏实）：/);
    assert.match(day, /写新的之前看一眼，别写重复了。/);
    assert.ok([...text].length > 60);
    assert.ok(day.includes(`${[...text].slice(0, 60).join('')}…`), '正文截到 60 字加省略号');
    assert.equal(ll.snapshot().diaryShownT, NOW - DAY);
    assert.equal(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 3 }), '', '白天给过就不再给');
    assert.match(ll.composeOwnLife({ kind: 'midnight', now: NOW + 12 * 60 * MIN, remainingSlots: 1 }), /【你最近的日记】/, '半夜可以再看一眼');
  }, { ltm: fakeLtm(), diary, options: { recallPerDay: 0 } });

  await withLifeLoop(async ({ ll }) => {
    assert.equal(ll.composeOwnLife({ kind: 'midnight', now: NOW, remainingSlots: 1 }), '', '超过 3 天的日记不出现');
  }, { ltm: fakeLtm(), diary: [diaryRow(NOW - 4 * DAY, { title: '太久以前', text: '很久以前的日记' })], options: { recallPerDay: 0 } });

  await withLifeLoop(async ({ ll }) => {
    const out = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 3 });
    assert.match(out, /：今天心情一般，随便写两句$/m);
    assert.doesNotMatch(out, /（心情：/, '没写心情就不加括号');
    assert.doesNotMatch(out, /《/, '没写标题就不加书名号');
  }, { ltm: fakeLtm(), diary: [diaryRow(NOW - DAY, { text: '今天心情一般，随便写两句' })], options: { recallPerDay: 0 } });
});

// ── 到期唤醒 ─────────────────────────────────────────────────────────────────

const pending = (id, text, { due = '2026-10-30', by = 'them', scope = 'private', sourceKey = OWNER_KEY, status = 'open' } = {}) => ({
  id, cat: 'pending', text, at: iso(NOW - 3 * DAY), scope, sourceKey, due, by, status,
});
const duePeople = (items = [pending('p1', '周末一起看电影')]) => ({ [OWNER]: { name: '主人', items } });
const WAKE_TEXT = [
  '【到期的约定】今天是你和主人说好的日子：',
  '- 周末一起看电影（他答应的）〔p1〕',
  '想提就自然地提一句（别像闹钟一样念），也可以等他来找你再说；他在忙或不方便就别打扰。',
  '确认兑现了、没兑现、不做了，用 qq_ltm_update 标 status（done / missed / cancelled）。',
].join('\n');

await test('到期唤醒：10:00 之前不发、安静时段不发，到点发一次；文案带名字 / 谁答应的 / id', async () => {
  await withLifeLoop(async ({ ll, delivered }) => {
    await ll.tick(new Date(2026, 9, 30, 9, 59).getTime());
    assert.equal(delivered.length, 0, '10:00 之前不发');
    await ll.tick(new Date(2026, 9, 30, 3, 30).getTime());
    assert.equal(delivered.length, 0, '安静时段不发');
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].key, OWNER_KEY);
    assert.equal(delivered[0].text, WAKE_TEXT);
    await ll.tick(new Date(2026, 9, 30, 10, 1).getTime());
    assert.equal(delivered.length, 1, '每人每天只发一次');
    assert.deepEqual(ll.snapshot().promiseWakes, { day: '2026-10-30', users: [OWNER] });
    assert.deepEqual(ll.snapshot().history.at(-1), { at: new Date(2026, 9, 30, 10, 0).getTime(), kind: 'promise-wake', userId: OWNER, items: 1 });
  }, { ltm: fakeLtm({ people: duePeople() }) });
});

await test('到期唤醒：by 缺省写「约定」；多条按顺序列出', async () => {
  await withLifeLoop(async ({ ll, delivered }) => {
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    assert.match(delivered[0].text, /- 给他带伞（约定）〔p2〕/);
    assert.match(delivered[0].text, /- 周末一起看电影（你答应的）〔p3〕/);
  }, { ltm: fakeLtm({ people: duePeople([pending('p2', '给他带伞', { by: null }), pending('p3', '周末一起看电影', { by: 'me' })]) }) });
});

await test('到期唤醒：看不见的约定（别人的私聊）不投，没有可见条目就跳过', async () => {
  await withLifeLoop(async ({ ll, delivered }) => {
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    assert.equal(delivered.length, 0);
    assert.deepEqual(ll.snapshot().promiseWakes.users, []);
  }, { ltm: fakeLtm({ people: duePeople([pending('p1', '群里的约定', { sourceKey: 'group:9' })]) }) });
});

await test('到期唤醒：isAllowed=false 跳过，同一个人一天只记一次日志；之后再允许也不补发', async () => {
  const logs = [];
  let allow = false;
  await withLifeLoop(async ({ ll, delivered }) => {
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    await ll.tick(new Date(2026, 9, 30, 10, 1).getTime());
    await ll.tick(new Date(2026, 9, 30, 10, 2).getTime());
    assert.equal(delivered.length, 0);
    assert.equal(logs.filter((l) => /到期唤醒跳过/.test(l)).length, 1);
    allow = true;
    await ll.tick(new Date(2026, 9, 30, 10, 3).getTime());
    assert.equal(delivered.length, 1, '一旦允许就发');
  }, { ltm: fakeLtm({ people: duePeople() }), isAllowed: () => allow, logs });
});

await test('到期唤醒：先记后投（投递那一刻状态里已经有这个人），投递失败也不重试', async () => {
  const attempts = [];
  const logs = [];
  let llRef = null;
  await withLifeLoop(async ({ ll }) => {
    llRef = ll;
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    await ll.tick(new Date(2026, 9, 30, 10, 1).getTime());
    assert.equal(attempts.length, 1, '失败只投一次，不一分钟一次刷屏');
    assert.equal(attempts[0].alreadyRecorded, true, '投递那一刻状态里已经记下了这个人');
    assert.deepEqual(ll.snapshot().promiseWakes.users, [OWNER]);
    assert.match(logs.join('\n'), /到期唤醒投递失败/);
  }, {
    ltm: fakeLtm({ people: duePeople() }),
    logs,
    deliverPromiseWake: async () => {
      attempts.push({ alreadyRecorded: llRef.snapshot().promiseWakes.users.includes(OWNER) });
      throw new Error('投递被拒');
    },
  });
});

await test('到期唤醒：全局每天最多 5 人（按 QQ 号排序，先到先得）', async () => {
  const people = {};
  for (let i = 1; i <= 7; i++) {
    const uid = String(1000 + i);
    people[uid] = { name: `人${i}`, items: [pending('p1', '说好的事', { sourceKey: `private:${uid}` })] };
  }
  await withLifeLoop(async ({ ll, delivered }) => {
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    assert.equal(delivered.length, 5);
    assert.deepEqual(delivered.map((d) => d.key), ['1001', '1002', '1003', '1004', '1005'].map((u) => `private:${u}`));
    assert.deepEqual(ll.snapshot().promiseWakes.users, ['1001', '1002', '1003', '1004', '1005']);
  }, { ltm: fakeLtm({ people }) });
});

await test('到期唤醒：换一天重新算，同一个人第二天还能再提醒', async () => {
  const people = duePeople([pending('p1', '周末一起看电影', { due: '2026-10-30' }), pending('p2', '明天记得还书', { due: '2026-10-31' })]);
  await withLifeLoop(async ({ ll, delivered }) => {
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    await ll.tick(new Date(2026, 9, 31, 10, 0).getTime());
    assert.equal(delivered.length, 2);
    assert.match(delivered[0].text, /周末一起看电影/);
    assert.match(delivered[1].text, /明天记得还书/);
    assert.deepEqual(ll.snapshot().promiseWakes, { day: '2026-10-31', users: [OWNER] });
  }, { ltm: fakeLtm({ people }) });
});

await test('到期唤醒：promiseWake.enabled=false 时什么都不做', async () => {
  await withLifeLoop(async ({ ll, delivered }) => {
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    assert.equal(delivered.length, 0);
  }, { ltm: fakeLtm({ people: duePeople() }), options: { promiseWake: { enabled: false } } });
});

// ── 状态文件 / 健壮性 ────────────────────────────────────────────────────────

await test('状态文件坏了当空状态：不崩，下一次写入恢复成合法 JSON（原子写、600）', async () => {
  const logs = [];
  await withLifeLoop(async ({ ll, statePath }) => {
    // RAG_PATCH（P3）：snapshot 多了 associateToday（新字段），其余字段一个不改。
    assert.deepEqual(ll.snapshot(), { recallDay: '', recallToday: 0, recallPerDay: 2, diaryShownT: 0, promiseWakes: { day: '', users: [] }, history: [], associateToday: 0 });
    assert.equal(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }), '');
    assert.doesNotThrow(() => ll.tick(NOW));
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    const leftovers = fs.readdirSync(path.dirname(statePath)).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '不留临时文件');
  }, { state: '{ 这不是 json', logs, ltm: fakeLtm({ people: duePeople() }) });
  assert.ok(logs.length >= 0);
});

await test('状态文件里 promiseWakes / history 类型不对也能读成空值', async () => {
  await withLifeLoop(async ({ ll }) => {
    const snap = ll.snapshot();
    assert.deepEqual(snap.promiseWakes, { day: '', users: [] });
    assert.deepEqual(snap.history, []);
  }, { state: { promiseWakes: 'oops', history: 'nope', recall: [], recallToday: 'x' } });
});

await test('日志不写素材原文', async () => {
  const logs = [];
  const people = { [OWNER]: { name: '主人', items: [item({ id: 'x1', cat: 'fact', text: '海边捡到一只小螃蟹带回家了', at: iso(NOW - 3 * DAY) })] } };
  await withLifeLoop(async ({ ll }) => {
    const out = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(out, /小螃蟹/);
    assert.match(logs.join('\n'), /忽然想起：ltm · ltm:x1/, '只记来源和编号');
    assert.doesNotMatch(logs.join('\n'), /螃蟹/);
  }, { ltm: fakeLtm({ people }), logs, rngValues: [0] });
});

await test('history 只留最近 30 条', async () => {
  const history = Array.from({ length: 35 }, (_, i) => ({ at: NOW - i * 1000, kind: 'recall', source: 'ltm', candId: `ltm:h${i}`, preview: 'x' }));
  await withLifeLoop(async ({ ll, statePath }) => {
    await ll.tick(new Date(2026, 9, 30, 10, 0).getTime());
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(saved.history.length, 30);
    assert.equal(saved.history.at(-1).kind, 'promise-wake');
  }, { state: { version: 1, history }, ltm: fakeLtm({ people: duePeople() }) });
});

await test('start / stop 不抛异常', async () => {
  await withLifeLoop(async ({ ll }) => {
    assert.doesNotThrow(() => ll.start());
    assert.doesNotThrow(() => ll.stop());
    assert.doesNotThrow(() => ll.stop());
  }, { ltm: fakeLtm() });
});

// ── 遗忘曲线（DECAY_PATCH，子项目 2 · MEMORY_DECAY_SPEC §8）─────────────────
// 假的 decay 严格按「接口约定」造，不 import src/memory-decay.js（那是另一个 worker 的文件）。

function fakeDecay({ freezeBelow = 0.5, states = {}, reviewThrows = false } = {}) {
  const calls = { ltmMeta: [], msgMeta: [], diaryMeta: [], state: [], review: [] };
  const inst = {
    freezeBelow,
    ltmMeta(it, opts = {}) {
      calls.ltmMeta.push({ itemId: it?.id, ...opts });
      return { kind: 'ltm', createdAt: Date.parse(it?.at), cat: it?.cat, owner: String(opts.userId) === String(opts.ownerQQ), exempt: false, intimacy: opts.intimacy };
    },
    msgMeta(r, opts = {}) {
      calls.msgMeta.push({ msgId: r?.msgId, salience: opts.salience, intensity: opts.intensity, intimacy: opts.intimacy });
      return { kind: 'msg', createdAt: Date.parse(r?.t), salience: opts.salience, intensity: opts.intensity, intimacy: opts.intimacy };
    },
    diaryMeta(entry) {
      calls.diaryMeta.push({ t: entry?.t });
      return { kind: 'diary', createdAt: Number(entry?.t) };
    },
    // states：{ [id]: { R, frozen } | null | (() => 抛异常的那个) }，没有编号时默认 R=1 不冻结。
    state(id, meta) {
      calls.state.push({ id, meta });
      const s = typeof states === 'function' ? states(id, meta) : states[id];
      if (typeof s === 'function') return s();
      return s === undefined ? { R: 1, frozen: false } : s;
    },
    review(id, meta, rating) {
      calls.review.push({ id, meta, rating });
      if (reviewThrows) throw new Error('写盘失败');
      return { R: 1 };
    },
  };
  return { inst, calls };
}

/** 和 withLifeLoop 一样，只是多传 decay（不改上面已有的 helper）。 */
async function withDecayLoop(run, {
  ltm = fakeLtm(), persona = null, diary = [], options = {}, rngValues = [1], nowMs = NOW,
  state = null, ownerQQ = () => OWNER, logs = [], decay = null,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-loop-decay-'));
  const diaryDir = path.join(dir, 'diary');
  fs.mkdirSync(diaryDir, { recursive: true });
  if (diary.length) fs.writeFileSync(path.join(diaryDir, 'index.jsonl'), diary.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const statePath = path.join(dir, 'life-loop.json');
  if (state !== null) fs.writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state));
  let ri = 0;
  const rng = () => (ri < rngValues.length ? rngValues[ri++] : rngValues[rngValues.length - 1]);
  const ll = createLifeLoop({
    ltm, persona, diaryDir, statePath, ownerQQ, decay,
    deliverPromiseWake: async () => {},
    isAllowed: () => true,
    options: {
      recallPerDay: 2, cooldownDays: 7, quiet: [3, 8],
      ...options,
      promiseWake: { enabled: true, at: '10:00', maxPerDay: 5, ...(options.promiseWake ?? {}) },
    },
    now: () => nowMs,
    rng,
    log: (m) => logs.push(String(m)),
  });
  try { return await run({ ll, dir, diaryDir, statePath, logs }); }
  finally { ll.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** 包一层 fakeLtm，记下 archiveRows 收到的完整参数（看 limit 有没有显式传）。 */
function spyArchives(ltm) {
  const seen = [];
  return {
    seen,
    ltm: { ...ltm, archiveRows(key, opts = {}) { seen.push({ key, ...opts }); return ltm.archiveRows(key, opts); } },
  };
}

await test('遗忘曲线（无 decay）：已过时的主人条目 / 别人公开条目不进池，其余候选与现在一样', async () => {
  const people = {
    [OWNER]: {
      name: '主人',
      items: [
        item({ id: 'old1', cat: 'fact', text: '已经过时的旧情况', at: iso(NOW - 5 * DAY), outdatedAt: iso(NOW - DAY) }),
        item({ id: 'ok1', cat: 'fact', text: '还没过时的那条', at: iso(NOW - 5 * DAY) }),
      ],
    },
    '2002': {
      name: '小满',
      items: [
        { id: 'pubold', cat: 'fact', text: '公开但已经过时', at: iso(NOW - 5 * DAY), scope: 'public', sourceKey: 'group:9', outdatedAt: iso(NOW - DAY) },
        { id: 'pubok', cat: 'event', text: '公开的旧事', at: iso(NOW - 5 * DAY), scope: 'public', sourceKey: 'group:9' },
      ],
    },
  };
  await withDecayLoop(async ({ ll }) => {
    const pool = ll.candidates(NOW);
    assert.deepEqual(pool.map((c) => c.candId).sort(), ['ltm:ok1', 'ltm:pubok']);
    assert.ok(pool.every((c) => !('meta' in c) && !('R' in c)), '没有 decay 时候选不带遗忘字段');
    near(pool.find((c) => c.candId === 'ltm:pubok').salience, 0.56);
  }, { ltm: fakeLtm({ people }) });
});

await test('遗忘曲线：已淡忘（frozen）的账本 / 消息 / 日记都不进池；其余进池且带 meta / R', async () => {
  const people = {
    [OWNER]: {
      name: '主人',
      items: [
        item({ id: 'fz', cat: 'fact', text: '已经淡忘的事实', at: iso(NOW - 5 * DAY) }),
        item({ id: 'live', cat: 'fact', text: '还记得的事实', at: iso(NOW - 6 * DAY) }),
      ],
    },
  };
  const archives = {
    [OWNER_KEY]: [
      { t: iso(NOW - 10 * DAY), dir: 'in', userId: OWNER, name: '主人', text: '很久以前说过的一句挺长的话', msgId: 'mf' },
      { t: iso(NOW - 9 * DAY), dir: 'in', userId: OWNER, name: '主人', text: '另一句还记得的话其实也很长', msgId: 'ml' },
    ],
  };
  const diary = [diaryRow(NOW - 20 * DAY, { title: '旧', text: '很久以前写的一篇日记' })];
  const { inst } = fakeDecay({
    states: {
      'ltm:fz': { R: 0.2, frozen: true },
      'msg:mf': { R: 0.3, frozen: true },
      [`diary:${NOW - 20 * DAY}`]: { R: 0.1, frozen: true },
      'ltm:live': { R: 0.6, frozen: false },
      'msg:ml': { R: 0.4, frozen: false },
    },
  });
  await withDecayLoop(async ({ ll }) => {
    const pool = ll.candidates(NOW);
    assert.deepEqual(pool.map((c) => c.candId).sort(), ['ltm:live', 'msg:ml']);
    const by = Object.fromEntries(pool.map((c) => [c.candId, c]));
    near(by['ltm:live'].R, 0.6);
    assert.equal(by['ltm:live'].meta.kind, 'ltm');
    assert.equal(by['ltm:live'].meta.cat, 'fact');
    near(by['msg:ml'].R, 0.4);
    assert.equal(by['msg:ml'].meta.kind, 'msg');
    assert.equal(by['msg:ml'].meta.createdAt, Date.parse(iso(NOW - 9 * DAY)));
  }, { ltm: fakeLtm({ people, archives }), diary, decay: inst });
});

await test('遗忘曲线：ltmMeta 拿到正确的 ownerQQ / userId / intimacy，同一 uid 只问一次 relationOf', async () => {
  const people = {
    [OWNER]: {
      name: '主人',
      items: [
        item({ id: 'o1', cat: 'fact', text: '主人的一件事', at: iso(NOW - 5 * DAY) }),
        item({ id: 'o2', cat: 'note', text: '主人的另一件事', at: iso(NOW - 6 * DAY) }),
      ],
    },
    '2002': {
      name: '小满',
      items: [{ id: 'p1', cat: 'fact', text: '小满公开说过的事', at: iso(NOW - 5 * DAY), scope: 'public', sourceKey: 'group:9' }],
    },
  };
  const relCalls = [];
  const persona = {
    relationOf(uid) {
      relCalls.push(String(uid));
      return { intimacy: String(uid) === OWNER ? 72 : 30 };
    },
  };
  const { inst, calls } = fakeDecay({ states: () => ({ R: 0.6, frozen: false }) });
  await withDecayLoop(async ({ ll }) => {
    ll.candidates(NOW);
    const owner = calls.ltmMeta.filter((c) => c.itemId === 'o1' || c.itemId === 'o2');
    assert.equal(owner.length, 2);
    for (const c of owner) {
      assert.deepEqual({ ownerQQ: c.ownerQQ, userId: c.userId, intimacy: c.intimacy }, { ownerQQ: OWNER, userId: OWNER, intimacy: 72 });
    }
    const pub = calls.ltmMeta.find((c) => c.itemId === 'p1');
    assert.deepEqual({ ownerQQ: pub.ownerQQ, userId: pub.userId, intimacy: pub.intimacy }, { ownerQQ: OWNER, userId: '2002', intimacy: 30 });
    assert.deepEqual([...relCalls].sort(), [OWNER, '2002'], '一次 candidates 里同一个人只问一次');
  }, { ltm: fakeLtm({ people }), persona, decay: inst });
});

await test('遗忘曲线：R 越接近冻结线越容易被抽到（R=0.55 约为 R=0.95 的 9 倍）', async () => {
  const people = {
    [OWNER]: {
      name: '主人',
      items: [
        item({ id: 'fresh', cat: 'fact', text: '刚被想起过的那件事', at: iso(NOW - 5 * DAY) }),
        item({ id: 'fading', cat: 'fact', text: '快忘了的那件事', at: iso(NOW - 5 * DAY) }),
      ],
    },
  };
  const { inst } = fakeDecay({
    states: { 'ltm:fresh': { R: 0.95, frozen: false }, 'ltm:fading': { R: 0.55, frozen: false } },
  });
  let fresh = 0;
  let fading = 0;
  for (let i = 0; i < 100; i++) {
    const x = (i + 0.5) / 100; // 0.005 ~ 0.995 均匀 100 个点
    await withDecayLoop(async ({ ll }) => {
      const out = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 });
      if (/刚被想起过的那件事/.test(out)) fresh++;
      else if (/快忘了的那件事/.test(out)) fading++;
    }, { ltm: fakeLtm({ people }), persona: { relationOf: () => ({ intimacy: 72 }) }, decay: inst, rngValues: [0, x] });
  }
  assert.equal(fresh + fading, 100);
  assert.ok(fresh >= 1, `R≈1 也不是绝对抽不到：${fresh}`);
  assert.ok(fading >= 5 * fresh, `快忘了的应明显更容易被抽到：fresh ${fresh} / fading ${fading}`);

  // forgetting 下限 0.05：R=1 → 0.05；R=0.975 → (1−0.975)/(1−0.5) = 0.05，两者权重相同，分界正好 0.5。
  const same = {
    [OWNER]: {
      name: '主人',
      items: [
        item({ id: 's1', cat: 'fact', text: '牢固度满格的事', at: iso(NOW - 5 * DAY) }),
        item({ id: 's2', cat: 'fact', text: '牢固度九成七的事', at: iso(NOW - 5 * DAY) }),
      ],
    },
  };
  const floor = fakeDecay({ states: { 'ltm:s1': { R: 1, frozen: false }, 'ltm:s2': { R: 0.975, frozen: false } } });
  await withDecayLoop(async ({ ll }) => {
    assert.match(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }), /牢固度满格的事/);
  }, { ltm: fakeLtm({ people: same }), persona: { relationOf: () => ({ intimacy: 72 }) }, decay: floor.inst, rngValues: [0, 0.49] });
  await withDecayLoop(async ({ ll }) => {
    assert.match(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }), /牢固度九成七的事/);
  }, { ltm: fakeLtm({ people: same }), persona: { relationOf: () => ({ intimacy: 72 }) }, decay: floor.inst, rngValues: [0, 0.51] });
});

await test('遗忘曲线：消息窗口放宽到 365 天、limit 2000 且不再只取最后 200 条；无 decay 保持原样', async () => {
  const msg = (id, t) => ({ t: iso(t), dir: 'in', userId: OWNER, name: '主人', text: `第${id}条是很长很大的一段话`, msgId: id });
  const small = spyArchives(fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives: { [OWNER_KEY]: [msg('old200', NOW - 200 * DAY), msg('old400', NOW - 400 * DAY)] } }));
  const { inst } = fakeDecay({ states: () => ({ R: 0.6, frozen: false }) });
  await withDecayLoop(async ({ ll }) => {
    const ids = ll.candidates(NOW).filter((c) => c.source === 'msg').map((c) => c.candId);
    assert.deepEqual(ids, ['msg:old200'], '200 天前进池，400 天前不进');
    assert.ok(small.seen.length >= 2);
    assert.ok(small.seen.every((c) => c.limit === 2000), `两次 archiveRows 都要显式 limit: 2000：${JSON.stringify(small.seen.map((c) => c.limit))}`);
    assert.ok(small.seen.every((c) => c.sinceMs === NOW - 365 * DAY), '窗口从 365 天起');
  }, { ltm: small.ltm, decay: inst });

  // 无 decay：60 天窗口，200 天前的不进池，limit 不显式传（保持原来的调用形状）。
  const legacy = spyArchives(fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives: { [OWNER_KEY]: [msg('old200', NOW - 200 * DAY)] } }));
  await withDecayLoop(async ({ ll }) => {
    assert.deepEqual(ll.candidates(NOW).filter((c) => c.source === 'msg'), []);
    assert.ok(legacy.seen.every((c) => c.limit === undefined), '没有 decay 时不该改 archiveRows 的参数形状');
    assert.ok(legacy.seen.every((c) => c.sinceMs === NOW - 60 * DAY));
  }, { ltm: legacy.ltm });

  // 超过 200 条：有 decay 时全部被考虑，没有 decay 时仍然只取最后 200 条。
  const manyRows = Array.from({ length: 250 }, (_, i) => msg(`b${i}`, NOW - 10 * DAY + i * 1000));
  const many = spyArchives(fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives: { [OWNER_KEY]: manyRows } }));
  await withDecayLoop(async ({ ll }) => {
    const ids = ll.candidates(NOW).filter((c) => c.source === 'msg').map((c) => c.candId);
    assert.equal(ids.length, 250);
    assert.ok(ids.includes('msg:b0'), '最早那条也不再被 slice(-200) 砍掉');
  }, { ltm: many.ltm, decay: inst });
  const manyLegacy = spyArchives(fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives: { [OWNER_KEY]: manyRows } }));
  await withDecayLoop(async ({ ll }) => {
    const ids = ll.candidates(NOW).filter((c) => c.source === 'msg').map((c) => c.candId);
    assert.equal(ids.length, 200);
    assert.ok(!ids.includes('msg:b0'));
  }, { ltm: manyLegacy.ltm });
});

await test('遗忘曲线：appraisalByMsg 同时给 msgMeta 显著度与情绪强度；没有判读时用 0.3', async () => {
  const archives = {
    [OWNER_KEY]: [
      { t: iso(NOW - 5 * DAY), dir: 'in', userId: OWNER, name: '主人', text: '第一句判读过的而且很长的话', msgId: 'a1' },
      { t: iso(NOW - 5 * DAY + MIN), dir: 'in', userId: OWNER, name: '主人', text: '第二句判读说不显著的那句话', msgId: 'a2' },
      { t: iso(NOW - 5 * DAY + 2 * MIN), dir: 'in', userId: OWNER, name: '主人', text: '第三句没有判读过的很长的话', msgId: 'a3' },
    ],
  };
  const ltm = () => fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives });
  const { inst, calls } = fakeDecay({ states: () => ({ R: 0.6, frozen: false }) });
  const persona = {
    relationOf: () => ({ intimacy: 72 }),
    appraisalByMsg: () => new Map([['a1', { salience: 0.8, intensity: 0.6 }], ['a2', { salience: 0.1 }]]),
  };
  await withDecayLoop(async ({ ll }) => {
    const ids = ll.candidates(NOW).filter((c) => c.source === 'msg').map((c) => c.candId);
    assert.deepEqual(ids, ['msg:a1', 'msg:a3'], '0.1 的那句跳过');
    const a1 = calls.msgMeta.find((c) => c.msgId === 'a1');
    assert.deepEqual({ salience: a1.salience, intensity: a1.intensity, intimacy: a1.intimacy }, { salience: 0.8, intensity: 0.6, intimacy: 72 });
    const a3 = calls.msgMeta.find((c) => c.msgId === 'a3');
    assert.deepEqual({ salience: a3.salience, intensity: a3.intensity }, { salience: undefined, intensity: undefined }, '没有判读就不传值');
  }, { ltm: ltm(), persona, decay: inst });

  // 只有 salienceByMsg 的旧 persona 也照常工作（强度传 undefined）。
  const { inst: inst2, calls: calls2 } = fakeDecay({ states: () => ({ R: 0.6, frozen: false }) });
  const oldPersona = { relationOf: () => ({ intimacy: 72 }), salienceByMsg: () => new Map([['a1', 0.7], ['a2', 0.1]]) };
  await withDecayLoop(async ({ ll }) => {
    const ids = ll.candidates(NOW).filter((c) => c.source === 'msg').map((c) => c.candId);
    assert.deepEqual(ids, ['msg:a1', 'msg:a3']);
    const a1 = calls2.msgMeta.find((c) => c.msgId === 'a1');
    assert.deepEqual({ salience: a1.salience, intensity: a1.intensity }, { salience: 0.7, intensity: undefined });
  }, { ltm: ltm(), persona: oldPersona, decay: inst2 });
});

await test('遗忘曲线：抽中后 decay.review 记一次「顺利」；复习写失败也不影响文案', async () => {
  const people = { [OWNER]: { name: '主人', items: [item({ id: 'r1', cat: 'fact', text: '要被想起的那件事', at: iso(NOW - 5 * DAY) })] } };
  const { inst, calls } = fakeDecay({ states: { 'ltm:r1': { R: 0.6, frozen: false } } });
  await withDecayLoop(async ({ ll }) => {
    const out = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(out, /【忽然想起】.*要被想起的那件事/);
    assert.equal(calls.review.length, 1);
    assert.equal(calls.review[0].id, 'ltm:r1');
    assert.equal(calls.review[0].rating, 'good');
    assert.equal(calls.review[0].meta.kind, 'ltm');
    assert.equal(calls.review[0].meta.createdAt, Date.parse(iso(NOW - 5 * DAY)));
  }, { ltm: fakeLtm({ people }), decay: inst, rngValues: [0, 0] });

  const bad = fakeDecay({ states: { 'ltm:r1': { R: 0.6, frozen: false } }, reviewThrows: true });
  const logs = [];
  await withDecayLoop(async ({ ll }) => {
    const out = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(out, /【忽然想起】.*要被想起的那件事/);
    assert.match(logs.join('\n'), /复习记录失败/);
    assert.doesNotMatch(logs.join('\n'), /要被想起的那件事/, '日志不写素材原文');
  }, { ltm: fakeLtm({ people }), decay: bad.inst, rngValues: [0, 0], logs });
});

await test('遗忘曲线：decay.state 抛异常 / 返回 null 时按原来的时间衰减算权重，照样进池', async () => {
  const people = {
    [OWNER]: {
      name: '主人',
      items: [
        item({ id: 'boom', cat: 'fact', text: '状态算不出来的一条', at: iso(NOW - 4 * DAY) }),
        item({ id: 'none', cat: 'fact', text: '状态是空的一条', at: iso(NOW - 4 * DAY) }),
      ],
    },
  };
  const { inst } = fakeDecay({
    states: {
      'ltm:boom': () => { throw new Error('算不动'); },
      'ltm:none': null,
    },
  });
  await withDecayLoop(async ({ ll }) => {
    const pool = ll.candidates(NOW);
    assert.deepEqual(pool.map((c) => c.candId).sort(), ['ltm:boom', 'ltm:none']);
    assert.ok(pool.every((c) => c.R === null), '算不出 R 就退回时间衰减');
    assert.match(ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }), /【忽然想起】/);
  }, { ltm: fakeLtm({ people }), decay: inst, rngValues: [0, 0] });
});

await test('persona.appraisalByMsg：按 msgId 取显著度 / 情绪强度各自最大值，空 msgId 跳过，未初始化返回空 Map', async () => {
  const { createPersona } = await import('../src/persona.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-decay-'));
  let persona = null;
  try {
    persona = createPersona({
      stateDir: dir, roleName: () => '小鲸鱼', roleCard: () => '# 角色卡', sessions: () => ({}),
      ownerQQ: () => OWNER, fetchImpl: async () => { throw new Error('不该联网'); }, now: () => NOW, log: () => {},
    });
    assert.deepEqual([...persona.appraisalByMsg(OWNER_KEY).keys()], [], '未初始化时返回空 Map');
    persona.console.confirmFactory({ traits: { O: 70, C: 45, E: 35, A: 30, N: 55 }, beliefs: [] });
    const row = (o) => ({ at: NOW - 5 * DAY, userId: OWNER, target: 'me', kind: 'normal', label: '平静', source: 'model', ...o });
    const store = persona._store;
    store.appendAppraisal('小鲸鱼', OWNER_KEY, row({ msgId: 'm1', salience: 0.5, intensity: 0.2 }));
    store.appendAppraisal('小鲸鱼', OWNER_KEY, row({ msgId: 'm1', salience: 0.8, intensity: 0.4 }));
    store.appendAppraisal('小鲸鱼', OWNER_KEY, row({ msgId: 'm2', salience: 0.6, intensity: 0.3 }));
    store.appendAppraisal('小鲸鱼', OWNER_KEY, row({ msgId: 'm2', salience: 0.2, intensity: 0.9 }));
    store.appendAppraisal('小鲸鱼', OWNER_KEY, row({ msgId: '', salience: 0.9, intensity: 0.9 }));
    store.appendAppraisal('小鲸鱼', OWNER_KEY, row({ msgId: null, salience: 0.9, intensity: 0.9 }));
    store.appendAppraisal('小鲸鱼', OWNER_KEY, row({ msgId: 'm3', salience: 'x', intensity: 'y' }));
    const map = persona.appraisalByMsg(OWNER_KEY);
    assert.deepEqual(map.get('m1'), { salience: 0.8, intensity: 0.4 });
    assert.deepEqual(map.get('m2'), { salience: 0.6, intensity: 0.9 });
    assert.deepEqual(map.get('m3'), {}, '非数字的判读不写进 Map');
    assert.deepEqual([...map.keys()].sort(), ['m1', 'm2', 'm3'], '空 msgId 跳过');
    assert.equal(persona.appraisalByMsg(OWNER_KEY, { sinceMs: NOW }).size, 0, 'sinceMs 按条目的 at 过滤');
  } finally {
    persona?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 联想链（RAG_PATCH（P3），docs/design/ASSOCIATION_SPEC.md §10）──────────────
// 假的 associate 由桥接注入的真实形状：async (params) => { items } 或 null。
// 这里只验证生活回路这一侧：什么时候问、种子怎么传、怎么挑、记什么、失败怎么退。

/** 和 withLifeLoop 一样，多传 associate 与一个可拨动的时钟（clock.t，snapshot 的 now() 也用它）。 */
async function withAssocLoop(run, {
  ltm = fakeLtm(), persona = null, diary = [], options = {}, rngValues = [1], nowMs = NOW,
  state = null, ownerQQ = () => OWNER, logs = [], associate = null, decay = null, clock = null,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-loop-assoc-'));
  const diaryDir = path.join(dir, 'diary');
  fs.mkdirSync(diaryDir, { recursive: true });
  if (diary.length) fs.writeFileSync(path.join(diaryDir, 'index.jsonl'), diary.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const statePath = path.join(dir, 'life-loop.json');
  if (state !== null) fs.writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state));
  let ri = 0;
  const rng = () => (ri < rngValues.length ? rngValues[ri++] : rngValues[rngValues.length - 1]);
  const clockRef = clock && typeof clock === 'object' ? clock : { t: nowMs };
  const ll = createLifeLoop({
    ltm, persona, diaryDir, statePath, ownerQQ, decay, associate,
    deliverPromiseWake: async () => {},
    isAllowed: () => true,
    options: {
      recallPerDay: 2, cooldownDays: 7, quiet: [3, 8],
      ...options,
      promiseWake: { enabled: true, at: '10:00', maxPerDay: 5, ...(options.promiseWake ?? {}) },
    },
    now: () => clockRef.t,
    rng,
    log: (m) => logs.push(String(m)),
  });
  try { return await run({ ll, dir, diaryDir, statePath, logs, clock: clockRef }); }
  finally { ll.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** 假 associate：记下每次收到的参数；只给一个回复就一直用它，给多个则按顺序用。 */
function fakeAssociate(...responses) {
  const calls = [];
  const fn = async (params) => {
    calls.push(params);
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(params);
    return r;
  };
  return { fn, calls };
}

const ASSOC_FACTS = {
  [OWNER]: {
    name: '主人',
    items: [
      item({ id: 'a1', cat: 'fact', text: '他小时候养过一只金毛', at: iso(NOW - 3 * DAY) }),
      item({ id: 'a2', cat: 'fact', text: '他高中去爬过泰山', at: iso(NOW - 3 * DAY) }),
    ],
  },
};

const sumItem = (o = {}) => ({ summary_id: 'S1', summary: '那件旧事', score: 1, day: '2026-10-20', via: [], ...o });

await test('联想：没传 associate 时 composeOwnLifeAsync 与 composeOwnLife 逐字相同', async () => {
  let syncOut = '';
  let asyncOut = '';
  await withAssocLoop(async ({ ll }) => { syncOut = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0] });
  await withAssocLoop(async ({ ll }) => { asyncOut = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0] });
  assert.match(syncOut, /【忽然想起】/);
  assert.equal(asyncOut, syncOut);
});

await test('联想：抽中回忆 + 返回 2 条 → 追加【顺着想到】，记账不带摘要、日志不写原文', async () => {
  const logs = [];
  const assoc = fakeAssociate({
    items: [
      { summary_id: 'S1', summary: '海边捡到的小螃蟹被带回家了', score: 3, day: '2026-10-20', via: ['小夏', '夜班'] },
      { summary_id: 'S2', summary: '另一件不相干的旧事', score: 1, day: '2026-10-18', via: ['小夏'] },
    ],
  });
  await withAssocLoop(async ({ ll, statePath }) => {
    const out = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(out, /【忽然想起】/);
    assert.match(out, /【忽然想起】[\s\S]*\n\n【顺着想到】/);
    assert.ok(out.endsWith(
      '【顺着想到】说起这个，又想到 10-20：海边捡到的小螃蟹被带回家了（都和「小夏」「夜班」有关）\n'
      + '是自己顺着想到的，不一定要提；想提就自然带一句。'
    ), out);

    const raw = fs.readFileSync(statePath, 'utf8');
    const saved = JSON.parse(raw);
    assert.deepEqual(saved.recall['sum:S1'], { lastAt: NOW, count: 1 });
    const last = saved.history.at(-1);
    assert.deepEqual(
      { kind: last.kind, candId: last.candId, from: last.from },
      { kind: 'associate', candId: 'sum:S1', from: 'ltm:a1' }
    );
    assert.ok(!('preview' in last), '联想条目不存预览');
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.ok(!raw.includes('小螃蟹'), '状态文件里不存摘要原文');
    assert.doesNotMatch(logs.join('\n'), /小螃蟹|小夏|夜班/, '日志不写摘要与 via');
    assert.match(logs.join('\n'), /顺着想到：sum:S1 ← ltm:a1/);
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0, 0.1], associate: assoc.fn, logs });
  assert.equal(assoc.calls.length, 1);
  assert.deepEqual(assoc.calls[0].exclude, []);
  assert.deepEqual(assoc.calls[0].people, []);
  assert.equal(assoc.calls[0].minAgeDays, 2);
  assert.equal(assoc.calls[0].k, 3);
});

await test('联想：这次没抽中回忆 → associate 一次都不调，返回值等于 composeOwnLife', async () => {
  // ① 当天额度已用完
  const a1 = fakeAssociate({ items: [sumItem()] });
  let syncA = '';
  let asyncA = '';
  await withAssocLoop(async ({ ll }) => { syncA = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0], associate: a1.fn, options: { recallPerDay: 0 } });
  await withAssocLoop(async ({ ll }) => { asyncA = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0], associate: a1.fn, options: { recallPerDay: 0 } });
  assert.equal(asyncA, syncA);
  assert.equal(asyncA, '');
  assert.equal(a1.calls.length, 0);

  // ② rng 让它不抽（quota 2 / slots 4 = 0.5，rng 0.9）
  const a2 = fakeAssociate({ items: [sumItem()] });
  let syncB = '';
  let asyncB = '';
  await withAssocLoop(async ({ ll }) => { syncB = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 4 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0.9], associate: a2.fn });
  await withAssocLoop(async ({ ll }) => { asyncB = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 4 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0.9], associate: a2.fn });
  assert.equal(asyncB, syncB);
  assert.equal(asyncB, '');
  assert.equal(a2.calls.length, 0);
});

await test('联想：抛错 / null / 空列表 / 形状不对 / 超时 → 返回 base，且不超过 1 秒', async () => {
  let base = '';
  await withAssocLoop(async ({ ll }) => { base = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0] });
  assert.match(base, /【忽然想起】/);

  const cases = [
    { name: '抛错', assoc: fakeAssociate(new Error('坏了')) },
    { name: '返回 null', assoc: fakeAssociate(null) },
    { name: '空列表', assoc: fakeAssociate({ items: [] }) },
    { name: 'items 不是数组', assoc: fakeAssociate({ items: 'x' }) },
    { name: '一直不 resolve', assoc: fakeAssociate(() => new Promise(() => {})), options: { associate: { timeoutMs: 50 } } },
  ];
  for (const c of cases) {
    const started = Date.now();
    let out = null;
    await withAssocLoop(async ({ ll }) => {
      out = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
    }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0], associate: c.assoc.fn, options: c.options ?? {} });
    const ms = Date.now() - started;
    assert.equal(out, base, `${c.name}：联想失败时【忽然想起】照常、不加【顺着想到】`);
    assert.doesNotMatch(out, /顺着想到/, c.name);
    assert.ok(ms < 1000, `${c.name}：不超过 1 秒（${ms} ms）`);
  }
});

await test('联想：种子按来源传参（msg 带消息时间、pub 传那个人、ltm 传空 people）', async () => {
  // msg：只有主人私聊里的一句话
  const archives = {
    [OWNER_KEY]: [
      { t: iso(NOW - 5 * DAY), dir: 'in', userId: OWNER, name: '主人', text: '今天下班路上看到一只很胖的橘猫，蹲在便利店门口', msgId: 'm1' },
    ],
  };
  const msgAssoc = fakeAssociate({ items: [sumItem()] });
  await withAssocLoop(async ({ ll }) => {
    await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
  }, { ltm: fakeLtm({ people: { [OWNER]: { name: '主人', items: [] } }, archives }), rngValues: [0], associate: msgAssoc.fn });
  assert.equal(msgAssoc.calls.length, 1);
  assert.equal(msgAssoc.calls[0].t, Date.parse(iso(NOW - 5 * DAY)), 'msg 种子带消息时间');
  assert.deepEqual(msgAssoc.calls[0].people, []);
  assert.match(msgAssoc.calls[0].text, /橘猫/);

  // pub：别人的公开条目 → people = [那个人]
  const pubPeople = {
    [OWNER]: { name: '主人', items: [] },
    '2002': { name: '小满', items: [{ id: 'pub1', cat: 'fact', text: '养了一只猫', at: iso(NOW - 3 * DAY), scope: 'public', sourceKey: 'group:9' }] },
  };
  const pubAssoc = fakeAssociate({ items: [sumItem({ summary_id: 'S2' })] });
  await withAssocLoop(async ({ ll }) => {
    await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
  }, { ltm: fakeLtm({ people: pubPeople }), rngValues: [0], associate: pubAssoc.fn });
  assert.deepEqual(pubAssoc.calls[0].people, ['2002']);
  assert.equal(pubAssoc.calls[0].t, undefined, 'pub 不带时间');
  assert.match(pubAssoc.calls[0].text, /养了一只猫/);

  // ltm：主人自己的账本条目 → people 空数组
  const ltmPeople = {
    [OWNER]: { name: '主人', items: [item({ id: 'a1', cat: 'fact', text: '他小时候养过一只金毛', at: iso(NOW - 3 * DAY) })] },
  };
  const ltmAssoc = fakeAssociate({ items: [sumItem({ summary_id: 'S3' })] });
  await withAssocLoop(async ({ ll }) => {
    await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
  }, { ltm: fakeLtm({ people: ltmPeople }), rngValues: [0], associate: ltmAssoc.fn });
  assert.deepEqual(ltmAssoc.calls[0].people, []);
  assert.equal(ltmAssoc.calls[0].t, undefined, 'ltm 不带时间');
  assert.match(ltmAssoc.calls[0].text, /金毛/);
});

await test('联想：冷却 7 天（exclude 带上次带出的 sum: 编号，过了 7 天不再带）', async () => {
  const assoc = fakeAssociate({ items: [{ summary_id: 'A', summary: '同一件旧事', score: 1, day: '2026-10-20', via: [] }] });
  const clock = { t: NOW };
  await withAssocLoop(async ({ ll }) => {
    await ll.composeOwnLifeAsync({ kind: 'day', now: clock.t, remainingSlots: 1 });
    clock.t = NOW; // 同一天再来一次
    await ll.composeOwnLifeAsync({ kind: 'day', now: clock.t, remainingSlots: 1 });
    clock.t = NOW + 8 * DAY;
    await ll.composeOwnLifeAsync({ kind: 'day', now: clock.t, remainingSlots: 1 });
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0], associate: assoc.fn, clock });
  assert.equal(assoc.calls.length, 3, '三次都抽中了回忆');
  assert.deepEqual(assoc.calls[0].exclude, []);
  assert.deepEqual(assoc.calls[1].exclude, ['A']);
  assert.deepEqual(assoc.calls[2].exclude, [], '过了 7 天不再排除');
});

await test('联想：options.associate.enabled=false 时一次都不调', async () => {
  const assoc = fakeAssociate({ items: [sumItem()] });
  let base = '';
  await withAssocLoop(async ({ ll }) => { base = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0] });
  let out = '';
  await withAssocLoop(async ({ ll }) => { out = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0], associate: assoc.fn, options: { associate: { enabled: false } } });
  assert.equal(assoc.calls.length, 0);
  assert.equal(out, base);
});

await test('联想：不合格的候选被过滤；全不合格时返回 base 并记「没有可联想的」', async () => {
  const messy = fakeAssociate({
    items: [
      { summary: '没有编号的', score: 1, day: '2026-10-20' },
      { summary_id: 'S2', summary: '', score: 1, day: '2026-10-20' },
      { summary_id: 'S3', summary: '零分的', score: 0, day: '2026-10-20' },
      { summary_id: 'S4', summary: '日期不对的', score: 1, day: '20261020' },
      { summary_id: 'S5', summary: '合格的这条', score: 1, day: '2026-10-20', via: '不是数组' },
      { summary_id: 'S6', summary: '另一条合格的', score: 1, day: '2026-10-21', via: ['A', 123, 'B', 'C'] },
    ],
  });
  await withAssocLoop(async ({ ll, statePath }) => {
    const out = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(out, /合格的这条/);
    assert.doesNotMatch(out, /零分|日期不对|没有编号|另一条合格的/);
    assert.doesNotMatch(out, /（都和/, 'via 不是数组就当没有，整段括号省略');
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(saved.history.at(-1).candId, 'sum:S5');
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0, 0], associate: messy.fn });

  // via 只取前 2 个、只留字符串
  const viaCase = fakeAssociate({ items: [sumItem({ summary_id: 'S9', summary: '靠 via 认出来的', via: ['A', 123, 'B', 'C'] })] });
  await withAssocLoop(async ({ ll }) => {
    const out = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(out, /（都和「A」「B」有关）/, out);
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0, 0], associate: viaCase.fn });

  // 全不合格
  const allBad = fakeAssociate({
    items: [
      { summary_id: '', summary: 'x', score: 1, day: '2026-10-20' },
      { summary_id: 'S1', summary: 'y', score: -1, day: '2026-10-20' },
    ],
  });
  const logs = [];
  let base = '';
  await withAssocLoop(async ({ ll }) => { base = ll.composeOwnLife({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0] });
  let out = '';
  await withAssocLoop(async ({ ll }) => { out = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 }); },
    { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0], associate: allBad.fn, logs });
  assert.equal(out, base);
  assert.doesNotMatch(out, /顺着想到/);
  assert.match(logs.join('\n'), /没有可联想的/);
});

await test('联想：按得分加权随机（3 : 1，rng 0.1 选第一条、0.9 选第二条）', async () => {
  const mk = () => fakeAssociate({
    items: [
      { summary_id: 'S1', summary: '得分高的那件事', score: 3, day: '2026-10-20', via: [] },
      { summary_id: 'S2', summary: '得分低的那件事', score: 1, day: '2026-10-20', via: [] },
    ],
  });
  const first = mk();
  await withAssocLoop(async ({ ll }) => {
    assert.match(await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 }), /得分高的那件事/);
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0, 0.1], associate: first.fn });
  const second = mk();
  await withAssocLoop(async ({ ll }) => {
    assert.match(await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 }), /得分低的那件事/);
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0, 0.9], associate: second.fn });
});

await test('联想：snapshot().associateToday 按活动日计数，跨活动日归零', async () => {
  const clock = { t: NOW };
  const assoc = fakeAssociate({ items: [sumItem()] });
  await withAssocLoop(async ({ ll }) => {
    assert.equal(ll.snapshot().associateToday, 0);
    await ll.composeOwnLifeAsync({ kind: 'day', now: clock.t, remainingSlots: 1 });
    assert.equal(ll.snapshot().associateToday, 1);
    await ll.composeOwnLifeAsync({ kind: 'day', now: clock.t, remainingSlots: 1 });
    assert.equal(ll.snapshot().associateToday, 2);
    clock.t = NOW + 8 * DAY;
    assert.equal(ll.snapshot().associateToday, 0, '换了活动日归零');
    await ll.composeOwnLifeAsync({ kind: 'day', now: clock.t, remainingSlots: 1 });
    assert.equal(ll.snapshot().associateToday, 1);
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0], associate: assoc.fn, clock });
});

await test('联想：不占每天回忆额度、不计复习（decay.review 只为【忽然想起】那条记一次）', async () => {
  const { inst, calls } = fakeDecay({ states: () => ({ R: 0.6, frozen: false }) });
  const assoc = fakeAssociate({ items: [sumItem({ summary_id: 'S1', summary: '另一件旧事' })] });
  await withAssocLoop(async ({ ll }) => {
    const out = await ll.composeOwnLifeAsync({ kind: 'day', now: NOW, remainingSlots: 1 });
    assert.match(out, /【顺着想到】/);
    assert.equal(ll.snapshot().recallToday, 1, '联想不占每天 2 次的额度');
    assert.equal(calls.review.length, 1, '只给【忽然想起】那条记了一次');
    assert.equal(calls.review[0].id, 'ltm:a1');
    assert.ok(!calls.review.some((r) => String(r.id).startsWith('sum:')), '联想出来的摘要不算复习');
  }, { ltm: fakeLtm({ people: ASSOC_FACTS }), rngValues: [0, 0, 0], associate: assoc.fn, decay: inst });
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
