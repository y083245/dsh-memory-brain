// memory-decay.js · 记忆代谢的遗忘曲线（子项目 2，DECAY_PATCH）
//
// 干什么：给每条记忆单元（账本条目、主人私聊里的显著消息、日记）算「牢固度 S / 难度 D / 可提取度 R」。
//         没人提就按 FSRS-5 曲线往下淡；被想起一次（good = 顺利、hard = 费劲）就回到 R = 1、并把 S 拉长。
//         淡过冻结线（默认 R < 0.5）算「冻结」：不再自己冒出来、不再注入 —— 但原话永远不删，查到一次就解冻。
//
// 为什么需要它：生活回路原来的「陈旧度」只是线性计数，记不住「快忘了的时候被想起才记得最牢」这件事。
//              公式与参数见 docs/design/MEMORY_DECAY_SPEC.md §2～§4（FSRS-5 默认参数，数据少不训练）。
//
// 设计约束（规格 §3、§5、§6）：
// - 只依赖 node 内置模块，不 import 项目里的任何文件：桥接、生活回路、测试都能单独加载；
// - 单元用 ID 记账（ltm:<条目id> / msg:<msgId，空时 msg:<t> / diary:<t>），meta 里没有任何原文，
//   状态文件里也只有 ID 和数字；
// - 没有复习记录的单元**不写盘**：R 由起点参数（meta）现算，第一次被想起才落一条记录；
// - 所有公开方法自己 try/catch，出错只 log、返回 null / false，绝不把异常抛回桥接；
// - 状态文件原子写（临时文件 + rename）、600，坏了当空状态，不拦住启动。
//
// 用法（bridge.js，第二批接线）：
//   import { createMemoryDecay } from './memory-decay.js';
//   const decay = createMemoryDecay({ statePath, options: cfg.decay, log });
//   decay.state('ltm:ab12', decay.ltmMeta(item, { ownerQQ, userId, intimacy }));

import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const HOUR = 3600 * 1000;

// FSRS-5 默认参数（规格 §4）。F 取 19/81：t = S 时恰好 R = 0.9。
const F = 19 / 81;
const W6 = 1.4604;
const W7 = 0.0046;
const W8 = 1.54575;
const W9 = 0.1192;
const W10 = 1.01925;
const W15 = 0.2315;
// 难度均值回归的目标值（评分「顺利」= 4 时的 D0），规格 §4 的常量。
const D0_EASY = 7.1949 - Math.exp(0.5345 * 3) + 1; // ≈ 3.2245
const S_MIN = 0.5;
const S_MAX = 3650;

const DEFAULT_FREEZE_BELOW = 0.5;
const DEFAULT_COOLDOWN_MS = HOUR;
const ID_PREFIXES = ['ltm:', 'msg:', 'diary:'];

const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : a));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** 单元 ID：字符串、1～200 字、三种前缀之一（与生活回路 candId 同一套键）。 */
export function isValidUnitId(id) {
  if (typeof id !== 'string') return false;
  if (id.length < 1 || id.length > 200) return false;
  return ID_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * 可提取度 R：距上次复习（或创建）t 天的保留概率。
 * S 单位是天；t = S 时 R = 0.9。参数不合法按最保守的边界处理，不抛异常。
 */
export function retrievability(days, S) {
  const t = Number.isFinite(days) && days > 0 ? days : 0;
  const s = Number.isFinite(S) && S >= S_MIN ? S : S_MIN;
  return (1 + (F * t) / s) ** -0.5;
}

/**
 * 想起一次之后的牢固度（规格 §4）：
 * S' = S · (1 + e^w8 · (11 − D) · S^(−w9) · (e^(w10 · (1 − R)) − 1) · (费劲 ? w15 : 1))，夹到 [0.5, 3650]。
 * R = 1 时不增长（刚复习完又想起，没有额外收获）。
 */
export function nextStability(S, D, R, rating) {
  const s = Number.isFinite(S) && S > 0 ? S : S_MIN;
  const d = Number.isFinite(D) ? clamp(D, 1, 10) : 5.5;
  const r = Number.isFinite(R) ? clamp(R, 0, 1) : 1;
  const gain =
    Math.exp(W8) *
    (11 - d) *
    s ** -W9 *
    (Math.exp(W10 * (1 - r)) - 1) *
    (rating === 'hard' ? W15 : 1);
  return clamp(s * (1 + gain), S_MIN, S_MAX);
}

/**
 * 难度更新（规格 §4）：评分 G = 费劲 2 / 顺利 3。
 * 顺利时 D 基本不动；费劲时 D 变大，以后淡得更快。最后向 D0_EASY 轻微回归，夹到 [1, 10]。
 */
export function nextDifficulty(D, rating) {
  const d = Number.isFinite(D) ? clamp(D, 1, 10) : 5.5;
  const G = rating === 'hard' ? 2 : 3;
  const d1 = d - (W6 * (G - 3) * (10 - d)) / 9;
  const d2 = W7 * D0_EASY + (1 - W7) * d1;
  return clamp(d2, 1, 10);
}

/**
 * 起点牢固度 S0（天，规格 §3）：
 * 账本按类别（约定 / 经历 14、事实 / 性格 7、备注 3，主人的条目 ×1.5）；
 * 消息按判读显著度与情绪强度（3～30 天，没有判读时 ≈ 8.7 天）；日记 7。
 */
export function initialStability(meta) {
  const kind = meta?.kind;
  if (kind === 'ltm') {
    let s = 7;
    if (meta.cat === 'pending' || meta.cat === 'event') s = 14;
    else if (meta.cat === 'fact' || meta.cat === 'trait') s = 7;
    else if (meta.cat === 'note') s = 3;
    return meta.owner === true ? s * 1.5 : s;
  }
  if (kind === 'msg') {
    const salience = Number.isFinite(meta.salience) ? meta.salience : 0.3;
    const intensity = Number.isFinite(meta.intensity) ? meta.intensity : 0;
    return 3 + 27 * clamp(0.7 * salience + 0.3 * intensity, 0, 1);
  }
  return 7;
}

/**
 * 起点难度 D0（规格 §3）：日记 5；账本 / 消息看这个人的亲密度（越亲近越难淡），没有关系数据时 5.5。
 * 亲密度按 0～100 传（persona.relationOf(uid).intimacy）。
 */
export function initialDifficulty(meta) {
  const kind = meta?.kind;
  if (kind === 'diary') return 5;
  if (kind === 'ltm' || kind === 'msg') {
    if (Number.isFinite(meta.intimacy)) return clamp(8 - meta.intimacy / 15, 2, 8);
    return 5.5;
  }
  return 5.5;
}

/** 数值参数归一：null / 空串 / 非数字都给 undefined（调用方据此走默认值）。 */
function optionalNumber(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 账本条目 → meta。**不复制 text 或任何其它字段**：meta 会进状态文件的记账路径，不能带原文。
 * exempt = 核心条目，或还没了结的约定（pending 且 status 缺省 / open）——规格 M4。
 */
export function ltmUnitMeta(item, { ownerQQ, userId, intimacy } = {}) {
  return {
    kind: 'ltm',
    createdAt: Date.parse(item?.at),
    cat: String(item?.cat ?? ''),
    owner: ownerQQ != null && String(userId) === String(ownerQQ),
    exempt: !!item?.core || (item?.cat === 'pending' && (item?.status ?? 'open') === 'open'),
    intimacy: optionalNumber(intimacy),
  };
}

/** 存档行 → meta。salience / intensity 来自人格判读（取最大值），没有就是 undefined（用默认值）。 */
export function msgUnitMeta(row, { salience, intensity, intimacy } = {}) {
  return {
    kind: 'msg',
    createdAt: Date.parse(row?.t),
    exempt: false,
    salience: optionalNumber(salience),
    intensity: optionalNumber(intensity),
    intimacy: optionalNumber(intimacy),
  };
}

/** 日记 → meta。t 是 state/diary/index.jsonl 里的毫秒数。 */
export function diaryUnitMeta(entry) {
  return {
    kind: 'diary',
    createdAt: Number(entry?.t),
    exempt: false,
  };
}

export function createMemoryDecay({ statePath, now = () => Date.now(), log = () => {}, options = {} } = {}) {
  if (!statePath) throw new Error('memory-decay: 缺 statePath');

  const freezeBelow =
    Number.isFinite(options?.freezeBelow) && options.freezeBelow > 0 && options.freezeBelow < 1
      ? options.freezeBelow
      : DEFAULT_FREEZE_BELOW;
  const reviewCooldownMs =
    Number.isFinite(options?.reviewCooldownMs) && options.reviewCooldownMs >= 0
      ? options.reviewCooldownMs
      : DEFAULT_COOLDOWN_MS;

  // 只存 { S, D, last, reps, hard }：没有原文，也没有任何可供推断原文的字段。
  const units = Object.create(null);

  function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, ''));
    } catch {
      return; // 文件不存在 / 坏 JSON：空状态，不拦住启动
    }
    if (!isPlainObject(raw) || !isPlainObject(raw.units)) return;
    for (const [id, rec] of Object.entries(raw.units)) {
      if (!isValidUnitId(id) || !isPlainObject(rec)) continue;
      // 单条记录坏了只丢这一条：其余照常读回。
      if (!Number.isFinite(rec.S) || !Number.isFinite(rec.D) || !Number.isFinite(rec.last)) continue;
      units[id] = {
        S: Number(rec.S),
        D: Number(rec.D),
        last: Number(rec.last),
        reps: count(rec.reps),
        hard: count(rec.hard),
      };
    }
  }
  load();

  const nowMs = () => {
    const t = Number(typeof now === 'function' ? now() : Date.now());
    return Number.isFinite(t) ? t : Date.now();
  };

  /** 原子写 + 600。没有任何复习记录、且文件本来就不存在时，不创建文件（规格 §3）。 */
  function save() {
    try {
      const empty = Object.keys(units).length === 0;
      if (empty && !fs.existsSync(statePath)) return;
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, units })}\n`, { mode: 0o600 });
      fs.renameSync(tmp, statePath);
      return true;
    } catch (e) {
      // 写盘失败只记日志：内存里的更新保留，下次写盘会一起带上。
      log(`[decay] 状态写不进去（忽略）：${e?.message ?? e}`);
      return false;
    }
  }

  function state(unitId, meta) {
    try {
      if (!isValidUnitId(unitId)) return null;
      const rec = units[unitId];
      let S;
      let D;
      let last;
      let reps;
      if (rec) {
        S = rec.S;
        D = rec.D;
        last = rec.last;
        reps = rec.reps;
      } else {
        S = initialStability(meta);
        D = initialDifficulty(meta);
        last = Number.isFinite(meta?.createdAt) ? meta.createdAt : nowMs();
        reps = 0;
      }
      const days = Math.max(0, (nowMs() - last) / DAY);
      const R = retrievability(days, S);
      const exempt = !!meta?.exempt;
      return { S, D, R, frozen: !exempt && R < freezeBelow, exempt, last, reps };
    } catch (e) {
      log(`[decay] 算 ${unitId} 出错（忽略）：${e?.message ?? e}`);
      return null;
    }
  }

  function review(unitId, meta, rating) {
    try {
      if (rating !== 'good' && rating !== 'hard') return false;
      if (!isValidUnitId(unitId)) return false;
      const rec = units[unitId];
      const t = nowMs();
      // 冷却只看已有的复习记录（规格 M2-b）：没记录过的单元第一次想起总是生效。
      if (rec && t - rec.last < reviewCooldownMs) return false;
      const cur = state(unitId, meta);
      if (!cur) return false;
      units[unitId] = {
        S: nextStability(cur.S, cur.D, cur.R, rating),
        D: nextDifficulty(cur.D, rating),
        last: t,
        reps: (count(rec?.reps) || cur.reps || 0) + 1,
        hard: count(rec?.hard) + (rating === 'hard' ? 1 : 0),
      };
      save();
      // 刚复习完：R = 1、不冻结。
      return state(unitId, meta);
    } catch (e) {
      log(`[decay] 复习 ${unitId} 出错（忽略）：${e?.message ?? e}`);
      return false;
    }
  }

  function drop(unitId) {
    try {
      if (!isValidUnitId(unitId)) return false;
      if (!Object.prototype.hasOwnProperty.call(units, unitId)) return false;
      delete units[unitId];
      save();
      return true;
    } catch (e) {
      log(`[decay] 删除 ${unitId} 出错（忽略）：${e?.message ?? e}`);
      return false;
    }
  }

  function snapshot() {
    const byKind = { ltm: 0, msg: 0, diary: 0 };
    try {
      const ids = Object.keys(units);
      for (const id of ids) {
        if (id.startsWith('ltm:')) byKind.ltm++;
        else if (id.startsWith('msg:')) byKind.msg++;
        else if (id.startsWith('diary:')) byKind.diary++;
      }
      return { units: ids.length, byKind, freezeBelow };
    } catch (e) {
      log(`[decay] 统计出错（忽略）：${e?.message ?? e}`);
      return { units: 0, byKind, freezeBelow };
    }
  }

  // meta 构造函数也挂在实例上：生活回路靠依赖注入拿到，不用 import 本文件，测试也不用依赖它。
  return { freezeBelow, ltmMeta: ltmUnitMeta, msgMeta: msgUnitMeta, diaryMeta: diaryUnitMeta, state, review, drop, snapshot };
}
