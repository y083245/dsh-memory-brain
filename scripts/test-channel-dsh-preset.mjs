import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import yaml from 'js-yaml';
import * as channelPresets from '../src/core/channel-dsh-preset.mjs';
import { apply as applyGlobal } from '../plugins/qq-agent-presets/channel-tool-guard-global.mjs';
import { apply as applyScoped } from '../plugins/qq-agent-presets/channel-tool-guard.mjs';

const { CHANNEL_DSH_PRESET, confirmChannelPreset } = channelPresets;
const textPreset = 'channel-chat-v2-text';
const patch = yaml.load(readFileSync(new URL('../plugins/qq-agent-presets/presets/channel-chat-v2.patch.yml', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../plugins/qq-agent-presets/package.json', import.meta.url), 'utf8'));
const sessionId = 'cb1-' + 'a'.repeat(32) + '-' + 'b'.repeat(32);
const plugins = patch[0].insert.find(row => row.config?.id === CHANNEL_DSH_PRESET).config.plugins;

function fixture({ preset = CHANNEL_DSH_PRESET, roster = [{ id: preset }], rows = plugins, selected = preset } = {}) {
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
          assert.deepEqual(request, { agentPreset: preset });
          value = { agentPreset: preset, content: yaml.dump(rows) };
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
  assert.deepEqual(plugins.find(row => row.id === 'tool-presentation'), {
    id: 'tool-presentation',
    name: '@deepseek-ai/dsh-agent-tool-presentation',
    config: { mode: 'native' },
  });
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
    { rows: plugins.filter(row => row.id !== 'tool-presentation') },
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
    on() { return () => {}; },
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
    restrict(value) { calls.push(value); },
    guard(callback) { check = callback; return () => {}; },
  };
  assert.throws(() => applyScoped({ tools }), /global channel tool guard/);
  applyScoped({ tools, channelToolGuard: {} });
  assert.deepEqual(calls, [{ allow: [] }]);
  assert.equal(typeof check({ name: 'channel_send_message' }), 'string');
  assert.equal(typeof check({ agent: { id: 'ordinary-session' }, name: 'read' }), 'string');
});

test('text preset requires its own exact composition and live session selection', async () => {
  assert.equal(channelPresets.CHANNEL_DSH_TEXT_PRESET, textPreset);
  const patchPath = './presets/channel-chat-v2-text.patch.yml';
  assert.ok(manifest.dsh.bundle.patch.includes(patchPath));
  const textPatch = yaml.load(readFileSync(new URL(patchPath, new URL('../plugins/qq-agent-presets/', import.meta.url)), 'utf8'));
  const rows = textPatch[0].insert.find(row => row.config?.id === textPreset).config.plugins;
  const scoped = rows.find(row => row.id === 'channel-native-text-tools');
  assert.equal(scoped.name, 'qq-agent-presets/channel-native-text-tools.mjs');
  const live = fixture({ preset: textPreset, rows });
  assert.equal(await confirmChannelPreset(live.api, { preset: textPreset, sessionId, signal: live.signal }), true);
  for (const options of [
    { rows: plugins },
    { rows: rows.filter(row => row !== scoped) },
    { rows: rows.map(row => row === scoped ? { ...row, disabled: true } : row) },
    { rows: [...rows, { id: 'other', name: 'untrusted-tool' }] },
    { selected: CHANNEL_DSH_PRESET },
  ]) {
    const { api, signal } = fixture({ preset: textPreset, rows, ...options });
    assert.equal(await confirmChannelPreset(api, { preset: textPreset, sessionId, signal }), false);
  }
  const unknown = fixture();
  assert.equal(await confirmChannelPreset(unknown.api, { preset: 'qq-chat-v2', signal: unknown.signal }), false);
  assert.deepEqual(unknown.calls, []);
});

test('native channel tools require the exact preset and a live direct call and validate signed results', async t => {
  const { apply: applyText } = await import('../plugins/qq-agent-presets/channel-native-text-tools.mjs');
  const calls = [];
  let response = { body: '{"status":"queued"}' };
  const endpoint = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    const pending = response;
    if (pending.beforeResponse) await pending.beforeResponse(res);
    if (res.destroyed) return;
    res.writeHead(pending.code ?? 200, { 'content-type': 'application/json', ...pending.headers });
    res.end(pending.body);
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => endpoint.close(resolve)));
  const secret = randomBytes(32).toString('hex');
  process.env.DSH_CHANNEL_TOOL_PORT = String(endpoint.address().port);
  process.env.DSH_CHANNEL_TOOL_SECRET = secret;
  t.after(() => {
    delete process.env.DSH_CHANNEL_TOOL_PORT;
    delete process.env.DSH_CHANNEL_TOOL_SECRET;
  });

  const session = { id: sessionId, header: { id: sessionId, isSeeded: false } };
  const agent = { id: sessionId, session, ctx: {}, status: 'running' };
  const fakeAgent = { ...agent };
  const registry = new Map([[agent.id, agent]]);
  const presets = new Map([[agent.ctx, textPreset]]);
  const definitions = new Map();
  const fields = {
    channel_send_text: ['text'],
    channel_reply_text: ['text'],
    channel_get_unread: ['afterSeq', 'limit'],
    channel_history_search: ['query', 'keywords', 'from', 'to', 'limit'],
    channel_memory_recall: [],
    channel_memory_remember: ['cat', 'text', 'due', 'by', 'core', 'replaces'],
    channel_memory_update: ['itemId', 'text', 'cat', 'due', 'by', 'core', 'status', 'archived', 'outdated'],
    channel_memory_forget: ['itemId'],
    channel_wait_for_messages: ['afterSeq', 'timeoutMs'],
    channel_mark_read: ['throughSeq'],
    channel_set_wake_config: ['throughSeq', 'groupPolicy'],
    channel_feedback: ['message'],
  };
  let checkGlobal, checkScoped, receive, channelToolGuard, claimAgent;
  let extraTool;
  applyGlobal({
    agents: registry,
    agentPresets: { composedPreset: ctx => presets.get(ctx) },
    on(event, callback) { assert.equal(event, 'session/event'); receive = callback; return () => {}; },
    tools: {
      guard(callback) { checkGlobal = callback; return () => {}; },
      get(name, scope) { return scope === agent ? definitions.get(name) : undefined; },
      schemas(scope) {
        return scope === agent ? [...definitions.values(), ...(extraTool ? [extraTool] : [])] : [];
      },
    },
    provide(key, service) { assert.equal(key, 'channelToolGuard'); channelToolGuard = service; },
  });
  assert.equal(process.env.DSH_CHANNEL_TOOL_SECRET, undefined);
  assert.throws(() => applyText({ tools: {} }), /global channel tool guard/);
  agent.ctx.tools = { register(definition) { definitions.set(definition.name, definition); return () => {}; } };
  applyText({ channelToolGuard,
    on(event, callback) { assert.equal(event, 'agent/inbox/claimed'); claimAgent = callback; return () => {}; },
    tools: {
      guard(callback) { checkScoped = callback; return () => {}; },
      restrict(rule) { assert.deepEqual(rule, { allow: [] }); return () => {}; },
    },
  });
  assert.equal(definitions.size, 0);
  claimAgent({ agent: fakeAgent });
  assert.equal(definitions.size, 0);
  presets.set(agent.ctx, CHANNEL_DSH_PRESET);
  claimAgent({ agent });
  assert.equal(definitions.size, 0);
  presets.set(agent.ctx, textPreset);
  claimAgent({ agent });
  assert.deepEqual([...definitions.keys()].sort(), Object.keys(fields).sort());
  for (const definition of definitions.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(definition.parameters.properties).sort(), [...fields[definition.name]].sort());
    if (['channel_send_text', 'channel_reply_text'].includes(definition.name)) {
      assert.deepEqual(definition.parameters.required, ['text']);
      assert.equal(definition.parameters.properties.text.type, 'string');
    }
  }

  const sendText = definitions.get('channel_send_text');
  const replyText = definitions.get('channel_reply_text');
  const requestId = 'task_' + 'c'.repeat(64);
  const callId = 'toolu_native_1';
  const args = { text: '你好 👋' };
  const exec = { agent, callId, name: sendText.name, rootCallId: callId, token: Symbol(), arguments: args,
    signal: new AbortController().signal };
  const user = (rpcId = requestId) => ({ source: { kind: 'user', rpcId } });
  const event = (type, data) => receive(session, { type, data });
  function begin(call = exec, sources = [user()], turn = 1) {
    event('turn/end', { turn: turn - 1 });
    event('turn/start', { turn });
    event('step/start', { turn, step: 1 });
    for (const source of sources) event('user/message', source);
    event('user/message', { source: { kind: 'runtime-context' } });
    event('tool/call', { turn, step: 1, callId: call.callId, name: call.name });
  }

  const denied = { status: 'denied' };
  assert.deepEqual(await sendText.execute(args, exec), denied);
  begin();
  assert.equal(checkGlobal(exec), undefined);
  assert.equal(checkScoped(exec), undefined);
  for (const context of [undefined, { ...exec, agent: undefined }, { ...exec, agent: fakeAgent },
    { ...exec, parent: Symbol() }, { ...exec, rootCallId: 'different' }, { ...exec, schema: {} },
    { ...exec, token: undefined }, { ...exec, callId: 'unlogged', rootCallId: 'unlogged' },
    { ...exec, name: replyText.name }]) {
    assert.equal(typeof checkScoped(context), 'string');
    assert.deepEqual(await sendText.execute(args, context), denied);
  }
  assert.equal(typeof checkGlobal({ ...exec, name: 'working_directory' }), 'string');
  presets.set(agent.ctx, CHANNEL_DSH_PRESET);
  assert.equal(typeof checkGlobal(exec), 'string');
  assert.deepEqual(await sendText.execute(args, exec), denied);
  presets.set(agent.ctx, textPreset);
  extraTool = { name: 'injected' };
  assert.deepEqual(await sendText.execute(args, exec), denied);
  extraTool = undefined;
  session.header.parentSession = 'parent-session';
  assert.deepEqual(await sendText.execute(args, exec), denied);
  delete session.header.parentSession;
  for (const payload of [{}, { text: '' }, { text: ' ' }, { text: '\0' }, { text: '\ud800' },
    { text: 'x'.repeat(1024 * 1024 + 1) }, { text: 'hello', requestId }, { text: 'hello', target: 'elsewhere' }]) {
    assert.deepEqual(await sendText.execute(payload, exec), { status: 'invalid' });
  }
  const rawExec = { ...exec, arguments: { ...args, target: 'elsewhere' } };
  assert.equal(typeof checkScoped(rawExec), 'string');
  assert.deepEqual(await sendText.execute(args, rawExec), { status: 'invalid' });
  assert.deepEqual(await sendText.execute({ text: 'rewritten' }, exec), { status: 'invalid' });
  for (const sources of [[], [user('untrusted')], [user(), user()], [user(), { source: { kind: 'agent-message' } }]]) {
    begin(exec, sources);
    assert.deepEqual(await sendText.execute(args, exec), denied);
  }
  assert.equal(calls.length, 0);

  begin();
  assert.deepEqual(await sendText.execute(args, exec), { status: 'queued' });
  const [received] = calls;
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/channel/text-tool');
  assert.equal(received.headers.host, `127.0.0.1:${endpoint.address().port}`);
  const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(received.body).digest('hex');
  assert.equal(received.headers.authorization, `Bearer ${signature}`);
  assert.deepEqual(JSON.parse(received.body), { sessionId, requestId, callId, name: 'channel_send_text', args });
  event('tool/result', { turn: 1, step: 1, message: { toolCallId: callId } });
  assert.deepEqual(await sendText.execute(args, exec), denied);
  event('turn/end', { turn: 1 });
  assert.deepEqual(await sendText.execute(args, exec), denied);

  const replyExec = { ...exec, name: replyText.name, callId: 'toolu_native_2', rootCallId: 'toolu_native_2' };
  begin(replyExec, [user()], 2);
  for (const unusable of [
    { body: '{"status":"queued","body":"private value"}' },
    { body: '{"status":"secret"}' },
    { body: 'x'.repeat(2048) },
    { body: '{"status":"queued"}', code: 302, headers: { location: '/channel/text-tool' } },
  ]) {
    response = unusable;
    const before = calls.length;
    assert.deepEqual(await replyText.execute(args, replyExec), { status: 'unavailable' });
    assert.equal(calls.length, before + 1);
  }
  assert.equal(JSON.parse(calls.at(-1).body).name, 'channel_reply_text');

  const search = definitions.get('channel_history_search');
  const searchArgs = { query: '原话', keywords: ['一条', '来信'], limit: 8 };
  const searchExec = { ...exec, name: search.name, arguments: searchArgs,
    callId: 'toolu_native_3', rootCallId: 'toolu_native_3' };
  const commonResult = { status: 'ok', data: { messages: [{ text: '只在这个会话' }] } };
  response = { body: JSON.stringify(commonResult) };
  begin(searchExec, [user()], 3);

  const ordinary = { id: 'ordinary-session', session, status: 'running' };
  assert.equal(typeof checkGlobal({ ...searchExec, agent: ordinary }), 'string');
  const before = calls.length;
  const injected = { ...searchExec, arguments: { ...searchArgs, source: 'other' } };
  assert.equal(typeof checkScoped(injected), 'string');
  assert.deepEqual(await search.execute(injected.arguments, injected), { status: 'invalid' });
  assert.deepEqual(await search.execute({ ...searchArgs, keywords: ['altered'] }, searchExec), { status: 'invalid' });
  const recall = definitions.get('channel_memory_recall');
  definitions.set(recall.name, { ...recall });
  assert.deepEqual(await search.execute(searchArgs, searchExec), denied);
  assert.equal(calls.length, before);
  definitions.set(recall.name, recall);
  assert.equal(checkScoped(searchExec), undefined);
  assert.deepEqual(await search.execute(searchArgs, searchExec), commonResult);
  assert.deepEqual(search.finalizeContent(searchExec, { value: commonResult }), [
    { type: 'text', text: JSON.stringify(commonResult) },
  ]);
  presets.set(agent.ctx, CHANNEL_DSH_PRESET);
  assert.deepEqual(search.finalizeContent(searchExec, { value: commonResult }), [
    { type: 'text', text: '{"status":"denied"}' },
  ]);
  presets.set(agent.ctx, textPreset);
  const signedSearch = calls.at(-1);
  assert.deepEqual(JSON.parse(signedSearch.body), {
    sessionId, requestId, callId: searchExec.callId, name: search.name, args: searchArgs,
  });
  assert.equal(signedSearch.headers.authorization,
    'Bearer ' + createHmac('sha256', Buffer.from(secret, 'hex')).update(signedSearch.body).digest('hex'));

  for (const status of ['invalid', 'denied', 'unavailable']) {
    response = { body: JSON.stringify({ status }) };
    assert.deepEqual(await search.execute(searchArgs, searchExec), { status });
  }
  for (const unusable of [
    '{"status":"ok","data":[]}',
    '{"status":"ok","data":{"__proto__":{"polluted":true}}}',
    '{"status":"ok","data":{"text":1e999}}',
    '{"status":"denied","data":{"text":"private value"}}',
    '{"status":"queued"}',
    JSON.stringify({ status: 'ok', data: { text: '界'.repeat(6_000) } }),
  ]) {
    response = { body: unusable };
    assert.deepEqual(await search.execute(searchArgs, searchExec), { status: 'unavailable' });
  }

  const waiting = definitions.get('channel_wait_for_messages');
  const cancel = new AbortController();
  const waitArgs = { afterSeq: 1, timeoutMs: 30_000 };
  const waitExec = { ...searchExec, name: waiting.name, arguments: waitArgs, signal: cancel.signal,
    callId: 'toolu_native_4', rootCallId: 'toolu_native_4' };
  for (const invalidate of [
    () => presets.set(agent.ctx, CHANNEL_DSH_PRESET),
    () => event('step/end', { turn: 4, step: 1 }),
    () => cancel.abort(),
  ]) {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const closed = Promise.withResolvers();
    response = {
      body: JSON.stringify(commonResult),
      async beforeResponse(res) {
        res.once('close', closed.resolve);
        started.resolve();
        await release.promise;
      },
    };
    begin(waitExec, [user()], 4);
    const result = waiting.execute(waitArgs, waitExec);
    await started.promise;
    invalidate();
    if (cancel.signal.aborted) await closed.promise;
    release.resolve();
    assert.deepEqual(await result, { status: cancel.signal.aborted ? 'unavailable' : 'denied' });
    presets.set(agent.ctx, textPreset);
  }
});
