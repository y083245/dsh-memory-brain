// 实时脑图回放模块（BRAIN_PATCH，src/brain-replay.js）的测试。
// 全部用临时目录（/tmp/worker-R/ 下）+ 合成数据 + 假 rag：不碰真实 state/、不联网。
// 存档 / 账本 / 判读日志直接调真实写入函数（long-memory.js、persona-store.js）造数据，
// 轨迹按约定 §6 的格式手写；其余（tool-calls、token-usage、影子日志、life-loop.json）
// 照 bridge.js / token-ledger.js / life-loop.js 的写法造行。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLongMemory } from '../src/long-memory.js';
import { createPersonaStore } from '../src/persona-store.js';
import { createBrainReplay } from '../src/brain-replay.js';

const TMP_ROOT = '/tmp/worker-R';
fs.mkdirSync(TMP_ROOT, { recursive: true });
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const NOW = Date.now(); // 账本 remember() 用真实时钟写 at，所以回放「今天」
const TODAY = ymd(NOW);
const d0 = new Date(NOW);
const DAY_START = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
const at = (h, m = 0, s = 0) => DAY_START + ((h * 60 + m) * 60 + s) * 1000;
const KEY = 'private:2001';
const KEY2 = 'group:3001';
const ROLE = '小鲸鱼';
const SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n');
}

function fakeRag(graph) {
  const calls = [];
  return { calls, async graph(arg) { calls.push(arg); return typeof graph === 'function' ? graph(arg) : graph; } };
}
const GRAPH = {
  ok: true,
  chunks: [{ chunk_id: 'c1', key: KEY, day: TODAY, t_start: 0, t_end: 0, title: '聊猫', n_msgs: 4, speakers: ['2001'], speaker_names: ['阿明'] }],
  summaries: [{ summary_id: 's1', chunk_id: 'c1', key: KEY, day: TODAY, title: '聊猫', summary: '阿明说家里的猫生病了', importance: 0.7, valence: -0.2 }],
  entities: [{ entity_id: 'e1', type: 'thing', name: '猫', qq: null, n: 1 }],
  summary_entities: [], relations: [],
  notes: [{ note_id: 'n1', summary_id: 's1', key: KEY, who: '2001', who_name: '阿明', cat: 'fact', text: '阿明养了一只橘猫', due: null, created_at: 0 }],
  truncated: {}
};

/** 造一整套状态目录：每种来源至少一条。返回 { stateDir, ltm, ids }。 */
function buildState(name) {
  const stateDir = fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
  const ltm = createLongMemory({ stateDir: path.join(stateDir, 'long-memory') });
  // 存档：两个会话，一条会被删（墓碑）
  ltm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: '我家猫生病了', msgId: '9001', at: at(9, 0) });
  ltm.archive(KEY, { dir: 'out', userId: '1000000009', name: '小肥鱼', text: '啊？严重吗', msgId: '9002', at: at(9, 1) });
  ltm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: '这条会被删掉的秘密消息', msgId: '9003', at: at(9, 2) });
  ltm.archive(KEY2, { dir: 'in', userId: '2002', name: '小红', text: '群里大家好', msgId: '9101', at: at(10, 0) });
  // 很长的一条，测截断
  ltm.archive(KEY, { dir: 'in', userId: '2001', name: '阿明', text: '长'.repeat(500), msgId: '9004', at: at(9, 3) });
  // 按行删（控制台的做法）：先列出来找那一条，再按 file / line / t 写墓碑
  const { rows } = ltm.listArchiveRows(KEY, { limit: 50 });
  const target = rows.find((r) => r.text === '这条会被删掉的秘密消息');
  assert.ok(target, '夹具：找不到要删的存档行');
  const r = ltm.deleteArchiveRows(KEY, { rows: [{ file: target.file, line: target.line, t: target.t }] });
  assert.equal(r.deleted, 1, '夹具：墓碑没写上');

  // 账本：一条留着、一条删掉
  const keep = ltm.remember({ userId: '2001', name: '阿明', cat: 'fact', text: '阿明养了一只橘猫', sourceKey: KEY }).item;
  const gone = ltm.remember({ userId: '2001', name: '阿明', cat: 'event', text: '这条账本会被删', sourceKey: KEY }).item;
  const promise = ltm.remember({ userId: '2001', name: '阿明', cat: 'pending', text: '今天陪阿明去宠物医院', sourceKey: KEY, due: TODAY }).item;
  ltm.forget({ userId: '2001', itemId: gone.id, viewerKey: KEY });
  ltm.flush();

  // 轨迹（约定 §6）
  const traceFile = path.join(stateDir, 'brain', 'trace', `${TODAY}.jsonl`);
  let id = 1;
  const tr = (o) => appendLine(traceFile, { id: id++, origin: 'ai', nodes: [], n: {}, e: {}, ...o });
  tr({ at: at(9, 0, 30), type: 'wake', key: KEY, origin: 'bridge', e: { reason: 'message' } });
  tr({ at: at(9, 0, 31), type: 'inject', key: KEY, origin: 'bridge', nodes: [`ltm:${keep.id}`], n: { chars: 120 }, e: { recall: true, suggest: false } });
  tr({ at: at(9, 5, 0), type: 'search', key: KEY, nodes: ['chunk:c1', 'sum:s1', 'sum:gone'], n: { ms: 182, items: 3 }, e: { src: 'rag', semantic: 'ok' } });
  tr({ at: at(9, 6, 0), type: 'recall', key: KEY, nodes: [`ltm:${keep.id}`, `ltm:${gone.id}`], n: { items: 2 } });
  tr({ at: at(9, 7, 0), type: 'remember', key: KEY, nodes: [`ltm:${gone.id}`] });
  tr({ at: at(9, 8, 0), type: 'decay.review', key: KEY, nodes: [`ltm:${keep.id}`], n: { R0: 0.8, R1: 1, S0: 3, S1: 9 }, e: { rating: 'hard' } });
  tr({ at: at(9, 9, 0), type: 'forget', key: KEY, nodes: [`ltm:${gone.id}`] });
  tr({ at: at(11, 0, 0), type: 'life.ownLife', key: null, origin: 'bridge', n: { remainingSlots: 4 }, e: { kind: 'day' } });
  tr({ at: at(11, 0, 5), type: 'life.assoc', key: null, origin: 'bridge', nodes: ['sum:s1', 'ent:e1'] });
  tr({ at: at(11, 30, 0), type: 'suggest.shown', key: KEY, origin: 'bridge', nodes: ['note:n1'] });
  tr({ at: at(11, 31, 0), type: 'suggest.adopted', key: KEY, origin: 'bridge', nodes: ['note:n1', `ltm:${keep.id}`] });
  tr({ at: at(12, 0, 0), type: 'tool', key: KEY, e: { tool: 'qq_get_message_images', status: 'ok' } });
  tr({ at: at(12, 0, 1), type: 'tool', key: KEY, e: { tool: 'qq_tts_voice', status: 'ok' } });
  tr({ at: at(12, 0, 2), type: 'tool', key: KEY, e: { tool: 'qq_memory_add', status: 'ok' } });
  tr({ at: at(12, 0, 3), type: 'tool', key: KEY, e: { tool: 'qq_send_message', status: 'ok' } });
  tr({ at: at(3, 0, 0), type: 'persona.nightly', key: null, origin: 'bridge' });
  tr({ at: at(13, 0, 0), type: 'rag.index', key: null, origin: 'bridge', n: { added: 2, total: 158 } });
  tr({ at: at(13, 0, 1), type: 'rag.distill', key: null, origin: 'bridge', n: { added: 1, total: 147 } });
  tr({ at: at(14, 0, 0), type: 'msg.in', key: KEY, origin: 'bridge' }); // 不该有，应被忽略

  // tool-calls.jsonl（appendToolLog 的形状；args 是 JSON 字符串，可能带 token）
  const tc = path.join(stateDir, 'tool-calls.jsonl');
  const iso = (ms) => new Date(ms).toISOString();
  appendLine(tc, { type: 'call', time: iso(at(0, 0, 1)), key: KEY, sessionId: 'sess-1', tool: 'mcp__snowluma__qq_send_message', args: JSON.stringify({ text: 'hi' }) });
  appendLine(tc, { type: 'call', time: iso(at(9, 4, 58)), key: KEY, sessionId: 'sess-1', tool: 'mcp__snowluma__qq_history_search',
    args: JSON.stringify({ query: '上次说猫怎么了', keywords: ['猫', SECRET], from: TODAY, to: TODAY, token: SECRET }), token: SECRET });
  appendLine(tc, { type: 'result', time: iso(at(9, 4, 59)), key: KEY, sessionId: 'sess-1', tool: 'mcp__snowluma__qq_history_search', ok: true, error: null });
  appendLine(tc, { type: 'call', time: iso(at(9, 5, 58)), key: KEY, sessionId: 'sess-1', tool: 'mcp__snowluma__qq_ltm_recall', args: JSON.stringify(JSON.stringify({ userId: '2001', query: '猫' })) });
  // 没配上轨迹的一次检索（比如脑图关着时）
  appendLine(tc, { type: 'call', time: iso(at(15, 0, 0)), key: KEY, sessionId: 'sess-1', tool: 'mcp__snowluma__qq_history_search', args: JSON.stringify({ query: '周末去哪', token: SECRET }) });

  // 影子日志（logRecallShadow 的形状）
  appendLine(path.join(stateDir, 'long-memory', 'recall-shadow', `${TODAY.slice(0, 7)}.jsonl`), {
    id: 'r-1', at: at(9, 0, 40), key: KEY, reason: 'message', mode: 'shadow', msgs: [{ t: at(9, 0), msgId: '9001' }],
    skipped: null, tau: 0.62, ms: 80, candidates: [{ summary_id: 's1', chunk_id: 'c1', day: TODAY, cosine: 0.71, signals: {}, pass: true }], inject: []
  });

  // 判读日志：用真实写入函数
  const pstore = createPersonaStore({ rootDir: path.join(stateDir, 'persona') });
  pstore.appendAppraisal(ROLE, KEY, { at: at(9, 0, 20), msgId: '9001', userId: '2001', target: 'other', kind: 'share', label: '担心', intensity: 0.6, salience: 0.8, source: 'model' });
  fs.writeFileSync(path.join(stateDir, 'persona', 'config.json'), JSON.stringify({ apiKey: SECRET, settings: { inject: true } }));

  // life-loop.json 的 history（life-loop.js 的三种形状）
  fs.writeFileSync(path.join(stateDir, 'life-loop.json'), JSON.stringify({
    version: 1, recall: {}, history: [
      { at: at(11, 0, 2), kind: 'recall', source: 'ltm', candId: `ltm:${keep.id}`, preview: '阿明养了一只橘猫' },
      { at: at(11, 0, 3), kind: 'recall', source: 'msg', candId: 'msg:9001', preview: '我家猫生病了' },
      { at: at(10, 0, 30), kind: 'promise-wake', userId: '2001', items: 1 },
      { at: DAY_START - 3600e3, kind: 'recall', source: 'diary', candId: 'diary:1', preview: '昨天的' }
    ]
  }, null, 2));

  // token-usage.jsonl（token-ledger 的 turn 行）
  const tu = path.join(stateDir, 'token-usage.jsonl');
  appendLine(tu, { k: 'turn', t: at(9, 0, 30), sid: 's', key: KEY, seq: 1, turn: 1, step: 0, retry: 0, model: 'x', b: {} });

  return { stateDir, ltm, ids: { keep: keep.id, gone: gone.id, promise: promise.id } };
}

function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { out[`${path.relative(dir, p)}/`] = 'dir'; walk(p); }
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const mk = (ctx, rag, extra = {}) => createBrainReplay({ stateDir: ctx.stateDir, ltm: ctx.ltm, rag, persona: { _store: createPersonaStoreReadOnly(ctx.stateDir) }, roleName: () => ROLE, now: () => NOW, ...extra });
// 回放只调 readConfig（纯读）；用一个只读替身，免得 createPersonaStore 自己建目录影响 sha256 比对。
function createPersonaStoreReadOnly(stateDir) {
  return { readConfig: () => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'persona', 'config.json'), 'utf8')); } catch { return {}; } } };
}

const ctx = buildState('full');

await test('1. 一天的完整拼装：类型、region、nodes、data、排序', async () => {
  const rag = fakeRag(GRAPH);
  const r = await mk(ctx, rag).replay({ day: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.day, TODAY);
  const ev = r.events;
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i - 1].at <= ev[i].at, '没有按时间排序');
  ev.forEach((e, i) => { assert.equal(e.id, `r${i + 1}`); assert.equal(e.replay, true); assert.ok(Array.isArray(e.nodes)); assert.ok(e.nodes.length <= 50); });
  const by = (t) => ev.filter((e) => e.type === t);
  const types = new Set(ev.map((e) => e.type));
  for (const t of ['msg.in', 'msg.out', 'wake', 'inject', 'search', 'recall', 'remember', 'forget', 'decay.review', 'recall.auto',
    'life.ownLife', 'life.recall', 'life.assoc', 'life.promiseDue', 'suggest.shown', 'suggest.adopted', 'persona.appraisal',
    'persona.nightly', 'rag.index', 'rag.distill', 'tool']) assert.ok(types.has(t), `缺少类型 ${t}`);
  const REG = { 'msg.in': 'input', 'msg.out': 'output', wake: 'working', inject: 'output', search: 'core', recall: 'core', remember: 'hippo', forget: 'decay',
    'decay.review': 'decay', 'recall.auto': 'core', 'life.ownLife': 'life', 'life.recall': 'life', 'life.assoc': 'life', 'life.promiseDue': 'life',
    'suggest.shown': 'introspect', 'suggest.adopted': 'introspect', 'persona.appraisal': 'limbic', 'persona.nightly': 'introspect', 'rag.index': 'hippo', 'rag.distill': 'hippo' };
  for (const e of ev) if (REG[e.type]) assert.equal(e.region, REG[e.type], `${e.type} 的 region`);
  // 工具按名分脑区
  assert.deepEqual(by('tool').map((e) => [e.data.name, e.region, e.data.ok]), [
    ['qq_get_message_images', 'vision', true], ['qq_tts_voice', 'audio', true], ['qq_memory_add', 'working', true], ['qq_send_message', 'output', true]]);
  // 消息
  const mi = by('msg.in').find((e) => e.data.msgId === '9001');
  assert.deepEqual(mi.data, { dir: 'in', userId: '2001', name: '阿明', text: '我家猫生病了', msgId: '9001' });
  assert.deepEqual(mi.nodes, ['msg:9001']);
  assert.equal(mi.key, KEY);
  assert.equal(by('msg.in').find((e) => e.data.msgId === '9004').data.text.length, 300, '原文没截到 300 字');
  // 轨迹里的 msg.in 被忽略：msg.in 只来自存档（9001、9004、群里 9101）
  assert.equal(by('msg.in').length, 3);
  // wake：轨迹有 wake → 不再从 token-usage 补
  assert.equal(by('wake').length, 1);
  assert.equal(by('wake')[0].data.reason, 'message');
  // inject
  // BRAIN_PATCH（返工 A2）：轨迹 e.recall: true → 回放 data.recall === true
  assert.deepEqual(by('inject')[0].data, { ltm: [`ltm:${ctx.ids.keep}`], recall: true, suggest: false, chars: 120 });
  assert.equal(by('inject')[0].data.recall, true);
  // search：配上 query / keywords（令牌样的关键词被丢掉），items 有摘要；sum:gone 已删
  const s = by('search').find((e) => e.nodes.length);
  assert.equal(s.data.query, '上次说猫怎么了');
  assert.deepEqual(s.data.keywords, ['猫']);
  assert.equal(s.data.from, TODAY);
  assert.equal(s.data.source, 'rag');
  assert.equal(s.data.semantic, 'ok');
  assert.equal(s.data.ms, 182);
  assert.deepEqual(s.data.ranked, []);
  assert.deepEqual(s.data.routes, {});
  assert.equal(s.data.items.find((x) => x.node === 'sum:s1').summary, '阿明说家里的猫生病了');
  assert.equal(s.data.items.find((x) => x.node === 'chunk:c1').title, '聊猫');
  assert.equal(s.data.items.find((x) => x.node === 'sum:gone').deleted, true);
  assert.equal(s.data.deleted, true);
  // 没配上轨迹的那次检索（只有 query）
  const s2 = by('search').find((e) => !e.nodes.length);
  assert.equal(s2.data.query, '周末去哪');
  // recall：query 来自双层字符串的 args
  const rc = by('recall')[0];
  assert.equal(rc.data.query, '猫');
  assert.equal(rc.data.items[0].text, '阿明养了一只橘猫');
  // decay.review
  assert.deepEqual(by('decay.review')[0].data, { unit: `ltm:${ctx.ids.keep}`, rating: 'hard', before: { R: 0.8, S: 3 }, after: { R: 1, S: 9 } });
  // recall.auto：轨迹没有 → 来自影子日志，带 shadow
  const ra = by('recall.auto')[0];
  assert.equal(ra.shadow, true);
  assert.deepEqual(ra.data, { candidates: [{ node: 'sum:s1', score: 0.71, pass: true }], tau: 0.62 });
  // persona.appraisal：按 msgId 对上存档原文
  const pa = by('persona.appraisal')[0];
  assert.deepEqual(pa.data, { kind: 'share', label: '担心', intensity: 0.6, salience: 0.8, source: 'model', inject: true, msgId: '9001', text: '我家猫生病了' });
  assert.ok(pa.nodes.includes('msg:9001') && pa.nodes.includes('persona:rel:2001'));
  assert.equal(pa.shadow, undefined);
  // life.*
  const lr = by('life.recall');
  assert.equal(lr.length, 2, '前一天的 recall 不该出现');
  assert.equal(lr.find((e) => e.data.node === `ltm:${ctx.ids.keep}`).data.text, '阿明养了一只橘猫');
  assert.equal(lr.find((e) => e.data.node === 'msg:9001').data.text, '我家猫生病了');
  assert.deepEqual(by('life.assoc')[0].data, { hops: ['sum:s1', 'ent:e1'] });
  const pd = by('life.promiseDue')[0];
  assert.deepEqual(pd.data, { node: `ltm:${ctx.ids.promise}`, userId: '2001', name: '阿明', text: '今天陪阿明去宠物医院' });
  assert.equal(pd.key, KEY);
  assert.deepEqual(by('life.ownLife')[0].data, { kind: 'day', remainingSlots: 4 });
  assert.deepEqual(by('suggest.shown')[0].data, { items: [{ node: 'note:n1', text: '阿明养了一只橘猫' }] });
  assert.deepEqual(by('suggest.adopted')[0].data, { node: 'note:n1', ltm: `ltm:${ctx.ids.keep}` });
  assert.deepEqual(by('rag.index')[0].data, { added: 2, total: 158 });
  assert.deepEqual(by('persona.nightly')[0].data, { changes: {} });
  // remember：账本留着的那条从 people.json 补；轨迹里的那条（已删）不重复
  const rem = by('remember');
  assert.ok(rem.some((e) => e.data.node === `ltm:${ctx.ids.keep}` && e.data.text === '阿明养了一只橘猫' && e.data.cat === 'fact' && e.data.userId === '2001' && e.data.name === '阿明'));
  assert.equal(rem.filter((e) => e.data.node === `ltm:${ctx.ids.gone}`).length, 1);
  // rag.graph 只调了一次、带会话 key
  assert.equal(rag.calls.length, 1);
  assert.deepEqual(rag.calls[0].keys, [KEY]);
  // 这套夹具每个来源都在，graph 正常 → 不是 partial
  assert.equal(r.partial, false, `不该是 partial：${r.notes.join(' / ')}`);
});

await test('2. 墓碑行不出现；已删账本条目 → deleted、文字 null', async () => {
  const r = await mk(ctx, fakeRag(GRAPH)).replay({ day: TODAY });
  const s = JSON.stringify(r);
  assert.ok(!s.includes('这条会被删掉的秘密消息'), '墓碑行的原文出现了');
  assert.ok(!r.events.some((e) => e.nodes.includes('msg:9003')));
  const rem = r.events.find((e) => e.type === 'remember' && e.data.node === `ltm:${ctx.ids.gone}`);
  assert.equal(rem.data.text, null);
  assert.equal(rem.data.deleted, true);
  const rc = r.events.find((e) => e.type === 'recall');
  const gone = rc.data.items.find((x) => x.node === `ltm:${ctx.ids.gone}`);
  assert.equal(gone.text, null);
  assert.equal(rc.data.deleted, true);
  assert.ok(!s.includes('这条账本会被删'));
});

await test('3. tool-calls 里的 token 字段 / 令牌样的值不出现', async () => {
  const r = await mk(ctx, fakeRag(GRAPH)).replay({ day: TODAY });
  const s = JSON.stringify(r);
  assert.ok(!s.includes(SECRET), '令牌值出现在输出里');
  assert.ok(!s.includes('sess-1'), 'sessionId 不该输出');
  assert.ok(!/"token"/.test(s));
});

await test('4. rag 返回 null → partial，其它来源照出', async () => {
  const r = await mk(ctx, fakeRag(null)).replay({ day: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.ok(r.notes.some((x) => x.includes('向量记忆')));
  assert.ok(r.events.some((e) => e.type === 'msg.in'));
  const s = r.events.find((e) => e.type === 'search' && e.nodes.length);
  assert.equal(s.data.items.find((x) => x.node === 'sum:s1').summary, null);
  assert.equal(s.data.deleted, undefined, 'rag 不可用时不该标已删除');
  // rag 根本没给 / graph 抛错也一样
  const r2 = await mk(ctx, null).replay({ day: TODAY });
  assert.equal(r2.partial, true);
  const r3 = await mk(ctx, { graph: async () => { throw new Error('boom'); } }).replay({ day: TODAY });
  assert.equal(r3.partial, true);
});

await test('5. 缺文件 / 坏 JSON 行 → 不抛、partial', async () => {
  const c2 = buildState('broken');
  fs.rmSync(path.join(c2.stateDir, 'token-usage.jsonl'));
  fs.rmSync(path.join(c2.stateDir, 'life-loop.json'));
  appendLine(path.join(c2.stateDir, 'brain', 'trace', `${TODAY}.jsonl`), '{坏行');
  appendLine(path.join(c2.stateDir, 'brain', 'trace', `${TODAY}.jsonl`), { id: 99, at: at(8), type: 'nope', key: KEY });
  appendLine(path.join(c2.stateDir, 'tool-calls.jsonl'), 'not json');
  appendLine(path.join(c2.stateDir, 'long-memory', 'archive', 'private_2001', `${TODAY.slice(0, 7)}.jsonl`), '{"t":');
  const r = await mk(c2, fakeRag(GRAPH)).replay({ day: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.ok(r.notes.length >= 3);
  assert.ok(r.events.some((e) => e.type === 'msg.in'));
  for (const n of r.notes) assert.ok(!n.includes('猫'), 'notes 里不该有原文');
  // 整个 state 目录都不存在
  const r2 = await createBrainReplay({ stateDir: path.join(TMP_ROOT, 'no-such-dir'), now: () => NOW }).replay({ day: TODAY });
  assert.equal(r2.ok, true);
  assert.equal(r2.partial, true);
  assert.deepEqual(r2.events, []);
  // ltm 方法抛错也不抛
  const r3 = await createBrainReplay({ stateDir: c2.stateDir, ltm: { listPeople() { throw new Error('x'); }, personView() {} }, now: () => NOW }).replay({ day: TODAY });
  assert.equal(r3.ok, true);
  assert.equal(r3.partial, true);
  // 没有轨迹的天：wake 从 token-usage 补，reason=other
  const c3 = buildState('notrace');
  fs.rmSync(path.join(c3.stateDir, 'brain'), { recursive: true });
  const r4 = await mk(c3, fakeRag(GRAPH)).replay({ day: TODAY });
  assert.equal(r4.partial, true);
  const w = r4.events.filter((e) => e.type === 'wake');
  assert.equal(w.length, 1);
  assert.equal(w[0].data.reason, 'other');
  // 没轨迹时检索调用照样出（只有 query）
  assert.equal(r4.events.filter((e) => e.type === 'search').length, 2);
  fs.rmSync(c2.stateDir, { recursive: true, force: true });
  fs.rmSync(c3.stateDir, { recursive: true, force: true });
});

await test('6. key 过滤；不传 key 时多个会话都有', async () => {
  const all = await mk(ctx, fakeRag(GRAPH)).replay({ day: TODAY });
  const keys = new Set(all.events.map((e) => e.key));
  assert.ok(keys.has(KEY) && keys.has(KEY2));
  const only = await mk(ctx, fakeRag(GRAPH)).replay({ day: TODAY, key: KEY2 });
  assert.ok(only.events.length > 0);
  for (const e of only.events) assert.ok(e.key === KEY2 || e.key === null, `混进了 ${e.key}`);
  assert.ok(!JSON.stringify(only).includes('我家猫生病了'));
  const bad = await mk(ctx, fakeRag(GRAPH)).replay({ day: TODAY, key: 'private:abc' });
  assert.equal(bad.ok, false);
});

await test('7. 超过 7 天 / 未来 / 格式错的 day → ok:false', async () => {
  const rp = mk(ctx, fakeRag(GRAPH));
  const shift = (n) => ymd(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + n).getTime());
  for (const day of [shift(-7), shift(-30), shift(1), '2026-13-01', '2026-02-30', '20261103', '', null, undefined, '2026-1-3']) {
    const r = await rp.replay({ day });
    assert.equal(r.ok, false, `day=${day} 应被拒绝`);
    assert.equal(typeof r.error, 'string');
  }
  const ok6 = await rp.replay({ day: shift(-6) });
  assert.equal(ok6.ok, true, '往前第 6 天（7 天内的最早一天）应可回放');
});

await test('8. 只读：运行前后 stateDir 下所有文件 sha256 不变', async () => {
  const before = hashTree(ctx.stateDir);
  await mk(ctx, fakeRag(GRAPH)).replay({ day: TODAY });
  await mk(ctx, fakeRag(null)).replay({ day: TODAY, key: KEY });
  const yday = ymd(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 1).getTime());
  await mk(ctx, fakeRag(GRAPH)).replay({ day: yday });
  assert.deepEqual(hashTree(ctx.stateDir), before);
});

await test('9. 超过 5000 条只回最早的 5000 条', async () => {
  const c = buildState('many');
  const f = path.join(c.stateDir, 'brain', 'trace', `${TODAY}.jsonl`);
  let buf = '';
  for (let i = 0; i < 5200; i++) buf += JSON.stringify({ id: 1000 + i, at: at(16) + i, type: 'tool', key: KEY, origin: 'ai', nodes: [], n: {}, e: { tool: 'qq_send_message', status: 'ok' } }) + '\n';
  fs.appendFileSync(f, buf);
  const r = await mk(c, fakeRag(GRAPH)).replay({ day: TODAY });
  assert.equal(r.events.length, 5000);
  assert.equal(r.partial, true);
  assert.ok(r.notes.some((x) => x.includes('5000')));
  assert.equal(r.events[0].id, 'r1');
  fs.rmSync(c.stateDir, { recursive: true, force: true });
});

fs.rmSync(ctx.stateDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} 个失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
