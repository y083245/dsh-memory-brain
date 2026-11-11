import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createChannelDshTransport } from '../src/core/channel-dsh-transport.mjs';
import { NodeApiClient } from '../src/dsh-client.js';

const TURN = { sessionId: 'channel-session-fixture', requestId: 'channel-request-fixture' };
const CONTENT = [{ type: 'text', text: 'Private prompt fixture' }];
const UNKNOWN = { status: 'unknown' };

function ok(value) {
  return { ok: true, value };
}

function rejected(code, sessionId = TURN.sessionId) {
  return { ok: false, error: { code, details: { sessionId }, message: 'Private error fixture' } };
}

function userMessage(requestId) {
  return { id: `message-${requestId}`, role: 'user', source: { kind: 'user', rpcId: requestId }, content: CONTENT };
}

function record(seq, type, data) {
  const event = { seq, time: seq + 100, type, data };
  if (type === 'user/message' || type === 'assistant/message') event.surfaceOp = 'append';
  return { type: 'event', event };
}

function start(seq, turn) {
  return record(seq, 'turn/start', { turn });
}

function message(seq, requestId = TURN.requestId) {
  return record(seq, 'user/message', userMessage(requestId));
}

function end(seq, turn, reason = { kind: 'completed' }) {
  return record(seq, 'turn/end', { turn, reason });
}

async function dsh(t, handle) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ url: req.url, ...envelope });
    const result = handle(envelope.method);
    if (result === null) {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = new NodeApiClient(`http://127.0.0.1:${server.address().port}`, 1500, { token: 'fixture-token' });
  api.cookie = 'fixture=local';
  return { transport: createChannelDshTransport(api), calls };
}

async function history(t, data) {
  return dsh(t, (method) => {
    if (method === 'session/projections') {
      return ok({
        kind: 'sequenced',
        asOfSeq: data.cursor,
        values: { inbox: { 'next-turn': data.queued ?? [], 'next-step': [] } },
      });
    }
    if (method === 'session/page') return ok({ records: data.records, hasMore: data.hasMore ?? false });
    return rejected('gateway/lookup-not-found');
  });
}

test('uses the stored request ID with queue mode and returns only the prompt receipt', async (t) => {
  const { transport, calls } = await dsh(t, () => ok({ accepted: true }));
  assert.deepEqual(await transport.submit(TURN, CONTENT), { status: 'accepted' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/session/prompt');
  assert.deepEqual(calls[0].payload, { args: { request: {
    sessionId: 'channel-session-fixture', requestId: 'channel-request-fixture', mode: 'queue', content: CONTENT,
  } } });
  assert.notEqual(calls[0].rpcId, TURN.requestId);
});

test('ambiguous prompt responses and dropped connections cannot imply acceptance or replay', async (t) => {
  let response;
  const { transport, calls } = await dsh(t, () => response);
  for (response of [
    ok({ accepted: 'true', turnId: '1', reply: 'Private model fixture' }),
    { ok: 'true', value: { accepted: true } },
    rejected('gateway/internal'),
    rejected('session/not-found', 'another-session'),
    null,
  ]) assert.deepEqual(await transport.submit(TURN, CONTENT), UNKNOWN);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ method }) => method === 'session/prompt'));
});

test('an explicit prompt rejection for the exact missing session confirms non-submission', async (t) => {
  const { transport } = await dsh(t, () => rejected('session/not-found'));
  assert.deepEqual(await transport.submit(TURN, CONTENT), { status: 'not_submitted' });
});

test('reads the exact session at the projection watermark and binds only the matching request', async (t) => {
  const data = {
    cursor: 8,
    records: [
      start(0, 7), message(1, 'older-request'), end(2, 7),
      start(3, 8), message(4), end(5, 8),
      start(6, 9), message(7, 'newer-request'), end(8, 9),
    ],
  };
  const { transport, calls } = await history(t, data);
  assert.deepEqual(await transport.reconcile(TURN), { status: 'completed', turnId: '8' });
  assert.deepEqual(calls.map(({ url }) => url), ['/api/session/projections', '/api/session/page']);
  assert.deepEqual(calls[0].payload, { args: { request: { sessionId: 'channel-session-fixture' } } });
  const page = calls[1].payload.args.request;
  assert.deepEqual(page.address, { kind: 'session', sessionId: 'channel-session-fixture' });
  assert.equal(page.throughSeq, 8);
  assert.ok(Number.isSafeInteger(page.maxMessages) && page.maxMessages > 0);
});

test('queued requests and open turns remain pending even with assistant text in history', async (t) => {
  const queued = [userMessage(TURN.requestId)];
  const data = {
    cursor: 0,
    records: [record(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: queued })],
    queued,
  };
  const { transport } = await history(t, data);
  assert.deepEqual(await transport.reconcile(TURN), { status: 'pending' });
  data.queued = [];
  data.cursor = 3;
  data.records = [
    start(0, 5), message(1),
    record(2, 'assistant/message', {
      turn: 5, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Private model fixture' }] },
    }),
    record(3, 'step/end', { turn: 5, step: 1 }),
  ];
  assert.deepEqual(await transport.reconcile(TURN), { status: 'pending', turnId: '5' });
});

test('a stored turn ID matches the corresponding terminal record in a bounded page', async (t) => {
  const data = { cursor: 11, hasMore: true, records: [end(11, 4, { kind: 'interrupted' })] };
  const { transport } = await history(t, data);
  assert.deepEqual(await transport.reconcile(TURN), UNKNOWN);
  assert.deepEqual(await transport.reconcile({ ...TURN, turnId: '4' }), { status: 'completed', turnId: '4' });
  assert.deepEqual(await transport.reconcile({ ...TURN, turnId: '3' }), UNKNOWN);
});

test('conflicting, missing and malformed history cannot bind or complete a request', async (t) => {
  const data = { cursor: 2, records: [start(0, 1), message(1), end(2, 1)] };
  const { transport } = await history(t, data);
  assert.deepEqual(await transport.reconcile({ ...TURN, turnId: '2' }), UNKNOWN);
  for (const records of [
    [start(0, 1), message(1, 'wrong-request'), end(2, 1)],
    [start(0, 1), message(1), end(2, 2)],
    [start(0, 1), message(1), end(2, 1, { kind: 'unrecognized' })],
    [start(0, 1), message(1), end(2, 1, { kind: 'aborted' })],
    [start(0, 1), message(1), end(2, 1, { kind: 'error' })],
    [start(0, 1), message(1), end(2, 1, { kind: 'forked' })],
    [start(0, 1), message(1), end(3, 1)],
    [start(0, 1), message(1), null],
  ]) {
    data.records = records;
    assert.deepEqual(await transport.reconcile(TURN), UNKNOWN);
  }
  data.cursor = 5;
  data.records = [start(0, 1), message(1), end(2, 1), start(3, 2), message(4), end(5, 2)];
  assert.deepEqual(await transport.reconcile(TURN), UNKNOWN);
  data.cursor = 2;
  data.records = [start(0, 1), message(1, 'wrong-request'), end(2, 1)];
  assert.deepEqual(await transport.reconcile({ ...TURN, turnId: '1' }), UNKNOWN);
});

test('invalid stored turn identifiers cannot trigger a history request', async (t) => {
  const { transport, calls } = await dsh(t, () => ok(null));
  for (const turnId of [1, '01', '0', '1\n', '9007199254740992', Symbol('malformed')]) {
    assert.deepEqual(await transport.reconcile({ ...TURN, turnId }), UNKNOWN);
  }
  assert.deepEqual(calls, []);
});

test('terminal aborts and model errors confirm execution ended without exposing their detail', async (t) => {
  const data = { cursor: 2 };
  const { transport } = await history(t, data);
  for (const reason of [
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'error', error: { message: 'Private model error', code: 'UNKNOWN' } },
    { kind: 'blocked' },
    { kind: 'max-tokens' },
  ]) {
    data.records = [start(0, 1), message(1), end(2, 1, reason)];
    assert.deepEqual(await transport.reconcile(TURN), { status: 'completed', turnId: '1' });
  }
});

test('retirement clears the queue and cancels work before verifying archival', async (t) => {
  const { transport, calls } = await dsh(t, (method) => {
    if (method === 'session/projections') {
      return ok({ kind: 'sequenced', asOfSeq: 4, values: { inbox: { 'next-turn': [userMessage('waiting')], 'next-step': [] } } });
    }
    if (method === 'workspace/archiveSession') return ok({ archivedSessionIds: [TURN.sessionId] });
    return ok({ accepted: true });
  });
  assert.deepEqual(await transport.retire(TURN), { status: 'retired' });
  assert.deepEqual(calls.map(({ method, payload }) => [method, payload.args.request]), [
    ['session/projections', { sessionId: 'channel-session-fixture' }],
    ['session/updateQueue', {
      sessionId: 'channel-session-fixture', itemId: 'message-waiting', action: { kind: 'remove' },
    }],
    ['session/cancel', { sessionId: 'channel-session-fixture' }],
    ['workspace/archiveSession', { sessionId: 'channel-session-fixture' }],
  ]);
});

test('retirement requires the archive RPC to confirm the same session', async (t) => {
  let cancellation = rejected('session/not-found');
  let archival;
  const { transport, calls } = await dsh(t, (method) => {
    if (method === 'session/projections') return ok(null);
    if (method === 'session/cancel') return cancellation;
    return archival;
  });
  for (archival of [
    ok({ archivedSessionIds: ['other-session'] }),
    ok({ archivedSessionIds: TURN.sessionId }),
    { ok: 'true', value: { archivedSessionIds: [TURN.sessionId] } },
    rejected('workspace/session-active'),
    rejected('session/not-found', 'other-session'),
    null,
  ]) assert.deepEqual(await transport.retire(TURN), UNKNOWN);
  archival = rejected('session/not-found');
  assert.deepEqual(await transport.retire(TURN), { status: 'retired' });
  cancellation = rejected('gateway/internal');
  assert.deepEqual(await transport.retire(TURN), UNKNOWN);
  assert.equal(calls.at(-1).method, 'session/cancel');
});

test('already-aborted operations leave DSH untouched', async (t) => {
  const { transport, calls } = await dsh(t, () => ok({ accepted: true }));
  const signal = AbortSignal.abort(new Error('Private reason'));
  assert.deepEqual(await transport.submit(TURN, CONTENT, { signal }), UNKNOWN);
  assert.deepEqual(await transport.reconcile(TURN, { signal }), UNKNOWN);
  assert.deepEqual(await transport.retire(TURN, { signal }), UNKNOWN);
  assert.deepEqual(calls, []);
});
