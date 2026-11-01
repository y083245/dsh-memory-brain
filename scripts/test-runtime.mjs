// src/runtime/* 的跨平台单测：端口探测、PID 文件、Python 解析、RAG 开关、路径覆盖。
// 全部使用临时目录 / 本地回环端口，不碰真实服务与 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { isPortOpen, waitForPort } from '../src/runtime/ports.mjs';
import { spawnDetached, stopPid, isPidAlive, readPidFile, writePidFile } from '../src/runtime/process.mjs';
import { resolvePython } from '../src/runtime/python.mjs';
import { commandSpec } from '../src/runtime/commands.mjs';
import { readRagEnabled, writeRagEnabled, isEmbeddingManaged } from '../src/runtime/rag-config.mjs';
import { findSnowLumaDir, resolveOrchestratorPaths } from '../src/runtime/paths.mjs';
import { fetchHealth } from '../src/runtime/rag-services.mjs';
import { createWindowsRagManager } from '../src/process-manager.mjs';
import { assertPosixMode } from './test-mode.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-runtime-test-'));
let counter = 0;
function tempDir(label) {
  counter += 1;
  const dir = path.join(ROOT, `${label}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

await test('端口探测：net 服务器在监听时 isPortOpen=true，关掉后 waitForPort 超时', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  assert.equal(await isPortOpen(port), true);
  assert.equal(await waitForPort(port, 1), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortOpen(port), false);
  assert.equal(await waitForPort(port, 0.2), false);
});

await test('findSnowLumaDir：按版本号自然排序挑最新可启动目录', () => {
  const home = tempDir('home');
  for (const version of ['2.9', '2.10']) {
    const dir = path.join(home, 'snowluma', `SnowLuma-v${version}-lite`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.mjs'), '');
  }
  const found = findSnowLumaDir({ home, platform: process.platform, env: {} });
  assert.match(found, /SnowLuma-v2\.10-lite$/);
});

await test('resolveOrchestratorPaths：config.orchestrator 被环境变量覆盖', () => {
  const root = tempDir('repo');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    orchestrator: { runDir: path.join(root, 'cfg-run'), qqBin: path.join(root, 'cfg-qq.exe'), dshCommand: ['node', 'dsh.js'] }
  }));
  const fromConfig = resolveOrchestratorPaths({ root, env: {}, home: root, platform: 'win32' });
  assert.equal(fromConfig.runDir, path.join(root, 'cfg-run'));
  assert.equal(fromConfig.qqBin, path.join(root, 'cfg-qq.exe'));
  assert.deepEqual(fromConfig.dshCommand.args, ['dsh.js']);

  const fromEnv = resolveOrchestratorPaths({
    root,
    env: { QQB_RUN_DIR: path.join(root, 'env-run'), QQ_BIN: path.join(root, 'env-qq.exe') },
    home: root,
    platform: 'win32'
  });
  assert.equal(fromEnv.runDir, path.join(root, 'env-run'));
  assert.equal(fromEnv.qqBin, path.join(root, 'env-qq.exe'));

  // sidecars/memory-rag 的 venv 必须解析到 .venv 里面（不是项目根目录）。
  const venvSub = process.platform === 'win32' ? 'Scripts' : 'bin';
  const venvExe = process.platform === 'win32' ? 'python.exe' : 'python';
  const venvPython = path.join(root, 'sidecars', 'memory-rag', '.venv', venvSub, venvExe);
  fs.mkdirSync(path.dirname(venvPython), { recursive: true });
  fs.writeFileSync(venvPython, '');
  const withVenv = resolveOrchestratorPaths({ root, env: {}, home: root, platform: process.platform });
  assert.equal(withVenv.ragPython.source, 'venv');
  assert.equal(withVenv.ragPython.command, venvPython);
});

await test('resolvePython：优先 venv，Windows/Linux 各自的目录结构', () => {
  const venv = tempDir('venv');
  const sub = process.platform === 'win32' ? 'Scripts' : 'bin';
  const exe = process.platform === 'win32' ? 'python.exe' : 'python';
  fs.mkdirSync(path.join(venv, sub), { recursive: true });
  fs.writeFileSync(path.join(venv, sub, exe), '');
  const found = resolvePython({ venvDir: venv });
  assert.equal(found.source, 'venv');
  assert.equal(found.command, path.join(venv, sub, exe));

  const winVenv = tempDir('win-venv');
  fs.mkdirSync(path.join(winVenv, 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(winVenv, 'Scripts', 'python.exe'), '');
  const winFound = resolvePython({ venvDir: winVenv, platform: 'win32', env: {} });
  assert.equal(winFound.command, path.join(winVenv, 'Scripts', 'python.exe'));
});

await test('rag-config：enabled 只认 true；写入保留其它键；kind 决定 embedding 是否归本项目管', async () => {
  const root = tempDir('rag');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ dsh: { baseUrl: 'x' }, memoryRag: { enabled: false, url: 'u' } }), { mode: 0o600 });
  fs.chmodSync(path.join(root, 'config.json'), 0o600);
  assert.equal(readRagEnabled(root), false);
  await writeRagEnabled(root, true);
  assert.equal(readRagEnabled(root), true);
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(doc.dsh.baseUrl, 'x');
  assert.equal(doc.memoryRag.url, 'u');
  assertPosixMode(path.join(root, 'config.json'), 0o600, 'config.json 权限 600');

  fs.mkdirSync(path.join(root, 'state', 'long-memory', 'rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'long-memory', 'rag', 'embedding-settings.json'), JSON.stringify({ kind: 'bundled' }));
  assert.equal(isEmbeddingManaged(root), true);
  fs.writeFileSync(path.join(root, 'state', 'long-memory', 'rag', 'embedding-settings.json'), JSON.stringify({ kind: 'local' }));
  assert.equal(isEmbeddingManaged(root), false);
  fs.rmSync(path.join(root, 'state'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'sidecars', 'memory-rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sidecars', 'memory-rag', 'config.yml'), 'embedding:\n  provider: api\n');
  assert.equal(isEmbeddingManaged(root), false);
});

await test('commandSpec：Windows .cmd 垫片优先解析成 node + JS 入口', () => {
  const dir = tempDir('shim');
  const bin = path.join(dir, 'node_modules', 'foo', 'bin.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  const cmd = path.join(dir, 'foo.cmd');
  fs.writeFileSync(cmd, '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\foo\\bin.js" %*\r\n');
  const spec = commandSpec(cmd, ['a'], { platform: 'win32', env: { PATHEXT: '.EXE;.CMD' }, nodeBin: process.execPath });
  assert.equal(spec.via, 'node-shim');
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args.slice(1), ['a']);
});

await test('commandSpec：Electron 的 .cmd 垫片不能被当成普通 node 垫片', () => {
  const dir = tempDir('electron-shim');
  const js = path.join(dir, 'cli.js');
  fs.writeFileSync(js, '');
  const cmd = path.join(dir, 'dsh.cmd');
  fs.writeFileSync(cmd, '@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0electron.exe" "%~dp0cli.js" %*\r\n');
  const spec = commandSpec(cmd, ['web'], { platform: 'win32', env: { ComSpec: 'cmd.exe' }, nodeBin: process.execPath });
  assert.equal(spec.via, 'cmd-shim');
  assert.equal(spec.command, 'cmd.exe');
});

await test('PID 文件 + detached 启动 + stopPid 真的收掉子进程', async () => {
  const runDir = tempDir('run');
  const logFile = path.join(runDir, 'child.log');
  const spawned = await spawnDetached({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: ROOT,
    logFile,
    platform: process.platform
  });
  const pidFile = path.join(runDir, 'child.pid');
  writePidFile(pidFile, spawned.pid);
  assert.equal(readPidFile(pidFile), spawned.pid);
  assert.equal(isPidAlive(spawned.pid), true);
  const result = await stopPid(spawned.pid, { platform: process.platform, timeoutMs: 8000 });
  assert.equal(result.ok, true, result.reason);
  await sleep(200);
  assert.equal(isPidAlive(spawned.pid), false);
});

await test('Windows RAG 管理器：pid 模式、installed=false、启停走注入的 spawn/stop', async () => {
  const runDir = tempDir('win-rag-run');
  const spawns = [];
  const stops = [];
  const manager = createWindowsRagManager({
    root: tempDir('win-rag-root'),
    runDir,
    platform: 'win32',
    paths: {
      home: tempDir('win-rag-home'),
      embedBin: 'C:/fake/llama-server.exe',
      embedModel: 'C:/fake/model.gguf',
      ragDir: 'C:/fake/rag',
      ragPython: { command: 'python.exe', args: [] }
    },
    deps: {
      isPortOpen: async () => false,
      gpuFreeMiB: async () => 24000,
      isFile: () => true,
      spawnDetached: async (options) => { spawns.push(path.basename(options.logFile)); return { pid: 4000 + spawns.length }; },
      writePidFile: () => {},
      waitForHealth: async () => true,
      stopPidFile: async ({ label }) => { stops.push(label); return { ok: true }; }
    }
  });
  assert.equal(await manager.detectMode(), 'pid');
  assert.equal(await manager.installed('qq-embedding'), false);
  await manager.start({ managed: true });
  assert.deepEqual(spawns, ['embed.log', 'memory-rag.log']);
  await manager.stop({ managed: true });
  assert.deepEqual(stops, ['memory-rag', 'embedding']);
});

await test('fetchHealth：慢 /health（>3s）也能读到（Windows memory-rag 实测约 4s）', async () => {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, embedding: { healthy: false } }));
    }, 3500);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const started = Date.now();
  const data = await fetchHealth(port);
  assert.ok(Date.now() - started >= 3000, '这个用例要真的跨过旧 3 秒超时');
  assert.equal(data?.embedding?.healthy, false);
  await new Promise((resolve) => server.close(resolve));
});

await test('fetchHealth：本地假 /health 能读到 JSON，关掉后返回 null', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  assert.deepEqual(await fetchHealth(port), { ok: true });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await fetchHealth(port, { timeoutMs: 300 }), null);
});

for (const entry of fs.readdirSync(ROOT)) {
  try { fs.rmSync(path.join(ROOT, entry), { recursive: true, force: true }); } catch { /* 忽略 */ }
}

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
