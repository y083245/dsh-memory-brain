// 生活回路（子项目 3）的桥接接线测试（规格 §8、§9 表里 C 那一行）。
//
// 用 audit-bridge-harness 在临时目录里跑真实的 bridge.js：不碰 state/，不联网，不启任何服务。
// 覆盖：
//   ① F1 —— own-life / promise-due / persona-weekly 的本地文案真的进了 prompt，不再被通用分支吞掉；
//      localText 为空时仍然走旧分支；其它唤醒原因行为不变。
//   ② 四个账本接口（socialV2 / 控制台）把 due / by / status / core / archived 透传到 long-memory。
//   ③ GET /api/life-loop 返回 own-life 与 life-loop 的快照；关掉 lifeLoop 时返回 null。
//   ④ onPromiseClosed → persona.onPromise：约定兑现涨信任、爽约掉信任、取消不动。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const CONSOLE = { 'x-console-token': 'fixture-console-token' };

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 本地日期 ±n 天（和 long-memory 的 normalizeDueDate 用同一套本地日期口径）。 */
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

function call(port, pathname, { method = 'GET', headers = CONSOLE, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } }, (response) => {
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

// ── ① F1：本地文案唤醒 ───────────────────────────────────────────────────────
await test('F1：own-life 的文案走 deliverPrompt 真的进了 prompt，不再被「群里在聊什么」替换', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const result = await h.deliverPrompt('private:123', '现在是你的时间，没人找你。想干嘛干嘛。', { silent: true, wakeReason: 'own-life' });
    assert.equal(result.ok, true);
    const prompt = lastPrompt(h);
    assert.match(prompt, /现在是你的时间，没人找你。想干嘛干嘛。/);
    assert.match(prompt, /原因：这是你自己的时间，不是有人找你（own-life）/);
    assert.match(prompt, /不需要回复谁；想做的事做完/);
    assert.ok(!prompt.includes('群里在聊什么'), 'own-life 不该走通用群聊分支');
  } finally { await h.close(); }
});

await test('F1：promise-due 与 persona-weekly 同理；空文案退回旧分支；其它原因即使带文案也不变', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    await h.deliverPrompt('private:123', '【到期的约定】今天是你和主人说好的日子：\n- 周末一起看电影（他答应的）〔a1b2c3d4〕', { silent: true, wakeReason: 'promise-due' });
    let prompt = lastPrompt(h);
    assert.match(prompt, /今天是你和主人说好的日子/);
    assert.match(prompt, /原因：今天有到期的约定（promise-due）/);
    assert.ok(!prompt.includes('群里在聊什么'));

    await h.deliverPrompt('private:123', '【这周的你】开放 +1', { silent: true, wakeReason: 'persona-weekly' });
    prompt = lastPrompt(h);
    assert.match(prompt, /【这周的你】开放 \+1/);
    assert.match(prompt, /原因：这周的你（persona-weekly）/);
    assert.ok(!prompt.includes('群里在聊什么'));

    // localText 只有空白：必须退回原来的通用分支（离线队列/重试可能只带原因没文案）。
    await h.deliverPrompt('private:123', '   \n  ', { silent: true, wakeReason: 'own-life' });
    prompt = lastPrompt(h);
    assert.match(prompt, /原因：own-life/);
    assert.match(prompt, /群里在聊什么/);
    assert.ok(!prompt.includes('这是你自己的时间，不是有人找你'));

    // 其它原因的第三参数不起作用：timeout 的 prompt 有没有文案都一样。
    assert.equal(h.buildWakePromptV2('private:123', 'timeout', '随便写点什么'), h.buildWakePromptV2('private:123', 'timeout'));
    // 三个本地文案原因在纯函数层面也认得第三种文案。
    assert.match(h.buildWakePromptV2('private:123', 'own-life', '正文'), /原因：这是你自己的时间，不是有人找你（own-life）\n正文/);
  } finally { await h.close(); }
});

// ── ② 账本接口透传新字段 ─────────────────────────────────────────────────────
await test('socialV2 账本接口：remember 透传 due / by / core，update 透传 status / due / by / core / archived', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const rem = await call(port, '/api/socialV2/ltm-remember', { method: 'POST', body: {
        key: 'private:123', category: 'pending', content: '周末一起看电影', due: '明天', by: 'them', core: true
      } });
      assert.equal(rem.status, 200, rem.body);
      const item = rem.json.item;
      assert.equal(item.due, plusDays(1), 'due 由桥接换算成 YYYY-MM-DD');
      assert.equal(item.by, 'them');
      assert.equal(item.core, true);
      assert.equal(item.status, 'open', '新建约定默认还没兑现');

      // 不能一起清掉 by 再标状态：这里只更新 status，顺便验证核心条目不能归档。
      const done = await call(port, '/api/socialV2/ltm-update', { method: 'POST', body: { key: 'private:123', itemId: item.id, status: 'done' } });
      assert.equal(done.status, 200, done.body);
      assert.equal(done.json.item.status, 'done');
      assert.ok(done.json.item.closedAt, '结束时会写 closedAt');

      const reopen = await call(port, '/api/socialV2/ltm-update', { method: 'POST', body: { key: 'private:123', itemId: item.id, status: 'open' } });
      assert.equal(reopen.json.item.status, 'open');
      assert.equal(reopen.json.item.closedAt, undefined, '重开会清掉 closedAt');

      assert.equal((await call(port, '/api/socialV2/ltm-update', { method: 'POST', body: { key: 'private:123', itemId: item.id, archived: true } })).status, 400,
        '核心条目不能归档');

      const clearDue = await call(port, '/api/socialV2/ltm-update', { method: 'POST', body: { key: 'private:123', itemId: item.id, due: '', by: '' } });
      assert.equal(clearDue.status, 200, clearDue.body);
      assert.equal(clearDue.json.item.due, undefined, '空串清除到期日');
      assert.equal(clearDue.json.item.by, undefined, '空串清除谁答应的');

      const uncore = await call(port, '/api/socialV2/ltm-update', { method: 'POST', body: { key: 'private:123', itemId: item.id, core: false, archived: true } });
      assert.equal(uncore.status, 200, uncore.body);
      assert.equal(uncore.json.item.core, undefined);
      assert.ok(uncore.json.item.archivedAt, '取消核心后可以归档');
    });
  } finally { await h.close(); }
});

await test('控制台账本接口：/api/ltm/remember 与 /api/ltm/update 同样透传 due / by / status / core / archived', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const rem = await call(port, '/api/ltm/remember', { method: 'POST', body: {
        userId: '456', category: 'pending', content: '给他带书', due: '3天后', by: 'me'
      } });
      assert.equal(rem.status, 200, rem.body);
      const item = rem.json.item;
      assert.equal(item.due, plusDays(3));
      assert.equal(item.by, 'me');

      const missed = await call(port, '/api/ltm/update', { method: 'POST', body: { userId: '456', itemId: item.id, status: 'missed' } });
      assert.equal(missed.status, 200, missed.body);
      // 控制台接口回的是 person（不是单条），从里面挑出这一条。
      const view = (res) => res.json.person?.items?.find((x) => x.id === item.id);
      assert.equal(view(missed).status, 'missed');

      const core = await call(port, '/api/ltm/update', { method: 'POST', body: { userId: '456', itemId: item.id, core: true } });
      assert.equal(view(core).core, true);

      const archived = await call(port, '/api/ltm/update', { method: 'POST', body: { userId: '456', itemId: item.id, core: false, archived: true } });
      assert.ok(view(archived).archivedAt);

      const restored = await call(port, '/api/ltm/update', { method: 'POST', body: { userId: '456', itemId: item.id, archived: false } });
      assert.equal(view(restored).archivedAt, undefined, '恢复后去掉 archivedAt');
    });
  } finally { await h.close(); }
});

// ── ③ GET /api/life-loop ────────────────────────────────────────────────────
await test('GET /api/life-loop：返回 own-life 与 life-loop 快照，只有控制台令牌能读', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/life-loop');
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.ok, true);
      assert.ok(r.json.ownLife, 'own-life 应该在启动时创建');
      assert.match(String(r.json.ownLife.activityDay), /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof r.json.ownLife.midnightDoneToday, 'boolean');
      assert.equal(typeof r.json.ownLife.firedToday, 'number');
      assert.ok(r.json.lifeLoop, 'lifeLoop 应该在启动时创建');
      assert.equal(r.json.lifeLoop.recallPerDay, 2);
      assert.equal(r.json.lifeLoop.recallToday, 0);
      assert.ok(Array.isArray(r.json.lifeLoop.history));
      assert.ok(r.json.lifeLoop.promiseWakes && Array.isArray(r.json.lifeLoop.promiseWakes.users));

      // 智能体调用（带 x-agent-token）不能读管理端状态。
      const agent = await call(port, '/api/life-loop', { headers: { ...CONSOLE, 'x-agent-token': 'whatever' } });
      assert.equal(agent.status, 403, agent.body);
      const anon = await call(port, '/api/life-loop', { headers: {} });
      assert.ok([401, 403].includes(anon.status), `无令牌应被拒，实际 ${anon.status}`);
    });
  } finally { await h.close(); }
});

await test('GET /api/life-loop：cfg.lifeLoop.enabled=false 时不创建生活回路（own-life 照常有）', async () => {
  const h = await bridgeHarness({ config: { lifeLoop: { enabled: false } } });
  try {
    await withServer(h, async (port) => {
      const r = await call(port, '/api/life-loop');
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.lifeLoop, null);
      assert.ok(r.json.ownLife);
    });
    assert.equal(h.getLifeLoop(), null, '关闭时 bridge 里也不留实例');
  } finally { await h.close(); }
});

// ── ④ onPromiseClosed → persona.onPromise ───────────────────────────────────
await test('约定结果联动情绪：对方兑现信任 +2，爽约 −3，取消不动', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      // 人格模块要先确认出厂性格才「就绪」。
      const confirm = await call(port, '/api/persona/factory/confirm', { method: 'POST', body: { traits: { O: 50, C: 50, E: 50, A: 50, N: 50 } } });
      assert.equal(confirm.status, 200, confirm.body);

      const addPromise = async (content) => {
        const r = await call(port, '/api/ltm/remember', { method: 'POST', body: { userId: '123', category: 'pending', content, by: 'them' } });
        assert.equal(r.status, 200, r.body);
        return r.json.item.id;
      };
      const setStatus = async (itemId, status) => {
        const r = await call(port, '/api/ltm/update', { method: 'POST', body: { userId: '123', itemId, status } });
        assert.equal(r.status, 200, r.body);
        return r.json.item;
      };
      const trustNow = () => {
        const people = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'persona', 'default', 'people.json'), 'utf8'));
        return people['123'].trust;
      };

      // 新认识的人 trust 从 30 起。
      const first = await addPromise('周末一起看电影');
      await setStatus(first, 'done');
      assert.equal(trustNow(), 32, '对方兑现 → 信任 +2');

      const second = await addPromise('周五交稿');
      await setStatus(second, 'missed');
      assert.equal(trustNow(), 29, '对方爽约 → 信任 −3');

      const third = await addPromise('下月一起吃饭');
      await setStatus(third, 'cancelled');
      assert.equal(trustNow(), 29, '取消不触发情绪联动');
    });
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
