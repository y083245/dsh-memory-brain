// 账本建议 v1 · 桥接集成测试（SUGGEST_PATCH，LEDGER_SUGGEST_SPEC §4）
//
// 用 audit-bridge-harness 在临时目录里跑真实的 bridge.js：不碰 state/、不联网，
// memory-rag 一律指向测试内起的本地假服务（随机端口）或一个没人监听的端口。
//
// 覆盖任务书第 7～13 条：唤醒块与会话隔离 / 块为空时提示词逐字不变 / 只在投递成功后计次 /
// 采用判定且响应不变 / 控制台两个接口 / 模块创建失败时桥接照常 / longMemory=false 不请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const OWNER = '123';
const KEY = `private:${OWNER}`;
const GROUP = 'group:456';
const GROUP_USER = '789';
const HOUR = 3600000;
const DAY = 86400000;
const SUGGEST = '【最近聊到、还没记进长期记忆的】';
const SUGGEST_STATE = 'state/long-memory/suggest-state.json';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
function replyJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}

/** 起一个本地假 memory-rag；没有显式处理的路径回一份形状合法的空结果。 */
async function startRagServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const entry = { method: req.method, path: req.url, body };
      requests.push(entry);
      Promise.resolve(handler(entry, req, res)).catch(() => { try { res.destroy(); } catch {} });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    notesRequests() { return requests.filter((r) => r.path === '/notes'); },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** 按请求里的 key 回候选；其它路径（/recall 等）回形状合法的空结果。 */
function ragHandler(itemsByKey = {}) {
  return (entry, req, res) => {
    const key = String(entry.body?.key ?? '');
    if (entry.path === '/notes') {
      replyJson(res, 200, { key, items: itemsByKey[key] ?? [] });
      return;
    }
    replyJson(res, 200, { key, skipped: null, tau: null, candidates: [], inject: [] });
  };
}

/** 一个没人监听的端口：memory-rag 连接会被立刻拒绝。 */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function call(port, pathname, { method = 'GET', headers = {}, body, token } = {}) {
  const h = { 'content-type': 'application/json', ...CONSOLE, ...headers };
  if (token) h['x-agent-token'] = token;
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: response.statusCode, json, body: data });
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

/** 取最近一次投递给 DSH 的 prompt 全文。 */
function lastPrompt(h) {
  const entry = h.calls.prompts.at(-1);
  return (entry?.content ?? []).map((c) => String(c?.text ?? '')).join('\n');
}

/** 一条账本条目（时间用现在，避免被记忆代谢判成已淡忘而不注入）。 */
const ltmItem = (id, text, { cat = 'fact', sourceKey = KEY, scope = 'public' } = {}) =>
  ({ id, cat, text, at: new Date().toISOString(), sourceKey, scope });

/** 人物账本：主人 123（私聊）与群友 789（群）。 */
function peopleFixture() {
  return {
    'state/long-memory/people.json': JSON.stringify({
      version: 1,
      people: {
        [OWNER]: {
          name: '主人', names: [], firstSeenAt: new Date(Date.now() - 30 * DAY).toISOString(),
          lastSeenAt: new Date().toISOString(), messages: 10,
          items: [ltmItem('aaaaaaaa', '他喜欢喝茶', { cat: 'trait' })]
        },
        [GROUP_USER]: {
          name: '群友', names: [], firstSeenAt: new Date(Date.now() - 30 * DAY).toISOString(),
          lastSeenAt: new Date().toISOString(), messages: 5,
          items: [ltmItem('bbbbbbbb', '他住在城东', { sourceKey: GROUP })]
        }
      }
    })
  };
}

/** 人物账本里人还在、但一条条目都没有（正是最该给她候选的那种人）。 */
function emptyLedgerFixture() {
  return {
    'state/long-memory/people.json': JSON.stringify({
      version: 1,
      people: {
        [OWNER]: {
          name: '主人', names: [], firstSeenAt: new Date(Date.now() - 30 * DAY).toISOString(),
          lastSeenAt: new Date().toISOString(), messages: 10,
          items: []
        }
      }
    })
  };
}

/** 存档目录：控制台「聊天存档」下拉的来源（archiveKeys 只看目录名）。 */
function archiveFixture() {
  const row = JSON.stringify({ t: new Date().toISOString(), dir: 'in', userId: OWNER, name: '主人', text: '在吗', msgId: null });
  return {
    [`state/long-memory/archive/private_${OWNER}/2026-10.jsonl`]: `${row}\n`,
    [`state/long-memory/archive/group_456/2026-10.jsonl`]: `${row}\n`
  };
}

/** 一条契约 §1 形状的候选。 */
function note(over = {}) {
  return {
    note_id: '1111111111111111',
    summary_id: 'S0000000000000001',
    day: '2026-10-30',
    t_end: Date.now() - HOUR,
    who: OWNER,
    who_name: '',
    cat: 'trait',
    text: '他喜欢喝冰美式不加糖',
    due: null,
    importance: 0.7,
    created_at: Date.now() - HOUR,
    source: 'distill',
    ...over
  };
}

const stateFile = (h) => path.join(h.temp, SUGGEST_STATE);
function readSuggestState(h) {
  try { return JSON.parse(fs.readFileSync(stateFile(h), 'utf8')); } catch { return null; }
}

/** 一次私聊唤醒：先落一条来信，再投递。 */
async function privateWake(h, text, msgId = `p-${Math.random()}`) {
  h.setMode('reserved2');
  h.appendSocialV2Message(KEY, '主人', text, text, false, true, msgId, [], OWNER);
  return h.deliverPrompt(KEY, text, { wakeReason: 'private' });
}

/** 一次群唤醒：群友 789 说话。 */
async function groupWake(h, text, msgId = `g-${Math.random()}`) {
  h.setMode('reserved2');
  h.appendSocialV2Message(GROUP, '群友', text, text, false, false, msgId, [], GROUP_USER);
  return h.deliverPrompt(GROUP, text, { wakeReason: 'anyMessage' });
}

/** 冻结时钟的 Date（VM 里注入）：两次投递的提示词才可比。 */
function frozenDate(nowMs) {
  const RealDate = Date;
  return class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  };
}

/** 响应里去掉每次都会变的编号与时间戳，便于跨实例比对。 */
function stableResponse(json) {
  const copy = JSON.parse(JSON.stringify(json));
  if (copy?.item) { copy.item.id = 'ID'; copy.item.at = 'AT'; }
  return copy;
}

// ── ⑦ 唤醒块与会话隔离 ─────────────────────────────────────────────────────
await test('唤醒：私聊提示词在【长期记忆】之后出现私聊候选；群里绝不出现私聊候选（反之亦然）', async () => {
  const candPrivate = note({ note_id: '1111111111111111', text: '他喜欢喝冰美式不加糖' });
  const candGroup = note({ note_id: '2222222222222222', who: GROUP_USER, who_name: '群友', cat: 'fact', text: '他在准备周末的考试', importance: 0.6, created_at: Date.now() - 2 * HOUR });
  const rag = await startRagServer(ragHandler({ [KEY]: [candPrivate], [GROUP]: [candGroup] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: peopleFixture() });
  try {
    const r1 = await privateWake(h, '在吗，今天好累');
    assert.equal(r1.ok, true, '唤醒照常');
    const prompt1 = lastPrompt(h);
    const ltmAt = prompt1.indexOf('【长期记忆 —— 你一直记得的事】');
    const suggestAt = prompt1.indexOf(SUGGEST);
    assert.ok(ltmAt >= 0 && suggestAt > ltmAt, '建议块必须在【长期记忆】之后');
    assert.ok(prompt1.includes('主人（QQ 123）· 喜好习惯(trait)：他喜欢喝冰美式不加糖'), prompt1.slice(suggestAt, suggestAt + 200));
    assert.ok(!prompt1.includes('他在准备周末的考试'), '私聊里不该出现群里的候选');
    assert.ok(prompt1.includes('值得长期记住的就用 qq_ltm_remember 记下'), '要带用法句');

    const r2 = await groupWake(h, '你们周末有空吗');
    assert.equal(r2.ok, true);
    const prompt2 = lastPrompt(h);
    assert.ok(prompt2.includes('【最近聊到、还没记进长期记忆的】'));
    assert.ok(prompt2.includes('群友（QQ 789）· 事实(fact)：他在准备周末的考试'));
    assert.ok(!prompt2.includes('他喜欢喝冰美式不加糖'), '群里不该出现私聊的候选');

    // 两次唤醒的 /notes 请求 key 各是各的。
    const keys = rag.notesRequests().map((r) => r.body.key);
    assert.ok(keys.includes(KEY) && keys.includes(GROUP));
  } finally { await h.close(); await rag.close(); }
});

// ── ⑧ 块为空 / 不可达时提示词逐字不变 ────────────────────────────────────
await test('块为空：假服务返回空 / 没配 memory-rag，两种提示词逐字相同', async () => {
  const now = Date.now();
  const rag = await startRagServer(ragHandler({ [KEY]: [] }));
  const prompts = [];
  try {
    for (const cfg of [{ memoryRag: { url: rag.url } }, { memoryRag: { url: 'http://10.9.9.9:8093' } }]) {
      const h = await bridgeHarness({ config: cfg, files: peopleFixture(), globals: { Date: frozenDate(now) } });
      try {
        await privateWake(h, '在吗在吗', 'fixture-msg-1');
        const prompt = lastPrompt(h);
        assert.ok(!prompt.includes(SUGGEST), '没有候选时不该出现建议块');
        prompts.push(prompt.replace(/【会话令牌】[0-9a-f]{32}/, '【会话令牌】TOKEN'));
      } finally { await h.close(); }
    }
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1], '块为空时提示词必须逐字相同');
  } finally { await rag.close(); }
});

// ── ⑧b 账本还空着的人 ────────────────────────────────────────────────────
// 规格 §4.1 的本意是「长期记忆工具关了才不取」；账本正文空 ≠ 工具关了。
// 以前这里用 ltmBlockFor 的返回值当条件，账本一条都没有的人反而永远拿不到候选。
await test('账本一条都没有：私聊唤醒照样请求 /notes，建议块在【长期记忆】之后（该段显示「（还没有记下什么）」）', async () => {
  const cand = note({ note_id: '1111111111111111', text: '他喜欢喝冰美式不加糖' });
  const rag = await startRagServer(ragHandler({ [KEY]: [cand] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: emptyLedgerFixture() });
  try {
    const r = await privateWake(h, '在吗，今天好累');
    assert.equal(r.ok, true, '唤醒照常');
    assert.equal(rag.notesRequests().length, 1, '账本空着也要请求 /notes');
    assert.equal(rag.notesRequests()[0].body.key, KEY, '问的是当前会话');
    const prompt = lastPrompt(h);
    const ltmAt = prompt.indexOf('【长期记忆 —— 你一直记得的事】');
    const emptyAt = prompt.indexOf('（还没有记下什么）');
    const suggestAt = prompt.indexOf(SUGGEST);
    assert.ok(ltmAt >= 0, '长期记忆段照常出现');
    assert.ok(emptyAt > ltmAt, '账本空时该段显示「（还没有记下什么）」');
    assert.ok(suggestAt > emptyAt, '建议块必须在【长期记忆】段之后');
    assert.ok(prompt.includes('他喜欢喝冰美式不加糖'), '候选原文要进块');
    assert.ok(prompt.includes('值得长期记住的就用 qq_ltm_remember 记下'), '要带用法句');
    // 投递成功后照常计次。
    assert.equal(readSuggestState(h).items[cand.note_id].shown, 1);
  } finally { await h.close(); await rag.close(); }
});

// ── ⑨ 计次 ────────────────────────────────────────────────────────────────
await test('计次：投递被 DSH 拒绝不计；成功后 +1；第二次出现后第三次唤醒不再出现', async () => {
  const cand = note({ note_id: '1111111111111111' });
  const rag = await startRagServer(ragHandler({ [KEY]: [cand] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: peopleFixture() });
  try {
    // 第一次投递：假 DSH 拒绝 → 不计次（状态文件都还不该写出来）。
    const original = h.api.sessions.prompt;
    let rejectOnce = true;
    h.api.sessions.prompt = async (params) => {
      if (rejectOnce) {
        rejectOnce = false;
        return { result: { ok: false, error: { code: 'fixture-rejected', message: '拒绝了' } } };
      }
      return original(params);
    };
    const rejected = await privateWake(h, '第一次');
    assert.equal(rejected.ok, false, '被拒绝的投递返回 ok:false');
    assert.equal(fs.existsSync(stateFile(h)), false, '投递失败不计次（不写状态文件）');

    const r2 = await privateWake(h, '第二次');
    assert.equal(r2.ok, true);
    assert.equal(readSuggestState(h).items[cand.note_id].shown, 1, '接受后 +1');

    const r3 = await privateWake(h, '第三次');
    assert.equal(r3.ok, true);
    assert.equal(readSuggestState(h).items[cand.note_id].shown, 2, '第二次再 +1');
    assert.ok(lastPrompt(h).includes(SUGGEST), '第二次出现时还应该给她看');

    const r4 = await privateWake(h, '第四次');
    assert.equal(r4.ok, true);
    assert.ok(!lastPrompt(h).includes(SUGGEST), '出现满 2 次后不再出现');
    assert.equal(readSuggestState(h).items[cand.note_id].status, 'expired');
  } finally { await h.close(); await rag.close(); }
});

// ── ⑩ 采用 ────────────────────────────────────────────────────────────────
await test('采用：她记下相似内容 → adopted；ltm-remember 的响应与没有本模块时一致', async () => {
  const cand = note({ note_id: '1111111111111111', cat: 'trait', text: '他喜欢喝冰美式不加糖' });
  const rag = await startRagServer(ragHandler({ [KEY]: [cand] }));
  const rememberBody = { key: KEY, category: 'trait', content: '他喜欢喝冰美式，不加糖' };
  let withModule = null;
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: peopleFixture() });
  try {
    await privateWake(h, '在吗');
    assert.ok(lastPrompt(h).includes(SUGGEST), '先真的给她看过');
    await withServer(h, async (port) => {
      const r = await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: rememberBody });
      assert.equal(r.status, 200, r.body);
      withModule = stableResponse(r.json);
      assert.deepEqual(Object.keys(r.json).sort(), ['duplicate', 'item', 'ok'], '响应不许加新字段');
      assert.equal(r.json.ok, true);
    });
    assert.equal(readSuggestState(h).items[cand.note_id].status, 'adopted', '应标成采用');
    assert.ok(Number.isFinite(readSuggestState(h).items[cand.note_id].statusAt));
  } finally { await h.close(); }

  // 没有本模块（构造时抛异常 → ledgerSuggest=null）时，同样的记账响应必须一样。
  const noModule = await bridgeHarness({
    files: peopleFixture(),
    globals: { createLedgerSuggest: () => { throw new Error('fixture: 模块禁用'); } }
  });
  try {
    assert.equal(noModule.getLedgerSuggest(), null);
    await withServer(noModule, async (port) => {
      const r = await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: rememberBody });
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(stableResponse(r.json), withModule, 'ltm-remember 的响应必须逐字（去掉随机编号）相同');
    });
  } finally { await noModule.close(); await rag.close(); }
});

// ── ⑪ 控制台接口 ───────────────────────────────────────────────────────────
await test('控制台 /api/ltm/suggest：字段与 contract §2 一致；agent 令牌 403；days 校验 400', async () => {
  const candPrivate = note({ note_id: '1111111111111111', created_at: Date.now() - HOUR });
  const candGroup = note({ note_id: '2222222222222222', who: GROUP_USER, who_name: '群友', cat: 'fact', text: '他在准备周末的考试', created_at: Date.now() - 2 * HOUR });
  const rag = await startRagServer(ragHandler({ [KEY]: [candPrivate], [GROUP]: [candGroup] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: { ...peopleFixture(), ...archiveFixture() } });
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/ltm/suggest?days=7');
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.mode, 'on');
      assert.equal(r.json.rag, true);
      assert.deepEqual(r.json.counts, { created: 2, open: 2, adopted: 0, duplicate: 0, expired: 0, dismissed: 0 });
      // 会话顺序按 key 排序（readdir 的顺序因文件系统而异）。
      assert.deepEqual(r.json.keys, [
        { key: GROUP, label: '群 456' },
        { key: KEY, label: '主人（私聊）' }
      ]);
      assert.equal(r.json.items.length, 2);
      const first = r.json.items[0];
      assert.equal(first.id, candPrivate.note_id);
      for (const field of ['id', 'key', 'day', 'createdAt', 'source', 'who', 'whoName', 'cat', 'text', 'due', 'importance', 'shown', 'status', 'statusAt']) {
        assert.ok(Object.hasOwn(first, field), `item 缺字段 ${field}`);
      }
      assert.equal(first.whoName, '主人', '账本里有名字就用账本的名字');
      assert.equal(first.shown, 0);
      assert.equal(first.status, 'open');
      assert.equal(first.statusAt, null);
      assert.equal(r.json.items[1].whoName, '群友');

      // days 校验。
      for (const days of ['0', '31', 'x', '1.5']) {
        const bad = await call(port, `/api/ltm/suggest?days=${days}`);
        assert.equal(bad.status, 400, `days=${days} 应回 400`);
      }
      // agent 令牌一律拒绝。
      for (const opts of [{ method: 'GET' }, { method: 'POST', body: { id: '1111111111111111', key: KEY } }]) {
        const denied = await call(port, opts.method === 'GET' ? '/api/ltm/suggest' : '/api/ltm/suggest/dismiss', { ...opts, token: 'whatever' });
        assert.equal(denied.status, 403, 'agent 令牌应 403');
      }
    });
  } finally { await h.close(); await rag.close(); }
});

await test('控制台 /api/ltm/suggest/dismiss：404 / 409 / 200；memory-rag 不可达 503；rag:false 的计数口径', async () => {
  const candPrivate = note({ note_id: '1111111111111111', text: '他喜欢喝冰美式不加糖' });
  const candGroup = note({ note_id: '2222222222222222', who: GROUP_USER, who_name: '群友', cat: 'fact', text: '他在准备周末的考试' });
  const rag = await startRagServer(ragHandler({ [KEY]: [candPrivate], [GROUP]: [candGroup] }));
  const h = await bridgeHarness({ config: { memoryRag: { url: rag.url } }, files: { ...peopleFixture(), ...archiveFixture() } });
  try {
    // 先让她看过私聊候选，并记下相似内容 → adopted。
    await privateWake(h, '在吗');
    await withServer(h, async (port) => {
      await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: { key: KEY, category: 'trait', content: '他喜欢喝冰美式，不加糖' } });
      assert.equal(readSuggestState(h).items[candPrivate.note_id].status, 'adopted');

      const missing = await call(port, '/api/ltm/suggest/dismiss', { method: 'POST', body: { id: '9999999999999999', key: KEY } });
      assert.equal(missing.status, 404, missing.body);
      assert.equal(missing.json.ok, false);

      const adopted = await call(port, '/api/ltm/suggest/dismiss', { method: 'POST', body: { id: candPrivate.note_id, key: KEY } });
      assert.equal(adopted.status, 409, adopted.body);
      assert.equal(adopted.json.ok, false);

      const badKey = await call(port, '/api/ltm/suggest/dismiss', { method: 'POST', body: { id: candPrivate.note_id, key: 'nonsense' } });
      assert.equal(badKey.status, 404, 'key 不合法当作找不到');

      const ok = await call(port, '/api/ltm/suggest/dismiss', { method: 'POST', body: { id: candGroup.note_id, key: GROUP } });
      assert.equal(ok.status, 200, ok.body);
      assert.deepEqual(ok.json, { ok: true, id: candGroup.note_id, status: 'dismissed' });
      const st = readSuggestState(h).items[candGroup.note_id];
      assert.equal(st.status, 'dismissed');
      assert.ok(Number.isFinite(st.statusAt));

      // 计数跟着状态走。
      const list = await call(port, '/api/ltm/suggest?days=7');
      assert.deepEqual(list.json.counts, { created: 2, open: 0, adopted: 1, duplicate: 0, expired: 0, dismissed: 1 });
    });
  } finally { await h.close(); await rag.close(); }

  // memory-rag 不可达：列表 rag:false、计数按状态文件；作废 503。
  const port = await freePort();
  const now = Date.now();
  const primed = {
    version: 1,
    items: {
      '4444444444444444': { key: KEY, who: OWNER, cat: 'fact', shown: 1, status: 'adopted', firstSeenAt: now - 2 * DAY, lastShownAt: now - DAY, statusAt: now - DAY },
      '5555555555555555': { key: KEY, who: OWNER, cat: 'fact', shown: 0, status: 'open', firstSeenAt: now - DAY, lastShownAt: null, statusAt: null },
      '6666666666666666': { key: KEY, who: OWNER, cat: 'fact', shown: 2, status: 'expired', firstSeenAt: now - 10 * DAY, lastShownAt: now - 9 * DAY, statusAt: now - 9 * DAY }
    }
  };
  const dead = await bridgeHarness({
    config: { memoryRag: { url: `http://127.0.0.1:${port}`, timeoutMs: 300 } },
    files: { ...peopleFixture(), ...archiveFixture(), [SUGGEST_STATE]: primed }
  });
  try {
    await withServer(dead, async (portNum) => {
      const r = await call(portNum, '/api/ltm/suggest?days=7');
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.rag, false);
      assert.deepEqual(r.json.items, []);
      // created 拿不到；其余按状态文件里 firstSeenAt 在窗口内的条目分组（10 天前那条不算）。
      assert.deepEqual(r.json.counts, { created: null, open: 1, adopted: 1, duplicate: 0, expired: 0, dismissed: 0 });
      assert.deepEqual(r.json.keys, [{ key: GROUP, label: '群 456' }, { key: KEY, label: '主人（私聊）' }]);

      const d = await call(portNum, '/api/ltm/suggest/dismiss', { method: 'POST', body: { id: '5555555555555555', key: KEY } });
      assert.equal(d.status, 503, d.body);
    });
  } finally { await dead.close(); }

  // 完全没配 memory-rag（地址不是回环 → 客户端拒绝创建）：mode=off、rag:false。
  const noRag = await bridgeHarness({
    // 地址不是回环 → 客户端拒绝创建（这才是「没配 memory-rag」的样子）。
    config: { memoryRag: { url: 'http://10.9.9.9:8093' } },
    files: { ...peopleFixture(), ...archiveFixture(), [SUGGEST_STATE]: primed }
  });
  try {
    await withServer(noRag, async (portNum) => {
      const r = await call(portNum, '/api/ltm/suggest');
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.mode, 'off');
      assert.equal(r.json.rag, false);
      assert.equal(r.json.counts.created, null);
      assert.equal(r.json.counts.open, 1);
      assert.equal(r.json.counts.adopted, 1);
      assert.equal(r.json.counts.expired, 0);
    });
  } finally { await noRag.close(); }
});

// ── ⑫ 模块创建失败 ─────────────────────────────────────────────────────────
await test('createLedgerSuggest 构造时抛异常 → 桥接照常启动、唤醒照常、两个接口 503', async () => {
  const h = await bridgeHarness({
    files: peopleFixture(),
    globals: { createLedgerSuggest: () => { throw new Error('fixture: 构造失败'); } }
  });
  try {
    assert.equal(h.getLedgerSuggest(), null);
    const r = await privateWake(h, '在吗在吗');
    assert.equal(r.ok, true, '唤醒照常');
    assert.ok(lastPrompt(h).includes('在吗在吗'));
    assert.ok(lastPrompt(h).includes('【长期记忆 —— 你一直记得的事】'), '长期记忆块照常');
    assert.ok(!lastPrompt(h).includes(SUGGEST));

    await withServer(h, async (port) => {
      const list = await call(port, '/api/ltm/suggest');
      assert.equal(list.status, 503, list.body);
      const dismiss = await call(port, '/api/ltm/suggest/dismiss', { method: 'POST', body: { id: '1111111111111111', key: KEY } });
      assert.equal(dismiss.status, 503, dismiss.body);
    });
  } finally { await h.close(); }
});

// ── ⑬ longMemory=false ────────────────────────────────────────────────────
await test('工具开关 longMemory=false → 不请求 /notes，提示词里没有建议块', async () => {
  const rag = await startRagServer(ragHandler({ [KEY]: [note()] }));
  const h = await bridgeHarness({
    config: { memoryRag: { url: rag.url }, socialV2: { tools: { longMemory: false } } },
    files: peopleFixture()
  });
  try {
    const r = await privateWake(h, '在吗');
    assert.equal(r.ok, true);
    const prompt = lastPrompt(h);
    assert.ok(!prompt.includes('【长期记忆'), '工具关了就没有长期记忆段');
    assert.ok(!prompt.includes(SUGGEST));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(rag.notesRequests().length, 0, '不该请求 /notes');
  } finally { await h.close(); await rag.close(); }
});

if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
