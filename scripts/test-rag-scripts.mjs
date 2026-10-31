// scripts/rag-config.py + start-all.sh / stop-all.sh 的 RAG 开关部分单测
// （APIHUB_PATCH；约定 docs/design/worker-kit/apihub/contract.md §6）。
//
// 为什么这么小心：stop-all.sh 的 sd() 会把 XDG_RUNTIME_DIR 默认成 /run/user/<uid>，一旦真调到
// systemctl，就会把线上的 qq-memory-rag / qq-embedding 停掉；端口兜底还会按 ss 的结果 kill 进程。
// 所以这里：
//   1. 在系统临时目录下的 home-<随机>/ 造一个假 HOME，把脚本、rag-config.py、qqb-helper.sh **复制**进去；
//   2. 假命令目录放在 PATH 最前面（systemctl / systemd-run / ss / curl / nvidia-smi / nohup / setsid /
//      pgrep / pkill / fuser / lsof 全是记录参数后 exit 0 的脚本），子进程环境只有 HOME / PATH /
//      XDG_RUNTIME_DIR 三个变量；
//   3. 每个用例运行前自检 `command -v systemctl` 确实指向假命令目录，否则整个测试立刻失败；
//   4. 只运行复制进去的那份脚本，且只用 `--rag` 模式（整套模式会去起 / 停 DSH、QQ）。
//      「整套模式下 enabled 决定起不起 RAG」用 rag-config.py 的单元测试 + 对源码调用点的检查覆盖。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 每次运行一个新的系统临时目录（os.tmpdir()），不和别的测试 / worker 共用。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-rag-scripts-'));
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
fs.mkdirSync(ROOT, { recursive: true });
const TMP_DIRS = [];
function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  TMP_DIRS.push(dir);
  return dir;
}

// ── 假命令目录 ─────────────────────────────────────────────────────────
const FAKE_BIN = tempDir('fakebin');
TMP_DIRS.push(FAKE_BIN);

/** 假命令：把参数追加到 $HOME/.fake-log/<名字>.log，然后按脚本决定输出 / 退出码。 */
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

// ss 什么都不输出：端口一律「没在监听」，脚本不会去杀任何进程。
fakeCommand('ss', 'echo "$*" >> "$HOME/.fake-log/ss.log"\nexit 0');
// curl 对任何 /health 都回「活着」：等待健康立刻通过，不用真的等。
fakeCommand('curl', 'echo "$*" >> "$HOME/.fake-log/curl.log"\nprintf \'%s\' \'{"status":"ok","embedding":{}}\'\nexit 0');
// 显存一律充足；同时记一笔调用，好断言 embed-check 到底有没有查显存。
fakeCommand('nvidia-smi', 'echo "$*" >> "$HOME/.fake-log/nvidia-smi.log"\necho 24000\nexit 0');
for (const name of ['systemd-run', 'nohup', 'setsid', 'pgrep', 'pkill', 'fuser', 'lsof']) {
  fakeCommand(name, `echo "$*" >> "$HOME/.fake-log/${name}.log"\nexit 0`);
}

/** 子进程环境：只给这三个变量（不传 DBUS_SESSION_BUS_ADDRESS，免得真连上会话总线）。 */
function envFor(home, { path: pathValue } = {}) {
  return {
    HOME: home,
    PATH: pathValue ?? `${FAKE_BIN}:/usr/bin:/bin`,
    XDG_RUNTIME_DIR: path.join(home, 'run'),
    // APIHUB_PATCH：EMBED_BIN / EMBED_MODEL 指向假 HOME 里的假文件。发布版 start-all.sh 的模型路径是占位
    // （/path/to/…gguf），不给的话 embed-check 判「找不到模型」、不去起 embedding，用例就依赖了作者本机
    // 真有模型文件。作者本机的 start-all.sh 不读这两个变量，照样用自己的真路径。
    EMBED_BIN: path.join(home, 'llama.cpp', 'build', 'bin', 'llama-server'),
    EMBED_MODEL: path.join(home, 'models', 'fake-embedding.gguf'),
  };
}

/**
 * 隔离自检：`command -v systemctl` 必须正好是假命令目录里的那个。
 * 不是就抛——整个测试会立刻失败退出，不再运行任何脚本（否则可能停掉线上服务）。
 */
function checkIsolation(env) {
  const result = spawnSync('/bin/bash', ['-c', 'command -v systemctl'], { env, encoding: 'utf8' });
  const resolved = String(result.stdout ?? '').trim();
  const expected = path.join(FAKE_BIN, 'systemctl');
  if (resolved !== expected) {
    throw new Error(`隔离自检失败：systemctl 指向 ${resolved || '（找不到）'}，不是 ${expected}；拒绝运行任何脚本`);
  }
  return resolved;
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

// ── 假 HOME 夹具 ───────────────────────────────────────────────────────
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
 *   qq-bridge/{start-all.sh,stop-all.sh,scripts/rag-config.py,scripts/systemd/qqb-helper.sh}
 *   qq-bridge/{config.json,state/long-memory/rag/embedding-settings.json,sidecars/memory-rag/config.yml}
 *   .config/systemd/user/qq-*.service（模拟已安装单元）、.ai-companion-run/、run/
 */
function makeHome({ name, units = true, settingsKind = 'bundled', provider = 'local', config = BASE_CONFIG }) {
  const home = tempDir(name);
  const bridge = path.join(home, 'qq-bridge');
  fs.mkdirSync(path.join(bridge, 'scripts', 'systemd'), { recursive: true });

  for (const file of ['start-all.sh', 'stop-all.sh']) {
    fs.copyFileSync(path.join(REPO, file), path.join(bridge, file));
  }
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

  // start_rag 会检查这几个文件在不在（真机上是 llama-server 与 memory-rag 的 venv）。
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
  checkIsolation(env); // 每个用例运行前自检
  clearLogs(homeInfo.home);
  const result = spawnSync('/bin/bash', [path.join(homeInfo.bridge, script), ...args], {
    env,
    cwd: homeInfo.home,
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

/**
 * 直接跑复制进假 HOME 的那份 qqb-helper.sh（不经过 start-all.sh）。
 * embed-check 分支要跑 rag-config.py，所以 PATH 里必须留着真的 python3（/usr/bin）。
 */
function runHelper(homeInfo, args) {
  const env = envFor(homeInfo.home);
  checkIsolation(env);
  clearLogs(homeInfo.home);
  const result = spawnSync('/bin/bash',
    [path.join(homeInfo.bridge, 'scripts', 'systemd', 'qqb-helper.sh'), ...args], {
      env,
      cwd: homeInfo.home,
      encoding: 'utf8',
      timeout: 30000,
    });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function markActive(homeInfo, units) {
  for (const unit of units) {
    writeFile(path.join(homeInfo.home, '.fake-state', unit), 'active\n');
  }
}

const enabledOf = (homeInfo) => JSON.parse(fs.readFileSync(homeInfo.configPath, 'utf8')).memoryRag.enabled;
const modeOf = (file) => fs.statSync(file).mode & 0o777;

// ══ 1. rag-config.py 单元测试 ═══════════════════════════════════════════
await test('rag-config get-enabled：缺省 / true / 非布尔 / 坏 JSON 都是 false，退出码 0', () => {
  const home = makeHome({ name: 'cfg-get', settingsKind: null });
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).stdout, 'false');

  writeJson(home.configPath, { memoryRag: { enabled: true } });
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).stdout, 'true');

  writeJson(home.configPath, { memoryRag: { enabled: 'yes' } });
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).stdout, 'false');

  writeJson(home.configPath, {});
  assert.equal(runRagConfig(home, ['get-enabled', home.bridge]).stdout, 'false');

  writeFile(home.configPath, '{ 这不是 JSON', 0o600);
  const broken = runRagConfig(home, ['get-enabled', home.bridge]);
  assert.equal(broken.code, 0, '读失败也要退出 0，脚本才不会被拦住');
  assert.equal(broken.stdout, 'false');
  assert.match(broken.stderr, /按 false 处理/);
});

await test('rag-config set-enabled：只改 enabled，其它键原样、权限保持 600', () => {
  const home = makeHome({ name: 'cfg-set', settingsKind: null });
  const before = JSON.parse(fs.readFileSync(home.configPath, 'utf8'));
  const result = runRagConfig(home, ['set-enabled', home.bridge, 'true']);
  assert.equal(result.code, 0, result.stderr);
  const after = JSON.parse(fs.readFileSync(home.configPath, 'utf8'));
  assert.equal(after.memoryRag.enabled, true);
  assert.equal(after.memoryRag.url, before.memoryRag.url, 'memoryRag 下其它键保留');
  assert.deepEqual(after.dsh, before.dsh);
  assert.deepEqual(after.webSearch, before.webSearch);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.equal(modeOf(home.configPath), 0o600);

  // 再写回 false
  assert.equal(runRagConfig(home, ['set-enabled', home.bridge, 'false']).code, 0);
  assert.equal(enabledOf(home), false);

  // 没有 memoryRag 段时新建一段
  writeJson(home.configPath, { dsh: { baseUrl: 'http://127.0.0.1:3080' } });
  assert.equal(runRagConfig(home, ['set-enabled', home.bridge, 'true']).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(home.configPath, 'utf8')),
    { dsh: { baseUrl: 'http://127.0.0.1:3080' }, memoryRag: { enabled: true } });
});

await test('rag-config set-enabled：config.json 不存在 → 退出码 1、不创建；坏 JSON 不改', () => {
  const home = makeHome({ name: 'cfg-missing', settingsKind: null });
  fs.rmSync(home.configPath);
  const missing = runRagConfig(home, ['set-enabled', home.bridge, 'true']);
  assert.equal(missing.code, 1);
  assert.equal(fs.existsSync(home.configPath), false, '不存在就不创建');

  writeFile(home.configPath, '{ 坏掉', 0o600);
  const broken = runRagConfig(home, ['set-enabled', home.bridge, 'true']);
  assert.equal(broken.code, 1);
  assert.equal(fs.readFileSync(home.configPath, 'utf8'), '{ 坏掉', '坏文件一个字节都不改');
});

await test('rag-config embedding-managed：设置文件 bundled/local/cloud + 无设置文件时 provider local/api', () => {
  const bundled = makeHome({ name: 'managed-bundled', settingsKind: 'bundled' });
  assert.equal(runRagConfig(bundled, ['embedding-managed', bundled.bridge]).stdout, 'yes');

  const local = makeHome({ name: 'managed-local', settingsKind: 'local' });
  assert.equal(runRagConfig(local, ['embedding-managed', local.bridge]).stdout, 'no');

  const cloud = makeHome({ name: 'managed-cloud', settingsKind: 'cloud' });
  assert.equal(runRagConfig(cloud, ['embedding-managed', cloud.bridge]).stdout, 'no');

  const legacyLocal = makeHome({ name: 'managed-legacy-local', settingsKind: null, provider: 'local' });
  assert.equal(runRagConfig(legacyLocal, ['embedding-managed', legacyLocal.bridge]).stdout, 'yes');

  const legacyApi = makeHome({ name: 'managed-legacy-api', settingsKind: null, provider: 'api' });
  assert.equal(runRagConfig(legacyApi, ['embedding-managed', legacyApi.bridge]).stdout, 'no');
});

// ══ 2. 已安装单元 + managed=yes ═════════════════════════════════════════
await test('已安装单元 + managed=yes：start-all.sh --rag 写 true 并起两个单元，stop-all.sh --rag 写 false 并停两个单元', () => {
  const home = makeHome({ name: 'units-managed', settingsKind: 'bundled' });
  assert.equal(enabledOf(home), undefined, '夹具里还没有 enabled');

  const started = runScript(home, 'start-all.sh', ['--rag']);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(enabledOf(home), true, 'start-all.sh --rag 要把开关写成 true');

  const startCalls = logLines(home.home, 'systemctl');
  assert.ok(startCalls.includes('--user start qq-embedding.service'), `要起 embedding：${startCalls.join(' | ')}`);
  assert.ok(startCalls.includes('--user start qq-memory-rag.service'), `要起 memory-rag：${startCalls.join(' | ')}`);
  assert.match(started.stdout, /embedding 已就绪/, '等了健康');
  assert.match(started.stdout, /memory-rag 已就绪/);

  markActive(home, ['qq-embedding.service', 'qq-memory-rag.service']);
  const stopped = runScript(home, 'stop-all.sh', ['--rag']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(enabledOf(home), false, 'stop-all.sh --rag 要把开关写成 false');

  const stopCalls = logLines(home.home, 'systemctl');
  assert.ok(stopCalls.includes('--user stop qq-embedding.service'), `要停 embedding：${stopCalls.join(' | ')}`);
  assert.ok(stopCalls.includes('--user stop qq-memory-rag.service'), `要停 memory-rag：${stopCalls.join(' | ')}`);
  // managed=yes 时会分别看一眼 8093、8091 两个端口（这里留作 managed=no 的对照）
  assert.equal(logLines(home.home, 'ss').length, 2, 'managed=yes 要查 8093 和 8091');
});

// ══ 3. 已安装单元 + managed=no ══════════════════════════════════════════
await test('managed=no（自己部署的本地服务）：start 只起 memory-rag，完全不碰 qq-embedding', () => {
  const home = makeHome({ name: 'units-managed-no', settingsKind: 'local' });
  const started = runScript(home, 'start-all.sh', ['--rag']);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(enabledOf(home), true);

  const calls = logLines(home.home, 'systemctl');
  assert.ok(calls.includes('--user start qq-memory-rag.service'), `memory-rag 照常起：${calls.join(' | ')}`);
  // 唯一允许出现的 qq-embedding 调用是原有 use_unit 的「装没装」查询（LoadState），
  // 不是启停：不起单元、不 reset-failed、不看它的 ActiveState。
  const embedCalls = calls.filter((line) => line.includes('qq-embedding'));
  assert.deepEqual(embedCalls, ['--user show -p LoadState --value qq-embedding.service'],
    `不该启停或等待 qq-embedding：${embedCalls.join(' | ')}`);
  assert.equal(logLines(home.home, 'curl').some((line) => line.includes(':8091/health')), false, '也不该等 8091 的健康');
  assert.match(started.stdout, /向量模型：自己部署 \/ 云端，不由本脚本管理/);
});

await test('managed=no：stop 只停 memory-rag，不停 qq-embedding、不按 8091 端口找进程', () => {
  const home = makeHome({ name: 'units-managed-no-stop', settingsKind: 'cloud' });
  markActive(home, ['qq-memory-rag.service', 'qq-embedding.service']);
  const stopped = runScript(home, 'stop-all.sh', ['--rag']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(enabledOf(home), false);

  const calls = logLines(home.home, 'systemctl');
  assert.ok(calls.includes('--user stop qq-memory-rag.service'), `memory-rag 照常停：${calls.join(' | ')}`);
  assert.equal(calls.some((line) => line.includes('qq-embedding')), false, `不该碰 qq-embedding：${calls.join(' | ')}`);

  // ss 不带端口参数（端口是在管道里 grep 的），所以只能数调用次数：
  // managed=yes 时是 2 次（8093 + 8091），managed=no 时只该剩 1 次（8093）。
  const ssCalls = logLines(home.home, 'ss');
  assert.equal(ssCalls.length, 1, `只该查一次端口（8093），实际：${ssCalls.join(' | ')}`);
  assert.match(stopped.stdout, /向量模型：自己部署 \/ 云端，不由本脚本管理/);
});

// ══ 4. qqb-helper.sh embed-check：部署方式（APIHUB_PATCH）════════════════
// qq-embedding 的 ExecCondition 就是它。memory-rag 的 Wants=、控制台开关、start-all.sh、
// 开机自启、崩溃重启都会经过这一关：用户选了「自己部署 / 云端」就必须在这里被拦住，
// 而且要在查端口、查显存之前拦住（否则还会白调 nvidia-smi、白打印显存不足的误导提示）。
await test('embed-check：kind=local / cloud → 退出 1 并提示，不查端口、不查显存', () => {
  for (const kind of ['local', 'cloud']) {
    const home = makeHome({ name: `embed-check-${kind}`, settingsKind: kind });
    const result = runHelper(home, ['embed-check', '/x/llama-server', '/x/model.gguf']);
    assert.equal(result.code, 1, `kind=${kind} 要退出 1（ExecCondition 不满足）：${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /不起自带的 embedding/, `kind=${kind} 要说明为什么不起`);
    assert.equal(logLines(home.home, 'ss').length, 0, '不该先查 8091 端口');
    assert.equal(logLines(home.home, 'nvidia-smi').length, 0, '不该先查显存');
  }
});

await test('embed-check：kind=bundled / 没有设置文件且 config.yml=local → 照旧查端口和显存', () => {
  const cases = [
    { name: 'embed-check-bundled', options: { settingsKind: 'bundled' } },
    { name: 'embed-check-legacy', options: { settingsKind: null, provider: 'local' } },
  ];
  for (const { name, options } of cases) {
    const home = makeHome({ name, ...options });
    const result = runHelper(home, ['embed-check', '/x/llama-server', '/x/model.gguf']);
    // 假 nvidia-smi 显存充足，但 /x/llama-server、/x/model.gguf 不存在 → 走到原来的「找不到文件」。
    assert.equal(result.code, 1, `${name}：${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.includes('不起自带的 embedding'), false, `${name} 不该走「不归本脚本管」那条`);
    assert.match(result.stdout, /找不到 llama-server 或 embedding 模型/, `${name} 要走原来的文件检查`);
    assert.equal(logLines(home.home, 'ss').length, 1, `${name} 要查一次 8091`);
    assert.equal(logLines(home.home, 'nvidia-smi').length, 1, `${name} 要查一次显存`);
  }
});

// ══ 5. 整套模式：源码调用点检查（不运行整套脚本）═══════════════════════
await test('源码里：整套 start-all.sh 用 get-enabled 决定起不起 RAG，stop-all.sh --rag 写 false', () => {
  const start = fs.readFileSync(path.join(REPO, 'start-all.sh'), 'utf8');
  const stop = fs.readFileSync(path.join(REPO, 'stop-all.sh'), 'utf8');
  assert.match(start, /get-enabled "\$BRIDGE_DIR"/, 'start-all.sh 要读 config.json 的开关');
  assert.match(start, /set-enabled "\$BRIDGE_DIR" true/, 'START_RAG=1 / --rag 要写 true');
  assert.match(start, /if \[ "\$RAG_ENABLED" != "1" \]; then/, 'start_rag 的门槛换成 RAG_ENABLED');
  assert.match(stop, /set-enabled "\$BRIDGE_DIR" false/, 'stop-all.sh --rag 要写 false');
  // 整套模式（不带 --rag）里没有 set-enabled：只是顺带停服务，不改开关。
  const fullMode = stop.slice(stop.indexOf('if [ "$RAG_ONLY" = "1" ]; then') + 1);
  assert.equal(fullMode.length > 0, true);
  assert.equal((stop.match(/set-enabled/g) || []).length, 1, 'stop-all.sh 只有 --rag 那一处写开关');
});

// ══ 6. 自检本身 ════════════════════════════════════════════════════════
await test('自检：真 PATH 放在假命令目录前面时，能发现并拒绝运行', () => {
  const home = makeHome({ name: 'guard', settingsKind: 'bundled' });
  // 正常环境通过
  assert.equal(checkIsolation(envFor(home.home)), path.join(FAKE_BIN, 'systemctl'));
  // 把系统的 /usr/bin 放前面 → 自检必须失败（这样才不会真的去 systemctl stop 线上服务）
  assert.throws(
    () => checkIsolation(envFor(home.home, { path: `/usr/bin:/bin:${FAKE_BIN}` })),
    /隔离自检失败/,
  );
});

for (const dir of TMP_DIRS) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
}

if (failures) {
  console.error(`\n${failures} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
