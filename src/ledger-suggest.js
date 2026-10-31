// ledger-suggest.js · 账本建议（SUGGEST_PATCH，docs/design/LEDGER_SUGGEST_SPEC.md §4）
//
// 为什么单独成模块：候选的挑选、块的拼装、出现次数、采用判定、状态文件、控制台列表
// 全在这里；bridge.js 只做接线（唤醒时问一句、投递成功后计次、她记账后判采用）。
//
// 数据从哪来：memory-rag 的 /notes（提炼器在同一次调用里顺带抽的「关于某个人、值得长期
// 记住的事」）。桥接问的是**当前会话**，服务端按 key 过滤；本模块再按状态文件与账本去重。
//
// 安全边界：候选原文只在内存里转一手（拼提示词、判采用），**绝不落盘、绝不进日志**；
// 状态文件只有编号、会话 key、类别人名和数字（与摘要同等对待，见规格 §6）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const DAY_MS = 86400000;
// 规格 §4.7：不是 open 且 statusAt 超过 14 天、或 firstSeenAt 超过 14 天的，下次写盘时清掉。
const KEEP_MS = 14 * DAY_MS;
const KEY_RE = /^(group|private):\d+$/;
const NOTE_ID_RE = /^[0-9a-f]{16}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 提示词里的类别短名（规格 §4.4 逐字）：trait 喜好习惯、fact 事实、event 经历、pending 约定。
const CAT_SHORT = Object.freeze({ trait: '喜好习惯', fact: '事实', event: '经历', pending: '约定' });
const STATUSES = new Set(['open', 'adopted', 'duplicate', 'expired', 'dismissed']);
const STATUS_TEXT = Object.freeze({ adopted: '已采用', duplicate: '已在账本', expired: '已作废', dismissed: '已手动作废' });
// /notes 一次最多要这么多条（契约 §1：limit 夹到 1～200）。
const NOTES_LIMIT = 200;
// 控制台接口不是唤醒路径，给宽松一点的超时；memory-rag 真的挂了也不能把页面拖太久。
const CONSOLE_MIN_TIMEOUT_MS = 2000;
const MAX_LIST_ITEMS = 300;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时区的日期 `YYYY-MM-DD`（候选的 day 缺失时用它兜底）。 */
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 配置规范化（规格 §4.1）：没配的一律取默认值，看不懂的值夹到安全范围。 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    mode: c.mode === 'off' ? 'off' : 'on',
    perWake: clampInt(c.perWake, 1, 10, 3),
    maxShows: clampInt(c.maxShows, 1, 10, 2),
    ttlHours: clampInt(c.ttlHours, 1, 720, 72),
    timeoutMs: clampInt(c.timeoutMs, 50, 5000, 300)
  };
}

/** 数字字段只认真正的有限数字（契约要求毫秒整数；null / 字符串都算不合法）。 */
function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * /notes 返回的一条候选：字段类型不对的**这一条**丢掉，不影响其它候选。
 * 这里只做最基本的守门；created_at / day 由调用方再兜底。
 */
function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.note_id === 'string' ? raw.note_id : '';
  if (!NOTE_ID_RE.test(id)) return null;
  const who = String(raw.who ?? '').trim();
  if (!/^\d+$/.test(who)) return null;
  if (typeof raw.cat !== 'string' || !CAT_SHORT[raw.cat]) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const createdAt = numOrNull(raw.created_at);
  if (createdAt === null) return null;
  const day = typeof raw.day === 'string' && DAY_RE.test(raw.day) ? raw.day : dayOf(createdAt);
  // due 只在 pending 上可能非空（契约 §1）；其它类别即使带了也不显示。
  const due = raw.cat === 'pending' && typeof raw.due === 'string' && DAY_RE.test(raw.due) ? raw.due : null;
  return {
    id,
    who,
    whoName: typeof raw.who_name === 'string' ? raw.who_name : '',
    cat: raw.cat,
    text,
    due,
    day,
    createdAt,
    importance: numOrNull(raw.importance) ?? 0,
    source: raw.source === 'backfill' ? 'backfill' : 'distill'
  };
}

/** 状态文件里的一条：结构看不懂就丢掉（当空的重来），不让坏数据进内存。 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key : '';
  if (!KEY_RE.test(key)) return null;
  const firstSeenAt = numOrNull(raw.firstSeenAt);
  if (firstSeenAt === null) return null;
  const status = STATUSES.has(raw.status) ? raw.status : 'open';
  return {
    key,
    who: String(raw.who ?? ''),
    cat: CAT_SHORT[raw.cat] ? raw.cat : 'fact',
    shown: Number.isInteger(raw.shown) && raw.shown >= 0 ? raw.shown : 0,
    status,
    firstSeenAt,
    lastShownAt: numOrNull(raw.lastShownAt),
    // open 的条目 statusAt 一律为 null（契约 §3）。
    statusAt: status === 'open' ? null : numOrNull(raw.statusAt)
  };
}

/**
 * 给 Promise 套一个硬超时：到点没回就当这次没有（resolve null）。
 * 客户端自己也有 AbortSignal 超时，这里再兜一层 —— 假服务 / 卡住的连接不能拖住唤醒。
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, Math.max(1, Math.round(ms)));
    // 不 unref：这个定时器最多 5 秒，且唤醒路径上本来就有别的句柄在跑；unref 反而可能让
    // 只有它在等的时候进程提前退出（测试里表现为 unsettled top-level await）。
    Promise.resolve(promise).then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

export function createLedgerSuggest({ rag = null, ltm = null, statePath = null, config = {}, log = () => {}, now = () => Date.now() } = {}) {
  const cfg = normalizeConfig(config);
  const at = () => {
    const t = Number(typeof now === 'function' ? now() : now);
    return Number.isFinite(t) ? t : Date.now();
  };
  const ttlMs = cfg.ttlHours * 3600000;
  const consoleTimeoutMs = Math.max(cfg.timeoutMs, CONSOLE_MIN_TIMEOUT_MS);

  let state = { version: VERSION, items: {} };
  let loaded = false;
  // 候选原文只在内存：会话 key → 最近一次 plan 给她看的那几条（onRemember 判采用用）。
  // 桥接重启后丢了也没关系：下次挑选时会被「账本里已有相似的」判成 duplicate（规格 §4.6）。
  const cache = new Map();

  function freshState() { return { version: VERSION, items: {} }; }

  function load() {
    if (loaded) return;
    loaded = true;
    if (!statePath) return;
    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch (error) {
      // 第一次运行就是没有文件，这是正常情况；其它读失败告警一行（按空的重来）。
      if (error?.code !== 'ENOENT') log(`[suggest] 状态文件读不了（${error?.code ?? 'error'}），按空的重来`);
      return;
    }
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !data.items || typeof data.items !== 'object' || Array.isArray(data.items)) {
        throw new Error('结构不对');
      }
      const items = {};
      for (const [id, entry] of Object.entries(data.items)) {
        const norm = normalizeEntry(entry);
        if (norm) items[id] = norm;
      }
      state = { version: VERSION, items };
    } catch {
      // 读坏了就当空的重来（打一行告警）—— 候选本来就会再抽，不能因为一个坏文件把她带崩。
      log('[suggest] 状态文件内容坏了，按空的重来');
      state = freshState();
    }
  }

  /** 14 天清理（规格 §4.7）：过期归档类看 statusAt，所有条目看 firstSeenAt。 */
  function prune() {
    const t = at();
    for (const [id, entry] of Object.entries(state.items)) {
      const firstTooOld = t - entry.firstSeenAt > KEEP_MS;
      const endedTooOld = entry.status !== 'open' && Number.isFinite(entry.statusAt) && t - entry.statusAt > KEEP_MS;
      if (firstTooOld || endedTooOld) delete state.items[id];
    }
  }

  /** 原子写：同目录临时文件 + rename，权限 600；失败只打一行日志（不带原文）。 */
  function save() {
    if (!statePath) return;
    prune();
    let tmp = null;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      tmp = `${statePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
      try { fs.chmodSync(statePath, 0o600); } catch { /* 权限收紧失败不影响内容 */ }
      tmp = null;
    } catch (error) {
      log(`[suggest] 状态文件写不进去（${error?.code ?? 'error'}）`);
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* 临时文件清不掉也没关系 */ } }
    }
  }

  /** 第一次见到这条候选时建条目（挑选时或核对作废时）。key 不覆盖已有值（会话隔离）。 */
  function ensureEntry(note, key) {
    let entry = state.items[note.id];
    if (!entry) {
      entry = {
        key,
        who: note.who,
        cat: note.cat,
        shown: 0,
        status: 'open',
        firstSeenAt: at(),
        lastShownAt: null,
        statusAt: null
      };
      state.items[note.id] = entry;
      return entry;
    }
    // 候选的类别 / 名字可能因为提炼器重跑而变；状态与次数以本地为准，只同步这两个字段。
    entry.cat = note.cat;
    entry.who = note.who;
    return entry;
  }

  /** 账本里已有相似的条目 = 她其实已经记下了（规格 §4.3 第 3 步）。 */
  function isDuplicate(note, key) {
    try {
      const hits = ltm?.similarItems?.(note.who, note.text, { viewerKey: key, limit: 1 });
      return Array.isArray(hits) && hits.length > 0;
    } catch {
      return false;
    }
  }

  /** 名字三级回退：账本里的名字 → 候选自带的 who_name → 「某人」（规格 §4.4）。 */
  function displayName(note, key) {
    let fromLedger = '';
    try { fromLedger = String(ltm?.personView?.(note.who, key)?.name || ''); } catch { fromLedger = ''; }
    return fromLedger || note.whoName || '某人';
  }

  /** 她看到的块（规格 §4.4 逐字）。picked 为空时返回空串。 */
  function buildBlock(picked) {
    if (!picked.length) return '';
    const lines = ['【最近聊到、还没记进长期记忆的】'];
    for (const note of picked) {
      const day = String(note.day).slice(-5);
      const due = note.due ? `（到期 ${note.due}）` : '';
      lines.push(`- ${day} · ${displayName(note, note.key)}（QQ ${note.who}）· ${CAT_SHORT[note.cat]}(${note.cat})：${note.text}${due}`);
    }
    lines.push('值得长期记住的就用 qq_ltm_remember 记下（可以换成你自己的话；约定记得填 due 和 by）；不值得就不用管。这些只是提醒，不要念出来，也不要为这个去问对方。');
    return lines.join('\n');
  }

  async function fetchNotes(key, sinceMs, timeoutMs) {
    try {
      return await withTimeout(
        rag.notes({ key, sinceMs, limit: NOTES_LIMIT }, { timeoutMs }),
        timeoutMs + 100
      );
    } catch {
      return null;
    }
  }

  /**
   * 这次唤醒给她看什么。返回 { ids, block } 或 null（没有可给的 / 任何失败）。
   * 绝不 reject：plan 在唤醒路径上，出问题只意味着这次不带块。
   */
  async function plan(key) {
    try {
      if (cfg.mode === 'off' || !rag) return null;
      const k = String(key ?? '').trim();
      if (!KEY_RE.test(k)) return null;
      load();
      const t = at();
      const since = t - ttlMs;
      const res = await fetchNotes(k, since, cfg.timeoutMs);
      // 响应 key 对不上（纵深防御）→ 整份丢掉，绝不把别会话的候选交给她。
      if (res && typeof res.key === 'string' && res.key && res.key !== k) {
        log('[suggest] 拒绝候选：响应 key 与请求不一致');
        cache.delete(k);
        return null;
      }
      if (!res || !Array.isArray(res.items)) {
        cache.delete(k);
        return null;
      }

      const candidates = [];
      let expired = 0;
      let duplicate = 0;
      let dirty = false;
      for (const raw of res.items) {
        const note = normalizeNote(raw);
        if (!note) continue;
        const existing = state.items[note.id];
        if (existing && existing.key !== k) continue; // 会话隔离：别的会话的候选绝不带进来
        const entry = ensureEntry(note, k);
        if (entry.status !== 'open') continue;        // 已采用 / 已作废 / 已判过重的都不再给
        // 出现满 maxShows 次、或超过 TTL → 作废（规格 §4.3 第 2 步）。
        if (entry.shown >= cfg.maxShows || note.createdAt + ttlMs <= t) {
          entry.status = 'expired';
          entry.statusAt = t;
          dirty = true;
          expired += 1;
          continue;
        }
        if (isDuplicate(note, k)) {
          entry.status = 'duplicate';
          entry.statusAt = t;
          dirty = true;
          duplicate += 1;
          continue;
        }
        candidates.push(note);
      }

      // 按摘要重要性降序、同分新的在前（规格 §4.3 第 4 步）。
      candidates.sort((a, b) => (b.importance - a.importance) || (b.createdAt - a.createdAt));
      const picked = candidates.slice(0, cfg.perWake);
      // 原文只留在内存里：她这一回合记下的内容要和这几条比相似度。
      cache.set(k, { at: t, items: picked.map((note) => ({ id: note.id, who: note.who, text: note.text })) });
      if (dirty) save();
      if (!picked.length) return null;
      log(`[suggest] ${k} 本次给 ${picked.length} 条候选（作废 ${expired}，已在账本 ${duplicate}）`);
      return {
        ids: picked.map((note) => note.id),
        block: buildBlock(picked.map((note) => ({ ...note, key: k })))
      };
    } catch (error) {
      log(`[suggest] 挑选失败（${error?.code ?? 'error'}）`);
      return null;
    }
  }

  /** 投递被 DSH 接受之后才计次（规格 §4.5）。只动给定 id；同步、不抛。 */
  function markShown(key, ids) {
    try {
      load();
      const k = String(key ?? '');
      const list = Array.isArray(ids) ? ids : [];
      if (!list.length) return;
      const t = at();
      let touched = 0;
      for (const raw of list) {
        const entry = state.items[String(raw ?? '')];
        if (!entry || entry.key !== k) continue;
        entry.shown += 1;
        entry.lastShownAt = t;
        touched += 1;
      }
      if (touched) save();
    } catch (error) {
      log(`[suggest] 计次失败（${error?.code ?? 'error'}）`);
    }
  }

  /**
   * 她刚用 qq_ltm_remember 记下一条 → 看是不是本进程内给她看过的某条候选（规格 §4.6）。
   * 只动状态文件；失败不影响写入，也不改给她的响应。
   */
  function onRemember(key, userId, itemId) {
    try {
      load();
      const k = String(key ?? '');
      const uid = String(userId ?? '').trim();
      const id = String(itemId ?? '').trim();
      if (!uid || !id) return;
      const cached = cache.get(k);
      if (!cached) return;
      const t = at();
      if (t - cached.at > ttlMs) { cache.delete(k); return; }
      let changed = 0;
      for (const cand of cached.items) {
        if (String(cand.who) !== uid) continue;
        const entry = state.items[cand.id];
        if (!entry || entry.key !== k || entry.status !== 'open') continue;
        let hits = [];
        try { hits = ltm?.similarItems?.(uid, cand.text, { viewerKey: k, limit: 3 }) ?? []; } catch { hits = []; }
        if (!Array.isArray(hits) || !hits.some((hit) => String(hit?.id) === id)) continue;
        entry.status = 'adopted';
        entry.statusAt = t;
        changed += 1;
      }
      if (changed) {
        save();
        log(`[suggest] ${k} ${changed} 条候选判为采用`);
      }
    } catch (error) {
      log(`[suggest] 采用判定失败（${error?.code ?? 'error'}）`);
    }
  }

  function archiveKeys() {
    try {
      const keys = ltm?.archiveKeys?.();
      // 排序只为让控制台下拉与接口输出稳定（readdir 的顺序因文件系统而异）。
      return Array.isArray(keys) ? keys.filter((k) => KEY_RE.test(String(k))).sort() : [];
    } catch {
      return [];
    }
  }

  /** memory-rag 不可达时：其余五个计数按状态文件里 firstSeenAt 落在窗口内的条目分组（契约 §2）。 */
  function countsFromState(since) {
    const counts = { created: null, open: 0, adopted: 0, duplicate: 0, expired: 0, dismissed: 0 };
    for (const entry of Object.values(state.items)) {
      if (!(entry.firstSeenAt >= since)) continue;
      counts[entry.status] += 1;
    }
    return counts;
  }

  /**
   * 控制台列表（契约 §2）。返回完整响应体或 null（内部异常）。
   * 只看有存档的会话（与控制台「聊天存档」下拉同一来源）。
   */
  async function list({ days = 7, labelFor = null } = {}) {
    try {
      load();
      const t = at();
      const since = t - Math.max(1, Math.round(Number(days) || 7)) * DAY_MS;
      const keys = archiveKeys();
      const labelOf = (key) => {
        try {
          const label = typeof labelFor === 'function' ? labelFor(key) : '';
          return typeof label === 'string' && label ? label : key;
        } catch { return key; }
      };
      const keyRows = keys.map((key) => ({ key, label: labelOf(key) }));
      // 没配 memory-rag 时 mode 一律报 off（契约 §2）。
      const mode = rag ? cfg.mode : 'off';
      if (!rag) {
        return { ok: true, mode, rag: false, counts: countsFromState(since), keys: keyRows, items: [] };
      }

      const results = await Promise.all(keys.map((key) => fetchNotes(key, since, consoleTimeoutMs)));
      const reachable = results.some((res) => res && Array.isArray(res.items));
      if (!reachable && keys.length) {
        return { ok: true, mode, rag: false, counts: countsFromState(since), keys: keyRows, items: [] };
      }

      const items = [];
      for (let i = 0; i < keys.length; i += 1) {
        const res = results[i];
        if (!res || !Array.isArray(res.items)) continue; // 部分会话不可达：只少这一批
        const key = keys[i];
        for (const raw of res.items) {
          const note = normalizeNote(raw);
          if (!note || note.createdAt < since) continue;
          const entry = state.items[note.id];
          if (entry && entry.key !== key) continue;
          const status = entry ? entry.status : 'open';
          items.push({
            id: note.id,
            key,
            day: note.day,
            createdAt: note.createdAt,
            source: note.source,
            who: note.who,
            whoName: displayName(note, key),
            cat: note.cat,
            text: note.text,
            due: note.due,
            importance: note.importance,
            shown: entry ? entry.shown : 0,
            status,
            statusAt: entry && status !== 'open' ? entry.statusAt : null
          });
        }
      }
      items.sort((a, b) => b.createdAt - a.createdAt);
      const capped = items.slice(0, MAX_LIST_ITEMS);
      const counts = { created: capped.length, open: 0, adopted: 0, duplicate: 0, expired: 0, dismissed: 0 };
      for (const item of capped) counts[item.status] += 1;
      return { ok: true, mode, rag: true, counts, keys: keyRows, items: capped };
    } catch (error) {
      log(`[suggest] 控制台列表失败（${error?.code ?? 'error'}）`);
      return null;
    }
  }

  /**
   * 手动作废（契约 §2）：先向 memory-rag 核对这条确实属于这个会话，再标 dismissed。
   * 返回 { code, body }（让桥接原样回状态码）；内部异常返回 null。
   */
  async function dismiss({ id, key } = {}) {
    try {
      load();
      const noteId = String(id ?? '').trim();
      const k = String(key ?? '').trim();
      if (!NOTE_ID_RE.test(noteId) || !KEY_RE.test(k)) {
        return { code: 404, body: { ok: false, error: '找不到这条候选' } };
      }
      if (!rag) return { code: 503, body: { ok: false, error: '向量索引没有配置' } };
      const t = at();
      const res = await fetchNotes(k, t - ttlMs, consoleTimeoutMs);
      if (!res || !Array.isArray(res.items)) {
        return { code: 503, body: { ok: false, error: '向量索引服务不可达' } };
      }
      const found = res.items.map(normalizeNote).filter(Boolean).find((note) => note.id === noteId);
      if (!found) return { code: 404, body: { ok: false, error: '找不到这条候选' } };
      const existing = state.items[noteId];
      if (existing && existing.key !== k) return { code: 404, body: { ok: false, error: '找不到这条候选' } };
      const entry = ensureEntry(found, k);
      if (entry.status !== 'open') {
        return { code: 409, body: { ok: false, error: `这条候选已经是「${STATUS_TEXT[entry.status] ?? entry.status}」状态，不能作废` } };
      }
      entry.status = 'dismissed';
      entry.statusAt = t;
      save();
      log(`[suggest] ${k} 候选 ${noteId} 手动作废`);
      return { code: 200, body: { ok: true, id: noteId, status: 'dismissed' } };
    } catch (error) {
      log(`[suggest] 作废失败（${error?.code ?? 'error'}）`);
      return null;
    }
  }

  return {
    plan,
    markShown,
    onRemember,
    list,
    dismiss,
    get mode() { return rag ? cfg.mode : 'off'; }
  };
}
