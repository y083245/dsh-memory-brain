// src/long-memory.js search() 的单测（RAG P1 任务 B）。
//
// 全部用临时目录 + 自己编的合成消息，不碰 state/ 里的真实存档。
// 重点钉住降级检索的新行为：部分命中、按命中词数与词长打分、中文长句切片、
// browse 兼容旧行为、上下文去重、maxChars 整组截断、debug.hits 的相对路径与行号、会话隔离。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLongMemory } from '../src/long-memory.js';

let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

/** 建一个临时 stateDir，跑完删掉。 */
async function withMemory(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-search-'));
  const lm = createLongMemory({ stateDir: dir });
  try { await run(lm, dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** 灌一批合成消息。at 用本地时间字符串，输出里的日期时间就是它。 */
function seed(lm, key, rows) {
  for (const r of rows) {
    lm.archive(key, {
      dir: r.dir ?? 'in',
      name: r.name ?? '阿明',
      userId: r.userId ?? '2001',
      text: r.text,
      at: r.at
    });
  }
}

// 主语料：故意让「公园」和「相机」没有任何一条消息同时包含（旧实现「全部命中」会返回 0 条），
// 「今天」是高频词，「图书馆」「长期记忆」「向量检索」是有区分度的词。
const MAIN = [
  { at: '2026-03-01T10:00:00', name: '阿明', userId: '2001', text: '明天我们去公园散步吗' },
  { at: '2026-03-01T10:01:00', name: '阿明', userId: '2001', text: '公园东门的樱花开了' },
  { at: '2026-03-01T10:02:00', dir: 'out', name: '', userId: null, text: '好呀我带相机去' },
  { at: '2026-03-01T10:03:00', name: '小美', userId: '2002', text: '今天图书馆人很多' },
  { at: '2026-03-01T10:04:00', name: '小美', userId: '2002', text: '今天下雨了' },
  { at: '2026-03-01T10:05:00', name: '小美', userId: '2002', text: '今天风很大' },
  { at: '2026-03-01T10:06:00', name: '阿明', userId: '2001', text: '今天讨论长期记忆方案' },
  { at: '2026-03-01T10:07:00', name: '阿明', userId: '2001', text: '长期记忆需要向量检索' },
  { at: '2026-04-02T09:00:00', name: '小美', userId: '2002', text: '四月去爬山吧' },
  { at: '2026-04-02T09:01:00', dir: 'out', name: '', userId: null, text: '爬山记得带水' },
  { at: '2026-03-01T10:08:00', name: '小美', userId: '2002', text: '图书馆闭馆了' }
];

const KEY = 'private:1001';

// ── 部分命中：旧实现要求所有词都出现，这里一条都不会返回 ────────────────────
await test('部分命中也能找到（旧「全部命中」会返回 0 条）', async () => {
  await withMemory(async (lm) => {
    seed(lm, KEY, MAIN);
    const r = lm.search(KEY, { query: '公园 相机' });
    assert.equal(r.mode, 'scored');
    assert.ok(r.matched >= 2, `应至少命中 2 条，实际 ${r.matched}`);
    assert.ok(r.lines.some((l) => l.includes('公园')), '命中「公园」的消息要在结果里');
    assert.ok(r.lines.some((l) => l.includes('相机')), '命中「相机」的消息要在结果里');
    // 没有任何一条同时包含两个词 —— 正好是旧实现会全部丢弃的形态
    assert.ok(!r.lines.some((l) => l.includes('公园') && l.includes('相机')));
  });
});

// ── 排序：命中词多/词长优先，高频词压不过有区分度的词 ─────────────────────
await test('命中词多、词长的排在前面；高频词不压过有区分度的词', async () => {
  await withMemory(async (lm) => {
    seed(lm, KEY, MAIN);

    // 两个词都命中的一条（长期记忆 + 向量检索）必须排第一
    const both = lm.search(KEY, { query: '长期记忆 向量检索', context: 0 });
    assert.ok(both.lines[0].includes('长期记忆需要向量检索'), `排第一的应是同时命中两个词的：\n${both.lines.join('\n')}`);
    assert.ok(both.lines[1].includes('长期记忆'), '只命中长词的排第二');

    // 「今天」在 4 条里出现，「图书馆」只出现 2 次；
    // 只命中图书馆的消息应排在只命中今天的前面。
    const r = lm.search(KEY, { query: '今天 图书馆', context: 0 });
    const top = r.lines[0];
    assert.ok(top.includes('今天图书馆人很多'), `两个词都命中的应排第一：\n${r.lines.join('\n')}`);
    const posLib = r.lines.findIndex((l) => l.includes('图书馆闭馆了'));
    const posToday = r.lines.findIndex((l) => l.includes('今天下雨了'));
    assert.ok(posLib >= 0 && posToday >= 0, `两类消息都应出现：\n${r.lines.join('\n')}`);
    assert.ok(posLib < posToday, `稀有词「图书馆」应压过高频词「今天」（${posLib} vs ${posToday}）`);
  });
});

// ── 一整句中文 query：切成 2～3 字片段后才能命中 ──────────────────────────
await test('整句中文 query 通过切片命中（没有 keywords）', async () => {
  await withMemory(async (lm) => {
    seed(lm, KEY, MAIN);
    const r = lm.search(KEY, { query: '他说过长期记忆要怎么做才好', context: 0 });
    assert.equal(r.mode, 'scored');
    assert.ok(r.matched >= 1, '整句应当能通过切片命中');
    const top3 = r.lines.slice(0, 3).join('\n');
    assert.ok(top3.includes('长期记忆'), `切片命中的应是讲长期记忆的消息：\n${r.lines.join('\n')}`);
  });
});

// ── keywords 数组 / 空格字符串 / 顿号字符串都等价 ─────────────────────────
await test('keywords 支持数组与字符串两种传法', async () => {
  await withMemory(async (lm) => {
    seed(lm, KEY, MAIN);
    const arr = lm.search(KEY, { keywords: ['公园', '相机'], context: 0 });
    const space = lm.search(KEY, { keywords: '公园 相机', context: 0 });
    const comma = lm.search(KEY, { keywords: '公园，相机', context: 0 });
    assert.ok(arr.matched > 0);
    assert.deepEqual(space.lines, arr.lines);
    assert.deepEqual(comma.lines, arr.lines);
    // 与旧调用把词塞进 query 的结果一致
    const viaQuery = lm.search(KEY, { query: '公园 相机', context: 0 });
    assert.deepEqual(viaQuery.lines, arr.lines);
  });
});

// ── browse：没有检索词时保持旧行为 ───────────────────────────────────────
await test('browse 模式：无检索词时从新到旧取 limit 条，按时间正序输出', async () => {
  await withMemory(async (lm) => {
    seed(lm, KEY, MAIN);

    const all = lm.search(KEY, {});
    assert.equal(all.mode, 'browse');
    assert.equal(all.total, MAIN.length);
    assert.equal(all.matched, MAIN.length); // 没有检索词 → 过滤后全部算命中（受 limit 30 限制）
    assert.equal(all.lines.length, MAIN.length);
    // 输出是时间正序：4 月的两条最后
    assert.ok(all.lines[0].startsWith('2026-03-01 10:00'));
    assert.ok(all.lines.at(-1).includes('爬山记得带水'));

    // 从新到旧取 2 条 → 4 月的两条，再按时间正序输出
    const newest2 = lm.search(KEY, { limit: 2 });
    assert.equal(newest2.matched, 2);
    assert.equal(newest2.lines.length, 2);
    assert.ok(newest2.lines[0].includes('四月去爬山吧'));
    assert.ok(newest2.lines[1].includes('爬山记得带水'));

    // 按日期翻页
    const apr = lm.search(KEY, { from: '2026-04-01', to: '2026-04-30' });
    assert.equal(apr.matched, 2);
    assert.ok(apr.lines[0].includes('四月去爬山吧'));
    const mar = lm.search(KEY, { to: '2026-03-31' });
    assert.equal(mar.matched, MAIN.length - 2, '3 月的消息都应被翻到');

    // 没有检索词但有 date 也没有关键词 → 仍然是 browse
    assert.equal(lm.search(KEY, { keywords: [] }).mode, 'browse');
  });
});

// ── from/to 与 speaker（名字 / QQ 号 / 「我」） ─────────────────────────────
await test('from/to 与 speaker 过滤（含「我」）', async () => {
  await withMemory(async (lm) => {
    seed(lm, KEY, MAIN);

    const scoped = lm.search(KEY, { query: '今天', from: '2026-03-01', to: '2026-03-01' });
    assert.equal(scoped.mode, 'scored');
    assert.equal(scoped.matched, 4, '3 月 1 日命中「今天」的正好 4 条');

    const byName = lm.search(KEY, { query: '今天', speaker: '小美' });
    assert.equal(byName.matched, 3);
    assert.ok(byName.lines.every((l) => l.includes('小美')));

    const byQQ = lm.search(KEY, { query: '今天', speaker: '2001' });
    assert.equal(byQQ.matched, 1, '2001 是阿明，只说过一条「今天…」');

    const me = lm.search(KEY, { query: '爬山 相机', speaker: '我' });
    assert.equal(me.matched, 2);
    assert.ok(me.lines.every((l) => l.includes('我：')));
    assert.ok(me.lines.some((l) => l.includes('相机')) && me.lines.some((l) => l.includes('爬山')));

    // 日期范围与说话人一起用
    const odd = lm.search(KEY, { query: '今天', from: '2026-04-01', speaker: '小美' });
    assert.equal(odd.matched, 0, '4 月里没有「今天」');
  });
});

// ── limit / context / 上下文去重 / 「……」分隔 ───────────────────────────
await test('limit、context、上下文去重与「……」分隔', async () => {
  await withMemory(async (lm) => {
    seed(lm, KEY, MAIN);
    // 排名：「图书馆」命中的两条（词长 3）在前，「公园」命中的两条（词长 2）在后
    const r = lm.search(KEY, { query: '公园 图书馆', context: 1, limit: 4 });
    assert.equal(r.mode, 'scored');
    const seps = r.lines.filter((l) => l === '……').length;
    assert.ok(seps >= 2, `不相邻的命中组之间要用「……」分隔，实际 ${seps} 个：\n${r.lines.join('\n')}`);
    const messages = r.lines.filter((l) => l !== '……');
    assert.equal(new Set(messages).size, messages.length, '同一行不能重复输出');
    // 每条命中前后各扩一条：图书馆闭馆了 前面是 长期记忆需要向量检索
    assert.ok(messages.some((l) => l.includes('长期记忆需要向量检索')), `上下文应被带出：\n${r.lines.join('\n')}`);

    const one = lm.search(KEY, { query: '公园 图书馆', limit: 1 });
    assert.equal(one.lines.length, 1, 'limit 限制的是命中组数');
    assert.ok(one.matched > 1, 'matched 统计的是截断前的命中总数');
  });
});

// ── maxChars：从排名最低的命中开始整组丢；单条超长截断 ────────────────────
await test('maxChars 整组丢弃排名最低的命中，单条超过 300 字加「…」', async () => {
  await withMemory(async (lm) => {
    const key = 'group:2002';
    const rowText = (i) => `编号${i}${'啊'.repeat(190)}关键词`;
    for (let i = 0; i < 8; i += 1) {
      lm.archive(key, {
        dir: 'in', name: '群友', userId: '3001', text: rowText(i),
        at: `2026-03-01T10:0${i}:00`
      });
    }
    const r = lm.search(key, { query: '关键词', limit: 8, maxChars: 700, context: 0 });
    assert.equal(r.matched, 8, 'matched 是截断前的命中总数');
    assert.equal(r.lines.length, 3, `700 字只装得下 3 条（实际 ${r.lines.length}）：\n${r.lines.map((l) => l.length).join(',')}`);
    // 分数相同 → 新的在前，所以保留的是最新 3 条
    assert.ok(r.lines[0].includes('编号7'), '保留的应是排名最高的（最新）几条');
    assert.ok(r.lines[1].includes('编号6'));
    assert.ok(r.lines[2].includes('编号5'));

    // 单条消息超过 300 字：按码点截断并加「…」
    const longKey = 'private:3003';
    lm.archive(longKey, { dir: 'in', name: '阿明', userId: '2001', text: `${'长'.repeat(400)}尾巴`, at: '2026-03-01T10:00:00' });
    const lr = lm.search(longKey, { query: '长' });
    assert.equal(lr.matched, 1);
    const shown = lr.lines[0].slice(lr.lines[0].indexOf('：') + 1);
    assert.ok(shown.endsWith('…'), '超长消息要以「…」结尾');
    assert.equal([...shown].length, 301, `显示的应是 300 字 + 一个「…」，实际 ${[...shown].length}`);
    assert.ok(!lr.lines[0].includes('尾巴'), '截断后的内容不应包含尾巴');
  });
});

// ── debug.hits：相对路径 + 1 起行号（空行也占行号） ────────────────────────
await test('debug.hits 返回存档相对路径与 1 起行号（含空行）', async () => {
  await withMemory(async (lm, dir) => {
    const key = 'private:1001';
    seed(lm, key, [
      { at: '2026-03-01T10:00:00', text: '第一条消息' },
      { at: '2026-03-01T10:01:00', text: '第二条消息' }
    ]);
    // 直接往文件尾部插一个空行：空行、坏行也要占行号
    const file = path.join(dir, 'archive', 'private_1001', '2026-03.jsonl');
    fs.appendFileSync(file, '\n');
    seed(lm, key, [{ at: '2026-03-01T10:02:00', text: '蟋蟀在草丛里叫' }]);

    const r = lm.search(key, { query: '蟋蟀', debug: true });
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].file, 'private_1001/2026-03.jsonl', 'file 必须是相对存档目录的路径');
    assert.ok(!path.isAbsolute(r.hits[0].file) && !r.hits[0].file.startsWith('/'), 'file 不能是绝对路径');
    assert.equal(r.hits[0].line, 4, '空行占行号，第三条消息在第 4 行');
    assert.equal(typeof r.hits[0].score, 'number');
    assert.ok(r.hits[0].score > 0);

    // 不开 debug 时不返回 hits
    assert.equal(lm.search(key, { query: '蟋蟀' }).hits, undefined);
  });
});

// ── 会话隔离 ────────────────────────────────────────────────────────────
await test('两个会话的存档互不可见', async () => {
  await withMemory(async (lm) => {
    lm.archive('private:1001', { dir: 'in', name: '阿明', userId: '2001', text: '秘密花园里有一条鱼', at: '2026-03-01T10:00:00' });
    lm.archive('group:2002', { dir: 'in', name: '群友', userId: '3001', text: '公开的鱼塘', at: '2026-03-01T10:00:00' });

    const priv = lm.search('private:1001', { query: '秘密花园' });
    const group = lm.search('group:2002', { query: '秘密花园' });
    assert.ok(priv.matched >= 1, '私聊自己能搜到');
    assert.equal(group.matched, 0, '群聊搜不到私聊内容');
    assert.equal(priv.total, 1);
    assert.equal(group.total, 1);

    // 非法 key 仍然直接拒绝
    assert.throws(() => lm.search('not-a-key', { query: '鱼' }), /会话 key 不合法/);
  });
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
