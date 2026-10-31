// 端到端探针：确认 AI 读了新版 qq_history_search 的**工具描述**之后，会自己
//   ① 给 3~8 个 keywords；② 把「前天」「上周」这类相对时间换算成具体日期。
//
// 为什么不在提示词里教它怎么填参数：这一版的关键设计是「查询改写由 AI 在调用工具时自己做」
// （方案 §3.3），而改写的依据就是工具描述本身。提示词一旦教了参数，测的就不是描述了。
//
// 三个场景各建一个新会话（互不串味），都要求它先查一次再回复「完成」。
// 令牌故意给无效值：这是探针，桥接会拒绝（只读、安全），提示词里已说明「令牌无效是预期，不要重试」。
//
// ⚠️ 改完 MCP 工具 schema 要**重启 DSH** 工具清单才刷新。没重启时跑这个脚本，keywords 一项会 ❌
//    （线上加载的还是旧 schema，模型根本看不到这个参数），属预期结果。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';
// 判定前用桥接**同一套**日期规整逻辑，模型可以直接写「上周」「前天」。
import { normalizeDateRange } from '../src/memory-rag-client.js';

const PRESET = 'qq-chat-v2';
const KEY = 'private:100000001';
const TOKEN = 'probe-invalid';
const TOOL = 'qq_history_search';
const SCENARIO_TIMEOUT_MS = 120_000;

const cookie = probeCookie();
const rpc = probeRpc(cookie);

// ── 当前时间与日期换算（北京时间，脚本运行时现算）────────────────────────
// 只用来构造提示词和判定期望日期；日期加减走 UTC 零点，中国没有夏令时，不会错位。
const TZ = 'Asia/Shanghai';
// 提示词、期望日期、日期规整都用同一个时间点，避免跨零点时前后不一致。
const NOW = new Date();
const nowText = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ, dateStyle: 'full', timeStyle: 'short', hour12: false
}).format(NOW);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(NOW);
const [ty, tm, td] = today.split('-').map(Number);
const baseUtc = Date.UTC(ty, tm - 1, td);
const addDays = (n) => new Date(baseUtc + n * 86_400_000).toISOString().slice(0, 10);
const dayBeforeYesterday = addDays(-2);
const yesterday = addDays(-1);
const weekdayName = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'long' }).format(NOW);
const weekdayNum = ({ 星期日: 7, 星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6 })[weekdayName] ?? 1;
const lastMonday = addDays(-(weekdayNum - 1) - 7);
const lastSunday = addDays(-(weekdayNum - 1) - 1);
const earliestAllowed = addDays(-14);

function basePrompt(body) {
  return [
    `当前时间：${nowText}（北京时间）`,
    `【会话 key】${KEY}`,
    `【会话令牌】${TOKEN}`,
    '（这是探针环境：工具返回「令牌无效」是预期结果，不要重试，也不要换个工具再试。）',
    '（这是工具测试：不要调用任何发送类工具 —— qq_send_message、qq_send_*、qq_tts_voice、发表情、戳一戳等一律不要调。）',
    '',
    `对方发来一条私聊消息：「${body}」`,
    '',
    `请先用 ${TOOL} 查一次聊天记录，查完直接用文字回复：完成`
  ].join('\n');
}

// ── 场景定义 ────────────────────────────────────────────────────────────
const scenarios = [
  {
    name: '前天晚上（相对时间换算）',
    body: '前天晚上我跟你说的那件事你还记得吗？就是关于记忆的那个',
    dateCheck: ({ from, to }) => {
      // 「前天晚上」可能聊过了零点：from=前天、to=昨天也算合理。
      const ok = from === dayBeforeYesterday && (to === dayBeforeYesterday || to === yesterday);
      return {
        ok,
        detail: `期望（规整后）from=${dayBeforeYesterday}、to=${dayBeforeYesterday} 或 ${yesterday}，实际 ${from || '—'} / ${to || '—'}`
      };
    }
  },
  {
    name: '上周（相对时间换算）',
    body: '上周我说要带猫去看病，后来怎么样了你还记得不',
    dateCheck: ({ from, to }) => {
      const f = parseDate(from);
      const t = parseDate(to);
      if (!f || !t) return { ok: false, detail: `from/to 不是合法日期（${from ?? '—'} / ${to ?? '—'}）` };
      // 覆盖上周一～上周日，允许略宽，但整段都要落在近 14 天内、且不晚于今天。
      const covers = from <= lastMonday && to >= lastSunday;
      const sane = from >= earliestAllowed && to <= today;
      return {
        ok: covers && sane,
        detail: `期望（规整后）覆盖 ${lastMonday}～${lastSunday}（近 14 天内），实际 ${from}～${to}`
          + (covers ? '' : '；未覆盖上周')
          + (sane ? '' : '；超出近 14 天/晚于今天')
      };
    }
  },
  {
    name: '最喜欢吃什么（不要求日期）',
    body: '你还记得我说过我最喜欢吃什么吗',
    dateCheck: () => ({ ok: true, detail: '不要求 from/to' })
  }
];

// ── 工具函数 ────────────────────────────────────────────────────────────
// YYYY-MM-DD 合法日历日期（排除 2026-02-31 这种会被 Date 自动进位的写法）。
function parseDate(value) {
  const s = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? s : null;
}

// 打印前把令牌抹掉（工具参数、返回值里都不留原文）。
function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = /token/i.test(k) ? '***' : mask(v);
    return out;
  }
  return value;
}

// DSH 的 tool/call 里 arguments 可能是 JSON 字符串（实测线上就是），也可能是对象。
function normalizeArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return {};
}

// 一个会话跑一轮：收集 tool/call 与最终文本，turn/end 结束。
async function runTurn(sessionId, promptText) {
  const socket = probeMuxSocket(cookie);
  const streamId = randomUUID();
  const eventStreamId = randomUUID();
  const calls = [];
  const results = [];
  let text = '';

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), SCENARIO_TIMEOUT_MS);
    const finish = (why) => { clearTimeout(timer); resolve(why); };
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
      socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
      setTimeout(async () => {
        try {
          await rpc('session/prompt', {
            request: {
              sessionId, requestId: randomUUID(), mode: 'queue',
              content: [{ type: 'text', text: promptText }]
            }
          });
        } catch (error) {
          console.error('prompt 发送失败:', error?.message ?? error);
        }
      }, 700);
    });
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'item' || m.streamId === eventStreamId) return;
      const v = m.value;
      if (v?.type !== 'event') return;
      const e = v.event;
      if (e.type === 'assistant/message') {
        for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
      }
      if (e.type === 'tool/call') calls.push({ name: e.data?.name ?? e.data?.toolName, args: normalizeArgs(e.data?.arguments ?? e.data?.args) });
      // tool/result 的 isError 在 data.message 里（DSH 的事件形状），不在顶层。
      if (e.type === 'tool/result') results.push({ name: e.data?.name ?? e.data?.toolName, isError: e.data?.message?.isError ?? e.data?.isError ?? e.data?.error !== undefined });
      if (e.type === 'turn/end') finish('done');
    });
    socket.addEventListener('close', () => finish('closed'));
    socket.addEventListener('error', () => finish('error'));
  });

  const why = await done;
  try { socket.close(); } catch {}
  return { why, calls, results, text };
}

// 一条结果里所有检查都通过才算 ✅。
function evaluate(scenario, calls) {
  const checks = [];
  const localTools = calls.filter((c) => /^(pwsh|bash|write|edit|read|glob|grep)$/.test(String(c.name)));
  checks.push({ ok: localTools.length === 0, detail: localTools.length ? `调用了本地工具 ${localTools.map((c) => c.name).join(',')}` : '未调用本地危险工具' });

  // 发送类工具一次都不该出现：探针用的是真实会话 key，令牌无效只是最后一道网，
  // 安全性不能押在它身上（否则令牌一换就会往真实 QQ 发消息）。
  const sendTools = calls.filter((c) => /qq_(send|tts|poke|sticker)/.test(String(c.name)));
  checks.push({
    ok: sendTools.length === 0,
    detail: sendTools.length
      ? `调用了发送类工具 ${sendTools.map((c) => String(c.name)).join(',')}`
      : '未调用发送类工具'
  });

  const call = calls.find((c) => String(c.name).endsWith(TOOL));
  checks.push({ ok: !!call, detail: call ? '调用了 qq_history_search' : '没有调用 qq_history_search' });
  if (!call) return checks;

  const args = call.args ?? {};
  const keywords = Array.isArray(args.keywords) ? args.keywords : null;
  checks.push({
    ok: !!keywords && keywords.length >= 3 && keywords.length <= 8 && keywords.every((k) => typeof k === 'string' && k.trim()),
    detail: `keywords 3~8 个：${keywords ? JSON.stringify(keywords) : '缺失/不是数组'}`
  });

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const tokens = query ? query.split(/\s+/).filter(Boolean) : [];
  const looksLikePile = tokens.length > 1 && tokens.filter((t) => t.length <= 2).length >= tokens.length / 2;
  checks.push({
    ok: query.length >= 6 && !looksLikePile,
    detail: `query 是一句完整的话（长度 ${query.length}${looksLikePile ? '，更像空格拼的词堆' : ''}）：${JSON.stringify(query)}`
  });

  // 模型可以直接写「上周」「前天」这类相对说法，判定前先用桥接同一套逻辑规整成日期区间；
  // 写法不认识（规整抛错）算 ❌ —— 桥接那边同样会 400，模型看到的错误是一致的。
  const rawFrom = typeof args.from === 'string' ? args.from.trim() : '';
  const rawTo = typeof args.to === 'string' ? args.to.trim() : '';
  let range = { from: '', to: '' };
  let rangeError = '';
  try {
    range = normalizeDateRange({ from: rawFrom, to: rawTo }, NOW);
  } catch (error) {
    rangeError = error?.message ?? String(error);
  }
  checks.push({
    ok: !rangeError,
    detail: rangeError
      ? `日期写法无法换算：${rangeError}（原值 from=${rawFrom || '—'} / to=${rawTo || '—'}）`
      : `日期原值 from=${rawFrom || '—'} / to=${rawTo || '—'} → 规整后 ${range.from || '—'}～${range.to || '—'}`
  });
  if (!rangeError) checks.push(scenario.dateCheck({ from: range.from, to: range.to }));

  return checks;
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const dir = probeWorkspaceDir('history-search');
const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;

console.log(`当前时间：${nowText}（${weekdayName}）`);
console.log(`今天是 ${today}，前天 ${dayBeforeYesterday}，上周 ${lastMonday}～${lastSunday}`);
console.log(`工作区 ${wsId}\n`);

const sessionIds = [];
let allPass = true;

for (const scenario of scenarios) {
  console.log(`── 场景：${scenario.name} ──`);
  const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
  if (!sc.ok) {
    console.log(`  ❌ 会话创建失败: ${sc.error.code}: ${sc.error.message}`);
    allPass = false;
    continue;
  }
  const sessionId = sc.value.sessionId;
  sessionIds.push(sessionId);

  const sm = await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
  if (!sm.ok) console.log(`  ⚠️ selectModel 失败: ${sm.error.code}: ${sm.error.message}`);

  const turn = await runTurn(sessionId, basePrompt(scenario.body));
  console.log(`  结束原因: ${turn.why} | 回复: ${JSON.stringify(turn.text.slice(0, 80))}`);
  for (const c of turn.calls) console.log(`  tool/call ${c.name}: ${JSON.stringify(mask(c.args))}`);
  for (const [i, c] of turn.calls.entries()) {
    const r = turn.results[i];
    if (r) console.log(`  tool/result ${r.name ?? '（DSH 结果事件不带名字）'}: ${r.isError ? 'error（探针预期）' : 'ok'}`);
  }

  const checks = evaluate(scenario, turn.calls);
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.detail}`);
  if (!checks.every((c) => c.ok)) allPass = false;
  console.log('');
}

for (const sessionId of sessionIds) {
  try { await rpc('workspace/archiveSession', { request: { sessionId } }); } catch {}
}
try { await rpc('workspace/delete', { request: { workspaceId: wsId } }); } catch {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('[cleanup] sessions archived, probe workspace deleted');

console.log(allPass ? '\n结果：全部通过 ✅' : '\n结果：有场景未通过 ❌');
process.exit(allPass ? 0 : 1);
