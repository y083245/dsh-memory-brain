// 每日报表（REPORT_PATCH，子项目 4 v1，规格 docs/design/DAILY_REPORT_SPEC.md，
// 接口约定 docs/design/worker-kit/report/contract.md）。
//
// 干什么：按本机时区的自然日，从桥接已有的文件里统计她这一天的收发、记忆、花费、
// 服务状态和说话习惯；每天给前一天写一份「只有数字」的快照，启动时补算最近缺的日子。
// 不调模型、不花钱、不改任何发给她的提示词。
//
// 数据从哪来（全部只读）：
//   state/long-memory/archive/<会话>/<YYYY-MM>.jsonl   聊天存档（墓碑行跳过）
//   state/tool-calls.jsonl                             工具调用（只读 time/type/ok/tool/key）
//   state/token-usage.jsonl                            回合 token 用量（k=turn，后到覆盖先到）
//   state/persona/usage.json                           人格判读用量
//   state/long-memory/rag/distill-usage.json           联想提炼用量（含当天抽出的账本建议条数）
//   state/long-memory/suggest-state.json               账本建议状态（只读 status / statusAt，不含原文）
//   state/life-loop.json                               忽然想起 / 到期提醒
//   state/long-memory/recall-shadow/<YYYY-MM>.jsonl    自动想起（影子）
//   state/daily-report/counters.json                   桥接计数与心跳区间（本模块自己写）
//                                                      heartbeats[day] = [[fromMinuteMs, toMinuteMs], …]
//
// 为什么快照里不存原文：快照会长期保存并给控制台展示，而存档、工具参数里有聊天原文、
// 本机路径和密钥。这里只留数字与表情包名字；工具调用的 `args` 一律不读、不进日志。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULT_PRICE_TABLE, normalizeUsage, priceUsage } from './model-prices.js';

const MINUTE = 60000;
const FIVE_MIN = 5 * MINUTE;

// 说话习惯的判定常量。
// 来源：2026-10-30 夜对存档 336 条她发出的消息的统计，见规格 §1（几乎没有客服腔，
// 真正的问题是劝睡劝吃、「行，」开头和重复表情包）。
export const SPEECH = {
  // 句尾语气词（允许后面跟标点 / 空白）：用于「语气词收尾」比例。
  PARTICLE_END_RE: /(吧|呢|啊|呀|哦|嘛|啦)[，。！？!?~～…\s]*$/,
  // 「行，/行吧/行。/行 」开头：这是她最明显的口头习惯。
  XING_OPEN_RE: /^行(，|,|吧|。|\s)/,
  // 劝睡劝吃：规格 §1 统计里最扎眼的一类重复。
  CARE_RE: /睡|熬夜|别熬|吃点|吃饭|休息|歇会|注意身体|别太累|收手/,
  // 少于这个条数，比例类数字没有意义（规格 §2.5）。
  MIN_TEXTS: 5
};

// 报错判定（规格 §4.2）。排除列表的出处：CLAUDE.md 坑 8（SnowLuma 首次连接的
// WS 令牌自愈流程会打「SnowLuma 错误：{}」「首次连接未成功」「连接断开 code=1006」）、
// 坑 9（qq-tool-restrict 的 restrict 失败是回归名单的预期日志）。
export const ERROR_RE = /失败|错误|异常|超时|Error|error|ECONN|EPIPE/;
export const BENIGN_RES = [
  /SnowLuma 错误：\{\}/,
  /自愈/,
  /qq-tool-restrict restrict 失败/,
  /首次连接未成功/,
  /SnowLuma 连接断开（code=1006）/,
  /WS 同步不可用/
];

/** 一行日志算不算真正的报错。非字符串一律不算。 */
export function isErrorLine(text) {
  if (typeof text !== 'string' || !text) return false;
  if (!ERROR_RE.test(text)) return false;
  return !BENIGN_RES.some((re) => re.test(text));
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 时间戳 → 本机时区的自然日 `YYYY-MM-DD`（不用 own-life 的「活动日」口径）。 */
export function dayOf(ms) {
  let n = NaN;
  try { n = Number(ms); } catch { n = NaN; }
  const d = new Date(Number.isFinite(n) ? n : Date.now());
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 校验并返回严格的 `YYYY-MM-DD`（非法 / 不存在返回 null）。 */
function strictDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return day;
}

/** 某天的本地零点毫秒。 */
function dayStartMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** 日期加减天数（用 Date 构造器处理跨月 / 跨年）。 */
function shiftDay(day, delta) {
  const [y, m, d] = String(day).split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const finiteOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round4 = (x) => Math.round((Number(x) + Number.EPSILON) * 1e4) / 1e4;
const round3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1e3) / 1e3;

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

/** 时间字段可能写成毫秒数，也可能是 ISO 字符串。 */
function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

/** 只留下「文字消息」：非空字符串，且去掉空白后不以 `[` 开头（排除图片 / 表情 / 语音）。 */
function textList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const text of list) {
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('[')) continue;
    out.push(text);
  }
  return out;
}

/** 字数：去掉所有空白后按字符数（emoji 算一个字符）。 */
const charLen = (text) => Array.from(text.replace(/\s+/g, '')).length;

/** 中位数，偶数个取中间两个的平均，结果保留 1 位小数。 */
function medianOf(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = arr.length >> 1;
  const m = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  return Math.round(m * 10) / 10;
}

/** 命中正则的条数比例（0～1，保留 3 位）。 */
function ratioOf(list, re) {
  if (!list.length) return null;
  let hit = 0;
  for (const text of list) if (re.test(text)) hit++;
  return round3(hit / list.length);
}

/** 每条消息的平均逗号数（全角 + 半角）。 */
function commasOf(list) {
  if (!list.length) return null;
  let total = 0;
  for (const text of list) total += (text.match(/[，,]/g) ?? []).length;
  return round3(total / list.length);
}

/** 表情包名字统计：出现 ≥ 2 次的，按次数降序，最多 5 个。 */
function stickersOf(rawOut) {
  if (!Array.isArray(rawOut)) return [];
  const counts = new Map();
  for (const text of rawOut) {
    if (typeof text !== 'string') continue;
    const re = /\[表情包:([^\]]+)\]/g;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 5)
    .map(([name, n]) => [name, n]);
}

/**
 * 「她的说话」统计。导出的纯函数，调用方传进来的已经是某个会话 / 全部会话的消息。
 * 比例类字段在条数不足 5 条时为 null（contract §1）。
 */
export function speechStats(herTexts, theirTexts, herRawOut = []) {
  const her = textList(herTexts);
  const their = textList(theirTexts);
  const herN = her.length;
  const theirN = their.length;
  const enoughHer = herN >= SPEECH.MIN_TEXTS;
  const enoughTheir = theirN >= SPEECH.MIN_TEXTS;
  return {
    herMedianLen: enoughHer ? medianOf(her.map(charLen)) : null,
    theirMedianLen: enoughTheir ? medianOf(their.map(charLen)) : null,
    herCommas: enoughHer ? commasOf(her) : null,
    theirCommas: enoughTheir ? commasOf(their) : null,
    herParticleEnd: enoughHer ? ratioOf(her, SPEECH.PARTICLE_END_RE) : null,
    theirParticleEnd: enoughTheir ? ratioOf(their, SPEECH.PARTICLE_END_RE) : null,
    xingOpen: enoughHer ? ratioOf(her, SPEECH.XING_OPEN_RE) : null,
    care: enoughHer ? ratioOf(her, SPEECH.CARE_RE) : null,
    herTextCount: herN,
    theirTextCount: theirN,
    stickers: stickersOf(herRawOut)
  };
}

/** 原子的 600 权限写文件（照 src/persona-store.js 的写法，避免半截文件）。 */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* 权限改不动不影响写入 */ }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** 流式逐行读 JSONL：大文件不整份进内存，坏行 / 不是文件的路径都当没数据。 */
async function forEachLine(file, fn) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
    // 目录 / 权限之类的错误会异步抛出；先挂一个监听器，避免没有监听者时炸进程。
    stream.on('error', () => {});
  } catch {
    return;
  }
  let rl;
  try {
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line.replace(/^﻿/, '')); } catch { continue; }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      try { fn(row); } catch { /* 单行处理失败不影响其余行 */ }
    }
  } catch {
    // 读文件本身出错（目录、权限、被删）当作没有数据。
  } finally {
    try { rl?.close(); } catch { /* ignore */ }
    try { stream.destroy(); } catch { /* ignore */ }
  }
}

/** 全部字段齐全的空报表（读不到任何来源时用，保证调用方拿到的形状一致）。 */
function emptyReport(day, today) {
  const partial = !today;
  return {
    version: 1,
    day,
    createdAt: Date.now(),
    partial,
    sessions: {},
    memory: {
      ltmRemember: 0, ltmUpdate: 0, ltmForget: 0, queries: 0,
      ltmTotal: null, ltmFaded: null, ltmOutdated: null,
      ownLifeDay: partial ? null : 0,
      ownLifeMidnight: partial ? null : 0,
      recalls: 0, associations: 0, promiseWakes: 0,
      shadow: 0, shadowPass: 0, shadowSkipped: 0,
      distillCalls: 0, distillOk: 0, distillFailed: 0,
      // SUGGEST_PATCH：账本建议（contract §4）。读不到就是 null，不是 0。
      suggestCreated: null,
      suggestAdopted: null, suggestDuplicate: null, suggestExpired: null, suggestDismissed: null
    },
    cost: {
      dsh: 0, persona: 0, distill: 0, total: 0,
      personaCalls: 0, personaRules: 0, personaFailures: 0
    },
    service: { errors: partial ? null : 0, longestGapMin: partial ? null : 0 },
    speechAll: {
      herMedianLen: null, theirMedianLen: null, xingOpen: null, care: null,
      herTextCount: 0, theirTextCount: 0
    }
  };
}

/**
 * 把心跳列表统一成「区间」：`[[fromMinuteMs, toMinuteMs], …]`，升序，两端都含。
 *
 * 旧格式是每分钟一个时间戳的数组（30 天 × 1440 个整数会把 counters.json 撑到几百 KB，
 * 且每分钟整份重写）。读到旧格式时就当成每分钟一个点、连续分钟合并成区间再用，
 * 不需要单独迁移文件。
 */
function normalizeHeartbeatList(raw) {
  if (!Array.isArray(raw)) return [];
  const minutes = [];
  const intervals = [];
  for (const item of raw) {
    if (Array.isArray(item)) {
      const from = Number(item[0]);
      const to = Number(item[1]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const a = Math.floor(from / MINUTE) * MINUTE;
      const b = Math.floor(to / MINUTE) * MINUTE;
      if (b < a) continue;
      intervals.push([a, b]);
    } else {
      const n = Number(item);
      if (Number.isFinite(n)) minutes.push(Math.floor(n / MINUTE) * MINUTE);
    }
  }

  // 旧格式：排序去重后把连续的分钟并成区间。
  if (minutes.length) {
    minutes.sort((a, b) => a - b);
    let start = null;
    let prev = null;
    for (const m of minutes) {
      if (m === prev) continue;
      if (start == null) { start = m; prev = m; continue; }
      if (m === prev + MINUTE) { prev = m; continue; }
      intervals.push([start, prev]);
      start = m;
      prev = m;
    }
    if (start != null) intervals.push([start, prev]);
  }

  // 排序并把重叠 / 相邻的区间并起来，保证 heartbeat() 只需要看最后一个区间。
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1] + MINUTE) {
      if (interval[1] > last[1]) last[1] = interval[1];
    } else {
      merged.push([interval[0], interval[1]]);
    }
  }
  return merged;
}

/**
 * 创建每日报表实例。
 *
 * @param {object} opts
 * @param {string} opts.stateDir        桥接的 STATE_DIR
 * @param {() => number} [opts.now]     假时钟（测试用）
 * @param {() => object} [opts.getLive] 桥接注入的实时状态（这里只用 ltmTotals）
 * @param {(line: string) => void} [opts.log]
 * @param {object} [opts.priceTable]    默认 DEFAULT_PRICE_TABLE
 * @param {(kind: string, day: string) => void} [opts.onScan]
 *        仅测试用：每打开一个来源文件（archive / tool-calls / token-usage / shadow）时回调一次，
 *        用来验证过去日子的结果缓存没有再扫文件。生产不传。
 */
export function createDailyReport({
  stateDir,
  now = () => Date.now(),
  getLive = () => ({}),
  ragHealth,
  priceTable = DEFAULT_PRICE_TABLE,
  log = () => {},
  onScan
} = {}) {
  // stateDir 不合法时用一个肯定不存在的目录，保证所有读操作都落到「没有数据」。
  const rootDir = typeof stateDir === 'string' && stateDir.trim()
    ? stateDir
    : path.join(process.cwd(), '.daily-report-no-state');
  const countersFile = path.join(rootDir, 'daily-report', 'counters.json');
  const table = priceTable && typeof priceTable === 'object' ? priceTable : DEFAULT_PRICE_TABLE;

  // ragHealth 保留在签名里（规格 §4.1），但 live 由桥接组装后原样传入（contract §4），
  // 这里不重复调用它，避免两边各查一次 /health。
  void ragHealth;

  const loggedKeys = new Set();
  function logOnce(key, line) {
    if (loggedKeys.has(key)) return;
    loggedKeys.add(key);
    try { log(line); } catch { /* 日志函数自己出错也不能影响报表 */ }
  }

  /** 仅测试用的扫描打桩；出错也不影响统计。 */
  function noteScan(kind, day) {
    if (typeof onScan !== 'function') return;
    try { onScan(kind, day); } catch { /* ignore */ }
  }

  let counters = null;
  let countersLoaded = false;
  let countersDirty = false;
  let todayCache = null; // { day, at, report, openers }

  // 过去日子的统计结果缓存：没有快照的日子（尤其是 hasData=false 的）会被 series / prev
  // 反复扫 tool-calls.jsonl、token-usage.jsonl；这两个文件每天约涨 100 KB，不缓存会越来越慢。
  const pastCache = new Map(); // day -> { at, result }
  const PAST_CACHE_MS = 10 * MINUTE;
  const PAST_CACHE_MAX = 90;

  const counterNames = new Set(['error', 'ownLifeDay', 'ownLifeMidnight', 'injectOn']);

  function ensureCounters() {
    if (countersLoaded) return counters;
    countersLoaded = true;
    const parsed = readJson(countersFile);
    const days = parsed && typeof parsed.days === 'object' && parsed.days && !Array.isArray(parsed.days) ? parsed.days : {};
    const heartbeats = {};
    const rawHeartbeats = parsed && typeof parsed.heartbeats === 'object' && parsed.heartbeats && !Array.isArray(parsed.heartbeats)
      ? parsed.heartbeats
      : {};
    for (const [day, raw] of Object.entries(rawHeartbeats)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const intervals = normalizeHeartbeatList(raw);
      if (intervals.length) heartbeats[day] = intervals;
    }
    counters = { version: 1, days, heartbeats };
    return counters;
  }

  /** 只保留最近 30 天（今天 + 之前 29 天）。 */
  function pruneCounters() {
    const c = ensureCounters();
    const cutoff = shiftDay(dayOf(now()), -29);
    let changed = false;
    for (const day of Object.keys(c.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff) { delete c.days[day]; changed = true; }
    }
    for (const day of Object.keys(c.heartbeats)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff) { delete c.heartbeats[day]; changed = true; }
    }
    if (changed) countersDirty = true;
  }

  function writeCounters() {
    if (!countersDirty) return false;
    try {
      writeFileAtomic(countersFile, JSON.stringify(ensureCounters()));
      countersDirty = false;
      return true;
    } catch (error) {
      // 同样的错误只打一行；不带任何内容。
      logOnce(`counters-write:${error?.code ?? 'error'}`, `[report] 计数文件写入失败（${error?.code ?? 'error'}）`);
      return false;
    }
  }

  // ── 各来源的读取 ───────────────────────────────────────────────────────

  /** 聊天存档：只读当天那个月份文件；墓碑行（{"deleted":true}）跳过。 */
  async function readArchives(day) {
    const month = day.slice(0, 7);
    const root = path.join(rootDir, 'long-memory', 'archive');
    const map = new Map();
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return map; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, `${month}.jsonl`);
      if (!fs.existsSync(file)) continue;
      noteScan('archive', day);
      const key = entry.name.replace('_', ':');
      await forEachLine(file, (row) => {
        if (row.deleted === true) return;
        if (row.dir !== 'in' && row.dir !== 'out') return;
        const t = timeOf(row.t);
        if (!Number.isFinite(t) || dayOf(t) !== day) return;
        let session = map.get(key);
        if (!session) {
          session = { in: 0, out: 0, herTexts: [], theirTexts: [], rawOut: [] };
          map.set(key, session);
        }
        if (row.dir === 'in') {
          session.in++;
          if (typeof row.text === 'string') session.theirTexts.push(row.text);
        } else {
          session.out++;
          if (typeof row.text === 'string') {
            session.rawOut.push(row.text);
            session.herTexts.push(row.text);
          }
        }
      });
    }
    return map;
  }

  /** 工具调用：`args` 里可能有聊天原文，这里绝不读它。 */
  async function readToolCalls(day) {
    const out = { bySession: new Map(), remember: 0, update: 0, forget: 0, queries: 0, rows: 0 };
    noteScan('tool-calls', day);
    await forEachLine(path.join(rootDir, 'tool-calls.jsonl'), (row) => {
      const t = timeOf(row.time);
      if (!Number.isFinite(t) || dayOf(t) !== day) return;
      out.rows++;
      if (row.type === 'call') {
        if (typeof row.key === 'string' && row.key) {
          out.bySession.set(row.key, (out.bySession.get(row.key) ?? 0) + 1);
        }
        return;
      }
      if (row.type !== 'result' || row.ok !== true) return;
      // 工具名带 `mcp__snowluma__` 前缀，按最后一个 `__` 之后的短名匹配。
      const name = String(row.tool ?? '').split('__').pop();
      if (name === 'qq_ltm_remember') out.remember++;
      else if (name === 'qq_ltm_update') out.update++;
      else if (name === 'qq_ltm_forget') out.forget++;
      else if (name === 'qq_history_search' || name === 'qq_ltm_recall') out.queries++;
    });
    return out;
  }

  /** token 用量：同一 (sid, turn, step, retry) 后到覆盖先到；k=base 不算当天花费。 */
  async function readTokenUsage(day) {
    const samples = new Map();
    const turnsBySession = new Map();
    let rows = 0;
    noteScan('token-usage', day);
    await forEachLine(path.join(rootDir, 'token-usage.jsonl'), (row) => {
      if (row.k !== 'turn' && row.k !== 'base') return;
      const t = timeOf(row.t);
      if (!Number.isFinite(t) || dayOf(t) !== day) return;
      rows++;
      if (row.k !== 'turn') return;
      const sampleKey = [row.sid ?? '', row.turn ?? '', row.step ?? '', row.retry ?? ''].join('|');
      samples.set(sampleKey, row);
    });
    let cost = 0;
    for (const row of samples.values()) {
      const priced = priceUsage(normalizeUsage(row.b), { model: row.model, at: timeOf(row.t), table });
      cost += num(priced?.cost?.total);
      const sessionKey = typeof row.key === 'string' ? row.key : '';
      let set = turnsBySession.get(sessionKey);
      if (!set) {
        set = new Set();
        turnsBySession.set(sessionKey, set);
      }
      set.add(`${row.sid ?? ''}|${row.turn ?? ''}`);
    }
    return { cost: round4(cost), turnsBySession, rows };
  }

  function readPersonaUsage(day) {
    const out = { cost: 0, calls: 0, rules: 0, failures: 0, present: false };
    const parsed = readJson(path.join(rootDir, 'persona', 'usage.json'));
    const entry = parsed?.days?.[day];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return out;
    out.present = true;
    for (const run of Object.values(entry)) {
      if (!run || typeof run !== 'object') continue;
      out.cost += num(run.cost);
      out.calls += num(run.calls);
      out.rules += num(run.rules);
      out.failures += num(run.failures);
    }
    out.cost = round4(out.cost);
    return out;
  }

  function readDistillUsage(day) {
    const parsed = readJson(path.join(rootDir, 'long-memory', 'rag', 'distill-usage.json'));
    const entry = parsed?.days?.[day];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { calls: 0, ok: 0, failed: 0, cost: 0, notes: null, present: false };
    }
    return {
      calls: num(entry.calls),
      ok: num(entry.ok),
      failed: num(entry.failed),
      cost: round4(num(entry.cost)),
      // SUGGEST_PATCH：当天写进 ledger_notes 的候选条数（提炼 + 回补合计）。
      // 没有这个键（上线前的日期）或值是 null / 空串 → null，页面显示「—」。
      // 不能直接 finiteOrNull：Number(null) 和 Number('') 都是 0，会被当成「那天抽了 0 条」。
      notes: entry.notes == null || entry.notes === '' ? null : finiteOrNull(entry.notes),
      present: true
    };
  }

  /**
   * SUGGEST_PATCH：账本建议的采用 / 重复 / 作废 / 手动作废，按状态文件里的 `statusAt`
   * 落在哪一天（本机时区自然日）分组计数（contract §4）。
   *
   * 文件不存在、坏 JSON、没有 `items` 一律返回 null——那几种情况都读不出「当天几条」，
   * 报表要显示「—」，不能拿 0 冒充。状态文件本来就不含原文，这里只读 status / statusAt。
   */
  function readSuggestState(day) {
    const parsed = readJson(path.join(rootDir, 'long-memory', 'suggest-state.json'));
    const items = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.items : null;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return null;
    const out = { adopted: 0, duplicate: 0, expired: 0, dismissed: 0 };
    for (const item of Object.values(items)) {
      if (!item || typeof item !== 'object') continue;
      // statusAt 为 null（还「待处理」）的条目不算在任何一天；Number(null) 是 0，要单独挡掉。
      const at = item.statusAt == null ? NaN : Number(item.statusAt);
      if (!Number.isFinite(at) || dayOf(at) !== day) continue;
      if (item.status === 'adopted') out.adopted++;
      else if (item.status === 'duplicate') out.duplicate++;
      else if (item.status === 'expired') out.expired++;
      else if (item.status === 'dismissed') out.dismissed++;
    }
    return out;
  }

  function readLifeLoop(day) {
    const out = { recalls: 0, associations: 0, promiseWakes: 0, rows: 0 };
    const parsed = readJson(path.join(rootDir, 'life-loop.json'));
    const history = Array.isArray(parsed?.history) ? parsed.history : [];
    for (const item of history) {
      if (!item || typeof item !== 'object') continue;
      const at = Number(item.at);
      if (!Number.isFinite(at) || dayOf(at) !== day) continue;
      out.rows++;
      if (item.kind === 'recall') out.recalls++;
      else if (item.kind === 'associate') out.associations++;
      else if (item.kind === 'promise-wake') out.promiseWakes++;
    }
    return out;
  }

  async function readShadow(day) {
    const out = { shadow: 0, shadowPass: 0, shadowSkipped: 0, rows: 0 };
    const file = path.join(rootDir, 'long-memory', 'recall-shadow', `${day.slice(0, 7)}.jsonl`);
    noteScan('shadow', day);
    await forEachLine(file, (row) => {
      const at = Number(row.at);
      // 没有 at 或 candidates 不是数组的行（标注行等其它形状）跳过、不计数。
      if (!Number.isFinite(at) || !Array.isArray(row.candidates)) return;
      if (dayOf(at) !== day) return;
      out.rows++;
      out.shadow++;
      if (row.candidates.some((c) => c && c.pass === true)) out.shadowPass++;
      if (row.skipped != null && row.skipped !== '') out.shadowSkipped++;
    });
    return out;
  }

  /**
   * 当天桥接「不在」的最长一段（分钟）。入参是当天的区间列表（升序、两端都含）：
   * 只有「前一个区间的 to」到「后一个区间的 from」之间才可能有中断，区间内部是连续的。
   */
  function longestGapMin(day, intervals, isToday) {
    if (!intervals.length) return isToday ? 0 : null;
    const startOfDay = dayStartMs(day);
    const endOfDay = dayStartMs(shiftDay(day, 1));
    const c = ensureCounters();
    const prevRaw = c.heartbeats[shiftDay(day, -1)];
    let prevEnd = null;
    if (Array.isArray(prevRaw) && prevRaw.length) {
      const lastPrev = prevRaw[prevRaw.length - 1];
      if (Array.isArray(lastPrev)) prevEnd = Number(lastPrev[1]);
    }

    let best = 0;
    const checkGap = (from, to) => {
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      if (to - from <= FIVE_MIN) return;
      // 缺失的分钟 = 两段心跳之间除两端之外的分钟；跨午夜那段只数落在这一天里的。
      const missingFrom = Math.max(from + MINUTE, startOfDay);
      const missingTo = Math.min(to - MINUTE, endOfDay - MINUTE);
      if (missingTo < missingFrom) return;
      best = Math.max(best, Math.floor((missingTo - missingFrom) / MINUTE) + 1);
    };

    for (const interval of intervals) {
      if (!Array.isArray(interval)) continue;
      const from = Number(interval[0]);
      const to = Number(interval[1]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      if (prevEnd != null) checkGap(prevEnd, from);
      prevEnd = to;
    }

    // 今天：最后一个区间的 to 到 now 也算一段（桥接活着时这段 ≤ 1 分钟，不会误报）。
    if (isToday && prevEnd != null) {
      const nowMs = Number(now());
      if (Number.isFinite(nowMs) && nowMs - prevEnd > FIVE_MIN) {
        const missingFrom = prevEnd + MINUTE;
        const missingTo = Math.floor(nowMs / MINUTE) * MINUTE;
        if (missingTo >= missingFrom) {
          best = Math.max(best, Math.floor((missingTo - missingFrom) / MINUTE) + 1);
        }
      }
    }
    return best;
  }

  /** 每个会话的常用开头（前 2 个字符，出现 ≥ 2 次的前 3 个）。 */
  function openersFor(herTexts) {
    const counts = new Map();
    for (const text of textList(herTexts)) {
      const head = Array.from(text).slice(0, 2).join('');
      if (!head) continue;
      counts.set(head, (counts.get(head) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 3);
  }

  // ── 现算某一天 ─────────────────────────────────────────────────────────

  /** 真正去读文件算一天；过去日子的结果由外层 collect() 缓存。 */
  async function collectUncached(day) {
    try {
      const today = day === dayOf(now());
      const c = ensureCounters();
      const dayCounters = c.days[day] && typeof c.days[day] === 'object' ? c.days[day] : null;
      const heartbeats = Array.isArray(c.heartbeats[day]) ? c.heartbeats[day] : [];
      // 过去的日子：既没有计数、也没有任何心跳区间 → 这天的快照是补算的（contract §1）。
      const partial = !today && !dayCounters && heartbeats.length === 0;

      const archives = await readArchives(day);
      const tools = await readToolCalls(day);
      const tokens = await readTokenUsage(day);
      const persona = readPersonaUsage(day);
      const distill = readDistillUsage(day);
      const loop = readLifeLoop(day);
      const shadow = await readShadow(day);
      const suggest = readSuggestState(day);

      const sessions = {};
      const openers = {};
      const allHer = [];
      const allTheir = [];
      for (const key of [...archives.keys()].sort()) {
        const session = archives.get(key);
        if (session.in + session.out <= 0) continue;
        allHer.push(...session.herTexts);
        allTheir.push(...session.theirTexts);
        sessions[key] = {
          in: session.in,
          out: session.out,
          turns: tokens.turnsBySession.get(key)?.size ?? 0,
          toolCalls: tools.bySession.get(key) ?? 0,
          speech: speechStats(session.herTexts, session.theirTexts, session.rawOut)
        };
        const list = openersFor(session.herTexts);
        if (list.length) openers[key] = list;
      }

      const all = speechStats(allHer, allTheir);
      const speechAll = {
        herMedianLen: all.herMedianLen,
        theirMedianLen: all.theirMedianLen,
        xingOpen: all.xingOpen,
        care: all.care,
        herTextCount: all.herTextCount,
        theirTextCount: all.theirTextCount
      };

      const report = {
        version: 1,
        day,
        createdAt: num(now()) || Date.now(),
        partial,
        sessions,
        memory: {
          ltmRemember: tools.remember,
          ltmUpdate: tools.update,
          ltmForget: tools.forget,
          queries: tools.queries,
          // 账本现状只有桥接知道（live.ltmTotals）；不传就是 null。
          ltmTotal: null,
          ltmFaded: null,
          ltmOutdated: null,
          ownLifeDay: partial ? null : num(dayCounters?.ownLifeDay),
          ownLifeMidnight: partial ? null : num(dayCounters?.ownLifeMidnight),
          recalls: loop.recalls,
          associations: loop.associations,
          promiseWakes: loop.promiseWakes,
          shadow: shadow.shadow,
          shadowPass: shadow.shadowPass,
          shadowSkipped: shadow.shadowSkipped,
          distillCalls: distill.calls,
          distillOk: distill.ok,
          distillFailed: distill.failed,
          // SUGGEST_PATCH：账本建议（contract §4）。快照里同样只有这些数字。
          suggestCreated: distill.notes,
          suggestAdopted: suggest ? suggest.adopted : null,
          suggestDuplicate: suggest ? suggest.duplicate : null,
          suggestExpired: suggest ? suggest.expired : null,
          suggestDismissed: suggest ? suggest.dismissed : null
        },
        cost: {
          dsh: tokens.cost,
          persona: persona.cost,
          distill: distill.cost,
          total: round4(tokens.cost + persona.cost + distill.cost),
          personaCalls: persona.calls,
          personaRules: persona.rules,
          personaFailures: persona.failures
        },
        service: {
          errors: partial ? null : num(dayCounters?.error),
          longestGapMin: partial ? null : longestGapMin(day, heartbeats, today)
        },
        speechAll
      };

      const hasData = archives.size > 0 ||
        tools.rows > 0 ||
        tokens.rows > 0 ||
        persona.present ||
        distill.present ||
        loop.rows > 0 ||
        shadow.rows > 0;

      return { report, openers, hasData };
    } catch (error) {
      logOnce('collect', `[report] 统计来源读取失败（${error?.code ?? 'error'}）`);
      return { report: emptyReport(day, day === dayOf(now())), openers: {}, hasData: false };
    }
  }

  /**
   * 过去日子的统计结果缓存 10 分钟（今天不缓存——今天有自己的 60 秒 compute 缓存）。
   * 没有快照、也没有数据的日子永远不会写快照，不缓存的话 series / prev 每次都会重扫
   * tool-calls.jsonl 与 token-usage.jsonl。返回深拷贝，避免调用方往上挂 live 时污染缓存。
   */
  async function collect(day) {
    const nowMs = num(now()) || Date.now();
    if (day === dayOf(nowMs)) return collectUncached(day);

    const hit = pastCache.get(day);
    if (hit && nowMs - hit.at < PAST_CACHE_MS) return cloneJson(hit.result);

    const result = await collectUncached(day);
    pastCache.delete(day); // 重新插入，让它排到最新
    pastCache.set(day, { at: nowMs, result: cloneJson(result) });
    while (pastCache.size > PAST_CACHE_MAX) {
      const oldest = pastCache.keys().next().value;
      pastCache.delete(oldest);
    }
    return result;
  }

  /** 快照写好后就不需要缓存了：后面统一走 read()。 */
  function dropPastCache(day) {
    pastCache.delete(day);
  }

  async function compute(day, options = {}) {
    try {
      const target = strictDay(day) ?? dayOf(now());
      const today = dayOf(now());
      let report;
      let openers;

      if (target === today) {
        const nowMs = num(now()) || Date.now();
        if (todayCache && todayCache.day === target && nowMs - todayCache.at < MINUTE) {
          report = cloneJson(todayCache.report);
          openers = cloneJson(todayCache.openers);
        } else {
          const collected = await collect(target);
          report = collected.report;
          openers = collected.openers;
          todayCache = { day: target, at: nowMs, report: cloneJson(report), openers: cloneJson(openers) };
        }
      } else {
        const collected = await collect(target);
        report = collected.report;
        openers = collected.openers;
      }

      // 传了 live 才挂 live；ltmTotals 单独取出来填账本现状，其余字段原样保留。
      if (options && options.live != null) {
        const live = typeof options.live === 'object' && !Array.isArray(options.live)
          ? { ...options.live }
          : {};
        const totals = live.ltmTotals && typeof live.ltmTotals === 'object' ? live.ltmTotals : null;
        delete live.ltmTotals;
        if (totals) {
          report.memory.ltmTotal = finiteOrNull(totals.total);
          report.memory.ltmFaded = finiteOrNull(totals.faded);
          report.memory.ltmOutdated = finiteOrNull(totals.outdated);
        }
        live.openers = openers;
        report.live = live;
      }

      return report;
    } catch (error) {
      logOnce('compute', `[report] 统计失败（${error?.code ?? 'error'}）`);
      const fallback = strictDay(day) ?? dayOf(now());
      return emptyReport(fallback, fallback === dayOf(now()));
    }
  }

  // ── 快照 ───────────────────────────────────────────────────────────────

  function read(day) {
    const target = strictDay(day);
    if (!target) return null;
    const parsed = readJson(path.join(rootDir, 'daily-report', `${target}.json`));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  }

  function snapshotDays() {
    let entries;
    try {
      entries = fs.readdirSync(path.join(rootDir, 'daily-report'), { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
      out.push(entry.name.slice(0, 10));
    }
    return out.sort();
  }

  /** 写一份快照。只写契约里的固定字段——`live` / `openers` 永远不会进快照。 */
  function writeSnapshot(report) {
    const clean = {
      version: 1,
      day: report.day,
      createdAt: report.createdAt,
      partial: report.partial,
      sessions: report.sessions,
      memory: report.memory,
      cost: report.cost,
      service: report.service,
      speechAll: report.speechAll
    };
    try {
      writeFileAtomic(path.join(rootDir, 'daily-report', `${clean.day}.json`), JSON.stringify(clean) + '\n');
      return true;
    } catch (error) {
      logOnce(`snapshot-write:${error?.code ?? 'error'}`, `[report] 快照写入失败（${error?.code ?? 'error'}）`);
      return false;
    }
  }

  function safeGetLive() {
    try {
      const live = getLive();
      return live && typeof live === 'object' ? live : {};
    } catch {
      return {};
    }
  }

  async function snapshotDue() {
    const written = [];
    try {
      const today = dayOf(now());
      const yesterday = shiftDay(today, -1);

      if (!read(yesterday)) {
        const { report } = await collect(yesterday);
        const live = safeGetLive();
        const totals = live && live.ltmTotals && typeof live.ltmTotals === 'object' ? live.ltmTotals : null;
        if (totals) {
          report.memory.ltmTotal = finiteOrNull(totals.total);
          report.memory.ltmFaded = finiteOrNull(totals.faded);
          report.memory.ltmOutdated = finiteOrNull(totals.outdated);
        }
        if (writeSnapshot(report)) {
          written.push(yesterday);
          dropPastCache(yesterday);
        }
      }

      // 最近 14 天里没有快照、但那天确实有数据的日子：补算一份 partial 的。
      for (let offset = 14; offset >= 2; offset--) {
        const day = shiftDay(today, -offset);
        if (read(day)) continue;
        const { report, hasData } = await collect(day);
        if (!hasData) continue;
        if (writeSnapshot(report)) {
          written.push(day);
          dropPastCache(day);
        }
      }
    } catch (error) {
      logOnce('snapshot-due', `[report] 补写快照失败（${error?.code ?? 'error'}）`);
    }
    return written.sort();
  }

  // ── 折线 ───────────────────────────────────────────────────────────────

  function sessionsSum(report) {
    let inCount = 0;
    let outCount = 0;
    for (const session of Object.values(report?.sessions ?? {})) {
      inCount += num(session?.in);
      outCount += num(session?.out);
    }
    return { in: inCount, out: outCount };
  }

  async function series(n = 14) {
    try {
      let count = Number(n);
      if (!Number.isFinite(count)) count = 14;
      count = Math.max(1, Math.min(60, Math.floor(count)));
      const today = dayOf(now());
      const days = [];
      for (let i = count - 1; i >= 0; i--) days.push(shiftDay(today, -i));

      const speech = [];
      const totals = [];
      for (const day of days) {
        let report = null;
        if (day === today) {
          report = await compute(day);
        } else {
          report = read(day);
          if (!report) {
            const collected = await collect(day);
            report = collected.hasData ? collected.report : null;
          }
        }
        if (!report) {
          speech.push(null);
          totals.push(null);
          continue;
        }
        speech.push(report.speechAll ?? null);
        const sum = sessionsSum(report);
        totals.push({ in: sum.in, out: sum.out, cost: num(report.cost?.total) });
      }

      const c = ensureCounters();
      const events = Object.entries(c.days)
        .filter(([, value]) => num(value?.injectOn) > 0)
        .map(([day]) => ({ day, kind: 'injectOn', label: '人格开注入' }))
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

      return { days, speechAll: speech, totals, events };
    } catch (error) {
      logOnce('series', `[report] 折线统计失败（${error?.code ?? 'error'}）`);
      return { days: [], speechAll: [], totals: [], events: [] };
    }
  }

  // ── 计数与心跳 ─────────────────────────────────────────────────────────

  function count(name, n = 1) {
    try {
      if (!counterNames.has(name)) return;
      const day = dayOf(now());
      const c = ensureCounters();
      let entry = c.days[day];
      if (!entry || typeof entry !== 'object') {
        entry = { error: 0, ownLifeDay: 0, ownLifeMidnight: 0, injectOn: 0 };
        c.days[day] = entry;
      }
      entry[name] = num(entry[name]) + (Number.isFinite(Number(n)) ? Number(n) : 0);
      countersDirty = true;
      todayCache = null; // 今天的数字变了，缓存作废
    } catch (error) {
      logOnce(`count:${error?.code ?? 'error'}`, `[report] 计数失败（${error?.code ?? 'error'}）`);
    }
  }

  function heartbeat() {
    try {
      const nowMs = num(now()) || Date.now();
      const minute = Math.floor(nowMs / MINUTE) * MINUTE;
      const day = dayOf(minute);
      const c = ensureCounters();
      let list = c.heartbeats[day];
      if (!Array.isArray(list)) {
        list = [];
        c.heartbeats[day] = list;
      }

      const last = list.length ? list[list.length - 1] : null;
      if (Array.isArray(last)) {
        // 同一分钟重复调用：什么都不做（不标脏、不写盘）。
        if (Number(last[1]) === minute) return;
        if (Number(last[1]) === minute - MINUTE) {
          // 紧接上一分钟：把区间往后延，不新增。
          last[1] = minute;
        } else {
          list.push([minute, minute]);
        }
      } else if (last != null) {
        // 理论上不会出现（加载时已统一成区间），保险起见整段重建。
        c.heartbeats[day] = [...normalizeHeartbeatList(list), [minute, minute]];
      } else {
        list.push([minute, minute]);
      }

      countersDirty = true;
      todayCache = null;
      pruneCounters();
      writeCounters();
    } catch (error) {
      logOnce(`heartbeat:${error?.code ?? 'error'}`, `[report] 心跳失败（${error?.code ?? 'error'}）`);
    }
  }

  function flush() {
    try {
      ensureCounters();
      pruneCounters();
      writeCounters();
    } catch (error) {
      logOnce(`flush:${error?.code ?? 'error'}`, `[report] 计数写盘失败（${error?.code ?? 'error'}）`);
    }
  }

  return {
    compute,
    snapshotDue,
    read,
    days: snapshotDays,
    series,
    count,
    heartbeat,
    flush
  };
}
