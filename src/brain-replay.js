// brain-replay.js · 实时脑图「回放某一天」（BRAIN_PATCH，docs/design/BRAIN_LIVE_SPEC.md §5.1、
// docs/design/worker-kit/brain/contract.md §7）
//
// 页面没开着时发生的事，靠轨迹文件（只有编号和数字）+ 现有的各种状态文件现场拼出来。
// 为什么是「现场拼、不缓存」：轨迹不存原文，原文一律按编号去取——存档被删、账本条目被删之后，
// 回放自然取不到，显示「已删除」，不会在别处留下一份聊天副本（规格 B5）。
//
// 只读：本模块不写任何文件、不建目录（所以不用 persona-store 的读函数——它的 roleDir 会 mkdir），
// 不联网（rag 客户端由调用方给）、不调 DeepSeek。整个 replay() 不抛。
//
// 各来源与写入方（格式都按写入代码读，不靠猜）：
//   long-memory/archive/<group|private>_<号>/<YYYY-MM>.jsonl   long-memory.js archive()；墓碑 {"deleted":true}（deleteArchiveRows）
//   brain/trace/<YYYY-MM-DD>.jsonl                              brain-feed.js（约定 §6）
//   long-memory/people.json（经 ltm.listPeople / personView）    long-memory.js remember / update
//   tool-calls.jsonl                                            bridge.js appendToolLog（type=call，time 是 ISO）
//   long-memory/recall-shadow/<YYYY-MM>.jsonl                   bridge.js logRecallShadow
//   persona/<角色>/appraisals/<会话>/<YYYY-MM>.jsonl            persona-store.js appendAppraisal（persona.js applyAppraisal 调）
//   life-loop.json 的 history                                   life-loop.js（recall / associate / promise-wake）
//   token-usage.jsonl（k=turn）                                 token-ledger.js
import fs from 'node:fs';
import path from 'node:path';

const MAX_EVENTS = 5000;
const MAX_TEXT = 300;
const MAX_NODES = 50;
const PAIR_MS = 5000;      // tool-calls 与轨迹配对的时间窗（任务书：±5 秒）
const DEDUP_MS = 10000;    // 旧文件推出来的事件与轨迹视为同一件事的时间窗
const DAYS_BACK = 6;       // 今天 + 往前 6 天 = 7 天（轨迹保留 7 天）

const KEY_RE = /^(private|group):\d{1,15}$/;
const NODE_RE = /^(ltm|chunk|sum|ent|note|diary|msg|persona):[A-Za-z0-9:_.\-]{1,80}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ORIGINS = new Set(['ai', 'bridge', 'console']);
const TYPES = new Set([
  'msg.in', 'msg.out', 'wake', 'inject', 'search', 'recall', 'remember', 'update', 'forget',
  'decay.review', 'recall.auto', 'life.ownLife', 'life.recall', 'life.assoc', 'life.promiseDue',
  'suggest.shown', 'suggest.adopted', 'persona.appraisal', 'persona.nightly', 'rag.index', 'rag.distill', 'tool'
]);
const REGION = {
  'msg.in': 'input', 'msg.out': 'output', wake: 'working', inject: 'output', search: 'core', recall: 'core',
  remember: 'hippo', update: 'hippo', forget: 'decay', 'decay.review': 'decay', 'recall.auto': 'core',
  'life.ownLife': 'life', 'life.recall': 'life', 'life.assoc': 'life', 'life.promiseDue': 'life',
  'suggest.shown': 'introspect', 'suggest.adopted': 'introspect', 'persona.appraisal': 'limbic',
  'persona.nightly': 'introspect', 'rag.index': 'hippo', 'rag.distill': 'hippo'
};
const WAKE_REASONS = new Set(['message', 'own-life', 'promise-due', 'persona-weekly', 'other']);
const MEMORY_LABELS = new Set(['清楚', '有点模糊', '已淡忘', '以前（已过时）']);

// 令牌样子的值：长串字母数字、sk- 开头、或「token: xxx」这类写法。tool-calls 里的值
// 桥接已脱敏过（redactSensitive），这里再拦一道——回放响应里绝不能出现令牌。
const TOKENISH_RE = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_\-]{8,}|[A-Za-z0-9_\-]{32,})(?:$|[^A-Za-z0-9])|(?:token|password|passwd|secret|api[_-]?key|authorization|bearer|密钥|密码|令牌)\s*[:=：]/i;

function pad2(n) { return String(n).padStart(2, '0'); }
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function timeOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v) return Date.parse(v);
  return NaN;
}
function clip(s) {
  if (s == null) return null;
  const cps = [...String(s)];
  return cps.length > MAX_TEXT ? cps.slice(0, MAX_TEXT).join('') : cps.join('');
}
function finite(v) { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; }
function plain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function shortTool(name) { return String(name ?? '').split('__').pop(); }
function safeRole(role) { return String(role || 'default').replace(/[\\/:*?"<>|\s.]+/g, '_') || 'default'; }
function dirToKey(name) { const k = String(name).replace('_', ':'); return KEY_RE.test(k) ? k : null; }
function keyToDir(key) { return String(key).replace(':', '_'); }
function cleanNodes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const n of list) {
    if (typeof n === 'string' && NODE_RE.test(n) && !out.includes(n)) out.push(n);
    if (out.length >= MAX_NODES) break;
  }
  return out;
}
function msgNode(row) {
  const id = row.msgId != null && row.msgId !== '' ? String(row.msgId) : String(row.t ?? '');
  const n = `msg:${id}`;
  return NODE_RE.test(n) ? n : null;
}
function toolRegion(name) {
  const s = shortTool(name);
  if (/image|sticker|表情/i.test(s)) return 'vision';
  if (s === 'qq_tts_voice' || s === 'send_voice' || /voice/i.test(s)) return 'audio';
  if (s.startsWith('qq_memory_')) return 'working';
  return 'output';
}
function noToken(v) {
  if (typeof v !== 'string') return null;
  if (v === '***' || TOKENISH_RE.test(v)) return null;
  return clip(v);
}

/** 读一个 JSONL：返回 { rows, bad, missing }。坏行跳过但计数。 */
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { rows: [], bad: 0, missing: true, error: e?.code ?? 'error' }; }
  const rows = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line.replace(/^﻿/, ''));
      if (plain(r)) rows.push(r); else bad += 1;
    } catch { bad += 1; }
  }
  return { rows, bad, missing: false };
}
function readJson(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')), missing: false }; } catch (e) {
    return { value: null, missing: e?.code === 'ENOENT', bad: e?.code !== 'ENOENT' };
  }
}
function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir   桥接的 STATE_DIR（state/）
 * @param {object} [opts.ltm]      long-memory 实例（listPeople / personView）
 * @param {object} [opts.rag]      memory-rag 客户端（graph({ keys }) → 对象或 null）
 * @param {object} [opts.persona]  人格实例（只用来读当前 inject 设置）
 * @param {string|Function} [opts.roleName]  当前角色名（与 createPersona 同一个来源）
 * @param {() => number} [opts.now]
 * @param {(line: string) => void} [opts.log]
 */
export function createBrainReplay({ stateDir, ltm = null, rag = null, persona = null, roleName = 'default', now = Date.now, log = () => {} } = {}) {
  const root = String(stateDir ?? '');

  function checkDay(day) {
    const m = DAY_RE.exec(String(day ?? ''));
    if (!m) return { error: 'day 格式应为 YYYY-MM-DD' };
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    const start = new Date(y, mo - 1, d);
    if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) return { error: 'day 不是有效日期' };
    const t = Number(now());
    const today = new Date(t);
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - DAYS_BACK).getTime();
    if (start.getTime() > todayStart) return { error: '不能回放未来的日期' };
    if (start.getTime() < earliest) return { error: '只能回放最近 7 天（含今天）' };
    return { start: start.getTime(), end: new Date(y, mo - 1, d + 1).getTime() };
  }

  async function replay({ day, key } = {}) {
    try {
      return await build({ day, key });
    } catch (e) {
      // 兜底：不该走到这里；不带任何内容，只说出错了。
      try { log(`[brain] 回放组装失败：${e?.name ?? 'Error'}`); } catch {}
      return { ok: true, day: String(day ?? ''), partial: true, notes: ['回放组装时出错，结果可能不完整'], events: [] };
    }
  }

  async function build({ day, key }) {
    const range = checkDay(day);
    if (range.error) return { ok: false, error: range.error };
    const keyFilter = key == null || key === '' ? null : String(key);
    if (keyFilter && !KEY_RE.test(keyFilter)) return { ok: false, error: 'key 不合法' };
    const { start, end } = range;
    const month = String(day).slice(0, 7);
    const inDay = (t) => Number.isFinite(t) && t >= start && t < end;
    const keyOk = (k) => !keyFilter || k == null || k === keyFilter;

    const notes = [];
    let partial = false;
    const note = (s) => { partial = true; if (!notes.includes(s)) notes.push(s); };
    const raw = []; // { at, type, key, origin, nodes, data, shadow?, src }

    // ── 1. 账本索引（按条目编号找原文） ─────────────────────────────────
    const items = new Map(); // id → { item, userId, name }
    const people = new Map(); // userId → name
    let ltmOk = false;
    try {
      if (ltm && typeof ltm.listPeople === 'function' && typeof ltm.personView === 'function') {
        for (const p of ltm.listPeople() ?? []) {
          const v = ltm.personView(p.userId, null);
          if (!v) continue;
          people.set(String(p.userId), String(v.name ?? ''));
          for (const it of v.items ?? []) {
            if (it && typeof it.id === 'string') items.set(it.id, { item: it, userId: String(p.userId), name: String(v.name ?? '') });
          }
        }
        ltmOk = true;
      }
    } catch { ltmOk = false; }
    if (!ltmOk) note('长期记忆账本不可用，账本条目的内容取不到');
    const ltmData = (node) => {
      const id = node.slice(4);
      const hit = items.get(id);
      if (!hit) return { node, text: null, deleted: ltmOk ? true : undefined };
      return { node, text: clip(hit.item.text), cat: hit.item.cat ?? null, userId: hit.userId, name: hit.name, item: hit.item };
    };

    // ── 2. 存档 → msg.in / msg.out ─────────────────────────────────────
    const archiveRoot = path.join(root, 'long-memory', 'archive');
    const msgByNode = new Map(); // `${key}|${node}` → row；以及 node → row
    const msgAny = new Map();
    const archEntries = listDir(archiveRoot);
    if (!archEntries) note('聊天存档目录读不到，收发消息没有回放');
    else {
      let bad = 0;
      for (const ent of archEntries) {
        if (!ent.isDirectory()) continue;
        const k = dirToKey(ent.name);
        if (!k) continue;
        const file = path.join(archiveRoot, ent.name, `${month}.jsonl`);
        if (!fs.existsSync(file)) continue;
        const r = readJsonl(file);
        if (r.missing) { note('有会话的聊天存档读不到'); continue; }
        bad += r.bad;
        for (const row of r.rows) {
          if (row.deleted === true) continue; // 墓碑行：被删的消息
          if (row.dir !== 'in' && row.dir !== 'out') { bad += 1; continue; }
          const at = timeOf(row.t);
          if (!Number.isFinite(at)) { bad += 1; continue; }
          if (!inDay(at)) continue;
          const node = msgNode(row);
          if (node) { msgByNode.set(`${k}|${node}`, row); msgAny.set(node, { row, key: k }); }
          if (!keyOk(k)) continue;
          raw.push({
            at, type: row.dir === 'in' ? 'msg.in' : 'msg.out', key: k, origin: row.dir === 'in' ? 'bridge' : 'ai',
            nodes: node ? [node] : [], src: 'archive',
            data: { dir: row.dir, userId: row.userId == null ? null : String(row.userId), name: String(row.name ?? ''), text: clip(row.text ?? ''), msgId: row.msgId == null ? null : String(row.msgId) }
          });
        }
      }
      if (bad) note(`聊天存档里有 ${bad} 行读不懂，已跳过`);
    }

    // ── 3. 轨迹 ───────────────────────────────────────────────────────
    const trace = [];
    const tr = readJsonl(path.join(root, 'brain', 'trace', `${day}.jsonl`));
    if (tr.missing) note('这一天没有轨迹文件，只能回放现有文件能给的部分（检索命中、注入、记忆复习等看不到）');
    let trBad = tr.bad;
    for (const r of tr.rows) {
      const at = finite(r.at);
      const k = r.key == null ? null : String(r.key);
      if (at == null || !TYPES.has(r.type) || (k != null && !KEY_RE.test(k))) { trBad += 1; continue; }
      if (r.type === 'msg.in' || r.type === 'msg.out') continue; // 约定 §6：不该有；有也以存档为准
      if (!inDay(at)) continue;
      trace.push({
        at, type: r.type, key: k, origin: ORIGINS.has(r.origin) ? r.origin : 'bridge',
        nodes: cleanNodes(r.nodes), n: plain(r.n) ? r.n : {}, e: plain(r.e) ? r.e : {}, shadow: r.shadow === true
      });
    }
    if (trBad) note(`轨迹里有 ${trBad} 行读不懂，已跳过`);
    const traceNear = (types, k, at, pred = () => true) => trace.some((t) => types.includes(t.type) && (k === undefined || t.key === k) && Math.abs(t.at - at) <= DEDUP_MS && pred(t));

    // ── 4. tool-calls.jsonl（配对 query / keywords） ─────────────────────
    const tc = readJsonl(path.join(root, 'tool-calls.jsonl'));
    const calls = [];
    if (tc.missing) note('工具调用日志读不到，检索只显示命中、不显示她查了什么');
    else {
      if (tc.bad) note(`工具调用日志里有 ${tc.bad} 行读不懂，已跳过`);
      let earliest = Infinity;
      for (const r of tc.rows) {
        const at = timeOf(r.time);
        if (Number.isFinite(at) && at < earliest) earliest = at;
        if (r.type !== 'call' || !inDay(at)) continue;
        const name = shortTool(r.tool);
        if (name !== 'qq_history_search' && name !== 'qq_ltm_recall') continue;
        const k = typeof r.key === 'string' && KEY_RE.test(r.key) ? r.key : null;
        calls.push({ at, key: k, kind: name === 'qq_history_search' ? 'search' : 'recall', args: parseArgs(r.args), used: false });
      }
      // 日志封顶约 2000 行：只有快满了、且最早一行晚于这天开头，才说明这天的前段被挤掉了
      if (tc.rows.length + tc.bad >= 1900 && earliest > start) note('这一天早于工具调用日志里最早的记录（日志只保留约 2000 行），检索可能配不上她查了什么');
    }
    const pairCall = (kind, k, at) => {
      let best = null;
      for (const c of calls) {
        if (c.used || c.kind !== kind || c.key !== k) continue;
        const d = Math.abs(c.at - at);
        if (d <= PAIR_MS && (!best || d < Math.abs(best.at - at))) best = c;
      }
      if (best) best.used = true;
      return best;
    };

    // ── 5. 判读日志（人格） ────────────────────────────────────────────
    let roleStr = 'default';
    try { roleStr = typeof roleName === 'function' ? String(roleName() || 'default') : String(roleName || 'default'); } catch {}
    const apprRoot = path.join(root, 'persona', safeRole(roleStr), 'appraisals');
    let injectNow = null;
    try {
      // 判读日志不记当时的 inject；只能用现在的设置近似（报告里写明）。readConfig 是纯读。
      const cfg = persona?._store?.readConfig?.();
      if (plain(cfg)) injectNow = cfg.settings?.inject === true;
    } catch { injectNow = null; }
    const appraisals = [];
    const apprEntries = listDir(apprRoot);
    if (!apprEntries) note('人格判读日志读不到，情绪判读没有回放');
    else {
      let bad = 0;
      for (const ent of apprEntries) {
        if (!ent.isDirectory()) continue;
        const k = dirToKey(ent.name);
        if (!k) continue;
        const file = path.join(apprRoot, ent.name, `${month}.jsonl`);
        if (!fs.existsSync(file)) continue;
        const r = readJsonl(file);
        bad += r.bad;
        for (const row of r.rows) {
          const at = finite(row.at);
          if (at == null) { bad += 1; continue; }
          if (!inDay(at)) continue;
          appraisals.push({ at, key: k, row, used: false });
        }
      }
      if (bad) note(`人格判读日志里有 ${bad} 行读不懂，已跳过`);
    }
    const appraisalData = (row, k, inject) => {
      const msgId = row.msgId == null ? null : String(row.msgId);
      const node = msgId ? `msg:${msgId}` : null;
      const m = node ? msgByNode.get(`${k}|${node}`) : null;
      const data = {
        kind: row.kind ?? null, label: row.label ?? null, intensity: finite(row.intensity), salience: finite(row.salience),
        source: row.source === 'model' || row.source === 'rules' ? row.source : null, inject, msgId,
        text: m ? clip(m.text ?? '') : null
      };
      const nodes = [];
      if (node && NODE_RE.test(node)) nodes.push(node);
      if (row.userId != null && /^\d{1,15}$/.test(String(row.userId))) nodes.push(`persona:rel:${row.userId}`);
      return { data, nodes };
    };

    // ── 6. 自动想起影子日志 ────────────────────────────────────────────
    const shadows = [];
    const sh = readJsonl(path.join(root, 'long-memory', 'recall-shadow', `${month}.jsonl`));
    if (sh.missing) note('自动想起的影子日志读不到（向量记忆关着时没有）');
    else {
      let bad = sh.bad;
      for (const row of sh.rows) {
        const at = finite(row.at);
        if (at == null || !Array.isArray(row.candidates)) continue; // 标注行等其它形状
        if (!inDay(at)) continue;
        const k = typeof row.key === 'string' && KEY_RE.test(row.key) ? row.key : null;
        shadows.push({ at, key: k, row, used: false });
      }
      if (bad) note(`影子日志里有 ${bad} 行读不懂，已跳过`);
    }
    const shadowData = (row) => {
      const candidates = [];
      for (const c of row.candidates) {
        if (!plain(c)) continue;
        const node = `sum:${c.summary_id}`;
        if (!NODE_RE.test(node)) continue;
        candidates.push({ node, score: finite(c.cosine), pass: c.pass === true });
        if (candidates.length >= MAX_NODES) break;
      }
      return { candidates, tau: finite(row.tau) };
    };

    // ── 7. 轨迹事件 → 回放事件 ─────────────────────────────────────────
    const ragNodes = new Set();
    const markRag = (nodes) => { for (const n of nodes) if (/^(chunk|sum|ent|note):/.test(n)) ragNodes.add(n); };
    for (const t of trace) {
      if (!keyOk(t.key)) continue;
      const ev = { at: t.at, type: t.type, key: t.key, origin: t.origin, nodes: t.nodes, shadow: t.shadow, src: 'trace', data: {} };
      const { n, e } = t;
      switch (t.type) {
        case 'wake':
          ev.data = { reason: WAKE_REASONS.has(e.reason) ? e.reason : 'other' };
          break;
        case 'inject':
          ev.data = { ltm: t.nodes.filter((x) => x.startsWith('ltm:')), recall: e.recall === true, suggest: e.suggest === true, chars: finite(n.chars) };
          break;
        case 'search': {
          const c = pairCall('search', t.key, t.at);
          markRag(t.nodes);
          ev.data = {
            query: c?.args.query ?? null, keywords: c?.args.keywords ?? [], from: c?.args.from ?? null, to: c?.args.to ?? null,
            source: e.src === 'rag' || e.source === 'rag' ? 'rag' : 'keyword',
            semantic: ['ok', 'unavailable', 'off'].includes(e.semantic) ? e.semantic : null,
            ms: finite(n.ms), items: [], ranked: [], routes: {}
          };
          ev.pending = 'search';
          break;
        }
        case 'recall': {
          const c = pairCall('recall', t.key, t.at);
          ev.data = { query: c?.args.query ?? null, items: [] };
          ev.pending = 'recall';
          break;
        }
        case 'remember': case 'update': {
          const node = t.nodes.find((x) => x.startsWith('ltm:')) ?? null;
          const d = node ? ltmData(node) : { text: null };
          if (t.type === 'remember') {
            const rest = t.nodes.filter((x) => x.startsWith('ltm:') && x !== node);
            ev.data = { node, text: d.text, cat: d.cat ?? null, userId: d.userId ?? null, name: d.name ?? null, replaces: rest[0] ?? null, similar: rest.slice(1) };
          } else {
            ev.data = {
              node, text: d.text, cat: d.cat ?? null,
              outdated: d.item ? !!d.item.outdatedAt : null, archived: d.item ? !!d.item.archivedAt : null,
              status: typeof e.status === 'string' ? e.status : (d.item?.status ?? null)
            };
          }
          if (d.deleted) ev.data.deleted = true;
          break;
        }
        case 'forget':
          ev.data = { node: t.nodes[0] ?? null };
          break;
        case 'decay.review':
          ev.data = {
            unit: t.nodes[0] ?? null, rating: e.rating === 'good' || e.rating === 'hard' ? e.rating : null,
            before: { R: finite(n.R0), S: finite(n.S0) }, after: { R: finite(n.R1), S: finite(n.S1) }
          };
          break;
        case 'recall.auto': {
          // 同一次自动想起：影子日志里有完整候选，以轨迹为准、用影子日志补内容。
          let best = null;
          for (const s of shadows) {
            if (s.used || s.key !== t.key) continue;
            const d = Math.abs(s.at - t.at);
            if (d <= DEDUP_MS && (!best || d < Math.abs(best.at - t.at))) best = s;
          }
          if (best) { best.used = true; ev.data = shadowData(best.row); }
          else ev.data = { candidates: t.nodes.map((node) => ({ node, score: null, pass: null })), tau: finite(n.tau) };
          ev.shadow = true;
          markRag(t.nodes);
          break;
        }
        case 'life.ownLife':
          ev.data = { kind: typeof e.kind === 'string' ? e.kind : null, remainingSlots: finite(n.remainingSlots) };
          break;
        case 'life.recall':
          ev.pending = 'life.recall';
          ev.data = { node: t.nodes[0] ?? null, text: null };
          markRag(t.nodes);
          break;
        case 'life.assoc':
          ev.data = { hops: t.nodes };
          markRag(t.nodes);
          break;
        case 'life.promiseDue': {
          const node = t.nodes.find((x) => x.startsWith('ltm:')) ?? null;
          const d = node ? ltmData(node) : { text: null };
          ev.data = { node, userId: d.userId ?? null, name: d.name ?? null, text: d.text };
          if (d.deleted) ev.data.deleted = true;
          break;
        }
        case 'suggest.shown':
          ev.pending = 'suggest.shown';
          ev.data = { items: t.nodes.filter((x) => x.startsWith('note:')).map((node) => ({ node, text: null })) };
          markRag(t.nodes);
          break;
        case 'suggest.adopted':
          ev.data = { node: t.nodes.find((x) => x.startsWith('note:')) ?? null, ltm: t.nodes.find((x) => x.startsWith('ltm:')) ?? null };
          break;
        case 'persona.appraisal': {
          // 判读日志有 label / msgId：同会话、时间最近的那条补进来。
          let best = null;
          for (const a of appraisals) {
            if (a.used || a.key !== t.key) continue;
            const d = Math.abs(a.at - t.at);
            if (d <= DEDUP_MS && (!best || d < Math.abs(best.at - t.at))) best = a;
          }
          const inject = typeof e.inject === 'boolean' ? e.inject : injectNow;
          if (best) {
            best.used = true;
            const x = appraisalData(best.row, t.key, inject);
            ev.data = x.data;
            ev.nodes = cleanNodes([...t.nodes, ...x.nodes]);
          } else {
            ev.data = { kind: typeof e.kind === 'string' ? e.kind : null, label: null, intensity: finite(n.intensity), salience: finite(n.salience), source: e.source === 'model' || e.source === 'rules' ? e.source : null, inject, msgId: null, text: null };
          }
          if (inject === false) ev.shadow = true;
          break;
        }
        case 'persona.nightly':
          ev.data = { changes: {} };
          break;
        case 'rag.index': case 'rag.distill':
          ev.data = { added: finite(n.added), total: finite(n.total) };
          break;
        case 'tool': {
          const name = typeof e.tool === 'string' ? e.tool : null;
          const ok = typeof e.ok === 'boolean' ? e.ok : (typeof e.status === 'string' ? e.status === 'ok' : (typeof e.pass === 'boolean' ? e.pass : null));
          ev.data = { name, ok };
          ev.region = toolRegion(name);
          break;
        }
        default: break;
      }
      raw.push(ev);
    }

    // ── 8. 旧文件补轨迹缺的部分 ─────────────────────────────────────────
    // 8a. 没配上轨迹的检索调用（轨迹缺的天 / 脑图关着时）：只有她查了什么，没有命中。
    for (const c of calls) {
      if (c.used || !keyOk(c.key)) continue;
      if (c.kind === 'search') {
        raw.push({ at: c.at, type: 'search', key: c.key, origin: 'ai', nodes: [], src: 'tool-calls',
          data: { query: c.args.query, keywords: c.args.keywords, from: c.args.from, to: c.args.to, source: null, semantic: null, ms: null, items: [], ranked: [], routes: {} } });
      } else {
        raw.push({ at: c.at, type: 'recall', key: c.key, origin: 'ai', nodes: [], src: 'tool-calls', data: { query: c.args.query, items: [] } });
      }
    }

    // 8b. 账本条目时间戳 → remember / update（轨迹里已有同一条同一时刻的就不重复）
    if (ltmOk) {
      for (const [id, { item, userId, name }] of items) {
        const node = `ltm:${id}`;
        if (!NODE_RE.test(node)) continue;
        const k = typeof item.sourceKey === 'string' && KEY_RE.test(item.sourceKey) ? item.sourceKey : null;
        if (!keyOk(k)) continue;
        const has = (at) => traceNear(['remember', 'update'], undefined, at, (t) => t.nodes.includes(node));
        const at = timeOf(item.at);
        if (inDay(at) && !has(at)) {
          raw.push({ at, type: 'remember', key: k, origin: 'ai', nodes: [node], src: 'people',
            data: { node, text: clip(item.text), cat: item.cat ?? null, userId, name, replaces: null, similar: [] } });
        }
        const upd = [
          ['outdatedAt', { outdated: true }],
          ['archivedAt', { archived: true }],
          ['closedAt', { status: typeof item.status === 'string' ? item.status : null }]
        ];
        for (const [field, extra] of upd) {
          const ut = timeOf(item[field]);
          if (!inDay(ut) || has(ut)) continue;
          const nodes = [node];
          if (field === 'outdatedAt' && typeof item.outdatedBy === 'string' && NODE_RE.test(`ltm:${item.outdatedBy}`)) nodes.push(`ltm:${item.outdatedBy}`);
          raw.push({ at: ut, type: 'update', key: k, origin: 'ai', nodes, src: 'people',
            data: { node, text: clip(item.text), cat: item.cat ?? null, outdated: null, archived: null, status: null, ...extra } });
        }
      }
    }

    // 8c. 没配上轨迹的影子日志 → recall.auto
    for (const s of shadows) {
      if (s.used || !keyOk(s.key)) continue;
      const data = shadowData(s.row);
      const nodes = data.candidates.map((c) => c.node);
      markRag(nodes);
      raw.push({ at: s.at, type: 'recall.auto', key: s.key, origin: 'bridge', nodes, shadow: true, src: 'shadow', data });
    }

    // 8d. 没配上轨迹的判读 → persona.appraisal
    for (const a of appraisals) {
      if (a.used || !keyOk(a.key)) continue;
      const x = appraisalData(a.row, a.key, injectNow);
      const ev = { at: a.at, type: 'persona.appraisal', key: a.key, origin: 'bridge', nodes: x.nodes, src: 'appraisal', data: x.data };
      if (injectNow === false) ev.shadow = true;
      raw.push(ev);
    }

    // 8e. 生活回路历史
    const ll = readJson(path.join(root, 'life-loop.json'));
    if (ll.missing) note('生活回路状态文件读不到');
    else if (ll.bad || !plain(ll.value)) note('生活回路状态文件读不懂');
    else {
      const hist = Array.isArray(ll.value.history) ? ll.value.history : [];
      for (const h of hist) {
        if (!plain(h)) continue;
        const at = finite(h.at);
        if (at == null || !inDay(at)) continue;
        if (h.kind === 'recall') {
          const node = typeof h.candId === 'string' && NODE_RE.test(h.candId) ? h.candId : null;
          if (traceNear(['life.recall'], undefined, at, (t) => !node || t.nodes.includes(node))) continue;
          const ev = { at, type: 'life.recall', key: null, origin: 'bridge', nodes: node ? [node] : [], src: 'life', pending: 'life.recall',
            data: { node, text: null }, preview: h.source === 'diary' && typeof h.preview === 'string' ? h.preview : null };
          raw.push(ev);
        } else if (h.kind === 'associate') {
          const hops = cleanNodes([h.from, h.candId]);
          if (traceNear(['life.assoc'], undefined, at)) continue;
          markRag(hops);
          raw.push({ at, type: 'life.assoc', key: null, origin: 'bridge', nodes: hops, src: 'life', data: { hops } });
        } else if (h.kind === 'promise-wake') {
          const uid = String(h.userId ?? '');
          if (!/^\d{1,15}$/.test(uid)) continue;
          const k = `private:${uid}`;
          if (!keyOk(k)) continue;
          if (traceNear(['life.promiseDue'], k, at)) continue;
          // 历史只记了人和条数：找这个人在那天到期的约定（与 duePromises 同一个判断）
          let found = null;
          for (const [id, v] of items) {
            const it = v.item;
            if (v.userId === uid && it.cat === 'pending' && it.due === day && (it.scope !== 'private' || it.sourceKey === k)) { found = { id, ...v }; break; }
          }
          const node = found ? `ltm:${found.id}` : null;
          raw.push({ at, type: 'life.promiseDue', key: k, origin: 'bridge', nodes: node ? [node] : [], src: 'life',
            data: { node, userId: uid, name: people.get(uid) ?? null, text: found ? clip(found.item.text) : null } });
        }
      }
    }

    // 8f. token-usage → wake（只在轨迹没有任何 wake 的时候）
    if (!trace.some((t) => t.type === 'wake')) {
      const tu = readJsonl(path.join(root, 'token-usage.jsonl'));
      if (tu.missing) note('令牌用量日志读不到，唤醒次数没有回放');
      else {
        if (tu.bad) note(`令牌用量日志里有 ${tu.bad} 行读不懂，已跳过`);
        const turns = new Map(); // sid|turn → { at, key }
        for (const r of tu.rows) {
          if (r.k !== 'turn') continue;
          const at = timeOf(r.t);
          if (!inDay(at)) continue;
          const k = typeof r.key === 'string' && KEY_RE.test(r.key) ? r.key : null;
          if (!k) continue; // 学习会话、未归属的不算她被唤醒
          const tk = `${r.sid ?? ''}|${r.turn ?? ''}`;
          const prev = turns.get(tk);
          if (!prev || at < prev.at) turns.set(tk, { at, key: k });
        }
        for (const w of turns.values()) {
          if (!keyOk(w.key)) continue;
          raw.push({ at: w.at, type: 'wake', key: w.key, origin: 'bridge', nodes: [], src: 'token-usage', data: { reason: 'other' } });
        }
      }
    }

    // ── 9. 需要 memory-rag 的内容（摘要、块标题、候选原文） ──────────────
    let graph = null;
    if (ragNodes.size) {
      const keys = keyFilter ? [keyFilter] : [...new Set(raw.filter((e) => e.key && e.nodes.some((x) => ragNodes.has(x))).map((e) => e.key))];
      try {
        if (rag && typeof rag.graph === 'function') graph = await rag.graph({ keys: keys.length ? keys : null });
      } catch { graph = null; }
      if (!plain(graph) || graph.ok === false) {
        graph = null;
        note('向量记忆不可用，话题块 / 摘要 / 候选的内容取不到');
      }
    }
    const gChunks = new Map(); const gSums = new Map(); const gEnts = new Map(); const gNotes = new Map();
    if (graph) {
      for (const c of Array.isArray(graph.chunks) ? graph.chunks : []) if (plain(c)) gChunks.set(`chunk:${c.chunk_id}`, c);
      for (const s of Array.isArray(graph.summaries) ? graph.summaries : []) if (plain(s)) gSums.set(`sum:${s.summary_id}`, s);
      for (const x of Array.isArray(graph.entities) ? graph.entities : []) if (plain(x)) gEnts.set(`ent:${x.entity_id}`, x);
      for (const x of Array.isArray(graph.notes) ? graph.notes : []) if (plain(x)) gNotes.set(`note:${x.note_id}`, x);
    }
    // graph 可用但编号找不到 = 已删除；graph 不可用 = 不知道（不标删除）
    const ragText = (node) => {
      if (!graph) return { text: null, deleted: false };
      if (gSums.has(node)) return { text: clip(gSums.get(node).summary ?? ''), deleted: false };
      if (gChunks.has(node)) return { text: clip(gChunks.get(node).title ?? ''), deleted: false };
      if (gEnts.has(node)) return { text: clip(gEnts.get(node).name ?? ''), deleted: false };
      if (gNotes.has(node)) return { text: clip(gNotes.get(node).text ?? ''), deleted: false };
      return { text: null, deleted: true };
    };

    // 「忽然想起」的旧消息可能是很早以前的：先在当天里找，找不到再扫一遍全部存档（只在需要时）。
    let fullMsg = null;
    const findMsg = (node) => {
      if (msgAny.has(node)) return msgAny.get(node);
      if (!fullMsg) {
        fullMsg = new Map();
        for (const ent of archEntries ?? []) {
          const k = dirToKey(ent.name);
          if (!ent.isDirectory() || !k) continue;
          let names = [];
          try { names = fs.readdirSync(path.join(archiveRoot, ent.name)).filter((x) => /^\d{4}-\d{2}\.jsonl$/.test(x)); } catch {}
          for (const nm of names) {
            for (const row of readJsonl(path.join(archiveRoot, ent.name, nm)).rows) {
              if (row.deleted === true) continue;
              const nd = msgNode(row);
              if (nd) fullMsg.set(nd, { row, key: k });
            }
          }
        }
      }
      return fullMsg.get(node) ?? null;
    };

    for (const ev of raw) {
      if (ev.pending === 'search') {
        let anyDeleted = false;
        ev.data.items = ev.nodes.map((node) => {
          const it = { node, day: null, title: null, summary: null, line: null };
          if (node.startsWith('chunk:') || node.startsWith('sum:')) {
            if (graph) {
              const s = gSums.get(node); const c = gChunks.get(node) ?? (s ? gChunks.get(`chunk:${s.chunk_id}`) : null);
              if (!s && !gChunks.has(node)) { it.deleted = true; anyDeleted = true; }
              it.day = s?.day ?? c?.day ?? null;
              it.title = clip(s?.title ?? c?.title ?? null);
              it.summary = s ? clip(s.summary ?? '') : null;
            }
          } else if (node.startsWith('msg:')) {
            const m = ev.key ? msgByNode.get(`${ev.key}|${node}`) : null;
            if (m) { it.day = dayOf(timeOf(m.t)); it.line = clip(m.text ?? ''); }
          }
          return it;
        });
        if (anyDeleted) ev.data.deleted = true;
      } else if (ev.pending === 'recall') {
        let anyDeleted = false;
        ev.data.items = ev.nodes.filter((x) => x.startsWith('ltm:')).map((node) => {
          const d = ltmData(node);
          if (d.deleted) anyDeleted = true;
          return { node, text: d.text, memory: null, ...(d.deleted ? { deleted: true } : {}) };
        });
        if (anyDeleted) ev.data.deleted = true;
      } else if (ev.pending === 'life.recall') {
        const node = ev.data.node;
        if (node?.startsWith('ltm:')) {
          const d = ltmData(node);
          ev.data.text = d.text;
          if (d.deleted) ev.data.deleted = true;
          // 私聊里记的条目只属于那个会话（与 long-memory 的 visible 一致）
          if (d.item?.scope === 'private' && KEY_RE.test(String(d.item.sourceKey ?? ''))) ev.key = d.item.sourceKey;
        } else if (node?.startsWith('msg:')) {
          const m = archEntries ? findMsg(node) : null;
          ev.data.text = m ? clip(m.row.text ?? '') : null;
          // 想起的是哪个会话里的话，就算那个会话的事：按 key 过滤时别的会话看不到这段原文
          if (m) ev.key = m.key;
          if (!m && archEntries) ev.data.deleted = true;
        } else if (node?.startsWith('sum:')) {
          const r = ragText(node);
          ev.data.text = r.text;
          if (r.deleted) ev.data.deleted = true;
        } else if (node?.startsWith('diary:')) {
          // 日记不会被这套系统删除；历史里存了前 20 字的预览，够面板显示。
          ev.data.text = ev.preview ? clip(ev.preview) : null;
        }
      } else if (ev.pending === 'suggest.shown') {
        let anyDeleted = false;
        ev.data.items = ev.data.items.map(({ node }) => {
          const r = ragText(node);
          if (r.deleted) anyDeleted = true;
          return { node, text: r.text, ...(r.deleted ? { deleted: true } : {}) };
        });
        if (anyDeleted) ev.data.deleted = true;
      }
    }

    // ── 10. 排序、编号、截断 ───────────────────────────────────────────
    // 同一时刻：存档（消息）在前，其余按来源稳定顺序。
    raw.forEach((e, i) => { e.seq = i; });
    raw.sort((a, b) => a.at - b.at || a.seq - b.seq);
    // life.recall 的 key 要等取到原文才知道，所以 key 过滤在这里再做一遍。
    let list = raw.filter((e) => keyOk(e.key));
    if (list.length > MAX_EVENTS) {
      note(`这一天的事件超过 ${MAX_EVENTS} 条，只回放最早的 ${MAX_EVENTS} 条`);
      list = list.slice(0, MAX_EVENTS);
    }
    const events = list.map((e, i) => {
      const out = {
        id: `r${i + 1}`, at: e.at, type: e.type, key: e.key ?? null, origin: e.origin,
        region: e.region ?? REGION[e.type] ?? 'output', nodes: cleanNodes(e.nodes), data: e.data, replay: true
      };
      if (e.shadow === true) out.shadow = true;
      return out;
    });
    return { ok: true, day: String(day), partial, notes, events };
  }

  return { replay };
}

/**
 * tool-calls 的 args：桥接写的是脱敏后的 JSON 字符串（sanitizeToolArgs），可能还是多层字符串。
 * 只取 query / keywords / from / to 四个字段；其它字段（含任何 token）一律不读出来。
 */
function parseArgs(args) {
  let v = args;
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch { break; }
  }
  const out = { query: null, keywords: [], from: null, to: null };
  if (!plain(v)) return out;
  out.query = noToken(v.query);
  let kw = v.keywords;
  if (typeof kw === 'string') kw = kw.split(/[\s,，、;；]+/u);
  if (Array.isArray(kw)) {
    for (const w of kw) {
      const s = noToken(typeof w === 'number' ? String(w) : w);
      if (s && !out.keywords.includes(s)) out.keywords.push(s.slice(0, 40));
      if (out.keywords.length >= 12) break;
    }
  }
  if (typeof v.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.from)) out.from = v.from;
  if (typeof v.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.to)) out.to = v.to;
  return out;
}
