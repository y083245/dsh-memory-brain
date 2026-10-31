// life-loop.js · 「生活回路」（子项目 3，LIFE_LOOP_PATCH）
//
// 干什么：own-life 每次静默唤醒时给她的提示里补两样东西 ——
//         ① 最近写过的那篇日记（半夜那次一定给；白天只要还没给她看过就给）；
//         ② 一条「忽然想起」的旧事（主人账本里的条目、别人公开的条目、主人私聊里说过的话、她自己的旧日记）。
//         另外每分钟看一眼账本里今天到期的约定，到点主动去私聊提醒她。
//
// 为什么需要它：own-life 以前只发一句「现在是你的时间」，她没什么可想；
//              人闲下来脑子里会冒出旧事，答应过的事会自己想起来。这是「主动想起」的开头。
//
// 设计约束（docs/design/LIFE_LOOP_SPEC.md §6）：
// - 素材只从**主人私聊**和**账本里公开的条目**来：不读任何群聊存档，别人私聊里的条目不进池（L3）；
// - 每次唤醒最多 1 条素材，每个活动日最多 recallPerDay 条，同一条 cooldownDays 天内不重复（L4）；
// - 所有公开方法自己 try/catch，出错只记日志、返回空值，绝不把异常抛回桥接；
// - 日志里不写素材原文，只写来源和编号；状态文件原子写、权限 600，坏了当空状态。
//
// 用法（bridge.js）：
//   import { createLifeLoop } from './life-loop.js';
//   const lifeLoop = createLifeLoop({ ltm, persona, diaryDir, statePath, ownerQQ,
//                                     deliverPromiseWake, isAllowed, options, log, decay });
//   decay（可选）= createMemoryDecay 的实例（子项目 2 · DECAY_PATCH）：挑素材时按遗忘曲线
//   剔掉已淡忘的、用「快忘了的程度」当权重，抽中后记一次「顺利想起」。不传就完全退回旧行为。
//   lifeLoop.start();

import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const HOUR = 3600 * 1000;
const HISTORY_MAX = 30;

const pad = (n) => String(n).padStart(2, '0');
const clip = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const len = (s) => [...String(s ?? '')].length;
const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : a));

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mmdd(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hhmm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 活动日只支持 quiet[0] < quiet[1]，不合法就回退 3:00–8:00（与 own-life 一致）。 */
function normalizeQuiet(raw) {
  const from = Number(raw?.[0]);
  const to = Number(raw?.[1]);
  if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && from < to && to <= 24) return [from, to];
  return [3, 8];
}

/** 去掉微信式 [图片] / [表情] 方括号片段：素材是给她「想起来的」，不是复述一串占位符。 */
const stripBrackets = (s) => String(s ?? '').replace(/\[[^\]\n]*\]/g, '').trim();

/** 约定还没结束：pending 里 status 缺省视为 open。 */
const isOpenPromise = (item) => item?.cat === 'pending' && (item.status ?? 'open') === 'open';

export function createLifeLoop({
  ltm,
  persona = null,
  diaryDir,
  statePath,
  ownerQQ,
  deliverPromiseWake,
  isAllowed = () => false,
  options = {},
  now = () => Date.now(),
  rng = Math.random,
  log = () => {},
  decay = null,
  associate = null,
}) {
  if (!ltm) throw new Error('life-loop: 缺 ltm');
  if (!statePath) throw new Error('life-loop: 缺 statePath');

  const quiet = normalizeQuiet(options.quiet);
  const recallPerDay = Math.max(0, Number(options.recallPerDay ?? 2));
  const cooldownDays = Math.max(0, Number(options.cooldownDays ?? 7));
  const promiseWake = {
    enabled: options.promiseWake?.enabled !== false,
    at: /^\d{2}:\d{2}$/.test(String(options.promiseWake?.at ?? '')) ? String(options.promiseWake.at) : '10:00',
    maxPerDay: Math.max(0, Number(options.promiseWake?.maxPerDay ?? 5)),
  };
  // RAG_PATCH（P3，docs/design/ASSOCIATION_SPEC.md §10）：联想链的开关与门槛。
  // 配置写错（非数字 / 负数）时一律退回缺省，免得一个 typo 把功能静默关掉。
  const assocNum = (raw, dft, min) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : dft;
  };
  const associateOpts = {
    enabled: options.associate?.enabled !== false,
    cooldownDays: assocNum(options.associate?.cooldownDays, 7, 0),
    minAgeDays: assocNum(options.associate?.minAgeDays, 2, 0),
    timeoutMs: assocNum(options.associate?.timeoutMs, 1500, 1),
  };
  // DECAY_PATCH（子项目 2，docs/design/MEMORY_DECAY_SPEC.md §8）：遗忘曲线的开关。
  // 没传 decay 时下面所有 DECAY_PATCH 分支都不走，除了「跳过已过时条目」外行为与接入前一致。
  const decayOn = !!decay;

  const emptyState = () => ({
    version: 1,
    recall: {},
    recallDay: '',
    recallToday: 0,
    diaryShownT: 0,
    promiseWakes: { day: '', users: [] },
    history: [],
  });

  // 状态文件坏了 / 第一次跑：都当空状态，不拦住启动。
  let state = emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, ''));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      state = { ...emptyState(), ...raw };
      state.recall = raw.recall && typeof raw.recall === 'object' && !Array.isArray(raw.recall) ? raw.recall : {};
      const pw = raw.promiseWakes && typeof raw.promiseWakes === 'object' ? raw.promiseWakes : {};
      state.promiseWakes = { day: String(pw.day ?? ''), users: Array.isArray(pw.users) ? pw.users.map(String) : [] };
      state.history = Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h === 'object').slice(-HISTORY_MAX) : [];
      state.recallToday = Number(state.recallToday) || 0;
      state.diaryShownT = Number(state.diaryShownT) || 0;
    }
  } catch { /* 文件坏了：空状态 */ }

  /** 原子写 + 600：素材相关的状态里有聊天片段（preview），不能让别的用户读到。 */
  function saveNow() {
    try {
      state.history = state.history.slice(-HISTORY_MAX);
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (e) {
      log(`状态写不进去（忽略）：${e?.message ?? e}`);
    }
  }

  const activityDay = (ts) => dayKey(Number(ts) - quiet[0] * HOUR);

  function inQuiet(ts) {
    const h = new Date(ts).getHours();
    return h >= quiet[0] && h < quiet[1];
  }

  // ── 日记 ─────────────────────────────────────────────────────────────────
  // 只读 index.jsonl（append-only，坏行跳过）。t 允许是数字或数字字符串。
  function readDiary() {
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
        rows.push({ t, title: String(r.title ?? ''), mood: String(r.mood ?? ''), text: String(r.text ?? '') });
      } catch { /* 坏行跳过 */ }
    }
    return rows;
  }

  function diaryLine(kind, t) {
    const rows = readDiary();
    if (!rows.length) return '';
    const latest = rows.reduce((a, b) => (b.t > a.t ? b : a));
    // 太旧的日记不拿出来：最近 3 天内写过才提醒她「别写重复了」。
    if (t - latest.t > 3 * DAY) return '';
    // 白天只给一次；半夜那次是每天收尾，能重新看一眼。
    if (kind !== 'midnight' && !(latest.t > Number(state.diaryShownT || 0))) return '';
    const title = latest.title ? `《${latest.title}》` : '';
    const mood = latest.mood ? `（心情：${latest.mood}）` : '';
    const body = clip(latest.text, 60) + (len(latest.text) > 60 ? '…' : '');
    state.diaryShownT = latest.t;
    saveNow();
    return `【你最近的日记】${mmdd(latest.t)} ${hhmm(latest.t)}${title}${mood}：${body}\n写新的之前看一眼，别写重复了。`;
  }

  // ── 素材池 ───────────────────────────────────────────────────────────────
  /** 账本条目 → 素材显著度；不属于「值得忽然想起」的类别返回 null。 */
  function ltmSalience(item) {
    if (item.core) return 0.9;
    if (item.cat === 'event') return 0.7;
    if (item.cat === 'fact') return 0.5;
    if (item.cat === 'note') return 0.4;
    return null;
  }

  const publicSalience = (item) => (item.core ? 0.9 : item.cat === 'event' ? 0.7 : item.cat === 'fact' ? 0.5 : null);

  const rowKey = (r) => `${r?.t}|${r?.msgId ?? ''}`;

  function candidates(t) {
    try {
      const owner = String(ownerQQ?.() ?? '');
      if (!owner) return [];
      const ownerKey = `private:${owner}`;
      const out = [];
      const seen = new Set();
      const push = (c) => {
        if (!c || !c.candId || seen.has(c.candId)) return;
        // 冷却：同一条素材 cooldownDays 天内不再抽到（熬夜时别同一天反复想起同一件事）。
        const last = Number(state.recall?.[c.candId]?.lastAt) || 0;
        if (last && t - last < cooldownDays * DAY) return;
        seen.add(c.candId);
        out.push(c);
      };

      // DECAY_PATCH（规格 §8.2）：亲密度按 uid 缓存——一次 candidates 里同一个人只问一次 persona。
      const intimacyCache = new Map();
      const intimacyOf = (uid) => {
        const id = String(uid ?? '');
        if (intimacyCache.has(id)) return intimacyCache.get(id);
        let raw;
        try { raw = persona?.relationOf?.(id)?.intimacy; } catch { raw = undefined; }
        const n = raw == null ? undefined : Number(raw);
        const value = Number.isFinite(n) ? n : undefined;
        intimacyCache.set(id, value);
        return value;
      };
      // 造 meta 失败就当没有 meta（decay 的方法约定不抛，但假实现 / 未来改动不该把整个素材池弄空）。
      const metaOf = (make) => {
        if (!decayOn) return null;
        try { return make(); } catch { return null; }
      };
      // 有 decay 时先算遗忘状态：已淡忘的（frozen）不进池，其余的带上 meta / R。
      const add = (c, meta) => {
        if (!decayOn) return push(c);
        let st = null;
        try { st = decay.state(c.candId, meta); } catch { st = null; }
        if (st?.frozen === true) return;
        push({ ...c, meta, R: Number.isFinite(st?.R) ? st.R : null });
      };

      // ① 主人自己的账本条目：core / event / fact / note，写入 ≥ 2 天前（太新的还算不上「忽然想起」）。
      //    DECAY_PATCH：已过时的旧情况不再翻出来（旧数据没有这个字段，行为不变）。
      const ownerView = ltm.personView?.(owner, ownerKey);
      for (const it of ownerView?.items ?? []) {
        if (it.archivedAt || it.outdatedAt || isOpenPromise(it)) continue;
        const salience = ltmSalience(it);
        if (salience == null) continue;
        const at = Date.parse(it.at);
        if (!Number.isFinite(at) || t - at < 2 * DAY) continue;
        add({
          candId: `ltm:${it.id}`,
          source: 'ltm',
          userId: owner,
          salience,
          createdAt: at,
          text: `${mmdd(at)} ${it.cat === 'event' ? '那天' : '记下的'}：${it.text}`,
        }, metaOf(() => decay.ltmMeta(it, { ownerQQ: owner, userId: owner, intimacy: intimacyOf(owner) })));
      }

      // ② 别人账本里**公开**的条目（私聊里记的一律不进池；未完成的约定也不进池——那不是「旧事」）。
      for (const p of ltm.listPeople?.() ?? []) {
        const uid = String(p?.userId ?? '');
        if (!uid || uid === owner) continue;
        const view = ltm.personView?.(uid, ownerKey);
        const name = view?.name || p?.name || uid;
        for (const it of view?.items ?? []) {
          if (it.archivedAt || it.outdatedAt || it.scope !== 'public' || isOpenPromise(it)) continue;
          const base = publicSalience(it);
          if (base == null) continue;
          const at = Date.parse(it.at);
          if (!Number.isFinite(at) || t - at < 2 * DAY) continue;
          add({ candId: `ltm:${it.id}`, source: 'pub', userId: uid, salience: base * 0.8, createdAt: at, text: `关于${name}：${it.text}` },
            metaOf(() => decay.ltmMeta(it, { ownerQQ: owner, userId: uid, intimacy: intimacyOf(uid) })));
        }
      }

      // ③ 主人私聊存档里他说过的话：3 天前 ~ 60 天内。
      //    只问 private:<owner> 这个 key，绝不碰 group: 会话（L3）。
      //    DECAY_PATCH：接入遗忘曲线后窗口放宽到 365 天、不再只取最后 200 条——
      //    淡没淡由 R 决定，不靠窗口截断（规格 §8.2）。
      const sinceMs = t - (decayOn ? 365 : 60) * DAY;
      const untilMs = t - 3 * DAY;
      const archiveOpts = decayOn ? { limit: 2000 } : {};
      // DECAY_PATCH：有 decay 且人格给了逐条判读明细时，显著度和情绪强度一起用来定起点牢固度。
      let appraisals = null;
      if (decayOn && typeof persona?.appraisalByMsg === 'function') {
        try {
          const m = persona.appraisalByMsg(ownerKey, { sinceMs });
          appraisals = m instanceof Map ? m : new Map();
        } catch { appraisals = new Map(); }
      }
      let salienceMap = new Map();
      if (!appraisals) {
        try {
          const m = persona?.salienceByMsg?.(ownerKey, { sinceMs });
          if (m instanceof Map) salienceMap = m;
        } catch { /* 判读日志读不到就全用默认显著度 */ }
      }
      const rows = ltm.archiveRows?.(ownerKey, { sinceMs, untilMs, dir: 'in', ...archiveOpts }) ?? [];
      // 「你回：…」要看紧接着的下一行，但那是 out，被 dir 过滤掉了，所以单独再要一次（放宽 10 分钟）。
      const all = ltm.archiveRows?.(ownerKey, { sinceMs, untilMs: untilMs + 10 * 60000, ...archiveOpts }) ?? [];
      const nextOf = new Map();
      for (let i = 0; i < all.length - 1; i++) nextOf.set(rowKey(all[i]), all[i + 1]);
      for (const r of (decayOn ? rows : rows.slice(-200))) {
        const plain = stripBrackets(r.text);
        if (len(plain) < 12) continue;
        const at = Date.parse(r.t);
        if (!Number.isFinite(at)) continue;
        const hasId = r.msgId != null && r.msgId !== '';
        let salience = 0.3;
        let intensity;
        let metaSalience;
        if (appraisals) {
          const a = hasId ? appraisals.get(String(r.msgId)) : undefined;
          if (Number.isFinite(a?.salience)) {
            salience = a.salience;
            if (!(salience >= 0.3)) continue; // 判读说这句话不显著，就别翻出来
          }
          // 起点牢固度用判读原值（非数字交给 msgMeta 处理成 undefined）。
          metaSalience = a?.salience;
          intensity = a?.intensity;
        } else {
          if (hasId && salienceMap.has(String(r.msgId))) {
            salience = Number(salienceMap.get(String(r.msgId)));
            if (!(salience >= 0.3)) continue; // 判读说这句话不显著，就别翻出来
          }
          metaSalience = salience;
        }
        let text = `${mmdd(at)} 他说：「${clip(plain, 60)}」`;
        const next = nextOf.get(rowKey(r));
        if (next && next.dir === 'out') {
          const nt = Date.parse(next.t);
          if (Number.isFinite(nt) && nt - at <= 10 * 60000) text += `，你回：「${clip(stripBrackets(next.text), 40)}」`;
        }
        add({ candId: `msg:${r.msgId ? String(r.msgId) : r.t}`, source: 'msg', userId: owner, salience, createdAt: at, text },
          metaOf(() => decay.msgMeta(r, { salience: metaSalience, intensity, intimacy: intimacyOf(owner) })));
      }

      // ④ 她自己写过、≥ 3 天前的日记。
      for (const d of readDiary()) {
        if (t - d.t < 3 * DAY) continue;
        add({
          candId: `diary:${d.t}`,
          source: 'diary',
          userId: null,
          salience: 0.5,
          createdAt: d.t,
          text: `${mmdd(d.t)} 你写过日记${d.title ? `《${d.title}》` : ''}：${clip(d.text, 60)}`,
        }, metaOf(() => decay.diaryMeta(d)));
      }

      return out;
    } catch (e) {
      log(`素材池构建失败：${e?.message ?? e}`);
      return [];
    }
  }

  /** 权重 = 显著度 × 陈旧度 × 亲密度（规格 §6.3）。
   *  DECAY_PATCH（规格 §8.2）：接入遗忘曲线后，陈旧度换成「快忘了的程度」——
   *  刚被想起的 R≈1，几乎不会马上又被抽到；快冻结的（R 接近冻结线）最容易冒出来。
   *  「快忘了的时候被想起，记得最牢」（规格 §2）。 */
  function weightOf(c, t) {
    let intimacy = 0.8;
    if (c.userId) {
      let raw;
      try { raw = persona?.relationOf?.(c.userId)?.intimacy; } catch { raw = undefined; }
      intimacy = clamp(0.5 + Number(raw ?? 40) / 200, 0.5, 1);
    }
    if (decayOn && Number.isFinite(c.R)) {
      let fb = Number(decay.freezeBelow);
      if (!(fb > 0 && fb < 1)) fb = 0.5; // 冻结线不合法时按默认 0.5
      const forgetting = clamp((1 - c.R) / (1 - fb), 0.05, 1);
      const w = (Number(c.salience) || 0) * forgetting * intimacy;
      return w > 0 ? w : 0;
    }
    const last = Number(state.recall?.[c.candId]?.lastAt) || 0;
    const since = last || Number(c.createdAt) || t;
    const staleness = clamp((t - since) / (14 * DAY), 0.2, 1);
    const w = (Number(c.salience) || 0) * staleness * intimacy;
    return w > 0 ? w : 0;
  }

  function weightedPick(pool, t) {
    if (!pool.length) return null;
    const weights = pool.map((c) => weightOf(c, t));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return null;
    let r = rng() * sum;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  // RAG_PATCH（P3）：同步版抽中回忆时把素材记这里，composeOwnLifeAsync 拿它当联想种子。
  let lastRecall = null;

  function recallLine(t, slots) {
    let dirty = false;
    // 跨了活动日先把今天的回忆次数归零（活动日 = 00:00～quiet[0]:00 算前一天）。
    const day = activityDay(t);
    if (state.recallDay !== day) {
      state.recallDay = day;
      state.recallToday = 0;
      dirty = true;
    }
    const quota = recallPerDay - Number(state.recallToday || 0);
    if (quota <= 0) {
      if (dirty) saveNow();
      return '';
    }
    // 越接近本活动日收工（remainingSlots 小），越容易现在抽；这样回忆不会被前几次全用光。
    if (!(rng() < quota / Math.max(1, slots))) {
      if (dirty) saveNow();
      return '';
    }
    const pick = weightedPick(candidates(t), t);
    if (!pick) {
      if (dirty) saveNow();
      return '';
    }
    const prev = state.recall[pick.candId] ?? {};
    state.recall[pick.candId] = { lastAt: t, count: Number(prev.count || 0) + 1 };
    state.recallToday = Number(state.recallToday || 0) + 1;
    state.history.push({ at: t, kind: 'recall', source: pick.source, candId: pick.candId, preview: clip(pick.text, 20) });
    saveNow();
    // DECAY_PATCH（规格 §8.3）：被「忽然想起」送到她面前 = 顺利想起一次（M2），回满牢固度、S 变大。
    // 失败只记一行日志，不影响返回的文案；日志不写素材原文。
    if (decayOn && pick.meta) {
      try { decay.review(pick.candId, pick.meta, 'good'); } catch (e) { log(`复习记录失败：${e?.message ?? e}`); }
    }
    // 只记来源和编号：素材原文（聊天、账本）不进日志。
    lastRecall = { at: t, pick }; // RAG_PATCH（P3）：给 composeOwnLifeAsync 当联想种子（同步版不用）
    log(`忽然想起：${pick.source} · ${pick.candId}`);
    return `【忽然想起】${pick.text}\n只是脑子里冒出来的旧事：想跟他聊就自然地提一句，不想就当想想，或者写进日记。别说「我想起了一条记忆」这种话。`;
  }

  // ── 对外：唤醒时补的文案 ─────────────────────────────────────────────────
  function composeOwnLife({ kind, now: t, remainingSlots } = {}) {
    try {
      const at = Number(t) || now();
      const parts = [];
      const diary = diaryLine(kind, at);
      if (diary) parts.push(diary);
      const recall = recallLine(at, Math.max(1, Number(remainingSlots) || 1));
      if (recall) parts.push(recall);
      return parts.join('\n\n');
    } catch (e) {
      log(`composeOwnLife 失败：${e?.message ?? e}`);
      return '';
    }
  }

  // ── 联想链（RAG_PATCH（P3），规格 docs/design/ASSOCIATION_SPEC.md §10）──────────
  // 同步的 composeOwnLife 一字不动；这一组只在「这一次真的抽中了忽然想起」时多用一次 associate：
  // 顺着那条素材里的人 / 事，从主人私聊的旧摘要里再带出一件相关的（说「说起这个，又想到……」）。
  // associate 由桥接注入（memoryRag.associate）；没传 / 关了 / 问不到 / 超时都退回同步结果，绝不抛给桥接。

  /** 冷却期内带出过的摘要不再带一次：只认 sum: 前缀的编号，返回去掉前缀的数组。 */
  function excludeSummaries(t) {
    const out = [];
    const still = associateOpts.cooldownDays * DAY;
    let recall = {};
    try { recall = state.recall && typeof state.recall === 'object' ? state.recall : {}; } catch { recall = {}; }
    for (const key of Object.keys(recall)) {
      if (!String(key).startsWith('sum:')) continue;
      const lastAt = Number(recall[key]?.lastAt) || 0;
      if (lastAt && t - lastAt < still) out.push(String(key).slice(4));
    }
    return out;
  }

  /** 只留字段齐全、能用的候选（规格 §10 第 6 条）；via 不是数组就当没有，只留字符串。 */
  function normalizeAssociateItems(raw) {
    const out = [];
    for (const it of Array.isArray(raw) ? raw : []) {
      if (!it || typeof it !== 'object') continue;
      if (typeof it.summary_id !== 'string' || !it.summary_id) continue;
      if (typeof it.summary !== 'string' || !it.summary) continue;
      const score = Number(it.score);
      if (!(score > 0)) continue;
      const day = typeof it.day === 'string' ? it.day : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const via = Array.isArray(it.via) ? it.via.filter((v) => typeof v === 'string') : [];
      out.push({ id: it.summary_id, summary: it.summary, score, day, via });
    }
    return out;
  }

  /** 按得分加权随机挑 1 条：与 weightedPick 同样的累减写法，但字段不同，单独实现（不动 weightedPick）。 */
  function pickByScore(list) {
    if (!list.length) return null;
    const sum = list.reduce((a, b) => a + b.score, 0);
    if (!(sum > 0)) return null;
    let r = rng() * sum;
    for (const it of list) {
      r -= it.score;
      if (r < 0) return it;
    }
    return list[list.length - 1];
  }

  /** 调一次 associate：超时 / 抛错 / null / 形状不对都给 null。日志只写错误类别，不写原文。 */
  async function callAssociate(params) {
    const timedOut = { timeout: true };
    let timer = null;
    let res;
    try {
      const call = Promise.resolve().then(() => associate(params));
      call.catch(() => {}); // 超时之后它再失败，不能变成未处理的拒绝
      res = await Promise.race([
        call,
        new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), associateOpts.timeoutMs); }),
      ]);
    } catch (e) {
      log(`联想失败：${e?.name || 'Error'}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res === timedOut) { log('联想失败：超时'); return null; }
    if (res == null) { log('联想失败：没有结果'); return null; }
    if (typeof res !== 'object' || !Array.isArray(res.items)) { log('联想失败：格式不对'); return null; }
    return res;
  }

  async function composeOwnLifeAsync(args = {}) {
    lastRecall = null;
    const base = composeOwnLife(args);
    if (typeof associate !== 'function' || !associateOpts.enabled) return base;
    const picked = lastRecall;
    if (!picked || !picked.pick) return base; // 这次没抽中回忆：没有种子，也就不联想
    const pick = picked.pick;
    const t = Number(args?.now) || picked.at || now();
    try {
      const params = {
        text: String(pick.text ?? ''),
        people: [],
        exclude: excludeSummaries(t),
        minAgeDays: associateOpts.minAgeDays,
        k: 3,
      };
      // 只有 msg 带时间（消息时间才落在话题块里）；别人的公开条目传那个人。
      if (pick.source === 'msg') params.t = Number(pick.createdAt);
      if (pick.source === 'pub') params.people = [String(pick.userId ?? '')];

      const res = await callAssociate(params);
      if (!res) return base;
      const items = normalizeAssociateItems(res.items);
      if (!items.length) { log('没有可联想的'); return base; }
      const chosen = pickByScore(items);
      if (!chosen) { log('没有可联想的'); return base; }

      const candId = `sum:${chosen.id}`;
      const prev = state.recall[candId] ?? {};
      state.recall[candId] = { lastAt: t, count: Number(prev.count || 0) + 1 };
      // 不存摘要、不存预览：只留编号和来自哪条。
      state.history.push({ at: t, kind: 'associate', candId, from: pick.candId });
      saveNow();
      log(`顺着想到：${candId} ← ${pick.candId}`);

      const via = chosen.via.slice(0, 2).map((v) => `「${v}」`).join('');
      const tail = via ? `（都和${via}有关）` : '';
      const line = `【顺着想到】说起这个，又想到 ${chosen.day.slice(-5)}：${clip(chosen.summary, 80)}${tail}\n`
        + '是自己顺着想到的，不一定要提；想提就自然带一句。';
      return `${base}\n\n${line}`;
    } catch (e) {
      log(`联想失败：${e?.name || 'Error'}`);
      return base;
    }
  }

  // ── 到期唤醒 ─────────────────────────────────────────────────────────────
  function promiseWakeText(userId, items) {
    let name = String(userId);
    try { name = String(ltm.personView?.(userId)?.name || userId); } catch { /* 用 QQ 号 */ }
    const lines = items.map((it) => {
      const by = it.by === 'me' ? '你答应的' : it.by === 'them' ? '他答应的' : '约定';
      return `- ${it.text}（${by}）〔${it.id}〕`;
    });
    return [
      `【到期的约定】今天是你和${name}说好的日子：`,
      ...lines,
      '想提就自然地提一句（别像闹钟一样念），也可以等他来找你再说；他在忙或不方便就别打扰。',
      '确认兑现了、没兑现、不做了，用 qq_ltm_update 标 status（done / missed / cancelled）。',
    ].join('\n');
  }

  let timer = null;
  let notAllowedLogged = new Set(); // 同一个人一天只记一次「当前模式不允许」日志

  async function tick(t = now()) {
    try {
      if (!promiseWake.enabled) return;
      const at = Number(t) || now();
      const today = dayKey(at);
      if (state.promiseWakes.day !== today) {
        state.promiseWakes = { day: today, users: [] };
        notAllowedLogged = new Set();
        saveNow();
      }
      if (hhmm(at) < promiseWake.at) return;
      if (inQuiet(at)) return;

      let due = [];
      try { due = ltm.duePromises?.(today) ?? []; } catch (e) { log(`读到期约定失败：${e?.message ?? e}`); return; }
      // 按 userId 排序：测试稳定，也和「先到先得」的观感一致。
      const entries = [...due].sort((a, b) => String(a?.userId ?? '').localeCompare(String(b?.userId ?? '')));

      for (const entry of entries) {
        const userId = String(entry?.userId ?? '');
        if (!userId) continue;
        const viewerKey = `private:${userId}`;
        let items = [];
        try { items = (entry.items ?? []).filter((it) => ltm.visibleTo?.(it, viewerKey)); } catch { items = []; }
        if (!items.length) continue; // 只看得见他那边可见的约定
        if (state.promiseWakes.users.includes(userId)) continue;
        if (state.promiseWakes.users.length >= promiseWake.maxPerDay) return;

        let allowed = false;
        try { allowed = !!isAllowed(viewerKey); } catch { allowed = false; }
        if (!allowed) {
          // 不记 users：这个会话晚点可能变成允许；但日志每人每天只记一次，免得每分钟刷屏。
          if (!notAllowedLogged.has(userId)) {
            notAllowedLogged.add(userId);
            log(`到期唤醒跳过（当前模式不允许私聊）：${userId}`);
          }
          continue;
        }

        // 先记后投：投递失败也不重试（至多一次），否则一分钟一次会把她自己刷屏。
        state.promiseWakes.users.push(userId);
        saveNow();
        try {
          await deliverPromiseWake(viewerKey, promiseWakeText(userId, items));
          log(`到期唤醒已投递：${userId}（${items.length} 条）`);
        } catch (e) {
          log(`到期唤醒投递失败：${userId} · ${e?.message ?? e}`);
        }
        state.history.push({ at, kind: 'promise-wake', userId, items: items.length });
        saveNow();
      }
    } catch (e) {
      log(`tick 失败：${e?.message ?? e}`);
    }
  }

  function snapshot() {
    try {
      return {
        recallDay: state.recallDay,
        recallToday: Number(state.recallToday) || 0,
        recallPerDay,
        diaryShownT: Number(state.diaryShownT) || 0,
        promiseWakes: state.promiseWakes,
        history: state.history.slice(-10),
        // RAG_PATCH（P3）：当天（活动日）顺着联想带出的次数。
        associateToday: state.history.filter((h) => h?.kind === 'associate' && activityDay(h.at) === activityDay(now())).length,
      };
    } catch (e) {
      log(`snapshot 失败：${e?.message ?? e}`);
      return null;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
    timer.unref?.();
    log(`已武装 · 到期唤醒${promiseWake.enabled ? ` 每天 ${promiseWake.at} 后（至多 ${promiseWake.maxPerDay} 人）` : '关闭'} · 回忆每天 ${recallPerDay} 条`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, composeOwnLife, composeOwnLifeAsync, candidates, snapshot };
}

export default createLifeLoop;
