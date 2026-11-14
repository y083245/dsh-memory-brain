import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isChannelOutboxId } from './outbox-store.mjs';
import {
  CHANNEL_TOOL_REQUEST_TIMEOUT_MS, CHANNEL_TOOL_WAIT_REQUEST_TIMEOUT_MS, channelCommonToolStatuses,
  channelTextToolNames, channelTextToolStatuses, validChannelToolArgs, validChannelToolResult,
} from '../../plugins/qq-agent-presets/channel-tool-contract.mjs';

const HOST = '127.0.0.1';
const ROUTE = '/channel/text-tool';
const MAX_CONNECTIONS = 16;
// A single UTF-8 byte can take six bytes in JSON. Leave room for the IDs and keys.
const MAX_BODY_BYTES = 6 * 1024 * 1024 + 1024;
const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const AUTH_PATTERN = /^Bearer ([0-9a-f]{64})$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hasFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function readPayload(raw) {
  const value = JSON.parse(utf8.decode(raw));
  if (!hasFields(value, ['sessionId', 'requestId', 'callId', 'name', 'args'])) return null;
  const { sessionId, requestId, callId, name, args } = value;
  if (![sessionId, requestId, callId].every(isChannelOutboxId) || !validChannelToolArgs(name, args)) return null;
  return { sessionId, requestId, callId, name, args };
}

function respond(res, code, status, result = { status }) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(result);
  res.writeHead(code, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body), Connection: 'close',
  });
  res.end(body);
}

async function dispatchCommonTool(res, payload, execute, deadline) {
  if (typeof execute !== 'function') {
    respond(res, 200, 'unavailable');
    return;
  }
  if (res.destroyed) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    respond(res, 408, 'unavailable');
  }, Math.max(0, deadline - performance.now()));
  const onClose = () => {
    clearTimeout(timeout);
    controller.abort();
  };
  res.once('close', onClose);
  try {
    const result = await execute(payload, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (performance.now() >= deadline) {
      controller.abort();
      respond(res, 408, 'unavailable');
      return;
    }
    const status = result && Object.getOwnPropertyDescriptor(result, 'status')?.value;
    if (status !== 'ok' && channelCommonToolStatuses.includes(status)) {
      respond(res, 200, status);
      return;
    }
    if (validChannelToolResult(payload.name, result)) {
      respond(res, 200, 'ok', result);
      return;
    }
  } catch {
    // Errors may contain request data. Only send the fixed failure status.
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
  }
  if (!controller.signal.aborted) respond(res, 500, 'unavailable');
}

export async function startChannelToolServer({
  invokeTextTool, invokeCommonTool, port = 0, secret = randomBytes(32).toString('hex'),
} = {}) {
  if (typeof invokeTextTool !== 'function' || (invokeCommonTool !== undefined && typeof invokeCommonTool !== 'function') ||
      typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
    throw new TypeError('Invalid channel tool listener configuration');
  }
  const key = Buffer.from(secret, 'hex');
  const server = createServer({
    headersTimeout: CHANNEL_TOOL_REQUEST_TIMEOUT_MS, requestTimeout: CHANNEL_TOOL_REQUEST_TIMEOUT_MS + 1_000,
    connectionsCheckingInterval: 1_000, maxHeaderSize: 8_192,
  }, (req, res) => {
    const headers = req.headersDistinct;
    if (headers.host?.length !== 1 || headers.host[0] !== `${HOST}:${req.socket.localPort}`) {
      respond(res, 400, 'invalid');
      return;
    }
    if (req.method !== 'POST' || req.url !== ROUTE) {
      respond(res, 404, 'invalid');
      return;
    }
    const signature = headers.authorization?.length === 1 && AUTH_PATTERN.exec(headers.authorization[0]);
    if (!signature) {
      respond(res, 401, 'denied');
      return;
    }
    if (headers['content-type']?.length !== 1 ||
        !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(headers['content-type'][0]) ||
        headers['content-encoding']) {
      respond(res, 400, 'invalid');
      return;
    }
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      respond(res, 413, 'invalid');
      return;
    }

    const startedAt = performance.now();
    const deadline = startedAt + CHANNEL_TOOL_REQUEST_TIMEOUT_MS;
    const chunks = [];
    let length = 0;
    const timeout = setTimeout(() => {
      chunks.length = 0;
      respond(res, 408, 'unavailable');
    }, CHANNEL_TOOL_REQUEST_TIMEOUT_MS);
    req.once('close', () => clearTimeout(timeout));
    req.once('error', () => clearTimeout(timeout));
    req.on('data', (chunk) => {
      if (res.writableEnded) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        clearTimeout(timeout);
        chunks.length = 0;
        respond(res, 413, 'invalid');
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      clearTimeout(timeout);
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks, length);
      const expected = createHmac('sha256', key).update(raw).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature[1], 'hex'))) {
        respond(res, 401, 'denied');
        return;
      }
      let payload;
      try {
        payload = readPayload(raw);
      } catch {
        respond(res, 400, 'invalid');
        return;
      }
      if (!payload) {
        respond(res, 400, 'invalid');
        return;
      }
      if (performance.now() >= deadline) {
        respond(res, 408, 'unavailable');
        return;
      }
      if (!channelTextToolNames.includes(payload.name)) {
        const toolDeadline = payload.name === 'channel_wait_for_messages'
          ? startedAt + CHANNEL_TOOL_WAIT_REQUEST_TIMEOUT_MS : deadline;
        void dispatchCommonTool(res, payload, invokeCommonTool, toolDeadline);
        return;
      }
      try {
        const result = invokeTextTool(payload);
        if (typeof result?.then === 'function') void Promise.resolve(result).catch(() => {});
        else if (result && Object.hasOwn(result, 'status')) {
          const { status } = result;
          if (channelTextToolStatuses.includes(status)) {
            respond(res, 200, status);
            return;
          }
        }
      } catch {
        // Errors may contain request data. Only send the fixed failure status.
      }
      respond(res, 500, 'unavailable');
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on('checkContinue', (_req, res) => respond(res, 417, 'invalid'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let closing;
  return {
    port: server.address().port,
    secret,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
