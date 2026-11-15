import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import {
  CHANNEL_TOOL_MAX_RESULT_BYTES, CHANNEL_TOOL_REQUEST_TIMEOUT_MS, CHANNEL_TOOL_WAIT_REQUEST_TIMEOUT_MS,
  channelTextToolNames, channelToolDenial, channelToolNames, validChannelToolArgs, validChannelToolResult,
} from './channel-tool-contract.mjs';

export const name = 'channel-tool-guard-global';
export const inject = ['tools', 'agents', 'agentPresets'];

const textPreset = 'channel-chat-v2-text';
const channelSessionId = /^cb1-[0-9a-f]{32}-[0-9a-f]{32}$/;
const bridgeRequestId = /^task_[0-9a-f]{64}$/;
const toolCallId = /^[A-Za-z0-9_.:-]{1,128}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
let endpoint;

function consumeEndpointEnv() {
  const port = process.env.DSH_CHANNEL_TOOL_PORT;
  const secret = process.env.DSH_CHANNEL_TOOL_SECRET;
  delete process.env.DSH_CHANNEL_TOOL_PORT;
  delete process.env.DSH_CHANNEL_TOOL_SECRET;
  // Keep the key in this module across plugin remounts, away from child process environments.
  if (!endpoint && /^[1-9][0-9]{0,4}$/.test(port ?? '') && Number(port) <= 65535 &&
      /^[0-9a-f]{64}$/.test(secret ?? '')) {
    endpoint = { port: Number(port), key: Buffer.from(secret, 'hex') };
  }
  return endpoint;
}

async function readResult(name, response) {
  if (response.statusCode !== 200) {
    response.destroy();
    return { status: 'unavailable' };
  }
  const limit = channelTextToolNames.includes(name) ? 256 : CHANNEL_TOOL_MAX_RESULT_BYTES;
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) {
      response.destroy();
      return { status: 'unavailable' };
    }
    chunks.push(chunk);
  }
  const value = JSON.parse(utf8.decode(Buffer.concat(chunks, size)));
  return validChannelToolResult(name, value) ? value : { status: 'unavailable' };
}

async function sendTool(config, payload, signal) {
  try {
    const body = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', config.key).update(body).digest('hex');
    const timeoutMs = payload.name === 'channel_wait_for_messages'
      ? CHANNEL_TOOL_WAIT_REQUEST_TIMEOUT_MS : CHANNEL_TOOL_REQUEST_TIMEOUT_MS;
    return await new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: config.port, path: '/channel/text-tool', method: 'POST', agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: {
          'content-type': 'application/json', 'content-length': body.length, authorization: `Bearer ${signature}`,
        },
      }, response => readResult(payload.name, response).then(resolve, reject));
      req.once('error', reject);
      req.end(body);
    });
  } catch {
    return { status: 'unavailable' };
  }
}

function observeTurn(turns, session, { type, data }) {
  if (typeof session?.id !== 'string' || !channelSessionId.test(session.id)) return;
  if (type === 'turn/start') {
    turns.set(session, { turn: data.turn, step: null, requestId: null, call: null });
    return;
  }
  if (type === 'turn/end') {
    turns.delete(session);
    return;
  }
  const current = turns.get(session);
  if (!current) return;
  if (type === 'user/message') {
    const source = data.source;
    // The loop records its own runtime context as a user/message alongside the actual input.
    if (source?.kind === 'runtime-context') return;
    current.requestId = current.requestId === null && source?.kind === 'user' &&
      typeof source.rpcId === 'string' && bridgeRequestId.test(source.rpcId) ? source.rpcId : false;
    return;
  }
  if (data?.turn !== current.turn) return;
  if (type === 'step/start' || type === 'step/end') {
    current.step = type === 'step/start' ? data.step : null;
    current.call = null;
  } else if (current.step !== null && data.step === current.step) {
    // The native batch logs the model call before entering its guard. These tools run exclusively.
    if (type === 'tool/call') current.call = data;
    if (type === 'tool/result' && data.message?.toolCallId === current.call?.callId) current.call = null;
  }
}

export function apply(ctx) {
  const config = consumeEndpointEnv();
  const definitions = new WeakSet();
  const turns = new WeakMap();
  ctx.on('session/event', (session, event) => observeTurn(turns, session, event));

  function isTextAgent(agent) {
    const sessionId = agent?.id;
    if (typeof sessionId !== 'string' || !channelSessionId.test(sessionId) ||
        ctx.agents.get(sessionId) !== agent || ctx.agentPresets.composedPreset(agent.ctx) !== textPreset) return false;
    const { session } = agent;
    const { header } = session ?? {};
    return session?.id === sessionId && header?.id === sessionId && header.isSeeded === false &&
      header.parentSession === undefined && header.origin === undefined && (header.delegationDepth ?? 0) === 0;
  }

  function requestFor(exec) {
    try {
      const { agent, callId, name: toolName } = exec ?? {};
      if (!config || !channelToolNames.includes(toolName) || typeof callId !== 'string' ||
          !toolCallId.test(callId) || exec.rootCallId !== callId || typeof exec.token !== 'symbol' ||
          exec.parent !== undefined || exec.schema !== undefined || !(exec.signal instanceof AbortSignal) ||
          exec.signal.aborted) return;
      if (!isTextAgent(agent) || agent.status !== 'running') return;

      const current = turns.get(agent.session);
      if (!current?.requestId || current.call?.callId !== callId || current.call.name !== toolName) return;
      const schemas = ctx.tools.schemas(agent);
      if (schemas.length !== channelToolNames.length || !channelToolNames.every(name =>
        schemas.some(schema => schema.name === name) && definitions.has(ctx.tools.get(name, agent)))) return;
      return { sessionId: agent.id, requestId: current.requestId, callId };
    } catch {
      return undefined;
    }
  }

  const dispose = ctx.tools.guard(exec => {
    // Also protect channel IDs under a different preset, including blank
    // sessions whose preset changed after creation.
    if ((typeof exec?.agent?.id === 'string' && exec.agent.id.startsWith('cb1-')) ||
        channelToolNames.includes(exec?.name)) {
      if (!requestFor(exec)) return channelToolDenial;
    }
  });
  if (typeof dispose !== 'function') throw new Error('DSH channel tool guard registration failed');
  ctx.provide('channelToolGuard', Object.freeze({
    enabled: Boolean(config),
    requestFor,
    isTextAgent,
    registerChannelTool: definition => definitions.add(definition),
    async submit(exec, args) {
      const request = requestFor(exec);
      if (!request) return { status: 'denied' };
      if (!validChannelToolArgs(exec.name, args) || !validChannelToolArgs(exec.name, exec.arguments) ||
          (args !== exec.arguments && !isDeepStrictEqual(args, exec.arguments))) {
        return { status: 'invalid' };
      }
      const result = await sendTool(config, { ...request, name: exec.name, args }, exec.signal);
      if (exec.signal.aborted) return { status: 'unavailable' };
      return isDeepStrictEqual(request, requestFor(exec)) ? result : { status: 'denied' };
    },
  }));
}
