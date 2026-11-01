// 桥接接入人格与情绪的测试（PERSONA_PATCH，子项目 1 任务 10）。
// 用 audit-bridge-harness 在临时目录里跑真实的 bridge.js，不碰 state/，不联网（没配判读密钥）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { assertPosixMode } from './test-mode.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const CONSOLE = { 'x-console-token': 'fixture-console-token' };

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

await test('控制台：未初始化 → 确认出厂性格 → 已初始化，live.json 写出性格', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const s0 = await call(port, '/api/persona/status');
      assert.equal(s0.status, 200, s0.body);
      assert.equal(s0.json.initialized, false);
      const c = await call(port, '/api/persona/factory/confirm', { method: 'POST', body: { traits: { O: 70, C: 45, E: 35, A: 30, N: 55 }, beliefs: ['我嘴硬但其实在意'] } });
      assert.equal(c.status, 200, c.body);
      const s1 = await call(port, '/api/persona/status');
      assert.equal(s1.json.initialized, true);
      assert.match(s1.json.rendered.core, /我嘴硬但其实在意/);
    });
    const live = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'persona', 'live.json'), 'utf8'));
    assert.match(live.core, /【你现在的性格】/);
  } finally { await h.close(); }
});

await test('控制台：密钥只回显提示；锁定、未知特质报错；没有快照时回滚报错', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      await call(port, '/api/persona/factory/confirm', { method: 'POST', body: { traits: { O: 50, C: 50, E: 50, A: 50, N: 50 } } });
      const cfg = await call(port, '/api/persona/config', { method: 'POST', body: { apiKey: 'sk-abcdefgh1234', settings: { inject: false } } });
      assert.equal(cfg.status, 200, cfg.body);
      assert.equal(cfg.json.apiKeyHint, 'sk-a…1234（15 位）');
      assert.ok(!cfg.body.includes('sk-abcdefgh1234'), '响应里不能有密钥原文');
      assert.equal(cfg.json.settings.inject, false);
      const lock = await call(port, '/api/persona/lock', { method: 'POST', body: { trait: 'N', locked: true } });
      assert.equal(lock.json.core.traits.N.locked, true);
      assert.equal((await call(port, '/api/persona/lock', { method: 'POST', body: { trait: 'X', locked: true } })).status, 400);
      assert.equal((await call(port, '/api/persona/rollback', { method: 'POST', body: { day: '2026-01-01' } })).status, 400);
    });
    const raw = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'persona', 'config.json'), 'utf8'));
    assert.equal(raw.apiKey, 'sk-abcdefgh1234');
    assertPosixMode(path.join(h.temp, 'state', 'persona', 'config.json'), 0o600);
  } finally { await h.close(); }
});

// PERSONA_PATCH（v2 §8 A1 + B3）：关系冷启动与好恶接口。ltm.listPeople() 的数据来自 state/long-memory/people.json，
// 这里用 harness 的 files 预置一份，验证「聊天统计 → 预览」这条链路真的通。
const LTM_PEOPLE = {
  version: 1,
  people: {
    123: { name: '主人', names: [], items: [], firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-31T00:00:00.000Z', messages: 53 },
    // 跨 4 天：信任种子里 2 × min(spanDays, 10) 那一项要靠 listPeople 返回的 firstSeenAt 才算得出来。
    456: { name: '小满', names: [], items: [], firstSeenAt: '2026-10-27T00:00:00.000Z', lastSeenAt: '2026-10-31T00:00:00.000Z', messages: 32 },
    // 非数字 QQ 号：seedRelations 会跳过（见 §6.1）。
    abc: { name: '非数字', names: [], items: [], firstSeenAt: '2026-10-31T00:00:00.000Z', lastSeenAt: '2026-10-31T00:00:00.000Z', messages: 9 }
  }
};

await test('关系冷启动：GET /api/persona/seed 用 ltm.listPeople 的统计给提案，POST 写入；/api/persona/prefs 保存好恶', async () => {
  const h = await bridgeHarness({ files: { 'state/long-memory/people.json': LTM_PEOPLE } });
  try {
    await withServer(h, async (port) => {
      // 未初始化：新接口给清楚错误（桥接包成 400）
      const early = await call(port, '/api/persona/seed');
      assert.equal(early.status, 400, early.body);
      assert.match(early.json.error, /先确认出厂性格/);
      const earlyPrefs = await call(port, '/api/persona/prefs', { method: 'POST', body: { prefs: [] } });
      assert.equal(earlyPrefs.status, 400);
      assert.match(earlyPrefs.json.error, /先确认出厂性格/);

      await call(port, '/api/persona/factory/confirm', { method: 'POST', body: { traits: { O: 70, C: 45, E: 35, A: 30, N: 55 } } });
      const seed = await call(port, '/api/persona/seed');
      assert.equal(seed.status, 200, seed.body);
      assert.equal(seed.json.ok, true);
      assert.equal(seed.json.proposals.length, 2, '非数字 QQ 被跳过');
      const owner = seed.json.proposals[0];
      assert.equal(owner.userId, '123', '主人排第一');
      assert.equal(owner.isOwner, true);
      assert.equal(owner.messages, 53, '消息数来自 ltm.listPeople');
      assert.equal(owner.name, '主人');
      assert.deepEqual(owner.after, { intimacy: 72, trust: 72, familiarity: 60 });
      const friend = seed.json.proposals.find((p) => p.userId === '456');
      assert.equal(friend.messages, 32);
      // §6.1：熟悉 = min(70, round(8·log2(1+32))) = round(8×5.0444) = 40；
      //       信任 = clamp(round(30 + 2×min(跨越 4 天, 10) + 消息≥20 的 5), 30, 55) = 43；
      //       亲密 = clamp(round(10 + 0.4×40), 10, 40) = 26。
      // 少了 firstSeenAt 时跨越天数按 0 算，信任会是 35 —— 43 就是 listPeople 补上首个时间戳的证据。
      assert.deepEqual(friend.after, { intimacy: 26, trust: 43, familiarity: 40 });

      const applied = await call(port, '/api/persona/seed', { method: 'POST', body: {} });
      assert.equal(applied.status, 200, applied.body);
      assert.deepEqual([...applied.json.applied].sort(), ['123', '456']);
      const again = await call(port, '/api/persona/seed');
      assert.ok(again.json.proposals.every((p) => p.changed === false), '补过之后再预览就没有变化了');

      const prefs = await call(port, '/api/persona/prefs', { method: 'POST', body: { prefs: [{ text: '被叫大肥鱼', valence: 'dislike', strength: 0.9, keywords: ['大肥鱼'] }] } });
      assert.equal(prefs.status, 200, prefs.body);
      assert.equal(prefs.json.core.prefs.length, 1);
      const status = await call(port, '/api/persona/status');
      assert.equal(status.json.traitView.length, 11, '控制台直接读 traitView');
      assert.match(status.json.rendered.core, /你讨厌：被叫大肥鱼（雷点）/);
    });
    // 真落盘：关系写到 state/persona/<角色>/people.json（没有 current-role.json 时角色名是 default）。
    const people = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'persona', 'default', 'people.json'), 'utf8'));
    assert.ok(people['123'].seededAt > 0);
    assert.equal(people['123'].stage, undefined, '只写三项数值与 seededAt，不塞多余字段');
    assert.equal(people['123'].intimacy, 72);
    assert.equal(people['456'].trust, 43, 'trust 含 2 × 跨越天数');
    // 好恶也落盘
    const core = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'persona', 'default', 'core.json'), 'utf8'));
    assert.equal(core.prefs[0].text, '被叫大肥鱼');
  } finally { await h.close(); }
});

// PERSONA_PATCH（v2 §12.1）：角色卡变更提醒。桥接的角色卡从 roles/<角色>.md 读，用 files 预置一份。
await test('角色卡变更：确认时记录版本，改卡后 status.card.changed=true，POST /api/persona/card-ack 记成已同步；未初始化先 400', async () => {
  const h = await bridgeHarness({
    files: {
      'state/current-role.json': { role: '小鲸鱼', mode: 'active' },
      'roles/小鲸鱼.md': '# 角色卡\n傲娇嘴硬，心软。\n'
    }
  });
  try {
    await withServer(h, async (port) => {
      const early = await call(port, '/api/persona/card-ack', { method: 'POST', body: {} });
      assert.equal(early.status, 400, early.body);
      assert.match(early.json.error, /先确认出厂性格/);

      await call(port, '/api/persona/factory/confirm', { method: 'POST', body: { traits: { O: 50, C: 50, E: 50, A: 50, N: 50 } } });
      let status = await call(port, '/api/persona/status');
      assert.equal(status.json.card.recorded, true);
      assert.equal(status.json.card.changed, false);

      fs.writeFileSync(path.join(h.temp, 'roles', '小鲸鱼.md'), '# 角色卡\n傲娇嘴硬，其实很黏人。\n');
      status = await call(port, '/api/persona/status');
      assert.equal(status.json.card.changed, true, '角色卡改过要提示');

      const ack = await call(port, '/api/persona/card-ack', { method: 'POST', body: {} });
      assert.equal(ack.status, 200, ack.body);
      assert.equal(ack.json.ok, true);
      assert.equal(ack.json.card.recorded, true);
      assert.equal(ack.json.card.changed, false);
      status = await call(port, '/api/persona/status');
      assert.equal(status.json.card.changed, false, 'ack 之后不再提示');
    });
    const core = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'persona', '小鲸鱼', 'core.json'), 'utf8'));
    assert.match(core.card.hash, /^[0-9a-f]{64}$/, '角色的 core.json 里记着卡哈希');
  } finally { await h.close(); }
});

await test('安全：带 agent 令牌或智能体调用头一律 403（她改不了自己的数值）；没有控制台令牌被拒', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const agent = await call(port, '/api/persona/status', { headers: { ...CONSOLE, 'x-agent-token': 'whatever' } });
      assert.equal(agent.status, 403);
      const agentCall = await call(port, '/api/persona/lock', { method: 'POST', headers: { ...CONSOLE, 'x-agent-call': '1' }, body: { trait: 'N', locked: true } });
      assert.equal(agentCall.status, 403);
      // v2 新增的接口同样只对控制台开放
      assert.equal((await call(port, '/api/persona/seed', { headers: { ...CONSOLE, 'x-agent-token': 'whatever' } })).status, 403);
      assert.equal((await call(port, '/api/persona/seed', { method: 'POST', headers: { ...CONSOLE, 'x-agent-call': '1' }, body: {} })).status, 403);
      assert.equal((await call(port, '/api/persona/prefs', { method: 'POST', headers: { ...CONSOLE, 'x-agent-call': '1' }, body: { prefs: [] } })).status, 403);
      assert.equal((await call(port, '/api/persona/card-ack', { method: 'POST', headers: { ...CONSOLE, 'x-agent-token': 'whatever' }, body: {} })).status, 403);
      const anon = await call(port, '/api/persona/status', { headers: {} });
      assert.ok([401, 403].includes(anon.status), `无令牌应被拒，实际 ${anon.status}`);
    });
  } finally { await h.close(); }
});

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
