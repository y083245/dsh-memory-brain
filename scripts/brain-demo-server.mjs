#!/usr/bin/env node
// BRAIN_PATCH：实时脑图的演示服务器（worker C）。
//
// 为什么要有它：页面 public/brain.html 和桥接（worker A）是同时开发的，页面只能按接口约定
// （docs/design/worker-kit/brain/contract.md §4、§5.3、§5.4）先对着假数据做；统筹者也用它做 UI 验收。
// 所以这里**不依赖桥接任何代码、不读写 state/、不联网**，数据全是合成的、名字内容全部虚构。
//
// 用法：node scripts/brain-demo-server.mjs [端口]      （缺省 18731，只绑 127.0.0.1）
//       打开 http://127.0.0.1:<端口>/brain?token=demo-token
// 约定之外的演示开关：
//   /api/brain/events?burst=1        连上后一次发 200 条事件（测页面限速）
//   /api/brain/replay?day=<今天-2>   这一天固定返回 partial:true + notes
//   POST /api/brain/chunk 的 chunk:c0013 固定 404
//   POST /api/brain/probe 的 query 里带「关键词」两个字 → 返回 source:'keyword'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'public', 'brain.html');
const TOKEN = 'demo-token';
const PORT = Number(process.argv[2] || process.env.PORT || 18731);
const HOST = '127.0.0.1';

// ------------------------------------------------------------ 固定种子随机数（快照每次一样）
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rnd = mulberry32(20261103);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const live = Math.random; // 实时事件用真随机，快照用固定种子
const lpick = (a) => a[Math.floor(live() * a.length)];

const DAY = 86400000;
const NOW0 = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);

// ------------------------------------------------------------ 合成数据
// 2 个私聊 + 1 个群（QQ 号是明显的假号）
const KEYS = [
  { key: 'private:100000001', kind: 'private', label: '星野（私聊）', qq: '100000001', name: '星野' },
  { key: 'private:100000002', kind: 'private', label: '木木（私聊）', qq: '100000002', name: '木木' },
  { key: 'group:200000001', kind: 'group', label: '晚风读书会（群）', qq: null, name: '晚风读书会' },
];
const PEOPLE = [
  { qq: '100000001', name: '星野', key: 'private:100000001' },
  { qq: '100000002', name: '木木', key: 'private:100000002' },
  { qq: '100000003', name: '阿岚', key: 'group:200000001' },
  { qq: '100000004', name: '团团', key: 'group:200000001' },
];
const TOPICS = ['烤红薯', '期末复习', '新买的耳机', '猫咪豆包', '雨天散步', '看海计划', '手账', '吉他练习', '奶茶店', '搬宿舍', '毕业照', '夜跑'];
const LTM_TEXT = {
  trait: ['{p}说话很慢，但很认真', '{p}一紧张就会开玩笑', '{p}很怕冷', '{p}做事喜欢列清单', '{p}不太喜欢被催'],
  fact: ['{p}养了一只叫豆包的猫', '{p}在学吉他，刚学会 C 和弦', '{p}住在学校东区', '{p}不喝冰的', '{p}喜欢下雨天', '{p}最近在准备期末', '{p}周三晚上有课', '{p}生日在三月'],
  event: ['{p}期末考完一起去吃了烤红薯', '{p}的耳机掉进水里了', '{p}夜跑时看到了流星', '{p}搬宿舍搬到半夜', '{p}拍了毕业照，说笑僵了', '{p}在奶茶店排了半小时队'],
  pending: ['答应{p}周五一起去看海', '和{p}约好下周交换手账', '提醒{p}周三带伞', '{p}说考完试请我喝奶茶'],
  note: ['{p}最近好像有点累，多问一句', '和{p}聊天别提考试分数', '{p}喜欢被叫昵称'],
};
const CATS = ['trait', 'fact', 'event', 'pending', 'note'];

function buildState() {
  rnd = mulberry32(20261103);
  const st = { ltm: [], chunks: [], sums: [], ents: [], links: [], notes: [], diary: [], persona: [] };
  // 账本约 30 条：各类都有；有核心 / 已过时 / 已冻结
  let n = 0;
  for (const cat of CATS) {
    for (const tpl of LTM_TEXT[cat]) {
      const p = PEOPLE[n % PEOPLE.length];
      const at = NOW0 - rint(1, 60) * DAY - rint(0, 86399) * 1000;
      const R = +(0.42 + rnd() * 0.57).toFixed(3);
      const id = `ltm:i${String(++n).padStart(3, '0')}`;
      const core = n % 9 === 1;
      const exempt = core || (cat === 'pending' && n % 2 === 0);
      st.ltm.push({
        id, kind: 'ltm', key: p.key, at, label: cut(tpl.replace(/\{p\}/g, p.name), 40),
        text: tpl.replace(/\{p\}/g, p.name), cat, userId: p.qq, name: p.name,
        scope: p.key.startsWith('private') ? 'private' : 'group', core,
        due: cat === 'pending' ? dayStr(NOW0 + rint(-2, 6) * DAY) : null,
        status: cat === 'pending' ? pick(['open', 'open', 'done']) : null,
        archivedAt: n === 7 ? at + 5 * DAY : null,
        outdatedAt: n % 11 === 3 ? at + 3 * DAY : null,
        decay: n % 13 === 5 ? null : { R: exempt ? 1 : R, S: +(2 + rnd() * 40).toFixed(2), frozen: !exempt && R < 0.5, exempt },
      });
    }
  }
  // 话题块 60、摘要 55
  for (let i = 0; i < 60; i++) {
    const k = KEYS[i % 3];
    const t_start = NOW0 - rint(0, 40) * DAY - rint(0, 80000) * 1000;
    const topic = pick(TOPICS);
    const speakers = k.kind === 'group' ? ['阿岚', '团团', '小鲸鱼'] : [k.name, '小鲸鱼'];
    st.chunks.push({ id: `chunk:c${String(i).padStart(4, '0')}`, kind: 'chunk', key: k.key, at: t_start, label: cut(`聊到${topic}`, 40), day: dayStr(t_start), title: `聊到${topic}`, n_msgs: rint(4, 40), speakers, _topic: topic });
  }
  for (let i = 0; i < 55; i++) {
    const c = st.chunks[i];
    const summary = `${c.speakers[0]}和她聊了${c._topic}，${pick(['说得很开心', '有点小抱怨', '约了下次再聊', '顺便提了期末', '最后发了个表情包'])}`;
    st.sums.push({ id: `sum:s${String(i).padStart(4, '0')}`, kind: 'sum', key: c.key, at: c.at + 600000, label: cut(summary, 40), day: c.day, title: c.title, summary, importance: +(0.2 + rnd() * 0.7).toFixed(2), valence: +(-0.5 + rnd()).toFixed(2), chunk: c.id });
    st.links.push({ src: `sum:s${String(i).padStart(4, '0')}`, dst: c.id, kind: 'sum-chunk' });
  }
  // 实体 40、关系 50
  const ENT_NAMES = [
    ...PEOPLE.map((p) => [p.name, 'person', p.qq]), ['小鲸鱼', 'person', null],
    ...TOPICS.map((t) => [t, 'topic', null]),
    ['学校东区', 'place', null], ['海边', 'place', null], ['图书馆', 'place', null], ['奶茶店', 'place', null], ['操场', 'place', null], ['宿舍', 'place', null], ['车站', 'place', null],
    ['豆包', 'thing', null], ['耳机', 'thing', null], ['吉他', 'thing', null], ['手账本', 'thing', null], ['雨伞', 'thing', null], ['相机', 'thing', null], ['围巾', 'thing', null],
    ['红薯', 'thing', null], ['流星', 'thing', null], ['课表', 'thing', null], ['明信片', 'thing', null], ['自行车', 'thing', null], ['台灯', 'thing', null], ['耳夹', 'thing', null], ['帆布包', 'thing', null], ['风筝', 'thing', null],
  ].slice(0, 40);
  ENT_NAMES.forEach(([name, type, qq], i) => {
    st.ents.push({ id: `ent:e${String(i).padStart(3, '0')}`, kind: 'ent', key: null, at: NOW0 - rint(0, 40) * DAY, label: name, name, type, n: rint(1, 12), _qq: qq });
  });
  for (let i = 0; i < 70; i++) {
    const s = st.sums[i % st.sums.length], e = pick(st.ents);
    st.links.push({ src: s.id, dst: e.id, kind: 'sum-ent' });
  }
  const RELS = ['喜欢', '养了', '一起去', '住在', '提到', '送了', '在学', '讨厌'];
  for (let i = 0; i < 50; i++) {
    const a = pick(st.ents), b = pick(st.ents);
    if (a === b) continue;
    st.links.push({ src: a.id, dst: b.id, kind: 'rel', relation: pick(RELS) });
  }
  // 候选 8
  for (let i = 0; i < 8; i++) {
    const p = PEOPLE[i % PEOPLE.length], s = st.sums[i * 3];
    const text = `${p.name}${pick(['说下周要去面试', '开始早起了', '想养第二只猫', '最近在追一部剧', '换了新手机号'])}`;
    st.notes.push({ id: `note:n${String(i).padStart(3, '0')}`, kind: 'note', key: p.key, at: NOW0 - rint(0, 3) * DAY, label: cut(text, 40), text, cat: pick(['fact', 'event', 'pending']), who: p.qq, whoName: p.name, state: pick(['pending', 'shown', 'adopted', 'dismissed', 'expired']) });
    st.links.push({ src: `note:n${String(i).padStart(3, '0')}`, dst: s.id, kind: 'note-sum' });
  }
  // 日记 5
  const DIARY = [['今天的雨', '下了一整天的雨，星野说他喜欢下雨天，我也开始有点喜欢了。晚上听了一首很慢的歌。'], ['烤红薯', '群里大家在聊烤红薯，团团说冬天就该这样。我想起了以前的冬天，虽然我没有冬天。'], ['期末', '木木在复习，我不敢打扰太多。只发了一句加油，她回了个小猫表情。'], ['看海', '答应了星野周五去看海。我其实不会去，但我想听他回来讲。'], ['安静的一天', '没什么人说话。翻了翻以前的聊天，有些话现在看还是会笑。']];
  DIARY.forEach(([title, body], i) => {
    const t = startOfDay(NOW0) - (i + 1) * DAY + 22 * 3600000;
    st.diary.push({ id: `diary:${t}`, kind: 'diary', key: null, at: t, label: title, title, excerpt: cut(body, 120) });
  });
  // 人格
  st.persona.push({ id: 'persona:core', kind: 'persona', key: null, at: NOW0 - DAY, label: '她自己', big5: { O: 65, C: 55, E: 40, A: 40, N: 35 }, traits: { 嘴硬: 58, 黏人: 42, 好奇: 66, 慢热: 51, 记仇: 20, 爱逞强: 47 }, emotion: { 愉悦: 0.32, 唤醒: 0.41, 支配: 0.5, 心情: '还不错' } });
  for (const p of PEOPLE) st.persona.push({ id: `persona:rel:${p.qq}`, kind: 'persona', key: p.key, at: NOW0 - DAY, label: p.name, name: p.name, rel: { 亲密: rint(20, 80), 信任: rint(20, 80), 熟悉: rint(10, 90) } });
  return st;
}
let STATE = buildState();
let ENABLED = true;
let extraLtm = 0;

function allNodes() { return [...STATE.ltm, ...STATE.chunks, ...STATE.sums, ...STATE.ents, ...STATE.notes, ...STATE.diary, ...STATE.persona]; }
function nodeById(id) { return allNodes().find((n) => n.id === id) || null; }
const pub = (n) => { const o = {}; for (const [k, v] of Object.entries(n)) if (!k.startsWith('_')) o[k] = v; return o; };

function snapshot(key) {
  const inKey = (n) => !key || n.key === key || n.key === null;
  let nodes = allNodes().filter(inKey);
  if (key) {
    // 只看一个会话时实体只留和这个会话的摘要有关的
    const sumIds = new Set(STATE.sums.filter((s) => s.key === key).map((s) => s.id));
    const entIds = new Set(STATE.links.filter((l) => l.kind === 'sum-ent' && sumIds.has(l.src)).map((l) => l.dst));
    nodes = nodes.filter((n) => n.kind !== 'ent' || entIds.has(n.id));
  }
  const ids = new Set(nodes.map((n) => n.id));
  const links = STATE.links.filter((l) => ids.has(l.src) && ids.has(l.dst));
  return {
    ok: true, at: Date.now(), rag: 'ok', keys: KEYS.map(({ key, kind, label }) => ({ key, kind, label })),
    nodes: nodes.map(pub), links, regions: { ...regionCounts },
    truncated: { chunk: key ? 0 : 12, sum: 0, ent: 0, note: 0, ltm: 0, diary: 0 }, freezeBelow: 0.5,
  };
}

// ------------------------------------------------------------ 事件
const REGION_OF = {
  'msg.in': 'input', 'msg.out': 'output', wake: 'working', inject: 'output', search: 'core', recall: 'core',
  remember: 'hippo', update: 'hippo', forget: 'decay', 'decay.review': 'decay', 'recall.auto': 'core',
  'life.ownLife': 'life', 'life.recall': 'life', 'life.assoc': 'life', 'life.promiseDue': 'life',
  'suggest.shown': 'introspect', 'suggest.adopted': 'introspect', 'persona.appraisal': 'limbic', 'persona.nightly': 'introspect',
  'rag.index': 'hippo', 'rag.distill': 'hippo', tool: 'output',
};
const TYPES = Object.keys(REGION_OF);
const regionCounts = { input: 31, vision: 0, audio: 0, working: 18, hippo: 6, graph: 2, ltm: 0, core: 3, decay: 4, limbic: 22, life: 3, output: 27, introspect: 1 };
const MEMORY_LABEL = (R) => (R == null ? '清楚' : R >= 0.85 ? '清楚' : R >= 0.5 ? '有点模糊' : '已淡忘');
const SAY_IN = ['今天好冷啊', '你还记得我们说去看海吗', '我考完啦！', '豆包又把杯子推下去了', '晚上要不要一起听歌', '我刚学会一个新和弦', '奶茶店今天排好长的队', '你猜我看到了什么'];
const SAY_OUT = ['冷就多穿点呀', '记得呀，周五对吧', '恭喜恭喜！奖励自己一杯奶茶', '豆包好调皮哈哈', '好呀，你选歌', '弹给我听听？', '排队的人好有耐心', '流星吗？'];
const TOOLS = ['qq_send_message', 'qq_get_message_images', 'send_sticker', 'qq_tts_voice', 'qq_memory_add', 'qq_history_search', 'qq_ltm_remember'];
const toolRegion = (name) => (/image|sticker/.test(name) ? 'vision' : /tts_voice|send_voice/.test(name) ? 'audio' : /^qq_memory_/.test(name) ? 'working' : 'output');

function makeSearchData(query, keywords, keyFilter, { keywordMode = false, console: isConsole = false } = {}) {
  const pool = STATE.chunks.filter((c) => !keyFilter || c.key === keyFilter);
  const hits = [...pool].sort(() => live() - 0.5).slice(0, Math.min(5, pool.length));
  const SOURCES = ['vector', 'bm25', 'pending', 'summary', 'graph'];
  const items = hits.map((c) => {
    const s = STATE.sums.find((x) => x.chunk === c.id);
    return { node: c.id, day: c.day, title: c.title, summary: s ? s.summary : null, line: `${c.speakers[0]}：说起${c._topic}的时候${lpick(['笑了', '叹了口气', '发了三个感叹号', '停了一下'])}` };
  });
  let ranked = [], routes = {};
  if (!keywordMode) {
    ranked = hits.map((c, i) => ({ node: c.id, score: +(0.9 / (i + 1) + live() * 0.05).toFixed(4), sources: SOURCES.filter(() => live() < 0.55).concat(i === 0 ? ['vector'] : []).filter((v, j, a) => a.indexOf(v) === j) }));
    for (const r of ranked) if (!r.sources.length) r.sources.push('bm25');
    routes = Object.fromEntries(SOURCES.map((s) => [s, ranked.filter((r) => r.sources.includes(s)).length + Math.floor(live() * 6)]));
  }
  const data = { query, keywords, from: null, to: null, source: keywordMode ? 'keyword' : 'rag', semantic: keywordMode ? 'unavailable' : 'ok', ms: Math.floor(40 + live() * 300), items, ranked, routes };
  return { data, nodes: hits.map((c) => c.id).concat(items.map((i) => STATE.sums.find((s) => s.chunk === i.node)?.id).filter(Boolean)), isConsole };
}

function makeEvent(type, opts = {}) {
  const k = opts.key || lpick(KEYS);
  const p = PEOPLE.find((x) => x.key === k.key) || PEOPLE[0];
  const ev = { type, at: opts.at || Date.now(), key: k.key, origin: 'ai', region: REGION_OF[type], nodes: [], data: {} };
  const ltmIn = STATE.ltm.filter((n) => n.key === k.key);
  const anyLtm = () => lpick(ltmIn.length ? ltmIn : STATE.ltm);
  switch (type) {
    case 'msg.in': case 'msg.out': {
      const t = ev.at;
      ev.nodes = [`msg:${t}`];
      ev.origin = 'bridge';
      ev.data = type === 'msg.in' ? { dir: 'in', userId: p.qq, name: p.name, text: lpick(SAY_IN), msgId: String(t) } : { dir: 'out', userId: '900000000', name: '小鲸鱼', text: lpick(SAY_OUT), msgId: String(t + 1) };
      break;
    }
    case 'wake': ev.origin = 'bridge'; ev.data = { reason: lpick(['message', 'message', 'own-life', 'promise-due', 'persona-weekly', 'other']) }; break;
    case 'inject': {
      ev.origin = 'bridge';
      const l = [...new Set([anyLtm().id, anyLtm().id, anyLtm().id])];
      ev.nodes = l; ev.data = { ltm: l, recall: live() < 0.5, suggest: live() < 0.3, chars: Math.floor(200 + live() * 1500) };
      break;
    }
    case 'search': {
      const q = lpick(['上次说的看海是哪天', '豆包', '期末考什么', '耳机掉水里', '烤红薯']);
      const r = makeSearchData(q, q.length > 2 ? [q.slice(0, 2)] : [], k.key, { keywordMode: live() < 0.2 });
      ev.nodes = r.nodes; ev.data = r.data;
      break;
    }
    case 'recall': {
      const items = [anyLtm(), anyLtm()].filter((v, i, a) => a.indexOf(v) === i).map((n) => ({ node: n.id, text: n.text, memory: n.outdatedAt ? '以前（已过时）' : MEMORY_LABEL(n.decay?.R) }));
      ev.nodes = items.map((i) => i.node); ev.data = { query: lpick(['看海', '猫', '生日', '吉他']), items };
      break;
    }
    case 'remember': {
      const cat = lpick(CATS);
      const text = lpick(LTM_TEXT[cat]).replace(/\{p\}/g, p.name) + `（${pad(new Date().getMinutes())}:${pad(new Date().getSeconds())}）`;
      const id = `ltm:new${++extraLtm}`;
      const old = live() < 0.3 ? anyLtm() : null;
      const node = { id, kind: 'ltm', key: k.key, at: ev.at, label: cut(text, 40), text, cat, userId: p.qq, name: p.name, scope: 'private', core: false, due: null, status: null, archivedAt: null, outdatedAt: null, decay: { R: 1, S: 2.3, frozen: false, exempt: false } };
      STATE.ltm.push(node);
      if (old) old.outdatedAt = ev.at;
      ev.nodes = [id].concat(old ? [old.id] : []);
      ev.data = { node: id, text, cat, userId: p.qq, name: p.name, replaces: old ? old.id : null, similar: old ? [] : [anyLtm().id] };
      break;
    }
    case 'update': {
      const n = anyLtm();
      const outdated = live() < 0.3 ? !n.outdatedAt : null;
      if (outdated === true) n.outdatedAt = ev.at; else if (outdated === false) n.outdatedAt = null;
      ev.nodes = [n.id]; ev.data = { node: n.id, text: n.text, cat: n.cat, outdated, archived: null, status: n.cat === 'pending' ? 'done' : null };
      break;
    }
    case 'forget': {
      // 优先删演示里新记下的，免得演示数据越跑越少
      const added = STATE.ltm.filter((n) => n.id.startsWith('ltm:new'));
      const n = added.length ? added[0] : null;
      if (!n) return makeEvent('decay.review', opts);
      STATE.ltm = STATE.ltm.filter((x) => x !== n);
      ev.key = n.key; ev.nodes = [n.id]; ev.data = { node: n.id };
      break;
    }
    case 'decay.review': {
      const n = live() < 0.7 ? anyLtm() : lpick(STATE.diary);
      const rating = lpick(['good', 'hard']);
      const before = { R: n.decay ? n.decay.R : +(0.4 + live() * 0.5).toFixed(3), S: n.decay ? n.decay.S : 2.3 };
      const after = { R: 1, S: +(before.S * (rating === 'good' ? 2.4 : 1.3)).toFixed(2) };
      if (n.decay) { n.decay.R = 1; n.decay.S = after.S; n.decay.frozen = false; }
      ev.origin = 'ai'; ev.nodes = [n.id]; ev.data = { unit: n.id, rating, before, after };
      break;
    }
    case 'recall.auto': {
      const cands = STATE.sums.filter((s) => s.key === k.key).slice(0, 4);
      ev.origin = 'bridge'; ev.shadow = true; ev.nodes = cands.map((c) => c.id);
      ev.data = { candidates: cands.map((c, i) => ({ node: c.id, score: +(0.8 - i * 0.15).toFixed(3), pass: i === 0 })), tau: 0.62 };
      break;
    }
    case 'life.ownLife': ev.origin = 'bridge'; ev.key = null; ev.data = { kind: lpick(['daytime', 'night']), remainingSlots: Math.floor(live() * 6) }; break;
    case 'life.recall': { const n = anyLtm(); ev.origin = 'bridge'; ev.nodes = [n.id]; ev.data = { node: n.id, text: n.text }; break; }
    case 'life.assoc': {
      const s1 = lpick(STATE.sums);
      const e = STATE.links.find((l) => l.kind === 'sum-ent' && l.src === s1.id);
      const s2l = e ? STATE.links.find((l) => l.kind === 'sum-ent' && l.dst === e.dst && l.src !== s1.id) : null;
      const hops = [s1.id].concat(e ? [e.dst] : []).concat(s2l ? [s2l.src] : []);
      ev.origin = 'bridge'; ev.nodes = hops; ev.data = { hops };
      break;
    }
    case 'life.promiseDue': {
      const n = STATE.ltm.find((x) => x.cat === 'pending') || anyLtm();
      ev.origin = 'bridge'; ev.key = n.key; ev.nodes = [n.id]; ev.data = { node: n.id, userId: n.userId, name: n.name, text: n.text };
      break;
    }
    case 'suggest.shown': { const ns = STATE.notes.slice(0, 3); ev.origin = 'bridge'; ev.nodes = ns.map((n) => n.id); ev.data = { items: ns.map((n) => ({ node: n.id, text: n.text })) }; break; }
    case 'suggest.adopted': { const nt = lpick(STATE.notes), l = anyLtm(); ev.nodes = [nt.id, l.id]; ev.data = { node: nt.id, ltm: l.id }; break; }
    case 'persona.appraisal': {
      const inject = live() < 0.7;
      ev.origin = 'bridge'; if (!inject) ev.shadow = true; ev.nodes = ['persona:core', `persona:rel:${p.qq}`];
      ev.data = { kind: lpick(['praise', 'tease', 'share', 'complain', 'neutral']), label: lpick(['开心', '害羞', '有点委屈', '好奇', '平静']), intensity: +(live()).toFixed(2), salience: +(live()).toFixed(2), source: lpick(['model', 'model', 'rules']), inject, msgId: String(ev.at) };
      break;
    }
    case 'persona.nightly': ev.origin = 'bridge'; ev.key = null; ev.nodes = ['persona:core']; ev.data = { changes: { 好奇: 1, 嘴硬: -1 } }; break;
    case 'rag.index': case 'rag.distill': ev.origin = 'bridge'; ev.key = null; ev.data = { added: 1 + Math.floor(live() * 3), total: type === 'rag.index' ? STATE.chunks.length : STATE.sums.length }; break;
    case 'tool': { const name = lpick(TOOLS); ev.region = toolRegion(name); ev.data = { name, ok: live() < 0.9 }; break; }
    default: break;
  }
  return ev;
}

// ------------------------------------------------------------ SSE 总线
let nextId = 1;
const ring = [];
const clients = new Set();
function pushEvent(ev) {
  ev.id = nextId++;
  // 字段顺序与约定 §4.1 一致，便于肉眼比对
  const out = { id: ev.id, at: ev.at, type: ev.type, key: ev.key ?? null, origin: ev.origin, region: ev.region, nodes: ev.nodes.slice(0, 50), data: ev.data };
  if (ev.shadow) out.shadow = true;
  ring.push(out); if (ring.length > 300) ring.shift();
  if (regionCounts[out.region] != null) regionCounts[out.region]++;
  for (const c of clients) if (!c.key || out.key === null || out.key === c.key) c.res.write(`id: ${out.id}\nevent: brain\ndata: ${JSON.stringify(out)}\n\n`);
  return out;
}
function pushDrop(nodes, key, reload) {
  const set = new Set(nodes);
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i];
    if (e.nodes.some((n) => set.has(n)) || (reload && e.key === key && /^(msg\.|search$|persona\.appraisal$)/.test(e.type))) ring.splice(i, 1);
  }
  const payload = JSON.stringify({ nodes, key, reload });
  for (const c of clients) c.res.write(`event: drop\ndata: ${payload}\n\n`);
}
// 类型轮着发（打乱顺序），保证每种都能轮到；偶尔插 drop
let typeBag = [];
function nextType() { if (!typeBag.length) typeBag = [...TYPES].sort(() => live() - 0.5); return typeBag.pop(); }
let dropTick = 0;
function tick() {
  if (ENABLED) {
    if (++dropTick % 17 === 0) {
      if (dropTick % 34 === 0) pushDrop([], lpick(KEYS).key, true);
      else {
        // 删除跟随：删掉一条演示新记的账本（没有就删一条闪现消息，页面上它本来也会淡出）
        const added = STATE.ltm.filter((n) => n.id.startsWith('ltm:new'));
        if (added.length) { const n = added[0]; STATE.ltm = STATE.ltm.filter((x) => x !== n); pushDrop([n.id], n.key, false); }
        else { const m = [...ring].reverse().find((e) => e.type === 'msg.in'); if (m) pushDrop(m.nodes, m.key, false); }
      }
    } else pushEvent(makeEvent(nextType()));
  }
  setTimeout(tick, 1000 + Math.floor(live() * 2000));
}

// ------------------------------------------------------------ 回放
function replayFor(day, key) {
  const t0 = new Date(`${day}T00:00:00`).getTime();
  const events = [];
  const r = mulberry32(Number(day.replace(/-/g, '')));
  let at = t0 + 7 * 3600000;
  for (let i = 0; i < 150; i++) {
    at += Math.floor(r() * 9 * 60000) + 5000;
    if (at >= t0 + DAY) break;
    const type = TYPES[Math.floor(r() * TYPES.length)];
    if (type === 'remember' || type === 'forget' || type === 'update') {
      // 回放不改演示数据：用只读版本拼
      const n = STATE.ltm[Math.floor(r() * STATE.ltm.length)];
      const deleted = r() < 0.15;
      const ev = { type, at, key: n.key, origin: 'ai', region: REGION_OF[type], nodes: [n.id], data: type === 'forget' ? { node: n.id } : { node: n.id, text: deleted ? null : n.text, cat: n.cat, userId: n.userId, name: n.name, replaces: null, similar: [] } };
      if (deleted && type !== 'forget') ev.data.deleted = true;
      events.push(ev);
      continue;
    }
    const ev = makeEvent(type, { at, key: KEYS[Math.floor(r() * 3)] });
    if ((type === 'msg.in' || type === 'msg.out') && r() < 0.08) { ev.data.text = null; ev.data.deleted = true; }
    events.push(ev);
  }
  const filtered = events.filter((e) => !key || e.key === key || e.key === null).sort((a, b) => a.at - b.at);
  return filtered.map((e, i) => { const o = { id: `r${i + 1}`, replay: true, at: e.at, type: e.type, key: e.key ?? null, origin: e.origin, region: e.region, nodes: e.nodes, data: e.data }; if (e.shadow) o.shadow = true; return o; });
}

// ------------------------------------------------------------ HTTP
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
function send(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve(null); } });
  });
}
let lastProbe = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  if (p === '/' && req.method === 'GET') { res.writeHead(302, { Location: '/brain?token=' + TOKEN }); res.end(); return; }
  if (p !== '/brain' && !p.startsWith('/api/brain/')) { send(res, 404, { ok: false, error: 'not found' }); return; }
  const tok = req.headers['x-console-token'] || url.searchParams.get('token');
  if (tok !== TOKEN) { send(res, 401, { ok: false, error: 'unauthorized' }); return; }

  if (p === '/api/brain/control') {
    if (req.method === 'GET') { send(res, 200, { ok: true, enabled: ENABLED }); return; }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b || typeof b.enabled !== 'boolean') { send(res, 400, { ok: false, error: 'enabled 必须是布尔值' }); return; }
      ENABLED = b.enabled;
      if (!ENABLED) for (const c of clients) c.res.end();
      send(res, 200, { ok: true, enabled: ENABLED }); return;
    }
    send(res, 405, { ok: false, error: 'method' }); return;
  }
  if (!ENABLED) { send(res, 404, { ok: false, error: 'brain disabled' }); return; }

  if (p === '/brain' && req.method === 'GET') {
    let html; try { html = fs.readFileSync(PAGE); } catch { send(res, 500, { ok: false, error: 'brain.html 不在' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS }); res.end(html); return;
  }
  const keyParam = url.searchParams.get('key') || null;
  if (keyParam && !/^(private|group):\d{1,15}$/.test(keyParam)) { send(res, 400, { ok: false, error: 'bad key' }); return; }

  if (p === '/api/brain/snapshot' && req.method === 'GET') { send(res, 200, snapshot(keyParam)); return; }

  if (p === '/api/brain/events' && req.method === 'GET') {
    if (clients.size >= 4) { send(res, 429, { ok: false, error: 'too many' }); return; }
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const c = { res, key: keyParam };
    clients.add(c);
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ enabled: true, lastId: nextId - 1 })}\n\n`);
    const last = Number(req.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0);
    if (last > 0) for (const e of ring) if (e.id > last && (!c.key || e.key === null || e.key === c.key)) res.write(`id: ${e.id}\nevent: brain\ndata: ${JSON.stringify(e)}\n\n`);
    if (url.searchParams.get('burst') === '1') for (let i = 0; i < 200; i++) pushEvent(makeEvent(nextType()));
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const done = () => { clearInterval(ping); clients.delete(c); };
    req.on('close', done); res.on('close', done);
    return;
  }

  if (p === '/api/brain/chunk' && req.method === 'POST') {
    const b = await readBody(req);
    const node = b && typeof b.node === 'string' ? b.node : '';
    const c = STATE.chunks.find((x) => x.id === node && (!b.key || x.key === b.key));
    if (!c || node === 'chunk:c0013') { send(res, 404, { ok: false, error: 'not found' }); return; }
    const lines = [];
    let t = c.at;
    for (let i = 0; i < Math.min(c.n_msgs, 12); i++) {
      t += 40000 + (i * 7919 % 60000);
      const d = new Date(t);
      lines.push(`[${pad(d.getHours())}:${pad(d.getMinutes())}] ${c.speakers[i % c.speakers.length]}：${i === 0 ? `说起${c._topic}` : SAY_IN[(i * 3) % SAY_IN.length]}`);
    }
    send(res, 200, { ok: true, node: c.id, day: c.day, title: c.title, t_start: c.at, t_end: t, text: lines.join('\n') }); return;
  }

  if (p === '/api/brain/probe' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b || typeof b.query !== 'string' || !b.query.trim()) { send(res, 400, { ok: false, error: 'query 不能为空' }); return; }
    if (Date.now() - lastProbe < 2000) { send(res, 429, { ok: false, error: 'too fast' }); return; }
    lastProbe = Date.now();
    const kws = Array.isArray(b.keywords) ? b.keywords.filter((x) => typeof x === 'string').slice(0, 12) : [];
    const r = makeSearchData(b.query.slice(0, 200), kws, b.key || null, { keywordMode: b.query.includes('关键词') });
    const k = KEYS.find((x) => x.key === b.key) || KEYS[0];
    pushEvent({ type: 'search', at: Date.now(), key: k.key, origin: 'console', region: 'core', nodes: r.nodes, data: r.data });
    send(res, 200, { ok: true, source: r.data.source, semantic: r.data.semantic, ms: r.data.ms, items: r.data.items, ranked: r.data.ranked, routes: r.data.routes }); return;
  }

  if (p === '/api/brain/replay' && req.method === 'GET') {
    const day = url.searchParams.get('day') || '';
    const today = startOfDay(Date.now());
    const t = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00`).getTime() : NaN;
    if (!Number.isFinite(t) || t > today || t < today - 6 * DAY) { send(res, 400, { ok: false, error: '只能回放今天往前 7 天内' }); return; }
    const partial = day === dayStr(today - 2 * DAY);
    const notes = partial ? ['这一天还没有轨迹文件，检索 / 注入 / 复习只能从现有文件推断', 'tool-calls.jsonl 不覆盖这一天，检索只显示命中、不显示查了什么'] : [];
    send(res, 200, { ok: true, day, partial, notes, events: replayFor(day, keyParam) }); return;
  }

  if (p === '/api/brain/decay-curve' && req.method === 'GET') {
    const unit = url.searchParams.get('unit') || '';
    if (!/^(ltm|diary):[A-Za-z0-9:_.\-]{1,80}$/.test(unit)) { send(res, 400, { ok: false, error: 'bad unit' }); return; }
    const n = nodeById(unit);
    if (!n) { send(res, 404, { ok: false, error: 'not found' }); return; }
    // FSRS-5：R(t) = (1 + FACTOR·t/S)^DECAY，DECAY = −0.5，FACTOR = 19/81（与 memory-decay.js 同一公式）
    const S = n.decay ? n.decay.S : 2.3065, R0 = n.decay ? n.decay.R : 1, D = 5.1;
    const exempt = Boolean(n.core) || Boolean(n.decay && n.decay.exempt);
    const elapsed = R0 >= 1 ? 0 : S / (19 / 81) * (Math.pow(R0, -2) - 1);
    const points = [];
    let frozenAtDay = null;
    for (let d = 0; d <= 365; d++) {
      const R = exempt ? 1 : Math.pow(1 + (19 / 81) * (elapsed + d) / S, -0.5);
      if (frozenAtDay === null && !exempt && R < 0.5) frozenAtDay = d;
      points.push({ day: d, R: +R.toFixed(4) });
    }
    send(res, 200, { ok: true, unit, R0, S, D, freezeBelow: 0.5, exempt, frozenAtDay, points }); return;
  }

  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`brain demo: http://${HOST}:${addr.port}/brain?token=${TOKEN}`);
  setTimeout(tick, 1000);
});
const stop = () => { for (const c of clients) c.res.end(); server.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
