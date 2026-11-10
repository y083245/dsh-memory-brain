import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createApiHub } from '../src/api-hub.js';
import { createWindowsRagManager } from '../src/process-manager.mjs';
import { createRagControl } from '../src/rag-control.js';

function fixture(t, { uvAvailable = true, existingPython = false, installed = false, failedInstall = false, childExit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-win-rag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'run');
  const ragDir = path.join(root, 'sidecars', 'memory-rag');
  const venvDir = path.join(ragDir, '.venv');
  const venvPython = path.join(venvDir, 'Scripts', 'python.exe');
  const calls = [];
  const uv = path.join(root, 'uv.exe');
  let pythonReady = installed;
  let venvExists = existingPython;
  let serving = false;
  const deps = {
    findExecutable: (name) => name === 'uv.exe' && uvAvailable ? uv : null,
    isFile: (file) => file === venvPython && venvExists,
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === venvPython) return { code: pythonReady ? 0 : 1 };
      if (command === uv && args[0] === 'venv') venvExists = true;
      if (command === uv && args[0] === 'pip') {
        if (failedInstall) return { code: 1, stderr: 'fixture-private-package-credential' };
        pythonReady = true;
      }
      return { code: 0 };
    },
    isPortOpen: async () => false,
    gpuFreeMiB: async () => assert.fail('云端模式不能检测显存'),
    spawnDetached: async ({ command, args, cwd }) => {
      calls.push({ command, args, cwd });
      serving = !childExit;
      return { pid: 4000, child: { exitCode: childExit ? 1 : null, signalCode: null } };
    },
    writePidFile: () => {},
    waitForHealth: async (_port, _seconds, { shouldContinue }) => shouldContinue?.() !== false && serving,
    stopPidFile: async () => { serving = false; return { ok: true }; },
  };
  const manager = createWindowsRagManager({
    root, runDir,
    paths: { ragDir, ragPython: null },
    deps,
  });
  const fetchImpl = async (url) => {
    if (url === 'https://fixture.invalid/v1/embeddings') {
      return { ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) };
    }
    if (!serving) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ ok: true, embedding: { healthy: true } }) };
  };
  const ctl = createRagControl({
    root, runDir, platform: 'win32', manager, fetchImpl, embeddingKind: () => 'cloud',
    healthTimeoutMs: 15, healthPollMs: 5,
  });
  const hub = createApiHub({ root, stateDir: path.join(root, 'state'), ragControl: ctl, fetchImpl });
  async function waitIdle() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await ctl.state();
      if (!state.busy) return state;
      await sleep(5);
    }
    assert.fail('RAG 启动未结束');
  }
  return { ctl, hub, calls, ragDir, venvDir, venvPython, uv, waitIdle };
}

test('Windows 云端配置测试通过后，首次开启自动准备项目 Python 并启动 RAG', async (t) => {
  const f = fixture(t);
  await f.ctl.setEnabled(true);
  const response = await f.hub.testEmbedding({
    kind: 'cloud', cloud: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture' }, apiKey: 'fixture-only',
  });
  assert.equal(response.body.ok, true);
  assert.equal((await f.waitIdle()).phase, 'running');
  assert.deepEqual(f.calls.filter((c) => c.command === f.uv).map((c) => c.args), [
    ['venv', '--allow-existing', '--python', '3.12', f.venvDir],
    ['pip', 'install', '--python', f.venvPython, '-e', '.'],
  ]);
  assert.deepEqual(f.calls.at(-1), {
    command: f.venvPython, args: ['-W', 'ignore::SyntaxWarning', '-m', 'memory_rag.app'], cwd: f.ragDir,
  });
});

test('Windows 重试复用已装好的虚拟环境，无需 uv', async (t) => {
  const f = fixture(t, { uvAvailable: false, existingPython: true, installed: true });
  await f.ctl.setEnabled(true);
  assert.equal((await f.waitIdle()).phase, 'running');
  assert.ok(f.calls.every((c) => c.command === f.venvPython));
  await f.ctl.withLock(() => f.ctl.restartMemoryRag({ embeddingBefore: 'cloud', embeddingAfter: 'cloud' }));
  assert.equal((await f.ctl.state()).phase, 'running');
  assert.equal(f.calls.filter((c) => c.args.includes('memory_rag.app')).length, 2);
});

test('Windows 已有空虚拟环境时只补依赖', async (t) => {
  const f = fixture(t, { existingPython: true });
  await f.ctl.setEnabled(true);
  assert.equal((await f.waitIdle()).phase, 'running');
  assert.deepEqual(f.calls.filter((c) => c.command === f.uv).map((c) => c.args[0]), ['pip']);
});

test('Windows 找不到可用环境和 uv 时，控制台给出可操作的失败原因', async (t) => {
  const f = fixture(t, { uvAvailable: false });
  await f.ctl.setEnabled(true);
  const state = await f.waitIdle();
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /Python.*uv/);
  assert.deepEqual(f.calls, []);
});

test('Windows 安装依赖失败时报告安装阶段，不泄露安装器输出', async (t) => {
  const f = fixture(t, { failedInstall: true });
  await f.ctl.setEnabled(true);
  const state = await f.waitIdle();
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /安装.*依赖/);
  assert.doesNotMatch(state.reason, /fixture-private/);
  assert.ok(!f.calls.some((c) => c.args.includes('memory_rag.app')));
});

test('Windows Python 子进程退出时提示查看 RAG 日志', async (t) => {
  const f = fixture(t, { existingPython: true, installed: true, childExit: true });
  await f.ctl.setEnabled(true);
  const state = await f.waitIdle();
  assert.equal(state.phase, 'failed');
  assert.match(state.reason, /已退出.*memory-rag\.log/);
});
