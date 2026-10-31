// RAG 总开关（src/rag-control.js）的单元测试 —— 全部用假的 execFile / fetch。
//
// 硬性要求：任何一条路径都**不能**真的调 systemctl / start-all.sh。这里每个用例都注入假的
// execFile；文件开头还把 QQB_NO_SYSTEMCTL=1 设上，作为默认实现 `defaultRagExec` 的第二道保险。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRagControl, defaultRagExec } from '../src/rag-control.js';

process.env.QQB_NO_SYSTEMCTL = '1';

// 每次运行一个新的系统临时目录（os.tmpdir()），不和别的测试 / worker 共用。
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-rag-control-'));

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(BASE, `${label}-`));
  return dir;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * 假 execFile：按「命令 + 单元状态」回结果，并记录全部调用。
 * `callOptions` 与 `calls` 平行，记下第三条参数（超时等），用来断言 stop / 脚本的超时。
 */
function makeExec({ mode = 'systemd', units = {}, systemdRun = true } = {}) {
  const calls = [];
  const callOptions = [];
  const exec = async (cmd, args = [], opts = {}) => {
    calls.push([cmd, ...args]);
    callOptions.push({ cmd, args: [...args], opts: { ...opts } });
    if (cmd === 'systemctl' && args[0] === '--user' && args[1] === 'cat') {
      return { code: mode === 'systemd' ? 0 : 1, stdout: '', stderr: '' };
    }
    if (cmd === 'systemctl' && args[0] === '--user' && args[1] === 'is-active') {
      const state = units[args[2]] ?? 'inactive';
      return { code: state === 'active' ? 0 : 3, stdout: state, stderr: '' };
    }
    if (cmd === 'systemd-run' && args[0] === '--version') {
      return { code: systemdRun ? 0 : 1, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls, callOptions };
}

const fetchOk = (health) => async () => ({
  ok: true,
  status: 200,
  json: async () => (typeof health === 'function' ? health() : health)
});
const fetchDown = () => async () => { throw new Error('ECONNREFUSED'); };

function makeCtl(overrides = {}) {
  const root = overrides.root ?? tempDir('root');
  const stateDir = overrides.stateDir ?? tempDir('state');
  const runDir = overrides.runDir ?? tempDir('run');
  const { exec, calls } = overrides.execPair ?? makeExec(overrides.execOptions);
  return {
    calls,
    ctl: createRagControl({
      root,
      stateDir,
      runDir,
      writeEnabled: () => {},
      ...overrides.deps,
      execFile: overrides.deps?.execFile ?? exec,
      // eslint-disable-next-line no-undefined
      fetchImpl: overrides.deps?.fetchImpl ?? overrides.fetchImpl ?? fetchDown(),
      embeddingKind: overrides.deps?.embeddingKind ?? overrides.embeddingKind ?? (() => 'bundled'),
      readEnabled: overrides.deps?.readEnabled ?? overrides.readEnabled ?? (() => false),
      // 测试默认把等待调短，别真的等 150 秒。
      healthTimeoutMs: 300,
      healthPollMs: 10,
      ...overrides.extra
    })
  };
}

/** 等后台任务结束（busy 回到 false）。 */
async function waitIdle(ctl, limitMs = 3000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const st = await ctl.state();
    if (!st.busy) return st;
    await sleep(5);
  }
  throw new Error('后台操作没有结束');
}

// APIHUB_PATCH：start / restart 现在带 `--no-block`，断言序列时先把它滤掉，只看动作与单元名。
const opCalls = (calls) => calls
  .filter(([cmd]) => cmd === 'systemctl')
  .map((c) => c.slice(1).filter((a) => a !== '--no-block'))
  .filter((args) => args[0] === '--user' && ['start', 'stop', 'restart', 'reset-failed'].includes(args[1]))
  .map((args) => args.slice(1).join(' '));

// ── 1. phase 判定（接口约定 §4.1 的判定顺序） ─────────────────────────────

await test('phase：off，但服务仍在跑 → 给出「不是从控制台起的」原因', async () => {
  const { ctl } = makeCtl({
    readEnabled: () => false,
    fetchImpl: fetchOk({ ok: true, embedding: { healthy: true } }),
    execOptions: { units: { 'qq-memory-rag': 'active', 'qq-embedding': 'active' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'off');
  assert.equal(st.reason, '服务仍在运行（不是从控制台起的）');
  assert.equal(st.enabled, false);
  assert.equal(st.mode, 'systemd');
  assert.equal(st.embedding.managed, true);
});

await test('phase：failed —— 单元进了 failed', async () => {
  const { ctl } = makeCtl({
    readEnabled: () => true,
    fetchImpl: fetchDown(),
    execOptions: { units: { 'qq-memory-rag': 'failed' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'failed');
  assert.match(st.reason, /memory-rag\.log/);
});

await test('phase：failed —— 服务没在运行', async () => {
  const { ctl } = makeCtl({ readEnabled: () => true, fetchImpl: fetchDown() });
  const st = await ctl.state();
  assert.equal(st.phase, 'failed');
  assert.equal(st.reason, 'memory-rag 没在运行');
});

await test('phase：partial —— 优先用 /health 的 embedding.error', async () => {
  const { ctl } = makeCtl({
    readEnabled: () => true,
    fetchImpl: fetchOk({ ok: false, embedding: { healthy: false, error: '缺少 model' } }),
    execOptions: { units: { 'qq-memory-rag': 'active', 'qq-embedding': 'inactive' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'partial');
  assert.equal(st.reason, '缺少 model');
});

await test('phase：partial —— embed.log 最后一条 [qqb] 提示（显存不足）', async () => {
  const runDir = tempDir('run');
  fs.writeFileSync(path.join(runDir, 'embed.log'), [
    '[qqb] 空闲显存 20 GB，可以启动',
    'llama-server: loading model',
    '[qqb] 显存空闲 6 GB < 10 GB，跳过 qq-embedding',
    ''
  ].join('\n'));
  const { ctl } = makeCtl({
    runDir,
    readEnabled: () => true,
    fetchImpl: fetchOk({ ok: false, embedding: { healthy: false } }),
    execOptions: { units: { 'qq-memory-rag': 'active', 'qq-embedding': 'inactive' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'partial');
  assert.equal(st.reason, '显存空闲 6 GB < 10 GB，跳过 qq-embedding');
});

await test('phase：partial —— 没有日志时兜底「向量模型连不上」', async () => {
  const { ctl } = makeCtl({
    readEnabled: () => true,
    fetchImpl: fetchOk({ ok: false, embedding: { healthy: false } }),
    execOptions: { units: { 'qq-memory-rag': 'active', 'qq-embedding': 'inactive' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'partial');
  assert.equal(st.reason, '向量模型连不上');
});

await test('phase：running', async () => {
  const { ctl } = makeCtl({
    readEnabled: () => true,
    fetchImpl: fetchOk({ ok: true, embedding: { healthy: true } }),
    execOptions: { units: { 'qq-memory-rag': 'active', 'qq-embedding': 'active' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'running');
  assert.equal(st.embedding.active, true);
  assert.equal(st.memoryRag.healthy, true);
});

await test('phase：mismatch（reason 是 mismatch 原文）', async () => {
  const { ctl } = makeCtl({
    readEnabled: () => true,
    fetchImpl: fetchOk({ ok: false, mismatch: 'model changed to x', embedding: { healthy: true } }),
    execOptions: { units: { 'qq-memory-rag': 'active', 'qq-embedding': 'active' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'mismatch');
  assert.equal(st.reason, 'model changed to x');
});

await test('phase：rebuilding（job 没有 finished_at）', async () => {
  const { ctl } = makeCtl({
    readEnabled: () => true,
    fetchImpl: fetchOk({ ok: true, embedding: { healthy: true }, job: { started_at: 1 } }),
    execOptions: { units: { 'qq-memory-rag': 'active', 'qq-embedding': 'active' } }
  });
  const st = await ctl.state();
  assert.equal(st.phase, 'rebuilding');
  assert.deepEqual(st.job, { started_at: 1 });
});

// ── 2. 打开（systemd + managed） ─────────────────────────────────────────

await test('setEnabled(true)：先落盘、再按 reset-failed → start 的顺序拉起两个单元', async () => {
  const events = [];
  const { exec, calls } = makeExec({ mode: 'systemd', units: { 'qq-memory-rag': 'active', 'qq-embedding': 'active' } });
  const { ctl } = makeCtl({
    deps: {
      readEnabled: () => false,
      writeEnabled: (value) => events.push(['write', value]),
      execFile: async (cmd, args = []) => { events.push(['exec', cmd, ...args]); return exec(cmd, args); },
      fetchImpl: fetchOk({ ok: true, embedding: { healthy: true } }),
      embeddingKind: () => 'bundled'
    }
  });
  const st = await ctl.setEnabled(true);
  assert.equal(st.busy, true, '接口立即回忙状态');
  assert.equal(st.phase, 'starting');
  assert.equal(ctl.enabled(), true, '内存开关立即置开');
  await waitIdle(ctl);
  assert.deepEqual(opCalls(calls), [
    'reset-failed qq-embedding',
    'start qq-embedding',
    'reset-failed qq-memory-rag',
    'start qq-memory-rag'
  ]);
  assert.deepEqual(events[0], ['write', true], 'writeEnabled 必须先于任何命令');
  assert.ok(events.findIndex((e) => e[0] === 'exec') > 0);
  for (const call of opCalls(calls)) {
    assert.match(call, /^[a-z-]+ qq-(embedding|memory-rag)$/, `只允许这两个单元名：${call}`);
  }
});

// ── 2.5 命令的超时与 --no-block（APIHUB_PATCH） ─────────────────────────

await test('systemd：start 带 --no-block，stop 给 60 秒超时且不加 --no-block', async () => {
  const { exec, callOptions } = makeExec({ mode: 'systemd' });
  const { ctl } = makeCtl({
    deps: { readEnabled: () => false, execFile: exec, fetchImpl: fetchOk({ ok: true, embedding: { healthy: true } }), embeddingKind: () => 'bundled' }
  });
  await ctl.setEnabled(true);
  await waitIdle(ctl);

  const starts = callOptions.filter((c) => c.cmd === 'systemctl' && c.args.includes('start'));
  assert.equal(starts.length, 2, `应有两次 start：${JSON.stringify(starts)}`);
  for (const c of starts) {
    assert.deepEqual(c.args.slice(0, 2), ['--user', '--no-block'], `start 必须带 --no-block：${c.args.join(' ')}`);
  }

  await ctl.setEnabled(false);
  await waitIdle(ctl);
  const stops = callOptions.filter((c) => c.cmd === 'systemctl' && c.args.includes('stop'));
  assert.equal(stops.length, 2, `应有两次 stop：${JSON.stringify(stops)}`);
  for (const c of stops) {
    assert.equal(c.opts.timeout, 60000, `stop 必须给 60 秒：${c.args.join(' ')}`);
    assert.ok(!c.args.includes('--no-block'), 'stop 不能加 --no-block（要阻塞着停）');
  }
});

await test('restartMemoryRag：起 / 重启都用 --no-block，停 embedding 给 60 秒', async () => {
  // 1) 云端 → 自带：要先起 embedding（不等就绪），再 restart memory-rag。
  const up = makeExec({ mode: 'systemd' });
  const a = makeCtl({ deps: { execFile: up.exec, fetchImpl: fetchOk({ ok: true }), embeddingKind: () => 'bundled' } });
  await a.ctl.restartMemoryRag({ embeddingBefore: 'cloud', embeddingAfter: 'bundled' });
  const startEmbed = up.callOptions.find((c) => c.cmd === 'systemctl' && c.args.includes('start') && c.args.includes('qq-embedding'));
  assert.ok(startEmbed, `应起 qq-embedding：${JSON.stringify(up.callOptions)}`);
  assert.deepEqual(startEmbed.args, ['--user', '--no-block', 'start', 'qq-embedding']);
  const restart = up.callOptions.find((c) => c.cmd === 'systemctl' && c.args.includes('restart'));
  assert.ok(restart, '应 restart memory-rag');
  assert.deepEqual(restart.args, ['--user', '--no-block', 'restart', 'qq-memory-rag']);

  // 2) 自带 → 云端：要先停 embedding（阻塞、60 秒超时）。
  const down = makeExec({ mode: 'systemd' });
  const b = makeCtl({ deps: { execFile: down.exec, fetchImpl: fetchOk({ ok: true }), embeddingKind: () => 'cloud' } });
  await b.ctl.restartMemoryRag({ embeddingBefore: 'bundled', embeddingAfter: 'cloud' });
  const stopEmbed = down.callOptions.find((c) => c.cmd === 'systemctl' && c.args.includes('stop') && c.args.includes('qq-embedding'));
  assert.ok(stopEmbed, `应停 qq-embedding：${JSON.stringify(down.callOptions)}`);
  assert.equal(stopEmbed.opts.timeout, 60000);
  assert.ok(!stopEmbed.args.includes('--no-block'));
});

// ── 3. 打开（自己部署 / 云端：不碰 qq-embedding） ─────────────────────────

await test('setEnabled(true)：managed=false（local / cloud）只动 qq-memory-rag', async () => {
  for (const kind of ['local', 'cloud']) {
    const { exec, calls } = makeExec({ mode: 'systemd' });
    const { ctl } = makeCtl({
      deps: { readEnabled: () => false, execFile: exec, fetchImpl: fetchOk({ ok: true, embedding: { healthy: true } }), embeddingKind: () => kind }
    });
    await ctl.setEnabled(true);
    await waitIdle(ctl);
    assert.deepEqual(opCalls(calls), ['reset-failed qq-memory-rag', 'start qq-memory-rag'], kind);
  }
});

// ── 4. 关闭 ──────────────────────────────────────────────────────────────

await test('setEnabled(false)：内存值立即为 false，随后先停 memory-rag 再停 embedding', async () => {
  const writes = [];
  const { exec, calls } = makeExec({ mode: 'systemd' });
  const { ctl } = makeCtl({
    deps: {
      readEnabled: () => true,
      writeEnabled: (value) => writes.push(value),
      execFile: exec,
      fetchImpl: fetchDown(),
      embeddingKind: () => 'bundled'
    }
  });
  const st = await ctl.setEnabled(false);
  assert.equal(st.phase, 'stopping');
  assert.equal(ctl.enabled(), false);
  assert.deepEqual(writes, [false]);
  await waitIdle(ctl);
  assert.deepEqual(opCalls(calls), ['stop qq-memory-rag', 'stop qq-embedding']);
});

await test('setEnabled(false)：managed=false 时不停 qq-embedding', async () => {
  const { exec, calls } = makeExec({ mode: 'systemd' });
  const { ctl } = makeCtl({
    deps: { readEnabled: () => true, execFile: exec, fetchImpl: fetchDown(), embeddingKind: () => 'local' }
  });
  await ctl.setEnabled(false);
  await waitIdle(ctl);
  assert.deepEqual(opCalls(calls), ['stop qq-memory-rag']);
});

// ── 5. script 模式 ───────────────────────────────────────────────────────

await test('script 模式：有 systemd-run 时套 scope 调 start-all.sh / stop-all.sh --rag', async () => {
  const root = tempDir('root');
  const { exec, calls, callOptions } = makeExec({ mode: 'script', systemdRun: true });
  const { ctl } = makeCtl({
    root,
    deps: { readEnabled: () => false, execFile: exec, fetchImpl: fetchOk({ ok: true, embedding: { healthy: true } }), embeddingKind: () => 'bundled' }
  });
  await ctl.setEnabled(true);
  await waitIdle(ctl);
  const startCall = calls.find((c) => c[0] === 'systemd-run' && c.includes(path.join(root, 'start-all.sh')));
  assert.ok(startCall, `应套 systemd-run：${JSON.stringify(calls)}`);
  assert.deepEqual(startCall.slice(0, 4), ['systemd-run', '--user', '--scope', '--collect']);
  assert.match(startCall[4], /^--unit=qqb-rag-\d{14}$/);
  assert.deepEqual(startCall.slice(5), [path.join(root, 'start-all.sh'), '--rag']);
  // APIHUB_PATCH：脚本里会等健康，超时放到 180 秒。
  const startOpts = callOptions.find((c) => c.cmd === 'systemd-run' && c.args.includes(path.join(root, 'start-all.sh')));
  assert.equal(startOpts.opts.timeout, 180000, 'start-all.sh 的超时要放到 180 秒');

  await ctl.setEnabled(false);
  await waitIdle(ctl);
  const stopCall = calls.find((c) => c[0] === 'systemd-run' && c.includes(path.join(root, 'stop-all.sh')));
  assert.ok(stopCall, '关闭也要走 stop-all.sh --rag');
  assert.deepEqual(stopCall.slice(5), [path.join(root, 'stop-all.sh'), '--rag']);
  const stopOpts = callOptions.find((c) => c.cmd === 'systemd-run' && c.args.includes(path.join(root, 'stop-all.sh')));
  assert.equal(stopOpts.opts.timeout, 180000, 'stop-all.sh 的超时也要放到 180 秒');
});

await test('script 模式：没有 systemd-run 时直接调脚本', async () => {
  const root = tempDir('root');
  const { exec, calls, callOptions } = makeExec({ mode: 'script', systemdRun: false });
  const { ctl } = makeCtl({
    root,
    deps: { readEnabled: () => true, execFile: exec, fetchImpl: fetchOk({ ok: true }), embeddingKind: () => 'bundled' }
  });
  await ctl.setEnabled(false);
  await waitIdle(ctl);
  const direct = calls.filter((c) => c[0] === path.join(root, 'stop-all.sh'));
  assert.equal(direct.length, 1);
  assert.deepEqual(direct[0], [path.join(root, 'stop-all.sh'), '--rag']);
  const directOpts = callOptions.find((c) => c.cmd === path.join(root, 'stop-all.sh'));
  assert.equal(directOpts.opts.timeout, 180000, '直接调脚本也要 180 秒');
});

// ── 6. 并发与写盘失败 ────────────────────────────────────────────────────

await test('忙时第二个 setEnabled / withLock 抛 busy', async () => {
  const { ctl } = makeCtl({
    extra: { healthTimeoutMs: 200, healthPollMs: 20 },
    deps: { readEnabled: () => false, fetchImpl: fetchDown() }
  });
  await ctl.setEnabled(true); // 后台会一直等到超时
  await assert.rejects(ctl.setEnabled(false), (error) => error?.code === 'busy');
  await assert.rejects(ctl.withLock(async () => {}), (error) => error?.code === 'busy');
  await waitIdle(ctl, 2000);
});

await test('writeEnabled 抛错：内存值不变、错误冒给调用方、锁被释放', async () => {
  const { ctl } = makeCtl({
    deps: {
      readEnabled: () => false,
      writeEnabled: () => { throw new Error('disk full'); }
    }
  });
  await assert.rejects(ctl.setEnabled(true), /disk full/);
  assert.equal(ctl.enabled(), false);
  const st = await ctl.state();
  assert.equal(st.busy, false);
});

// ── 7. 等健康超时 ────────────────────────────────────────────────────────

await test('等健康超时：后台结束后 phase=failed（不真的等 150 秒）', async () => {
  const { exec } = makeExec({ mode: 'systemd' });
  const { ctl } = makeCtl({
    extra: { healthTimeoutMs: 60, healthPollMs: 10 },
    deps: { readEnabled: () => true, execFile: exec, fetchImpl: fetchDown(), embeddingKind: () => 'bundled' }
  });
  const started = Date.now();
  await ctl.setEnabled(true);
  const st = await waitIdle(ctl, 3000);
  assert.ok(Date.now() - started < 2000, '应使用注入的超时，而不是默认 150 秒');
  assert.equal(st.phase, 'failed');
});

// ── 8. 默认 execFile 的闸门 ──────────────────────────────────────────────

await test('defaultRagExec：QQB_NO_SYSTEMCTL=1 时直接返回 127，不 spawn 任何进程', async () => {
  process.env.QQB_NO_SYSTEMCTL = '1';
  const result = await defaultRagExec('systemctl', ['--user', 'stop', 'qq-memory-rag']);
  assert.deepEqual(result, { code: 127, stdout: '', stderr: 'QQB_NO_SYSTEMCTL' });
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
