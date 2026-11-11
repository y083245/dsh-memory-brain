import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import { CHANNEL_DSH_PRESET, confirmChannelPreset } from '../src/core/channel-dsh-preset.mjs';
import { apply as applyGlobal } from '../plugins/qq-agent-presets/channel-tool-guard-global.mjs';
import { apply as applyScoped } from '../plugins/qq-agent-presets/channel-tool-guard.mjs';

const patch = yaml.load(readFileSync(new URL('../plugins/qq-agent-presets/presets/channel-chat-v2.patch.yml', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../plugins/qq-agent-presets/package.json', import.meta.url), 'utf8'));
const sessionId = 'cb1-' + 'a'.repeat(32) + '-' + 'b'.repeat(32);
const plugins = patch[0].insert.find(row => row.config?.id === CHANNEL_DSH_PRESET).config.plugins;

function fixture({ roster = [{ id: CHANNEL_DSH_PRESET }], rows = plugins, selected = CHANNEL_DSH_PRESET } = {}) {
  const calls = [];
  const controller = new AbortController();
  const api = {
    async callUnary(endpoint, request, signal) {
      assert.equal(signal, controller.signal);
      calls.push(endpoint);
      let value;
      switch (endpoint) {
        case 'agentPresets/list':
          assert.deepEqual(request, {});
          value = { presets: roster };
          break;
        case 'agentPresets/read':
          assert.deepEqual(request, { agentPreset: CHANNEL_DSH_PRESET });
          value = { agentPreset: CHANNEL_DSH_PRESET, content: yaml.dump(rows) };
          break;
        case 'session/projections':
          assert.deepEqual(request, { sessionId });
          value = { values: { agentPreset: selected } };
          break;
        default:
          throw new Error('Unexpected endpoint');
      }
      return { result: { ok: true, value } };
    },
  };
  return { api, calls, signal: controller.signal };
}

test('channel preset and global guard are installed together in the bundle', () => {
  assert.ok(manifest.dsh.bundle.patch.includes('./presets/channel-chat-v2.patch.yml'));
  assert.ok(patch[0].insert.some(row => row.name === 'qq-agent-presets/channel-tool-guard-global.mjs'));
});

test('accepts an active exact preset and confirms the selected preset of the session', async () => {
  const { api, calls, signal } = fixture();
  assert.equal(await confirmChannelPreset(api, { sessionId, signal }), true);
  assert.deepEqual(calls, ['agentPresets/list', 'agentPresets/read', 'session/projections']);
});

test('rejects unavailable, broken, modified, or reselected presets', async () => {
  const guard = plugins.find(row => row.id === 'channel-tool-guard');
  const cases = [
    { roster: [] },
    { roster: [{ id: CHANNEL_DSH_PRESET, broken: 'Missing guard' }] },
    { roster: [{ id: CHANNEL_DSH_PRESET }, { id: CHANNEL_DSH_PRESET }] },
    { rows: plugins.filter(row => row !== guard) },
    { rows: plugins.map(row => row === guard ? { ...row, disabled: true } : row) },
    { rows: [...plugins, { id: 'untrusted', name: 'unknown-tool-plugin' }] },
    { selected: 'qq-chat-v2' },
  ];
  for (const options of cases) {
    const { api, signal } = fixture(options);
    assert.equal(await confirmChannelPreset(api, { sessionId, signal }), false);
  }
  assert.equal(await confirmChannelPreset({ callUnary: async () => { throw Error('offline'); } }), false);
});

test('global guard denies every tool for cb1 without changing QQ or ordinary session decisions', () => {
  let check;
  let guardReady;
  applyGlobal({
    tools: { guard(callback) { check = callback; return () => {}; } },
    provide(key, service) {
      assert.equal(key, 'channelToolGuard');
      guardReady = service;
    },
  });
  assert.ok(guardReady);
  for (const name of ['mcp__snowluma__qq_send_message', 'channel_send_message', 'run_code', 'future_tool', undefined]) {
    assert.equal(typeof check({ agent: { id: sessionId }, name }), 'string');
  }
  assert.equal(typeof check({ agent: { id: 'cb1-invalid' }, name: 'future_tool' }), 'string');
  assert.equal(check({ agent: { id: 'qqb-g-1-test' }, name: 'mcp__snowluma__qq_send_message' }), undefined);
  assert.equal(check({ agent: { id: 'ordinary-session' }, name: 'future_tool' }), undefined);
});

test('scoped guard suppresses inherited schemas and denies even tool calls without a trusted agent', () => {
  const calls = [];
  let check;
  const tools = {
    presentAs(value) { calls.push(value); },
    restrict(value) { calls.push(value); },
    guard(callback) { check = callback; return () => {}; },
  };
  assert.throws(() => applyScoped({ tools }), /global channel tool guard/);
  applyScoped({ tools, channelToolGuard: {} });
  assert.deepEqual(calls, ['native', { allow: [] }]);
  assert.equal(typeof check({ name: 'channel_send_message' }), 'string');
  assert.equal(typeof check({ agent: { id: 'ordinary-session' }, name: 'read' }), 'string');
});
