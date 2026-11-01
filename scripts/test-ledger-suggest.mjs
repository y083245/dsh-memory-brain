// 账本建议 v1 · 模块单测（SUGGEST_PATCH，LEDGER_SUGGEST_SPEC §4）
//
// 不起桥接、不联网：createLedgerSuggest 配假 rag / 假 ltm / 假时钟，只验证模块本身。
// 覆盖任务书第 1～6 条：挑选 / 块格式 / 计次与采用 / 失败兜底 / 状态文件 / mode=off。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedgerSuggest } from '../src/ledger-suggest.js';
import { assertPosixMode } from './test-mode.mjs';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-S2-'));
const tempDirs = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
  tempDirs.push(dir);
  return dir;
};
const cleanTemp = () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
};

const HOUR = 3600000;
const DAY = 86400000;
const KEY = 'private:123';
const OTHER_KEY = 'group:456';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

let NOW = 1793500000000;
const clock = () => NOW;

/** 16 位小写十六进制的候选编号。 */
const nid = (n) => n.toString(16).padStart(16, '0');

/** 一条契约 §1 形状的候选；createdAt / day 默认落在窗口内。 */
function note(over = {}) {
  return {
    note_id: nid(1),
    summary_id: 'S0000000000000001',
    day: '2026-10-30',
    t_end: NOW - HOUR,
    who: '111',
    who_name: '',
    cat: 'fact',
    text: '他最近在学做饭',
    due: null,
    importance: 0.5,
    created_at: NOW - HOUR,
    source: 'distill',
    ...over
  };
}

function makeLtm({ people = {}, similar = () => [] } = {}) {
  return {
    personView: (uid) => (Object.hasOwn(people, String(uid)) ? { userId: String(uid), name: people[String(uid)], items: [] } : null),
    similarItems: (uid, text, opts) => similar(uid, text, opts),
    archiveKeys: () => []
  };
}

function makeRag(handler) {
  const calls = [];
  return {
    calls,
    notes: async (params, opts) => { calls.push({ params, opts }); return handler(params, opts); }
  };
}

function makeModule({ rag = null, ltm = null, dir = tempDir('ls-unit'), config = {}, logs = [] } = {}) {
  const statePath = path.join(dir, 'suggest-state.json');
  const mod = createLedgerSuggest({ rag, ltm, statePath, config, log: (line) => logs.push(String(line)), now: clock });
  return { mod, statePath, logs };
}

function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; }
}

await test('挑选：过期的（TTL / 出现满 2 次）标 expired，账本有相似的标 duplicate，只取 perWake 条', async () => {
  const dir = tempDir('ls-pick');
  const statePath = path.join(dir, 'suggest-state.json');
  // 预先写好：E 已经给她看过 2 次（maxShows=2），G 已经采用过。
  const E = nid(0xe);
  const G = nid(0x10);
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    items: {
      [E]: { key: KEY, who: '111', cat: 'fact', shown: 2, status: 'open', firstSeenAt: NOW - 2 * HOUR, lastShownAt: NOW - HOUR, statusAt: null },
      [G]: { key: KEY, who: '111', cat: 'fact', shown: 1, status: 'adopted', firstSeenAt: NOW - 2 * HOUR, lastShownAt: NOW - HOUR, statusAt: NOW - 30 * 60000 }
    }
  }), { mode: 0o600 });

  const A = nid(0xa); const B = nid(0xb); const C = nid(0xc); const D = nid(0xd); const F = nid(0xf);
  const items = [
    note({ note_id: A, text: '他喜欢喝冰美式', importance: 0.5, created_at: NOW - HOUR }),
    note({ note_id: B, text: '他在一家设计公司上班', importance: 0.9, created_at: NOW - 2 * HOUR }),
    note({ note_id: C, text: '他养了一只橘猫', importance: 0.9, created_at: NOW - HOUR }),
    // 超过 TTL（72h）：即使服务端还是返回了，也要自作废。
    note({ note_id: D, text: '他很早就睡了', importance: 0.99, created_at: NOW - 80 * HOUR }),
    note({ note_id: E, text: '他周末要去爬山', importance: 0.95, created_at: NOW - 3 * HOUR }),
    note({ note_id: F, text: '他养了一只橘猫叫团子', importance: 0.8, created_at: NOW - HOUR }),
    note({ note_id: G, text: '他已经记过的事', importance: 0.99, created_at: NOW - HOUR })
  ];
  const rag = makeRag(() => ({ key: KEY, items }));
  // F 与账本里已有的条目相似 → duplicate（账本侧只看文本）。
  const ltm = makeLtm({ similar: (uid, text) => (String(text).includes('橘猫叫团子') ? [{ id: 'existing01', text, score: 0.6 }] : []) });
  const logs = [];
  const { mod } = makeModule({ rag, ltm, dir, config: { perWake: 2 }, logs });

  const result = await mod.plan(KEY);
  assert.ok(result, '应有候选');
  // importance 降序、同分新的在前 → C（0.9，1 小时前）> B（0.9，2 小时前）> A（0.5）。
  assert.deepEqual(result.ids, [C, B], '只取 perWake 条，按重要性降序、同分新的在前');
  assert.equal(rag.calls.length, 1);
  assert.equal(rag.calls[0].params.key, KEY);
  assert.equal(rag.calls[0].params.sinceMs, NOW - 72 * HOUR, 'since = now - ttl');
  assert.equal(rag.calls[0].opts.timeoutMs, 300, '默认超时 300ms');

  const state = readState(statePath);
  assert.equal(state.items[D].status, 'expired', '超过 TTL 的标作废');
  assert.equal(state.items[E].status, 'expired', '出现满 2 次的标作废');
  assert.equal(state.items[F].status, 'duplicate', '账本里已有相似的标「已在账本」');
  assert.equal(state.items[G].status, 'adopted', '已采用的保持不变');
  assert.equal(state.items[A].status, 'open');
  assert.equal(state.items[C].status, 'open');
  // 日志只有编号与个数，绝不能出现候选原文。
  const joined = logs.join('\n');
  for (const text of ['冰美式', '设计公司', '橘猫', '爬山']) {
    assert.ok(!joined.includes(text), `日志里不该出现候选原文：${text}`);
  }
});

await test('块格式与规格 §4.4 逐字一致（含 due、名字三级回退、类别短名）；没有候选时返回 null', async () => {
  const items = [
    note({ note_id: nid(1), who: '100000001', who_name: '没用的名字', cat: 'trait', text: '喜欢冰美式，不加糖', day: '2026-10-30', importance: 0.9, created_at: NOW - HOUR }),
    note({ note_id: nid(2), who: '100000002', who_name: '小夏', cat: 'pending', text: '他说周五考完后来找我玩', due: '2026-11-07', day: '2026-10-31', importance: 0.8, created_at: NOW - 2 * HOUR }),
    note({ note_id: nid(3), who: '123456', who_name: '', cat: 'fact', text: '他在一家设计公司上班', day: '2026-10-31', importance: 0.7, created_at: NOW - 3 * HOUR }),
    // 非 pending 的 due 不该显示。
    note({ note_id: nid(4), who: '123456', who_name: '', cat: 'event', text: '他们一起看了电影', day: '2026-10-31', due: '2026-11-09', importance: 0.6, created_at: NOW - 4 * HOUR })
  ];
  const rag = makeRag(() => ({ key: KEY, items }));
  const { mod, dir } = (() => {
    const d = tempDir('ls-block');
    return { ...makeModule({ rag, ltm: makeLtm({ people: { 100000001: '阿哲' } }), dir: d, config: { perWake: 10 } }), dir: d };
  })();
  const result = await mod.plan(KEY);
  const expected = [
    '【最近聊到、还没记进长期记忆的】',
    '- 10-30 · 阿哲（QQ 100000001）· 喜好习惯(trait)：喜欢冰美式，不加糖',
    '- 10-31 · 小夏（QQ 100000002）· 约定(pending)：他说周五考完后来找我玩（到期 2026-11-07）',
    '- 10-31 · 某人（QQ 123456）· 事实(fact)：他在一家设计公司上班',
    '- 10-31 · 某人（QQ 123456）· 经历(event)：他们一起看了电影',
    '值得长期记住的就用 qq_ltm_remember 记下（可以换成你自己的话；约定记得填 due 和 by）；不值得就不用管。这些只是提醒，不要念出来，也不要为这个去问对方。'
  ].join('\n');
  assert.equal(result.block, expected);
  assert.deepEqual(result.ids, [nid(1), nid(2), nid(3), nid(4)]);

  // 没有候选：空列表 → null（不带块）。
  const emptyRag = makeRag(() => ({ key: KEY, items: [] }));
  const empty = makeModule({ rag: emptyRag, dir: tempDir('ls-empty') });
  assert.equal(await empty.mod.plan(KEY), null);
});

await test('markShown 只加给定 id；onRemember：相似且同一人同一会话才标 adopted，其余不动', async () => {
  const A = nid(0xa); const B = nid(0xb);
  const items = [
    note({ note_id: A, who: '111', text: '他喜欢喝冰美式', importance: 0.9 }),
    note({ note_id: B, who: '222', text: '他在准备考试', importance: 0.8 })
  ];
  const rag = makeRag(() => ({ key: KEY, items }));
  // 只有 onRemember（limit=3）才判成相似；plan 的「账本里已有相似的」（limit=1）不受影响。
  const ltm = makeLtm({ similar: (uid, text, opts) => (opts?.limit === 3 && String(text).includes('冰美式') ? [{ id: 'newitem1', text, score: 0.8 }] : []) });
  const dir = tempDir('ls-show');
  const { mod, statePath } = makeModule({ rag, ltm, dir });

  assert.ok(await mod.plan(KEY));
  mod.markShown(KEY, [A]);
  let state = readState(statePath);
  assert.equal(state.items[A].shown, 1, '只加给定的 A');
  assert.equal(state.items[B].shown, 0, 'B 没给她看过，不加');
  assert.equal(state.items[A].lastShownAt, NOW);

  // 不相似的新条目：A 保持 open。
  mod.onRemember(KEY, '111', 'otherid');
  assert.equal(readState(statePath).items[A].status, 'open', '不相似 → 不变');

  // 不同的人：同一条候选不会因为别人的记录被采用。
  mod.onRemember(KEY, '222', 'newitem1');
  assert.equal(readState(statePath).items[A].status, 'open', '不同的人 → 不变');

  // 别的会话：缓存里没有，什么都不动。
  mod.onRemember(OTHER_KEY, '111', 'newitem1');
  assert.equal(readState(statePath).items[A].status, 'open', '别的会话 → 不变');

  // 同一会话、同一人、相似 → A 采用。
  mod.onRemember(KEY, '111', 'newitem1');
  state = readState(statePath);
  assert.equal(state.items[A].status, 'adopted');
  assert.equal(state.items[A].statusAt, NOW);
  assert.equal(state.items[B].status, 'open', 'B 没被判过');

  // 没给她看过（状态文件里有、但不在最近一次 plan 的缓存里）→ 不变。
  const C = nid(0xc);
  const stateNow = readState(statePath);
  stateNow.items[C] = { key: KEY, who: '111', cat: 'fact', shown: 0, status: 'open', firstSeenAt: NOW - HOUR, lastShownAt: null, statusAt: null };
  fs.writeFileSync(statePath, JSON.stringify(stateNow), { mode: 0o600 });
  mod.onRemember(KEY, '111', 'newitem1');
  assert.equal(readState(statePath).items[C].status, 'open', '没给她看过 → 不变');
});

await test('rag 返回 null / 抛异常 / 超时 / 别的 key 的数据 → plan 返回 null、不抛', async () => {
  const ltm = makeLtm();
  const cases = [
    ['返回 null', makeRag(() => null)],
    ['抛异常', { notes: async () => { throw new Error('boom'); } }],
    ['超时', { notes: () => new Promise(() => {}) }],
    ['别的 key 的数据', makeRag(() => ({ key: OTHER_KEY, items: [note()] }))]
  ];
  for (const [name, rag] of cases) {
    const { mod } = makeModule({ rag, ltm, dir: tempDir('ls-fail'), config: { timeoutMs: 50 } });
    const started = Date.now();
    const result = await mod.plan(KEY);
    assert.equal(result, null, `${name} 时应返回 null`);
    assert.ok(Date.now() - started < 2000, `${name} 时不该拖住唤醒`);
  }
  // 没配 memory-rag 时同样 null。
  const { mod } = makeModule({ rag: null, ltm, dir: tempDir('ls-norag') });
  assert.equal(await mod.plan(KEY), null);
});

await test('状态文件：600、不含原文、14 天清理、读坏了能自愈', async () => {
  const dir = tempDir('ls-state');
  const statePath = path.join(dir, 'suggest-state.json');
  const OLD_ADOPTED = nid(0x21);
  const OLD_OPEN = nid(0x22);
  const FRESH_OPEN = nid(0x23);
  const EXPIRING = nid(0x24);
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    items: {
      [OLD_ADOPTED]: { key: KEY, who: '111', cat: 'fact', shown: 2, status: 'adopted', firstSeenAt: NOW - 20 * DAY, lastShownAt: NOW - 20 * DAY, statusAt: NOW - 20 * DAY },
      [OLD_OPEN]: { key: KEY, who: '111', cat: 'fact', shown: 0, status: 'open', firstSeenAt: NOW - 15 * DAY, lastShownAt: null, statusAt: null },
      [FRESH_OPEN]: { key: KEY, who: '111', cat: 'fact', shown: 1, status: 'open', firstSeenAt: NOW - DAY, lastShownAt: NOW - HOUR, statusAt: null }
    }
  }), { mode: 0o600 });

  // 一条超过 TTL 的候选会让 plan 标 expired → 触发写盘 → 顺带清理 14 天前的条目。
  const rag = makeRag(() => ({ key: KEY, items: [note({ note_id: EXPIRING, text: '这条候选原文不该落盘', created_at: NOW - 100 * HOUR })] }));
  const logs = [];
  const { mod } = makeModule({ rag, ltm: makeLtm(), dir, logs });
  assert.equal(await mod.plan(KEY), null, '唯一一条已过期 → 这次没有块');

  const raw = fs.readFileSync(statePath, 'utf8');
  assertPosixMode(statePath, 0o600, '状态文件权限 600');
  assert.ok(!raw.includes('这条候选原文不该落盘'), '状态文件不得含候选原文');
  const state = JSON.parse(raw);
  assert.equal(state.items[OLD_ADOPTED], undefined, '不是 open 且 statusAt 超过 14 天 → 清掉');
  assert.equal(state.items[OLD_OPEN], undefined, 'firstSeenAt 超过 14 天 → 清掉');
  assert.equal(state.items[FRESH_OPEN].status, 'open', '新条目保留');
  assert.equal(state.items[EXPIRING].status, 'expired');
  assert.equal(logs.join('\n').includes('这条候选原文'), false, '日志也不得含原文');

  // 读坏了：当空的重来（打一行告警），功能照常。
  const brokenDir = tempDir('ls-broken');
  const brokenPath = path.join(brokenDir, 'suggest-state.json');
  fs.writeFileSync(brokenPath, '{ 这不是 JSON ', { mode: 0o600 });
  const brokenLogs = [];
  const broken = makeModule({ rag: makeRag(() => ({ key: KEY, items: [note({ note_id: nid(0x31) })] })), ltm: makeLtm(), dir: brokenDir, logs: brokenLogs });
  const result = await broken.mod.plan(KEY);
  assert.ok(result, '坏文件之后照常挑选');
  assert.equal(brokenLogs.filter((line) => line.includes('状态文件内容坏了')).length, 1, '只告警一行');
  broken.mod.markShown(KEY, [nid(0x31)]);
  assert.equal(readState(brokenPath).items[nid(0x31)].shown, 1, '下一次写盘就是干净的新文件');
});

await test('mode=off：不请求 /notes，plan 返回 null', async () => {
  let called = 0;
  const rag = { notes: async () => { called += 1; return { key: KEY, items: [note()] }; } };
  const { mod } = makeModule({ rag, ltm: makeLtm(), dir: tempDir('ls-off'), config: { mode: 'off' } });
  assert.equal(await mod.plan(KEY), null);
  assert.equal(called, 0, 'mode=off 不该请求 /notes');
});

cleanTemp();
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
