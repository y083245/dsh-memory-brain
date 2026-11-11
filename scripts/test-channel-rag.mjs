import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { encodeConversationKey, encodePersonKey } from '../src/core/identity.mjs';
import { createMemoryRagClient } from '../src/memory-rag-client.js';

const FEISHU = { platform: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' };
const SOURCE = { ...FEISHU, chatType: 'group', chatId: 'oc_fixture', threadId: 'one' };
const KEY = encodeConversationKey(SOURCE);
const OTHER = encodeConversationKey({ ...SOURCE, threadId: 'two' });
const TELEGRAM = encodeConversationKey({ platform: 'telegram', accountId: '41', chatType: 'group', chatId: '-100123' });
const QQ = 'group:123';
const QUERY = '私密检索短语';
const PROTOCOL = { ok: true, archive_protocol: { identity: 1, archive: 1, index: 1 } };
const FILE = `c1_${createHash('sha256').update(KEY).digest('hex')}/2026-11.jsonl`;
const RECORD_ID = `record_${'a'.repeat(64)}`;

async function sidecar(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    const request = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null };
    requests.push(request);
    const { status = 200, headers, data } = respond(request);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function searchResponse(key = KEY, file = FILE) {
  return { key, semantic: 'ok', tokens: ['hidden'], items: [{
    day: '2026-11-01', title: '往事', sources: ['bm25'], text: '原文证据', score: 0.9,
    file, file_end: file, line_start: 3, line_end: 3, byte_start: 0, byte_end: 480,
    record_id_start: RECORD_ID, record_id_end: RECORD_ID,
  }] };
}

test('channel search negotiates before sending text and keeps evidence internal', async (t) => {
  const server = await sidecar(t, ({ method }) => ({ data: method === 'GET' ? PROTOCOL : searchResponse() }));
  const result = await createMemoryRagClient(server).search({ key: KEY, query: QUERY, context: 1 });
  assert.deepEqual(result, {
    semantic: 'ok', items: [{ day: '2026-11-01', title: '往事', sources: ['bm25'], text: '原文证据' }],
  });
  assert.deepEqual(result.refs, [{ file: FILE, fileEnd: FILE, lineStart: 3, lineEnd: 3,
    byteStart: 0, byteEnd: 480, recordIdStart: RECORD_ID, recordIdEnd: RECORD_ID }]);
  assert.deepEqual(server.requests, [
    { method: 'GET', path: '/health?protocol=channel', body: null },
    { method: 'POST', path: '/search', body: { key: KEY, query: QUERY, k: 5 } },
  ]);
});

test('missing, malformed, incompatible, or unavailable protocol never receives a channel body', async (t) => {
  let health;
  const logs = [];
  const server = await sidecar(t, ({ method }) => method === 'GET' ? health : { data: searchResponse() });
  const client = createMemoryRagClient({ ...server, log: (line) => logs.push(line) });
  for (health of [
    { data: { ok: true } },
    { data: { ok: false, archive_protocol: PROTOCOL.archive_protocol } },
    { data: { ok: 'true', archive_protocol: PROTOCOL.archive_protocol } },
    { data: { ok: true, archive_protocol: { identity: '1', archive: 1, index: 1 } } },
    { data: { ok: true, archive_protocol: { identity: 1, archive: 2, index: 1 } } },
    { data: { ok: true, archive_protocol: { identity: 1, archive: 1 } } },
    { status: 503, data: { error: `${QUERY} ${KEY}` } },
  ]) assert.equal(await client.search({ key: KEY, query: QUERY }), null);
  assert.equal(server.requests.length, 7);
  assert.ok(server.requests.every(({ method, body }) => method === 'GET' && body === null));
  assert.ok(logs.length > 0);
  assert.ok(logs.every((line) => !line.includes(QUERY) && !line.includes(KEY)));
});

test('rejects malformed channel keys, scoped QQ, and channel requests while disabled', async (t) => {
  const server = await sidecar(t, () => ({ data: PROTOCOL }));
  const client = createMemoryRagClient(server);
  const encodedQQ = encodeConversationKey({ platform: 'qq', accountId: '42', chatType: 'group', chatId: '123' });
  for (const key of [` ${KEY}`, `${KEY}=`, 'c1_invalid', encodedQQ, { toString: null }]) {
    assert.equal(await client.search({ key, query: QUERY }), null);
    assert.equal(await client.graph({ keys: [key] }), null);
  }
  assert.equal(await createMemoryRagClient({ ...server, isEnabled: () => false }).search({ key: KEY, query: QUERY }), null);
  assert.deepEqual(server.requests, []);
});

test('rejects mismatched responses and evidence from any other archive', async (t) => {
  let response;
  const server = await sidecar(t, ({ method }) => method === 'GET' ? { data: PROTOCOL } : response);
  const client = createMemoryRagClient(server);
  for (response of [
    { data: searchResponse(OTHER) },
    { data: searchResponse(KEY, `c1_${'b'.repeat(64)}/2026-11.jsonl`) },
    { data: searchResponse(KEY, `${FILE}/../2026-11.jsonl`) },
    { status: 503, data: searchResponse() },
  ]) assert.equal(await client.search({ key: KEY, query: QUERY }), null);
});

test('malformed channel results fail closed instead of becoming an empty RAG success', async (t) => {
  let data;
  const server = await sidecar(t, ({ method }) => ({ data: method === 'GET' ? PROTOCOL : data }));
  const client = createMemoryRagClient(server);
  const search = searchResponse();
  const [item] = search.items;
  for (data of [
    { ...search, semantic: undefined },
    { ...search, semantic: 'unsupported' },
    { ...search, items: [null] },
    { ...search, items: [{ ...item, sources: [42] }] },
    { ...search, items: [{ ...item, file: `${FILE}\n` }] },
    { ...search, items: [{ ...item, record_id_start: `${RECORD_ID}\n` }] },
    { ...search, items: [{ ...item, line_end: 2 }] },
    { ...search, items: [{ ...item, file_end: FILE.replace('2026-11', '2026-10') }] },
  ]) assert.equal(await client.search({ key: KEY, query: QUERY }), null);
  data = { ...search, items: [] };
  assert.deepEqual(await client.search({ key: KEY, query: QUERY }), { semantic: 'ok', items: [] });
});

test('channel request rejects redirects for negotiation and query', async (t) => {
  const receiver = await sidecar(t, () => ({ data: PROTOCOL }));
  let redirectHealth = true;
  const server = await sidecar(t, ({ method }) => method === 'GET' && !redirectHealth ? { data: PROTOCOL }
    : { status: 307, headers: { location: `${receiver.url}/forwarded` }, data: null });
  const client = createMemoryRagClient(server);
  assert.equal(await client.search({ key: KEY, query: QUERY }), null);
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET']);
  redirectHealth = false;
  assert.equal(await client.search({ key: KEY, query: QUERY }), null);
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET', 'GET', 'POST']);
  assert.deepEqual(receiver.requests, []);
});

test('recall, association, summaries, notes and chunk negotiate and retain existing response shapes', async (t) => {
  const summary = { summary_id: 's1', day: '2026-11-01', title: '往事', summary: '摘要' };
  const recall = { ...summary, chunk_id: 'c1', t_end: 8, cosine: 0.6, bm25_rank: null, graph: null, signals: ['vector'], pass: true };
  const associate = { ...summary, t_end: 8, score: 0.5, via: ['text'] };
  const note = { note_id: 'n1', summary_id: 's1', day: '2026-11-01', t_end: 8, who: '', who_name: '', cat: 'event', text: '笔记', due: null, importance: 0.6, created_at: 9, source: 'distill' };
  const chunk = { ok: true, chunk_id: 'c1', key: KEY, day: '2026-11-01', title: '往事', t_start: 1, t_end: 8, n_msgs: 1, text: '原文' };
  let wrongKey = false;
  const server = await sidecar(t, ({ method, path }) => {
    if (method === 'GET') return { data: PROTOCOL };
    const data = {
      '/recall': { candidates: [{ ...recall, file: 'hidden' }], inject: ['s1'], tau: 0.5 },
      '/associate': { items: [{ ...associate, file: 'hidden' }] },
      '/summaries': { items: [{ ...summary, file: 'hidden' }] },
      '/notes': { items: [{ ...note, file: 'hidden' }] },
      '/chunk': { ...chunk, file: 'hidden' },
    }[path];
    return { data: { ...data, key: wrongKey ? OTHER : KEY } };
  });
  const client = createMemoryRagClient(server);
  const person = encodePersonKey({ ...FEISHU, userId: 'ou_fixture' });
  const foreignPerson = encodePersonKey({ ...FEISHU, tenantId: 'tenant_b', userId: 'ou_fixture' });
  const queries = [
    [() => client.recall({ key: KEY, texts: [QUERY] }), { candidates: [recall], skipped: null, inject: ['s1'], tau: 0.5 }],
    [() => client.associate({ key: KEY, text: QUERY, people: [person, foreignPerson, '42'] }), { items: [associate] }],
    [() => client.summaries({ key: KEY, ids: ['s1'] }), { items: [summary] }],
    [() => client.notes({ key: KEY }), { items: [note] }],
    [() => client.chunk({ key: KEY, chunkId: 'c1' }), chunk],
  ];
  for (const [query, expected] of queries) assert.deepEqual(await query(), expected);
  assert.deepEqual(server.requests.map(({ method, path }) => method === 'GET' ? 'health' : path),
    ['health', '/recall', 'health', '/associate', 'health', '/summaries', 'health', '/notes', 'health', '/chunk']);
  assert.deepEqual(server.requests.find(({ path }) => path === '/associate').body.people, [person]);
  wrongKey = true;
  for (const [query] of queries) assert.equal(await query(), null);
});

test('explicit channel graph exposes only requested keyed rows and their linked entities', async (t) => {
  const server = await sidecar(t, ({ method }) => ({ data: method === 'GET' ? PROTOCOL : {
    ok: true,
    chunks: [{ key: TELEGRAM, chunk_id: 'tg', text: 'hidden', file: '/hidden' }, { key: OTHER, chunk_id: 'other' }],
    summaries: [{ key: TELEGRAM, summary_id: 's1', summary: '摘要', file: '/hidden' }, { key: OTHER, summary_id: 'other' }],
    entities: [{ entity_id: 'e1', type: 'thing', name: '故事', n: 3 }, { entity_id: 'outside', name: 'hidden' }],
    summary_entities: [{ key: TELEGRAM, summary_id: 's1', entity_id: 'e1' }, { key: OTHER, summary_id: 'other', entity_id: 'outside' }],
    relations: [{ key: TELEGRAM, summary_id: 's1', src_id: 'e1', dst_id: 'outside', relation: 'hidden' }],
    notes: [{ key: OTHER, summary_id: 'other', note_id: 'other' }],
    truncated: { chunks: 1, hidden: 99 },
  } }));
  const result = await createMemoryRagClient(server).graph({ keys: [TELEGRAM] });
  assert.deepEqual(result, {
    ok: true, chunks: [{ key: TELEGRAM, chunk_id: 'tg' }], summaries: [{ key: TELEGRAM, summary_id: 's1', summary: '摘要' }],
    entities: [{ entity_id: 'e1', type: 'thing', name: '故事', n: 1 }],
    summary_entities: [{ key: TELEGRAM, summary_id: 's1', entity_id: 'e1' }], relations: [], notes: [], truncated: { chunks: 1 },
  });
  assert.deepEqual(server.requests.map(({ method }) => method), ['GET', 'POST']);
});

test('legacy QQ calls keep old-sidecar contracts without a channel health request', async (t) => {
  const server = await sidecar(t, ({ path }) => {
    if (path === '/search') return { data: searchResponse(QQ, 'group_123/2026-11.jsonl') };
    if (path === '/chunk') return { status: 404, data: null };
    return { data: { ok: true, chunks: [{ key: QQ, chunk_id: 'legacy', text: 'hidden' }] } };
  });
  const client = createMemoryRagClient(server);
  assert.deepEqual((await client.search({ key: ` ${QQ} `, query: QUERY })).refs,
    [{ file: 'group_123/2026-11.jsonl', fileEnd: 'group_123/2026-11.jsonl', lineStart: 3, lineEnd: 3 }]);
  assert.deepEqual(await client.chunk({ key: QQ, chunkId: 'missing' }), { ok: false, status: 404 });
  assert.deepEqual((await client.graph()).chunks, [{ key: QQ, chunk_id: 'legacy' }]);
  assert.deepEqual(server.requests.map(({ path }) => path), ['/search', '/chunk', '/graph']);
});
