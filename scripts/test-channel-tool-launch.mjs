import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  channelTextToolsEnabled, channelToolDshEnv, launchChannelToolBridge, withoutChannelToolEnv,
} from '../src/runtime/channel-tool-launch.mjs';
import { startManagedChannelServices } from '../src/runtime/orchestrator.mjs';
import { isPidAlive, stopPid } from '../src/runtime/process.mjs';

const launchModule = JSON.stringify(new URL('../src/runtime/channel-tool-launch.mjs', import.meta.url).href);
const serverModule = JSON.stringify(new URL('../src/core/channel-tool-server.mjs', import.meta.url).href);

function fixture(t, code) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-tool-launch-'));
  const script = join(dir, 'bridge.mjs');
  const logFile = join(dir, 'bridge.log');
  writeFileSync(script, code);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return { command: process.execPath, args: [script], cwd: dir, logFile };
}

test('only explicitly configured new channels request a text-tool handoff', () => {
  assert.equal(channelTextToolsEnabled({ channels: { textTools: true, telegram: { enabled: true } } }), true);
  assert.equal(channelTextToolsEnabled({ channels: { textTools: true, feishu: { enabled: true } } }), true);
  assert.equal(channelTextToolsEnabled({ channels: { textTools: 'true', telegram: { enabled: true } } }), false);
  assert.equal(channelTextToolsEnabled({ channels: { textTools: true, qq: { enabled: true } } }), false);
  assert.equal(channelTextToolsEnabled({}), false);
});

test('a detached bridge binds its tool listener before credentials can reach the DSH child', async (t) => {
  const spec = fixture(t, `
    import assert from 'node:assert/strict';
    import { expectsChannelToolCredentials, publishChannelToolCredentials } from ${launchModule};
    import { startChannelToolServer } from ${serverModule};
    assert.equal(expectsChannelToolCredentials(), true);
    assert.equal(Object.keys(process.env).some(key => /^DSH_CHANNEL_TOOL_(PORT|SECRET)$/i.test(key)), false);
    const listener = await startChannelToolServer({ invokeTextTool: () => ({ status: 'queued' }) });
    assert.equal(await publishChannelToolCredentials(listener), true);
    assert.equal(expectsChannelToolCredentials(), false);
  `);
  const ambient = { ...process.env, dsh_channel_tool_port: '9', DSH_CHANNEL_TOOL_SECRET: 'a'.repeat(64) };
  const { credentials, pid } = await launchChannelToolBridge({ ...spec, env: ambient });
  try {
    assert.match(credentials.secret, /^[a-f0-9]{64}$/);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createHmac } from 'node:crypto';
      const { DSH_CHANNEL_TOOL_PORT: port, DSH_CHANNEL_TOOL_SECRET: secret } = process.env;
      const body = JSON.stringify({ sessionId: 'fixture', requestId: 'fixture', callId: 'fixture',
        name: 'channel_send_text', args: { text: 'Synthetic reply' } });
      const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest('hex');
      const res = await fetch('http://127.0.0.1:' + port + '/channel/text-tool', { method: 'POST',
        headers: { authorization: 'Bearer ' + signature, 'content-type': 'application/json' }, body });
      console.log(res.status, (await res.json()).status);
    `], { env: channelToolDshEnv(ambient, credentials), encoding: 'utf8', timeout: 6_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), '200 queued');
    assert.equal(readFileSync(spec.logFile, 'utf8').includes(credentials.secret), false);
    assert.equal(ambient.DSH_CHANNEL_TOOL_SECRET, 'a'.repeat(64));
    assert.equal(channelToolDshEnv(ambient).DSH_CHANNEL_TOOL_SECRET, undefined);
    assert.equal(withoutChannelToolEnv(ambient).dsh_channel_tool_port, undefined);
  } finally {
    await stopPid(pid, { timeoutMs: 3_000 });
  }
});

test('a bridge without an available listener explicitly falls back without credentials', async (t) => {
  const spec = fixture(t, `
    import { publishChannelToolCredentials } from ${launchModule};
    await publishChannelToolCredentials(null);
    setInterval(() => {}, 1000);
  `);
  const { credentials, pid } = await launchChannelToolBridge(spec);
  try {
    assert.equal(credentials, null);
    assert.equal(isPidAlive(pid), true);
  } finally {
    await stopPid(pid, { timeoutMs: 3_000 });
  }
});

test('a bridge that never publishes readiness is stopped after the deadline', async (t) => {
  const spec = fixture(t, `
    console.log(process.pid);
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(launchChannelToolBridge({ ...spec, timeoutMs: 1_500 }), /readiness timed out/);
  const pid = Number(readFileSync(spec.logFile, 'utf8').trim());
  assert.ok(pid > 0);
  assert.equal(isPidAlive(pid), false);
});

function managedFixture(t) {
  const { cwd } = fixture(t, '');
  const config = { channels: { textTools: true, telegram: { enabled: true, botTokenEnv: 'TEST_BOT' } } };
  const env = { test_bot: 'synthetic bot secret', DEEPSEEK_BASE_URL: 'http://127.0.0.1:19991' };
  const logger = { log() {}, ok() {}, warn() {}, err() {} };
  const options = {
    paths: { root: cwd, runDir: cwd, nodeBin: process.execPath, config },
    env, bridgeEnv: env, platform: process.platform, target: 'auto', setup: { ok: true }, ...logger,
  };
  const calls = [];
  const deps = {
    portOpen: async () => false, discover: async () => null, serviceRunning: async () => false,
    startBridge: async ({ env: childEnv }) => {
      calls.push('bridge');
      assert.equal(childEnv.QQ_BRIDGE_DSH_TARGET, 'web');
      assert.equal(childEnv.test_bot, 'synthetic bot secret');
      assert.equal(childEnv.DSH_CHANNEL_TOOL_SECRET, undefined);
      return { pid: 131071, credentials: { port: 16661, secret: 'e'.repeat(64) } };
    },
    startWeb: async ({ env: childEnv, onSpawn }) => {
      calls.push('dsh');
      assert.equal(childEnv.DSH_CHANNEL_TOOL_PORT, '16661');
      assert.equal(childEnv.DSH_CHANNEL_TOOL_SECRET, 'e'.repeat(64));
      assert.equal(childEnv.test_bot, undefined);
      assert.equal(childEnv.DEEPSEEK_BASE_URL, 'http://127.0.0.1:19991');
      onSpawn(131072);
      return true;
    },
    waitBridge: async ({ managed, port }) => {
      calls.push('wait');
      assert.equal(managed, true);
      assert.equal(port, 3100);
      return true;
    },
    verifyTextPreset: async () => {
      calls.push('verify preset');
      return true;
    },
    stop: async (_pid, { label }) => {
      calls.push(label + ' stop');
      return { ok: true };
    },
  };
  return { options, deps, calls };
}

test('the start-all managed path starts the bridge before DSH and confines platform credentials to the bridge', async (t) => {
  const { options, deps, calls } = managedFixture(t);
  assert.deepEqual(await startManagedChannelServices(options, deps), {
    ok: true, endpoint: { baseUrl: 'http://127.0.0.1:3080', kind: 'web' }, consolePort: 3100,
  });
  assert.deepEqual(calls, ['bridge', 'dsh', 'wait', 'verify preset']);
});

test('the start-all managed path leaves an existing DSH or bridge untouched', async (t) => {
  const { options, deps, calls } = managedFixture(t);
  for (const occupied of [3080, 3100]) {
    assert.equal(await startManagedChannelServices(options, { ...deps, portOpen: async (port) => port === occupied }), null);
  }
  assert.equal(await startManagedChannelServices(options, { ...deps, serviceRunning: async () => true }), null);
  assert.deepEqual(calls, []);
});

test('the start-all managed path stops both owned children when the bridge never becomes ready', async (t) => {
  const { options, deps, calls } = managedFixture(t);
  assert.deepEqual(await startManagedChannelServices(options, {
    ...deps, waitBridge: async () => false,
  }), { ok: false });
  assert.deepEqual(calls, ['bridge', 'dsh', 'qq-bridge stop', 'DSH stop']);
});
