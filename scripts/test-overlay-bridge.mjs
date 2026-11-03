// UPGRADE_PATCH：覆盖层 + 版本检查的桥接接口测试——经 audit-bridge-harness 跑真实 bridge.js，
// 仓库根与 state/ 都是 harness 的临时目录（出厂卡 / 出厂 preset 从开发副本拷进去，开发副本本身只读）。
// 不联网（harness 设了 QQB_NO_UPDATE_CHECK=1、fetch 是记录型替身），不碰任何线上服务。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { mergeRagConfig } from '../src/api-hub.js';
import { renderPatch } from './build-agent-preset-patches.mjs';
import { extractPresetPrefix } from '../src/preset-prompt.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function call(port, urlPath, { method = 'GET', headers = CONSOLE, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: data, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function treeHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      h.update(path.relative(dir, p) + '\0');
      if (fs.statSync(p).isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
const devFactoryHash = { roles: treeHash(path.join(REPO, 'roles')), presets: treeHash(path.join(REPO, 'dsh', 'agent-presets')) };

/** 出厂 preset 两个文件（preset.yml + agent.cordis.yml）拷进 harness 的临时仓库根。 */
function presetFiles() {
  const out = {};
  for (const name of ['qq-chat', 'qq-chat-v2']) {
    for (const f of ['preset.yml', 'agent.cordis.yml']) {
      out[`dsh/agent-presets/${name}/${f}`] = fs.readFileSync(path.join(REPO, 'dsh', 'agent-presets', name, f), 'utf8');
    }
  }
  return out;
}

const FACTORY_ROLES = {
  'roles/甲.md': '# 甲\n出厂甲的性格：安静。\n',
  'roles/乙.md': '# 乙\n出厂乙。\n',
  'roles/README.md': '说明\n',
};

await test('角色卡：GET /api/roles 带 origin；保存出厂卡写进 state/roles/、出厂不变、origin=modified；reset 回到出厂', async () => {
  const h = await bridgeHarness({ files: { ...FACTORY_ROLES } });
  try {
    const factoryFile = path.join(h.temp, 'roles', '甲.md');
    const before = sha(factoryFile);
    await withServer(h, async (port) => {
      let res = await call(port, '/api/roles');
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(res.json.roles, ['甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
      assert.deepEqual(res.json.summaries.map((s) => s.origin), ['factory', 'factory']);
      for (const k of ['name', 'bytes', 'chars', 'lines', 'mtime', 'excerpt', 'injectedV1', 'injectedV2', 'warnings']) assert.ok(k in res.json.summaries[0], k);

      res = await call(port, '/api/roles/update', { method: 'POST', body: { name: '甲', content: '# 甲\n用户改过：话痨。' } });
      assert.equal(res.status, 200, res.body);
      assert.equal(sha(factoryFile), before, '出厂文件不变');
      const userFile = path.join(h.temp, 'state', 'roles', '甲.md');
      assert.equal(fs.readFileSync(userFile, 'utf8'), '# 甲\n用户改过：话痨。\n');
      assert.equal(fs.statSync(userFile).mode & 0o777, 0o600);
      res = await call(port, '/api/roles');
      assert.equal(res.json.summaries.find((s) => s.name === '甲').origin, 'modified');
      res = await call(port, '/api/roles/content?name=甲'.replace('甲', encodeURIComponent('甲')));
      assert.equal(res.json.content, '# 甲\n用户改过：话痨。\n');
      assert.equal(res.json.origin, 'modified');

      // reset：只对已修改有效
      res = await call(port, '/api/roles/reset', { method: 'POST', body: { name: '乙' } });
      assert.equal(res.status, 400, res.body);
      // 名字先过 validateRoleName（会把 ../x 净化成 x）：不存在 → 404，绝不越出目录
      res = await call(port, '/api/roles/reset', { method: 'POST', body: { name: '../x' } });
      assert.ok([400, 404].includes(res.status), res.body);
      res = await call(port, '/api/roles/reset', { method: 'POST', body: { name: '' } });
      assert.equal(res.status, 400, res.body);
      res = await call(port, '/api/roles/reset', { method: 'POST', body: { name: '甲' } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.origin, 'factory');
      assert.equal(fs.existsSync(userFile), false);
      res = await call(port, `/api/roles/content?name=${encodeURIComponent('甲')}`);
      assert.equal(res.json.content, '# 甲\n出厂甲的性格：安静。\n');
    });
    assert.equal(sha(factoryFile), before);
  } finally { await h.close(); }
});

await test('角色卡：新建 / 改名 / 删除都走覆盖层，出厂目录前后 sha256 不变', async () => {
  const h = await bridgeHarness({ files: { ...FACTORY_ROLES, 'state/current-role.json': { role: '乙', mode: 'active' } } });
  try {
    const rolesDir = path.join(h.temp, 'roles');
    const before = treeHash(rolesDir);
    await withServer(h, async (port) => {
      let res = await call(port, '/api/roles/create', { method: 'POST', body: { name: '丙', content: '# 丙\n自建。' } });
      assert.equal(res.status, 200, res.body);
      assert.ok(fs.existsSync(path.join(h.temp, 'state', 'roles', '丙.md')));
      res = await call(port, '/api/roles/create', { method: 'POST', body: { name: '甲', content: 'x' } });
      assert.equal(res.status, 400, '出厂卡同名不能新建');

      // 改名出厂卡（正在启用）：新名是用户版、旧名隐藏、当前角色跟随
      res = await call(port, '/api/roles/rename', { method: 'POST', body: { from: '乙', to: '丁' } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.currentFollowed, true);
      res = await call(port, '/api/roles');
      assert.deepEqual(res.json.roles.slice().sort(), ['丁', '丙', '甲'].sort());
      assert.equal(res.json.current, '丁');
      assert.equal(res.json.summaries.find((s) => s.name === '丁').origin, 'user');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'roles', 'hidden.json'), 'utf8')), { version: 1, names: ['乙'] });

      // 删除出厂卡：从列表消失
      res = await call(port, '/api/roles/delete', { method: 'POST', body: { name: '甲' } });
      assert.equal(res.status, 200, res.body);
      res = await call(port, '/api/roles');
      assert.deepEqual(res.json.roles.slice().sort(), ['丁', '丙'].sort());
      // 被隐藏的出厂卡不能被设为当前角色
      res = await call(port, '/api/role', { method: 'POST', body: { role: '甲' } });
      assert.equal(res.status, 400);
      // 删除自建卡
      res = await call(port, '/api/roles/delete', { method: 'POST', body: { name: '丙' } });
      assert.equal(res.status, 200, res.body);
      assert.equal(fs.existsSync(path.join(h.temp, 'state', 'roles', '丙.md')), false);
    });
    assert.equal(treeHash(rolesDir), before, '出厂 roles/ 一个字节都没变');
    assert.equal(fs.statSync(path.join(h.temp, 'state', 'roles')).mode & 0o777, 0o700);
  } finally { await h.close(); }
});

await test('当前角色注入读的是生效版本（用户版优先；恢复出厂后立刻换回出厂）', async () => {
  const h = await bridgeHarness({
    config: { mode: 'reserved2' },
    files: { ...FACTORY_ROLES, 'state/current-role.json': { role: '甲', mode: 'active' } },
  });
  try {
    h.setMode('reserved2');
    // 二代的角色卡经 qq_get_prompt（/api/socialV2/prompt 的 role.hint）给到她，唤醒提示里只放名字
    await withServer(h, async (port) => {
      const hint = async () => {
        const res = await call(port, `/api/socialV2/prompt?key=${encodeURIComponent('private:123')}`);
        assert.equal(res.status, 200, res.body);
        return String(res.json.role?.hint ?? '');
      };
      assert.match(await hint(), /出厂甲的性格：安静/);
      let res = await call(port, '/api/roles/update', { method: 'POST', body: { name: '甲', content: '# 甲\n用户版的甲：特别黏人。' } });
      assert.equal(res.status, 200, res.body);
      const h1 = await hint();
      assert.match(h1, /用户版的甲：特别黏人/);
      assert.doesNotMatch(h1, /出厂甲的性格/);
      res = await call(port, '/api/roles/reset', { method: 'POST', body: { name: '甲' } });
      assert.equal(res.status, 200, res.body);
      assert.match(await hint(), /出厂甲的性格：安静/);
    });
  } finally { await h.close(); }
});

await test('仿真提示词：保存 → 写覆盖、出厂 yml 不变、派生 patch 重新生成且含新提示词；与出厂相同 → 删覆盖；reset → patch 回到出厂生成结果', async () => {
  const h = await bridgeHarness({ files: presetFiles() });
  try {
    const name = 'qq-chat-v2';
    const factoryYml = path.join(h.temp, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
    const presetsDir = path.join(h.temp, 'dsh', 'agent-presets');
    const before = treeHash(presetsDir);
    const factoryPrefix = extractPresetPrefix(fs.readFileSync(factoryYml, 'utf8'));
    const patchFile = path.join(h.temp, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`);
    const overrideFile = path.join(h.temp, 'state', 'preset-overrides', `${name}.prefix.md`);
    const factoryPatch = renderPatch(name, { root: h.temp });
    const devPatch = fs.readFileSync(path.join(REPO, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`), 'utf8');
    await withServer(h, async (port) => {
      let res = await call(port, `/api/preset/sim-prompt?preset=${name}`);
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.overridden, false);
      assert.equal(res.json.content, factoryPrefix);
      for (const k of ['chars', 'bytes', 'warnings', 'status', 'presets']) assert.ok(k in res.json, k);

      const next = `${factoryPrefix}\n【覆盖层测试】用户加的一句。`;
      res = await call(port, '/api/preset/sim-prompt', { method: 'POST', body: { preset: name, content: next } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.requiresRestart, true);
      assert.equal(fs.readFileSync(overrideFile, 'utf8'), next);
      assert.equal(fs.statSync(overrideFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(overrideFile)).mode & 0o777, 0o700);
      assert.equal(treeHash(presetsDir), before, '出厂 preset 不变');
      assert.match(fs.readFileSync(patchFile, 'utf8'), /【覆盖层测试】用户加的一句。/);
      res = await call(port, `/api/preset/sim-prompt?preset=${name}`);
      assert.equal(res.json.overridden, true);
      assert.equal(res.json.content, next);
      assert.equal(res.json.status.overridden, true);

      // 备份走覆盖层：列出来、还原后覆盖回到那份内容
      res = await call(port, `/api/preset/sim-prompt/backups?preset=${name}`);
      assert.equal(res.status, 200);
      assert.ok(res.json.backups.length >= 1);

      // 同样的内容再存一次 = 没变化
      res = await call(port, '/api/preset/sim-prompt', { method: 'POST', body: { preset: name, content: next } });
      assert.equal(res.json.unchanged, true);

      // 存一份与出厂相同的内容 → 删除覆盖，patch 回到出厂生成结果
      res = await call(port, '/api/preset/sim-prompt', { method: 'POST', body: { preset: name, content: factoryPrefix } });
      assert.equal(res.status, 200, res.body);
      assert.equal(fs.existsSync(overrideFile), false);
      assert.equal(fs.readFileSync(patchFile, 'utf8'), factoryPatch);

      // 还原最近一份备份（保存 next 之后、存回出厂之前做的备份，内容是 next）
      res = await call(port, `/api/preset/sim-prompt/backups?preset=${name}`);
      const withNext = res.json.backups.find((b) => fs.readFileSync(path.join(h.temp, 'state', 'preset-backups', b.file), 'utf8').includes('【覆盖层测试】'));
      assert.ok(withNext, '有一份含用户提示词的备份');
      res = await call(port, '/api/preset/sim-prompt/restore', { method: 'POST', body: { preset: name, file: withNext.file } });
      assert.equal(res.status, 200, res.body);
      assert.equal(fs.readFileSync(overrideFile, 'utf8'), next);
      assert.match(fs.readFileSync(patchFile, 'utf8'), /【覆盖层测试】/);
      assert.equal(treeHash(presetsDir), before);

      // reset
      res = await call(port, '/api/preset/sim-prompt/reset', { method: 'POST', body: { preset: name } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.reset, true);
      assert.equal(fs.existsSync(overrideFile), false);
      assert.equal(fs.readFileSync(patchFile, 'utf8'), factoryPatch);
      assert.equal(factoryPatch, devPatch, '临时根里出厂生成的 patch 与开发副本里的派生 patch 逐字相同');
      res = await call(port, '/api/preset/sim-prompt/reset', { method: 'POST', body: { preset: name } });
      assert.equal(res.json.reset, false);
      res = await call(port, '/api/preset/sim-prompt/reset', { method: 'POST', body: { preset: '../../x' } });
      assert.equal(res.status, 400);
      // 不满足安全不变量的内容照旧 400，不写覆盖
      res = await call(port, '/api/preset/sim-prompt', { method: 'POST', body: { preset: name, content: '太短' } });
      assert.equal(res.status, 400);
      assert.equal(fs.existsSync(overrideFile), false);
    });
    assert.equal(treeHash(presetsDir), before);
  } finally { await h.close(); }
});

await test('仿真提示词：保存时同步 DSH 旧安装目录（存在时写生效版本）', async () => {
  const h = await bridgeHarness({ files: presetFiles() });
  try {
    const name = 'qq-chat-v2';
    const installed = path.join(process.env.DSH_HOME, '.agent-presets', name, 'agent.cordis.yml');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, 'old');
    const factoryPrefix = extractPresetPrefix(fs.readFileSync(path.join(h.temp, 'dsh', 'agent-presets', name, 'agent.cordis.yml'), 'utf8'));
    await withServer(h, async (port) => {
      const res = await call(port, '/api/preset/sim-prompt', { method: 'POST', body: { preset: name, content: `${factoryPrefix}\n【同步】` } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.synced, true);
    });
    assert.match(fs.readFileSync(installed, 'utf8'), /【同步】/);
    assert.ok(process.env.DSH_HOME.startsWith(h.temp), 'DSH_HOME 在临时目录里');
  } finally { await h.close(); }
});

await test('GET /api/update/status 形状；harness 里恒为 off、零请求；POST /api/update/check 也不发请求', async () => {
  const h = await bridgeHarness({ files: { 'package.json': JSON.stringify({ version: '0.3.0' }), '.git/config': '[remote "origin"]\n\turl = https://github.com/a/b.git\n' } });
  try {
    await withServer(h, async (port) => {
      let res = await call(port, '/api/update/status');
      assert.equal(res.status, 200, res.body);
      for (const k of ['ok', 'version', 'state', 'latest', 'newer', 'notes', 'upgrade', 'command', 'checkedAt', 'lastUpgrade']) assert.ok(k in res.json, k);
      assert.equal(res.json.version, '0.3.0');
      assert.equal(res.json.state, 'off');
      assert.equal(res.json.command, 'bash scripts/update.sh');
      res = await call(port, '/api/update/check', { method: 'POST', body: {} });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.state, 'off');
    });
    assert.ok(h.getUpdateCheck(), '版本检查实例已创建');
    assert.equal(h.calls.http.filter((c) => /github/.test(c.url)).length, 0, '零请求');
  } finally { await h.close(); }
});

await test('新路由拒绝智能体调用：x-agent-call / x-agent-token → 403', async () => {
  const h = await bridgeHarness({ files: { ...FACTORY_ROLES, ...presetFiles() } });
  try {
    await withServer(h, async (port) => {
      const routes = [
        ['POST', '/api/roles/reset', { name: '甲' }],
        ['POST', '/api/preset/sim-prompt/reset', { preset: 'qq-chat-v2' }],
        ['GET', '/api/update/status'],
        ['POST', '/api/update/check', {}],
      ];
      for (const [method, p, body] of routes) {
        for (const extra of [{ 'x-agent-call': '1' }, { 'x-agent-token': 'whatever' }, { 'x-agent-call': '1', 'x-agent-token': 'whatever' }]) {
          const res = await call(port, p, { method, headers: { ...CONSOLE, ...extra }, body });
          assert.equal(res.status, 403, `${method} ${p} ${JSON.stringify(extra)} → ${res.status}`);
        }
        const anon = await call(port, p, { method, headers: {}, body });
        assert.ok([401, 403].includes(anon.status), `${p} 无令牌应被拒，实际 ${anon.status}`);
      }
    });
  } finally { await h.close(); }
});

await test('api-hub：有 config.local.yml 时 GET /api/apis 读到合并后的值；没有时照出厂', async () => {
  const factoryYml = fs.readFileSync(path.join(REPO, 'sidecars', 'memory-rag', 'config.yml'), 'utf8');
  for (const withLocal of [false, true]) {
    const files = { 'sidecars/memory-rag/config.yml': factoryYml };
    if (withLocal) files['state/long-memory/rag/config.local.yml'] = 'embedding:\n  model: user-model-x\n  dim: 1024\nstate_dir: /elsewhere\n';
    const h = await bridgeHarness({ files, config: { memoryRag: { enabled: false } } });
    try {
      await withServer(h, async (port) => {
        const res = await call(port, '/api/apis');
        assert.equal(res.status, 200, res.body);
        const emb = JSON.stringify(res.json);
        if (withLocal) {
          assert.match(emb, /user-model-x/);
          assert.match(emb, /"dim":1024/);
          assert.match(emb, /127\.0\.0\.1:8091/, '没被覆盖的键（base_url）保留出厂值');
        } else {
          assert.match(emb, /Qwen3-Embedding-8B-Q8_0/);
          assert.doesNotMatch(emb, /user-model-x/);
        }
      });
    } finally { await h.close(); }
  }
});

await test('mergeRagConfig：worker M 的共用用例全部一致，且不改参数', () => {
  const file = path.join(REPO, 'sidecars', 'memory-rag', 'tests', 'fixtures', 'config_merge_cases.json');
  const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(cases.length >= 5);
  for (const c of cases) {
    const base = structuredClone(c.base);
    const local = structuredClone(c.local);
    assert.deepEqual(mergeRagConfig(c.base, c.local), c.expected, c.name);
    assert.deepEqual(c.base, base, `${c.name}：base 没被改`);
    assert.deepEqual(c.local, local, `${c.name}：local 没被改`);
  }
});

await test('开发副本的出厂 roles/ 与 dsh/agent-presets/ 前后 sha256 不变', () => {
  assert.equal(treeHash(path.join(REPO, 'roles')), devFactoryHash.roles);
  assert.equal(treeHash(path.join(REPO, 'dsh', 'agent-presets')), devFactoryHash.presets);
});

if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
console.log('\n全部通过');
