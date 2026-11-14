import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { startChannelToolServer } from '../src/core/channel-tool-server.mjs';

const secret = '07'.repeat(32);
const payload = {
  sessionId: 'session-1', requestId: 'request-1', callId: 'call-1',
  name: 'channel_reply_text', args: { text: '一封原始来信' },
};

function sign(body) {
  return `Bearer ${createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest('hex')}`;
}

function post(port, body, { headers, method = 'POST', path = '/channel/text-tool', stream, partial } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json',
      ...(stream ? {} : { 'Content-Length': Buffer.byteLength(body) }), Authorization: sign(body), ...headers,
    };
    const req = request({
      hostname: '127.0.0.1', port, method, path, agent: false,
      headers: Object.entries(requestHeaders).flatMap(([name, value]) => [value].flat().flatMap((entry) => [name, entry])),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (partial) {
      req.write(body);
      return;
    }
    req.end(body);
  });
}

async function fixture(t, invokeTextTool, invokeCommonTool) {
  const server = await startChannelToolServer({ secret, invokeTextTool, invokeCommonTool });
  t.after(server.close);
  return server.port;
}

test('authenticates the exact UTF-8 bytes and forwards only the host envelope', async (t) => {
  const calls = [];
  const port = await fixture(t, (value) => {
    calls.push(value);
    return { status: 'queued', private: secret, text: payload.args.text };
  });
  const original = Buffer.from(JSON.stringify(payload, null, 2));
  assert.deepEqual(await post(port, original), { code: 200, body: { status: 'queued' } });
  assert.deepEqual(calls, [payload]);

  const tampered = original.toString().replace('原始', '修改');
  assert.deepEqual(await post(port, tampered, { headers: { Authorization: sign(original) } }), {
    code: 401, body: { status: 'denied' },
  });
  assert.deepEqual(await post(port, original, { headers: { Authorization: '' } }), {
    code: 401, body: { status: 'denied' },
  });
  assert.deepEqual(calls, [payload]);
});

test('rejects other hosts, methods, paths, query strings and content types', async (t) => {
  const port = await fixture(t, () => ({ status: 'queued' }));
  const body = JSON.stringify(payload);
  for (const [options, code] of [
    [{ headers: { Host: `localhost:${port}` } }, 400],
    [{ headers: { Host: 'external.example' } }, 400],
    [{ headers: { Host: '127.0.0.1' } }, 400],
    [{ headers: { Host: [`127.0.0.1:${port}`, 'external.example'] } }, 400],
    [{ method: 'PUT' }, 404],
    [{ path: '/channel/text-tool?route=external' }, 404],
    [{ path: '/channel/text-tool?' }, 404],
    [{ path: '/channel/text-tool/' }, 404],
    [{ headers: { 'Content-Type': 'text/plain' } }, 400],
  ]) {
    assert.deepEqual(await post(port, body, options), { code, body: { status: 'invalid' } });
  }
});

test('rejects signed malformed JSON and extra or malformed envelope fields', async (t) => {
  const port = await fixture(t, () => ({ status: 'queued' }));
  const invalid = [
    { ...payload, args: { text: '内容', chatId: 'other' } },
    { ...payload, args: { text: '内容', ['__proto__']: {} } },
    { ...payload, accountId: 'other' },
    { ...payload, name: 'send_external' },
    { ...payload, sessionId: '' },
    { ...payload, callId: 'call-1\n' },
    { ...payload, requestId: null },
    { ...payload, args: null },
    { ...payload, args: { text: 1 } },
    { ...payload, args: { text: '  ' } },
    { ...payload, args: { text: '\0' } },
    { ...payload, args: { text: '\ud800' } },
    [payload],
  ].map((value) => JSON.stringify(value));
  invalid.push('{', Buffer.concat([Buffer.from(JSON.stringify(payload).slice(0, -3)), Buffer.from([0xff, 34, 125, 125])]));
  for (const body of invalid) {
    assert.deepEqual(await post(port, body), { code: 400, body: { status: 'invalid' } });
  }
});

test('accepts 1 MiB of decoded text with worst-case JSON escaping and bounds larger bodies', async (t) => {
  const port = await fixture(t, () => ({ status: 'queued' }));
  const limit = 1024 * 1024;
  const body = (text) => JSON.stringify({ ...payload, args: { text } });
  assert.deepEqual(await post(port, body('\u0001'.repeat(limit))), { code: 200, body: { status: 'queued' } });
  assert.deepEqual(await post(port, body('界'.repeat(Math.floor(limit / 3) + 1))), {
    code: 400, body: { status: 'invalid' },
  });
  assert.deepEqual(await post(port, '', { headers: { 'Content-Length': 7 * limit } }), {
    code: 413, body: { status: 'invalid' },
  });
  assert.deepEqual(await post(port, body('\u0001'.repeat(limit + 2048)), { stream: true }), {
    code: 413, body: { status: 'invalid' },
  });
});

test('closes an incomplete body at the request deadline', { timeout: 10_000 }, async (t) => {
  let calls = 0;
  const port = await fixture(t, () => {
    calls += 1;
    return { status: 'queued' };
  });
  assert.deepEqual(await post(port, '{', { partial: true, headers: { 'Content-Length': 100 } }), {
    code: 408, body: { status: 'unavailable' },
  });
  assert.equal(calls, 0);
});

test('returns a sanitized failure for unknown statuses, callback throws and async callbacks', async (t) => {
  const results = [
    () => ({ status: secret }),
    () => { throw new Error(payload.args.text); },
    async () => { throw new Error(payload.args.text); },
  ];
  const port = await fixture(t, () => results.shift()());
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await post(port, JSON.stringify(payload)), { code: 500, body: { status: 'unavailable' } });
  }
});

const commonPayload = (name, args) => ({ ...payload, name: `channel_${name}`, args });

test('authenticates shared tools and rejects malformed arguments before the host callback', async (t) => {
  const calls = [];
  const port = await fixture(t, () => ({ status: 'queued' }), async (value, { signal }) => {
    assert.equal(signal.aborted, false);
    calls.push(value);
    return { status: 'ok', data: { seen: [1, '已读'] } };
  });
  const authorized = [
    commonPayload('get_unread', { afterSeq: 0, limit: 100 }),
    commonPayload('history_search', { query: '原话', keywords: ['关键字'], from: '上周', to: '今天', limit: 1 }),
    commonPayload('memory_recall', {}),
    commonPayload('memory_remember', { cat: 'pending', text: '去公园', due: '明天', by: 'them', core: true, replaces: 'id-1' }),
    commonPayload('memory_update', { itemId: 'id-1', text: '更正', cat: 'pending', due: '', by: '', core: false,
      status: 'open', archived: false, outdated: true }),
    commonPayload('memory_forget', { itemId: 'id-1' }),
    commonPayload('wait_for_messages', { afterSeq: 5, timeoutMs: 30_000 }),
    commonPayload('mark_read', { throughSeq: Number.MAX_SAFE_INTEGER }),
    commonPayload('set_wake_config', { throughSeq: 0, groupPolicy: 'observe' }),
    commonPayload('feedback', { message: '这是一条反馈' }),
  ];
  for (const value of authorized) {
    assert.deepEqual(await post(port, JSON.stringify(value)), { code: 200, body: { status: 'ok', data: { seen: [1, '已读'] } } });
    assert.deepEqual(await post(port, JSON.stringify(value), { headers: { Authorization: sign(JSON.stringify(payload)) } }),
      { code: 401, body: { status: 'denied' } });
    assert.deepEqual(await post(port, JSON.stringify({ ...value, args: { ...value.args, source: 'another-source' } })),
      { code: 400, body: { status: 'invalid' } });
  }
  for (const value of [
    commonPayload('get_unread', { afterSeq: -1 }),
    commonPayload('get_unread', { afterSeq: Number.MAX_SAFE_INTEGER + 1 }),
    commonPayload('get_unread', { limit: 101 }),
    commonPayload('history_search', { keywords: ['x', false] }),
    commonPayload('history_search', { keywords: Array(13).fill('x') }),
    commonPayload('history_search', { query: '界'.repeat(200) }),
    commonPayload('history_search', { from: 3 }),
    commonPayload('memory_recall', { scope: 'public' }),
    commonPayload('memory_remember', { cat: 'invalid', text: '内容' }),
    commonPayload('memory_remember', { cat: 'note', text: ' ', by: 'public' }),
    commonPayload('memory_update', { itemId: 'id', archived: 'false' }),
    commonPayload('memory_update', { itemId: 'id', status: 'pending' }),
    commonPayload('memory_forget', { itemId: 'a/b' }),
    commonPayload('wait_for_messages', { timeoutMs: 30_001 }),
    commonPayload('wait_for_messages', { afterSeq: 1.5 }),
    commonPayload('mark_read', {}),
    commonPayload('set_wake_config', { groupPolicy: 'directed' }),
    commonPayload('set_wake_config', { throughSeq: 0, groupPolicy: 'admin' }),
    commonPayload('feedback', { message: '\ud800' }),
    commonPayload('feedback', { message: '界'.repeat(1_400) }),
    { ...authorized[2], name: ['channel_memory_recall'] },
    { ...authorized[2], name: { toString: 'channel_memory_recall' } },
    { ...authorized[0], scope: 'public' },
  ]) {
    assert.deepEqual(await post(port, JSON.stringify(value)), { code: 400, body: { status: 'invalid' } });
  }
  assert.deepEqual(calls, authorized);
});

test('allows a text-only server and strips data from common failures', async (t) => {
  const body = JSON.stringify(commonPayload('memory_recall', {}));
  const withoutCommon = await fixture(t, () => ({ status: 'queued' }));
  assert.deepEqual(await post(withoutCommon, body), { code: 200, body: { status: 'unavailable' } });

  const results = [
    () => ({ status: 'denied', data: { text: 'private' }, detail: secret }),
    () => ({ status: 'ok', data: [] }),
    () => ({ status: 'ok', data: { ['__proto__']: {} } }),
    () => ({ status: 'ok', data: { value: Infinity } }),
    () => ({ status: 'ok', data: { unread: undefined } }),
    () => ({ status: 'ok', data: { text: '界'.repeat(6_000) } }),
    () => ({ status: 'ok', data: { nested: JSON.parse('['.repeat(16) + '0' + ']'.repeat(16)) } }),
    () => ({ status: 'ok', data: { get x() { throw new Error(secret); } } }),
    () => ({ status: 'ok', data: { text: 'x'.repeat(2_048) } }),
    async () => { throw new Error(secret); },
  ];
  const port = await fixture(t, () => ({ status: 'queued' }), () => results.shift()());
  assert.deepEqual(await post(port, body), { code: 200, body: { status: 'denied' } });
  for (let i = 0; i < 7; i += 1) {
    assert.deepEqual(await post(port, body), { code: 500, body: { status: 'unavailable' } });
  }
  assert.deepEqual(await post(port, body), { code: 200, body: { status: 'ok', data: { text: 'x'.repeat(2_048) } } });
  assert.deepEqual(await post(port, body), { code: 500, body: { status: 'unavailable' } });
});

test('aborts a shared tool when the client disconnects and allows another request', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const port = await fixture(t, () => ({ status: 'queued' }), async ({ name }, { signal }) => {
    if (name !== 'channel_wait_for_messages') return { status: 'ok', data: {} };
    signal.addEventListener('abort', () => aborted.resolve(signal.aborted), { once: true });
    started.resolve();
    await aborted.promise;
    return { status: 'denied' };
  });
  const body = JSON.stringify(commonPayload('wait_for_messages', { timeoutMs: 30_000 }));
  const client = request({ hostname: '127.0.0.1', port, path: '/channel/text-tool', method: 'POST', agent: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: sign(body) } });
  client.on('error', () => {});
  client.end(body);
  try {
    await started.promise;
    client.destroy();
    assert.equal(await aborted.promise, true);
    assert.deepEqual(await post(port, JSON.stringify(commonPayload('memory_recall', {}))),
      { code: 200, body: { status: 'ok', data: {} } });
  } finally {
    client.destroy();
  }
});

test('only the wait tool can use a longer execution budget', { timeout: 12_000 }, async (t) => {
  const canceled = Promise.withResolvers();
  const port = await fixture(t, () => ({ status: 'queued' }), async ({ name }, { signal }) => {
    if (name === 'channel_wait_for_messages') {
      await pause(5_100, undefined, { signal });
      return { status: 'ok', data: { messages: [] } };
    }
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    canceled.resolve(signal.aborted);
    return { status: 'denied' };
  });
  const [waiting, timed] = await Promise.all([
    post(port, JSON.stringify(commonPayload('wait_for_messages', { timeoutMs: 6_000 }))),
    post(port, JSON.stringify(commonPayload('memory_recall', {}))),
  ]);
  assert.deepEqual(waiting, { code: 200, body: { status: 'ok', data: { messages: [] } } });
  assert.deepEqual(timed, { code: 408, body: { status: 'unavailable' } });
  assert.equal(await canceled.promise, true);
});
