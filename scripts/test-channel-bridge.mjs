import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
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

async function withConsole(h, run) {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await once(server, 'listening');
    const request = (route, { body, agent = false } = {}) => fetch(new URL(route, `http://127.0.0.1:${server.address().port}`), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...(agent ? { 'x-agent-call': '1' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await run(request, server);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('a Telegram-only bridge never loads QQ or resumes its legacy jobs', async () => {
  const fixture = hostFixture({ managed: false });
  let attempted = 0;
  const h = await bridgeHarness({
    config: { ownerQQ: 'invalid old QQ administrator', allow: undefined, channels: { qq: { enabled: false }, telegram: { enabled: true } } },
    savedState: { sessions: { 'private:123': 'qqb-p-123' } },
    globals: { ...fixture.globals, createQQAdapter: () => { attempted++; return { bot: {} }; } },
  });
  try {
    assert.equal(attempted, 0);
    assert.deepEqual(fixture.events, ['discover', 'start passive']);
    assert.equal(h.getOwnLife(), null);
    assert.equal(h.getLifeLoop(), null);
    assert.deepEqual(h.calls.follows, []);
    await h.checkDsh();
    assert.deepEqual(h.calls.archived, []);
    await withConsole(h, async (request) => {
      const result = await request('/api/status');
      assert.equal(result.status, 200);
      const status = await result.json();
      assert.equal(status.dshReady, true);
      assert.deepEqual(status.channels.qq, { enabled: false, state: 'disabled' });
      assert.deepEqual(status.channels.feishu, { enabled: false, state: 'disabled' });
      assert.deepEqual(status.channels.telegram, { enabled: true, state: 'awaiting_adapter' });
      assert.equal((await request('/api/test-send', { body: { kind: 'private', id: 123, message: 'offline fixture' } })).status, 503);
      assert.equal((await request('/api/send/group', { body: { groupId: 456, message: 'offline fixture' }, agent: true })).status, 503);
      assert.equal((await (await request('/api/status', { agent: true })).json()).channels, undefined);
    });
    assert.deepEqual(h.calls.http, []);
    assert.deepEqual({ ...h.state.sessions }, { 'private:123': 'qqb-p-123' });
  } finally { await h.close(); }
});

test('an unavailable QQ SDK is isolated and omitted from public diagnostics', async () => {
  const fixture = hostFixture({ managed: false });
  const h = await bridgeHarness({ config, globals: {
    ...fixture.globals,
    createQQAdapter: async () => { throw Object.assign(new Error('private SDK loader detail'), { code: 'ERR_MODULE_NOT_FOUND' }); },
  } });
  try {
    assert.deepEqual(fixture.events, ['discover', 'start passive']);
    assert.equal(h.getLifeLoop(), null);
    await h.checkDsh();
    await withConsole(h, async (request) => {
      const status = await (await request('/api/status')).json();
      assert.deepEqual(status.channels.qq, { enabled: true, state: 'missing_dependency' });
      assert.deepEqual(status.channels.telegram, { enabled: true, state: 'awaiting_adapter' });
      assert.equal(status.dshReady, true);
    });
    assert.doesNotMatch(fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8'), /private SDK loader detail/);
  } finally { await h.close(); }
});

test('an invalid QQ administrator in mixed mode leaves Telegram available', async () => {
  const fixture = hostFixture({ managed: false });
  let sdkLoads = 0;
  const invalidOwner = 'fixture invalid administrator';
  const h = await bridgeHarness({
    config: { ...config, ownerQQ: invalidOwner },
    globals: { ...fixture.globals, createQQAdapter() { sdkLoads++; throw new Error('unexpected QQ load'); } },
  });
  try {
    assert.equal(sdkLoads, 0);
    assert.deepEqual(fixture.events, ['discover', 'start passive']);
    const configFile = path.join(h.temp, 'config.json');
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(saved.ownerQQ, invalidOwner);
    await h.checkDsh();
    await withConsole(h, async (request) => {
      const status = await (await request('/api/status')).json();
      assert.deepEqual(status.channels.qq, { enabled: true, state: 'needs_config' });
      assert.deepEqual(status.channels.telegram, { enabled: true, state: 'awaiting_adapter' });
      assert.equal(status.dshReady, true);
      assert.doesNotMatch(JSON.stringify(status), /fixture invalid administrator/);
      fs.writeFileSync(configFile, JSON.stringify({ ...saved, ownerQQ: 123 }));
      const repaired = await (await request('/api/status')).json();
      assert.deepEqual(repaired.channels.qq, { enabled: true, state: 'restart_required' });
    });
    assert.deepEqual(h.calls.http, []);
    assert.doesNotMatch(fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8'), /fixture invalid administrator/);
  } finally { await h.close(); }
});

test('disabling QQ stops its client, and changing the flag back requires a restart', async () => {
  const fixture = hostFixture({ managed: false });
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try {
    let closed = 0;
    h.bot.close = () => { closed++; };
    const configFile = path.join(h.temp, 'config.json');
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const writeEnabled = (enabled) => fs.writeFileSync(configFile, JSON.stringify({ ...saved, channels: { ...saved.channels, qq: { enabled } } }));
    writeEnabled(false);
    fixture.watches.get(h.temp)('rename', 'config.json');
    assert.equal(closed, 1);
    writeEnabled(true);
    fixture.watches.get(h.temp)('rename', 'config.json');
    await withConsole(h, async (request) => {
      const status = await (await request('/api/status')).json();
      assert.deepEqual(status.channels.qq, { enabled: true, state: 'restart_required' });
      assert.equal((await request('/api/test-send', { body: { kind: 'private', id: 123, message: 'offline fixture' } })).status, 503);
    });
    assert.deepEqual(h.calls.sent, []);
  } finally { await h.close(); }
});

test('a QQ test send whose request body arrives after disable never reaches the adapter', { timeout: 5000 }, async () => {
  const fixture = hostFixture({ managed: false });
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try {
    await withConsole(h, async (_request, server) => {
      const body = JSON.stringify({ kind: 'private', id: 123, message: 'offline fixture' });
      const started = once(server, 'request');
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/api/test-send', method: 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      const responded = once(req, 'response');
      try {
        req.flushHeaders();
        await started;
        const configFile = path.join(h.temp, 'config.json');
        const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        saved.channels.qq = { enabled: false };
        fs.writeFileSync(configFile, JSON.stringify(saved));
        req.end(body);
        const [response] = await responded;
        response.resume();
        assert.equal(response.statusCode, 503);
      } finally { req.destroy(); }
    });
    assert.deepEqual(h.calls.sent, []);
  } finally { await h.close(); }
});

test('a late DSH result during QQ disable preserves the existing QQ session mapping', { timeout: 5000 }, async () => {
  const fixture = hostFixture({ managed: false });
  const sessionId = 'qqb-p-123';
  const key = 'private:123';
  const h = await bridgeHarness({
    config, savedState: { sessions: { [key]: sessionId } }, globals: fixture.globals,
  });
  try {
    h.state.sessionPolicies[key] = h.sessionPolicy(key);
    const selectedModel = Promise.withResolvers();
    const finishSelecting = Promise.withResolvers();
    h.api.sessions.selectModel = async () => {
      selectedModel.resolve();
      await finishSelecting.promise;
      throw new Error('not-found');
    };
    const queued = h.deliverPrompt(key, 'offline fixture');
    const rejected = assert.rejects(queued, /QQ 渠道未运行/);
    await selectedModel.promise;
    const configFile = path.join(h.temp, 'config.json');
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    saved.channels.qq = { enabled: false };
    fs.writeFileSync(configFile, JSON.stringify(saved));
    finishSelecting.resolve();
    await rejected;
    assert.equal(h.state.sessions[key], sessionId);
    assert.deepEqual(h.calls.archived, []);
    assert.deepEqual(h.calls.prompts, []);
  } finally { await h.close(); }
});

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

function assertConfigRejected(t, rawConfig, diagnostic) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-invalid-config-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'src'), path.join(temp, 'src'), { recursive: true });
  for (const bundle of ['qq-agent-presets', 'channel-agent-presets']) {
    fs.cpSync(path.join(repo, 'plugins', bundle), path.join(temp, 'plugins', bundle), { recursive: true });
  }
  fs.mkdirSync(path.join(temp, 'scripts'));
  fs.copyFileSync(path.join(repo, 'scripts', 'build-agent-preset-patches.mjs'), path.join(temp, 'scripts', 'build-agent-preset-patches.mjs'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(temp, 'config.json'), rawConfig);
  fs.mkdirSync(path.join(temp, 'state'));
  const mappingPath = path.join(temp, 'state', 'sessions.json');
  const mapping = '{\n  "sessions": { "private:123": "fixture-session" }\n}\n';
  fs.writeFileSync(mappingPath, mapping);
  const child = spawnSync(process.execPath, [path.join(temp, 'src', 'bridge.js')], {
    cwd: temp, encoding: 'utf8', timeout: 15_000, env: { ...process.env, DSH_HOME: path.join(temp, 'dsh-home') },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, diagnostic);
  assert.equal(fs.readFileSync(mappingPath, 'utf8'), mapping);
}

test('a malformed config leaves the existing session mapping byte-for-byte intact', (t) => {
  assertConfigRejected(t, '{invalid', /配置文件读取\/解析失败/);
});

test('a legacy QQ-only config still rejects an invalid administrator', (t) => {
  assertConfigRejected(t, '{"ownerQQ":"invalid administrator"}', /ownerQQ 必须是 QQ 号/);
});

test('shutdown closes the channel listener and workers before releasing the bridge lock', async () => {
  const fixture = hostFixture();
  let finishClose;
  fixture.waitBeforeClose(new Promise((resolve) => { finishClose = resolve; }));
  const h = await bridgeHarness({ config, globals: fixture.globals });
  try {
    const lock = path.join(h.temp, 'state', 'bridge.lock');
    const stopping = h.shutdownBridge();
    await new Promise((resolve) => setImmediate(resolve));
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
    await new Promise((resolve) => setImmediate(resolve));
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

test('Feishu adapter starts, syncs on config change, and stops before host close and lock release', async () => {
  const fixture = hostFixture({ managed: false });
  let finishFeishuStop;
  const feishuStopGate = new Promise((resolve) => { finishFeishuStop = resolve; });
  const h = await bridgeHarness({
    config: { channels: { qq: { enabled: false }, feishu: { enabled: true }, telegram: { enabled: false } } },
    globals: {
      ...fixture.globals,
      createFeishuAdapter: () => {
        fixture.events.push('feishu:create');
        return {
          async start() { fixture.events.push('feishu:start'); return { status: 'registered' }; },
          async syncConfig() { fixture.events.push('feishu:syncConfig'); return { status: 'disabled' }; },
          async stop() {
            fixture.events.push('feishu:stop:begin');
            await feishuStopGate;
            fixture.events.push('feishu:stop:end');
          },
          status: () => ({ status: 'registered' }),
        };
      },
    },
  });
  try {
    assert.ok(fixture.events.includes('feishu:create'));
    assert.ok(fixture.events.includes('feishu:start'));

    const configFile = path.join(h.temp, 'config.json');
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...saved, channels: { ...saved.channels, feishu: { enabled: false } } }));
    fixture.watches.get(h.temp)('rename', 'config.json');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.events.at(-1), 'feishu:syncConfig');

    const lock = path.join(h.temp, 'state', 'bridge.lock');
    const stopping = h.shutdownBridge();
    assert.ok(fixture.events.includes('feishu:stop:begin'));
    assert.equal(fs.existsSync(lock), true);

    finishFeishuStop();
    await stopping;
    const stopEndIndex = fixture.events.indexOf('feishu:stop:end');
    const hostClosingIndex = fixture.events.indexOf('closing');
    assert.ok(stopEndIndex !== -1 && hostClosingIndex !== -1 && stopEndIndex < hostClosingIndex);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    finishFeishuStop();
    await h.close();
  }
});

test('bridge options.isSensitive blocks Feishu appSecret, Telegram botToken, and proxy credentials', async () => {
  const fixture = hostFixture({ managed: false });
  let capturedEnv;
  const h = await bridgeHarness({
    config: { channels: { qq: { enabled: false }, feishu: { enabled: true }, telegram: { enabled: true } } },
    globals: {
      ...fixture.globals,
      createFeishuAdapter: ({ env }) => {
        capturedEnv = env;
        return { start: async () => ({ status: 'awaiting_credentials' }), stop: async () => {}, syncConfig: async () => {}, status: () => ({ status: 'idle' }) };
      },
    },
  });
  try {
    capturedEnv.FEISHU_APP_SECRET = 'feishu-app-secret-fixture-99';
    capturedEnv.TELEGRAM_BOT_TOKEN = '123456789:telegram-bot-token-fixture';
    capturedEnv.TELEGRAM_PROXY_URL = 'http://proxyuser:proxypass1234@127.0.0.1:7890';
    const [{ isSensitive }] = fixture.starts;

    assert.equal(isSensitive('leaked feishu-app-secret-fixture-99 here'), true);
    assert.equal(isSensitive('f e i s h u - a p p - s e c r e t - f i x t u r e - 9 9'), true);
    assert.equal(isSensitive(Buffer.from('feishu-app-secret-fixture-99').toString('base64')), true);
    assert.equal(isSensitive('token 123456789:telegram-bot-token-fixture'), true);
    assert.equal(isSensitive('pass proxypass1234'), true);
    assert.equal(isSensitive('ordinary friendly message'), false);
  } finally { await h.close(); }
});

test('Telegram adapter starts, syncs on config change, and stops before host close and lock release', async () => {
  const fixture = hostFixture({ managed: false });
  let finishTelegramStop;
  const telegramStopGate = new Promise((resolve) => { finishTelegramStop = resolve; });
  const h = await bridgeHarness({
    config: { channels: { qq: { enabled: false }, feishu: { enabled: false }, telegram: { enabled: true } } },
    globals: {
      ...fixture.globals,
      createTelegramAdapter: () => {
        fixture.events.push('telegram:create');
        return {
          async start() { fixture.events.push('telegram:start'); return { status: 'registered' }; },
          async syncConfig() { fixture.events.push('telegram:syncConfig'); return { status: 'disabled' }; },
          async stop() {
            fixture.events.push('telegram:stop:begin');
            await telegramStopGate;
            fixture.events.push('telegram:stop:end');
          },
          status: () => ({ status: 'registered' }),
        };
      },
    },
  });
  try {
    assert.ok(fixture.events.includes('telegram:create'));
    assert.ok(fixture.events.includes('telegram:start'));

    const configFile = path.join(h.temp, 'config.json');
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...saved, channels: { ...saved.channels, telegram: { enabled: false } } }));
    fixture.watches.get(h.temp)('rename', 'config.json');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.events.at(-1), 'telegram:syncConfig');

    const lock = path.join(h.temp, 'state', 'bridge.lock');
    const stopping = h.shutdownBridge();
    assert.ok(fixture.events.includes('telegram:stop:begin'));
    assert.equal(fs.existsSync(lock), true);

    finishTelegramStop();
    await stopping;
    const stopEndIndex = fixture.events.indexOf('telegram:stop:end');
    const hostClosingIndex = fixture.events.indexOf('closing');
    assert.ok(stopEndIndex !== -1 && hostClosingIndex !== -1 && stopEndIndex < hostClosingIndex);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    finishTelegramStop();
    await h.close();
  }
});
