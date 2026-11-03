// brain-feed.js · 实时脑图（/brain）的事件总线（BRAIN_PATCH）
//
// 规格：docs/design/BRAIN_LIVE_SPEC.md；接口约定（以它为准）：docs/design/worker-kit/brain/contract.md。
//
// 这条通道是**只读**的旁路：她每用到一个记忆模块，桥接就 emit 一个事件。为了让主路径零影响：
//   - emit 同步、不抛、不 await；挂点自己出错只告警一次；
//   - 包装器（tapLtm / tapDecay）对被包方法的返回值、异常、this、调用次数完全透明；
//   - 没有页面连着时不组装原文（payload.data 可以是函数，只有 active() 时才调用）；
//   - 原文只在内存（环形缓冲 + SSE）；落盘的轨迹只有编号和数字，写入前过显式白名单
//     （filterTraceRecord，测试直接测它）。删存档时自然删不到原文副本——因为根本没有副本。
import fs from 'node:fs';
import path from 'node:path';
import {
  retrievability, initialStability, initialDifficulty, ltmUnitMeta, msgUnitMeta, diaryUnitMeta
} from './memory-decay.js';

const DAY = 86400000;

// ── 白名单常量（约定 §2 / §3 / §6） ─────────────────────────────────────────
export const NODE_RE = /^(ltm|chunk|sum|ent|note|diary|msg|persona):[A-Za-z0-9:_.\-]{1,80}$/;
export const KEY_RE = /^(private|group):\d{1,15}$/;
const ENUM_RE = /^[a-z0-9._-]{1,32}$/;
export const ORIGINS = Object.freeze(['ai', 'bridge', 'console']);
export const REGIONS = Object.freeze(['input', 'vision', 'audio', 'working', 'hippo', 'graph', 'ltm', 'core', 'decay', 'limbic', 'life', 'output', 'introspect']);

/** 事件类型 → 脑区（约定 §3）。tool 按工具名另算（regionFor）。 */
export const TYPE_REGION = Object.freeze({
  'msg.in': 'input',
  'msg.out': 'output',
  wake: 'working',
  inject: 'output',
  search: 'core',
  recall: 'core',
  remember: 'hippo',
  update: 'hippo',
  forget: 'decay',
  'decay.review': 'decay',
  'recall.auto': 'core',
  'life.ownLife': 'life',
  'life.recall': 'life',
  'life.assoc': 'life',
  'life.promiseDue': 'life',
  'suggest.shown': 'introspect',
  'suggest.adopted': 'introspect',
  'persona.appraisal': 'limbic',
  'persona.nightly': 'introspect',
  'rag.index': 'hippo',
  'rag.distill': 'hippo',
  tool: 'output'
});
export const EVENT_TYPES = Object.freeze(Object.keys(TYPE_REGION));
const TYPE_SET = new Set(EVENT_TYPES);

const N_KEYS = new Set(['ms', 'items', 'chars', 'added', 'total', 'remainingSlots', 'score', 'tau', 'intensity', 'salience', 'R0', 'R1', 'S0', 'S1', 'rank']);
// BRAIN_PATCH（返工 A2）：加 recall / suggest —— inject 事件的两个布尔，回放从轨迹的 e 里读（约定 §6）。
const E_KEYS = new Set(['src', 'semantic', 'rating', 'kind', 'reason', 'dir', 'source', 'inject', 'pass', 'status', 'tool', 'recall', 'suggest']);

/** tool 事件的脑区：图片 / 表情 → vision；语音 → audio；短期记忆 → working；其它 → output。 */
export function toolRegion(name) {
  const n = String(name ?? '');
  if (n === 'qq_tts_voice' || n === 'send_voice' || /(^|_)send_voice$/.test(n)) return 'audio';
  if (/^qq_memory_/.test(n)) return 'working';
  if (/image|sticker|emoji|face/i.test(n)) return 'vision';
  return 'output';
}

export function regionFor(type, toolName) {
  if (type === 'tool') return toolRegion(toolName);
  return TYPE_REGION[type] ?? 'working';
}

/** 编号列表：只留合法编号、去重、≤ 50 个。 */
export function cleanNodes(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (typeof raw !== 'string' || !NODE_RE.test(raw) || out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * 轨迹行的显式白名单过滤（约定 §6）。不合规的字段一律丢掉；
 * 顶层缺了 id / at / type 这种必需项时整行丢掉（返回 null）。
 * msg.in / msg.out 不写轨迹（回放直接读存档），这里也返回 null。
 */
export function filterTraceRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (!Number.isInteger(rec.id) || !Number.isInteger(rec.at)) return null;
  if (typeof rec.type !== 'string' || !TYPE_SET.has(rec.type)) return null;
  if (rec.type === 'msg.in' || rec.type === 'msg.out') return null;
  const out = { id: rec.id, at: rec.at, type: rec.type };
  out.key = typeof rec.key === 'string' && KEY_RE.test(rec.key) ? rec.key : null;
  if (ORIGINS.includes(rec.origin)) out.origin = rec.origin;
  out.nodes = cleanNodes(rec.nodes);
  if (rec.n && typeof rec.n === 'object' && !Array.isArray(rec.n)) {
    const n = {};
    for (const [k, v] of Object.entries(rec.n)) {
      if (!N_KEYS.has(k)) continue;
      if (k === 'rank') {
        if (Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) n.rank = v.slice();
        continue;
      }
      if (typeof v === 'number' && Number.isFinite(v)) n[k] = v;
    }
    if (Object.keys(n).length) out.n = n;
  }
  if (rec.e && typeof rec.e === 'object' && !Array.isArray(rec.e)) {
    const e = {};
    for (const [k, v] of Object.entries(rec.e)) {
      if (!E_KEYS.has(k)) continue;
      if (typeof v === 'boolean' || (typeof v === 'string' && ENUM_RE.test(v))) e[k] = v;
    }
    if (Object.keys(e).length) out.e = e;
  }
  if (typeof rec.shadow === 'boolean') out.shadow = rec.shadow;
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 本地日期 YYYY-MM-DD。 */
export function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function shiftDay(ts, delta) {
  const d = new Date(ts);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta).getTime());
}

const clipChars = (s, n) => {
  const chars = [...String(s ?? '')];
  return chars.length > n ? chars.slice(0, n).join('') : chars.join('');
};

/** 面板载荷：字符串一律截到 300 字并去掉已知令牌；深度与数组长度有上限，防止意外的大对象。 */
function clipData(value, redact, depth = 0) {
  if (typeof value === 'string') {
    let s = value;
    try { s = String(redact(s)); } catch { /* redact 出错就用原样（它只是纵深防御） */ }
    return clipChars(s, 300);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return Number.isNaN(value) ? null : value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => clipData(v, redact, depth + 1)).map((v) => (v === undefined ? null : v));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clipData(v, redact, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

export function createBrainFeed({
  log = () => {},
  now = () => Date.now(),
  bufferSize = 300,
  maxClients = 4,
  stateDir = null,
  isEnabled = () => true,
  redact = (s) => s,
  pingMs = 15000,
  retentionDays = 7
} = {}) {
  const nowMs = () => {
    try {
      const t = Number(now());
      return Number.isFinite(t) ? t : Date.now();
    } catch { return Date.now(); }
  };
  const enabled = () => {
    try { return isEnabled() !== false; } catch { return false; }
  };
  const traceDir = stateDir ? path.join(stateDir, 'brain', 'trace') : null;

  let seq = 0;
  const buffer = [];
  const clients = new Set();
  // 今天各脑区的事件数（快照用）。启动时从今天的轨迹补一次；msg.* 不写轨迹，只在内存里数。
  let countsDay = '';
  let counts = {};

  const warned = new Set();
  function warnOnce(tag, error) {
    if (warned.has(tag)) return;
    warned.add(tag);
    // 只写类别：错误信息里可能带路径，但不会带原文（原文从不进这条路径）。
    try { log(`[brain] ${tag}失败（只提示一次）：${error?.code ?? error?.name ?? 'error'}`); } catch { /* 日志也坏了就算了 */ }
  }

  function bump(region, at) {
    const day = localDay(at);
    if (day !== countsDay) { countsDay = day; counts = {}; }
    counts[region] = (counts[region] ?? 0) + 1;
  }

  function loadTodayCounts() {
    try {
      const t = nowMs();
      countsDay = localDay(t);
      counts = {};
      if (!traceDir) return;
      let text = '';
      try { text = fs.readFileSync(path.join(traceDir, `${countsDay}.jsonl`), 'utf8'); } catch { return; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || !TYPE_SET.has(rec.type)) continue;
        // 轨迹里的 id 是上一次进程的；本进程从 1 开始（约定 §4.1），这里只数脑区、不续号。
        const r = regionFor(rec.type, rec.e?.tool);
        counts[r] = (counts[r] ?? 0) + 1;
      }
    } catch (e) { warnOnce('读今天的轨迹计数', e); }
  }

  function writeTrace(rec) {
    if (!traceDir) return;
    const clean = filterTraceRecord(rec);
    if (!clean) return;
    try {
      fs.mkdirSync(traceDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(traceDir, `${localDay(clean.at)}.jsonl`), JSON.stringify(clean) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      warnOnce('写轨迹', e);
    }
  }

  /** 删掉更早的轨迹：只留今天和往前 retentionDays-1 天（共 retentionDays 天，与回放的 7 天窗口一致）。 */
  function cleanupTrace() {
    if (!traceDir) return 0;
    let removed = 0;
    try {
      const oldest = shiftDay(nowMs(), -(retentionDays - 1));
      let names = [];
      try { names = fs.readdirSync(traceDir); } catch { return 0; }
      for (const name of names) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!m || m[1] >= oldest) continue;
        try { fs.unlinkSync(path.join(traceDir, name)); removed += 1; } catch (e) { warnOnce('清理轨迹', e); }
      }
    } catch (e) { warnOnce('清理轨迹', e); }
    return removed;
  }

  function active() { return clients.size > 0 && enabled(); }

  function clientWants(client, ev) {
    return !client.key || ev.key === null || ev.key === client.key;
  }

  function writeClient(client, text) {
    try { client.res.write(text); } catch (e) { dropClient(client); }
  }

  function sendEvent(client, ev) {
    writeClient(client, `id: ${ev.id}\nevent: brain\ndata: ${JSON.stringify(ev)}\n\n`);
  }

  function dropClient(client) {
    if (!clients.has(client)) return;
    clients.delete(client);
    try { clearInterval(client.ping); } catch {}
    try { client.res.end(); } catch {}
  }

  /**
   * 发一个事件。payload：{ key, origin, nodes, n, e, shadow, tool, data }，
   * data 可以是函数（只有页面连着时才调用）。返回事件 id；关着 / 出错返回 null。绝不抛。
   */
  function emit(type, payload = {}) {
    try {
      if (!enabled()) return null;
      if (!TYPE_SET.has(type)) return null;
      const p = payload && typeof payload === 'object' ? payload : {};
      const at = Math.round(nowMs());
      const id = ++seq;
      const key = typeof p.key === 'string' && KEY_RE.test(p.key) ? p.key : null;
      const origin = ORIGINS.includes(p.origin) ? p.origin : 'bridge';
      const nodes = cleanNodes(p.nodes);
      const toolName = type === 'tool' ? String(p.tool ?? '') : '';
      const region = regionFor(type, toolName);
      bump(region, at);
      const shadow = p.shadow === true;
      writeTrace({ id, at, type, key, origin, nodes, n: p.n, e: p.e, ...(shadow ? { shadow: true } : {}) });
      if (!active()) return id;
      let data = {};
      try {
        const raw = typeof p.data === 'function' ? p.data() : p.data;
        data = clipData(raw ?? {}, redact) ?? {};
      } catch (e) {
        warnOnce(`组装 ${type} 载荷`, e);
        data = {};
      }
      const ev = { id, at, type, key, origin, region, nodes, data, ...(shadow ? { shadow: true } : {}) };
      buffer.push(ev);
      while (buffer.length > bufferSize) buffer.shift();
      for (const client of [...clients]) if (clientWants(client, ev)) sendEvent(client, ev);
      return id;
    } catch (e) {
      warnOnce('发事件', e);
      return null;
    }
  }

  /**
   * SSE（约定 §4.3）。调用方已经做完鉴权与开关判断；headers 是控制台同款安全头。
   * 第 5 个连接回 429。
   */
  function handleEvents(req, res, { key = null, lastEventId = null, headers = {} } = {}) {
    if (clients.size >= maxClients) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify({ ok: false, error: `实时脑图同时最多 ${maxClients} 个连接` }));
      return null;
    }
    const k = typeof key === 'string' && KEY_RE.test(key) ? key : null;
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    });
    const client = { res, key: k, ping: null };
    clients.add(client);
    try { req.socket?.setTimeout?.(0); } catch {}
    writeClient(client, 'retry: 3000\n\n');
    writeClient(client, `event: hello\ndata: ${JSON.stringify({ enabled: true, lastId: seq })}\n\n`);
    const last = Number(lastEventId);
    if (lastEventId !== null && lastEventId !== undefined && lastEventId !== '' && Number.isFinite(last)) {
      for (const ev of buffer) if (ev.id > last && clientWants(client, ev)) sendEvent(client, ev);
    }
    client.ping = setInterval(() => {
      // 开关被手改（config.json）时，最迟一次心跳内断开（POST 接口会立刻断开）。
      if (!enabled()) { closeAll(); return; }
      writeClient(client, ': ping\n\n');
    }, pingMs);
    client.ping.unref?.();
    const cleanup = () => dropClient(client);
    req.on?.('close', cleanup);
    res.on?.('close', cleanup);
    res.on?.('error', cleanup);
    return client;
  }

  /**
   * 删除跟随：从环形缓冲删掉含这些编号的事件；reload 且给了会话时，该会话的
   * msg.* / search / persona.appraisal 事件全删（页面重拉快照）。再通知所有相关页面。
   */
  function drop({ nodes = [], key = null, reload = false } = {}) {
    try {
      const ids = new Set(cleanNodes(nodes));
      const k = typeof key === 'string' && KEY_RE.test(key) ? key : null;
      const reloadTypes = new Set(['msg.in', 'msg.out', 'search', 'persona.appraisal']);
      for (let i = buffer.length - 1; i >= 0; i -= 1) {
        const ev = buffer[i];
        const hit = ev.nodes.some((n) => ids.has(n));
        const wipe = reload && k && ev.key === k && reloadTypes.has(ev.type);
        if (hit || wipe) buffer.splice(i, 1);
      }
      if (!clients.size) return;
      const text = `event: drop\ndata: ${JSON.stringify({ nodes: [...ids], key: k, reload: reload === true })}\n\n`;
      for (const client of [...clients]) {
        if (!client.key || !k || client.key === k) writeClient(client, text);
      }
    } catch (e) { warnOnce('删除跟随', e); }
  }

  function closeAll() {
    for (const client of [...clients]) dropClient(client);
  }

  function regionCounts() {
    const today = localDay(nowMs());
    if (today !== countsDay) { countsDay = today; counts = {}; }
    const out = {};
    for (const r of REGIONS) out[r] = counts[r] ?? 0;
    return out;
  }

  // ── 包装器（约定 §8） ──────────────────────────────────────────────────────
  // 被包方法先原样调用（异常原样往外抛，不经过任何 catch），之后挂点自己 try/catch。
  function wrap(obj, name, after, before = null) {
    const orig = obj?.[name];
    if (typeof orig !== 'function' || orig.__brainTapped) return;
    const wrapped = function (...args) {
      let pre;
      if (before) { try { pre = before(args); } catch (e) { warnOnce(`挂点 ${name}`, e); } }
      const result = orig.apply(this, args);
      try { after(args, result, pre); } catch (e) { warnOnce(`挂点 ${name}`, e); }
      return result;
    };
    Object.defineProperty(wrapped, '__brainTapped', { value: true });
    obj[name] = wrapped;
  }

  const msgNode = (msgId, at) => {
    if (msgId !== null && msgId !== undefined && String(msgId) !== '') return `msg:${String(msgId)}`;
    const d = at ? new Date(at) : new Date(nowMs());
    return Number.isFinite(d.getTime()) ? `msg:${d.toISOString()}` : null;
  };
  const kind = (s) => (typeof s === 'string' && ENUM_RE.test(s) ? s : undefined);

  function tapLtm(ltm) {
    if (!ltm || typeof ltm !== 'object') return ltm;
    wrap(ltm, 'archive', (args) => {
      const [key, row] = args;
      const r = row && typeof row === 'object' ? row : {};
      if (r.dir !== 'in' && r.dir !== 'out') return;
      if (!String(r.text ?? '').trim()) return; // 空消息 archive 本来就不写
      const node = msgNode(r.msgId, r.at);
      emit(r.dir === 'in' ? 'msg.in' : 'msg.out', {
        key, origin: 'bridge', nodes: node ? [node] : [],
        e: { dir: r.dir },
        data: () => ({
          dir: r.dir,
          userId: r.userId == null ? null : String(r.userId),
          name: String(r.name ?? ''),
          text: String(r.text ?? '').trim(),
          msgId: r.msgId == null ? null : String(r.msgId)
        })
      });
    });
    wrap(ltm, 'remember', (args, r) => {
      const a = args[0] ?? {};
      if (!r?.item?.id) return;
      const node = `ltm:${r.item.id}`;
      const replaces = r.replaced?.id ? `ltm:${r.replaced.id}` : null;
      // AI 通道总会带 replaces 这个参数（值可能是 undefined），控制台的「添加」不带。
      const origin = Object.prototype.hasOwnProperty.call(a, 'replaces') ? 'ai' : 'console';
      emit('remember', {
        key: a.sourceKey, origin, nodes: [node, replaces].filter(Boolean),
        e: { kind: kind(r.item.cat), ...(r.duplicate ? { status: 'duplicate' } : {}) },
        data: () => {
          let similar = [];
          if (!r.duplicate) {
            try {
              similar = (ltm.similarItems?.(a.userId, r.item.text, { viewerKey: a.sourceKey, excludeIds: [r.item.id, r.replaced?.id].filter(Boolean) }) ?? [])
                .map((x) => `ltm:${x.id}`);
            } catch { similar = []; }
          }
          let name = String(a.name ?? '');
          if (!name) { try { name = String(ltm.personView?.(a.userId)?.name ?? ''); } catch { name = ''; } }
          return { node, text: r.item.text, cat: r.item.cat, userId: String(a.userId ?? ''), name, replaces, similar };
        }
      });
    });
    wrap(ltm, 'update', (args, it) => {
      const a = args[0] ?? {};
      if (!it?.id) return;
      const node = `ltm:${it.id}`;
      emit('update', {
        key: a.viewerKey ?? it.sourceKey, origin: a.viewerKey ? 'ai' : 'console', nodes: [node],
        e: { kind: kind(it.cat), ...(kind(a.status) ? { status: a.status } : {}) },
        data: () => ({
          node, text: it.text, cat: it.cat,
          outdated: typeof a.outdated === 'boolean' ? a.outdated : null,
          archived: typeof a.archived === 'boolean' ? a.archived : null,
          status: typeof a.status === 'string' ? a.status : null
        })
      });
    });
    wrap(ltm, 'forget', (args, removed) => {
      const a = args[0] ?? {};
      if (!removed?.id) return;
      const node = `ltm:${removed.id}`;
      // 先删缓冲里含它的旧事件（原文），再发 forget 本身（只带编号）。
      drop({ nodes: [node] });
      emit('forget', { key: a.viewerKey ?? removed.sourceKey, origin: a.viewerKey ? 'ai' : 'console', nodes: [node], data: { node } });
    });
    wrap(ltm, 'deleteArchiveRows', (args, r) => {
      const [key, opts] = args;
      if (opts?.dryRun === true) return;
      if (!r || !(Number(r.deleted) > 0)) return;
      drop({ nodes: [], key, reload: true });
    });
    return ltm;
  }

  function tapDecay(decay) {
    if (!decay || typeof decay !== 'object') return decay;
    const stateOf = decay.state;
    wrap(decay, 'review', (args, result, before) => {
      if (!result || typeof result !== 'object') return; // false = 冷却中 / 没记上
      const [unit, , rating] = args;
      if (typeof unit !== 'string') return;
      const R0 = Number(before?.R);
      const S0 = Number(before?.S);
      const n = { R1: Number(result.R), S1: Number(result.S) };
      if (Number.isFinite(R0)) n.R0 = R0;
      if (Number.isFinite(S0)) n.S0 = S0;
      const key = null;
      emit('decay.review', {
        key, origin: 'bridge', nodes: [unit], n, e: { rating: kind(rating) },
        data: () => ({
          unit, rating,
          before: before ? { R: before.R, S: before.S } : null,
          after: { R: result.R, S: result.S }
        })
      });
    }, (args) => {
      // 复习前的状态：只在开着时多算一次（state 是纯计算，不写盘）。
      if (!enabled() || typeof stateOf !== 'function') return null;
      return stateOf.call(decay, args[0], args[1]);
    });
    // drop 只是删复习记录（条目本身的删除由 ltm.forget 负责发事件）；包上只为统一透明性约定。
    wrap(decay, 'drop', () => {});
    return decay;
  }

  // ── 快照（约定 §5.4） ──────────────────────────────────────────────────────
  const CAP = 2000;
  const capLatest = (list, cap = CAP) => {
    const sorted = [...list].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    return { kept: sorted.slice(0, cap), cut: Math.max(0, sorted.length - cap) };
  };

  function readDiaryRows(diaryDir) {
    if (!diaryDir) return [];
    let text = '';
    try { text = fs.readFileSync(path.join(diaryDir, 'index.jsonl'), 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const r = JSON.parse(s);
        const t = Number(r?.t);
        if (!Number.isFinite(t)) continue;
        rows.push({ t, title: String(r.title ?? ''), text: String(r.text ?? '') });
      } catch { /* 坏行跳过 */ }
    }
    return rows;
  }

  /** suggest-state.json → note_id → state（约定 §5.4 的五种）。 */
  function readNoteStates(file) {
    const out = new Map();
    if (!file) return out;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return out; }
    const items = raw?.items && typeof raw.items === 'object' ? raw.items : {};
    for (const [id, entry] of Object.entries(items)) {
      const st = entry?.status;
      let s = 'pending';
      if (st === 'adopted') s = 'adopted';
      else if (st === 'dismissed') s = 'dismissed';
      else if (st === 'expired' || st === 'duplicate') s = 'expired';
      else if (Number(entry?.shown) > 0) s = 'shown';
      out.set(id, s);
    }
    return out;
  }

  const numOnly = (obj) => {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      const n = v && typeof v === 'object' ? Number(v.value) : Number(v);
      if (typeof (v && typeof v === 'object' ? v.value : v) === 'number' && Number.isFinite(n)) out[k] = n;
    }
    return out;
  };

  /**
   * 组装快照。依赖全部由调用方传入（便于测试）；任何一块出错只少那一块。
   * ltmDecay(item, userId) → { R, S, frozen, exempt } | null。
   */
  async function snapshot({ ltm = null, ltmDecay = null, rag = null, persona = null, diaryDir = null, suggestStatePath = null, labelFor = null, freezeBelow = 0.5, key = null } = {}) {
    const k = typeof key === 'string' && KEY_RE.test(key) ? key : null;
    const nodes = [];
    const links = [];
    const truncated = { chunk: 0, sum: 0, ent: 0, note: 0, ltm: 0, diary: 0 };
    const keySet = new Set();

    // 账本
    try {
      const all = [];
      for (const p of ltm?.listPeople?.() ?? []) {
        const v = ltm.personView(p.userId);
        if (!v) continue;
        for (const it of v.items ?? []) {
          const sk = typeof it.sourceKey === 'string' && KEY_RE.test(it.sourceKey) ? it.sourceKey : null;
          if (k && sk !== k && !(k === `private:${p.userId}` && it.scope !== 'private')) continue;
          let decay = null;
          try { decay = ltmDecay ? ltmDecay(it, p.userId) : null; } catch { decay = null; }
          all.push({
            id: `ltm:${it.id}`, kind: 'ltm', key: sk, at: Date.parse(it.at) || 0, label: clipChars(it.text, 40),
            text: it.text, cat: it.cat, userId: String(p.userId), name: v.name ?? '', scope: it.scope ?? null,
            core: !!it.core, due: it.due ?? null, status: it.status ?? null,
            archivedAt: it.archivedAt ?? null, outdatedAt: it.outdatedAt ?? null, decay
          });
        }
      }
      const c = capLatest(all);
      nodes.push(...c.kept);
      truncated.ltm = c.cut;
    } catch (e) { warnOnce('快照（账本）', e); }
    try { for (const kk of ltm?.archiveKeys?.() ?? []) if (KEY_RE.test(String(kk))) keySet.add(String(kk)); } catch {}

    // memory-rag
    let ragState = 'off';
    try {
      const on = rag && (typeof rag.enabled !== 'function' || rag.enabled());
      if (on) {
        const g = typeof rag.graph === 'function' ? await rag.graph({ keys: k ? [k] : null, limit: CAP }) : null;
        if (!g || g.ok === false) ragState = 'unavailable';
        else {
          ragState = 'ok';
          const noteStates = readNoteStates(suggestStatePath);
          for (const ch of g.chunks ?? []) {
            if (k && ch.key !== k) continue;
            if (KEY_RE.test(String(ch.key))) keySet.add(String(ch.key));
            nodes.push({
              id: `chunk:${ch.chunk_id}`, kind: 'chunk', key: ch.key ?? null, at: Number(ch.t_end) || 0, label: clipChars(ch.title, 40),
              day: ch.day ?? '', title: ch.title ?? '', n_msgs: Number(ch.n_msgs) || 0,
              speakers: Array.isArray(ch.speaker_names) ? ch.speaker_names.map(String) : []
            });
          }
          for (const s of g.summaries ?? []) {
            if (k && s.key !== k) continue;
            nodes.push({
              id: `sum:${s.summary_id}`, kind: 'sum', key: s.key ?? null, at: Number(s.t_end) || 0, label: clipChars(s.title || s.summary, 40),
              day: s.day ?? '', title: s.title ?? '', summary: s.summary ?? '', importance: s.importance ?? null, valence: s.valence ?? null,
              chunk: `chunk:${s.chunk_id}`
            });
            links.push({ src: `sum:${s.summary_id}`, dst: `chunk:${s.chunk_id}`, kind: 'sum-chunk' });
          }
          for (const en of g.entities ?? []) {
            nodes.push({ id: `ent:${en.entity_id}`, kind: 'ent', key: null, at: 0, label: clipChars(en.name, 40), name: en.name ?? '', type: en.type ?? '', n: Number(en.n) || 0 });
          }
          for (const se of g.summary_entities ?? []) {
            if (k && se.key !== k) continue;
            links.push({ src: `sum:${se.summary_id}`, dst: `ent:${se.entity_id}`, kind: 'sum-ent' });
          }
          for (const rel of g.relations ?? []) {
            if (k && rel.key !== k) continue;
            links.push({ src: `ent:${rel.src_id}`, dst: `ent:${rel.dst_id}`, kind: 'rel', relation: rel.relation ?? '' });
          }
          for (const nt of g.notes ?? []) {
            if (k && nt.key !== k) continue;
            nodes.push({
              id: `note:${nt.note_id}`, kind: 'note', key: nt.key ?? null, at: Number(nt.created_at) || 0, label: clipChars(nt.text, 40),
              text: nt.text ?? '', cat: nt.cat ?? '', who: nt.who ?? '', whoName: nt.who_name ?? '',
              state: noteStates.get(nt.note_id) ?? 'pending'
            });
            if (nt.summary_id) links.push({ src: `note:${nt.note_id}`, dst: `sum:${nt.summary_id}`, kind: 'note-sum' });
          }
          const t = g.truncated ?? {};
          truncated.chunk = Number(t.chunks) || 0;
          truncated.sum = Number(t.summaries) || 0;
          truncated.ent = Number(t.entities) || 0;
          truncated.note = Number(t.notes) || 0;
        }
      }
    } catch (e) { ragState = 'unavailable'; warnOnce('快照（memory-rag）', e); }

    // 日记
    try {
      const rows = readDiaryRows(diaryDir).map((r) => ({
        id: `diary:${r.t}`, kind: 'diary', key: null, at: r.t, label: clipChars(r.title || r.text, 40),
        title: r.title, excerpt: clipChars(r.text, 120)
      }));
      const c = capLatest(rows);
      nodes.push(...c.kept);
      truncated.diary = c.cut;
    } catch (e) { warnOnce('快照（日记）', e); }

    // 人格（只有数字和名字）
    try {
      const pc = persona?.console;
      if (pc) {
        const st = pc.status();
        if (st?.initialized && st.core) {
          nodes.push({
            id: 'persona:core', kind: 'persona', key: null, at: 0, label: '人格',
            big5: numOnly(st.core.traits), traits: numOnly(st.core.character), emotion: numOnly(st.emotion?.core)
          });
          for (const p of pc.people() ?? []) {
            if (!/^\d{1,15}$/.test(String(p.userId))) continue;
            nodes.push({
              id: `persona:rel:${p.userId}`, kind: 'persona', key: null, at: Number(p.lastSeenAt) || 0, label: clipChars(p.name || p.userId, 40),
              name: p.name ?? '', rel: { stage: p.stage ?? null, intimacy: p.intimacy ?? null, trust: p.trust ?? null, familiarity: p.familiarity ?? null }
            });
          }
        }
      }
    } catch (e) { warnOnce('快照（人格）', e); }

    const keys = [...keySet].sort().map((kk) => {
      let label = kk;
      try { label = (labelFor ? labelFor(kk) : null) || kk; } catch { label = kk; }
      return { key: kk, kind: kk.startsWith('group:') ? 'group' : 'private', label };
    });
    return { ok: true, at: Math.round(nowMs()), rag: ragState, keys, nodes, links, regions: regionCounts(), truncated, freezeBelow };
  }

  // ── 遗忘曲线（约定 §5.3 decay-curve） ───────────────────────────────────────
  /**
   * unit：ltm:<id> / msg:<id 或 ISO 时间> / diary:<t>。findLtm(id) → { item, userId } | null。
   * 返回 null = 找不到这个单元（调用方回 404）。
   */
  function decayCurve({ unit, decay = null, findLtm = null, ownerQQ = '', intimacyOf = () => undefined } = {}) {
    const u = String(unit ?? '');
    if (!NODE_RE.test(u)) return null;
    const [prefix, ...rest] = u.split(':');
    const idPart = rest.join(':');
    let meta;
    if (prefix === 'ltm') {
      const found = findLtm ? findLtm(idPart) : null;
      if (!found?.item) return null;
      let intimacy;
      try { intimacy = intimacyOf(found.userId); } catch { intimacy = undefined; }
      meta = ltmUnitMeta(found.item, { ownerQQ, userId: found.userId, intimacy });
    } else if (prefix === 'msg') {
      meta = msgUnitMeta({ t: idPart });
    } else if (prefix === 'diary') {
      if (!Number.isFinite(Number(idPart))) return null;
      meta = diaryUnitMeta({ t: Number(idPart) });
    } else {
      return null;
    }
    const freezeBelow = Number.isFinite(decay?.freezeBelow) ? decay.freezeBelow : 0.5;
    let st = null;
    try { st = decay?.state?.(u, meta) ?? null; } catch { st = null; }
    const hasRecord = !!st && Number(st.reps) > 0;
    let S;
    let D;
    let R0;
    let offset = 0;
    if (hasRecord) {
      S = st.S;
      D = st.D;
      R0 = st.R;
      offset = Math.max(0, (nowMs() - Number(st.last)) / DAY);
    } else {
      S = initialStability(meta);
      D = initialDifficulty(meta);
      R0 = 1;
    }
    const exempt = !!meta.exempt;
    const points = [];
    let frozenAtDay = null;
    for (let d = 0; d <= 365; d += 1) {
      const R = retrievability(offset + d, S);
      points.push({ day: d, R: Math.round(R * 10000) / 10000 });
      if (frozenAtDay === null && !exempt && R < freezeBelow) frozenAtDay = d;
    }
    return { ok: true, unit: u, R0, S, D, freezeBelow, exempt, frozenAtDay, points };
  }

  loadTodayCounts();
  cleanupTrace();

  return {
    active, emit, tapLtm, tapDecay, handleEvents, snapshot, drop, closeAll, regionCounts, cleanupTrace, decayCurve,
    clients: () => clients.size,
    lastId: () => seq,
    bufferedEvents: () => buffer.slice()
  };
}
