// Real DSH with a loopback model and a fake Feishu adapter. All state is disposable.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { channelToolNames } from '../plugins/qq-agent-presets/channel-tool-contract.mjs';
import { CHANNEL_DSH_TEXT_PRESET, confirmChannelPreset } from '../src/core/channel-dsh-preset.mjs';
import { encodeConversationKey } from '../src/core/identity.mjs';
import { openChannelInbox } from '../src/core/inbox-store.mjs';
import { NodeApiClient } from '../src/dsh-client.js';
import { createLongMemory } from '../src/long-memory.js';
import { startChannelHost } from '../src/runtime/channel-host.mjs';
import { commandSpec } from '../src/runtime/commands.mjs';
import { findDshCli } from '../src/runtime/paths.mjs';
import { stopPid } from '../src/runtime/process.mjs';

const HOST = '127.0.0.1';
const TURN = 'Synthetic channel tool roundtrip.';
const REPLY = 'Fixture reply';
const MODEL_KEY = 'fixture-local-only';
const TOOLS = [...channelToolNames].sort();
const setupFile = fileURLToPath(new URL('./setup-dsh.mjs', import.meta.url));

async function listen(server) {
  server.listen(0, HOST);
  await once(server, 'listening');
  return server.address().port;
}

function closeHttp(server) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  return closed;
}

function printHostTail(file) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const tail = Buffer.alloc(Math.min(8_192, size));
    const read = readSync(fd, tail, 0, tail.length, size - tail.length);
    let lines = tail.subarray(0, read).toString('utf8');
    if (size > tail.length) lines = lines.slice(lines.indexOf('\n') + 1);
    lines = lines.slice(0, lines.lastIndexOf('\n') + 1);
    const redacted = lines
      .replace(/([?&]token=)[^&#\s]+/gi, '$1[redacted]')
      .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[redacted header]')
      .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted value]')
      .replaceAll(MODEL_KEY, '[redacted value]').trim();
    if (redacted) console.error(`DSH fixture host log (redacted tail)\n${redacted}`);
  } finally {
    closeSync(fd);
  }
}

function createModelFixture(observed) {
  const model = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'fixture' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404).end();
      return;
    }
    let input;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      input = JSON.parse(Buffer.concat(chunks));
      if (!Array.isArray(input?.messages) || (input.tools !== undefined && !Array.isArray(input.tools))) {
        throw new TypeError('Invalid model request');
      }
    } catch {
      res.writeHead(400).end();
      return;
    }
    const tools = (input.tools ?? []).map((tool) => tool.name).sort();
    const hasTurn = JSON.stringify(input.messages).includes(TURN);
    const results = input.messages.flatMap(({ content }) => Array.isArray(content) ? content : [])
      .filter((block) => block?.type === 'tool_result');
    let toolCall;
    if (hasTurn && results.length === 0 && tools.includes('channel_get_unread')) {
      toolCall = { id: 'toolu_read_fixture', name: 'channel_get_unread', args: {} };
    } else if (hasTurn && results.length === 1 && tools.includes('channel_reply_text')) {
      toolCall = { id: 'toolu_reply_fixture', name: 'channel_reply_text', args: { text: REPLY } };
    }
    observed.push({ tools, hasTurn, results });

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const write = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    write('message_start', { message: {
      id: 'msg_fixture', model: input.model, type: 'message', role: 'assistant', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 },
    } });
    const contentBlock = toolCall
      ? { type: 'tool_use', id: toolCall.id, name: toolCall.name, input: {} }
      : { type: 'text', text: '' };
    const delta = toolCall
      ? { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.args) }
      : { type: 'text_delta', text: 'Internal fixture response.' };
    write('content_block_start', { index: 0, content_block: contentBlock });
    write('content_block_delta', { index: 0, delta });
    write('content_block_stop', { index: 0 });
    write('message_delta', { delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
    write('message_stop', {});
    res.end();
  });
  return model;
}

async function poll(attempt, accept, signal, hostFailure) {
  while (!signal.aborted) {
    const failure = hostFailure();
    if (failure) throw failure;
    const value = await attempt();
    if (accept(value)) return value;
    await pause(200, undefined, { signal });
  }
  signal.throwIfAborted();
}

const cli = findDshCli();
assert.ok(cli, 'DSH CLI is required');
const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-channel-text-'));
let model, channelHost, portReservation, child;
const hostLog = join(fixtureDir, 'host.log');
try {
  const fixtureEnv = { HOME: fixtureDir, USERPROFILE: fixtureDir, DSH_HOME: join(fixtureDir, '.dsh') };
  const setupEnv = { ...process.env, ...fixtureEnv, QQ_BRIDGE_DSH_BIN: cli };
  for (const key of [
    'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'QQ_BRIDGE_SKIP_DSH_INSTALL',
    'DSH_CHANNEL_TOOL_PORT', 'DSH_CHANNEL_TOOL_SECRET', 'DSH_LAUNCH_TOKEN',
  ]) {
    delete setupEnv[key];
  }
  const setup = spawnSync(process.execPath, [setupFile, 'web'], {
    cwd: fixtureDir, env: setupEnv, encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  if (setup.error) throw setup.error;
  assert.equal(setup.status, 0, `Isolated DSH setup failed: ${setup.stderr}`);
  // NodeApiClient mints its cookie from the new host's own disposable signing key.
  process.env.DSH_HOME = fixtureEnv.DSH_HOME;
  delete process.env.DSH_LAUNCH_TOKEN;

  const observed = [];
  model = createModelFixture(observed);
  const modelPort = await listen(model);
  portReservation = createServer();
  const hostPort = await listen(portReservation);
  const api = new NodeApiClient(`http://${HOST}:${hostPort}`, 2_000, {});
  const account = { platform: 'feishu', accountId: 'cli_fixture_app', tenantId: 'fixture_tenant' };
  const conversation = { ...account, chatType: 'group', chatId: 'oc_fixture', threadId: 'topic_a' };
  const actor = { ...account, userId: 'ou_fixture' };
  const policy = { enabled: true, appId: account.accountId, allow: { groups: [conversation.chatId], senders: [actor.userId] } };
  const stateDir = join(fixtureDir, 'channel-state');
  const longMemory = createLongMemory({ stateDir: join(fixtureDir, 'long-memory') });
  const delivered = [];
  channelHost = await startChannelHost({
    api, workspacePath: fixtureDir, stateDir, longMemory, enableTextTools: true, intervalMs: 50,
    readConfig: () => ({ channels: { textTools: true, feishu: policy } }),
    readRoleState: () => null, readRoleCard: () => '', isSensitive: () => false,
  });
  const binding = channelHost.registerAccount(account, {
    adapter: {
      splitText: (text) => [text],
      sendText(request) {
        delivered.push(request);
        return { status: 'sent', platformMessageId: 'om_sent_fixture' };
      },
    },
  });
  const { port, secret } = channelHost.toolCredentials;

  const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|TMP|TEMP|TMPDIR)$/i.test(key)));
  const hostEnv = {
    ...systemEnv, ...fixtureEnv,
    DEEPSEEK_BASE_URL: `http://${HOST}:${modelPort}`, DEEPSEEK_API_KEY: MODEL_KEY,
    DSH_CHANNEL_TOOL_PORT: String(port), DSH_CHANNEL_TOOL_SECRET: secret,
  };
  const spec = commandSpec(cli, ['--profile', 'web', '--no-open', '--host', HOST, '--port', String(hostPort)], { env: hostEnv });
  await closeHttp(portReservation);
  portReservation = undefined;
  const logFd = openSync(hostLog, 'w', 0o600);
  try {
    child = spawn(spec.command, spec.args, {
      cwd: fixtureDir, env: { ...hostEnv, ...spec.env }, stdio: ['ignore', logFd, logFd], windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments, detached: process.platform !== 'win32',
    });
  } finally {
    closeSync(logFd);
  }
  let failure;
  child.once('error', (error) => { failure = error; });
  child.once('exit', (code, signal) => { failure = new Error(`DSH exited before fixture completion (${code ?? signal})`); });

  const startup = AbortSignal.timeout(120_000);
  await poll(() => confirmChannelPreset(api, { preset: CHANNEL_DSH_TEXT_PRESET, signal: startup }),
    (value) => value === true, startup, () => failure);

  const event = {
    conversation, actor, kind: 'message', senderType: 'human', trigger: 'directed',
    text: TURN, occurredAt: Date.now(), deliveryRef: 'evt_fixture',
    message: { conversation, platformChatId: conversation.chatId, messageId: 'om_fixture' },
  };
  assert.equal(binding.accept(event).status, 'durableAccepted');
  const turnDeadline = AbortSignal.timeout(30_000);
  const inbox = openChannelInbox(join(stateDir, 'inbox.sqlite'), { archive: longMemory.channelArchive });
  let archivedReply;
  try {
    const reader = inbox.bind(account, () => ({ ...account, ...policy }));
    await poll(() => reader.pending().length === 0 && delivered.length > 0, Boolean, turnDeadline, () => failure);
    archivedReply = await poll(
      () => longMemory.archiveRows(encodeConversationKey(conversation), { dir: 'out' })[0],
      Boolean, turnDeadline, () => failure,
    );
  } finally {
    inbox.close();
  }

  const firstRequest = observed.find(({ hasTurn, results }) => hasTurn && results.length === 0);
  assert.deepEqual(firstRequest?.tools, TOOLS, 'DSH must expose only the scoped channel tool set');
  const readResult = observed.flatMap(({ results }) => results).find(({ tool_use_id }) => tool_use_id === 'toolu_read_fixture');
  const readPayload = JSON.parse(readResult?.content?.[0]?.text);
  assert.equal(readPayload.status, 'ok');
  assert.deepEqual(readPayload.data.messages.map(({ text }) => text), [TURN]);
  assert.doesNotMatch(JSON.stringify(readPayload), /ou_fixture|oc_fixture/);
  const toolResult = observed.flatMap(({ results }) => results).find(({ tool_use_id }) => tool_use_id === 'toolu_reply_fixture');
  assert.deepEqual(toolResult?.content, [{ type: 'text', text: '{"status":"queued"}' }],
    'The model must receive only the native tool status');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, REPLY);
  assert.equal(delivered[0].replyToMessageId, 'om_fixture');
  assert.deepEqual(delivered[0].conversation, conversation);
  assert.equal(archivedReply.sendId, delivered[0].sendId);
  assert.equal(archivedReply.msgId, 'om_sent_fixture');
  console.log('Real DSH read the scoped inbox, delivered one authenticated reply, and archived its confirmation.');
} catch (error) {
  if (child) {
    try { printHostTail(hostLog); } catch { /* Keep the original failure if the log cannot be read. */ }
  }
  throw error;
} finally {
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = await stopPid(child.pid, { timeoutMs: 8_000 });
      assert.ok(stopped.ok, 'Fixture DSH did not stop');
    }
  } finally {
    await Promise.all([channelHost?.close(), model && closeHttp(model), portReservation && closeHttp(portReservation)]);
    rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5 });
  }
}
