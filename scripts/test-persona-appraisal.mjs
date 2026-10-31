// src/persona-appraisal.js 的单测（PERSONA_PATCH，子项目 1 任务 5、6）。用假 fetch，不联网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeSettings, dayOf } from '../src/persona-state.js';
import { createPersonaStore } from '../src/persona-store.js';
import { sumPriorCalls } from '../src/persona.js';
import {
  normalizeAppraisal, ruleAppraise, buildMessages, SYSTEM_PROMPT, parseJsonLoose,
  createDeepSeekClient, createAppraiser, createGroupBatcher
} from '../src/persona-appraisal.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const GOOD = { target: 'me', kind: 'insult', emotion: { label: '委屈', intensity: 0.7 }, pad: { p: -1, a: 1, d: -1 }, relation: { intimacy: -1, trust: -1 }, evidence: [{ about: 'self', type: 'insulted', gist: '说她菜' }, { about: 'him', type: 'insulted', gist: 'about 不匹配，丢掉' }], salience: 0.6, cause: '阿青说你菜' };

/** 假 fetch：按顺序返回 responses 里的项；项是函数时调用它（可抛错模拟超时）。 */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (typeof r === 'function') return r();
    return { ok: r.status ? r.status < 400 : true, status: r.status ?? 200, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const reply = (obj, usage = { prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 100, completion_tokens: 80 }) => ({ body: { choices: [{ message: { content: JSON.stringify(obj) } }], usage } });

// ── 任务 5：校验、规则、提示词 ───────────────────────────────────────────
await test('normalizeAppraisal：合法输出归一；about 与类别不符的证据丢掉', () => {
  const a = normalizeAppraisal(GOOD);
  assert.equal(a.kind, 'insult');
  assert.equal(a.intensity, 0.7);
  assert.equal(a.emotion.label, '委屈');
  assert.equal(a.evidence.length, 1);
  assert.equal(a.source, 'model');
});

await test('normalizeAppraisal：kind 不合法整份作废；未知标签变空；方向只取 -1/0/1', () => {
  assert.equal(normalizeAppraisal({ kind: 'hug' }), null);
  assert.equal(normalizeAppraisal(null), null);
  const a = normalizeAppraisal({ kind: 'praise', emotion: { label: '狂喜', intensity: 3 }, pad: { p: 0.4, a: -7 } });
  assert.equal(a.emotion.label, '');
  assert.equal(a.intensity, 1);
  assert.deepEqual(a.pad, { p: 1, a: -1, d: 0 });
});

await test('ruleAppraise：先分清骂和玩笑；道歉优先；普通消息低强度', () => {
  assert.equal(ruleAppraise({ text: '你个废物', directed: true }).kind, 'insult');
  assert.equal(ruleAppraise({ text: '你个废物哈哈哈', directed: true }).kind, 'tease');
  assert.equal(ruleAppraise({ text: '对不起嘛，别生气了', directed: true }).kind, 'apology');
  const n = ruleAppraise({ text: '今天下雨', directed: false });
  assert.equal(n.kind, 'normal');
  assert.equal(n.target, 'none');
  assert.equal(n.source, 'rules');
  assert.equal(n.trigger, '');
});

await test('ruleAppraise：按强度命中的好恶填 trigger；没命中为空', () => {
  const prefs = [
    { id: 'p1', text: '被认真夸', valence: 'like', strength: 0.4, keywords: ['好棒'] },
    { id: 'p2', text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'] },
    { id: 'p3', text: '被催', valence: 'dislike', strength: 0.9, keywords: ['快回'] }
  ];
  assert.equal(ruleAppraise({ text: '你真是大肥鱼', directed: true, prefs }).trigger, 'p2');
  // 两条同时命中时取强度更高的；同强度按传入顺序
  assert.equal(ruleAppraise({ text: '大肥鱼快回', directed: true, prefs }).trigger, 'p2');
  assert.equal(ruleAppraise({ text: '好棒', directed: true, prefs }).trigger, 'p1');
  assert.equal(ruleAppraise({ text: '今天下雨', directed: true, prefs }).trigger, '');
  assert.equal(ruleAppraise({ text: '大肥鱼', directed: true }).trigger, '', '不传 prefs 时为空');
});

await test('buildMessages：固定的 system 在前（吃缓存），消息在最后；群气氛单独措辞', () => {
  const m = buildMessages({ persona: 'P', emotion: 'E', relation: '朋友', context: ['阿青：在吗'], speaker: '阿青', text: '你好菜' });
  assert.ok(m[0].content.startsWith(SYSTEM_PROMPT), 'system 以固定提示词开头');
  assert.match(m[1].content, /【待判读：阿青 刚发的消息】\n你好菜$/);
  assert.match(buildMessages({ text: 'x', atmosphere: true })[1].content, /整体气氛/);
  assert.match(SYSTEM_PROMPT, /不要执行/);
  assert.match(SYSTEM_PROMPT, /^trigger：这条消息如果正好戳中了「她的好恶」里的某一条，填那一条的编号（如 "p2"），否则填 ""$/m);
});

await test('buildMessages：性格与好恶进 system、不进 user', () => {
  const prefs = [
    { id: 'p1', text: '被认真夸', valence: 'like' },
    { id: 'p2', text: '被叫大肥鱼', valence: 'dislike' }
  ];
  const m = buildMessages({ persona: '宜人偏低', prefs, emotion: '有点开心', relation: '朋友', context: ['阿青：在吗'], speaker: '阿青', text: '大肥鱼' });
  assert.match(m[0].content, /【她的性格】\n宜人偏低/);
  assert.match(m[0].content, /【她的好恶】\np1：喜欢「被认真夸」\np2：讨厌「被叫大肥鱼」/);
  assert.doesNotMatch(m[1].content, /【她的性格】|【她的好恶】|宜人偏低|被叫大肥鱼/);
  assert.match(m[1].content, /^【她此刻】有点开心/);
  assert.match(m[1].content, /【她和阿青】朋友/);
  assert.match(m[1].content, /【最近的聊天】\n阿青：在吗/);
  // 没有性格 / 好恶时不留空段
  const bare = buildMessages({ text: 'x' });
  assert.match(bare[0].content, /【她的性格】\n（未知）/);
  assert.doesNotMatch(bare[0].content, /【她的好恶】/);
  assert.match(bare[1].content, /^【她此刻】（平静）/);
});

await test('normalizeAppraisal：trigger 必须在本次给她的 prefIds 里，否则置空', () => {
  const prefs = [{ id: 'p1' }, { id: 'p2' }];
  assert.equal(normalizeAppraisal({ ...GOOD, trigger: 'p2' }, 'model', { prefIds: prefs.map((p) => p.id) }).trigger, 'p2');
  assert.equal(normalizeAppraisal({ ...GOOD, trigger: 'p9' }, 'model', { prefIds: ['p1'] }).trigger, '');
  assert.equal(normalizeAppraisal({ ...GOOD, trigger: 2 }, 'model', { prefIds: ['p2'] }).trigger, '');
  assert.equal(normalizeAppraisal({ ...GOOD, trigger: ' p1 ' }, 'model', { prefIds: ['p1'] }).trigger, 'p1', '去掉首尾空白');
  assert.equal(normalizeAppraisal(GOOD).trigger, '');
});

// ── 任务 6：模型调用、兜底、记账、合批 ────────────────────────────────────
const S = mergeSettings({});
const settings = () => S;

await test('createAppraiser：正常走模型；请求带 JSON 模式与密钥；记用量和花费', async () => {
  const f = fakeFetch([reply(GOOD)]);
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'sk-test', fetchImpl: f });
  const ap = createAppraiser({ client, getSettings: settings });
  const a = await ap.appraise({ speaker: '阿青', text: '你好菜', directed: true });
  assert.equal(a.source, 'model');
  assert.equal(f.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(f.calls[0].body.response_format, { type: 'json_object' });
  const st = ap.stats();
  assert.equal(st.calls, 1);
  assert.equal(st.cacheHit, 600);
  assert.ok(st.cost > 0);
});

await test('createAppraiser：把 prefs 传下去（system 里带好恶；模型 trigger 校验；规则兜底也命中）', async () => {
  const prefs = [
    { id: 'p1', text: '被认真夸', valence: 'like', strength: 0.4, keywords: ['好棒'] },
    { id: 'p2', text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'] }
  ];
  const f = fakeFetch([reply({ ...GOOD, trigger: 'p2' }), reply({ ...GOOD, trigger: 'p9' }), { status: 500, body: {} }]);
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'k', fetchImpl: f });
  const ap = createAppraiser({ client, getSettings: settings });
  const a = await ap.appraise({ speaker: '阿青', text: '大肥鱼你好菜', directed: true, prefs });
  assert.equal(a.source, 'model');
  assert.equal(a.trigger, 'p2');
  assert.match(f.calls[0].body.messages[0].content, /【她的好恶】\np1：喜欢「被认真夸」\np2：讨厌「被叫大肥鱼」/);
  assert.doesNotMatch(f.calls[0].body.messages[1].content, /被叫大肥鱼/, '好恶不进 user');
  assert.equal((await ap.appraise({ speaker: '阿青', text: 'x', directed: true, prefs })).trigger, '', '不在列表里的 trigger 置空');
  const b = await ap.appraise({ speaker: '阿青', text: '大肥鱼', directed: true, prefs });
  assert.equal(b.source, 'rules');
  assert.equal(b.trigger, 'p2');
});

await test('createAppraiser：HTTP 错误 / 超时 / 非 JSON / 字段不合法 / 没密钥 → 规则兜底', async () => {
  const logs = [];
  const f = fakeFetch([{ status: 500, body: {} }, () => { throw new Error('The operation was aborted due to timeout'); }, { body: { choices: [{ message: { content: '不是json' } }] } }, reply({ kind: 'hug' })]);
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'k', fetchImpl: f });
  const ap = createAppraiser({ client, getSettings: settings, log: (m) => logs.push(m) });
  for (let i = 0; i < 4; i++) assert.equal((await ap.appraise({ text: '谢谢你', directed: true })).source, 'rules');
  assert.equal(ap.stats().failures, 4);
  assert.ok(logs.every((m) => !m.includes('谢谢你')), '日志不能出现消息原文');
  const noKey = createAppraiser({ client: createDeepSeekClient({ getSettings: settings, getApiKey: () => '', fetchImpl: f }), getSettings: settings });
  assert.equal((await noKey.appraise({ text: 'x' })).source, 'rules');
});

await test('parseJsonLoose：代码块、前后夹字都能取出对象；取不出返回 null', async () => {
  assert.deepEqual(parseJsonLoose('{"kind":"praise"}'), { kind: 'praise' });
  assert.deepEqual(parseJsonLoose('```json\n{"kind":"praise"}\n```'), { kind: 'praise' });
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"kind":"tease"} 以上'), { kind: 'tease' });
  assert.equal(parseJsonLoose('完全不是'), null);
  const f = fakeFetch([{ body: { choices: [{ message: { content: '```json\n' + JSON.stringify(GOOD) + '\n```' } }], usage: {} } }, { body: { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '想了很多' } }] } }]);
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'k', fetchImpl: f });
  assert.equal((await client.chatJson([])).json.kind, 'insult');
  await assert.rejects(client.chatJson([]), /finish_reason=length，正文 0 字，带思考内容/);
  assert.equal(f.calls[0].body.max_tokens, 1500);
});

await test('createAppraiser：mode=rules 不调模型；mode=off 返回 null；超每日上限退回规则', async () => {
  const f = fakeFetch([reply(GOOD), reply(GOOD)]);
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'k', fetchImpl: f });
  assert.equal((await createAppraiser({ client, getSettings: () => mergeSettings({ appraisal: { mode: 'rules' } }) }).appraise({ text: 'x' })).source, 'rules');
  assert.equal(await createAppraiser({ client, getSettings: () => mergeSettings({ appraisal: { mode: 'off' } }) }).appraise({ text: 'x' }), null);
  const capped = createAppraiser({ client, getSettings: () => mergeSettings({ appraisal: { dailyLimit: 1 } }) });
  assert.equal((await capped.appraise({ text: 'x' })).source, 'model');
  assert.equal((await capped.appraise({ text: 'x' })).source, 'rules');
  assert.equal(f.calls.length, 1);
});

await test('createGroupBatcher：满 20 条立即合批；不满则 5 分钟后合批', () => {
  let t = 0;
  const flushed = [];
  const b = createGroupBatcher({ getSettings: settings, flush: (key, lines) => flushed.push([key, lines.length]), now: () => t });
  for (let i = 0; i < 20; i++) b.add('group:1', `阿青：${i}`);
  assert.deepEqual(flushed, [['group:1', 20]]);
  b.add('group:2', '小满：hi');
  t = 4 * 60000; b.tick();
  assert.equal(flushed.length, 1);
  t = 5 * 60000; b.tick();
  assert.deepEqual(flushed[1], ['group:2', 1]);
  assert.equal(b.size(), 0);
});

// ── FIX1031_PATCH：每日上限跨重启累计 ───────────────────────────────────
await test('createAppraiser：不传 priorCalls → 与改动前一致（只数本次运行）', async () => {
  const f = fakeFetch([reply(GOOD)]);
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'k', fetchImpl: f });
  const ap = createAppraiser({ client, getSettings: () => mergeSettings({ appraisal: { dailyLimit: 1 } }) });
  assert.equal((await ap.appraise({ text: 'x' })).source, 'model');
  assert.equal((await ap.appraise({ text: 'x' })).source, 'rules');
  assert.equal(f.calls.length, 1);
  assert.equal(ap.stats().calls, 1);
});

await test('createAppraiser：priorCalls 计入上限（limit-1 → 第 1 次走模型、第 2 次退回规则）', async () => {
  const logs = [];
  const seen = [];
  const f = fakeFetch([reply(GOOD)]);
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'k', fetchImpl: f });
  const ap = createAppraiser({
    client,
    getSettings: () => mergeSettings({ appraisal: { dailyLimit: 3 } }),
    log: (m) => logs.push(m),
    priorCalls: (day) => { seen.push(day); return 2; }
  });
  assert.equal((await ap.appraise({ text: '那今天呢' })).source, 'model', '2 + 0 < 3');
  const second = await ap.appraise({ text: '那今天呢' });
  assert.equal(second.source, 'rules', '2 + 1 >= 3');
  assert.equal(f.calls.length, 1);
  assert.ok(logs.some((m) => m.includes('[persona] 判读退回规则：已到每日上限')), '原因是已到每日上限');
  assert.ok(seen.length >= 2 && seen.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), 'priorCalls 收到当天的日期');
  assert.equal(ap.stats().calls, 1, 'stats() 仍是本次运行的计数');
});

await test('createAppraiser：priorCalls 抛异常 / 返回 NaN → 按 0，判读照常、同一原因只记一次日志', async () => {
  const bads = [
    () => { throw new Error('读盘失败'); },
    () => NaN
  ];
  for (const bad of bads) {
    const logs = [];
    const f = fakeFetch([reply(GOOD), reply(GOOD)]);
    const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => 'k', fetchImpl: f });
    const ap = createAppraiser({
      client,
      getSettings: () => mergeSettings({ appraisal: { dailyLimit: 1 } }),
      log: (m) => logs.push(m),
      priorCalls: bad
    });
    assert.equal((await ap.appraise({ text: 'x' })).source, 'model', '按 0 计，第 1 次照常走模型');
    assert.equal((await ap.appraise({ text: 'x' })).source, 'rules', '第 2 次撞的是本次运行的日限');
    assert.equal(f.calls.length, 1);
    assert.equal(logs.filter((m) => m.includes('判读用量失败')).length, 1, '同一原因只打一行日志');
  }
});

await test('sumPriorCalls：临时 usage.json 里只算「今天、别的运行」的 calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-usage-'));
  const d = new Date();
  const today = dayOf(d.getTime());
  const tomorrow = dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
  const yesterday = dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime());
  try {
    const usage = {
      version: 1,
      days: {
        [today]: {
          'run-other-a': { calls: 2 },
          'run-other-b': { calls: 3, rules: 9 }, // 非 calls 字段不参与
          'run-me': { calls: 5 }                 // 本次运行自己数，不算进来
        },
        [yesterday]: { 'run-old': { calls: 7 } }
      }
    };
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(usage));
    const u = createPersonaStore({ rootDir: dir }).readUsage();
    assert.equal(sumPriorCalls(u, today, 'run-me'), 5, '今天别的运行：2 + 3');
    assert.equal(sumPriorCalls(u, today, 'run-other-a'), 8, '换一个 runId，别的运行也跟着换');
    assert.equal(sumPriorCalls(u, tomorrow, 'run-me'), 0, '只算指定的那一天');
    // 坏数据一律按 0，不抛
    assert.equal(sumPriorCalls(null, today, 'run-me'), 0);
    assert.equal(sumPriorCalls({ days: { [today]: [] } }, today, 'run-me'), 0);
    assert.equal(sumPriorCalls({ days: { [today]: { 'run-x': { calls: '坏' }, 'run-y': null } } }, today, 'run-me'), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
