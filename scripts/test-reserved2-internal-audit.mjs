// R2_AUDIT_PATCH：reserved2（二代仿真）的回合结尾文字只是「内部小结」，本来就发不出去，
// 不该被出站审计当成「回复被拦截」，更不该因此往 QQ 发拦截提示（2026-10-30 线上误报）。
// 这里用 bridgeHarness 起真实桥接代码，再把 DSH 事件流灌进去，跑真正的 pumpMux 回合结束分支。
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`❌ ${name}`);
    console.error(error?.stack ?? error);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, { timeoutMs = 2000, label = '条件' } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待${label}超时`);
    await tick(20);
  }
}

/**
 * 起一个「能真的跑回合结束分支」的桥接实例。
 * mode：'reserved2' 或 'reserved'（仿真群友）。key 固定用白名单里的 private:123。
 */
async function createDriver({ mode, config = {} }) {
  const h = await bridgeHarness({ config, savedState: { sessions: {} } });
  const queue = [];
  let wake = null;
  h.api.events.mux = async function* (_options, signal) {
    const stop = () => wake?.();
    signal.addEventListener('abort', stop, { once: true });
    try {
      while (!signal.aborted) {
        if (queue.length === 0) await new Promise((resolve) => { wake = resolve; });
        while (queue.length && !signal.aborted) yield { payload: queue.shift() };
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
  };
  h.setMode(mode);

  const key = 'private:123';
  const sessionId = `fixture-${mode}`;
  h.state.sessions[key] = sessionId;
  h.state.sessionPolicies[key] = h.sessionPolicy(key);
  h.reverse.set(sessionId, key);

  const pump = h.pumpMux();

  const push = (payload) => {
    queue.push(payload);
    if (wake) { const resolve = wake; wake = null; resolve(); }
  };
  const pushEvent = (event) => push({ type: 'session/event', sessionId, event });

  return {
    h,
    handle: h,
    key,
    sessionId,
    pushEvent,
    logFile: path.join(h.temp, 'state/bridge.log'),
    readLog() {
      try { return fs.readFileSync(this.logFile, 'utf8'); } catch { return ''; }
    },
    sent: () => h.calls.sent,
    /** 造一轮完整回合：turn/start → assistant/message(text) → turn/end(completed)。 */
    async runTurn(text, turn = 1) {
      pushEvent({ type: 'turn/start', data: { turn } });
      pushEvent({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
      pushEvent({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
      // 回合结束处理可能 await 发送；用「日志里出现本轮标记」或「发送记录」做同步点。
      await waitFor(() => this.readLog().includes('AI 内部输出') || this.sent().length > 0, { label: '回合结束' });
      await tick(100); // 给可能的二次动作（拦截提示发送）留出时间
    },
    async close() { await h.shutdownBridge(); await pump; await h.close(); },
  };
}

const SECRET_PATH = '/home/user/qq-bridge/state/diary/2026-10-30.md';
const FAKE_TOKEN = 'fixture-agent-token-4b1d2c3e5f60718293a4b5c6d7e8f901';

// ── 1. reserved2：含本机路径的内部小结 → 不发送任何东西，日志不留原文 ─────────
await test('1. reserved2 含路径的内部小结：不发送、不误报、日志不留原文', async () => {
  const d = await createDriver({ mode: 'reserved2', config: { security: { interceptNotify: true } } });
  try {
    await d.runTurn(`今天把日记写好了，存在 ${SECRET_PATH} 里。`);
    const sent = d.sent();
    assert(sent.length === 0, `reserved2 内部输出不得发到 QQ（实际发了 ${JSON.stringify(sent)}）`);
    const log = d.readLog();
    assert(log.includes('含疑似敏感信息，不记原文'), '日志应标记「含疑似敏感信息，不记原文」');
    assert(!log.includes(SECRET_PATH), '日志里不得出现本机路径原文');
  } finally { await d.close(); }
});

// ── 2. reserved2：普通内部小结 → 不发送，日志照旧带前 80 字 ───────────────────
await test('2. reserved2 普通内部小结：不发送，日志照旧带前 80 字', async () => {
  const d = await createDriver({ mode: 'reserved2' });
  try {
    const text = '今天把日记写完了，心情不错，晚点再想想要做什么。';
    await d.runTurn(text);
    assert(d.sent().length === 0, 'reserved2 普通内部输出不得发到 QQ');
    const log = d.readLog();
    assert(log.includes(`[reserved2] AI 内部输出（不自动转发）(${d.key}): ${text.slice(0, 80)}`),
      '日志应照旧记录内部小结的前 80 字');
    assert(!log.includes('含疑似敏感信息'), '普通小结不该走「不记原文」分支');
  } finally { await d.close(); }
});

// ── 3. reserved2：内部小结里带已知会话令牌 → 不发送，日志无令牌 ───────────────
await test('3. reserved2 含已知会话令牌：不发送、日志无令牌', async () => {
  const d = await createDriver({ mode: 'reserved2' });
  try {
    d.handle.KNOWN_AGENT_TOKENS.add(FAKE_TOKEN);
    await d.runTurn(`这轮的 token 是 ${FAKE_TOKEN}，别写进日记。`);
    assert(d.sent().length === 0, 'reserved2 内部输出不得发到 QQ');
    const log = d.readLog();
    assert(log.includes('含疑似敏感信息，不记原文'), '日志应标记「含疑似敏感信息，不记原文」');
    assert(!log.includes(FAKE_TOKEN), '日志里不得出现会话令牌原文');
  } finally { await d.close(); }
});

// ── 4. 仿真群友模式（reserved，会真发）→ 仍被拦截，仍发拦截提示 ──────────────
await test('4. 仿真群友模式的发送路径：含路径的回复仍被拦截并提示', async () => {
  const d = await createDriver({ mode: 'reserved', config: { social: { enabled: true }, security: { interceptNotify: true } } });
  try {
    await d.runTurn(`这条是要发出去的回复，里面误带了 ${SECRET_PATH}。`);
    const sent = d.sent();
    assert(sent.length === 1, `应只发一条拦截提示（实际 ${sent.length} 条）`);
    assert(sent[0].text.includes('被安全策略拦截'), '拦截提示内容应保持原样');
    const log = d.readLog();
    assert(log.includes('⚠️ 回复被安全策略拦截'), '日志仍应记录拦截');
  } finally { await d.close(); }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
process.exit(0);
