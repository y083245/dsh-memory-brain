import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const config = { channels: { telegram: { enabled: true }, textTools: true } };
const credentials = { port: 32123, secret: 'a'.repeat(64) };

function hostFixture({ managed = true, publish = true, failText = false, failPassive = false, stateProtected = true } = {}) {
  const events = [];
  const starts = [];
  const watches = new Map();
  let waitForClose;
  return {
    events, starts, watches,
    waitBeforeClose(promise) { waitForClose = promise; },
    globals: {
      hardenDir: () => ({ ok: stateProtected }),
      expectsChannelToolCredentials: () => managed,
      channelTextToolsEnabled: (config) => config?.channels?.textTools === true && config.channels.telegram?.enabled === true,
      resolveDshEndpoint: async ({ baseUrl, target }) => {
        events.push('discover');
        return { baseUrl: target === 'desktop' ? 'http://127.0.0.1:3777' : baseUrl, kind: target === 'desktop' ? 'desktop' : 'web' };
      },
      discoverDshBaseUrl: async () => { throw new Error('Managed startup must avoid guessing a DSH port'); },
      startChannelHost: async (options) => {
        starts.push(options);
        events.push(options.enableTextTools ? 'start text' : 'start passive');
        if (options.enableTextTools ? failText : failPassive) throw new Error('private startup detail');
        let closing;
        return {
          toolCredentials: options.enableTextTools ? credentials : null,
          reload() { events.push('reload'); },
          invalidateAll() { events.push('invalidate'); },
          close() {
            return closing ??= (async () => {
              events.push('closing');
              await waitForClose;
              events.push('closed');
            })();
          },
        };
      },
      publishChannelToolCredentials: async (value) => {
        assert.deepEqual(value, failText || !stateProtected ? null : credentials);
        events.push(value ? 'ready' : 'unavailable');
        return publish;
      },
      fs: {
        ...fs,
        watch(dir, _options, listener) {
          watches.set(dir, listener);
          return { on() {}, close() { watches.delete(dir); } };
        },
      },
    },
  };
}

test('managed startup publishes the listener before DSH discovery and hooks up live bridge state', async () => {
  const fixture = hostFixture();
  const h = await bridgeHarness({ config: { ...config, dsh: { target: 'desktop' } }, globals: fixture.globals,
    files: { 'state/current-role.json': { role: 'Fixture', mode: 'active' }, 'roles/Fixture.md': 'Fixture role card' } });
  try {
    assert.deepEqual(fixture.events, ['start text', 'ready']);
    const [options] = fixture.starts;
    assert.equal(options.api, h.api);
    assert.equal(options.stateDir, path.join(h.temp, 'state', 'channels'));
    assert.equal(options.workspacePath, path.join(options.stateDir, 'workspace'));
    assert.equal(typeof options.longMemory.channelArchive?.project, 'function');
    assert.ok(options.rag);
    assert.equal(options.readRoleState().role, 'Fixture');
    assert.equal(options.readRoleCard('Fixture'), 'Fixture role card');
    assert.equal(options.readRoleCard('../Fixture'), '');
    assert.equal(options.isSensitive(credentials.secret.slice(4, 24)), true);

    const reloadConfig = fixture.watches.get(h.temp);
    fs.writeFileSync(path.join(h.temp, 'config.json'), JSON.stringify({ channels: { telegram: { enabled: false } } }));
    reloadConfig('rename', 'config.json');
    assert.equal(options.readConfig().channels.telegram.enabled, false);
    assert.deepEqual(fixture.events.slice(-2), ['invalidate', 'reload']);

    const beforeSilent = fixture.events.length;
    h.writeRoleState('Fixture', 'silent');
    h.writeRoleState('Fixture', 'active');
    assert.ok(fixture.events.slice(beforeSilent).includes('invalidate'));

    h.setReady(false);
    assert.equal(options.canRunTurns(), false);
    h.api.resolveBase = () => 'http://127.0.0.1:3080';
    h.api.rebind = (next) => assert.equal(next, 'http://127.0.0.1:3777');
    await h.checkDsh();
    assert.deepEqual(fixture.events.slice(-2), ['discover', 'invalidate']);
    assert.equal(options.canRunTurns(), true);
    h.api.settings.describe = async () => { throw new Error('DSH offline'); };
    await h.checkDsh();
    assert.equal(fixture.events.at(-1), 'invalidate');
    assert.equal(options.canRunTurns(), false);
  } finally { await h.close(); }
  assert.deepEqual(fixture.events.slice(-2), ['closing', 'closed']);
  assert.equal(fixture.watches.size, 0);
});

test('manual startup with a configured channel uses the zero-tool host', async () => {
  const fixture = hostFixture({ managed: false });
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try { assert.deepEqual(fixture.events, ['discover', 'start passive']); }
  finally { await h.close(); }
});

test('an existing outbox starts local confirmation recovery even when both channels are disabled', async () => {
  const fixture = hostFixture({ managed: false });
  const h = await bridgeHarness({ config: { channels: {} }, globals: fixture.globals,
    files: { 'state/channels/outbox.sqlite': 'fixture durable outbox' } });
  try {
    assert.deepEqual(fixture.events, ['discover', 'start passive']);
    assert.equal(fixture.starts[0].enableTextTools, false);
  } finally { await h.close(); }
});

test('a failed managed handoff closes the listener before starting a zero-tool host', async () => {
  const fixture = hostFixture({ publish: false });
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try { assert.deepEqual(fixture.events, ['start text', 'ready', 'closing', 'closed', 'start passive']); }
  finally { await h.close(); }
});

test('channel-host startup failure reports unavailable while QQ still initializes', async () => {
  const fixture = hostFixture({ failText: true, failPassive: true });
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try {
    assert.deepEqual(fixture.events, ['start text', 'unavailable', 'start passive']);
    assert.equal(typeof h.bot.sendPrivateMessage, 'function');
    const bridgeLog = fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8');
    assert.doesNotMatch(bridgeLog, /private startup detail/);
  } finally { await h.close(); }
});

test('text host startup failure leaves the zero-tool host available', async () => {
  const fixture = hostFixture({ failText: true });
  const h = await bridgeHarness({ config, globals: fixture.globals });
  await h.close();
  assert.deepEqual(fixture.events, ['start text', 'unavailable', 'start passive', 'closing', 'closed']);
});

test('a state permissions failure prevents the text and zero-tool hosts from opening', async () => {
  const fixture = hostFixture({ stateProtected: false });
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try {
    assert.deepEqual(fixture.events, ['unavailable']);
    assert.equal(typeof h.bot.sendPrivateMessage, 'function');
  } finally { await h.close(); }
});

test('a malformed config leaves the existing session mapping byte-for-byte intact', (t) => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-invalid-config-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'src'), path.join(temp, 'src'), { recursive: true });
  fs.cpSync(path.join(repo, 'plugins', 'qq-agent-presets'), path.join(temp, 'plugins', 'qq-agent-presets'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'scripts'));
  fs.copyFileSync(path.join(repo, 'scripts', 'build-agent-preset-patches.mjs'), path.join(temp, 'scripts', 'build-agent-preset-patches.mjs'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(temp, 'config.json'), '{invalid');
  fs.mkdirSync(path.join(temp, 'state'));
  const mappingPath = path.join(temp, 'state', 'sessions.json');
  const mapping = '{\n  "sessions": { "private:123": "fixture-session" }\n}\n';
  fs.writeFileSync(mappingPath, mapping);
  const child = spawnSync(process.execPath, [path.join(temp, 'src', 'bridge.js')], {
    cwd: temp, encoding: 'utf8', timeout: 15_000, env: { ...process.env, DSH_HOME: path.join(temp, 'dsh-home') },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /配置文件读取\/解析失败/);
  assert.equal(fs.readFileSync(mappingPath, 'utf8'), mapping);
});

test('shutdown closes the channel listener and workers before releasing the bridge lock', async () => {
  const fixture = hostFixture();
  let finishClose;
  fixture.waitBeforeClose(new Promise((resolve) => { finishClose = resolve; }));
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try {
    const lock = path.join(h.temp, 'state', 'bridge.lock');
    const stopping = h.shutdownBridge();
    assert.equal(fixture.events.at(-1), 'closing');
    assert.equal(fs.existsSync(lock), true);
    finishClose();
    await stopping;
    assert.equal(fixture.events.at(-1), 'closed');
    assert.equal(fs.existsSync(lock), false);
  } finally { finishClose(); await h.close(); }
});

test('shutdown deadline leaves the bridge lock for process exit even if a worker settles later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = hostFixture();
  const { promise, resolve } = Promise.withResolvers();
  fixture.waitBeforeClose(promise);
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try {
    const lock = path.join(h.temp, 'state', 'bridge.lock');
    const stopping = h.shutdownBridge();
    assert.equal(fixture.events.at(-1), 'closing');
    t.mock.timers.tick(10_000);
    const nextTurn = new Promise((done) => setImmediate(() => done('pending')));
    assert.equal(await Promise.race([stopping.then(() => 'stopped'), nextTurn]), 'stopped');
    assert.equal(fs.existsSync(lock), true);
    resolve();
    await promise;
    assert.equal(fs.existsSync(lock), true);
  } finally { resolve(); await h.close(); }
});
