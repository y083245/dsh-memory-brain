// persona-growth.js · 性格养成：证据 → 信念 → 性格漂移（PERSONA_PATCH）
//
// 设计见 docs/design/PERSONA_MIND_PLAN.md §5.4。全部是纯函数，外加一个只经 store 读写的 runNightly。
// 证据类别是固定枚举（同一类证据用同一句模板，才能攒成同一条信念——persona_mind 的经验）。
import {
  TRAITS, CHAR_TRAITS, CHAR_NAMES, ALL_TRAITS, TRAIT_PHRASES, NEGATIVE_LABELS, STAGE_COEF, clamp, dayOf, band, newCore, stageOf, upgradeCore, normalizePrefs
} from './persona-state.js';

export const EVIDENCE_TYPES = Object.freeze({
  relied_on: { about: 'self', label: '被依赖并接住了', text: '有人难的时候会来找我，我接得住', core: { A: 1, C: 0.5 } },
  praised: { about: 'self', label: '被真心夸', text: '我被认真夸过，我没自己想的那么差', core: { N: -1, E: 0.5 } },
  insulted: { about: 'self', label: '被真骂', text: '有人会冲我说难听的话', core: { N: 1 }, offset: { A: -1 } },
  ignored: { about: 'self', label: '说话没人接', text: '我说的话有时候没人接', core: { E: -1, N: 0.5 } },
  novelty_joy: { about: 'self', label: '聊新鲜事很开心', text: '聊新鲜东西让我开心', core: { O: 1 } },
  task_recognized: { about: 'self', label: '正事做好被认可', text: '正事上我是靠得住的', core: { C: 1 } },
  cared: { about: 'self', label: '被惦记', text: '有人会惦记我', core: { N: -0.5, A: 0.5 } },
  he_vents: { about: 'him', label: '他来倾诉', text: '他难受的时候会来找我', offset: { A: 1 } },
  he_teases: { about: 'him', label: '他爱开玩笑', text: '他爱跟我开玩笑', offset: { E: 1 } },
  he_praises: { about: 'him', label: '他真心夸', text: '他夸我的时候是真心的', offset: { A: 0.5 } },
  he_cold: { about: 'him', label: '他爱搭不理', text: '他有时候爱搭不理', offset: { E: -1 } },
  he_night: { about: 'him', label: '他夜里常在', text: '他常在夜里还醒着' }
});

const DAY = 86400000;
const zero = () => ({ O: 0, C: 0, E: 0, A: 0, N: 0 }); // 周报按大五统计用（漂移已改成通用的 zeroOf）
// 没有具体发言人的自有事件（比如「说话没人接」）按会话当来源，避免全算成同一个人。
const sourceOf = (r) => String(r.userId ?? r.key ?? '');

// PERSONA_PATCH（v2 §2.2 B2）：后天性格的事件表。模型只说「发生了什么」，变多少由这张表决定。
export const CHAR_EVENTS = Object.freeze({
  insult: { grudge: 1, guarded: 0.5, pride: -0.5 }, // 被真骂：更记仇、更防备、自尊受挫
  apology: { grudge: -1 }, // 被道歉：慢慢学会放下
  tease_fun: { playful: 1 }, // 被逗并且觉得好玩
  tease_hurt: { playful: -0.5, guarded: 0.5 }, // 被逗但被戳到了
  praise: { pride: 1 },
  care: { guarded: -0.5, clingy: 0.5 }, // 被惦记：没那么防备、更依恋
  vent: { empathy: 1 }, // 有人向她倾诉
  ignored: { clingy: 0.5, guarded: 0.5 } // 说话没人接
});

/**
 * PERSONA_PATCH（v2 §2.2）：一次判读 → 后天性格事件名；没有就 null。
 * 只在她被直接指向（target=me）时产生；玩笑损按当时的情绪 / 好恶分清「好玩」和「戳到了」。
 */
export function charEventOf(a, prefs = []) {
  if (!a || a.target !== 'me') return null;
  switch (a.kind) {
    case 'insult': return 'insult';
    case 'apology': return 'apology';
    case 'praise': return 'praise';
    case 'care': return 'care';
    case 'vent': return 'vent';
    case 'ignore': return 'ignored';
    case 'tease': {
      const pref = a.trigger ? prefs.find((p) => p?.id === a.trigger) : null;
      const hitDislike = pref?.valence === 'dislike';
      return Number(a.pad?.p) < 0 || NEGATIVE_LABELS.has(a.emotion?.label) || hitDislike ? 'tease_hurt' : 'tease_fun';
    }
    default: return null;
  }
}

/**
 * 用证据更新一组信念（自我信念或对某人的信念）。
 * 采纳门槛：≥ beliefMinEvidence 条、跨 ≥ beliefMinDays 天；关于自己的还要 ≥ selfBeliefMinPeople 个不同来源。
 * 采纳后半衰期 beliefHalfLifeDays，有新证据就刷新；先验信念（prior）不淡化。超出上限时淡化最久没刷新的。
 */
export function updateBeliefs(list, rows, { about, now, settings, cap }) {
  const g = settings.growth;
  const byType = new Map();
  for (const r of rows) {
    if (r.about !== about || !EVIDENCE_TYPES[r.type]) continue;
    const x = byType.get(r.type) ?? { days: new Set(), people: new Set(), keys: new Set(), count: 0, last: 0 };
    x.days.add(r.day);
    x.people.add(sourceOf(r));
    if (r.key) x.keys.add(r.key);
    x.count += 1;
    x.last = Math.max(x.last, Number(r.at) || 0);
    byType.set(r.type, x);
  }
  const out = (list || []).map((b) => ({ ...b, keys: [...(b.keys || [])] }));
  for (const [type, x] of byType) {
    let b = out.find((y) => y.type === type);
    if (!b) {
      b = { type, text: EVIDENCE_TYPES[type].text, status: 'candidate', prior: false, acceptedAt: 0, refreshedAt: 0, keys: [] };
      out.push(b);
    }
    b.keys = [...new Set([...b.keys, ...x.keys])];
    const enough = x.count >= g.beliefMinEvidence && x.days.size >= g.beliefMinDays && (about === 'him' || x.people.size >= g.selfBeliefMinPeople);
    if (b.status === 'accepted') b.refreshedAt = Math.max(b.refreshedAt, x.last);
    else if (enough && !(b.status === 'faded' && x.last <= b.refreshedAt)) {
      b.status = 'accepted';
      b.acceptedAt = now;
      b.refreshedAt = x.last;
    }
  }
  for (const b of out) {
    if (b.prior || b.status !== 'accepted') continue;
    const strength = Math.pow(0.5, (now - b.refreshedAt) / (g.beliefHalfLifeDays * DAY));
    if (strength < 0.2) b.status = 'faded';
  }
  const priors = out.filter((b) => b.prior && b.status === 'accepted').length;
  const accepted = out.filter((b) => !b.prior && b.status === 'accepted').sort((x, y) => y.refreshedAt - x.refreshedAt);
  for (const b of accepted.slice(Math.max(0, cap - priors))) b.status = 'faded';
  return out;
}

const zeroOf = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const magOf = (o, keys) => keys.reduce((s, k) => s + Math.abs(o[k] ?? 0), 0);

/**
 * PERSONA_PATCH（v2 §2.2）：大五与后天性格共用的漂移算法（原来只在 driftCore 里）。
 * 权重 = 来源人信任 × 关系阶段系数，群聊证据减半；同一来源一天对这项性格的贡献不超过当天总变化的一半；
 * 每项每天 ≤ dailyStep，离出厂值 ≤ maxDrift，锁定的不动。effectsOf(row) 返回 { 特质: 增减 } 或空。
 */
function driftTraitGroup(group, keys, todayRows, people, settings, effectsOf) {
  const g = settings.growth;
  const per = new Map();
  for (const r of todayRows) {
    const eff = effectsOf(r);
    if (!eff) continue;
    const p = r.userId ? people[r.userId] : null;
    const w = ((p?.trust ?? 30) / 100) * (STAGE_COEF[stageOf(p)] ?? 0.6) * (String(r.key ?? '').startsWith('group:') ? 0.5 : 1);
    const acc = per.get(sourceOf(r)) ?? zeroOf(keys);
    for (const [t, v] of Object.entries(eff)) if (t in acc) acc[t] += v * w;
    per.set(sourceOf(r), acc);
  }
  const sum = zeroOf(keys);
  for (const acc of per.values()) for (const k of keys) sum[k] += acc[k];
  const all = magOf(sum, keys);
  const total = zeroOf(keys);
  for (const acc of per.values()) {
    const m = magOf(acc, keys);
    const scale = all > 0 && m > all / 2 ? all / 2 / m : 1;
    for (const k of keys) total[k] += acc[k] * scale;
  }
  const next = structuredClone(group);
  const changes = {};
  for (const k of keys) {
    const tr = next[k];
    if (!tr || tr.locked) continue;
    const step = clamp(total[k] * 0.5, -g.dailyStep, g.dailyStep);
    const v = clamp(tr.value + step, Math.max(0, tr.factory - g.maxDrift), Math.min(100, tr.factory + g.maxDrift));
    if (Math.abs(v - tr.value) >= 0.01) {
      changes[k] = +(v - tr.value).toFixed(2);
      tr.value = +v.toFixed(2);
    }
  }
  return { group: next, changes };
}

/**
 * 当天证据推动核心性格。
 * PERSONA_PATCH（v2）：算法抽到 driftTraitGroup，行为与 v1 一致；`about === 'char'` 的派生行不算大五证据
 * （CHAR_EVENTS 里的 `ignored` 与 EVIDENCE_TYPES 同名，不加这一行会被当成本人的「说话没人接」）。
 */
export function driftCore(core, todayRows, people, settings) {
  const r = driftTraitGroup(core.traits, TRAITS, todayRows, people, settings, (row) => (row.about === 'char' ? null : EVIDENCE_TYPES[row.type]?.core));
  const next = structuredClone(core);
  next.traits = r.group;
  return { core: next, changes: r.changes };
}

/** PERSONA_PATCH（v2 §2.2 B2）：同一套算法作用在后天性格上，只读 about === 'char' 的派生证据。 */
export function driftCharacter(core, todayRows, people, settings) {
  const base = upgradeCore(core);
  if (!base) return { core, changes: {} };
  const r = driftTraitGroup(base.character, CHAR_TRAITS, todayRows, people, settings, (row) => (row.about === 'char' ? CHAR_EVENTS[row.type] : null));
  const next = structuredClone(base);
  next.character = r.group;
  return { core: next, changes: r.changes };
}

/** 对每个人的相处偏移：只用这个人的证据，每项每天 ≤ dailyStep，范围 ±personOffsetMax。 */
export function driftOffsets(people, todayRows, settings) {
  const g = settings.growth;
  const next = structuredClone(people);
  const sums = new Map();
  for (const r of todayRows) {
    const spec = EVIDENCE_TYPES[r.type];
    if (!spec?.offset || !r.userId) continue;
    const acc = sums.get(r.userId) ?? zero();
    for (const [t, v] of Object.entries(spec.offset)) acc[t] += v;
    sums.set(r.userId, acc);
  }
  const changes = {};
  for (const [uid, acc] of sums) {
    const p = next[uid];
    if (!p) continue;
    p.offsets ??= zero();
    for (const t of TRAITS) {
      const step = clamp(acc[t] * 0.5, -g.dailyStep, g.dailyStep);
      if (!step) continue;
      const v = clamp((p.offsets[t] ?? 0) + step, -g.personOffsetMax, g.personOffsetMax);
      if (v !== p.offsets[t]) {
        (changes[uid] ??= {})[t] = +(v - (p.offsets[t] ?? 0)).toFixed(2);
        p.offsets[t] = +v.toFixed(2);
      }
    }
  }
  return { people: next, changes };
}

/** 长期不来的人，亲密度慢慢回落：7 天后每天 −0.5。 */
export function decayAbsence(people, now) {
  for (const p of Object.values(people)) {
    if (p.lastSeenAt && now - p.lastSeenAt > 7 * DAY) p.intimacy = clamp((p.intimacy ?? 0) - 0.5, 0, 100);
  }
  return people;
}

export function isoWeek(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/** 周报：最近 7 份快照的变化 + 每项变化附证据（时间、人、消息 ID）。 */
export function weeklyReport({ snapshots, evidence, names = {}, now }) {
  const lines = [`# 她这周的变化（${isoWeek(now)}）`, ''];
  const sum = zero();
  for (const s of snapshots) for (const [t, v] of Object.entries(s.changes?.core ?? {})) sum[t] += v;
  const moved = TRAITS.filter((t) => Math.abs(sum[t]) >= 0.01);
  lines.push('## 性格', moved.length ? moved.map((t) => `- ${t}：${sum[t] > 0 ? '+' : ''}${sum[t].toFixed(2)}`).join('\n') : '- 这周没有变化', '');
  // PERSONA_PATCH（v2 §2.2）：后天性格单独一段，用中文名写。
  const csum = zeroOf(CHAR_TRAITS);
  for (const s of snapshots) for (const [t, v] of Object.entries(s.changes?.character ?? {})) if (t in csum) csum[t] += v;
  const cmoved = CHAR_TRAITS.filter((t) => Math.abs(csum[t]) >= 0.01);
  lines.push('## 相处习惯', cmoved.length ? cmoved.map((t) => `- ${CHAR_NAMES[t]}：${csum[t] > 0 ? '+' : ''}${csum[t].toFixed(2)}`).join('\n') : '- 这周没有变化', '');
  const last = snapshots[snapshots.length - 1];
  const accepted = (last?.core?.beliefs ?? []).filter((b) => b.status === 'accepted' && !b.prior && b.acceptedAt >= now - 7 * DAY);
  lines.push('## 新采纳的自我信念', accepted.length ? accepted.map((b) => `- ${b.text}`).join('\n') : '- 无', '');
  const rel = [];
  const first = snapshots[0]?.people ?? {};
  for (const [uid, p] of Object.entries(last?.people ?? {})) {
    const d = (p.intimacy ?? 0) - (first[uid]?.intimacy ?? p.intimacy ?? 0);
    if (Math.abs(d) >= 1) rel.push([uid, d]);
  }
  rel.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  lines.push('## 关系变化最大', rel.length ? rel.slice(0, 5).map(([uid, d]) => `- ${names[uid] || uid}：亲密 ${d > 0 ? '+' : ''}${d.toFixed(1)}`).join('\n') : '- 无', '');
  lines.push('## 证据（每类最多 3 条）');
  const byType = new Map();
  // PERSONA_PATCH（v2 返工 5）：`about === 'char'` 是代码派生的性格事件，没有 gist，列出来只是噪音；
  // 性格漂移照常读它们，只是不进周报的证据段。
  for (const r of evidence) {
    if (r.about === 'char') continue;
    const arr = byType.get(r.type) ?? [];
    if (arr.length < 3) arr.push(r);
    byType.set(r.type, arr);
  }
  if (!byType.size) lines.push('- 无');
  for (const [type, arr] of byType) {
    lines.push(`- ${EVIDENCE_TYPES[type]?.label ?? type}`);
    for (const r of arr) lines.push(`  - ${dayOf(r.at)} ${names[r.userId] || r.userId || r.key}${r.gist ? `：${r.gist}` : ''}${r.msgId ? `（消息 ${r.msgId}）` : ''}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * 夜间结算：信念 → 漂移 → 关系回落 → 快照；周日顺带出周报。
 * state = { core, people, meta }（就地更新 meta，返回新的 core / people 由调用方保存）。
 */
export function runNightly({ store, role, state, settings, now }) {
  const g = settings.growth;
  const since = Number(state.meta.lastNightlyAt) || now - DAY;
  const windowRows = store.readEvidence(role, now - g.beliefHalfLifeDays * DAY);
  const todayRows = windowRows.filter((r) => Number(r.at) > since);

  const core = structuredClone(state.core);
  core.beliefs = updateBeliefs(core.beliefs, windowRows, { about: 'self', now, settings, cap: g.selfBeliefCap });
  let people = structuredClone(state.people);
  for (const [uid, p] of Object.entries(people)) {
    p.beliefs = updateBeliefs(p.beliefs, windowRows.filter((r) => String(r.userId) === uid), { about: 'him', now, settings, cap: g.personBeliefCap });
  }
  const dc = driftCore(core, todayRows, people, settings);
  const dch = driftCharacter(dc.core, todayRows, people, settings); // PERSONA_PATCH（v2 §2.2）：后天性格同样每晚漂移
  const doff = driftOffsets(people, todayRows, settings);
  people = decayAbsence(doff.people, now);
  const day = dayOf(now);
  const snapshot = { day, at: now, core: dch.core, people, changes: { core: dc.changes, character: dch.changes, offsets: doff.changes } };
  store.writeSnapshot(role, day, snapshot);
  state.meta.lastNightlyAt = now;

  let report = null;
  if (g.weeklyReport && new Date(now).getDay() === 0) {
    const days = store.listSnapshots(role).slice(-7);
    const snapshots = days.map((d) => store.readSnapshot(role, d)).filter(Boolean);
    const names = Object.fromEntries(Object.entries(people).map(([uid, p]) => [uid, p.name || uid]));
    report = { name: isoWeek(now), markdown: weeklyReport({ snapshots, evidence: windowRows.filter((r) => Number(r.at) > now - 7 * DAY), names, now }) };
    store.writeReport(role, report.name, report.markdown);
  }
  return { day, core: dch.core, people, changes: snapshot.changes, report };
}

/** 回滚到某天的快照：只换 core / people，情绪不动。 */
export function rollbackTo({ store, role, day }) {
  const s = store.readSnapshot(role, day);
  if (!s?.core || !s?.people) throw new Error(`没有 ${day} 的快照`);
  return { core: s.core, people: s.people };
}

// ── 初始化：从角色卡提取出厂值 ──────────────────────────────────────────────

/**
 * PERSONA_PATCH（v2 §5 B1+B2+B3）：出厂提取一次要拿全：大五 + 后天性格 + 每项的具体表现 + 好恶 + 自我看法。
 * 输出多了约 3 倍，调用方的 maxTokens / 超时在 persona.js 里同步调大。
 */
export function factoryMessages(roleCard) {
  const charLines = CHAR_TRAITS.map((k) => `${k} ${CHAR_NAMES[k]}（高：${TRAIT_PHRASES[k].高}；低：${TRAIT_PHRASES[k].低}）`);
  const system = [
    '你是人格评估员。读下面的角色卡，给出这个角色的出厂人格，并写清每一项在她身上的具体表现、角色卡里明确写到的好恶，以及她对自己的看法。',
    '只输出一个 JSON 对象，不要任何解释：',
    '{"traits":{"O":0,"C":0,"E":0,"A":0,"N":0},',
    ' "character":{"grudge":0,"clingy":0,"guarded":0,"playful":0,"pride":0,"empathy":0},',
    ' "manifests":{"O":"…","C":"…","E":"…","A":"…","N":"…","grudge":"…","clingy":"…","guarded":"…","playful":"…","pride":"…","empathy":"…"},',
    ' "prefs":[{"text":"…","valence":"like|dislike","strength":0.6,"keywords":["…"]}],',
    ' "beliefs":["…"]}',
    '要求：',
    '- 所有数值取 0~100，50 为普通人。',
    '- traits 是先天气质：O 开放、C 尽责、E 外向、A 宜人、N 神经质。',
    `- character 是后天性格：${charLines.join('；')}。`,
    '- manifests 是「这一项在她身上的具体表现」，用角色卡里的细节写，每条 ≤ 30 字，不要写数值。',
    '- prefs 只收角色卡里明确写到的、由别人的言行或外界事物引起的喜欢 / 讨厌 / 雷点，最多 12 条。',
    '- 她自己的说话守则、口头禅、扮演规则不是好恶，不要收（例如「不用客服腔」「回复要短」「别用括号写动作」）。',
    '- 别人难过、低落、生病这类她会去关心的情况，不是她「喜欢」的事，不要收。',
    '- prefs 的 text ≤ 16 字，不要带「喜欢 / 讨厌」字样（写「雨天」，不写「喜欢雨天」）。',
    '- prefs 的 strength：只有角色卡明确写了会真生气 / 最讨厌 / 炸毛的，才给 0.85~1；一般的讨厌给 0.5~0.7，一般的喜欢给 0.5~0.7，特别喜欢的给 0.75~0.85。',
    '- prefs 的 keywords：至少 2 个字，要能单独说明命中（写「小矮子」，不写「矮」；写「碰我的书」，不写「书」）；不要放容易误伤的普通词或相反含义的词（「讨厌早起」不要配「早点睡」）；最多 3 个，每个 ≤ 8 字。',
    '- keywords 不要用称呼（「主人」「老板」「群友」「大家」这类）或聊天里天天出现的词，它们会让好恶大面积误命中。',
    '- beliefs 是第一人称自我看法，最多 5 句，每句 ≤ 20 字。'
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: String(roleCard ?? '').slice(0, 12000) }
  ];
}

// PERSONA_PATCH（§6-2）：称呼和聊天里天天出现的词做关键词，会让规则兜底大面积误命中
// （「主人」几乎每条私聊都有，等于把这条好恶变成常驻命中）。只在出厂提取这里过滤；
// savePrefs（主人手动编辑）不受影响——他明确写的东西应当照办。
export const ADDRESS_KEYWORD_RE = /主人|^(?:老板|群友|大家|你们|我们|家人们|宝宝)$/;

export function parseFactory(raw) {
  const traits = {};
  for (const t of TRAITS) {
    const v = Number(raw?.traits?.[t]);
    if (!Number.isFinite(v)) throw new Error(`出厂值缺少 ${t}`);
    traits[t] = Math.round(clamp(v, 0, 100));
  }
  // 后天性格缺项、非数字都按 50 补，不报错（模型少写一项不该让整个出厂流程失败）。
  const character = {};
  for (const k of CHAR_TRAITS) {
    const raw0 = raw?.character?.[k];
    const v = Number(raw0);
    character[k] = raw0 === undefined || raw0 === null || raw0 === '' || !Number.isFinite(v) ? 50 : Math.round(clamp(v, 0, 100));
  }
  const manifests = {};
  for (const k of ALL_TRAITS) {
    const s = raw?.manifests?.[k];
    if (typeof s !== 'string') continue;
    const text = s.trim().slice(0, 40);
    if (text) manifests[k] = text;
  }
  // PERSONA_PATCH（§6-2）：关键词里的称呼一律滤掉；pref 本身保留——模型判读靠 text 仍能命中。
  // 必须放在归一化之前滤：normalizePrefs 会先把 keywords 截成前 3 个，模型给
  // ['主人','大家','群友','小矮子'] 时「小矮子」在过滤前就被截掉，剩下全被滤空。
  // 非对象项、非数组 keywords 原样交给 normalizePrefs 兜底（它自己会丢掉 / 清空）。
  const prefs = normalizePrefs((Array.isArray(raw?.prefs) ? raw.prefs : []).map((p) => (
    p && typeof p === 'object' && Array.isArray(p.keywords)
      ? { ...p, keywords: p.keywords.filter((k) => !ADDRESS_KEYWORD_RE.test(String(k ?? '').trim())) }
      : p
  )));
  return { traits, character, manifests, prefs, beliefs: (Array.isArray(raw?.beliefs) ? raw.beliefs : []).map((s) => String(s ?? '').trim().slice(0, 30)).filter(Boolean).slice(0, 5) };
}

/**
 * 主人确认后的出厂核心：先验信念标 prior，永不自动淡化。
 * PERSONA_PATCH（v2 §5）：每项表现按「该项出厂值所在的档」存下 band；好恶整体替换。
 */
export function confirmFactory({ traits, character = {}, manifests = {}, prefs = [], beliefs = [] }, now) {
  const core = newCore(traits, character);
  for (const [k, text] of Object.entries(manifests ?? {})) {
    if (!ALL_TRAITS.includes(k) || typeof text !== 'string' || !text.trim()) continue;
    const factory = TRAITS.includes(k) ? core.traits[k].factory : core.character[k].factory;
    core.manifests[k] = { band: band(factory), text: text.trim().slice(0, 40) };
  }
  core.prefs = normalizePrefs(prefs);
  core.beliefs = beliefs.map((text) => ({ type: 'prior', text, status: 'accepted', prior: true, acceptedAt: now, refreshedAt: now, keys: [] }));
  core.confirmedAt = now;
  return core;
}

// ── A1 关系冷启动 ──────────────────────────────────────────────────────────

const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10;

/**
 * PERSONA_PATCH（v2 §6.1 A1）：用聊天存档的统计播种关系，纯计算、不调模型。
 * 只往上补、不往下压：已有判读记录的人取 max(现状, 播种值)。主人有保底（亲近）。
 * stats：ltm.listPeople() 的数组；people：当前 st.people。
 */
export function seedRelations(stats, { ownerQQ, now, people = {} } = {}) {
  const owner = String(ownerQQ ?? '');
  const out = [];
  for (const s of Array.isArray(stats) ? stats : []) {
    const userId = String(s?.userId ?? '');
    if (!/^\d+$/.test(userId)) continue;
    const messages = Number(s.messages) || 0;
    const isOwner = userId === owner;
    if (!isOwner && messages <= 0) continue;
    const familiaritySeed = Math.min(70, Math.round(8 * Math.log2(1 + messages)));
    const first = Date.parse(s.firstSeenAt);
    const last = Date.parse(s.lastSeenAt);
    const spanDays = Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, (last - first) / DAY) : 0;
    const trustSeed = clamp(Math.round(30 + 2 * Math.min(spanDays, 10) + (messages >= 20 ? 5 : 0)), 30, 55);
    const intimacySeed = clamp(Math.round(10 + 0.4 * familiaritySeed), 10, 40);
    const seed = {
      familiarity: isOwner ? Math.max(familiaritySeed, 60) : familiaritySeed,
      intimacy: isOwner ? Math.max(intimacySeed, 72) : intimacySeed,
      trust: isOwner ? Math.max(trustSeed, 72) : trustSeed
    };
    const p = people?.[userId];
    const before = p ? { intimacy: round1(p.intimacy), trust: round1(p.trust), familiarity: round1(p.familiarity) } : null;
    const after = before
      ? { intimacy: Math.max(before.intimacy, seed.intimacy), trust: Math.max(before.trust, seed.trust), familiarity: Math.max(before.familiarity, seed.familiarity) }
      : { ...seed };
    const changed = !before || after.intimacy > before.intimacy || after.trust > before.trust || after.familiarity > before.familiarity;
    out.push({ userId, name: String(s.name ?? ''), isOwner, messages, before, after, stageBefore: before ? stageOf(before) : '陌生', stageAfter: stageOf(after), changed });
  }
  out.sort((x, y) => Number(y.isOwner) - Number(x.isOwner) || y.messages - x.messages);
  return out;
}
