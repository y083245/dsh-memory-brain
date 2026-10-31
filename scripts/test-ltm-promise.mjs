// src/long-memory.js 的「账本前置」单测（子项目 3 v1 · 规格 §4，任务 A）。
//
// 覆盖：到期日换算全表、约定字段（due / by / status）、核心条目上限、
// 超上限改成归档（不再删除）、约定状态转换与 onPromiseClosed 回调、
// at 刷新规则、renderFor 的新顺序与标记、duePromises / visibleTo / archiveRows。
//
// 全部用临时目录 + 假数据，不碰 state/ 里的真实账本与存档。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLongMemory, normalizeDueDate, CORE_MAX } from '../src/long-memory.js';

let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

/** 建一个临时 stateDir，跑完删掉。logs 收集 log() 的输出。 */
async function withMemory(run, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-promise-'));
  const logs = [];
  const lm = createLongMemory({ stateDir: dir, log: (m) => logs.push(String(m)), ...opts });
  try { await run(lm, dir, logs); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const OWNER = '100000001';
const KEY = `private:${OWNER}`;
const NOW = new Date(2026, 9, 30, 12, 0); // 2026-10-30 周五（规格 §4.1 的固定时刻）

// ── §4.1 normalizeDueDate：全表逐条断言 ─────────────────────────────────
const DUE_TABLE = [
  ['今天', '2026-10-30'],
  ['明天', '2026-10-31'],
  ['后天', '2026-11-01'],
  ['大后天', '2026-11-02'],
  ['3天后', '2026-11-02'],
  ['三天后', '2026-11-02'],
  ['两天后', '2026-11-01'],
  ['周五', '2026-10-30'],
  ['周六', '2026-10-31'],
  ['周一', '2026-11-02'],
  ['星期日', '2026-11-01'],
  ['周天', '2026-11-01'],
  ['这周一', '2026-10-26'],
  ['这周日', '2026-11-01'],
  ['下周一', '2026-11-02'],
  ['下周三', '2026-11-04'],
  ['下周五', '2026-11-06'],
  ['11月3日', '2026-11-03'],
  ['11月3号', '2026-11-03'],
  ['11-3', '2026-11-03'],
  ['11/3', '2026-11-03'],
  ['1月5日', '2027-01-05'],
  ['10月29日', '2026-10-29'],
  ['5号', '2026-11-05'],
  ['31号', '2026-10-31'],
  ['2026-11-03', '2026-11-03'],
  ['2026/11/3', '2026-11-03'],
  ['2026年11月3日', '2026-11-03']
];
const DUE_BAD = ['2026-02-30', '2028-01-01', '2026-09-01', '下周', '月底', 'asdf'];

await test('normalizeDueDate：规格 §4.1 全表', async () => {
  for (const [input, want] of DUE_TABLE) {
    assert.equal(normalizeDueDate(input, NOW), want, `${input} 应换算成 ${want}`);
  }
  for (const input of DUE_BAD) {
    assert.throws(() => normalizeDueDate(input, NOW), /到期日看不懂/, `${input} 应抛错`);
  }
  assert.equal(normalizeDueDate('', NOW), null);
  assert.equal(normalizeDueDate(null, NOW), null);
  assert.equal(normalizeDueDate('   ', NOW), null);
});

await test('normalizeDueDate：错误文案含原文与提示、原文截 20 字', async () => {
  assert.throws(() => normalizeDueDate('月底', NOW),
    (e) => /^到期日看不懂：月底；请写 YYYY-MM-DD，或 今天\/明天\/后天\/周五\/下周三\/3天后\/11月3日$/.test(e.message),
    '错误文案必须与规格一字不差');
  const long = '一二三四五六七八九十一二三四五六七八九十多余的字';
  assert.throws(() => normalizeDueDate(long, NOW), (e) => e.message.includes('到期日看不懂：一二三四五六七八九十一二三四五六七八九十；'),
    '原文要截到 20 字');
});

await test('normalizeDueDate：用本地日期而不是 UTC，全天任意时刻结果一致', async () => {
  // 同一天的 00:01 与 23:59 必须给出同一个「今天」（toISOString 在 UTC+8 的晚上会差一天）
  assert.equal(normalizeDueDate('今天', new Date(2026, 9, 30, 0, 1)), '2026-10-30');
  assert.equal(normalizeDueDate('今天', new Date(2026, 9, 30, 23, 59)), '2026-10-30');
  assert.equal(normalizeDueDate('明天', new Date(2026, 9, 30, 23, 59)), '2026-10-31');
});

// ── remember：due / by / core ───────────────────────────────────────────
await test('remember：约定默认 status=open，due / by 到位', async () => {
  await withMemory(async (lm) => {
    // FIX1031_PATCH：期望值用同一个时钟现算，不再写死 2026-10-31（过了那天用例必失败）。
    // 调用前后各取一次时间：万一正好跨过午夜，内部用的是哪一侧都对得上。
    const before = new Date();
    const { item, duplicate } = lm.remember({
      userId: OWNER, name: '主人', cat: 'pending', text: '周末一起看电影', sourceKey: KEY, due: '明天', by: 'them'
    });
    const after = new Date();
    assert.equal(duplicate, false);
    assert.equal(item.cat, 'pending');
    assert.equal(item.status, 'open');
    const wantDue = new Set([normalizeDueDate('明天', before), normalizeDueDate('明天', after)]);
    assert.ok(wantDue.has(item.due), `due 要经 normalizeDueDate 换算（得到 ${item.due}）`);
    assert.equal(item.by, 'them');
    assert.equal(item.core, undefined);
  });
});

await test('remember：due / by 只允许给 pending；by 只认 me / them', async () => {
  await withMemory(async (lm) => {
    assert.throws(() => lm.remember({ userId: OWNER, cat: 'fact', text: '他养了一只猫', due: '明天', sourceKey: KEY }),
      /只有约定（pending）才能设到期日和谁答应的/);
    assert.throws(() => lm.remember({ userId: OWNER, cat: 'trait', text: '喜欢猫', by: 'me', sourceKey: KEY }),
      /只有约定（pending）才能设到期日和谁答应的/);
    assert.throws(() => lm.remember({ userId: OWNER, cat: 'pending', text: '去看海', by: 'other', sourceKey: KEY }),
      /谁答应的只能是/);
    // 空的 due / by 当作没传
    const { item } = lm.remember({ userId: OWNER, cat: 'fact', text: '他家在杭州', due: '', by: '', sourceKey: KEY });
    assert.equal(item.due, undefined);
    assert.equal(item.by, undefined);
    // 看不懂的到期日直接报错，条目不会写进去
    assert.throws(() => lm.remember({ userId: OWNER, cat: 'pending', text: '出门', due: '月底', sourceKey: KEY }), /到期日看不懂/);
    assert.equal(lm.personView(OWNER).items.length, 1);
  });
});

await test('remember：核心条目最多 8 条（第 9 条报错）', async () => {
  await withMemory(async (lm) => {
    assert.equal(CORE_MAX, 8);
    for (let i = 1; i <= CORE_MAX; i += 1) {
      const r = lm.remember({ userId: OWNER, cat: 'fact', text: `核心事实${i}`, sourceKey: KEY, core: true });
      assert.equal(r.item.core, true);
    }
    assert.throws(() => lm.remember({ userId: OWNER, cat: 'fact', text: '核心事实9', sourceKey: KEY, core: true }),
      /核心条目最多 8 条，先用 qq_ltm_update 把一条的 core 设为 false/);
    // 非核心照常写
    assert.equal(lm.remember({ userId: OWNER, cat: 'fact', text: '普通事实', sourceKey: KEY }).item.core, undefined);
  });
});

await test('remember：重复内容合并到同一条，并补上这次的 due / by / core', async () => {
  await withMemory(async (lm) => {
    const first = lm.remember({ userId: OWNER, cat: 'pending', text: '一起看电影', sourceKey: KEY }).item;
    // FIX1031_PATCH：同上，周五按调用时的「今天」换算，不写死日期（跨午夜时取两侧之一）。
    const before = new Date();
    const r = lm.remember({ userId: OWNER, cat: 'pending', text: '一起看电影', sourceKey: KEY, due: '周五', by: 'me', core: true });
    const after = new Date();
    assert.equal(r.duplicate, true);
    assert.equal(r.item.id, first.id, '同一条，不新增');
    const wantDue = new Set([normalizeDueDate('周五', before), normalizeDueDate('周五', after)]);
    assert.ok(wantDue.has(r.item.due), `重复时补上这次的 due（得到 ${r.item.due}）`);
    assert.equal(r.item.by, 'me');
    assert.equal(r.item.core, true);
    assert.equal(lm.personView(OWNER).items.length, 1);
  });
});

// ── 重复命中已归档条目：恢复（规格 §4.3，2026-10-30 审核补充）─────────────
await test('remember：重复命中已归档条目 → 恢复、刷新 at，超上限时归档的是别的最旧条目', async () => {
  await withMemory(async (lm, dir, logs) => {
    const uid = '710';
    const key = `private:${uid}`;
    // note 上限 40：写 41 条 → 第 41 条写入时把最旧的「笔记1」归档
    const notes = [];
    for (let i = 1; i <= 41; i += 1) notes.push(lm.remember({ userId: uid, name: '阿强', cat: 'note', text: `笔记${i}`, sourceKey: key }).item);
    // 手动把 at 拉开成递增的旧时间（真机上是毫秒级写入顺序，测试里不能靠同一毫秒的偶然顺序）
    notes.forEach((n, i) => { n.at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(); });
    const live = () => lm.personView(uid).items;
    assert.equal(live()[0].text, '笔记1');
    assert.ok(live()[0].archivedAt, '第 41 条写入时「笔记1」被归档');

    const oldAt = live()[0].at;
    const r = lm.remember({ userId: uid, name: '阿强', cat: 'note', text: '笔记1', sourceKey: key });
    assert.equal(r.duplicate, true);
    assert.equal(r.item.archivedAt, undefined, '已归档的条目被重复记时要恢复');
    assert.notEqual(r.item.at, oldAt, 'at 要刷新');
    assert.ok(Date.parse(r.item.at) > Date.parse(oldAt), 'at 要变成最新的');
    assert.equal(live().length, 41, '条目一条都不能少');

    // 恢复后该类别超上限 1 条 → 归档的是此刻最旧的「笔记2」，不是刚恢复的那条
    assert.equal(live().find((x) => x.text === '笔记2').archivedAt !== undefined, true, '超上限时应归档其它最旧条目');
    assert.equal(live().find((x) => x.text === '笔记1').archivedAt, undefined, '刚恢复的条目不能被立刻再归档');
    const active = live().filter((x) => x.cat === 'note' && !x.archivedAt && !x.core);
    assert.equal(active.length, 40);
    assert.ok(logs.some((m) => /账本超上限，归档 1 条（710·note）/.test(m)), logs.join(' | '));
  });
});

await test('remember：已归档条目被重复记 + core:true → 先恢复再设核心；核心满 8 条仍报上限', async () => {
  await withMemory(async (lm) => {
    const uid = '711';
    const key = `private:${uid}`;
    const a = lm.remember({ userId: uid, name: '小林', cat: 'fact', text: '他喜欢爬山', sourceKey: key }).item;
    lm.update({ userId: uid, itemId: a.id, archived: true, viewerKey: key });

    const r = lm.remember({ userId: uid, name: '小林', cat: 'fact', text: '他喜欢爬山', sourceKey: key, core: true });
    assert.equal(r.duplicate, true);
    assert.equal(r.item.archivedAt, undefined, '不报「已归档的条目先恢复再设为核心」，直接恢复');
    assert.equal(r.item.core, true, '恢复后成为核心');

    // 补满到 8 条核心
    for (let i = 2; i <= 8; i += 1) {
      lm.remember({ userId: uid, name: '小林', cat: 'fact', text: `核心${i}`, sourceKey: key, core: true });
    }
    assert.equal(lm.personView(uid).items.filter((x) => x.core && !x.archivedAt).length, 8);

    const b = lm.remember({ userId: uid, name: '小林', cat: 'note', text: '他怕水', sourceKey: key }).item;
    lm.update({ userId: uid, itemId: b.id, archived: true, viewerKey: key });
    assert.throws(() => lm.remember({ userId: uid, name: '小林', cat: 'note', text: '他怕水', sourceKey: key, core: true }),
      /核心条目最多 8 条/, '核心已满时，已归档条目重新记也不能绕过上限');
    assert.ok(lm.personView(uid).items.find((x) => x.id === b.id).archivedAt, '报错时不应留下半截修改（仍然归档着）');
  });
});

// ── enforceCap：归档而不是删除 ──────────────────────────────────────────
await test('enforceCap：超上限归档最旧的，条目不删除、核心不归档', async () => {
  await withMemory(async (lm, dir, logs) => {
    const uid = '700';
    const key = `private:${uid}`;
    // trait 上限 40：写 45 条
    for (let i = 1; i <= 45; i += 1) lm.remember({ userId: uid, name: '阿明', cat: 'trait', text: `性格${i}`, sourceKey: key });
    // 三条核心（任何类别都不计入上限）
    for (let i = 1; i <= 3; i += 1) lm.remember({ userId: uid, name: '阿明', cat: 'trait', text: `核心性格${i}`, sourceKey: key, core: true });

    const items = lm.personView(uid).items;
    assert.equal(items.length, 48, '条目一条都不能少（旧实现会真删）');
    const traits = items.filter((x) => x.cat === 'trait');
    const archived = traits.filter((x) => x.archivedAt);
    const active = traits.filter((x) => !x.archivedAt && !x.core);
    assert.equal(active.length, 40, '未归档非核心的正好等于上限');
    assert.deepEqual(archived.map((x) => x.text), ['性格1', '性格2', '性格3', '性格4', '性格5'], '按 at 从旧到新归档');
    assert.ok(traits.filter((x) => x.core).every((x) => !x.archivedAt), '核心条目永不归档');
    assert.ok(logs.some((m) => /账本超上限，归档 1 条（700·trait）/.test(m)), `应有归档日志：${logs.join(' | ')}`);
    // 存档文件里也还在（不是只从内存里删）
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'people.json'), 'utf8'));
    assert.equal(onDisk.people[uid].items.length, 48);
  });
});

await test('enforceCap：先归档已结束的约定（按 closedAt 从旧到新），核心不动', async () => {
  await withMemory(async (lm) => {
    const uid = '701';
    const key = `private:${uid}`;
    const made = [];
    for (let i = 1; i <= 40; i += 1) made.push(lm.remember({ userId: uid, name: '小美', cat: 'pending', text: `约定${i}`, sourceKey: key }).item);
    for (let i = 1; i <= 3; i += 1) lm.remember({ userId: uid, name: '小美', cat: 'pending', text: `核心约定${i}`, sourceKey: key, core: true });

    // 把第 3 条标 done、第 1 条标 missed；再手动把 closedAt 拉开，确定归档顺序
    lm.update({ userId: uid, itemId: made[2].id, status: 'done', viewerKey: key });
    lm.update({ userId: uid, itemId: made[0].id, status: 'missed', viewerKey: key });
    const live = lm.personView(uid).items;
    live.find((x) => x.id === made[2].id).closedAt = '2026-10-20T00:00:00.000Z';
    live.find((x) => x.id === made[0].id).closedAt = '2026-10-10T00:00:00.000Z';

    // 再加两条 → 超上限 2 条
    lm.remember({ userId: uid, name: '小美', cat: 'pending', text: '新约定A', sourceKey: key });
    lm.remember({ userId: uid, name: '小美', cat: 'pending', text: '新约定B', sourceKey: key });

    const items = lm.personView(uid).items;
    assert.equal(items.length, 45, '一条都不能少');
    const archived = items.filter((x) => x.archivedAt).map((x) => x.text).sort();
    assert.deepEqual(archived, ['约定1', '约定3'], '先归档已结束的（closedAt 早的先）');
    const active = items.filter((x) => x.cat === 'pending' && !x.archivedAt && !x.core);
    assert.equal(active.length, 40);
    assert.ok(items.filter((x) => x.core).every((x) => !x.archivedAt));
  });
});

// ── update：状态转换与 onPromiseClosed ──────────────────────────────────
await test('onPromiseClosed：只在 open → done / missed 时同步调一次', async () => {
  const calls = [];
  await withMemory(async (lm) => {
    const made = lm.remember({ userId: OWNER, name: '主人', cat: 'pending', text: '一起去买菜', sourceKey: KEY, by: 'them' }).item;
    const done = lm.update({ userId: OWNER, itemId: made.id, status: 'done', viewerKey: KEY });
    assert.equal(done.status, 'done');
    assert.ok(done.closedAt, 'open → done 要写 closedAt');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, OWNER);
    assert.equal(calls[0].name, '主人');
    assert.equal(calls[0].from, 'open');
    assert.equal(calls[0].to, 'done');
    assert.equal(calls[0].viewerKey, KEY);
    assert.equal(calls[0].item.status, 'done');

    // 结束后互改：只改状态，不回调、不动 closedAt
    const closedAt = done.closedAt;
    lm.update({ userId: OWNER, itemId: made.id, status: 'missed', viewerKey: KEY });
    lm.update({ userId: OWNER, itemId: made.id, status: 'cancelled', viewerKey: KEY });
    assert.equal(calls.length, 1, 'done ↔ missed ↔ cancelled 不回调');
    assert.equal(lm.personView(OWNER).items[0].closedAt, closedAt);

    // 重开 → 删掉 closedAt，也不回调
    lm.update({ userId: OWNER, itemId: made.id, status: 'open', viewerKey: KEY });
    assert.equal(lm.personView(OWNER).items[0].closedAt, undefined);
    assert.equal(calls.length, 1);

    // open → cancelled 也不回调
    lm.update({ userId: OWNER, itemId: made.id, status: 'cancelled', viewerKey: KEY });
    assert.equal(calls.length, 1);
  }, { onPromiseClosed: (info) => calls.push(info) });
});

await test('onPromiseClosed：回调抛错不影响 update 的返回值', async () => {
  const logs = [];
  await withMemory(async (lm) => {
    const made = lm.remember({ userId: OWNER, name: '主人', cat: 'pending', text: '一起爬山', sourceKey: KEY }).item;
    const it = lm.update({ userId: OWNER, itemId: made.id, status: 'missed', viewerKey: KEY });
    assert.equal(it.status, 'missed');
    assert.equal(it.id, made.id);
    assert.ok(logs.some((m) => /onPromiseClosed 失败：故意炸/.test(m)), `要记日志：${logs.join(' | ')}`);
  }, { log: (m) => logs.push(String(m)), onPromiseClosed: () => { throw new Error('故意炸'); } });
});

await test('update：状态 / due / by 的校验与清除', async () => {
  await withMemory(async (lm) => {
    const made = lm.remember({ userId: OWNER, cat: 'pending', text: '去看展', sourceKey: KEY, due: '明天', by: 'me' }).item;
    assert.throws(() => lm.update({ userId: OWNER, itemId: made.id, status: 'nope', viewerKey: KEY }), /状态只能是/);
    assert.throws(() => lm.update({ userId: OWNER, itemId: made.id, due: '月底', viewerKey: KEY }), /到期日看不懂/);
    assert.throws(() => lm.update({ userId: OWNER, itemId: made.id, by: 'x', viewerKey: KEY }), /谁答应的只能是/);

    const cleared = lm.update({ userId: OWNER, itemId: made.id, due: '', by: '', viewerKey: KEY });
    assert.equal(cleared.due, undefined);
    assert.equal(cleared.by, undefined);
    const set = lm.update({ userId: OWNER, itemId: made.id, due: '下周三', by: 'them', viewerKey: KEY });
    assert.equal(set.due, '2026-11-04');
    assert.equal(set.by, 'them');

    // 非约定不能有状态 / 到期日
    const fact = lm.remember({ userId: OWNER, cat: 'fact', text: '他喜欢咖啡', sourceKey: KEY }).item;
    assert.throws(() => lm.update({ userId: OWNER, itemId: fact.id, status: 'done', viewerKey: KEY }), /只有约定（pending）才有状态/);
    assert.throws(() => lm.update({ userId: OWNER, itemId: fact.id, due: '明天', viewerKey: KEY }), /只有约定（pending）才能设到期日和谁答应的/);
  });
});

await test('update：类别在 pending 与其它之间切换时，约定字段跟着走', async () => {
  await withMemory(async (lm) => {
    const made = lm.remember({ userId: OWNER, cat: 'pending', text: '整理照片', sourceKey: KEY, due: '明天', by: 'me' }).item;
    const toFact = lm.update({ userId: OWNER, itemId: made.id, cat: 'fact', viewerKey: KEY });
    assert.equal(toFact.cat, 'fact');
    for (const f of ['due', 'by', 'status', 'closedAt']) assert.equal(toFact[f], undefined, `${f} 应被清掉`);

    const back = lm.update({ userId: OWNER, itemId: made.id, cat: 'pending', viewerKey: KEY });
    assert.equal(back.status, 'open', '改回约定时状态是 open');
  });
});

await test('update：核心 / 归档的规则', async () => {
  await withMemory(async (lm) => {
    const it = lm.remember({ userId: OWNER, cat: 'fact', text: '他生日是 5 月 1 日', sourceKey: KEY }).item;
    assert.equal(lm.update({ userId: OWNER, itemId: it.id, core: true, viewerKey: KEY }).core, true);
    assert.throws(() => lm.update({ userId: OWNER, itemId: it.id, archived: true, viewerKey: KEY }), /核心条目不能归档，先取消核心/);
    assert.equal(lm.update({ userId: OWNER, itemId: it.id, core: false, viewerKey: KEY }).core, undefined);
    assert.ok(lm.update({ userId: OWNER, itemId: it.id, archived: true, viewerKey: KEY }).archivedAt);
    // 已归档的不能直接设核心
    assert.throws(() => lm.update({ userId: OWNER, itemId: it.id, core: true, viewerKey: KEY }), /已归档的条目先恢复再设为核心/);
    // 同一次调用里先恢复再设核心是允许的
    const both = lm.update({ userId: OWNER, itemId: it.id, archived: false, core: true, viewerKey: KEY });
    assert.equal(both.archivedAt, undefined);
    assert.equal(both.core, true);

    // 核心上限：不算它自己
    for (let i = 1; i <= 7; i += 1) lm.remember({ userId: OWNER, cat: 'note', text: `核心${i}`, sourceKey: KEY, core: true });
    const first = lm.personView(OWNER).items.find((x) => x.core && x.text === '他生日是 5 月 1 日');
    assert.equal(lm.update({ userId: OWNER, itemId: first.id, core: true, viewerKey: KEY }).core, true, '已经在核心里的条目再设一次不算超限');
    const extra = lm.remember({ userId: OWNER, cat: 'note', text: '第九条', sourceKey: KEY }).item;
    assert.throws(() => lm.update({ userId: OWNER, itemId: extra.id, core: true, viewerKey: KEY }), /核心条目最多 8 条/);
  });
});

await test('update：at 只在 text / cat / scope 真的传入时刷新', async () => {
  await withMemory(async (lm) => {
    const it = lm.remember({ userId: OWNER, cat: 'pending', text: '一起跑步', sourceKey: KEY }).item;
    const live = () => lm.personView(OWNER).items.find((x) => x.id === it.id);
    const OLD = '2020-01-01T00:00:00.000Z';
    live().at = OLD;
    lm.update({ userId: OWNER, itemId: it.id, status: 'done', viewerKey: KEY });
    assert.equal(live().at, OLD, '标状态不应刷新 at');
    live().at = OLD;
    lm.update({ userId: OWNER, itemId: it.id, core: true, viewerKey: KEY });
    assert.equal(live().at, OLD, '设核心不应刷新 at');
    live().at = OLD;
    lm.update({ userId: OWNER, itemId: it.id, core: false, viewerKey: KEY });
    assert.equal(live().at, OLD, '取消核心不应刷新 at');
    live().at = OLD;
    lm.update({ userId: OWNER, itemId: it.id, archived: true, viewerKey: KEY });
    assert.equal(live().at, OLD, '归档不应刷新 at');
    live().at = OLD;
    lm.update({ userId: OWNER, itemId: it.id, text: '一起跑步呀', viewerKey: KEY });
    assert.notEqual(live().at, OLD, '改内容要刷新 at');
    live().at = OLD;
    lm.update({ userId: OWNER, itemId: it.id, scope: 'public', viewerKey: KEY });
    assert.notEqual(live().at, OLD, '改可见范围要刷新 at');
    live().at = OLD;
    lm.update({ userId: OWNER, itemId: it.id, cat: 'note', viewerKey: KEY });
    assert.notEqual(live().at, OLD, '改类别要刷新 at');
  });
});

// ── renderFor：新顺序、标记、隐藏规则 ───────────────────────────────────
await test('renderFor：块的顺序与「另有 N 条」只数未归档', async () => {
  await withMemory(async (lm) => {
    const uid = '800';
    const key = `private:${uid}`;
    const coreTrait = lm.remember({ userId: uid, name: '阿明', cat: 'trait', text: '核心：怕黑', sourceKey: key, core: true }).item;
    const promise = lm.remember({ userId: uid, name: '阿明', cat: 'pending', text: '周末一起看电影', sourceKey: key, due: '2026-10-30', by: 'them' }).item;
    lm.remember({ userId: uid, name: '阿明', cat: 'trait', text: '喜欢吃辣', sourceKey: key });
    for (let i = 1; i <= 18; i += 1) lm.remember({ userId: uid, name: '阿明', cat: 'fact', text: `事实${i}`, sourceKey: key });
    const facts = lm.personView(uid).items.filter((x) => x.cat === 'fact');
    lm.update({ userId: uid, itemId: facts[0].id, archived: true, viewerKey: key }); // 事实1 归档
    lm.update({ userId: uid, itemId: facts[1].id, core: true, viewerKey: key });     // 事实2 进核心
    lm.remember({ userId: uid, name: '阿明', cat: 'event', text: '一起看过海', sourceKey: key });
    lm.remember({ userId: uid, name: '阿明', cat: 'note', text: '他养了一只叫豆豆的猫', sourceKey: key });

    const out = lm.renderFor([uid], key, { today: '2026-10-30' });
    const lines = out.split('\n');
    assert.equal(lines[0], '· 阿明（QQ 800）');
    const labels = lines.slice(1).map((l) => l.trim().split('：')[0]);
    assert.deepEqual(labels, ['核心', '约定/没聊完', '性格/喜好', '他说过的事', '最近的要紧事', '其它'],
      `顺序必须按规格 §4.5：\n${out}`);

    const pick = (label) => lines.find((l) => l.trim().startsWith(`${label}：`));
    assert.ok(pick('核心').includes('核心：怕黑〔'), pick('核心'));
    assert.ok(pick('核心').includes('事实2'), '进核心的事实只出现在核心行');
    assert.ok(!pick('他说过的事').includes('事实2'), '核心条目不再出现在分类行');
    assert.ok(!out.includes('事实1〔'), '已归档的条目不渲染');
    assert.equal((out.match(/事实2/g) || []).length, 1, '同一条只出现一次');
    assert.ok(pick('他说过的事').includes('另有 1 条'), `事实3 被挤出去、只剩未归档的 16 条：${pick('他说过的事')}`);
    assert.ok(!pick('他说过的事').includes('事实3'), '显示最近 15 条');
    assert.ok(pick('他说过的事').includes('事实18'));
    assert.ok(pick('约定/没聊完').includes('【今天到期】周末一起看电影（他答应的）〔'), pick('约定/没聊完'));
    assert.ok(pick('约定/没聊完').includes(promise.id));
    assert.ok(pick('最近的要紧事').includes('一起看过海'));
    assert.ok(/最近的要紧事：\d{4}-\d{2}-\d{2} 一起看过海/.test(pick('最近的要紧事')), 'event 照旧带日期前缀');
    assert.ok(pick('核心').includes(coreTrait.id));
  });
});

await test('renderFor：约定排序（过期 → 今天 → 7 天内 → 其余）与标记；已结束的不渲染', async () => {
  await withMemory(async (lm) => {
    const uid = '801';
    const key = `private:${uid}`;
    const mk = (text, extra = {}) => lm.remember({ userId: uid, name: '小红', cat: 'pending', text, sourceKey: key, ...extra }).item;
    const far = mk('很久以后的事', { due: '2026-12-01' });
    const none = mk('没写到期日的事');
    const soon = mk('三天后的事', { due: '2026-11-02' });
    const today = mk('今天的事', { due: '2026-10-30' });
    const older = mk('前天的事', { due: '2026-10-28' });
    const olderStill = mk('上周的事', { due: '2026-10-23' });
    const doneOne = mk('已经兑现的事', { due: '2026-10-29' });
    lm.update({ userId: uid, itemId: doneOne.id, status: 'done', viewerKey: key });

    const out = lm.renderFor([uid], key, { today: '2026-10-30' });
    const line = out.split('\n').find((l) => l.trim().startsWith('约定/没聊完：'));
    assert.ok(line, out);
    const order = [olderStill.text, older.text, today.text, soon.text].map((t) => line.indexOf(t));
    assert.ok(order.every((p) => p >= 0), `前四条都要出现：${line}`);
    assert.ok(order.every((p, i) => i === 0 || p > order[i - 1]), `排序应为 过期(按 due) → 今天 → 7 天内 → 其余：${line}`);
    assert.ok(line.indexOf(none.text) > order[3] && line.indexOf(far.text) > order[3], '无 due / 远期排在最后');
    assert.ok(!line.includes('已经兑现的事'), '已结束的约定不渲染');

    assert.ok(line.includes('【已过期7天，兑现了吗？】上周的事'), line);
    assert.ok(line.includes('【已过期2天，兑现了吗？】前天的事'), line);
    assert.ok(line.includes('【今天到期】今天的事'), line);
    assert.ok(line.includes('【11-02到期】三天后的事'), line);
    assert.ok(!/【[^】]*】没写到期日的事/.test(line), '没有 due 的不加标记');
    assert.ok(line.includes('没写到期日的事〔'), line);

    // by 标记插在文字后、编号前
    lm.update({ userId: uid, itemId: today.id, by: 'me', viewerKey: key });
    const out2 = lm.renderFor([uid], key, { today: '2026-10-30' });
    assert.ok(out2.includes(`【今天到期】今天的事（你答应的）〔${today.id}〕`), out2);
  });
});

await test('renderFor：today 缺省用本地今天；空账本 / 全是已结束的返回空串', async () => {
  await withMemory(async (lm) => {
    assert.equal(lm.renderFor(['999'], null), '');
    const uid = '802';
    const key = `private:${uid}`;
    const only = lm.remember({ userId: uid, cat: 'pending', text: '没下文的事', sourceKey: key }).item;
    lm.update({ userId: uid, itemId: only.id, status: 'cancelled', viewerKey: key });
    assert.equal(lm.renderFor([uid], key), '', '只剩已结束的约定时整块不出现');

    const p = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const localToday = `${p.getFullYear()}-${pad(p.getMonth() + 1)}-${pad(p.getDate())}`;
    lm.remember({ userId: uid, cat: 'pending', text: '今天的事', sourceKey: key, due: '今天' });
    assert.ok(lm.renderFor([uid], key).includes('【今天到期】今天的事'), `today 缺省应为本地今天 ${localToday}`);
  });
});

// ── 新增查询：duePromises / visibleTo / archiveRows ─────────────────────
await test('duePromises：只出未归档、open、当天的约定，按人分组', async () => {
  await withMemory(async (lm) => {
    const a = lm.remember({ userId: '901', name: '甲', cat: 'pending', text: '甲的约定一', sourceKey: 'private:901', due: '2026-10-30' }).item;
    lm.remember({ userId: '901', name: '甲', cat: 'pending', text: '甲的约定二', sourceKey: 'private:901', due: '2026-10-30' });
    lm.remember({ userId: '901', name: '甲', cat: 'pending', text: '甲别的日子', sourceKey: 'private:901', due: '2026-10-31' });
    const b = lm.remember({ userId: '902', name: '乙', cat: 'pending', text: '乙的约定', sourceKey: 'private:902', due: '2026-10-30' }).item;
    lm.update({ userId: '902', itemId: b.id, status: 'done', viewerKey: 'private:902' });
    const c = lm.remember({ userId: '903', name: '丙', cat: 'pending', text: '丙的约定', sourceKey: 'private:903', due: '2026-10-30' }).item;
    lm.update({ userId: '903', itemId: c.id, archived: true, viewerKey: 'private:903' });

    const r = lm.duePromises('2026-10-30');
    assert.equal(r.length, 1, '已兑现 / 已归档的人不出现');
    assert.equal(r[0].userId, '901');
    assert.equal(r[0].name, '甲');
    assert.deepEqual(r[0].items.map((x) => x.text), ['甲的约定一', '甲的约定二']);
    assert.equal(r[0].items[0].id, a.id);
    assert.deepEqual(lm.duePromises(''), []);
    assert.deepEqual(lm.duePromises('2026-01-01'), []);
  });
});

await test('visibleTo：公开给谁看都行，私聊记的只在该私聊可见', async () => {
  await withMemory(async (lm) => {
    const priv = lm.remember({ userId: OWNER, cat: 'fact', text: '私事', sourceKey: KEY }).item;
    const pub = lm.remember({ userId: OWNER, cat: 'fact', text: '公开的事', sourceKey: KEY, scope: 'public' }).item;
    assert.equal(priv.scope, 'private');
    assert.equal(lm.visibleTo(priv, KEY), true);
    assert.equal(lm.visibleTo(priv, 'private:111'), false, '别的私聊看不到');
    assert.equal(lm.visibleTo(priv, 'group:222'), false, '群聊看不到');
    assert.equal(lm.visibleTo(priv, null), true, '不传会话时不过滤');
    assert.equal(lm.visibleTo(pub, 'group:222'), true);
  });
});

await test('archiveRows：按时间/方向过滤、只保留最新 limit 条、坏行跳过', async () => {
  await withMemory(async (lm, dir) => {
    const rows = [
      { at: '2026-10-01T10:00:00', text: '第一天', userId: '2001', name: '阿明' },
      { at: '2026-10-02T10:00:00', dir: 'out', text: '第二天的回复' },
      { at: '2026-10-03T10:00:00', text: '第三天', msgId: '42' }
    ];
    for (const r of rows) lm.archive(KEY, { dir: r.dir ?? 'in', userId: r.userId ?? null, name: r.name ?? '', text: r.text, at: r.at, msgId: r.msgId ?? null });
    // 混一条坏行进文件尾
    fs.appendFileSync(path.join(dir, 'archive', 'private_100000001', '2026-10.jsonl'), '{坏行\n');
    lm.archive('group:555', { dir: 'in', userId: '3001', name: '群友', text: '群里的消息', at: '2026-10-02T10:00:00' });

    const all = lm.archiveRows(KEY);
    assert.deepEqual(all.map((r) => r.text), ['第一天', '第二天的回复', '第三天'], '按时间从旧到新、坏行跳过');
    assert.deepEqual(Object.keys(all[0]).sort(), ['dir', 'msgId', 'name', 'text', 't', 'userId'].sort());

    const since = lm.archiveRows(KEY, { sinceMs: Date.parse('2026-10-02T00:00:00'), untilMs: Date.parse('2026-10-03T00:00:00') });
    assert.deepEqual(since.map((r) => r.text), ['第二天的回复'], '[sinceMs, untilMs) 左闭右开');

    const incoming = lm.archiveRows(KEY, { dir: 'in' });
    assert.deepEqual(incoming.map((r) => r.text), ['第一天', '第三天']);

    const newest = lm.archiveRows(KEY, { limit: 2 });
    assert.deepEqual(newest.map((r) => r.text), ['第二天的回复', '第三天'], '超上限保留最新 limit 条');

    assert.deepEqual(lm.archiveRows('group:555').map((r) => r.text), ['群里的消息'], '会话之间互不可见');
    assert.deepEqual(lm.archiveRows('private:1000'), [], '没有存档的会话返回空');
    assert.throws(() => lm.archiveRows('not-a-key'), /会话 key 不合法/);
  });
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
