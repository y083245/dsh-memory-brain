// src/own-life.js 的单测（LIFE_LOOP_PATCH，子项目 3 · 规格 docs/design/LIFE_LOOP_SPEC.md §5）。
//
// 全部用固定本地时刻 + 一分钟一次的假时钟，不碰真实时间和 state/。
// 重点钉住 F2 的修复：计数按活动日、半夜那次不占白天额度、安静时段一次都不发。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnLife, DEFAULT_TEXT_DAY, DEFAULT_TEXT_MIDNIGHT } from '../src/own-life.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const MIN = 60000;
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const ymd = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 建一个临时状态目录 + 假的 deliver；failFirst 用来模拟前 n 次投递失败。 */
function withOwnLife(run, { opts = {}, state = null, failFirst = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-own-life-'));
  const statePath = path.join(dir, 'own-life.json');
  if (state) fs.writeFileSync(statePath, JSON.stringify(state));
  const fired = [];
  const logs = [];
  let calls = 0;
  const ol = createOwnLife({
    key: 'private:2001',
    deliver: async (text, meta) => {
      calls += 1;
      if (calls <= failFirst) throw new Error('投递失败');
      fired.push({ text, meta });
    },
    statePath,
    log: (...a) => logs.push(a.join(' ')),
    ...opts,
  });
  return run({ ol, fired, logs, dir, statePath }).finally(() => { ol.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
}

/** 从 start 到 end（含）按本地墙钟每分钟 tick 一次。 */
async function runMinutes(ol, start, end) {
  const cursor = new Date(start);
  const stop = new Date(end);
  while (cursor.getTime() <= stop.getTime()) {
    await ol.tick(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
}

const DAY_TIMES = ['08:00', '10:30', '13:00', '15:30', '18:00', '20:30', '23:30'];

await test('连跑两个活动日：每天正好 7 次（白天 6 + 半夜 1），时刻如规格，08:00 前一次都不发', async () => {
  await withOwnLife(async ({ ol, fired }) => {
    await runMinutes(ol, at(2026, 10, 30, 8, 0), at(2026, 11, 1, 7, 59));
    const got = fired.map((f) => `${ymd(f.meta.at)} ${hm(f.meta.at)}`);
    const expected = [];
    for (const day of ['2026-10-30', '2026-10-31']) for (const t of DAY_TIMES) expected.push(`${day} ${t}`);
    assert.deepEqual(got, expected);
    // 文案：白天用白天那句，半夜点「主人睡着了」那句。
    assert.ok(fired.every((f) => (f.meta.kind === 'midnight' ? f.text === DEFAULT_TEXT_MIDNIGHT : f.text === DEFAULT_TEXT_DAY)));
    // 半夜那次不占白天额度：每个活动日 6 白天 + 1 半夜。
    assert.equal(fired.filter((f) => f.meta.kind === 'day').length, 12);
    assert.equal(fired.filter((f) => f.meta.kind === 'midnight').length, 2);
    // 00:00～07:59 一次都不发（含 00:00～02:59 这段「前一个活动日」的尾巴）。
    assert.equal(fired.filter((f) => new Date(f.meta.at).getHours() < 8).length, 0);
  });
});

await test('remainingSlots：白天依次 7/6/5/4/3/2，半夜那次是 1', async () => {
  await withOwnLife(async ({ ol, fired }) => {
    await runMinutes(ol, at(2026, 10, 30, 8, 0), at(2026, 10, 30, 23, 31));
    assert.deepEqual(fired.map((f) => f.meta.remainingSlots), [7, 6, 5, 4, 3, 2, 1]);
    assert.deepEqual(fired.map((f) => f.meta.kind), ['day', 'day', 'day', 'day', 'day', 'day', 'midnight']);
    // meta.at 就是触发时刻，和 deliver 收到的文字分开传（桥接要用它算生活回路的素材）。
    assert.equal(fired[0].meta.at, at(2026, 10, 30, 8, 0));
  });
});

await test('安静时段 3:00–8:00 什么都不发（返回 quiet）', async () => {
  await withOwnLife(async ({ ol, fired }) => {
    const cursor = new Date(at(2026, 10, 30, 3, 0));
    while (cursor.getTime() < at(2026, 10, 30, 8, 0)) {
      const r = await ol.tick(cursor.getTime());
      assert.deepEqual(r, { ok: false, skipped: 'quiet' });
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    assert.equal(fired.length, 0);
  });
});

await test('半夜那次不占白天额度：20:00 起步的一天仍是 2 白天 + 1 半夜，次日照样 6 白天 + 1 半夜', async () => {
  await withOwnLife(async ({ ol, fired }) => {
    await runMinutes(ol, at(2026, 10, 30, 20, 0), at(2026, 10, 30, 23, 59));
    assert.deepEqual(fired.map((f) => `${hm(f.meta.at)} ${f.meta.kind}`), ['20:00 day', '22:30 day', '23:30 midnight']);
    const snap = ol.snapshot();
    assert.equal(snap.firedToday, 2, '半夜那次没有让白天计数 +1');
    assert.equal(snap.midnightDoneToday, true);
    await runMinutes(ol, at(2026, 10, 31, 8, 0), at(2026, 10, 31, 23, 59));
    const next = fired.slice(3);
    assert.deepEqual(next.map((f) => hm(f.meta.at)), DAY_TIMES);
    assert.equal(next.filter((f) => f.meta.kind === 'day').length, 6);
  });
});

await test('按活动日归零：00:00～02:59 不会重置白天计数，也不会再发一次半夜', async () => {
  await withOwnLife(async ({ ol, fired }) => {
    await runMinutes(ol, at(2026, 10, 30, 8, 0), at(2026, 10, 30, 23, 31));
    const before = fired.length;
    assert.equal(before, 7);
    await runMinutes(ol, at(2026, 10, 31, 0, 0), at(2026, 10, 31, 2, 59));
    assert.equal(fired.length, before, '00:00～02:59 属于前一个活动日，什么都不发');
    assert.equal(ol.snapshot().activityDay, '2026-10-30');
  });
});

await test('旧状态文件直接读：lastDay / firedToday / lastFiredAt 照旧生效，不迁移', async () => {
  await withOwnLife(async ({ ol, fired, statePath }) => {
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).firedToday, 3, '旧字段原样留在文件里');
    await ol.tick(at(2026, 10, 30, 10, 31)); // 距 08:00 已经超过 2.5h
    assert.equal(fired.length, 1);
    assert.equal(ol.snapshot().firedToday, 4, '在旧计数 3 的基础上 +1');
  }, { state: { lastFiredAt: at(2026, 10, 30, 8, 0), lastDay: '2026-10-30', firedToday: 3, lastMidnightDay: '' } });
});

await test('snapshot 新字段：activityDay / midnightDoneToday / nextDayFireAt', async () => {
  await withOwnLife(async ({ ol }) => {
    await ol.tick(at(2026, 10, 30, 8, 0));
    let snap = ol.snapshot();
    assert.equal(snap.activityDay, '2026-10-30');
    assert.equal(snap.midnightDoneToday, false);
    assert.equal(snap.nextDayFireAt, at(2026, 10, 30, 10, 30));
    await runMinutes(ol, at(2026, 10, 30, 8, 1), at(2026, 10, 30, 23, 31));
    snap = ol.snapshot();
    assert.equal(snap.midnightDoneToday, true);
    assert.equal(snap.nextDayFireAt, null, '已过 midnightAt：今天没有白天那几次了');
  });

  await withOwnLife(async ({ ol }) => {
    // 白天次数满了（20:30 之后），也不再有下一次。
    await runMinutes(ol, at(2026, 10, 30, 8, 0), at(2026, 10, 30, 21, 0));
    assert.equal(ol.snapshot().firedToday, 6);
    assert.equal(ol.snapshot().nextDayFireAt, null);
  });

  await withOwnLife(async ({ ol }) => {
    // 早上第一次之前：下一次就是 quiet[1]:00。
    await ol.tick(at(2026, 10, 30, 7, 59));
    assert.equal(ol.snapshot().nextDayFireAt, at(2026, 10, 30, 8, 0));
  });
});

await test('安静时段配置不合法（quiet[0] >= quiet[1]）：记一行日志、回退 3:00–8:00', async () => {
  await withOwnLife(async ({ ol, logs }) => {
    assert.deepEqual(ol.snapshot().quiet, [3, 8]);
    assert.match(logs.join('\n'), /安静时段配置不合法/);
    // 回退后半夜窗口仍然是 23:30 起：23:30 发那次。
    await runMinutes(ol, at(2026, 10, 30, 23, 29), at(2026, 10, 30, 23, 30));
    assert.equal(ol.snapshot().midnightDoneToday, true);
  }, { opts: { quiet: [8, 3] } });
});

await test('投递失败不记账，下一分钟还会重试', async () => {
  await withOwnLife(async ({ ol, fired, logs }) => {
    let r = await ol.tick(at(2026, 10, 30, 8, 0));
    assert.equal(r.ok, false);
    assert.match(logs.join('\n'), /投递失败/);
    assert.equal(ol.snapshot().firedToday, 0);
    await ol.tick(at(2026, 10, 30, 8, 1));
    assert.equal(fired.length, 1);
    assert.equal(ol.snapshot().firedToday, 1);
  }, { failFirst: 1 });
});

await test('fireNow / fireMidnightNow 也带 meta', async () => {
  await withOwnLife(async ({ ol, fired }) => {
    await ol.fireMidnightNow();
    assert.equal(fired[0].meta.kind, 'midnight');
    assert.equal(fired[0].meta.remainingSlots, 1);
    await ol.fireNow();
    assert.equal(fired[1].meta.kind, 'day');
    assert.ok(fired[1].meta.remainingSlots >= 1);
  });
});

await test('state 没给 statePath 时不报错（只在内存里记）', async () => {
  const fired = [];
  const ol = createOwnLife({ key: 'private:2001', deliver: async (text, meta) => { fired.push(meta); }, log: () => {} });
  try {
    await ol.tick(at(2026, 10, 30, 8, 0));
    assert.equal(fired.length, 1);
    assert.equal(ol.snapshot().firedToday, 1);
  } finally { ol.stop(); }
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
