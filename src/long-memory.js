// long-memory.js · 长期记忆：人物账本 + 聊天存档
//
// 两层，都只存在本机 state/long-memory/ 下：
//
// ① 人物账本（people.json）—— 按 QQ 号存，不按会话存（思路来自 ai-companion-kit 的 memory.js）。
//    会话被重建、上下文被压缩都不影响。每条记录：
//      { id, cat, text, at, sourceKey, scope, outdatedAt?, outdatedBy? }
//    cat：trait 性格习惯 / fact 他告诉过你的事 / event 一起经历的事、聊过的要紧事 /
//         pending 约定、没聊完、答应过的事 / note 其它
//    scope：private —— 只在记下它的那个会话里可见（私聊里说的话不会被带到群里）
//           public  —— 各处可见
//    DECAY_PATCH（子项目 2 规格 M5）：outdatedAt —— 这条已经过时（情况变了，被更新的
//    条目替代），不再注入、不再冒出来，但原话保留、工具照样查得到；outdatedBy —— 替代它
//    的新条目 id（用 qq_ltm_update 手动标过时的不写这个字段）。
//
// ② 聊天存档（archive/<会话>/<YYYY-MM>.jsonl）—— 每条收发消息追加一行，永不改写。
//    检索只允许在**当前会话**内进行：A 群里的 AI 翻不到私聊记录。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CATEGORIES = Object.freeze({
  trait: '性格/习惯/喜好',
  fact: '告诉过你的事',
  event: '一起经历/聊过的要紧事',
  pending: '约定/没聊完/答应过的事',
  note: '其它'
});

const CAPS = { trait: 40, fact: 100, event: 200, pending: 40, note: 40 };
const MAX_TEXT = 300;

// ── LIFE_LOOP_PATCH：账本前置（子项目 3「主动想起与生活回路」v1，规格 §3、§4）────
// 超上限从「静默删最旧」改成「归档」：账本是长期记忆，删掉的再也找不回来；
// 归档只是不再注入唤醒提示，qq_ltm_recall 和控制台仍然看得到（规格 §3）。
// core 是这个人最重要的几件事：注入时必带、永不归档，每人限 8 条。
export const CORE_MAX = 8;

const DAY_MS = 86400000;
const PROMISE_STATUSES = Object.freeze(['open', 'done', 'missed', 'cancelled']);
const CN_NUM = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 });
const CN_WEEKDAY = Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 });
const REL_DAY = Object.freeze({ 今天: 0, 明天: 1, 后天: 2, 大后天: 3 });
const DUE_HINT = '请写 YYYY-MM-DD，或 今天/明天/后天/周五/下周三/3天后/11月3日';

/** 只取本地年月日（零点），避免时刻部分影响日期比较。 */
function localDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

/** 合法日期的构造：m 超出 1～12、d 超出当月天数（如 2026-02-30）一律返回 null。 */
function dateAt(y, m, d) {
  if (!(y >= 1970 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const dt = new Date(y, m - 1, d);
  return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? dt : null;
}

/**
 * 把 AI / 用户写的到期日换算成 `YYYY-MM-DD`（**本地日期**，不能用 toISOString 的 UTC 日期）。
 * 空串返回 null；看不懂抛错（错误文案固定，规格 §4.1）。周以周一为一周的开始。
 */
export function normalizeDueDate(input, now = new Date()) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const fail = () => { throw new Error(`到期日看不懂：${[...s].slice(0, 20).join('')}；${DUE_HINT}`); };
  const today = localDay(now);
  const todayWd = today.getDay() === 0 ? 7 : today.getDay();
  // 结果必须落在 [today − 30 天, today + 366 天]；超出说明写错了年份。
  const finish = (dt) => {
    if (!dt) fail();
    const diff = Math.round((dt - today) / DAY_MS);
    if (diff < -30 || diff > 366) fail();
    return ymd(dt);
  };

  let m;
  // 完整日期：2026-11-03 / 2026/11/3 / 2026年11月3日
  if ((m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?$/.exec(s))) {
    return finish(dateAt(+m[1], +m[2], +m[3]));
  }
  // 月日：11-3 / 11/3 / 11月3日。早于今天超过 30 天 → 明年
  if ((m = /^(\d{1,2})[-/月](\d{1,2})[日号]?$/.exec(s))) {
    const [mo, dd] = [+m[1], +m[2]];
    const thisYear = dateAt(today.getFullYear(), mo, dd);
    if (!thisYear) fail();
    const early = Math.round((today - thisYear) / DAY_MS) > 30;
    return finish(early ? dateAt(today.getFullYear() + 1, mo, dd) : thisYear);
  }
  // 只有日：5号。早于今天 → 下个月
  if ((m = /^(\d{1,2})[日号]$/.exec(s))) {
    const dd = +m[1];
    const thisMonth = dateAt(today.getFullYear(), today.getMonth() + 1, dd);
    if (!thisMonth) fail();
    if (thisMonth >= today) return finish(thisMonth);
    const nm = new Date(today.getFullYear(), today.getMonth() + 1, 1); // 下个月 1 号，借它算进位
    return finish(dateAt(nm.getFullYear(), nm.getMonth() + 1, dd));
  }
  if (Object.hasOwn(REL_DAY, s)) return finish(addDays(today, REL_DAY[s]));
  // N天后 / N天之后（阿拉伯数字 1～365，或 一～十）
  if ((m = /^(\d{1,3}|[一二两三四五六七八九十])天(?:之)?后$/.exec(s))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : CN_NUM[m[1]];
    if (!(n >= 1 && n <= 365)) fail();
    return finish(addDays(today, n));
  }
  // 周X / 星期X / 礼拜X，以及 这周X / 本周X / 下周X
  if ((m = /^(下|这|本)?(?:周|星期|礼拜)([一二三四五六日天1-7])$/.exec(s))) {
    const wd = CN_WEEKDAY[m[2]] ?? Number(m[2]);
    if (!(wd >= 1 && wd <= 7)) fail();
    const mondayOffset = todayWd - 1; // 本周一相对 today 差几天（负）
    if (m[1] === '下') return finish(addDays(today, 7 - mondayOffset + wd - 1));
    if (m[1] === '这' || m[1] === '本') return finish(addDays(today, wd - 1 - mondayOffset));
    return finish(addDays(today, (wd - todayWd + 7) % 7));
  }
  return fail();
}

/** 「谁答应的」只认 me / them；空值返回 null（调用方按「没写」处理）。 */
function normalizeBy(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (s !== 'me' && s !== 'them') throw new Error('谁答应的只能是 me（你答应的）或 them（对方答应的）');
  return s;
}

/** 约定记号：今天到期 / 已过期 N 天 / MM-DD 到期；没有 due 不加。 */
function promiseMark(item, today) {
  if (item.cat !== 'pending' || !item.due) return '';
  if (item.due === today) return '【今天到期】';
  if (item.due < today) {
    const n = Math.max(1, Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${item.due}T00:00:00`)) / DAY_MS));
    return `【已过期${n}天，兑现了吗？】`;
  }
  return `【${item.due.slice(5)}到期】`;
}

function byMark(item) {
  if (item.by === 'me') return '（你答应的）';
  if (item.by === 'them') return '（他答应的）';
  return '';
}

/**
 * 约定的渲染顺序（规格 §4.5）：已过期（due 早到晚）→ 今天到期 → 7 天内到期（due）→
 * 其余（含无 due，at 新到旧）。前三个桶按 due 排，保证「最该提的」排最前。
 */
function sortPromises(items, today) {
  const dayOf = (s) => Date.parse(`${s}T00:00:00`);
  const t0 = dayOf(today);
  const bucket = (x) => {
    if (!x.due) return 3;
    if (x.due < today) return 0;
    if (x.due === today) return 1;
    return (dayOf(x.due) - t0) / DAY_MS <= 7 ? 2 : 3;
  };
  const byDue = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0);
  const byAtDesc = (a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
  return [...items].sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 0 || ba === 2) return byDue(a, b);
    if (ba === 1) return 0; // 今天到期的不再细分，保持写入顺序
    return byAtDesc(a, b);
  });
}

// ── RAG_PATCH：降级检索的打分参数 ─────────────────────────────────────────
// memory-rag 不可用时桥接退回这里的 search()。旧实现是「所有词都要命中、从新到旧取 30 条」，
// 一条消息只要差一个词就整条出局（P0 评估 R@1 只有 0.24）。这里改成按命中程度打分：
//   ① 检索词 = keywords ∪ query 按空白/标点切出的片段；中文长片段再切成 2～3 字的片段，
//      否则一整句「他说过要怎么帮我保留记忆」永远子串命不中；
//   ② 每个命中词的权重 = 词长^lenPow ×（整词命中再 ×wholeMult）× IDF，
//      IDF 让「今天」这类高频片段压不过「向量检索」这类有区分度的词；
//   ③ 分数降序，同分时新的在前。
// 参数集中放这里，评估调参时只改这一处。
const SEARCH_SCORE = Object.freeze({
  lenPow: 1.5,          // 词长指数：越长的词越有区分度，但别让长词完全碾压多个短词
  wholeMult: 2,         // 整词命中的加成（相对切片命中）
  sliceLens: Object.freeze([2, 3]),
  displayMaxChars: 300  // 单条消息原文显示上限，超出截断加「…」
});

const TERM_SEP_RE = /[^\p{L}\p{N}]+/u;
const HAN_RE = /\p{Script=Han}/u;

// DECAY_PATCH：matchItems 允许单个汉字当关键词（「猫」「药」这类单字名词很常见，
// 工具描述的示例就是「猫 生日」）。但这些单字几乎每条都有，拿来当关键词会把整本
// 账本都算成「想起」，所以只留实词、过滤掉高频虚词。
const MATCH_STOP_HAN = new Set([...'的了是我你他她它在和也就都还吗呢啊吧呀哦有这那个么']);

function cpLen(s) { return [...String(s)].length; }
function hasHan(s) { return HAN_RE.test(s); }

/** 把 keywords（数组或字符串）与 query 拆成候选检索词。 */
function buildSearchTerms(query, keywords) {
  const inputs = [];
  if (Array.isArray(keywords)) inputs.push(...keywords);
  else if (keywords != null) inputs.push(keywords);
  if (query != null) inputs.push(query);

  const terms = new Map(); // text → { text, whole, len }
  const add = (text, whole) => {
    const t = String(text ?? '').toLowerCase();
    if (!t) return;
    const cur = terms.get(t);
    if (cur) { if (whole) cur.whole = true; return; }
    terms.set(t, { text: t, whole, len: cpLen(t) });
  };

  for (const input of inputs) {
    for (const frag of String(input ?? '').toLowerCase().split(TERM_SEP_RE)) {
      if (!frag) continue;
      const chars = [...frag];
      if (hasHan(frag) && chars.length > 3) {
        add(frag, true);
        for (const n of SEARCH_SCORE.sliceLens) {
          for (let i = 0; i + n <= chars.length; i += 1) add(chars.slice(i, i + n).join(''), false);
        }
      } else {
        add(frag, true);
      }
    }
  }

  // 单个汉字太容易撞上，不单独作为检索词；但如果整条查询就只有一个汉字，还是留着。
  if (terms.size > 1) {
    for (const [text, t] of terms) if (t.len === 1 && hasHan(text)) terms.delete(text);
  }
  return [...terms.values()];
}

/** 单条消息的显示文本：格式与旧实现一致，超长按码点截断（不切开代理对）。 */
function clipMessageText(text) {
  const chars = [...String(text ?? '')];
  if (chars.length <= SEARCH_SCORE.displayMaxChars) return chars.join('');
  return `${chars.slice(0, SEARCH_SCORE.displayMaxChars).join('')}…`;
}

/** 一行输出：`YYYY-MM-DD HH:MM 称呼：原文`，与旧实现一致。 */
function formatRow(r) {
  const d = new Date(r.t);
  return `${ymd(d)} ${hm(d)} ${r.dir === 'out' ? '我' : (r.name || r.userId || '对方')}：${clipMessageText(r.text)}`;
}

/** 按排名把每条命中展开成「命中 + 前后各 ctx 条」，同一行只输出一次。 */
function buildHitGroups(rows, ranked, ctx) {
  const emitted = new Set();
  const groups = [];
  for (const hit of ranked) {
    const s = Math.max(hit.i - ctx, 0);
    const e = Math.min(rows.length - 1, hit.i + ctx);
    const idxs = [];
    const texts = [];
    for (let j = s; j <= e; j += 1) {
      if (emitted.has(j)) continue;
      emitted.add(j);
      idxs.push(j);
      texts.push(formatRow(rows[j]));
    }
    groups.push({ ...hit, idxs, texts });
  }
  return groups;
}

/** lines 的总字数（含组间「……」，上限判断用）。 */
function groupChars(groups, ctx) {
  let n = 0;
  for (const g of groups) for (const s of g.texts) n += s.length;
  const blocks = groups.filter((g) => g.texts.length).length;
  if (ctx > 0 && blocks > 1) n += 2 * (blocks - 1);
  return n;
}

/**
 * 展开并做总长截断。超过 maxChars 时从排名最低的命中开始整组丢弃：
 * scored 的最低排名在列表尾部（trimFrom=end）；browse 的输出按时间正序、越靠前越旧，
 * 等于「最不相关」，所以从头丢（trimFrom=front）。至少保留一组，避免上限比单组还小时全空。
 */
function renderHitGroups(rows, ranked, ctx, maxLen, trimFrom) {
  let kept = ranked;
  let groups = buildHitGroups(rows, kept, ctx);
  while (groups.length > 1 && groupChars(groups, ctx) > maxLen) {
    kept = trimFrom === 'front' ? kept.slice(1) : kept.slice(0, -1);
    groups = buildHitGroups(rows, kept, ctx);
  }
  const out = [];
  let last = -1;
  for (const g of groups) {
    if (!g.texts.length) continue;
    // 与旧实现一致：只有带上下文时，才在不相邻的组之间放「……」。
    if (ctx > 0 && out.length && g.idxs[0] !== last + 1) out.push('……');
    out.push(...g.texts);
    last = g.idxs[g.idxs.length - 1];
  }
  return { lines: out, kept };
}

function nowIso() { return new Date().toISOString(); }
function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function hm(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function keyDir(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? ''));
  if (!m) throw new Error(`会话 key 不合法：${key}`);
  return `${m[1]}_${m[2]}`;
}
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── RAG_PATCH（P2）：存档删除（墓碑） ─────────────────────────────────────
// 删一条消息不做「重写整个文件」：把那一行原地改写成固定字节数的墓碑。
// 这样行号、后续各行的字节偏移全都不变 —— memory-rag 按字节记的索引水位、
// 评估用例里的行号都不会错位（接口约定 §存档墓碑）。
const TOMBSTONE = '{"deleted":true}';
const TOMBSTONE_BYTES = Buffer.byteLength(TOMBSTONE); // 16
const DELETE_MAX_ROWS = 500;

/** from/to 只认 YYYY-MM-DD（空 = 不限）；2026-02-30 这种不存在的日期抛错。 */
function parseDayArg(raw, label) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`${label} 必须是 YYYY-MM-DD（或留空）：${s}`);
  const d = dateAt(+m[1], +m[2], +m[3]);
  if (!d) throw new Error(`${label} 日期不存在：${s}`);
  return d;
}

/** 日期区间换算成毫秒（本地时区整天）：from 当天 00:00 起、to 当天 23:59:59.999 止。 */
function dayRangeMs(fromD, toD) {
  const startMs = fromD ? fromD.getTime() : -Infinity;
  const endMs = toD ? new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() + 1).getTime() - 1 : Infinity;
  return { startMs, endMs };
}

/**
 * 按 \n 切出每一行在 Buffer 里的起始字节与字节长度（行尾 \n 不算进 len）。
 * 必须按字节算：墓碑要求「改写后字节数完全不变」，多字节字符会让字符数与字节数不一致。
 */
function lineMetas(buf) {
  const metas = [];
  let start = 0;
  let lineNo = 1;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i === buf.length || buf[i] === 0x0a) {
      metas.push({ line: lineNo, start, len: i - start });
      start = i + 1;
      lineNo += 1;
    }
  }
  return metas;
}

// LIFE_LOOP_PATCH：新增可选 onPromiseClosed —— 约定从 open 变成 done / missed 时同步通知
// （人格模块据此调情绪）。回调放在 createLongMemory 的依赖注入里，账本本身不认识人格模块。
// DECAY_PATCH：新增可选 decayOf —— (item, userId) => { R, frozen } | null，renderFor 用它
// 挑「先带哪几条」；没传时 renderFor 的行为与改动前逐字相同。
export function createLongMemory({ stateDir, redact = (s) => s, log = () => {}, onPromiseClosed = null, decayOf = null }) {
  const PEOPLE_FILE = path.join(stateDir, 'people.json');
  const ARCHIVE_DIR = path.join(stateDir, 'archive');
  // RAG_PATCH（P2）：遗忘请求文件（memory-rag 起来后自己消费）。
  const FORGET_DIR = path.join(stateDir, 'forget-requests');
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  // DECAY_PATCH：只在真的传了函数时才启用按牢固度排序，避免把 null / 别的类型当回调。
  const decayFn = typeof decayOf === 'function' ? decayOf : null;

  let people = {};
  try { people = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8')).people ?? {}; } catch {}
  let saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeFileAtomic(PEOPLE_FILE, JSON.stringify({ version: 1, people }, null, 2) + '\n');
  }
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { log(`[ltm] 账本写入失败：${e?.message ?? e}`); } }, 2000);
    saveTimer.unref?.();
  }

  function person(userId, name) {
    const id = String(userId ?? '').trim();
    if (!/^\d+$/.test(id)) throw new Error(`QQ 号不合法：${userId}`);
    let p = people[id];
    if (!p) {
      p = people[id] = { name: '', names: [], items: [], firstSeenAt: nowIso(), lastSeenAt: nowIso(), messages: 0 };
    }
    const n = String(name ?? '').trim();
    if (n && n !== '私聊' && n !== id) {
      p.name = n;
      if (!p.names.includes(n)) p.names = [...p.names, n].slice(-8);
    }
    return p;
  }

  /** 收到/发出消息时顺手更新「认识这个人」的基础信息（不写入记忆条目）。 */
  function touch(userId, name) {
    try {
      const p = person(userId, name);
      p.lastSeenAt = nowIso();
      p.messages = (Number(p.messages) || 0) + 1;
      saveSoon();
    } catch {}
  }

  // ── LIFE_LOOP_PATCH：上限治理与核心条目 ────────────────────────────────
  /** 该人未归档的核心条目数；self 用于「重复内容合并到同一条」时不算它自己。 */
  function coreCount(p, self = null) {
    // DECAY_PATCH：已过时的条目不再占核心名额（更新时可以把核心转移给新条目）
    return p.items.filter((x) => x.core && !x.archivedAt && !x.outdatedAt && x !== self).length;
  }

  function assertCoreRoom(p, self = null) {
    if (coreCount(p, self) >= CORE_MAX) throw new Error(`核心条目最多 ${CORE_MAX} 条，先用 qq_ltm_update 把一条的 core 设为 false`);
  }

  /**
   * 超上限时**归档**而不是删除（规格 §3、§4.3）：active 只数「未归档且非核心」的条目，
   * 超出的部分写 archivedAt；先归档已结束的约定（没人还想被提醒），再按 at 从旧到新。
   */
  function enforceCap(p, cat, userId) {
    const cap = CAPS[cat];
    if (!Number.isFinite(cap)) return;
    const active = p.items.filter((x) => x.cat === cat && !x.archivedAt && !x.core);
    const over = active.length - cap;
    if (over <= 0) return;
    const ended = (x) => x.cat === 'pending' && x.status && x.status !== 'open';
    const when = (x) => Date.parse(x.closedAt ?? x.at ?? '') || 0;
    const closed = active.filter(ended).sort((a, b) => when(a) - when(b));
    const rest = active.filter((x) => !ended(x)).sort((a, b) => when(a) - when(b));
    const victims = [...closed, ...rest].slice(0, over);
    const at = nowIso();
    for (const v of victims) v.archivedAt = at;
    log(`[ltm] 账本超上限，归档 ${victims.length} 条（${userId}·${cat}）`);
  }

  function remember({ userId, name, cat, text, sourceKey, scope, due, by, core, replaces }) {
    if (!Object.hasOwn(CATEGORIES, cat)) throw new Error(`类别只能是：${Object.keys(CATEGORIES).join(' / ')}`);
    const t = redact(String(text ?? '').trim()).slice(0, MAX_TEXT);
    if (!t) throw new Error('内容不能为空');
    const sk = String(sourceKey ?? '');
    const sc = scope === 'public' || scope === 'private' ? scope : (sk.startsWith('private:') ? 'private' : 'public');
    const p = person(userId, name);
    // LIFE_LOOP_PATCH：到期日 / 谁答应的只对约定有意义（到期日由 AI 在记的时候填，桥接只做换算）
    const dueIn = due == null ? '' : String(due).trim();
    const byIn = by == null ? '' : String(by).trim();
    if ((dueIn || byIn) && cat !== 'pending') throw new Error('只有约定（pending）才能设到期日和谁答应的');
    const dueDay = dueIn ? normalizeDueDate(dueIn) : null;
    const byWho = byIn ? normalizeBy(byIn) : null;
    const wantCore = core === true;
    // 完全相同的内容不重复记
    const dup = p.items.find((x) => x.cat === cat && x.text === t && (x.scope === 'public' || x.sourceKey === sk));
    // DECAY_PATCH（规格 M5）：replaces —— 「这条是在更新一件旧事」。
    // 校验必须在动任何条目之前做完（找不到 / 不可见 / 已过时的旧条目都直接抛错），
    // 否则会留下「新条目写进去、旧条目没标上」的半截账本。
    const repIn = replaces == null ? '' : String(replaces).trim();
    let old = null;
    if (repIn) {
      old = p.items.find((x) => x.id === repIn) ?? null;
      if (!old || !visible(old, sk) || old.outdatedAt) {
        throw new Error(`找不到要替换的旧条目：${repIn}（先用 qq_ltm_recall 查编号；已过时的不能再替换）`);
      }
      if (dup === old) throw new Error('新内容和旧条目一样，不用替换');
    }
    // DECAY_PATCH：核心条目被替换时把核心「转移」给新条目 —— 这是转移不是新增，不占名额。
    const inheritCore = !!(old && old.core);
    if (wantCore && !inheritCore) assertCoreRoom(p, dup);
    if (dup) {
      dup.at = nowIso();
      // LIFE_LOOP_PATCH：又被记了一次，说明它重新变得要紧 —— 已归档的先恢复（规格 §4.3）。
      // 它刚刷新了 at，紧接着的 enforceCap 按 at 从旧到新挑，不会挑中它。
      const restored = !!dup.archivedAt;
      if (restored) delete dup.archivedAt;
      // DECAY_PATCH：已过时的条目又被记了一次，说明旧情况又成立了 —— 和「已归档的先恢复」一样处理。
      if (dup.outdatedAt) { delete dup.outdatedAt; delete dup.outdatedBy; }
      // LIFE_LOOP_PATCH：这次带上的新信息合并到同一条上，不另起一条
      if (dueDay) dup.due = dueDay;
      if (byWho) dup.by = byWho;
      if (wantCore) dup.core = true;
      // DECAY_PATCH：核心转移；旧条目标过时，at 不动（它还是原来那条历史）
      if (inheritCore) { dup.core = true; delete old.core; }
      if (old) { old.outdatedAt = nowIso(); old.outdatedBy = dup.id; }
      if (restored) enforceCap(p, cat, String(userId ?? '').trim());
      saveNow();
      return { item: dup, duplicate: true, replaced: old };
    }
    const item = { id: crypto.randomBytes(4).toString('hex'), cat, text: t, at: nowIso(), sourceKey: sk, scope: sc };
    // LIFE_LOOP_PATCH：约定默认「还没兑现」；到期日 / 谁答应的可选
    if (cat === 'pending') item.status = 'open';
    if (dueDay) item.due = dueDay;
    if (byWho) item.by = byWho;
    // DECAY_PATCH：wantCore 或核心转移都要成为核心
    if (wantCore || inheritCore) item.core = true;
    p.items.push(item);
    // DECAY_PATCH：新条目写好之后才动旧条目（旧条目 at 不动，它还是那条历史）
    if (inheritCore) delete old.core;
    if (old) { old.outdatedAt = nowIso(); old.outdatedBy = item.id; }
    // LIFE_LOOP_PATCH：超上限改成归档（永不删除）
    enforceCap(p, cat, String(userId ?? '').trim());
    saveNow();
    return { item, duplicate: false, replaced: old };
  }

  function visible(item, viewerKey) {
    return item.scope !== 'private' || !viewerKey || item.sourceKey === viewerKey;
  }

  function findItem(userId, itemId) {
    const p = people[String(userId ?? '').trim()];
    if (!p) throw new Error('这个人还没有任何记忆');
    const idx = p.items.findIndex((x) => x.id === String(itemId ?? '').trim());
    if (idx < 0) throw new Error(`找不到记忆条目：${itemId}`);
    return { p, idx };
  }

  function update({ userId, itemId, text, cat, scope, viewerKey, due, by, status, core, archived, outdated }) {
    const { p, idx } = findItem(userId, itemId);
    const it = p.items[idx];
    if (!visible(it, viewerKey)) throw new Error('这条记忆不属于当前会话，不能修改');

    // LIFE_LOOP_PATCH：新参数（due / by / status / core / archived）先全部校验完再动条目，
    // 免得改了一半抛错、留下半截状态。旧参数（text / cat / scope）的行为保持不变。
    const uid = String(userId ?? '').trim();
    let nextText;
    if (text !== undefined) {
      nextText = redact(String(text).trim()).slice(0, MAX_TEXT);
      if (!nextText) throw new Error('内容不能为空');
    }
    if (cat !== undefined && !Object.hasOwn(CATEGORIES, cat)) throw new Error('类别不合法');
    const nextCat = cat !== undefined ? cat : it.cat;

    const dueIn = due == null ? '' : String(due).trim(); // 空串 = 清除
    const byIn = by == null ? '' : String(by).trim();
    const dueDay = (due !== undefined && dueIn) ? normalizeDueDate(dueIn) : null;
    const byWho = (by !== undefined && byIn) ? normalizeBy(byIn) : null;
    if (((due !== undefined && dueIn) || (by !== undefined && byIn)) && nextCat !== 'pending') {
      throw new Error('只有约定（pending）才能设到期日和谁答应的');
    }
    if (status !== undefined) {
      if (!PROMISE_STATUSES.includes(status)) throw new Error('状态只能是：open / done / missed / cancelled');
      if (nextCat !== 'pending') throw new Error('只有约定（pending）才有状态');
    }
    // DECAY_PATCH（规格 M5）：outdated 只认布尔值；undefined 表示这次不改。
    if (outdated !== undefined && typeof outdated !== 'boolean') throw new Error('outdated 只能是 true 或 false');
    // 同一次调用里可能同时改核心与归档，所以按「改完之后」的取值判断冲突。
    const willBeCore = core === true ? true : (core === false ? false : !!it.core);
    const willBeArchived = archived === true ? true : (archived === false ? false : !!it.archivedAt);
    // DECAY_PATCH：同理，按「改完之后」是否过时判断冲突
    const willBeOutdated = outdated === true ? true : (outdated === false ? false : !!it.outdatedAt);
    if (core === true) {
      if (willBeArchived) throw new Error('已归档的条目先恢复再设为核心');
      // DECAY_PATCH：已过时的条目不能直接设为核心（同一次调用里 outdated: false 可以一起传）
      if (willBeOutdated) throw new Error('已过时的条目先取消过时再设为核心');
      if (coreCount(p, it) >= CORE_MAX) throw new Error(`核心条目最多 ${CORE_MAX} 条，先用 qq_ltm_update 把一条的 core 设为 false`);
    }
    if (archived === true && willBeCore) throw new Error('核心条目不能归档，先取消核心');
    // DECAY_PATCH：核心条目不能标过时（同一次调用里 core: false 可以一起传）
    if (outdated === true && willBeCore) throw new Error('核心条目不能标过时，先取消核心');

    if (nextText !== undefined) it.text = nextText;
    if (cat !== undefined && cat !== it.cat) {
      it.cat = cat;
      if (cat === 'pending') {
        it.status = 'open';
        delete it.closedAt;
      } else {
        delete it.due;
        delete it.by;
        delete it.status;
        delete it.closedAt;
      }
    }
    if (scope === 'public' || scope === 'private') it.scope = scope;

    // LIFE_LOOP_PATCH：到期日 / 谁答应的（只有在传了的时候才动；空串清除）
    if (due !== undefined) {
      if (dueDay) it.due = dueDay; else delete it.due;
    }
    if (by !== undefined) {
      if (byWho) it.by = byWho; else delete it.by;
    }

    // LIFE_LOOP_PATCH：约定状态。只有 open → done / missed 需要记 closedAt 并回调；
    // 结束态之间互改只换标签（不重复通知）。
    let closedTo = null;
    if (status !== undefined) {
      const prev = it.status ?? 'open';
      if (status === 'open') {
        delete it.closedAt;
      } else if (prev === 'open') {
        it.closedAt = nowIso();
        if (status === 'done' || status === 'missed') closedTo = status;
      }
      it.status = status;
    }

    // LIFE_LOOP_PATCH：归档 / 恢复。恢复后暂不立刻 enforceCap，等下次 remember 时再收。
    if (archived === true) it.archivedAt = nowIso();
    else if (archived === false) delete it.archivedAt;
    if (core === true) it.core = true;
    else if (core === false) delete it.core;

    // DECAY_PATCH：过时 / 恢复。手动标过时不写 outdatedBy（它没有替代者）。
    // 和 status / core / archived 一样不算「内容变了」，不刷新 at。
    if (outdated === true) {
      if (!it.outdatedAt) it.outdatedAt = nowIso();
    } else if (outdated === false) {
      delete it.outdatedAt;
      delete it.outdatedBy;
    }

    // LIFE_LOOP_PATCH：at 只在「内容真的变了」时刷新 —— 标状态、设核心、归档不该让条目
    // 变成账本里最新的一条（renderFor 的「最近」是按写入顺序挑的）。
    if (text !== undefined || cat !== undefined || scope === 'public' || scope === 'private') it.at = nowIso();
    saveNow();

    if (closedTo) {
      try {
        if (typeof onPromiseClosed === 'function') {
          onPromiseClosed({ userId: uid, name: p.name, item: it, from: 'open', to: closedTo, viewerKey });
        }
      } catch (e) {
        // 回调是别人的事，失败了也不能影响这次修改的结果
        log(`[ltm] onPromiseClosed 失败：${e?.message ?? e}`);
      }
    }
    return it;
  }

  function forget({ userId, itemId, viewerKey }) {
    const { p, idx } = findItem(userId, itemId);
    if (!visible(p.items[idx], viewerKey)) throw new Error('这条记忆不属于当前会话，不能删除');
    const [removed] = p.items.splice(idx, 1);
    saveNow();
    return removed;
  }

  function personView(userId, viewerKey = null) {
    const p = people[String(userId ?? '').trim()];
    if (!p) return null;
    return { userId: String(userId), name: p.name, names: p.names, firstSeenAt: p.firstSeenAt, lastSeenAt: p.lastSeenAt, messages: p.messages, items: p.items.filter((x) => visible(x, viewerKey)) };
  }

  function listPeople() {
    // PERSONA_PATCH（v2 A1）：关系冷启动要算「认识多久」（seedRelations 的信任种子含 2 × 跨越天数），所以带上首条消息时间。
    return Object.entries(people).map(([id, p]) => ({ userId: id, name: p.name, names: p.names, items: p.items.length, messages: p.messages, firstSeenAt: p.firstSeenAt, lastSeenAt: p.lastSeenAt }))
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  }

  /** 给唤醒提示用的一段「你记得的事」。 */
  function renderFor(userIds, viewerKey, { maxChars = 1800, today } = {}) {
    // LIFE_LOOP_PATCH：今天的日期可注入（测试用假时钟）；缺省是本地今天。
    const day = today ? String(today) : ymd();
    const blocks = [];
    for (const uid of userIds) {
      const v = personView(uid, viewerKey);
      if (!v) continue;
      // LIFE_LOOP_PATCH：已归档的条目一律不注入
      // DECAY_PATCH（规格 M5）：已过时的条目不注入，也不计入「另有 N 条」
      const items = v.items.filter((x) => !x.archivedAt && !x.outdatedAt);
      if (!items.length) continue;
      const isOpenPromise = (x) => x.cat === 'pending' && (x.status ?? 'open') === 'open';
      // LIFE_LOOP_PATCH：已结束的约定（done / missed / cancelled）不渲染
      const renderable = (x) => !(x.cat === 'pending' && !isOpenPromise(x));
      // LIFE_LOOP_PATCH（规格 §4.5）：event 的日期前缀用**本地**日期。原来是 at.slice(0, 10)（UTC），
      // 凌晨 0～8 点记下的事会显示成前一天，和生活回路按本地日期说的「那天」对不上。
      const fmt = (x) => `${promiseMark(x, day)}${x.cat === 'event' ? `${Number.isFinite(Date.parse(x.at)) ? ymd(new Date(x.at)) : String(x.at ?? '').slice(0, 10)} ` : ''}${x.text}${byMark(x)}〔${x.id}〕`;
      const lines = [`· ${v.name || uid}（QQ ${uid}）`];
      // 参数：标签、要显示的条目、该类的未归档总数（「另有 N 条」只数未归档）
      const push = (label, shown, total) => {
        if (!shown.length) return;
        lines.push(`  ${label}：${shown.map(fmt).join('；')}${total > shown.length ? `（另有 ${total - shown.length} 条，用 qq_ltm_recall 查看）` : ''}`);
      };
      const openItems = items.filter(renderable);
      // 核心条目（任何类别）排最前，每次唤醒必带
      const core = openItems.filter((x) => x.core);
      push('核心', core, core.length);
      const promises = sortPromises(openItems.filter((x) => !x.core && isOpenPromise(x)), day);
      push('约定/没聊完', promises.slice(0, 10), promises.length);
      const tail = (label, cat, n) => {
        const arr = openItems.filter((x) => x.cat === cat && !x.core);
        // DECAY_PATCH（规格 M1 / M4）：没传 decayOf 时与改动前逐字相同；传了则按牢固度挑：
        // 冻死的换成别的条目，其余按 R 从高到低取前 n 条，显示时仍按写入顺序（arr 的顺序）。
        // 「另有 N 条」数 arr 全部（含冻结），和改动前口径一致。
        if (!decayFn) { push(label, arr.slice(-n), arr.length); return; }
        const scored = [];
        for (let i = 0; i < arr.length; i += 1) {
          let st = null;
          try { st = decayFn(arr[i], uid); } catch { st = null; }
          // 回调出错 / 返回的不是对象：按「R = 1、不冻结」处理，不能因为遗忘曲线坏了就不注入
          if (!st || typeof st !== 'object') { scored.push({ i, R: 1 }); continue; }
          if (st.frozen === true) continue;
          scored.push({ i, R: Number.isFinite(st.R) ? st.R : 1 });
        }
        scored.sort((a, b) => (b.R - a.R) || (b.i - a.i)); // R 相同：arr 里靠后的（更新的）优先
        const picked = scored.slice(0, n).sort((a, b) => a.i - b.i).map((s) => arr[s.i]);
        push(label, picked, arr.length);
      };
      tail('性格/喜好', 'trait', 15);
      tail('他说过的事', 'fact', 15);
      tail('最近的要紧事', 'event', 6);
      tail('其它', 'note', 5);
      // 只剩标题行（全是已结束的约定）时不占地方
      if (lines.length > 1) blocks.push(lines.join('\n'));
    }
    if (!blocks.length) return '';
    let out = blocks.join('\n');
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}…（已截断，用 qq_ltm_recall 查看完整记忆）`;
    return out;
  }

  // ── DECAY_PATCH：账本代谢（子项目 2 规格 §7.2 / §7.3、M2-a / M5）───────────
  // 相似提示：她记新事时桥接用它查「是不是在说同一件事」，由 AI 自己决定要不要 replaces。
  // 不额外调模型 —— 「中文 2 字切片 + 英文单词」的 Jaccard 已经够用。
  /** 切成词集合：中文取相邻 2 字片段（单字段落取这个字），英文 / 数字连续串整体算一个词。 */
  function tokenSet(text) {
    const set = new Set();
    const han = [];
    const ascii = [];
    const flushHan = () => {
      if (!han.length) return;
      if (han.length === 1) set.add(han[0]);
      else for (let i = 0; i + 1 < han.length; i += 1) set.add(han[i] + han[i + 1]);
      han.length = 0;
    };
    const flushAscii = () => {
      if (ascii.length) { set.add(ascii.join('')); ascii.length = 0; }
    };
    for (const ch of [...String(text ?? '').toLowerCase()]) {
      // HAN_RE 没有 g 标志，可以逐字反复 test
      if (HAN_RE.test(ch)) { flushAscii(); han.push(ch); }
      else if (/^[a-z0-9]$/.test(ch)) { flushHan(); ascii.push(ch); }
      else { flushHan(); flushAscii(); }
    }
    flushHan();
    flushAscii();
    return set;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    return inter / (a.size + b.size - inter);
  }

  /**
   * 和她记得的哪些条目「可能说的是同一件事」。只提示，不自动替换（规格 M5）。
   * 只看同一个人、当前会话可见、未过时、未归档的条目；按相似度降序取前 limit 条（1～5）。
   */
  function similarItems(userId, text, { cat, viewerKey, limit = 2, excludeIds = [] } = {}) {
    try {
      const t = String(text ?? '').trim();
      if (!t) return [];
      const p = people[String(userId ?? '').trim()];
      if (!p) return [];
      const a = tokenSet(t);
      if (!a.size) return [];
      const ex = new Set((Array.isArray(excludeIds) ? excludeIds : []).map((x) => String(x)));
      const n = Number(limit);
      const lim = Number.isFinite(n) ? Math.min(5, Math.max(1, Math.trunc(n))) : 2;
      const scored = [];
      for (const x of p.items) {
        if (!visible(x, viewerKey) || x.outdatedAt || x.archivedAt) continue;
        if (ex.has(x.id)) continue;
        if (cat !== undefined && x.cat !== cat) continue;
        const score = jaccard(a, tokenSet(x.text));
        if (score >= 0.35) scored.push({ id: x.id, text: x.text, score: Math.round(score * 1000) / 1000 });
      }
      scored.sort((x, y) => y.score - x.score);
      return scored.slice(0, lim);
    } catch (e) {
      log(`[ltm] similarItems 失败：${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 按关键词查条目（规格 M2-a）：qq_ltm_recall 带 query 时用它挑「想起」了哪几条。
   * query 按空白 / 标点切开；保留 ≥ 2 个码点的词，或 1 个码点的汉字（虚词除外）。
   * 条目文本包含任一词即命中。
   * 已过时、已归档的也返回（字段原样带）—— 「费劲想起」也算想起，工具永远查得到。
   */
  function matchItems(userId, viewerKey, query) {
    try {
      const p = people[String(userId ?? '').trim()];
      if (!p) return [];
      const words = String(query ?? '')
        .split(/[\s,，。.!！?？、;；:：'"“”‘’()（）\[\]【】<>《》\/|]+/)
        .map((s) => s.toLowerCase())
        // DECAY_PATCH：单个汉字可查（实词），单个英文字母 / 数字仍不保留
        .filter((s) => cpLen(s) >= 2 || (cpLen(s) === 1 && HAN_RE.test(s) && !MATCH_STOP_HAN.has(s)));
      if (!words.length) return [];
      return p.items.filter((x) => visible(x, viewerKey) && words.some((w) => String(x.text ?? '').toLowerCase().includes(w)));
    } catch (e) {
      log(`[ltm] matchItems 失败：${e?.message ?? e}`);
      return [];
    }
  }

  // ── LIFE_LOOP_PATCH：给「生活回路」用的三个查询（规格 §4.6）───────────────
  /** 某一天的到期约定，按人和状态分组；不做可见性过滤（调用方用 visibleTo 自己过）。 */
  function duePromises(day) {
    const d = String(day ?? '').trim();
    if (!d) return [];
    const out = [];
    for (const [id, p] of Object.entries(people)) {
      // DECAY_PATCH：已过时的约定不再触发到期唤醒
      const items = (p.items ?? []).filter((x) => x.cat === 'pending' && !x.archivedAt && !x.outdatedAt && (x.status ?? 'open') === 'open' && x.due === d);
      if (items.length) out.push({ userId: id, name: p.name || id, items });
    }
    return out.sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
  }

  /** 读一个会话的存档原始行（时间从旧到新），给「忽然想起」挑素材用。 */
  function archiveRows(key, { sinceMs = 0, untilMs = Infinity, dir = null, limit = 2000 } = {}) {
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 2000;
    const rows = [];
    for (const f of archiveFiles(key)) {
      let lines = [];
      try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
      for (const line of lines) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; } // 坏行跳过
        if (!row || typeof row !== 'object') continue;
        // RAG_PATCH（P2）：墓碑没有 t，本来就会被下面的 Date.parse 过滤掉；这里写明确，
        // 免得以后有人给墓碑补字段时它悄悄混进「忽然想起」的素材。
        if (row.deleted === true) continue;
        const t = Date.parse(row.t);
        if (!Number.isFinite(t) || t < sinceMs || t >= untilMs) continue;
        if (dir != null && row.dir !== dir) continue;
        rows.push({
          t: row.t,
          dir: row.dir,
          userId: row.userId == null ? null : String(row.userId),
          name: String(row.name ?? ''),
          text: String(row.text ?? ''),
          msgId: row.msgId == null ? null : String(row.msgId),
          _t: t
        });
      }
    }
    rows.sort((a, b) => a._t - b._t);
    // 超过上限保留最新的 limit 条
    const kept = rows.length > lim ? rows.slice(rows.length - lim) : rows;
    return kept.map(({ _t, ...row }) => row);
  }

  // ── DECAY_PATCH：按 refs 取回存档里的指定行（桥接把检索命中映射成消息单元用）──
  /**
   * refs 每项二选一：`{ file, line }`（单行）或 `{ file, lineStart, fileEnd, lineEnd }`
   * （一段，可能跨两个月份文件）。file 是相对 archive/ 的路径，行号从 1 起
   * （与 search(..., { debug: true }).hits、memory-rag 的 file / line_start 同一口径）。
   * 只接受本会话自己的 `keyDir/YYYY-MM.jsonl`：`..`、绝对路径、别的会话一律跳过。
   * 返回 `[{ t, dir, userId, name, text, msgId, file, line }]`，按存档顺序、按 file:line 去重，
   * 墓碑 / 坏行 / 空行跳过，最多 200 行。任何输入都不抛异常。
   */
  function rowsAt(key, refs) {
    const out = [];
    try {
      if (!/^(group|private):\d+$/.test(String(key ?? ''))) return out;
      if (!Array.isArray(refs) || !refs.length) return out;
      const kd = keyDir(key);
      const monthRe = /^\d{4}-\d{2}\.jsonl$/;
      const ordered = archiveFiles(key); // 月份升序
      const relOf = new Map(ordered.map((f) => [path.relative(ARCHIVE_DIR, f).split(path.sep).join('/'), f]));
      const cache = new Map(); // 同一文件本次调用只读一次
      const readLines = (rel) => {
        if (!cache.has(rel)) {
          const file = relOf.get(rel);
          let lines = [];
          try { if (file) lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { lines = []; }
          cache.set(rel, lines);
        }
        return cache.get(rel);
      };
      const seen = new Set();
      const MAX_ROWS = 200;
      for (const ref of refs) {
        if (out.length >= MAX_ROWS) break;
        if (!ref || typeof ref !== 'object') continue;
        const single = ref.line !== undefined;
        const relStart = String(ref.file ?? '');
        const relEnd = single ? relStart : String(ref.fileEnd ?? relStart);
        const lineStart = Number(single ? ref.line : ref.lineStart);
        const lineEnd = Number(single ? ref.line : ref.lineEnd);
        // 路径必须是「这个会话目录 + YYYY-MM.jsonl」，且文件真的存在
        const okRel = (rel) => {
          const parts = rel.split('/');
          return parts.length === 2 && parts[0] === kd && monthRe.test(parts[1]) && relOf.has(rel);
        };
        if (!okRel(relStart) || !okRel(relEnd)) continue;
        if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < 1) continue;
        const iStart = ordered.indexOf(relOf.get(relStart));
        const iEnd = ordered.indexOf(relOf.get(relEnd));
        if (iStart < 0 || iEnd < 0 || iStart > iEnd) continue;
        if (iStart === iEnd && lineStart > lineEnd) continue;
        for (let fi = iStart; fi <= iEnd && out.length < MAX_ROWS; fi += 1) {
          const rel = path.relative(ARCHIVE_DIR, ordered[fi]).split(path.sep).join('/');
          const lines = readLines(rel);
          const from = fi === iStart ? lineStart : 1;
          const to = fi === iEnd ? lineEnd : lines.length;
          for (let ln = from; ln <= to && ln <= lines.length && out.length < MAX_ROWS; ln += 1) {
            const raw = lines[ln - 1];
            if (!raw) continue;
            let row;
            try { row = JSON.parse(raw); } catch { continue; }
            if (!row || typeof row !== 'object' || row.deleted === true) continue;
            const id = `${rel}:${ln}`;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({
              t: String(row.t ?? ''),
              dir: row.dir,
              userId: row.userId == null ? null : String(row.userId),
              name: String(row.name ?? ''),
              text: String(row.text ?? ''),
              msgId: row.msgId == null ? null : String(row.msgId),
              file: rel,
              line: ln
            });
          }
        }
      }
    } catch (e) {
      log(`[ltm] rowsAt 失败：${e?.message ?? e}`);
    }
    return out;
  }

  // ── 聊天存档 ─────────────────────────────────────────────────────────────
  function archive(key, { dir, userId = null, name = '', text = '', msgId = null, at = null }) {
    try {
      const t = redact(String(text ?? '')).trim();
      if (!t) return;
      const d = at ? new Date(at) : new Date();
      const file = path.join(ARCHIVE_DIR, keyDir(key), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const row = { t: d.toISOString(), dir, userId: userId == null ? null : String(userId), name: String(name ?? ''), text: t.slice(0, 4000), msgId: msgId == null ? null : String(msgId) };
      fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (e) {
      log(`[ltm] 存档写入失败（${key}）：${e?.message ?? e}`);
    }
  }

  function archiveFiles(key) {
    const dir = path.join(ARCHIVE_DIR, keyDir(key));
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch {}
    return names.map((n) => path.join(dir, n));
  }

  function hasArchive(key) { return archiveFiles(key).length > 0; }

  /**
   * 在**一个会话**的存档里检索。
   * - 没有任何检索词（query 与 keywords 都空）→ browse：按日期/说话人过滤后从新到旧取 limit 条，按时间输出；
   * - 有检索词 → scored：按命中词数与词长加权、再乘 IDF，按分数降序（同分新的在前）。
   * query：旧调用是空格分隔的词，新调用是一句完整的话；from/to：YYYY-MM-DD；speaker：名字、QQ 号片段或「我」。
   * debug：附带 hits（存档相对路径 + 1 起行号），只给评估脚本用。
   */
  function search(key, { query = '', keywords = [], from = '', to = '', speaker = '', limit = 30, context = 0, maxChars = 3000, debug = false } = {}) {
    const sp = String(speaker ?? '').trim().toLowerCase();
    const fromT = from ? Date.parse(`${from}T00:00:00`) : -Infinity;
    const toT = to ? Date.parse(`${to}T23:59:59.999`) : Infinity;
    const lim = Math.min(100, Math.max(1, Number(limit) || 30));
    const ctx = Math.min(5, Math.max(0, Number(context) || 0));
    const maxLen = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Number(maxChars) : 3000;

    // 顺序读档：文件名按月份升序、文件内按追加顺序，天然就是时间顺序。
    // 行号要单独记（空行、坏行也占行号），debug.hits 需要它。
    const rows = [];
    for (const f of archiveFiles(key)) {
      const rel = path.relative(ARCHIVE_DIR, f);
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (let n = 0; n < lines.length; n += 1) {
        if (!lines[n]) continue;
        try {
          const row = JSON.parse(lines[n]);
          if (!row || typeof row !== 'object') continue;
          // RAG_PATCH（P2）：墓碑不是消息，不能进检索结果（行号计数照旧，_line 不变）。
          if (row.deleted === true) continue;
          row._file = rel;
          row._line = n + 1;
          rows.push(row);
        } catch {}
      }
    }
    const total = rows.length;

    const speakerOk = (r) => !sp
      || String(r.name ?? '').toLowerCase().includes(sp)
      || String(r.userId ?? '').includes(sp)
      || (sp === '我' && r.dir === 'out');
    const inRange = (r) => {
      const tt = Date.parse(r.t);
      return !(tt < fromT || tt > toT);
    };
    const hitView = (h) => ({ file: rows[h.i]._file, line: rows[h.i]._line, score: Math.round(h.score * 1000) / 1000 });

    const terms = buildSearchTerms(query, keywords);
    if (!terms.length) {
      // browse：保持旧行为（从新到旧凑够 limit 条，再按时间正序输出），只是多了总长上限。
      const picked = [];
      for (let i = rows.length - 1; i >= 0 && picked.length < lim; i -= 1) {
        const r = rows[i];
        if (!inRange(r) || !speakerOk(r)) continue;
        picked.push({ i, score: 0 });
      }
      picked.reverse();
      const rendered = renderHitGroups(rows, picked, ctx, maxLen, 'front');
      return {
        total,
        matched: picked.length,
        lines: rendered.lines,
        mode: 'browse',
        ...(debug ? { hits: rendered.kept.map(hitView) } : {})
      };
    }

    // scored：IDF 用整个会话的命中条数算（「本会话里命中的消息越多越不值钱」），
    // 日期/说话人只决定哪些消息能成为结果，不改变词的价值。
    const hays = rows.map((r) => String(r.text ?? '').toLowerCase());
    const df = new Map(terms.map((t) => [t.text, 0]));
    for (const hay of hays) {
      for (const t of terms) if (hay.includes(t.text)) df.set(t.text, df.get(t.text) + 1);
    }
    const N = total || 1;
    const weighted = terms.map((t) => ({
      text: t.text,
      weight: Math.pow(t.len, SEARCH_SCORE.lenPow)
        * (t.whole ? SEARCH_SCORE.wholeMult : 1)
        * Math.log(1 + N / (df.get(t.text) + 1))
    }));
    const scored = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (!inRange(rows[i]) || !speakerOk(rows[i])) continue;
      const hay = hays[i];
      let score = 0;
      for (const t of weighted) if (hay.includes(t.text)) score += t.weight;
      if (score > 0) scored.push({ i, score });
    }
    scored.sort((a, b) => (b.score - a.score)
      || ((Date.parse(rows[b.i].t) || 0) - (Date.parse(rows[a.i].t) || 0))
      || (b.i - a.i));
    const ranked = scored.slice(0, lim);
    const rendered = renderHitGroups(rows, ranked, ctx, maxLen, 'end');
    return {
      total,
      matched: scored.length,
      lines: rendered.lines,
      mode: 'scored',
      ...(debug ? { hits: rendered.kept.map(hitView) } : {})
    };
  }

  function archiveStats(key) {
    const files = archiveFiles(key);
    let count = 0;
    let first = null;
    for (const f of files) {
      let lines = [];
      try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
      for (const line of lines) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== 'object') continue;
        // RAG_PATCH（P2）：墓碑不算一条消息，也不参与 firstAt 的取数。
        if (row.deleted === true) continue;
        count += 1;
        if (first === null) first = row.t ?? null;
      }
    }
    return { months: files.map((f) => path.basename(f, '.jsonl')), messages: count, firstAt: first };
  }

  // ── RAG_PATCH（P2）：存档浏览与删除（控制台「存档」页用） ─────────────────
  /**
   * 列出一个会话在某段日期里的消息，从新到旧。
   * 返回 { total, rows }：total 是范围内的非墓碑条数，rows 最多 limit 条。
   */
  function listArchiveRows(key, { from = '', to = '', limit = 200 } = {}) {
    const fromD = parseDayArg(from, 'from');
    const toD = parseDayArg(to, 'to');
    if (fromD && toD && fromD > toD) throw new Error('from 不能晚于 to');
    const { startMs, endMs } = dayRangeMs(fromD, toD);
    const n = Number(limit);
    const lim = Number.isFinite(n) ? Math.min(500, Math.max(1, Math.trunc(n))) : 200;

    const rows = [];
    for (const f of archiveFiles(key)) {
      const rel = path.relative(ARCHIVE_DIR, f).split(path.sep).join('/');
      let lines = [];
      try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]) continue;
        let row;
        try { row = JSON.parse(lines[i]); } catch { continue; }
        if (!row || typeof row !== 'object' || row.deleted === true) continue;
        const tt = Date.parse(row.t);
        if (!Number.isFinite(tt) || tt < startMs || tt > endMs) continue;
        rows.push({
          _i: rows.length,
          _tt: tt,
          file: rel,
          line: i + 1,
          t: String(row.t ?? ''),
          dir: row.dir,
          userId: row.userId == null ? null : String(row.userId),
          name: String(row.name ?? ''),
          text: clipMessageText(row.text)
        });
      }
    }
    rows.sort((a, b) => (b._tt - a._tt) || (b._i - a._i)); // 从新到旧
    const total = rows.length;
    return { total, rows: rows.slice(0, lim).map(({ _i, _tt, ...row }) => row) };
  }

  /** 删掉 ≥1 行后写遗忘请求：memory-rag 停着就留给它起来后处理，向量库不会漏删。 */
  function writeForgetRequest(key) {
    fs.mkdirSync(FORGET_DIR, { recursive: true, mode: 0o700 });
    // recursive 模式只对「新建」的目录生效；已存在时显式收紧一次权限。
    try { fs.chmodSync(FORGET_DIR, 0o700); } catch {}
    writeFileAtomic(path.join(FORGET_DIR, `${keyDir(key)}.json`), JSON.stringify({ key, at: Date.now() }));
  }

  /**
   * 删存档里的消息（墓碑）。两种模式二选一：
   * - rows（最多 500 条，每项 { file, line, t }）—— 按行删，t 必须与那一行一致，防止删错行；
   * - from / to（YYYY-MM-DD，至少给一个）—— 按日期范围删范围内的所有非墓碑行。
   * 返回 { matched, deleted, skipped }；dryRun 只报 matched 不写任何东西。
   */
  function deleteArchiveRows(key, { rows = null, from = '', to = '', dryRun = false } = {}) {
    const files = archiveFiles(key); // key 不合法时这里就会抛
    if (!files.length) throw new Error(`这个会话还没有存档：${key}`);
    const byRows = Array.isArray(rows) && rows.length > 0;
    const fromD = parseDayArg(from, 'from');
    const toD = parseDayArg(to, 'to');
    const byRange = !!(fromD || toD);
    if (byRows && byRange) throw new Error('rows 与 from / to 只能二选一');
    if (!byRows && !byRange) throw new Error('要么给 rows，要么给 from / to');
    if (byRows && rows.length > DELETE_MAX_ROWS) throw new Error(`一次最多删除 ${DELETE_MAX_ROWS} 条`);
    if (fromD && toD && fromD > toD) throw new Error('from 不能晚于 to');
    const { startMs, endMs } = dayRangeMs(fromD, toD);

    const perFile = []; // [{ file, writes: [{ offset, len }] }]
    let matched = 0;
    let skipped = 0;

    if (byRows) {
      // matched 是「传入条数」：被跳过的行也算进来，控制台据此提示「有几条没删成」。
      matched = rows.length;
      // 只接受本会话现有的文件，且路径必须与 archiveFiles 里的相对路径**逐字相同**：
      // 这样 `..`、绝对路径、别的会话目录都自然被拒。
      const allowed = new Map(files.map((f) => [path.relative(ARCHIVE_DIR, f).split(path.sep).join('/'), f]));
      const byFile = new Map();
      for (const item of rows) {
        if (!item || typeof item !== 'object') throw new Error('rows 的每一项都要是 { file, line, t }');
        const rel = String(item.file ?? '');
        const file = allowed.get(rel);
        if (!file) throw new Error(`文件不属于这个会话：${rel}`);
        const line = Number(item.line);
        if (!Number.isInteger(line) || line < 1) throw new Error(`行号不合法：${item.line}`);
        const wantT = String(item.t ?? '');
        if (!byFile.has(file)) byFile.set(file, new Map());
        const linesMap = byFile.get(file);
        if (linesMap.has(line)) { skipped += 1; continue; } // 同一行重复出现，多出来的按跳过算
        linesMap.set(line, wantT);
      }
      for (const [file, linesMap] of byFile) {
        let buf;
        try { buf = fs.readFileSync(file); } catch { skipped += linesMap.size; continue; }
        const metas = lineMetas(buf);
        const writes = [];
        for (const [line, wantT] of linesMap) {
          const meta = metas[line - 1];
          if (!meta || !meta.len) { skipped += 1; continue; }
          let row;
          try { row = JSON.parse(buf.subarray(meta.start, meta.start + meta.len).toString('utf8')); } catch { skipped += 1; continue; }
          if (!row || typeof row !== 'object' || row.deleted === true) { skipped += 1; continue; }
          if (String(row.t ?? '') !== wantT) { skipped += 1; continue; }
          if (meta.len < TOMBSTONE_BYTES) { skipped += 1; continue; } // 太短的行塞不下墓碑
          writes.push({ offset: meta.start, len: meta.len });
        }
        if (writes.length) perFile.push({ file, writes });
      }
    } else {
      for (const file of files) {
        let buf;
        try { buf = fs.readFileSync(file); } catch { continue; }
        const metas = lineMetas(buf);
        const writes = [];
        for (const meta of metas) {
          if (!meta.len) continue;
          let row;
          try { row = JSON.parse(buf.subarray(meta.start, meta.start + meta.len).toString('utf8')); } catch { continue; }
          if (!row || typeof row !== 'object' || row.deleted === true) continue;
          const tt = Date.parse(row.t);
          if (!Number.isFinite(tt) || tt < startMs || tt > endMs) continue;
          matched += 1;
          if (meta.len < TOMBSTONE_BYTES) { skipped += 1; continue; }
          writes.push({ offset: meta.start, len: meta.len });
        }
        if (writes.length) perFile.push({ file, writes });
      }
    }

    if (dryRun) return { matched, deleted: 0, skipped };

    // 原地改写：同一个线程里同步写，和 archive() 的 appendFileSync 不会交错。
    let deleted = 0;
    for (const { file, writes } of perFile) {
      let fd = null;
      let done = 0; // 这个文件里已经成功改写成墓碑的条数
      try {
        fd = fs.openSync(file, 'r+');
        for (const w of writes) {
          // 墓碑 + ASCII 空格补齐到原来那一行的字节数（不含行尾 \n）。
          const payload = Buffer.alloc(w.len, 0x20);
          payload.write(TOMBSTONE, 0, 'ascii');
          fs.writeSync(fd, payload, 0, payload.length, w.offset);
          deleted += 1;
          done += 1;
        }
      } catch (e) {
        // 写失败时保留已经改好的墓碑：每一行都是自洽的，跳过失败的部分即可。
        // 只记会话、文件名和错误码——绝不记消息原文。
        log(`[ltm] 存档删除写入失败：${key} ${path.basename(file)} ${e?.code || e?.message || e}`);
        skipped += writes.length - done; // 没写成的行按跳过上报，别让控制台以为都删掉了
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      }
    }

    if (deleted > 0) writeForgetRequest(key);
    // 日志只记会话和条数，绝不记消息原文。
    log(`[ltm] 存档删除：${key} ${deleted} 条`);
    return { matched, deleted, skipped };
  }

  /** 还没被 memory-rag 消费的遗忘请求（memory-rag 停着也能看，控制台状态页用）。 */
  function pendingForgetKeys() {
    let names = [];
    try { names = fs.readdirSync(FORGET_DIR).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
    const out = [];
    for (const name of names) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(FORGET_DIR, name), 'utf8'));
        const key = String(obj?.key ?? '').trim();
        if (/^(group|private):\d+$/.test(key) && !out.includes(key)) out.push(key);
      } catch {}
    }
    return out;
  }

  function archiveKeys() {
    let names = [];
    try { names = fs.readdirSync(ARCHIVE_DIR); } catch {}
    return names.map((n) => n.replace('_', ':')).filter((k) => /^(group|private):\d+$/.test(k));
  }

  return {
    CATEGORIES,
    touch, remember, update, forget, personView, listPeople, renderFor,
    archive, hasArchive, search, archiveStats, archiveKeys,
    // RAG_PATCH（P2）：控制台的存档浏览 / 删除，以及给状态页看的遗忘请求队列
    listArchiveRows, deleteArchiveRows, pendingForgetKeys,
    // LIFE_LOOP_PATCH：生活回路要用的查询（visibleTo 是 visible 的公开别名）
    visibleTo: visible,
    duePromises,
    archiveRows,
    // DECAY_PATCH：账本代谢（M2-a 按关键词查、M5 相似提示）+ 桥接按行取回消息
    similarItems, matchItems, rowsAt,
    flush: () => { if (saveTimer) saveNow(); }
  };
}
