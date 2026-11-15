#!/usr/bin/env node
// CI: start the real bridge and DSH web from a clean, isolated checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isPortOpen } from '../src/runtime/ports.mjs';
import { EMBED_PORT, RAG_PORT } from '../src/runtime/rag-services.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-no-qq-'));
const repo = path.join(fixture, 'dsh-memory-brain (no QQ)');
const home = path.join(fixture, 'home');
const runDir = path.join(home, '.ai-companion-run');
fs.mkdirSync(home);

const sidecarPorts = [EMBED_PORT, RAG_PORT, 9880];
const isolateStop = path.join(fixture, 'isolate-stop.cjs');
// Only the bridge and DSH belong to this fixture. Keep stop-all's fallback
// process discovery away from sidecars running on the developer's machine.
fs.writeFileSync(isolateStop, `
const { EventEmitter } = require('node:events');
const net = require('node:net');
const connect = net.connect;
net.connect = function (options, ...args) {
  if (!${JSON.stringify(sidecarPorts)}.includes(options?.port)) {
    return connect.call(this, options, ...args);
  }
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit('error', new Error('Sidecar fixture port is closed')));
  return socket;
};
`);

async function loopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let dshPort;
do { dshPort = await loopbackPort(); } while (sidecarPorts.includes(dshPort));
let consolePort;
do { consolePort = await loopbackPort(); } while (consolePort === dshPort || sidecarPorts.includes(consolePort));
const baseUrl = `http://127.0.0.1:${consolePort}`;
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  DSH_HOME: path.join(home, '.dsh'),
  QQB_RUN_DIR: runDir,
  QQB_ASSUME_YES: '1',
  QQB_ONEBOT_WAIT_SECONDS: '1',
  NPM_CONFIG_CACHE: path.join(fixture, 'npm-cache'),
  NPM_CONFIG_FETCH_RETRIES: '0',
};
for (const key of [
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DSH_LAUNCH_TOKEN',
  'DSH_CHANNEL_TOOL_PORT', 'DSH_CHANNEL_TOOL_SECRET', 'FEISHU_APP_SECRET', 'TELEGRAM_BOT_TOKEN',
  'START_RAG', 'START_GSV', 'START_SNOWLUMA',
]) delete env[key];

function command(file, args) {
  const nodeArgs = file === 'stop-all.mjs' ? ['--require', isolateStop] : [];
  const result = spawnSync(process.execPath, [...nodeArgs, path.join(repo, 'scripts', file), ...args], {
    cwd: repo, env, encoding: 'utf8', timeout: 360_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

function configure(qqEnabled, feishuEnabled = true) {
  fs.writeFileSync(path.join(repo, 'config.json'), JSON.stringify({
    channels: {
      qq: { enabled: qqEnabled },
      feishu: { enabled: feishuEnabled },
      telegram: { enabled: false },
      textTools: false,
    },
    dsh: { target: 'web', baseUrl: `http://127.0.0.1:${dshPort}` },
    consolePort,
  }));
}

async function readStatus(expectedQq, feishuEnabled = true) {
  const token = fs.readFileSync(path.join(repo, 'state', 'console-token'), 'utf8').trim();
  const deadline = Date.now() + 8000;
  let status;
  do {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-console-token': token }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    status = await response.json();
    if (status.dshReady) break;
    await sleep(200);
  } while (Date.now() < deadline);
  assert.equal(status.dshReady, true);
  assert.deepEqual(status.channels.qq, expectedQq);
  assert.deepEqual(status.channels.feishu, { enabled: feishuEnabled, state: feishuEnabled ? 'awaiting_adapter' : 'disabled' });
  assert.deepEqual(status.channels.telegram, { enabled: false, state: 'disabled' });
}

async function assertStopped(port) {
  const deadline = Date.now() + 4000;
  while (await isPortOpen(port)) {
    assert.ok(Date.now() < deadline, `Fixture port ${port} remained open after shutdown`);
    await sleep(100);
  }
}

try {
  const publicEntries = ['package.json', 'package-lock.json', '.npmrc', 'src', 'scripts', 'plugins', 'dsh', 'roles', 'public'];
  fs.mkdirSync(repo);
  for (const entry of publicEntries) fs.cpSync(path.join(root, entry), path.join(repo, entry), { recursive: true });
  configure(false);
  const lockFile = path.join(repo, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const blockedPort = await loopbackPort();
  for (const pkg of ['@snowluma/sdk', '@snowluma/mcp']) {
    // npm should never have to fetch these locked tarballs in the no-QQ install.
    lock.packages[`node_modules/${pkg}`].resolved = `http://127.0.0.1:${blockedPort}/${pkg}.tgz`;
  }
  fs.writeFileSync(lockFile, JSON.stringify(lock));

  const first = command('start-all.mjs', ['--web']);
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /首次运行：安装依赖（npm ci .*--omit=optional）/);
  assert.match(first.output, /DSH 已注册渠道预设/);
  assert.match(first.output, /桥接与 DSH 已就绪/);
  assert.doesNotMatch(first.output, /\[patch-snowluma\]|OneBot|管理员 QQ|启动 QQ|找不到 SnowLuma/);
  for (const name of ['sdk', 'mcp']) assert.equal(fs.existsSync(path.join(repo, 'node_modules', '@snowluma', name)), false);
  await readStatus({ enabled: false, state: 'disabled' });
  console.log('QQ disabled: clean install, real DSH and bridge ready without SnowLuma dependencies.');

  const firstStop = command('stop-all.mjs', []);
  assert.equal(firstStop.code, 0, firstStop.output);
  assert.doesNotMatch(firstStop.output, /OneBot|SnowLuma|停止 QQ/);
  await assertStopped(consolePort);

  configure(true);
  const degraded = command('start-all.mjs', ['--web']);
  assert.equal(degraded.code, 0, degraded.output);
  assert.match(degraded.output, /QQ 暂不可用：SnowLuma SDK 缺失或加载失败/);
  assert.doesNotMatch(degraded.output, /首次运行：安装依赖|等待.*OneBot/);
  await readStatus({ enabled: true, state: 'missing_dependency' });
  console.log('Missing QQ SDK: bridge and DSH remain available for the enabled Feishu entry.');

  configure(false);
  const mixedStop = command('stop-all.mjs', []);
  assert.equal(mixedStop.code, 0, mixedStop.output);
  await assertStopped(consolePort);

  configure(true, false);
  const qqOnly = command('start-all.mjs', ['--web']);
  assert.equal(qqOnly.code, 0, qqOnly.output);
  assert.match(qqOnly.output, /QQ 暂不可用：SnowLuma SDK 缺失或加载失败/);
  assert.match(qqOnly.output, /桥接与 DSH 已就绪/);
  assert.doesNotMatch(qqOnly.output, /首次运行：安装依赖|OneBot|管理员 QQ \/ 白名单/);
  await readStatus({ enabled: true, state: 'missing_dependency' }, false);
  console.log('Missing QQ SDK in QQ-only mode: bridge and DSH remain available.');
} finally {
  if (fs.existsSync(path.join(repo, 'node_modules'))) {
    configure(false);
    const stop = command('stop-all.mjs', ['--all']);
    assert.equal(stop.code, 0, stop.output);
    await assertStopped(consolePort);
    await assertStopped(dshPort);
  }
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
}
