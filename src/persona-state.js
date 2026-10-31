// persona-state.js · 人格与情绪：三层状态的纯函数（PERSONA_PATCH）
//
// 设计见 docs/design/PERSONA_MIND_PLAN.md §5.2：
//   核心性格 core：大五（O/C/E/A/N，0～100），factory 出厂值 / value 当前值 / locked，外加自我信念；
//   对每个人 person：亲密 / 信任 / 熟悉（0～100）、相处偏移、信念、称呼、梗；
//   情绪 emotion：core（她自己的心情，全局）+ scenes（每个会话的残留）+ labels（活跃情绪标签）。
// 这里只放纯计算：不读写文件、不调网络，方便单测。存储在 persona-store.js，胶水在 persona.js。

export const TRAITS = Object.freeze(['O', 'C', 'E', 'A', 'N']);
export const TRAIT_NAMES = Object.freeze({ O: '开放', C: '尽责', E: '外向', A: '宜人', N: '神经质' });
// PERSONA_PATCH（v2 §1.1 B2）：大五是先天气质，这 6 项是后天性格，同样 0～100、每晚漂移。
// 顺序即渲染顺序（相处习惯按这个顺序做并列时的次序）。
export const CHAR_TRAITS = Object.freeze(['grudge', 'clingy', 'guarded', 'playful', 'pride', 'empathy']);
export const CHAR_NAMES = Object.freeze({ grudge: '记仇', clingy: '黏人', guarded: '嘴硬', playful: '爱玩梗', pride: '自尊', empathy: '共情' });
export const ALL_TRAITS = Object.freeze([...TRAITS, ...CHAR_TRAITS]);

// PERSONA_PATCH（v2 §1.1 B1）：每一档「这一项在她身上怎么表现」。出厂时 manifests 里没有对应档就用它；
// 中档没有一般表现（只说「X中等」），免得每个特质都多一句正确的废话。
export const TRAIT_PHRASES = Object.freeze({
  O: Object.freeze({ 高: '对新鲜东西好奇，爱聊没聊过的话题', 低: '偏爱熟悉的话题，对新花样兴趣不大' }),
  C: Object.freeze({ 高: '答应的事会做到，正事上认真靠谱', 低: '随性，不爱计划，正事以外比较散漫' }),
  E: Object.freeze({ 高: '话多，爱主动搭话、凑热闹', 低: '话少，不太主动开口，更爱在旁边看' }),
  A: Object.freeze({ 高: '好说话，容易顺着别人，不爱和人顶', 低: '不会顺着别人说，被怼会顶回去' }),
  N: Object.freeze({ 高: '情绪起伏大，一句话就能影响心情', 低: '情绪稳，不容易被一句话带跑' }),
  grudge: Object.freeze({ 高: '不高兴会记一阵，道歉也不会马上消气', 低: '不记仇，过去就过去了' }),
  clingy: Object.freeze({ 高: '很在意别人回不回她，久等不回会委屈、会想人', 低: '不黏人，别人不回也无所谓' }),
  guarded: Object.freeze({ 高: '心软但嘴上不承认，被哄了也装作没事，不轻易示弱', 低: '心里怎么想就怎么说，开心难过都直接表现' }),
  playful: Object.freeze({ 高: '爱接梗、爱互损，被开玩笑不往心里去', 低: '不太接梗，被损容易当真' }),
  pride: Object.freeze({ 高: '对自己有底气，被骂不太往心里去，被夸觉得理所当然', 低: '容易自我怀疑，被夸会很开心，被骂难受很久' }),
  empathy: Object.freeze({ 高: '别人难过时自己也跟着难受，会先安慰', 低: '别人倾诉时比较冷静，不太被带情绪' })
});
export const LABELS = Object.freeze(['开心', '得意', '感动', '害羞', '想念', '生气', '难过', '委屈', '焦虑', '无聊', '害怕']);
export const NEGATIVE_LABELS = new Set(['生气', '难过', '委屈', '焦虑', '无聊', '害怕']);
export const KINDS = Object.freeze(['insult', 'tease', 'praise', 'care', 'vent', 'ask_help', 'ignore', 'apology', 'share', 'normal']);

// 判读结果的「性质 → 基础冲量」。模型只给「发生了什么」，变多少由这里和性格调制决定
// （Emotion Engine 的原则：模型判断，代码记住）。pad 是方向与相对大小，最后乘 stepClamp × 强度。
export const KIND_EFFECTS = Object.freeze({
  insult: { pad: { p: -1, a: 0.6, d: -0.4 }, label: '生气' },
  tease: { pad: { p: 0.2, a: 0.3, d: 0 }, label: '' },
  praise: { pad: { p: 1, a: 0.3, d: 0.3 }, label: '得意' },
  care: { pad: { p: 0.8, a: 0, d: 0 }, label: '感动' },
  vent: { pad: { p: -0.3, a: 0.1, d: 0 }, label: '' },
  ask_help: { pad: { p: 0.1, a: 0.2, d: 0.2 }, label: '' },
  ignore: { pad: { p: -0.6, a: -0.2, d: -0.3 }, label: '委屈' },
  apology: { pad: { p: 0.3, a: -0.1, d: 0.1 }, label: '' },
  share: { pad: { p: 0.4, a: 0.2, d: 0 }, label: '开心' },
  normal: { pad: { p: 0, a: 0, d: 0 }, label: '' }
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  inject: true,
  appraisal: {
    mode: 'model', // model / rules / off
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash', // 任务 0 用 /models 核对后再定
    timeoutMs: 20000, // PERSONA_PATCH：2026-10-29 任务 0 实测 deepseek-flash 判读用时 2.2～5.7 秒，5 秒超时约 11% 失败（目标 < 5%）
    dailyLimit: 400,
    groupBatch: { messages: 20, minutes: 5 },
    contextMessages: 6
  },
  emotion: {
    coreHalfLifeMin: 360,
    sceneHalfLifeMin: 45,
    labelHalfLifeMin: 45,
    stepClamp: 0.12,
    coreWeight: 0.4,
    coreShare: 0.4,
    coreHourlyBudget: 0.5,
    labelCap: 0.6,
    labelCapStrong: 0.8
  },
  growth: {
    nightlyAt: '03:30',
    dailyStep: 1,
    maxDrift: 15,
    personOffsetMax: 10,
    beliefMinEvidence: 3,
    beliefMinDays: 2,
    selfBeliefMinPeople: 2,
    beliefHalfLifeDays: 45,
    selfBeliefCap: 10,
    personBeliefCap: 8,
    weeklyReport: true,
    reportToDiary: true
  },
  express: { toOwnerPerDay: 2, quiet: [0, 8], expectMinutes: { private: 30, group: 10 } }
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 两层深合并默认设置（用户只写想改的键）。 */
export function mergeSettings(raw = {}) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(isPlainObject(raw) ? raw : {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      for (const [k2, v2] of Object.entries(v)) {
        if (isPlainObject(v2) && isPlainObject(out[k][k2])) out[k][k2] = { ...out[k][k2], ...v2 };
        else out[k][k2] = v2;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : a));

// PERSONA_PATCH（v2 §3 B1）：表现分档。用它挑 manifests / 一般表现文字；
// 显示用的「很高 / 偏高 / 中等」仍是 LEVEL，两者分界不同（band 只有三档）。
export const band = (v) => {
  const n = Number(v);
  const x = Number.isFinite(n) ? n : 50;
  return x >= 60 ? '高' : x <= 40 ? '低' : '中';
};

/** 经过 dtMs 后按半衰期剩下的比例。 */
export function halfLifeFactor(dtMs, halfLifeMin) {
  if (!(dtMs > 0) || !(halfLifeMin > 0)) return 1;
  return Math.pow(0.5, dtMs / (halfLifeMin * 60000));
}

export function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function inQuiet(ms, settings) {
  const [from, to] = settings.express.quiet;
  const h = new Date(ms).getHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

// ── 核心性格 ───────────────────────────────────────────────────────────────

// PERSONA_PATCH（v2 §1.1）：core 升到 version 2，多了 character（后天性格）/ manifests（每项的具体表现）/ prefs（好恶）。
// 出厂值 0～100，当前值先等于出厂值；漂移规则和 limit 在 persona-growth.js。
export function newCore(factory = {}, character = {}) {
  const traits = {};
  for (const t of TRAITS) {
    const f = clamp(Number(factory[t] ?? 50), 0, 100);
    traits[t] = { factory: f, value: f, locked: false };
  }
  const chars = {};
  for (const k of CHAR_TRAITS) {
    const f = clamp(Number(character[k] ?? 50), 0, 100);
    chars[k] = { factory: f, value: f, locked: false };
  }
  return { version: 2, traits, character: chars, manifests: {}, prefs: [], beliefs: [], confirmedAt: null };
}

const numOr = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

/**
 * PERSONA_PATCH（v2 §1.1）：v1 core → v2，幂等。老的 state/persona/<角色>/core.json 读进来先过一遍这里。
 * null 原样返回 null（还没初始化出厂性格）。
 */
export function upgradeCore(core) {
  if (!core || typeof core !== 'object') return null;
  const needChar = () => {
    for (const k of CHAR_TRAITS) {
      const c = core.character?.[k];
      if (!isPlainObject(c) || !Number.isFinite(Number(c.factory)) || !Number.isFinite(Number(c.value))) return true;
    }
    return false;
  };
  if (core.version === 2 && !needChar() && isPlainObject(core.manifests) && Array.isArray(core.prefs)) return core;
  const character = {};
  for (const k of CHAR_TRAITS) {
    const c = isPlainObject(core.character?.[k]) ? core.character[k] : {};
    const f = clamp(numOr(c.factory, 50), 0, 100);
    character[k] = { factory: f, value: clamp(numOr(c.value, f), 0, 100), locked: !!c.locked };
  }
  return {
    ...core,
    version: 2,
    character,
    manifests: isPlainObject(core.manifests) ? { ...core.manifests } : {},
    prefs: Array.isArray(core.prefs) ? core.prefs.map((p) => (isPlainObject(p) ? { ...p } : p)) : []
  };
}

/** PERSONA_PATCH（v2 §2）：扁平对象，同时含大五与后天性格，缺省按 50 算。 */
export function traitValues(core) {
  const out = {};
  for (const t of ALL_TRAITS) {
    const src = TRAITS.includes(t) ? core?.traits?.[t] : core?.character?.[t];
    out[t] = numOr(src?.value, 50);
  }
  return out;
}

const norm = (values, t) => (clamp(Number(values?.[t] ?? 50), 0, 100) - 50) / 50; // → −1..1

/**
 * 性格 → 心情基线（PAD）。Mehrabian (1996) 的大五 → PAD 线性映射（ALMA 模型采用），
 * 原文用「情绪稳定性」S，这里 S = −N。整体乘 0.5，基线不会把心情钉死在极端。
 */
export function padBaseline(values) {
  const O = norm(values, 'O'), C = norm(values, 'C'), E = norm(values, 'E'), A = norm(values, 'A'), S = -norm(values, 'N');
  const k = 0.5;
  return {
    p: clamp(k * (0.21 * E + 0.59 * A + 0.19 * S), -1, 1),
    a: clamp(k * (0.15 * O + 0.30 * A - 0.57 * S), -1, 1),
    d: clamp(k * (0.25 * O + 0.17 * C + 0.60 * E - 0.32 * A), -1, 1)
  };
}

/**
 * 性格怎么调制情绪动力学——养成能被感觉到的地方（§5.2）。
 * PERSONA_PATCH（v2 §2.1 B2）：原来由大五硬算的几项改由后天性格决定，并新增 5 个系数；
 * 11 项全 50 时新系数都等于 1（soothe 0.5、expressThreshold −0.15），与 v1 结果一致。
 */
export function modulation(values) {
  return {
    negGain: 1 + 0.5 * norm(values, 'N'), // 神经质高：负面变化放大
    negHalfLifeMul: 1 + 0.6 * norm(values, 'grudge'), // 记仇高：负面标签退得慢（原来挂在神经质上）
    soothe: 0.5 - 0.4 * norm(values, 'guarded'), // 嘴硬高：道歉、安抚削得少（原来挂在宜人上）
    missGain: 1 + 0.5 * norm(values, 'clingy'), // 黏人高：被冷落、想念涨得快（原来挂在外向上）
    noveltyGain: 1 + 0.5 * norm(values, 'O'), // 开放高：分享新鲜事更开心
    teaseNegMul: 1 - 0.5 * norm(values, 'playful'), // 爱玩梗高：被玩笑损时不那么难受
    insultGain: 1 - 0.4 * norm(values, 'pride'), // 自尊高：被骂、被晾不那么往心里去
    praiseGain: 1 - 0.3 * norm(values, 'pride'), // 自尊高：被夸的冲量也小
    empathyGain: 1 + 0.6 * norm(values, 'empathy'), // 共情高：别人倾诉时被带得更狠
    expectMul: 1 - 0.4 * norm(values, 'clingy'), // 黏人高：更早就觉得被晾着（persona.js 的 tick）
    expressThreshold: -0.15 - 0.15 * norm(values, 'guarded') // 嘴硬高：更低落才肯表达小情绪
  };
}

// ── 情绪 ───────────────────────────────────────────────────────────────────

const hourKey = (ms) => Math.floor(ms / 3600000);

export function newEmotion(now = Date.now()) {
  return { version: 1, core: { p: 0, a: 0, d: 0, at: now }, scenes: {}, labels: [], budget: { hour: hourKey(now), used: 0 }, history: [] };
}

/** 惰性衰减：每份状态带 at，读取或更新前按经过的时间算（桥接停机重启也不会跳变）。 */
export function decayEmotion(em, now, settings, mod = modulation({})) {
  const e = settings.emotion;
  const k = halfLifeFactor(now - em.core.at, e.coreHalfLifeMin);
  em.core = { p: em.core.p * k, a: em.core.a * k, d: em.core.d * k, at: now };
  for (const [key, s] of Object.entries(em.scenes)) {
    const f = halfLifeFactor(now - s.at, e.sceneHalfLifeMin);
    const next = { p: s.p * f, a: s.a * f, d: s.d * f, at: now };
    if (Math.abs(next.p) + Math.abs(next.a) + Math.abs(next.d) < 0.01) delete em.scenes[key];
    else em.scenes[key] = next;
  }
  em.labels = em.labels
    .map((l) => {
      const hl = e.labelHalfLifeMin * (NEGATIVE_LABELS.has(l.name) ? mod.negHalfLifeMul : 1);
      return { ...l, v: l.v * halfLifeFactor(now - l.at, hl), at: now };
    })
    .filter((l) => l.v >= 0.05);
  return em;
}

/**
 * 把一次冲量打进情绪：scene 全额吃，core 只吃 coreShare，并受每小时预算约束（防刷）。
 * delta：{ p, a, d }；label：{ name, v（本次增量）, cause, strong }。
 */
export function applyImpulse(em, { key, delta = {}, label = null }, now, settings, mod = modulation({})) {
  decayEmotion(em, now, settings, mod);
  const e = settings.emotion;
  const step = (x) => clamp(Number(x) || 0, -e.stepClamp, e.stepClamp);
  const d = { p: step(delta.p), a: step(delta.a), d: step(delta.d) };
  const s = em.scenes[key] ?? { p: 0, a: 0, d: 0, at: now };
  em.scenes[key] = { p: clamp(s.p + d.p, -1, 1), a: clamp(s.a + d.a, -1, 1), d: clamp(s.d + d.d, -1, 1), at: now };

  const hk = hourKey(now);
  if (em.budget.hour !== hk) em.budget = { hour: hk, used: 0 };
  const want = (Math.abs(d.p) + Math.abs(d.a) + Math.abs(d.d)) * e.coreShare;
  const allow = Math.max(0, e.coreHourlyBudget - em.budget.used);
  const ratio = want > 0 ? Math.min(1, allow / want) : 0;
  const share = e.coreShare * ratio;
  em.core = { p: clamp(em.core.p + d.p * share, -1, 1), a: clamp(em.core.a + d.a * share, -1, 1), d: clamp(em.core.d + d.d * share, -1, 1), at: now };
  em.budget.used += want * ratio;

  if (label && LABELS.includes(label.name) && label.v > 0) {
    const cap = label.strong ? e.labelCapStrong : e.labelCap;
    const cur = em.labels.find((l) => l.name === label.name && l.key === key);
    if (cur) {
      cur.v = clamp(cur.v + label.v, 0, cap);
      cur.since = now;
      cur.at = now;
      if (label.cause) cur.cause = String(label.cause).slice(0, 20);
    } else {
      em.labels.push({ name: label.name, v: clamp(label.v, 0, cap), key, cause: String(label.cause ?? '').slice(0, 20), since: now, at: now });
    }
    em.labels.sort((x, y) => y.v - x.v);
    em.labels = em.labels.slice(0, 3);
  }

  const last = em.history[em.history.length - 1];
  if (!last || now - last.at >= 300000) em.history.push({ at: now, p: +em.core.p.toFixed(3), a: +em.core.a.toFixed(3), d: +em.core.d.toFixed(3) });
  if (em.history.length > 288) em.history.splice(0, em.history.length - 288);
  return em;
}

/** 道歉 / 安抚：只削这个会话的负面标签，削多少看嘴硬（guarded 高 = 嘴硬，削得少）。 */
export function soothe(em, key, now, settings, mod = modulation({})) {
  decayEmotion(em, now, settings, mod);
  for (const l of em.labels) if (l.key === key && NEGATIVE_LABELS.has(l.name)) l.v = Math.max(0, l.v - 0.25 * mod.soothe);
  em.labels = em.labels.filter((l) => l.v >= 0.05);
  return em;
}

/**
 * 判读 → 冲量。target 不是她时只吃四成。
 * PERSONA_PATCH（v2 §2.1 / §4.3 B2+B3）：新系数按 kind 作用在「负的 p 与负面标签」「正的 p 与标签」「整个冲量」上；
 * 戳中好恶（a.trigger）时强度放大、愉悦方向强制为负 / 正、标签按好恶改写。不传 prefs 时行为与 v1 一致。
 */
export function impulseFromAppraisal(a, mod, settings, prefs = []) {
  const base = KIND_EFFECTS[a.kind] ?? KIND_EFFECTS.normal;
  const hasDir = a.pad && (a.pad.p || a.pad.a || a.pad.d);
  const dir = { ...(hasDir ? a.pad : base.pad) }; // 复制：下面强制方向不能改到判读结果本身
  let intensity = clamp(Number(a.intensity ?? 0.5), 0, 1);
  let name = LABELS.includes(a.emotion?.label) ? a.emotion.label : base.label;
  let prefStrong = false;
  const pref = a.trigger ? prefs.find((p) => p?.id === a.trigger) : null;
  if (pref) {
    const strength = clamp(Number(pref.strength ?? 0.6), 0, 1);
    if (pref.valence === 'dislike') {
      intensity = Math.min(1, intensity * (1 + 0.5 * strength));
      dir.p = -1;
      if (!NEGATIVE_LABELS.has(name)) name = '生气';
      prefStrong = strength >= 0.8; // 雷点：标签强度可以用 labelCapStrong
    } else if (pref.valence === 'like') {
      intensity = Math.min(1, intensity * (1 + 0.4 * strength));
      dir.p = 1;
      if (!name || NEGATIVE_LABELS.has(name)) name = '开心';
    }
  }
  const negMul = (a.kind === 'tease' ? mod.teaseNegMul : 1) * (a.kind === 'insult' || a.kind === 'ignore' ? mod.insultGain : 1);
  const praiseMul = a.kind === 'praise' ? mod.praiseGain : 1;
  const wholeMul = a.kind === 'vent' ? mod.empathyGain : 1; // 共情：整个冲量一起放大
  let k = settings.emotion.stepClamp * intensity * (a.target === 'me' ? 1 : 0.4);
  if (a.kind === 'ignore') k *= mod.missGain;
  if (a.kind === 'share') k *= mod.noveltyGain;
  const delta = { p: dir.p * k, a: dir.a * k, d: dir.d * k };
  if (delta.p < 0) delta.p *= mod.negGain * negMul;
  else if (delta.p > 0) delta.p *= praiseMul;
  delta.p *= wholeMul;
  delta.a *= wholeMul;
  delta.d *= wholeMul;
  let label = null;
  if (name) {
    // 0.6：强度 0.5 的事就能到「一点」以上（用户要求情绪变化明显）；重复几次就到上限 0.6。
    let v = 0.6 * intensity * (a.target === 'me' ? 1 : 0.4);
    if (NEGATIVE_LABELS.has(name)) v *= mod.negGain * negMul;
    else v *= praiseMul;
    v *= wholeMul;
    if (name === '想念' || a.kind === 'ignore') v *= mod.missGain;
    label = { name, v, cause: a.cause ?? '', strong: intensity >= 0.8 || prefStrong };
  }
  return { delta, label };
}

/** 表现值 = 基线 + w·core 偏移 + (1−w)·scene 偏移（w 越大，跨会话串得越多）。 */
export function expressedPad(em, key, values, settings) {
  const base = padBaseline(values);
  const w = settings.emotion.coreWeight;
  const s = em.scenes[key] ?? { p: 0, a: 0, d: 0 };
  return {
    p: clamp(base.p + w * em.core.p + (1 - w) * s.p, -1, 1),
    a: clamp(base.a + w * em.core.a + (1 - w) * s.a, -1, 1),
    d: clamp(base.d + w * em.core.d + (1 - w) * s.d, -1, 1)
  };
}

export function tierWord(v) {
  if (v < 0.2) return '';
  if (v < 0.4) return '一点';
  if (v < 0.6) return '有点';
  return '很';
}

export function moodWord(p) {
  if (p >= 0.3) return '心情不错';
  if (p >= 0.1) return '心情还行';
  if (p > -0.1) return '心情平平';
  if (p > -0.3) return '心情偏低';
  return '心情很差';
}

// 时间写成粗档：精确到分钟的话，快照文字每分钟都变，DSH 就会每步追加一份新快照。
export function agoBucket(ms) {
  if (ms < 10 * 60000) return '刚刚';
  if (ms < 30 * 60000) return '半小时内';
  if (ms < 60 * 60000) return '一小时内';
  return '几小时前';
}

/** 「你此刻」一行。别的会话的标签只按 coreWeight 串过来，且不带原因（防止跨会话泄露）。 */
export function renderNow(em, key, values, settings, now) {
  const e = decayEmotion(structuredClone(em), now, settings, modulation(values));
  const w = settings.emotion.coreWeight;
  const shown = e.labels
    .map((l) => ({ ...l, shown: l.key === key ? l.v : l.v * w }))
    .filter((l) => tierWord(l.shown))
    .sort((x, y) => y.shown - x.shown)
    .slice(0, 2)
    .map((l) => `${tierWord(l.shown)}${l.name}${l.key === key && l.cause ? `（${l.cause}，${agoBucket(now - l.since)}）` : ''}`);
  const pad = expressedPad(e, key, values, settings);
  let mood = `整体${moodWord(pad.p)}`;
  if (pad.a <= -0.3) mood += '，没什么精神';
  else if (pad.a >= 0.35) mood += '，有点来劲';
  return `【你此刻】${shown.length ? `${shown.join('；')}；` : ''}${mood}`;
}

// ── 对每个人 ───────────────────────────────────────────────────────────────

export const STAGE_COEF = Object.freeze({ 陌生: 0.3, 认识: 0.6, 熟人: 0.8, 朋友: 1, 亲近: 1.2 });
export const CLOSE_STAGES = new Set(['熟人', '朋友', '亲近']);

export function newPerson(now = Date.now()) {
  return { name: '', intimacy: 10, trust: 30, familiarity: 0, offsets: { O: 0, C: 0, E: 0, A: 0, N: 0 }, beliefs: [], nickname: '', jokes: [], trustDay: { day: '', gain: 0, loss: 0 }, lastSeenAt: 0, createdAt: now };
}

export function stageOf(p) {
  if (!p || (p.familiarity ?? 0) < 10) return '陌生';
  const i = p.intimacy ?? 0;
  if (i < 25) return '认识';
  if (i < 45) return '熟人';
  if (i < 70) return '朋友';
  return '亲近';
}

const INTIMACY_BY_KIND = Object.freeze({ praise: 1, care: 1.5, share: 1, vent: 1.5, ask_help: 0.5, apology: 0.5, tease: 0.3, normal: 0.2, ignore: -0.5, insult: -3 });

/** 一次判读对关系的影响。信任按事件结算、每天封顶；玩笑损（tease）不扣信任。 */
export function applyRelation(p, a, now) {
  const day = dayOf(now);
  const gap = p.lastSeenAt ? now - p.lastSeenAt : 0;
  p.familiarity = clamp(p.familiarity + 0.5 * (1 - p.familiarity / 100), 0, 100);
  if (p.trustDay.day !== day) p.trustDay = { day, gain: 0, loss: 0 };
  let trust = 0;
  if (gap >= 20 * 3600000) trust += 2; // 隔天又回来
  if (a.target === 'me' && (a.kind === 'vent' || a.kind === 'share')) trust += 1;
  if (a.target === 'me' && a.kind === 'insult') trust -= 6;
  // LIFE_LOOP_PATCH（规格 §7.1）：约定兑现 / 爽约只走规则来源，用 a.trustDelta 表达信任变化
  // （模型判读即使带了这个字段也忽略——影子期内不能改判读管线）。放在每日封顶之前，仍受 +4 / −12 约束。
  if (a.source === 'rules' && Number.isFinite(Number(a.trustDelta))) trust += clamp(Number(a.trustDelta), -6, 4);
  if (trust > 0) {
    const g = Math.min(trust, 4 - p.trustDay.gain);
    if (g > 0) { p.trust = clamp(p.trust + g, 0, 100); p.trustDay.gain += g; }
  } else if (trust < 0) {
    const l = Math.min(-trust, 12 - p.trustDay.loss);
    if (l > 0) { p.trust = clamp(p.trust - l, 0, 100); p.trustDay.loss += l; }
  }
  if (a.target === 'me' || a.kind === 'normal') {
    const base = INTIMACY_BY_KIND[a.kind] ?? 0;
    const nudge = 0.5 * Math.sign(Number(a.relation?.intimacy) || 0);
    p.intimacy = clamp(p.intimacy + base * (0.5 + clamp(Number(a.intensity ?? 0.5), 0, 1)) + nudge, 0, 100);
  }
  p.lastSeenAt = now;
  return p;
}

const LEVEL = (v) => (v >= 75 ? '很高' : v >= 60 ? '偏高' : v > 40 ? '中等' : v > 25 ? '偏低' : '很低');

// 这一项当前该用的表现文字：manifest 的档与当前档一致才用，否则退回一般表现（中档没有一般表现）。
// 同时说明来源（manifest / generic / 无），控制台和测试靠它区分「她自己写的」和「通用模板」。
function phraseOf(core, key, v) {
  const m = core?.manifests?.[key];
  const b = band(v);
  if (isPlainObject(m) && m.band === b && typeof m.text === 'string' && m.text) return { text: m.text, source: 'manifest' };
  const generic = TRAIT_PHRASES[key]?.[b];
  return generic ? { text: generic, source: 'generic' } : { text: '', source: '' };
}

/**
 * PERSONA_PATCH（v2 §3 末尾）：性格卡片的统一数据源（控制台表格、渲染都读它，避免两套逻辑）。
 * 顺序：大五（TRAITS）→ 后天性格（CHAR_TRAITS）。phrase / phraseSource 与渲染用的完全一致。
 */
export function traitView(core) {
  const vals = traitValues(core);
  return ALL_TRAITS.map((key) => {
    const group = TRAITS.includes(key) ? 'big5' : 'char';
    const src = group === 'big5' ? core?.traits?.[key] : core?.character?.[key];
    const p = phraseOf(core, key, vals[key]);
    return {
      key,
      name: group === 'big5' ? TRAIT_NAMES[key] : CHAR_NAMES[key],
      group,
      factory: numOr(src?.factory, 50),
      value: vals[key],
      locked: !!src?.locked,
      level: LEVEL(vals[key]),
      band: band(vals[key]),
      phrase: p.text,
      phraseSource: p.source
    };
  });
}

/**
 * PERSONA_PATCH（v2 §3 B1）：行为锚定渲染。分档写、不写数值、不写 hits 等计数——
 * 保证一天之内文字不变，DSH 的 system prompt 前缀缓存就不会每步失效。
 * 大五 5 项都列（中档只写「X中等」），相处习惯只列非中档的，好恶各取强度前 3。
 * 数据全部来自 traitView，这里只负责拼文字。
 */
export function renderCore(core) {
  const view = traitView(core);
  const line = (t) => `- ${t.name}${t.level}${t.phrase ? `：${t.phrase}` : ''}`;
  const lines = [`【你现在的性格】（会随经历慢慢变化；按它自然表现，不要说出来）`];
  for (const t of view.filter((x) => x.group === 'big5')) lines.push(line(t));
  const habits = view
    .filter((x) => x.group === 'char' && x.band !== '中')
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Math.abs(b.t.value - 50) - Math.abs(a.t.value - 50) || a.i - b.i);
  if (habits.length) {
    lines.push('相处习惯：');
    for (const { t } of habits) lines.push(line(t));
  }
  const byStrength = (list) => [...list].sort((x, y) => (Number(y?.strength ?? 0) || 0) - (Number(x?.strength ?? 0) || 0)).slice(0, 3);
  const prefs = Array.isArray(core?.prefs) ? core.prefs.filter((p) => p && typeof p.text === 'string' && p.text) : [];
  const likes = byStrength(prefs.filter((p) => p.valence === 'like'));
  const dislikes = byStrength(prefs.filter((p) => p.valence === 'dislike'));
  if (likes.length) lines.push(`你喜欢：${likes.map((p) => p.text).join('、')}`);
  if (dislikes.length) lines.push(`你讨厌：${dislikes.map((p) => (Number(p.strength ?? 0) >= 0.8 ? `${p.text}（雷点）` : p.text)).join('、')}`);
  const beliefs = (core.beliefs || []).filter((b) => b.status === 'accepted').slice(0, 10).map((b) => `- ${b.text}`);
  if (beliefs.length) lines.push(`你对自己的看法：\n${beliefs.join('\n')}`);
  return lines.join('\n');
}

// PERSONA_PATCH（v2 §4.1 B3）：好恶校验。不合格的条目直接丢掉（宁可少一条，也不让半截数据进提示词）。
const BAD_KEYWORD_RE = /^[\p{P}\p{S}\s]+$/u;
// 模型常把「喜欢雨天」整句写进来，渲染就成了「你喜欢：喜欢雨天」——去掉开头这种前缀。
// 长的先匹配（最讨厌 / 很讨厌 / 不喜欢 在前），「喜欢」本身作为整条 text 时保留。
const PREF_PREFIX_RE = /^(最讨厌|很讨厌|不喜欢|讨厌|最恨|喜欢)/;
function stripPrefPrefix(text) {
  const m = text.match(PREF_PREFIX_RE);
  if (!m) return text;
  const rest = text.slice(m[0].length).trim();
  return rest || text;
}

export function normalizePrefs(list) {
  const out = [];
  const used = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!isPlainObject(item)) continue;
    const text = stripPrefPrefix(String(item.text ?? '').trim());
    if (!text || text.length > 16) continue;
    if (item.valence !== 'like' && item.valence !== 'dislike') continue;
    const strength = Number.isFinite(Number(item.strength)) && item.strength !== null && item.strength !== '' ? clamp(Number(item.strength), 0.3, 1) : 0.6;
    // 单字关键词（书 / 矮 / 雨）误伤太厉害：「这本书真好看」会被判成戳雷点，所以至少 2 个字。
    const keywords = (Array.isArray(item.keywords) ? item.keywords : [])
      .map((k) => String(k ?? '').trim())
      .filter((k) => k.length >= 2 && k.length <= 8 && !BAD_KEYWORD_RE.test(k))
      .slice(0, 3);
    const id = typeof item.id === 'string' && /^p\d+$/.test(item.id) && !used.has(item.id) ? item.id : null;
    if (id) used.add(id);
    out.push({
      id,
      text,
      valence: item.valence,
      strength,
      keywords,
      hits: Number.isFinite(Number(item.hits)) && item.hits !== null ? Number(item.hits) : 0,
      lastHitAt: Number.isFinite(Number(item.lastHitAt)) && item.lastHitAt !== null ? Number(item.lastHitAt) : 0
    });
    if (out.length >= 12) break;
  }
  // 第二遍才分配自动 id：先把输入里合法的 id 全占住，避免自动编号与后面的显式 id 撞车。
  let n = 1;
  for (const p of out) {
    if (p.id) continue;
    while (used.has(`p${n}`)) n += 1;
    p.id = `p${n}`;
    used.add(p.id);
  }
  return out;
}

/** 「你和他」一行。来自私聊的信念只在那个私聊里出现（§5.11）。 */
export function renderRelation(p, name, { key = '' } = {}) {
  const bits = [stageOf(p), p.trust >= 70 ? '信任高' : p.trust >= 40 ? '信任一般' : '还不太信任'];
  const o = p.offsets || {};
  if ((o.A ?? 0) >= 4) bits.push('你对他更软一点');
  else if ((o.A ?? 0) <= -4) bits.push('你对他嘴更毒');
  if ((o.E ?? 0) >= 4) bits.push('跟他话更多');
  else if ((o.E ?? 0) <= -4) bits.push('跟他话少');
  const visible = (b) => b.status === 'accepted' && (b.keys || []).some((k) => k === key || k.startsWith('group:'));
  for (const b of (p.beliefs || []).filter(visible).slice(0, 3)) bits.push(b.text);
  if (p.nickname) bits.push(`你叫他"${p.nickname}"`);
  if (Array.isArray(p.jokes) && p.jokes.length) bits.push(`你们的梗：${p.jokes.slice(0, 2).join('、')}`);
  return `【你和${name}】${bits.join('；')}`;
}
