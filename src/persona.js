// persona.js · 人格与情绪的胶水层（PERSONA_PATCH）
//
// bridge.js 只调这里的几个入口，逻辑都在 persona-*.js：
//   onIncoming / onOutgoing / onPoke   收发消息、拍一拍
//   tick                               每分钟：群聊合批、期望落空、想念、夜间结算、刷新 live.json
//   ownLifeLine                        own-life 唤醒时附上的一句心情（以及能不能跟主人表达小情绪）
//   console                            控制台 /api/persona/* 用的读写接口
// 设计见 docs/design/PERSONA_MIND_PLAN.md §5；实施细化见 docs/design/PERSONA_IMPL_PLAN.md。
import {
  TRAITS, CHAR_TRAITS, CLOSE_STAGES, mergeSettings, dayOf, inQuiet, clamp, traitValues, modulation, newEmotion, applyImpulse, soothe,
  impulseFromAppraisal, expressedPad, renderNow, renderCore, renderRelation, newPerson, stageOf, applyRelation, padBaseline,
  upgradeCore, traitView, normalizePrefs
} from './persona-state.js';
import { createHash } from 'node:crypto';
import { createPersonaStore } from './persona-store.js';
import { createDeepSeekClient, createAppraiser, createGroupBatcher, ruleAppraise } from './persona-appraisal.js';
import { runNightly, rollbackTo, factoryMessages, parseFactory, confirmFactory, seedRelations, charEventOf } from './persona-growth.js';

// PERSONA_PATCH（v2 §12.1）：人格模块只在「从当前角色卡提议」那一刻读过角色卡，之后在控制台改了卡，
// 性格档案不会自动同步。这里对归一化后的卡文本取 sha256，确认出厂时记下来，之后就能提示「卡改过了」。
// 归一化只吃掉行尾 CRLF 和首尾空白——错别字、示例这类小改仍会变哈希，由主人决定要不要重新提取。
// 空卡返回 ''（读不到角色卡时不记录版本，避免把「读不到」当成一个有效的已同步状态）。
function cardHash(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
  return s ? createHash('sha256').update(s, 'utf8').digest('hex') : '';
}

const EXPRESS_HINT = '如果你现在心里有点小情绪（想他了、有点不开心、觉得被冷落），可以直接给他发一句说出来，像平时撒娇或抱怨那样；别长篇大论，也别翻旧账。不想说就算了。';

/**
 * FIX1031_PATCH：从用量表里算「今天别的运行已经用掉的模型调用次数」。
 * usage.json 的形状是 { version, days: { 'YYYY-MM-DD': { [runId]: { calls, ... } } } }；同一天重启几次
 * 就有几条运行记录，本次运行的那条由判读器自己数，这里只看别的运行。纯函数（不读盘，方便单测），
 * 坏数据一律算 0——上限判断不能把判读搞挂。
 */
export function sumPriorCalls(usage, day, runId) {
  const runs = usage?.days?.[day];
  if (!runs || typeof runs !== 'object' || Array.isArray(runs)) return 0;
  let sum = 0;
  for (const [id, row] of Object.entries(runs)) {
    if (id === runId) continue;
    const n = Number(row?.calls);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return sum;
}

export function createPersona({
  stateDir, roleName, roleCard, sessions, ownerQQ, peopleStats = () => [],
  redact = (s) => s, log = () => {}, fetchImpl = fetch, now = () => Date.now(), onWeeklyReport = null
}) {
  const store = createPersonaStore({ rootDir: stateDir });
  const settings = () => mergeSettings(store.readConfig().settings ?? {});
  const apiKey = () => String(store.readConfig().apiKey ?? '');
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: apiKey, fetchImpl });
  // FIX1031_PATCH：把「今天别的运行用掉的次数」传给判读器，每日上限跨重启累计（见下面 priorCalls）。
  const appraiser = createAppraiser({ client, getSettings: settings, log, now, priorCalls });
  const batcher = createGroupBatcher({ getSettings: settings, now, flush: (key, lines) => { appraiseAtmosphere(key, lines).catch(() => {}); } });

  // ── 判读用量落盘（PERSONA_PATCH §6-1）──────────────────────────────────────
  // 判读器的当日计数只在内存里，桥接一重启就清零（HANDOFF §6-1）。tick 每分钟把 stats() 写进
  // state/persona/usage.json，按「天 × 本次运行」分开存，读的时候加起来。
  // FIX1031_PATCH：每日上限改为跨重启累计——判读器通过 priorCalls 把「今天、别的运行」的 calls
  // 一起算进上限（以前只看本次运行，重启后从 0 开始，一天重启几次上限就形同放宽）。
  // 控制台的 stats() 含义不变，仍是本次运行的计数。
  const runId = `${now().toString(36)}-${process.pid}`; // 同一天重启几次就有几条运行记录
  const USAGE_KEEP_DAYS = 60;
  const USAGE_FIELDS = ['calls', 'rules', 'failures', 'cacheHit', 'cacheMiss', 'output', 'cost'];
  let lastUsageSig = '';
  let lastUsageErr = '';

  // FIX1031_PATCH：今天别的运行已经用掉的模型调用次数，交给判读器算每日上限。
  // 按天缓存、每 10 分钟刷新一次：别的运行此刻不会同时在跑，但重启前那次运行最后一分钟的用量
  // 可能刚落盘，永久缓存会把刚重启时的额度算少。
  const PRIOR_CALLS_TTL_MS = 10 * 60 * 1000;
  let priorCallsCache = { day: '', at: 0, value: 0 };

  /** 读盘失败一律按 0（判读器还有一层兜底），绝不让上限判断打断判读。 */
  function priorCalls(day) {
    const t = now();
    const age = t - priorCallsCache.at;
    if (priorCallsCache.day === day && age >= 0 && age < PRIOR_CALLS_TTL_MS) return priorCallsCache.value;
    let value = 0;
    try { value = sumPriorCalls(store.readUsage(), day, runId); } catch { value = 0; }
    priorCallsCache = { day, at: t, value };
    return value;
  }

  /** 把本次运行的用量写盘。任何异常都只记一行日志，绝不抛给 tick / stop / status 这些主路径。 */
  function flushUsage() {
    try {
      const s = appraiser.stats();
      if (!s.day) return; // 还没判读过：stats 里连日期都没有
      const row = Object.fromEntries(USAGE_FIELDS.map((k) => [k, Number(s[k]) || 0]));
      if (!USAGE_FIELDS.some((k) => row[k])) return; // 全 0 不创建文件
      const sig = JSON.stringify([s.day, row]);
      if (sig === lastUsageSig) return; // 每分钟都会调，没变化不写盘
      const u = store.readUsage();
      (u.days[s.day] ??= {})[runId] = { ...row, updatedAt: now() };
      const days = Object.keys(u.days).sort(); // YYYY-MM-DD 字典序即时间序
      for (const d of days.slice(0, Math.max(0, days.length - USAGE_KEEP_DAYS))) delete u.days[d];
      store.writeUsage(u);
      lastUsageSig = sig;
      lastUsageErr = '';
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg !== lastUsageErr) log(`[persona] 用量落盘失败：${msg}`);
      lastUsageErr = msg;
    }
  }

  let role = null;
  let S = null; // { core, people, emotion, meta }
  let lastLive = '';
  let timer = null;
  let nightlyRunning = false;
  const awaiting = new Map(); // key → 她上次说话的时间（等回应，用来判断期望落空）
  const speakers = new Map(); // key → 最近说话的 QQ 号（最多 3 个，群聊注入关系用）

  function ensure() {
    const r = String(roleName() || 'default');
    if (r !== role || !S) {
      role = r;
      S = store.load(r);
      // PERSONA_PATCH（v2 §7）：老的 core.json 是 v1，读进来先升到 v2（补后天性格 / manifests / prefs）。
      S.core = upgradeCore(S.core);
      S.emotion ??= newEmotion(now());
      S.meta ??= {};
      lastLive = '';
    }
    return S;
  }
  const persist = (...parts) => { for (const p of parts) store.save(role, p, S[p]); };
  const ready = () => settings().enabled && !!ensure().core;

  function noteSpeaker(key, userId) {
    const list = (speakers.get(key) ?? []).filter((u) => u !== userId);
    list.unshift(userId);
    speakers.set(key, list.slice(0, 3));
  }

  /** 把一次判读落到情绪、关系、证据、判读日志上。 */
  function applyAppraisal({ key, userId = null, msgId = null, a, t = now() }) {
    const s = settings();
    const st = ensure();
    const values = traitValues(st.core);
    const mod = modulation(values);
    const prefs = st.core.prefs ?? [];
    applyImpulse(st.emotion, { key, ...impulseFromAppraisal(a, mod, s, prefs) }, t, s, mod);
    if (a.kind === 'apology' && a.target === 'me') soothe(st.emotion, key, t, s, mod);
    if (userId) applyRelation((st.people[userId] ??= newPerson(t)), a, t);
    for (const e of a.evidence) {
      store.appendEvidence(role, { at: t, day: dayOf(t), about: e.about, type: e.type, userId, key, msgId, gist: redact(e.gist) });
    }
    // PERSONA_PATCH（v2 §1.3 / §7）：代码派生的后天性格事件（没有 gist、没有原文），每晚交给 driftCharacter。
    const charType = charEventOf(a, prefs);
    if (charType && (userId || key)) store.appendEvidence(role, { at: t, day: dayOf(t), about: 'char', type: charType, userId, key, derived: true });
    // PERSONA_PATCH（v2 §7）：戳中好恶就累计命中次数（控制台看好恶有没有被踩到），不进提示词。
    const hitPref = a.trigger ? prefs.find((p) => p.id === a.trigger) : null;
    if (hitPref) {
      hitPref.hits = (Number(hitPref.hits) || 0) + 1;
      hitPref.lastHitAt = t;
      persist('core');
    }
    store.appendAppraisal(role, key, { at: t, msgId, userId, target: a.target, kind: a.kind, label: a.emotion.label, intensity: a.intensity, salience: a.salience, source: a.source });
    persist('emotion', 'people');
    writeLive();
  }

  function inputFor(key, userId, speaker, text, context, atmosphere = false) {
    const s = settings();
    const st = ensure();
    const values = traitValues(st.core);
    const p = userId ? st.people[userId] : null;
    return {
      persona: renderCore(st.core).split('\n').slice(1).join(' '),
      // PERSONA_PATCH（v2 §7 / §4.2 B3）：好恶交给判读（进 system 前缀）与规则兜底（按 keywords 命中、按 strength 排序）；
      // 只在这里传，不写判读日志。
      prefs: (st.core.prefs ?? []).map(({ id, text: prefText, valence, strength, keywords }) => ({ id, text: prefText, valence, strength, keywords })),
      emotion: renderNow(st.emotion, key, values, s, now()).replace('【你此刻】', ''),
      relation: p ? renderRelation(p, speaker, { key }).replace(/^【[^】]*】/, '') : '',
      context: context.map((l) => redact(String(l)).slice(0, 200)).slice(-s.appraisal.contextMessages),
      speaker,
      text: redact(String(text)).slice(0, 1000),
      atmosphere
    };
  }

  async function onIncoming({ key, kind, userId, name = '', text = '', msgId = null, directed = false, context = [] }) {
    if (!ready()) return;
    const st = ensure();
    const uid = String(userId);
    if (directed || kind === 'private') awaiting.delete(key);
    const p = (st.people[uid] ??= newPerson(now()));
    if (name) p.name = String(name).slice(0, 30);
    noteSpeaker(key, uid);
    // 群聊里和她无关、关系也一般、又没有强情绪词的消息：攒起来按「群气氛」判读，省调用。
    if (kind === 'group' && !directed && !CLOSE_STAGES.has(stageOf(p)) && ruleAppraise({ text }).kind === 'normal') {
      batcher.add(key, `${p.name || uid}：${redact(String(text)).slice(0, 200)}`);
      return;
    }
    const a = await appraiser.appraise({ ...inputFor(key, uid, p.name || uid, text, context), directed });
    if (a) applyAppraisal({ key, userId: uid, msgId, a });
  }

  async function appraiseAtmosphere(key, lines) {
    if (!ready()) return;
    const a = await appraiser.appraise(inputFor(key, null, '群友', lines.join('\n'), [], true));
    if (a) applyAppraisal({ key, a: { ...a, target: a.target === 'me' ? 'me' : 'none', evidence: [] } });
  }

  function onOutgoing({ key }) {
    if (!ready()) return;
    awaiting.set(key, now());
  }

  function onPoke({ key, userId, name = '' }) {
    if (!ready()) return;
    const a = { source: 'rules', target: 'me', kind: 'tease', intensity: 0.4, emotion: { label: '害羞' }, pad: { p: 1, a: 1, d: 0 }, relation: { intimacy: 1, trust: 0 }, evidence: [], salience: 0.3, cause: `${String(name || userId).slice(0, 8)}拍了拍你` };
    applyAppraisal({ key, userId: String(userId), a });
  }

  async function nightly() {
    if (!ready() || nightlyRunning) return null;
    nightlyRunning = true;
    try {
      const st = ensure();
      const r = runNightly({ store, role, state: st, settings: settings(), now: now() });
      st.core = r.core;
      st.people = r.people;
      persist('core', 'people', 'meta');
      writeLive();
      log(`[persona] 夜间结算完成 ${r.day}：性格变化 ${JSON.stringify(r.changes.core)}`);
      // PERSONA_PATCH：影子期（inject=false）只算不注入——周报照常写盘（控制台能看），但不回调去给主人发提示。
      if (r.report && settings().inject && settings().growth.reportToDiary && typeof onWeeklyReport === 'function') onWeeklyReport(r.report);
      return r;
    } finally {
      nightlyRunning = false;
    }
  }

  function tick() {
    flushUsage(); // PERSONA_PATCH（§6-1）：先落盘上一分钟的用量；即使模块没启用也要写（判读器是全局的）
    const s = settings();
    if (!ready()) return;
    const st = ensure();
    const t = now();
    // PERSONA_PATCH（v2 §7 / §2.1）：期望落空的等待时间按黏人缩放（expectMul）。
    const mod = modulation(traitValues(st.core));
    batcher.tick();
    // 期望落空：她说完话，私聊 30 分钟 / 群聊 10 分钟没人接（安静时段不算）。
    for (const [key, at] of [...awaiting]) {
      const lim = (key.startsWith('private:') ? s.express.expectMinutes.private : s.express.expectMinutes.group) * 60000 * mod.expectMul;
      if (t - at < lim) continue;
      awaiting.delete(key);
      if (inQuiet(t, s)) continue;
      applyAppraisal({ key, userId: key.startsWith('private:') ? key.slice(8) : null, a: { source: 'rules', target: 'me', kind: 'ignore', intensity: 0.5, emotion: { label: '委屈' }, pad: { p: -1, a: 0, d: -1 }, relation: { intimacy: 0, trust: 0 }, evidence: [{ about: 'self', type: 'ignored', gist: '说的话没人接' }], salience: 0.3, cause: '说的话没人接' }, t });
    }
    // 想念：主人超过一天没来，关系到「朋友」以上，每天最多一次。
    const owner = String(ownerQQ() || '');
    const op = owner ? st.people[owner] : null;
    const today = dayOf(t);
    if (op && op.lastSeenAt && t - op.lastSeenAt > 86400000 && ['朋友', '亲近'].includes(stageOf(op)) && st.meta.longingDay !== today && !inQuiet(t, s)) {
      st.meta.longingDay = today;
      persist('meta');
      applyAppraisal({ key: `private:${owner}`, a: { source: 'rules', target: 'me', kind: 'normal', intensity: 0.6, emotion: { label: '想念' }, pad: { p: -1, a: 0, d: 0 }, relation: { intimacy: 0, trust: 0 }, evidence: [], salience: 0.3, cause: '他一天多没来了' }, t });
    }
    // 夜间结算：到点且今天还没跑过。
    const hhmm = `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`;
    if (hhmm >= s.growth.nightlyAt && st.meta.nightlyDay !== today) {
      st.meta.nightlyDay = today;
      persist('meta');
      nightly().catch((e) => log(`[persona] 夜间结算失败：${e?.message ?? e}`));
    }
    writeLive();
  }

  function contextFor(key) {
    const s = settings();
    const st = ensure();
    const lines = [renderNow(st.emotion, key, traitValues(st.core), s, now())];
    const ids = key.startsWith('private:') ? [key.slice(8)] : speakers.get(key) ?? [];
    for (const uid of ids.slice(0, 3)) {
      const p = st.people[uid];
      if (p && (p.familiarity ?? 0) > 0) lines.push(renderRelation(p, p.name || uid, { key }));
    }
    return lines.join('\n');
  }

  /** 写给 DSH 插件读的快照；内容不变就不写（插件按 mtime 缓存）。 */
  function writeLive() {
    const s = settings();
    const st = ensure();
    const live = { version: 1, core: '', sessions: {}, byKey: {} };
    if (s.enabled && s.inject && st.core) {
      live.core = renderCore(st.core);
      for (const [key, sid] of Object.entries(sessions() || {})) {
        if (typeof sid !== 'string' || !sid || !/^(group|private):\d+$/.test(key)) continue;
        live.sessions[sid] = key;
        live.byKey[key] = contextFor(key);
      }
    }
    const json = JSON.stringify(live);
    if (json === lastLive) return;
    store.writeLive(live);
    lastLive = json;
  }

  function ownLifeLine() {
    if (!ready()) return '';
    const s = settings();
    // PERSONA_PATCH：影子期（inject=false）只判读不注入——心情文字也不给她，且不消耗当天的表达次数。
    if (!s.inject) return '';
    const st = ensure();
    const owner = String(ownerQQ() || '');
    if (!owner) return '';
    const key = `private:${owner}`;
    const t = now();
    const values = traitValues(st.core);
    const mod = modulation(values);
    const text = renderNow(st.emotion, key, values, s, t);
    const today = dayOf(t);
    if (st.meta.expressDay !== today) { st.meta.expressDay = today; st.meta.expressCount = 0; }
    const pad = expressedPad(st.emotion, key, values, s);
    const longing = st.emotion.labels.some((l) => l.name === '想念' && l.v >= 0.2);
    // PERSONA_PATCH（v2 §7 / §2.1）：门槛由嘴硬决定（原来写死 −0.15）。
    const allow = s.inject && !inQuiet(t, s) && st.meta.expressCount < s.express.toOwnerPerDay && (pad.p <= mod.expressThreshold || longing);
    if (allow) st.meta.expressCount += 1;
    persist('meta');
    return allow ? `${text}\n${EXPRESS_HINT}` : text;
  }

  // ── 约定兑现 / 爽约（LIFE_LOOP_PATCH，规格 §7.3）──────────────────────────
  // 桥接在账本的 onPromiseClosed 里调 onPromise：对方兑现了会开心、信任涨；爽约会委屈、信任掉；
  // 她自己答应的事兑现了会得意，没做到会难过（语气上表达一点内疚）。
  // 全部走规则来源（source='rules'），不碰判读管线——影子期内线上判读数据要前后可比。
  const PROMISE_EFFECTS = Object.freeze({
    'them:done': { kind: 'care', label: '开心', pad: { p: 1, a: 0.2, d: 0.1 }, intensity: 0.5, salience: 0.5, trustDelta: 2, cause: (who) => `${who}说到做到了` },
    'them:missed': { kind: 'ignore', label: '委屈', pad: { p: -1, a: 0, d: -0.3 }, intensity: 0.5, salience: 0.5, trustDelta: -3, cause: (who) => `${who}说好的事没做到` },
    // 情绪标签表里没有「内疚」：用「难过」+ cause 表达（影子期不改标签表）。
    'me:done': { kind: 'normal', label: '得意', pad: { p: 0.6, a: 0.1, d: 0.3 }, intensity: 0.3, salience: 0.4, trustDelta: 0, cause: (who) => `答应${who}的事做到了` },
    'me:missed': { kind: 'normal', label: '难过', pad: { p: -0.6, a: -0.1, d: -0.4 }, intensity: 0.4, salience: 0.4, trustDelta: 0, cause: (who) => `答应${who}的事没做到，有点内疚` }
  });

  function onPromise({ key = '', userId, name = '', by, outcome } = {}) {
    if (!ready()) return;
    if (outcome !== 'done' && outcome !== 'missed') return;
    if (by !== 'me' && by !== 'them') return;
    const eff = PROMISE_EFFECTS[`${by}:${outcome}`];
    if (!eff) return;
    const who = String(name || userId).slice(0, 8);
    const a = {
      source: 'rules',
      target: 'me',
      kind: eff.kind,
      intensity: eff.intensity,
      emotion: { label: eff.label },
      pad: eff.pad,
      relation: { intimacy: 0, trust: 0 },
      evidence: [],
      salience: eff.salience,
      trustDelta: eff.trustDelta,
      cause: eff.cause(who)
    };
    applyAppraisal({ key, userId: String(userId), a });
  }

  /** 当前对某个人的关系（只读，不写盘）；没这个人或没初始化返回 null。 */
  function relationOf(userId) {
    if (!ready()) return null;
    const p = ensure().people[String(userId ?? '')];
    if (!p) return null;
    return { intimacy: p.intimacy, trust: p.trust, familiarity: p.familiarity, stage: stageOf(p) };
  }

  /** 某个会话里每条消息的判读显著度（msgId → 最大值）；生活回路用它筛「值得忽然想起」的话。 */
  function salienceByMsg(key, { sinceMs = 0 } = {}) {
    if (!ready()) return new Map();
    const map = new Map();
    for (const r of store.readAppraisals(role, key, { sinceMs })) {
      if (r?.msgId == null || r.msgId === '') continue;
      const s = Number(r.salience);
      if (!Number.isFinite(s)) continue;
      const id = String(r.msgId);
      if (!map.has(id) || s > map.get(id)) map.set(id, s);
    }
    return map;
  }

  // DECAY_PATCH：遗忘曲线给消息定起点牢固度要同时看显著度和情绪强度（规格 §3）。
  // 只读判读日志，不改判读 / 情绪的任何状态（影子期约束）。
  function appraisalByMsg(key, { sinceMs = 0 } = {}) {
    if (!ready()) return new Map();
    const map = new Map();
    for (const r of store.readAppraisals(role, key, { sinceMs })) {
      if (r?.msgId == null || r.msgId === '') continue;
      const id = String(r.msgId);
      const cur = map.get(id) ?? {};
      const s = Number(r.salience);
      const i = Number(r.intensity);
      if (Number.isFinite(s) && !(cur.salience >= s)) cur.salience = s;
      if (Number.isFinite(i) && !(cur.intensity >= i)) cur.intensity = i;
      map.set(id, cur);
    }
    return map;
  }

  // ── 控制台 ───────────────────────────────────────────────────────────────
  // PERSONA_PATCH（§6-1）：近 n 天用量。用量文件按「天 × 运行」累加；判读日志按天统计作对照
  // （日志任何时候都有，包括用量功能上线之前）。日期升序，今天在最后。
  function usageHistory(days = 7) {
    const n = clamp(Math.round(Number(days) || 7), 1, 60);
    ensure();
    const d = new Date(now());
    const dayKeys = [];
    // 按本地日历往前减天（`new Date(y, m, d - i)` 自己处理跨月 / 跨年），不要用固定毫秒数相减。
    for (let i = n - 1; i >= 0; i--) dayKeys.push(dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime()));
    const firstMs = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (n - 1)).getTime();
    const u = store.readUsage();
    const logged = store.appraisalDayCounts(role, firstMs);
    return dayKeys.map((day) => {
      const runsObj = u.days?.[day];
      const runs = runsObj && typeof runsObj === 'object' ? Object.values(runsObj) : [];
      const sum = Object.fromEntries(USAGE_FIELDS.map((k) => [k, 0]));
      for (const r of runs) for (const k of USAGE_FIELDS) sum[k] += Number(r?.[k]) || 0; // 非数字按 0
      const lg = logged[day] ?? { model: 0, rules: 0 };
      return {
        day,
        recorded: runs.length > 0,
        calls: sum.calls,
        rules: sum.rules,
        failures: sum.failures,
        cacheHit: sum.cacheHit,
        cacheMiss: sum.cacheMiss,
        output: sum.output,
        cost: +sum.cost.toFixed(4),
        runs: runs.length,
        logged: { model: Number(lg.model) || 0, rules: Number(lg.rules) || 0 }
      };
    });
  }

  // PERSONA_PATCH（v2 §12.1）：角色卡版本状态。每次读一遍当前角色卡（小文件）；没记录时 changed 为 null。
  function cardStatus(core) {
    const recorded = !!core?.card?.hash;
    return {
      recorded,
      changed: recorded ? cardHash(roleCard(role)) !== core.card.hash : null,
      recordedAt: core?.card?.at ?? 0
    };
  }

  function maskedConfig() {
    const c = store.readConfig();
    const key = String(c.apiKey ?? '');
    return { settings: settings(), apiKeyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}（${key.length} 位）` : '' };
  }

  const consoleApi = {
    status() {
      flushUsage(); // PERSONA_PATCH（§6-1）：保证控制台看到的是最新用量
      const s = settings();
      const st = ensure();
      const values = st.core ? traitValues(st.core) : null;
      return {
        role, initialized: !!st.core, ...maskedConfig(), stats: appraiser.stats(), usage: usageHistory(7),
        core: st.core, traitView: st.core ? traitView(st.core) : [], card: st.core ? cardStatus(st.core) : null, baseline: values ? padBaseline(values) : null,
        emotion: { core: st.emotion.core, labels: st.emotion.labels, scenes: st.emotion.scenes, history: st.emotion.history },
        rendered: st.core ? { core: renderCore(st.core), byKey: Object.fromEntries(Object.keys(sessions() || {}).filter((k) => /^(group|private):\d+$/.test(k)).map((k) => [k, contextFor(k)])) } : null,
        meta: st.meta, enabled: s.enabled, inject: s.inject
      };
    },
    people() {
      const st = ensure();
      return Object.entries(st.people).map(([userId, p]) => ({ userId, name: p.name, stage: stageOf(p), intimacy: +p.intimacy.toFixed(1), trust: +p.trust.toFixed(1), familiarity: +p.familiarity.toFixed(1), offsets: p.offsets, beliefs: p.beliefs, nickname: p.nickname, jokes: p.jokes, lastSeenAt: p.lastSeenAt }))
        .sort((x, y) => (y.lastSeenAt || 0) - (x.lastSeenAt || 0));
    },
    evidence(limit = 100) { ensure(); return store.readEvidence(role, 0).slice(-Math.min(500, Math.max(1, Number(limit) || 100))).reverse(); },
    snapshots() { ensure(); return store.listSnapshots(role); },
    reports() { ensure(); return store.listReports(role); },
    report(name) { ensure(); return store.readReport(role, name); },
    saveConfig(patch = {}) {
      const c = store.readConfig();
      const next = { ...c };
      if (patch.settings && typeof patch.settings === 'object') next.settings = mergeSettings({ ...(c.settings ?? {}), ...patch.settings });
      if (patch.clearApiKey === true) next.apiKey = '';
      else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
      store.writeConfig(next);
      lastLive = '';
      writeLive();
      return maskedConfig();
    },
    async proposeFactory() {
      const r = String(roleName() || 'default');
      const card = String(roleCard(r) || '');
      if (!card) throw new Error(`读不到角色卡：${r}`);
      // PERSONA_PATCH（v2 §5 / §7）：v2 一次要拿 11 个数、11 段表现、好恶和信念，输出约为 v1 的 3 倍，
      // 所以 maxTokens 1500 → 3000、超时 30 秒 → 60 秒（原来 1500 是按「只有 5 个数 + 信念」实测定的）。
      const { json } = await client.chatJson(factoryMessages(card), { maxTokens: 3000, timeoutMs: 60000 });
      return parseFactory(json);
    },
    confirmFactory({ traits, character, manifests, prefs, beliefs }) {
      const st = ensure();
      const f = parseFactory({ traits, character, manifests, prefs, beliefs });
      const fresh = confirmFactory(f, now());
      if (st.core) {
        // 已初始化：大五和后天性格都改出厂值；每项表现与好恶整体替换；养成出来的信念保留。
        // PERSONA_PATCH（v2 返工）：当前值要保留已经养成出来的偏移、跟着出厂值一起移动，而不是夹回新出厂值的边界——
        // v1 → v2 升级后 6 项后天性格补的是 50/50，夹回边界会让她带着比设定低 15 的性格上线
        // （比如新出厂 86，当前值会被夹成 71）。从来没变化过的项（当前 = 旧出厂）因此正好等于新出厂值。
        const g = settings().growth;
        const rebase = (tr, factory) => {
          const offset = Number(tr.value) - Number(tr.factory);
          tr.factory = factory;
          tr.value = +clamp(factory + offset, Math.max(0, factory - g.maxDrift), Math.min(100, factory + g.maxDrift)).toFixed(2);
        };
        st.core.character ??= fresh.character;
        for (const t of TRAITS) rebase(st.core.traits[t], f.traits[t]);
        for (const k of CHAR_TRAITS) rebase(st.core.character[k], f.character[k]);
        st.core.manifests = fresh.manifests;
        st.core.prefs = fresh.prefs;
        st.core.beliefs = [...st.core.beliefs.filter((b) => !b.prior), ...fresh.beliefs];
      } else {
        st.core = fresh;
        // PERSONA_PATCH（§6-4）：第一次确认时把「今天已经结算过」记下来。否则 tick 一分钟后发现
        // nightlyDay 为空且已过 nightlyAt，立刻跑一次夜间结算，留下当天的一份空快照。
        // 这样第一次夜间结算从下一个日历日的 nightlyAt 才开始。
        st.meta.nightlyDay = dayOf(now());
      }
      // PERSONA_PATCH（v2 §12.1）：新建和重新确认两条路径都记下这次出厂值来自哪个版本的角色卡。
      st.core.card = { hash: cardHash(roleCard(role)), at: now() };
      persist('core', 'meta');
      writeLive();
      return st.core;
    },
    lock(trait, locked) {
      const st = ensure();
      // PERSONA_PATCH（v2 §7）：后天性格 6 项也能锁。
      const group = TRAITS.includes(trait) ? st.core?.traits : CHAR_TRAITS.includes(trait) ? st.core?.character : null;
      if (!group?.[trait]) throw new Error(`未知特质：${trait}`);
      group[trait].locked = !!locked;
      persist('core');
      return st.core;
    },
    /** PERSONA_PATCH（v2 §12.1）：把当前角色卡版本记成已同步（只是小改，或这个功能上线前确认过的 core）。 */
    ackCard() {
      const st = ensure();
      if (!st.core) throw new Error('先确认出厂性格');
      st.core.card = { hash: cardHash(roleCard(role)), at: now() };
      persist('core');
      return cardStatus(st.core);
    },
    /** PERSONA_PATCH（v2 §7 / §4）：只改好恶，不用重新确认出厂性格。 */
    savePrefs(list) {
      const st = ensure();
      if (!st.core) throw new Error('先确认出厂性格');
      st.core.prefs = normalizePrefs(list);
      persist('core');
      writeLive();
      return st.core;
    },
    /** PERSONA_PATCH（v2 §6.2 A1）：关系冷启动预览。只读，不写盘。 */
    seedPreview() {
      const st = ensure();
      if (!st.core) throw new Error('先确认出厂性格');
      return { proposals: seedRelations(peopleStats(), { ownerQQ: String(ownerQQ() || ''), now: now(), people: st.people }) };
    },
    /** PERSONA_PATCH（v2 §6.2 A1）：只写有变化的人（传了 userIds 再按它过滤），日志只记人数。 */
    seedApply(userIds = null) {
      const st = ensure();
      if (!st.core) throw new Error('先确认出厂性格');
      const t = now();
      const only = Array.isArray(userIds) && userIds.length ? new Set(userIds.map((u) => String(u))) : null;
      const applied = [];
      for (const p of seedRelations(peopleStats(), { ownerQQ: String(ownerQQ() || ''), now: t, people: st.people })) {
        if (!p.changed || (only && !only.has(p.userId))) continue;
        const person = (st.people[p.userId] ??= newPerson(t));
        if (!person.name && p.name) person.name = String(p.name).slice(0, 30);
        person.intimacy = p.after.intimacy;
        person.trust = p.after.trust;
        person.familiarity = p.after.familiarity;
        person.seededAt = t;
        applied.push(p.userId);
      }
      if (applied.length) {
        persist('people');
        writeLive();
        // 只记人数：人名和 QQ 号属于私人数据，不写日志。
        log(`[persona] 关系冷启动：写入 ${applied.length} 人`);
      }
      return { applied };
    },
    rollback(day) {
      const st = ensure();
      const r = rollbackTo({ store, role, day });
      st.core = r.core;
      st.people = r.people;
      persist('core', 'people');
      writeLive();
      log(`[persona] 已回滚到 ${day} 的快照`);
      return { ok: true, day };
    },
    runNightly: () => nightly()
  };

  // PERSONA_PATCH：桥接在收发消息、拍一拍、own-life 投递这些主路径上同步调这三个钩子。
  // state/persona/ 写失败（权限、磁盘满、目录被删）时只记一行日志，绝不把异常抛回桥接。
  const guarded = (name, fallback, fn) => (...args) => {
    try { return fn(...args); } catch (e) { log(`[persona] ${name} 失败：${e?.message ?? e}`); return fallback; }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { try { tick(); } catch (e) { log(`[persona] tick 失败：${e?.message ?? e}`); } }, 60000);
      timer.unref?.();
      try { ensure(); writeLive(); } catch (e) { log(`[persona] 启动时写快照失败：${e?.message ?? e}`); }
    },
    stop() { flushUsage(); if (timer) clearInterval(timer); timer = null; },
    onIncoming, tick, writeLive,
    // PERSONA_PATCH：这三个是桥接主路径上的同步调用，各自包一层异常隔离。
    onOutgoing: guarded('onOutgoing', undefined, onOutgoing),
    onPoke: guarded('onPoke', undefined, onPoke),
    ownLifeLine: guarded('ownLifeLine', '', ownLifeLine),
    // LIFE_LOOP_PATCH（规格 §7.3）：生活回路的入口，同样各自隔离异常。
    onPromise: guarded('onPromise', undefined, onPromise),
    relationOf: guarded('relationOf', null, relationOf),
    salienceByMsg: guarded('salienceByMsg', new Map(), salienceByMsg),
    appraisalByMsg: guarded('appraisalByMsg', new Map(), appraisalByMsg),
    console: consoleApi,
    _store: store
  };
}
