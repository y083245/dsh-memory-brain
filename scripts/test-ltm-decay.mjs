// src/long-memory.js 的「记忆代谢」单测（子项目 2 · 规格 M1 / M2-a / M4 / M5，任务 D2）。
//
// 覆盖：已过时（replaces / outdated / renderFor / duePromises / coreCount）、
// 相似提示 similarItems、按关键词查条目 matchItems、注入按牢固度排（decayOf）、
// 按行取回存档 rowsAt，以及「没传 decayOf 时 renderFor 输出与改动前逐字相同」。
//
// 全部用临时目录 + 固定时间生成的数据，不碰 state/ 里的真实账本与存档。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLongMemory, CORE_MAX } from '../src/long-memory.js';

let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

/** 建一个临时 stateDir，跑完删掉。opts 原样传给 createLongMemory。 */
async function withMemory(run, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-decay-'));
  const logs = [];
  const lm = createLongMemory({ stateDir: dir, log: (m) => logs.push(String(m)), ...opts });
  try { await run(lm, dir, logs); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const OWNER = '100000001';
const KEY = `private:${OWNER}`;
const OTHER_KEY = 'group:123456';

// ── §2 已过时：replaces ─────────────────────────────────────────────────────
await test('replaces：旧条目标过时、renderFor 只剩新的、personView 两条都在', async () => {
  await withMemory(async (lm) => {
    const { item: oldItem } = lm.remember({ userId: OWNER, name: '主人', cat: 'fact', text: '住在杭州', sourceKey: KEY });
    const oldAt = oldItem.at;
    const res = lm.remember({ userId: OWNER, name: '主人', cat: 'fact', text: '搬到上海了', sourceKey: KEY, replaces: oldItem.id });

    assert.equal(res.duplicate, false);
    assert.equal(res.replaced, oldItem, '返回的 replaced 就是被标过时的旧条目');
    assert.equal(oldItem.outdatedBy, res.item.id);
    assert.ok(oldItem.outdatedAt, '旧条目要有 outdatedAt');
    assert.equal(oldItem.at, oldAt, '旧条目的 at 不动');

    const text = lm.renderFor([OWNER], KEY, { today: '2026-10-30' });
    assert.ok(text.includes('搬到上海了'), '新的要注入');
    assert.ok(!text.includes('住在杭州'), '已过时的不能注入');

    const v = lm.personView(OWNER, KEY);
    assert.equal(v.items.length, 2, 'personView / 控制台照常返回两条');
    assert.ok(v.items.some((x) => x.text === '住在杭州' && x.outdatedAt));
  });
});

await test('replaces：找不到 / 已过时 / 不可见都抛错，账本一个字都不变', async () => {
  await withMemory(async (lm) => {
    const { item: oldItem } = lm.remember({ userId: OWNER, cat: 'fact', text: '住在杭州', sourceKey: KEY });

    const before1 = JSON.stringify(lm.personView(OWNER, KEY));
    assert.throws(
      () => lm.remember({ userId: OWNER, cat: 'fact', text: '搬到上海了', sourceKey: KEY, replaces: 'deadbeef' }),
      /找不到要替换的旧条目：deadbeef（先用 qq_ltm_recall 查编号；已过时的不能再替换）/
    );
    assert.equal(JSON.stringify(lm.personView(OWNER, KEY)), before1, '找不到时不能留下新条目');

    lm.update({ userId: OWNER, itemId: oldItem.id, viewerKey: KEY, outdated: true });
    const before2 = JSON.stringify(lm.personView(OWNER, KEY));
    assert.throws(
      () => lm.remember({ userId: OWNER, cat: 'fact', text: '搬去南京了', sourceKey: KEY, replaces: oldItem.id }),
      /找不到要替换的旧条目/
    );
    assert.equal(JSON.stringify(lm.personView(OWNER, KEY)), before2, '已过时的不能再替换');

    lm.update({ userId: OWNER, itemId: oldItem.id, viewerKey: KEY, outdated: false });
    const before3 = JSON.stringify(lm.personView(OWNER, KEY));
    assert.throws(
      () => lm.remember({ userId: OWNER, cat: 'fact', text: '搬到上海了', sourceKey: OTHER_KEY, replaces: oldItem.id }),
      /找不到要替换的旧条目/,
      '私聊记的条目在别的会话里不可见'
    );
    assert.equal(JSON.stringify(lm.personView(OWNER, KEY)), before3, '不可见时不能留下新条目');
  });
});

await test('replaces：指向内容完全相同的条目 → 抛「新内容和旧条目一样」', async () => {
  await withMemory(async (lm) => {
    const { item: oldItem } = lm.remember({ userId: OWNER, cat: 'fact', text: '住在杭州', sourceKey: KEY });
    const before = JSON.stringify(lm.personView(OWNER, KEY));
    assert.throws(
      () => lm.remember({ userId: OWNER, cat: 'fact', text: '住在杭州', sourceKey: KEY, replaces: oldItem.id }),
      /新内容和旧条目一样，不用替换/
    );
    assert.equal(JSON.stringify(lm.personView(OWNER, KEY)), before);
  });
});

await test('replaces：核心继承（核心 8 条满时替换成功，核心总数仍 8）', async () => {
  await withMemory(async (lm) => {
    const cores = [];
    for (let i = 0; i < CORE_MAX; i += 1) {
      cores.push(lm.remember({ userId: OWNER, cat: 'fact', text: `核心事实${i}`, sourceKey: KEY, core: true }).item);
    }
    const res = lm.remember({ userId: OWNER, cat: 'fact', text: '新的核心事实', sourceKey: KEY, replaces: cores[0].id });
    assert.equal(res.item.core, true, '新条目继承核心');
    assert.equal(cores[0].core, undefined, '旧条目不再核心');
    const v = lm.personView(OWNER, KEY);
    assert.equal(v.items.filter((x) => x.core && !x.outdatedAt && !x.archivedAt).length, CORE_MAX, '核心总数仍是 8');
    assert.ok(cores[0].outdatedAt);
  });
});

await test('replaces：重复内容命中已过时的条目 → 该条恢复（不是替换）', async () => {
  await withMemory(async (lm) => {
    const { item } = lm.remember({ userId: OWNER, cat: 'fact', text: '住在杭州', sourceKey: KEY });
    lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, outdated: true });
    assert.ok(item.outdatedAt);

    const res = lm.remember({ userId: OWNER, cat: 'fact', text: '住在杭州', sourceKey: KEY });
    assert.equal(res.duplicate, true);
    assert.equal(res.item, item);
    assert.equal(res.replaced, null);
    assert.ok(!('outdatedAt' in item));
    assert.ok(!('outdatedBy' in item));
  });
});

// ── §2 已过时：update ──────────────────────────────────────────────────────
await test('update：outdated 的标 / 取消 / 校验 / 与 core 的冲突', async () => {
  await withMemory(async (lm) => {
    const { item } = lm.remember({ userId: OWNER, cat: 'fact', text: '喜欢下雨天', sourceKey: KEY });
    const at0 = item.at;

    lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, outdated: true });
    assert.ok(item.outdatedAt);
    assert.ok(!('outdatedBy' in item), '手动标过时没有 outdatedBy');
    assert.equal(item.at, at0, '改 outdated 不刷新 at');

    lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, outdated: false });
    assert.ok(!('outdatedAt' in item));
    assert.ok(!('outdatedBy' in item));

    const before = JSON.stringify(lm.personView(OWNER, KEY));
    assert.throws(() => lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, outdated: 'yes' }), /outdated 只能是 true 或 false/);
    assert.equal(JSON.stringify(lm.personView(OWNER, KEY)), before);

    lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, core: true });
    assert.throws(() => lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, outdated: true }), /核心条目不能标过时，先取消核心/);
    assert.ok(!item.outdatedAt, '抛错时不能半截改掉');

    // 同一次调用里核心与过时一起传
    lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, core: false, outdated: true });
    assert.ok(!item.core);
    assert.ok(item.outdatedAt);
    assert.equal(item.at, at0);

    // 过时的条目想直接设为核心 → 抛错；同一次传 outdated: false 则可以
    assert.throws(() => lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, core: true }), /已过时的条目先取消过时再设为核心/);
    lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, core: true, outdated: false });
    assert.equal(item.core, true);
    assert.ok(!('outdatedAt' in item));
    assert.equal(item.at, at0);
  });
});

// ── §2 已过时：duePromises / coreCount ─────────────────────────────────────
await test('已过时的约定不进 duePromises', async () => {
  await withMemory(async (lm) => {
    const { item } = lm.remember({ userId: OWNER, cat: 'pending', text: '周末一起看电影', sourceKey: KEY, due: '2026-11-01' });
    assert.equal(lm.duePromises('2026-11-01').length, 1);
    lm.update({ userId: OWNER, itemId: item.id, viewerKey: KEY, outdated: true });
    assert.deepEqual(lm.duePromises('2026-11-01'), []);
  });
});

await test('coreCount 不数已过时的条目', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-decay-'));
  try {
    // 接口造不出「已过时的核心」，直接写 people.json
    const at = '2026-09-01T04:00:00.000Z';
    const items = [{ id: 'aaaa0001', cat: 'fact', text: '已过时的核心', at, sourceKey: KEY, scope: 'private', core: true, outdatedAt: '2026-09-02T04:00:00.000Z' }];
    for (let i = 0; i < CORE_MAX - 1; i += 1) {
      items.push({ id: `core${String(i).padStart(4, '0')}`, cat: 'fact', text: `核心${i}`, at, sourceKey: KEY, scope: 'private', core: true });
    }
    items.push({ id: 'plain001', cat: 'fact', text: '普通条目', at, sourceKey: KEY, scope: 'private' });
    fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify({
      version: 1,
      people: { [OWNER]: { name: '主人', names: [], items, firstSeenAt: at, lastSeenAt: at, messages: 1 } }
    }));
    const lm = createLongMemory({ stateDir: dir });
    // 7 条有效核心 + 1 条已过时的核心：再设一条核心应当成功（已过时的不占名额）
    lm.update({ userId: OWNER, itemId: 'plain001', viewerKey: KEY, core: true });
    const v = lm.personView(OWNER, KEY);
    assert.equal(v.items.filter((x) => x.core && !x.outdatedAt).length, CORE_MAX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── §3 相似提示 ────────────────────────────────────────────────────────────
await test('similarItems：相似度阈值、排除过时 / 归档 / excludeIds / 不可见、cat 与 limit', async () => {
  await withMemory(async (lm) => {
    const f1 = lm.remember({ userId: OWNER, cat: 'fact', text: '他养了一只橘猫叫团子', sourceKey: KEY }).item;
    const f2 = lm.remember({ userId: OWNER, cat: 'fact', text: '她养的那只橘猫叫团子', sourceKey: KEY }).item;
    const t1 = lm.remember({ userId: OWNER, cat: 'trait', text: '她养的那只橘猫叫团子呀', sourceKey: KEY }).item;
    const q = '她养的那只橘猫叫团子';

    // 规格 §3 给的例子按「中文 2 字切片」的 Jaccard 只有 3/13 ≈ 0.231 < 0.35，达不到阈值
    // （报告里已说明这一处规格与测试要求的出入，这里断言算法的真实行为）。
    assert.deepEqual(lm.similarItems(OWNER, '团子是他养的橘猫', { viewerKey: KEY }), []);

    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY }).map((x) => x.id), [f2.id, t1.id], '默认 limit 是 2');
    const all = lm.similarItems(OWNER, q, { viewerKey: KEY, limit: 5 });
    assert.deepEqual(all.map((x) => x.id), [f2.id, t1.id, f1.id], '按相似度降序');
    assert.deepEqual(all.map((x) => x.score), [1, 0.9, 0.385]);
    assert.ok(all.every((x) => x.score >= 0.35));

    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY, limit: 1 }).map((x) => x.id), [f2.id]);
    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY, limit: 5 }).map((x) => x.id), [f2.id, t1.id, f1.id]);
    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY, limit: 99 }).map((x) => x.id), [f2.id, t1.id, f1.id], 'limit 夹到 5');
    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY, cat: 'fact' }).map((x) => x.id), [f2.id, f1.id]);
    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY, excludeIds: [f2.id] }).map((x) => x.id), [t1.id, f1.id]);
    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: OTHER_KEY }), [], '私聊条目在别的会话不可见');

    lm.update({ userId: OWNER, itemId: f2.id, viewerKey: KEY, outdated: true });
    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY }).map((x) => x.id), [t1.id, f1.id], '已过时的不提示');
    lm.update({ userId: OWNER, itemId: f1.id, viewerKey: KEY, archived: true });
    assert.deepEqual(lm.similarItems(OWNER, q, { viewerKey: KEY }).map((x) => x.id), [t1.id], '已归档的不提示');

    assert.deepEqual(lm.similarItems(OWNER, '今天下雨了', { viewerKey: KEY }), [], '不相似的返回空');
    assert.deepEqual(lm.similarItems(OWNER, '   ', { viewerKey: KEY }), [], '空文本返回空');
    assert.deepEqual(lm.similarItems('10001', q, { viewerKey: KEY }), [], '没有记录的人返回空');
  });
});

// ── §4 按关键词查条目 ──────────────────────────────────────────────────────
await test('matchItems：切词命中、单个汉字可查、虚词不查、过时 / 归档也返回、按会话可见', async () => {
  await withMemory(async (lm) => {
    const a = lm.remember({ userId: OWNER, cat: 'fact', text: '团子的生日是三月五号', sourceKey: KEY }).item;
    const b = lm.remember({ userId: OWNER, cat: 'fact', text: '今天下雨了', sourceKey: KEY }).item;
    const c = lm.remember({ userId: OWNER, cat: 'note', text: '团子的猫粮快吃完了', sourceKey: KEY }).item;
    lm.update({ userId: OWNER, itemId: b.id, viewerKey: KEY, outdated: true });
    lm.update({ userId: OWNER, itemId: c.id, viewerKey: KEY, archived: true });

    assert.deepEqual(lm.matchItems(OWNER, KEY, '生日').map((x) => x.id), [a.id]);
    assert.deepEqual(lm.matchItems(OWNER, KEY, '团子').map((x) => x.id), [a.id, c.id], '已过时 / 已归档的也返回');
    assert.deepEqual(lm.matchItems(OWNER, KEY, '团子 生日').map((x) => x.id), [a.id, c.id]);
    assert.deepEqual(lm.matchItems(OWNER, KEY, '下雨').map((x) => x.id), [b.id]);
    assert.ok(lm.matchItems(OWNER, KEY, '下雨')[0].outdatedAt, '过时标记要原样带出');
    assert.ok(lm.matchItems(OWNER, KEY, '猫粮')[0].archivedAt, '归档标记要原样带出');

    assert.deepEqual(lm.matchItems(OWNER, KEY, '猫').map((x) => x.id), [c.id], '单个汉字可查');
    assert.deepEqual(lm.matchItems(OWNER, KEY, '的'), [], '虚词不查');
    assert.deepEqual(lm.matchItems(OWNER, KEY, '我 的'), [], '全是虚词时返回空');
    assert.deepEqual(lm.matchItems(OWNER, KEY, 'a'), [], '单个英文字母不查');
    assert.deepEqual(lm.matchItems(OWNER, KEY, '猫 的').map((x) => x.id), lm.matchItems(OWNER, KEY, '猫').map((x) => x.id), '虚词被丢掉后等同单字查询');
    assert.deepEqual(lm.matchItems(OWNER, KEY, '，。！'), [], '没有可用的词');
    assert.deepEqual(lm.matchItems(OWNER, OTHER_KEY, '团子'), [], '私聊条目在别的会话不可见');
    assert.deepEqual(lm.matchItems('10001', KEY, '团子'), [], '没有记录的人返回空');
    assert.deepEqual(lm.matchItems(OWNER, KEY, ''), []);
  });
});

// ── §5 renderFor：没传 decayOf 时与改动前逐字相同 ─────────────────────────
// 期望字符串由 /tmp/decay-work/snap/orig/src/long-memory.js（改动前快照）对同一份 people.json
// 生成，比较脚本 /tmp/worker-D2/compare-render.mjs 输出「相同： true」。改动 renderFor 时要重跑。
const RENDER_FIX_ISO = (n) => new Date(2026, 8, 1, 12, 0, 0, n).toISOString();
const RENDER_EXPECTED = [
  '· 主人（QQ 100000001）',
  '  核心：核心性格：喜欢冷清〔id0001〕；核心事实：主人的生日〔id0002〕',
  '  约定/没聊完：【已过期10天，兑现了吗？】约定B已过期〔id0003〕；【今天到期】约定A今天到期〔id0004〕；约定C没有日子〔id0005〕',
  '  性格/喜好：性格条目5〔id0014〕；性格条目6〔id0015〕；性格条目7〔id0016〕；性格条目8〔id0017〕；性格条目9〔id0018〕；性格条目10〔id0019〕；性格条目11〔id0020〕；性格条目12〔id0021〕；性格条目13〔id0022〕；性格条目14〔id0023〕；性格条目15〔id0024〕；性格条目16〔id0025〕；性格条目17〔id0026〕；性格条目18〔id0027〕；性格条目19〔id0028〕（另有 5 条，用 qq_ltm_recall 查看）',
  '  他说过的事：事实条目6〔id0035〕；事实条目7〔id0036〕；事实条目8〔id0037〕；事实条目9〔id0038〕；事实条目10〔id0039〕；事实条目11〔id0040〕；事实条目12〔id0041〕；事实条目13〔id0042〕；事实条目14〔id0043〕；事实条目15〔id0044〕；事实条目16〔id0045〕；事实条目17〔id0046〕；事实条目18〔id0047〕；事实条目19〔id0048〕；公开的事实〔id0049〕（另有 6 条，用 qq_ltm_recall 查看）',
  '  最近的要紧事：2026-09-01 经历条目2〔id0052〕；2026-09-01 经历条目3〔id0053〕；2026-09-01 经历条目4〔id0054〕；2026-09-01 经历条目5〔id0055〕；2026-09-01 经历条目6〔id0056〕；2026-09-01 经历条目7〔id0057〕（另有 2 条，用 qq_ltm_recall 查看）',
  '  其它：备注条目2〔id0060〕；备注条目3〔id0061〕；备注条目4〔id0062〕；备注条目5〔id0063〕；备注条目6〔id0064〕（另有 2 条，用 qq_ltm_recall 查看）'
].join('\n');

await test('renderFor：没传 decayOf 时输出与改动前逐字相同（已过时的条目不在数据里）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-decay-'));
  try {
    // 与 /tmp/worker-D2/compare-render.mjs 完全相同的夹具：各类别都超过 n 条，
    // 另含核心、过期 / 今天到期 / 无到期 / 已结束的约定、一条已归档。
    const items = [];
    let seq = 0;
    const push = (o) => { seq += 1; items.push({ id: `id${String(seq).padStart(4, '0')}`, at: RENDER_FIX_ISO(seq), sourceKey: KEY, scope: 'private', ...o }); };
    push({ cat: 'trait', text: '核心性格：喜欢冷清', core: true });
    push({ cat: 'fact', text: '核心事实：主人的生日', core: true });
    push({ cat: 'pending', text: '约定B已过期', due: '2026-10-20', status: 'open' });
    push({ cat: 'pending', text: '约定A今天到期', due: '2026-10-30', status: 'open' });
    push({ cat: 'pending', text: '约定C没有日子', status: 'open' });
    push({ cat: 'pending', text: '约定D已经做完', due: '2026-10-31', status: 'done' });
    push({ cat: 'pending', text: '约定E取消了', status: 'cancelled' });
    push({ cat: 'fact', text: '已经归档的事实', archivedAt: '2026-10-05T00:00:00.000Z' });
    for (let i = 0; i < 20; i += 1) push({ cat: 'trait', text: `性格条目${i}` });
    for (let i = 0; i < 20; i += 1) push({ cat: 'fact', text: `事实条目${i}` });
    push({ cat: 'fact', text: '公开的事实', scope: 'public' });
    for (let i = 0; i < 8; i += 1) push({ cat: 'event', text: `经历条目${i}` });
    for (let i = 0; i < 7; i += 1) push({ cat: 'note', text: `备注条目${i}` });
    fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify({
      version: 1,
      people: { [OWNER]: { name: '主人', names: ['主人'], items, firstSeenAt: RENDER_FIX_ISO(0), lastSeenAt: RENDER_FIX_ISO(seq), messages: 3 } }
    }));
    const lm = createLongMemory({ stateDir: dir });
    assert.equal(lm.renderFor([OWNER], KEY, { today: '2026-10-30' }), RENDER_EXPECTED);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── §5 renderFor：有 decayOf 时按牢固度挑 ─────────────────────────────────
await test('renderFor + decayOf：按 R 取前 n、冻结的换成别的、显示按写入顺序、另有 N 条含冻结', async () => {
  await withMemory(async (lm) => {
    for (let i = 0; i < 20; i += 1) lm.remember({ userId: OWNER, cat: 'fact', text: `事实R${i}`, sourceKey: KEY });
    lm.remember({ userId: OWNER, cat: 'fact', text: '核心事实不冻结', sourceKey: KEY, core: true });

    const out = lm.renderFor([OWNER], KEY, { today: '2026-10-30' });
    const line = out.split('\n').find((l) => l.startsWith('  他说过的事：'));
    assert.ok(line, '应该有「他说过的事」这一行');

    // 20 条事实里冻结 3 条（R 还很高也照样剔除），其余按 R 取最高的 15 条
    const shown = [3, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19];
    for (const i of shown) assert.ok(line.includes(`事实R${i}〔`), `事实R${i} 应该在（R 最高的 15 条）`);
    for (const i of [0, 1, 2, 7, 13]) assert.ok(!line.includes(`事实R${i}〔`), `事实R${i} 不该在（冻结或被挤出）`);
    assert.ok(line.includes('（另有 5 条，用 qq_ltm_recall 查看）'), '另有 N 条含冻结的：20 - 15 = 5');

    // 显示顺序 = 写入顺序（arr 的顺序），不是 R 的顺序
    const idx = shown.map((i) => line.indexOf(`事实R${i}〔`));
    for (let k = 1; k < idx.length; k += 1) assert.ok(idx[k - 1] < idx[k], '显示时要按写入顺序');

    // 核心条目即使 decayOf 说冻结也照样显示
    assert.ok(out.includes('核心事实不冻结'), '核心条目不受冻结影响');
  }, {
    // 纯文本推 R，测试不依赖条目 id：冻结 2 / 7 / 13 和核心条目
    decayOf: (it) => {
      if (it.text === '核心事实不冻结') return { R: 0.01, frozen: true };
      if (['事实R2', '事实R7', '事实R13'].includes(it.text)) return { R: 0.99, frozen: true };
      const m = /事实R(\d+)/.exec(it.text);
      return { R: m ? Number(m[1]) / 20 : 1, frozen: false };
    }
  });
});

await test('renderFor + decayOf：回调抛异常 / 返回 null / R 不是数字时当作不冻结、不崩', async () => {
  await withMemory(async (lm) => {
    lm.remember({ userId: OWNER, cat: 'fact', text: '会抛错', sourceKey: KEY });
    lm.remember({ userId: OWNER, cat: 'fact', text: '返回null', sourceKey: KEY });
    lm.remember({ userId: OWNER, cat: 'fact', text: 'R不是数字', sourceKey: KEY });
    const out = lm.renderFor([OWNER], KEY, { today: '2026-10-30' });
    for (const t of ['会抛错', '返回null', 'R不是数字']) assert.ok(out.includes(t), `${t} 应当照常注入`);
  }, {
    decayOf: (it) => {
      if (it.text === '会抛错') throw new Error('boom');
      if (it.text === '返回null') return null;
      if (it.text === 'R不是数字') return { R: 'x', frozen: false };
      return { R: 0.5, frozen: false };
    }
  });
});

// ── §6 rowsAt ─────────────────────────────────────────────────────────────
await test('rowsAt：单行 / 跨月区间 / 去重 / 墓碑 / 路径安全 / 非法 key', async () => {
  await withMemory(async (lm) => {
    const F10 = 'private_100000001/2026-10.jsonl';
    const F11 = 'private_100000001/2026-11.jsonl';
    lm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: '十月第一条', at: '2026-10-01T10:00:00', msgId: 'm1' });
    lm.archive(KEY, { dir: 'out', userId: null, name: '', text: '十月第二条', at: '2026-10-02T10:00:00' });
    lm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: '十月第三条', at: '2026-10-03T10:00:00' });
    lm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: '十一月第一条', at: '2026-11-01T10:00:00' });
    lm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: '十一月第二条', at: '2026-11-02T10:00:00' });

    // 单行：字段形状与 archive 一致
    const one = lm.rowsAt(KEY, [{ file: F10, line: 2 }]);
    assert.deepEqual(one, [{
      t: new Date('2026-10-02T10:00:00').toISOString(),
      dir: 'out',
      userId: null,
      name: '',
      text: '十月第二条',
      msgId: null,
      file: F10,
      line: 2
    }]);

    // 跨文件区间：起点在 10 月第 3 行、终点在 11 月第 1 行
    assert.deepEqual(
      lm.rowsAt(KEY, [{ file: F10, lineStart: 3, fileEnd: F11, lineEnd: 1 }]).map((r) => r.text),
      ['十月第三条', '十一月第一条']
    );

    // 同一个 ref 重复出现只算一次
    assert.equal(lm.rowsAt(KEY, [{ file: F10, line: 1 }, { file: F10, line: 1 }]).length, 1);

    // 墓碑行跳过（参考 test-ltm-forget 的删法：按行改成墓碑）
    const listed = lm.listArchiveRows(KEY);
    const target = listed.rows.find((r) => r.file === F10 && r.line === 1);
    assert.deepEqual(lm.deleteArchiveRows(KEY, { rows: [{ file: target.file, line: target.line, t: target.t }] }), { matched: 1, deleted: 1, skipped: 0 });
    assert.deepEqual(lm.rowsAt(KEY, [{ file: F10, line: 1 }]), [], '墓碑要跳过');
    assert.equal(lm.rowsAt(KEY, [{ file: F10, lineStart: 1, lineEnd: 3 }]).length, 2, '墓碑占行号，后面的行照常返回');

    // 路径安全：`..`、别的会话、绝对路径、不存在的月份一律跳过
    assert.deepEqual(lm.rowsAt(KEY, [{ file: '../2026-10.jsonl', line: 1 }]), []);
    assert.deepEqual(lm.rowsAt(KEY, [{ file: 'private_999/2026-10.jsonl', line: 1 }]), []);
    assert.deepEqual(lm.rowsAt(KEY, [{ file: '/etc/passwd', line: 1 }]), []);
    assert.deepEqual(lm.rowsAt(KEY, [{ file: 'private_100000001/2026-09.jsonl', line: 1 }]), []);
    assert.deepEqual(lm.rowsAt(KEY, [{ file: F10, lineStart: 3, lineEnd: 1 }]), [], '起点在终点之后跳过');
    assert.deepEqual(lm.rowsAt(KEY, [{ file: F11, lineStart: 1, fileEnd: F10, lineEnd: 1 }]), [], '文件顺序反过来跳过');
    assert.deepEqual(lm.rowsAt(KEY, [{ file: F10, line: 0 }]), []);
    assert.deepEqual(lm.rowsAt(KEY, [{ file: F10, line: 1.5 }]), []);

    // 非法 key / 非法 refs
    assert.deepEqual(lm.rowsAt('not-a-key', [{ file: F10, line: 1 }]), []);
    assert.deepEqual(lm.rowsAt(KEY, 'not-array'), []);
    assert.deepEqual(lm.rowsAt(KEY, []), []);
    assert.deepEqual(lm.rowsAt(KEY, [null, 42, { file: F10 }]), []);
  });
});

await test('rowsAt：最多 200 行', async () => {
  await withMemory(async (lm) => {
    const F10 = 'private_100000001/2026-10.jsonl';
    for (let i = 0; i < 210; i += 1) lm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: `批量消息${i}`, at: '2026-10-05T10:00:00' });
    const rows = lm.rowsAt(KEY, [{ file: F10, lineStart: 1, lineEnd: 210 }]);
    assert.equal(rows.length, 200);
    assert.equal(rows[0].text, '批量消息0', '从存档顺序的头开始取');
    assert.equal(rows[199].text, '批量消息199');
  });
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
