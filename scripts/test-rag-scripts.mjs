// scripts/rag-config.py + start-all.sh / stop-all.sh（.sh 转发到 Node 编排）的 RAG 开关单测。
//
// 为什么 Windows 跳过：这套夹具依赖 /bin/bash、假 systemctl / 假命令脚本与 POSIX 权限位；
// Windows 没有等价的 systemd 语义，跨平台的编排逻辑由 test-runtime / test-orchestrator 覆盖。
// Linux 上仍然逐条验证：开关读写、systemd 单元的启停序列、managed=no 时不碰 embedding。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('SKIP test-rag-scripts：假 systemctl / bash 命令是 POSIX 专用；Windows 走 PID 管理器，另有跨平台测试');
  process.exit(0);
}

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-rag-scripts-'));
const FAKE_BIN = path.join(ROOT, 'fakebin');
fs.mkdirSync(FAKE_BIN, { recursive: true });

function fakeCommand(name, body) {
  const file = path.join(FAKE_BIN, name);
  fs.writeFileSync(file, `#!/bin/bash\nmkdir -p "$HOME/.fake-log"\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

fakeCommand('systemctl', [
  'echo "$*" >> "$HOME/.fake-log/systemctl.log"',
  'last="${!#}"',
  'case "$*" in',
  '  *LoadState*) echo loaded ;;',
  '  *ActiveState*)',
  '    if [ -f "$HOME/.fake-state/$last" ]; then cat "$HOME/.fake-state/$last"; else echo inactive; fi ;;',
  'esac',
  'exit 0',
].join('\n'));
fakeCommand('ss', 'echo "$*" >> "$HOME/.fake-log/ss.log"\nexit 0');
fakeCommand('nvidia-smi', 'echo "$*" >> "$HOME/.fake-log/nvidia-smi.log"\necho 24000\nexit 0');
for (const name of ['systemd-run', 'pgrep', 'pkill']) {
  fakeCommand(name, `echo "$*" >> "$HOME/.fake-log/${name}.log"\nexit 0`);
}

function envFor(home, extra = {}) {
  return {
    HOME: home,
    PATH: `${FAKE_BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_RUNTIME_DIR: path.join(home, 'run'),
    EMBED_BIN: path.join(home, 'llama.cpp', 'build', 'bin', 'llama-server'),
    EMBED_MODEL: path.join(home, 'models', 'fake-embedding.gguf'),
    // 测试不真的等 60 秒：编排脚本认这两个环境变量。
    QQB_RAG_WAIT_SECONDS: '1',
    QQB_RAG_EMBED_WAIT_SECONDS: '1',
    ...extra,
  };
}

function checkIsolation(env) {
  const result = spawnSync('/bin/bash', ['-c', 'command -v systemctl'], { env, encoding: 'utf8' });
  const resolved = String(result.stdout ?? '').trim();
  const expected = path.join(FAKE_BIN, 'systemctl');
  if (resolved !== expected) {
    throw new Error(`隔离自检失败：systemctl 指向 ${resolved || '（找不到）'}，不是 ${expected}`);
  }
}

const logLines = (home, name) => {
  try {
    return fs.readFileSync(path.join(home, '.fake-log', `${name}.log`), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const clearLogs = (home) => {
  fs.rmSync(path.join(home, '.fake-log'), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.fake-log'), { recursive: true });
};

const BASE_CONFIG = {
  dsh: { baseUrl: 'http://127.0.0.1:3080' },
  role: { maxInjectChars: 6000 },
  memoryRag: { url: 'http://127.0.0.1:8093', timeoutMs: 3000 },
  webSearch: { model: 'deepseek-v4-flash' },
};

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(file, mode);
}

function writeFile(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}

/**
 * 造一个假 HOME：
 *   qq-bridge/{start-all.sh,stop-all.sh,scripts/start-all.mjs,scripts/stop-all.mjs,src/runtime/...}
 *   qq-bridge/sidecars/memory-rag/.venv/bin/python（假解释器）
 *   ~/.config/systemd/user/qq-*.service（模拟已安装单元）
 */
function makeHome({ name, units = true, settingsKind = 'bundled', provider = 'local', config = BASE_CONFIG }) {
  const home = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  const bridge = path.join(home, 'qq-bridge');
  fs.mkdirSync(path.join(bridge, 'scripts', 'systemd'), { recursive: true });

  for (const file of ['start-all.sh', 'stop-all.sh']) {
    fs.copyFileSync(path.join(REPO, file), path.join(bridge, file));
    fs.chmodSync(path.join(bridge, file), 0o755);
  }
  fs.copyFileSync(path.join(REPO, 'scripts', 'start-all.mjs'), path.join(bridge, 'scripts', 'start-all.mjs'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'stop-all.mjs'), path.join(bridge, 'scripts', 'stop-all.mjs'));
  fs.cpSync(path.join(REPO, 'src', 'runtime'), path.join(bridge, 'src', 'runtime'), { recursive: true });
  // js-yaml 等依赖：让 Node 从仓库 node_modules 解析（只读链接）。
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(bridge, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(REPO, 'scripts', 'rag-config.py'), path.join(bridge, 'scripts', 'rag-config.py'));
  const helper = path.join(bridge, 'scripts', 'systemd', 'qqb-helper.sh');
  fs.copyFileSync(path.join(REPO, 'scripts', 'systemd', 'qqb-helper.sh'), helper);
  fs.chmodSync(helper, 0o755);

  writeJson(path.join(bridge, 'config.json'), config);
  if (settingsKind !== null) {
    writeJson(path.join(bridge, 'state', 'long-memory', 'rag', 'embedding-settings.json'), {
      version: 1,
      kind: settingsKind,
      local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', dim: 1024 },
      cloud: { baseUrl: 'https://api.example.com/v1', model: 'bge-m3', dim: 1024 },
    });
  }
  writeFile(path.join(bridge, 'sidecars', 'memory-rag', 'config.yml'),
    `embedding:\n  provider: ${provider}\n  base_url: http://127.0.0.1:8091\n  model: Qwen3-Embedding-8B-Q8_0\n  dim: 2048\n`);

  writeFile(path.join(home, 'llama.cpp', 'build', 'bin', 'llama-server'), '#!/bin/bash\nexit 0\n', 0o755);
  writeFile(path.join(home, 'models', 'fake-embedding.gguf'), 'fake\n');
  writeFile(path.join(bridge, 'sidecars', 'memory-rag', '.venv', 'bin', 'python'), '#!/bin/bash\nexit 0\n', 0o755);

  fs.mkdirSync(path.join(home, '.ai-companion-run'), { recursive: true });
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.mkdirSync(path.join(home, '.fake-log'), { recursive: true });
  fs.mkdirSync(path.join(home, '.fake-state'), { recursive: true });
  if (units) {
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    for (const unit of ['qq-bridge.service', 'qq-memory-rag.service', 'qq-embedding.service']) {
      writeFile(path.join(unitDir, unit), '# 假单元\n');
    }
  }
  return { home, bridge, configPath: path.join(bridge, 'config.json') };
}

function runScript(homeInfo, script, args) {
  const env = envFor(homeInfo.home);
  checkIsolation(env);
  clearLogs(homeInfo.home);
  const result = spawnSync('/bin/bash', [path.join(homeInfo.bridge, script), ...args], {
    env,
    cwd: homeInfo.bridge,
    encoding: 'utf8',
    timeout: 60000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runRagConfig(homeInfo, args) {
  const env = envFor(homeInfo.home);
  const result = spawnSync('python3', [path.join(homeInfo.bridge, 'scripts', 'rag-config.py'), ...args], {
    env,
    cwd: homeInfo.home,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
}

function runHelper(homeInfo, args) {
  const env = envFor(homeInfo.home);
  checkIsolation(env);
  clearLogs(homeInfo.home);
  const result = spawnSync('/bin/bash', [path.join(homeInfo.bridge, 'scripts', 'systemd', 'qqb-helper.sh'), ...args], {
    env,
    cwd: homeInfo.home,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const enabledOf = (home) => JSON.parse(fs.readFileSync(home.configPath, 'utf8')).memoryRag?.enabled;
const markActive = (home, units) => {
  for (const unit of units) fs.writeFileSync(path.join(home.home, '.fake-state', unit), 'active\n');
};

// ══ 1. rag-config.py ════════════════════════════════════════════════════
await test('rag-config get-enabled：缺省 / true / 非布尔 / 坏 JSON 都是 false，退出码 0', () => {
  const home = makeHome({ name: 'cfg-get' });
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).stdout, 'false');
  fs.writeFileSync(home.configPath, JSON.stringify({ memoryRag: { enabled: true } }));
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).stdout, 'true');
  fs.writeFileSync(home.configPath, JSON.stringify({ memoryRag: { enabled: 'true' } }));
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).stdout, 'false');
  fs.writeFileSync(home.configPath, '{ 坏掉');
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).code, 0);
});

await test('rag-config set-enabled：只改 enabled，其它键原样、权限保持 600', () => {
  const home = makeHome({ name: 'cfg-set' });
  const before = JSON.parse(fs.readFileSync(home.configPath, 'utf8'));
  const result = runRagConfig(home, ['set-enabled', home.bridge, 'true']);
  assert.equal(result.code, 0, result.stderr);
  const after = JSON.parse(fs.readFileSync(home.configPath, 'utf8'));
  assert.equal(after.memoryRag.enabled, true);
  assert.deepEqual(after.memoryRag.url, before.memoryRag.url);
  assert.equal(after.dsh.baseUrl, before.dsh.baseUrl);
  assert.equal(fs.statSync(home.configPath).mode & 0o777, 0o600);
});

await test('rag-config embedding-managed：设置文件 bundled/local/cloud + config.yml 回落', () => {
  const bundled = makeHome({ name: 'managed-bundled', settingsKind: 'bundled' });
  assert.equal(runRagConfig(bundled, ['embedding-managed', bundled.bridge]).stdout, 'yes');
  const local = makeHome({ name: 'managed-local', settingsKind: 'local' });
  assert.equal(runRagConfig(local, ['embedding-managed', local.bridge]).stdout, 'no');
  const legacyLocal = makeHome({ name: 'managed-legacy-local', settingsKind: null, provider: 'local' });
  assert.equal(runRagConfig(legacyLocal, ['embedding-managed', legacyLocal.bridge]).stdout, 'yes');
  const legacyApi = makeHome({ name: 'managed-legacy-api', settingsKind: null, provider: 'api' });
  assert.equal(runRagConfig(legacyApi, ['embedding-managed', legacyApi.bridge]).stdout, 'no');
});

// ══ 2. 已安装单元 + managed=yes ═════════════════════════════════════════
await test('已安装单元 + managed=yes：start-all.sh --rag 写 true 并起两个单元，stop-all.sh --rag 写 false 并停两个单元', () => {
  const home = makeHome({ name: 'units-managed', settingsKind: 'bundled' });
  assert.equal(enabledOf(home), undefined);

  const started = runScript(home, 'start-all.sh', ['--rag']);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(enabledOf(home), true);

  const startCalls = logLines(home.home, 'systemctl');
  assert.ok(startCalls.includes('--user start qq-embedding.service'), `要起 embedding：${startCalls.join(' | ')}`);
  assert.ok(startCalls.includes('--user start qq-memory-rag.service'), `要起 memory-rag：${startCalls.join(' | ')}`);

  markActive(home, ['qq-embedding.service', 'qq-memory-rag.service']);
  const stopped = runScript(home, 'stop-all.sh', ['--rag']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(enabledOf(home), false);

  const stopCalls = logLines(home.home, 'systemctl');
  assert.ok(stopCalls.includes('--user stop qq-embedding.service'), `要停 embedding：${stopCalls.join(' | ')}`);
  assert.ok(stopCalls.includes('--user stop qq-memory-rag.service'), `要停 memory-rag：${stopCalls.join(' | ')}`);
});

// ══ 3. 已安装单元 + managed=no ══════════════════════════════════════════
await test('managed=no（自己部署的本地服务）：start 只起 memory-rag，完全不碰 qq-embedding', () => {
  const home = makeHome({ name: 'units-managed-no', settingsKind: 'local' });
  const started = runScript(home, 'start-all.sh', ['--rag']);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(enabledOf(home), true);

  const calls = logLines(home.home, 'systemctl');
  assert.ok(calls.includes('--user start qq-memory-rag.service'), `memory-rag 照常起：${calls.join(' | ')}`);
  const embedCalls = calls.filter((line) => line.includes('qq-embedding'));
  assert.deepEqual(embedCalls, ['--user show -p LoadState --value qq-embedding.service'],
    `不该启停或等待 qq-embedding：${embedCalls.join(' | ')}`);
  assert.match(started.stdout, /向量模型：自己部署 \/ 云端，不由本脚本管理/);
});

await test('managed=no：stop 只停 memory-rag，不停 qq-embedding', () => {
  const home = makeHome({ name: 'units-managed-no-stop', settingsKind: 'cloud' });
  markActive(home, ['qq-memory-rag.service', 'qq-embedding.service']);
  const stopped = runScript(home, 'stop-all.sh', ['--rag']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(enabledOf(home), false);

  const calls = logLines(home.home, 'systemctl');
  assert.ok(calls.includes('--user stop qq-memory-rag.service'), `memory-rag 照常停：${calls.join(' | ')}`);
  assert.equal(calls.some((line) => line.includes('qq-embedding')), false, `不该碰 qq-embedding：${calls.join(' | ')}`);
  assert.match(stopped.stdout, /向量模型：自己部署 \/ 云端，不由本脚本管理/);
});

// ══ 4. .sh 保持一行转发 ════════════════════════════════════════════════
await test('.sh 保留为转发到 Node 编排的一行（老用法不变）', () => {
  for (const [file, target] of [['start-all.sh', 'scripts/start-all.mjs'], ['stop-all.sh', 'scripts/stop-all.mjs']]) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    assert.match(text, /exec node /, `${file} 要调用 node`);
    assert.ok(text.includes(target), `${file} 要转发到 ${target}`);
  }
});

// ══ 5. qqb-helper.sh embed-check：部署方式 ═══════════════════════════════
await test('embed-check：kind=local / cloud → 退出 1 并提示，不查端口、不查显存', () => {
  for (const kind of ['local', 'cloud']) {
    const home = makeHome({ name: `embed-check-${kind}`, settingsKind: kind });
    const result = runHelper(home, ['embed-check', '/x/llama-server', '/x/model.gguf']);
    assert.equal(result.code, 1, `kind=${kind} 要退出 1：${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /不起自带的 embedding/);
    assert.equal(logLines(home.home, 'ss').length, 0, '不该先查 8091 端口');
    assert.equal(logLines(home.home, 'nvidia-smi').length, 0, '不该先查显存');
  }
});

await test('embed-check：bundled / config.yml=local → 照旧查端口和显存', () => {
  for (const options of [{ settingsKind: 'bundled' }, { settingsKind: null, provider: 'local' }]) {
    const home = makeHome({ name: `embed-check-${options.settingsKind ?? 'legacy'}`, ...options });
    const result = runHelper(home, ['embed-check', '/x/llama-server', '/x/model.gguf']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.includes('不起自带的 embedding'), false);
    assert.match(result.stdout, /找不到 llama-server 或 embedding 模型/);
    assert.equal(logLines(home.home, 'ss').length, 1, '要查一次 8091');
    assert.equal(logLines(home.home, 'nvidia-smi').length, 1, '要查一次显存');
  }
});

for (const dir of fs.readdirSync(ROOT)) {
  try { fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
}

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
