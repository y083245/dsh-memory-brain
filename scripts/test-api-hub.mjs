// 「API 管理」后端（src/api-hub.js）的测试 + 经 harness 跑真实 bridge.js 的接口测试。
//
// APIHUB_PATCH（docs/design/API_CONSOLE_SPEC.md §4～§7；接口约定 §4.2 / §4.3 / §5）。
// 全部用临时目录与假对象：不读任何真实密钥文件、不联网、不调付费 API、不碰 state/ 与线上服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createApiHub, normalizeLocalBaseUrl, normalizeCloudBaseUrl } from '../src/api-hub.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { assertPosixMode } from './test-mode.mjs';

process.env.QQB_NO_SYSTEMCTL = '1';

// 每次运行一个新的系统临时目录（os.tmpdir()），不和别的测试 / worker 共用。
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-api-hub-'));
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const KEY = 'private:123';
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function tempDir(label) { return fs.mkdtempSync(path.join(BASE, `${label}-`)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function readConfigObject(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.json 顶层不是对象');
  return parsed;
}

const keyHint = (key) => {
  const value = String(key ?? '');
  if (!value) return '';
  return value.length >= 12 ? `${value.slice(0, 4)}…${value.slice(-4)}（${value.length} 位）` : `（${value.length} 位）`;
};

// ── 假依赖 ──────────────────────────────────────────────────────────────

function fakeDsh(overrides = {}) {
  return {
    keyHint,
    readDshKeyStatus: () => ({ hasKey: false, keyHint: '', writable: true, reason: null, ...overrides.status }),
    writeDshKey: overrides.write ?? (async (key) => ({ ok: true, keyHint: keyHint(key) }))
  };
}

/** 与真实 persona.saveConfig 一致：settings 浅合并、appraisal 整个被替换。 */
function fakePersona({ settings, key = '' } = {}) {
  const patches = [];
  const config = {
    settings: {
      enabled: true,
      inject: true,
      appraisal: { mode: 'model', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', dailyLimit: 400, timeoutMs: 20000 },
      emotion: { coreHalfLifeMin: 360 },
      ...settings
    },
    apiKey: key
  };
  return {
    _config: () => config,
    _patches: patches,
    status: () => ({ settings: config.settings, apiKeyHint: config.apiKey ? keyHint(config.apiKey) : '' }),
    saveConfig: (patch = {}) => {
      patches.push(patch);
      if (patch.settings && typeof patch.settings === 'object') config.settings = { ...config.settings, ...patch.settings };
      if (patch.clearApiKey === true) config.apiKey = '';
      else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) config.apiKey = patch.apiKey.trim();
      return { settings: config.settings, apiKeyHint: config.apiKey ? keyHint(config.apiKey) : '' };
    }
  };
}

function fakeTts(cfg = {}) {
  const patches = [];
  const config = { endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', apiKey: '', ...cfg };
  return {
    _patches: patches,
    _config: () => config,
    saveConfig: (patch = {}) => {
      patches.push(patch);
      if (patch.endpoint !== undefined) config.endpoint = patch.endpoint;
      if (patch.clearApiKey === true) config.apiKey = '';
      else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) config.apiKey = patch.apiKey.trim();
      return config;
    },
    publicConfig: () => ({ endpoint: config.endpoint, hasApiKey: !!config.apiKey, apiKeyHint: keyHint(config.apiKey) }),
    readConfig: () => config
  };
}

function fakeRagControl({ enabled = true, installed = true, lockError = null } = {}) {
  const calls = { restarts: [], rebuilds: 0, locks: 0 };
  let enabledNow = enabled;
  return {
    calls,
    setEnabled: (v) => { enabledNow = v; },
    enabled: () => enabledNow,
    state: async () => ({ enabled: enabledNow, phase: enabledNow ? 'running' : 'off', busy: false }),
    withLock: async (fn) => {
      if (lockError) throw lockError;
      calls.locks += 1;
      return fn();
    },
    restartMemoryRag: async (info) => { calls.restarts.push(info); },
    rebuild: async () => { calls.rebuilds += 1; return { ok: true, status: 202, data: {} }; },
    unitInstalled: async () => installed
  };
}

const fakeRag = (health = null) => ({
  health: async () => health,
  rebuild: async () => ({ ok: true, status: 202, data: {} })
});

/** web-search 的读取器：只读临时 config.json，不碰 ~/.dsh。 */
const testSearchLoader = (rootDir) => {
  const file = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
  const raw = file.webSearch && typeof file.webSearch === 'object' ? file.webSearch : {};
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : '',
    model: typeof raw.model === 'string' && raw.model ? raw.model : 'deepseek-v4-flash'
  };
};
const testSearchResolver = (cfg) => ({ source: cfg.apiKey ? 'config' : 'none' });

function makeHub(overrides = {}) {
  const root = overrides.root ?? tempDir('root');
  const stateDir = overrides.stateDir ?? tempDir('state');
  if (!fs.existsSync(path.join(root, 'config.json'))) {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      ownerQQ: 123,
      allow: { private: ['123'], groups: ['456'] },
      webSearch: {},
      ...(overrides.config ?? {})
    }));
  }
  const ragControl = overrides.ragControl ?? fakeRagControl();
  const hub = createApiHub({
    root,
    stateDir,
    getPersonaConsole: overrides.getPersonaConsole ?? (() => fakePersona()),
    ttsApi: overrides.ttsApi ?? fakeTts(),
    dshCredentials: overrides.dshCredentials ?? fakeDsh(),
    ragControl,
    rag: overrides.rag ?? fakeRag(null),
    readConfigObject,
    atomicWriteJson,
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error('network disabled'); }),
    log: () => {},
    now: () => 1000000,
    searchConfigLoader: testSearchLoader,
    searchKeyResolver: testSearchResolver
  });
  return { hub, root, stateDir, ragControl };
}

const settingsFile = (stateDir) => path.join(stateDir, 'long-memory', 'rag', 'embedding-settings.json');
const embeddingApiFile = (stateDir) => path.join(stateDir, 'long-memory', 'rag', 'embedding-api.json');
const distillFile = (stateDir) => path.join(stateDir, 'long-memory', 'rag', 'distill-api.json');

const CLOUD_SEG = {
  baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', dim: 1024,
  instruct: '', appendEos: false, sendDimensions: false, batch: 32, timeoutS: 30
};

// ── 1. 地址规范化 ────────────────────────────────────────────────────────

await test('normalizeLocalBaseUrl：§5.1 的两张表', () => {
  const ok = [
    ['127.0.0.1:11434', 'http://127.0.0.1:11434/v1'],
    ['localhost:1234', 'http://localhost:1234/v1'],
    ['http://127.0.0.1:8000/v1/', 'http://127.0.0.1:8000/v1'],
    ['[::1]:11434', 'http://[::1]:11434/v1'],
    ['127.0.0.5:9000/api/v1', 'http://127.0.0.5:9000/api/v1']
  ];
  for (const [input, expected] of ok) assert.equal(normalizeLocalBaseUrl(input), expected, input);
  const bad = [
    ['192.168.1.5:11434', /回环/],
    ['127.0.0.1', /端口/],
    ['http://u:p@127.0.0.1:11434', /账号密码/],
    ['127.0.0.1:99999', /端口/],
    ['ftp://127.0.0.1:21', /http/],
    ['http://127.0.0.1:11434/v1?x=1', /参数/]
  ];
  for (const [input, re] of bad) assert.throws(() => normalizeLocalBaseUrl(input), re, input);
});

await test('normalizeCloudBaseUrl：§5.2 的两张表', () => {
  const ok = [
    ['https://api.siliconflow.cn/v1/', 'https://api.siliconflow.cn/v1'],
    ['api.siliconflow.cn/v1', 'https://api.siliconflow.cn/v1'],
    ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4']
  ];
  for (const [input, expected] of ok) assert.equal(normalizeCloudBaseUrl(input), expected, input);
  const bad = [
    ['http://api.example.com/v1', /https/],
    ['https://k:s@api.example.com/v1', /账号密码/],
    ['https://api.example.com/v1#a', /参数/]
  ];
  for (const [input, re] of bad) assert.throws(() => normalizeCloudBaseUrl(input), re, input);
});

// ── 2. summary ──────────────────────────────────────────────────────────

const SECRETS = [
  'sk-persona-SECRET-9f0e',
  'sk-websearch-SECRET-1234',
  'sk-tts-SECRET-abcd',
  'sk-embed-cloud-SECRET-wxyz',
  'sk-embed-local-SECRET-qrst',
  'sk-distill-SECRET-mnop'
];

await test('summary：字段齐全，且没有任何密钥原文', async () => {
  const root = tempDir('root');
  const stateDir = tempDir('state');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    ownerQQ: 123,
    webSearch: { apiKey: SECRETS[1], baseURL: '', model: 'deepseek-v4-flash' }
  }));
  fs.mkdirSync(path.join(root, 'sidecars', 'memory-rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sidecars', 'memory-rag', 'config.yml'), [
    'embedding:',
    '  provider: local',
    '  base_url: http://127.0.0.1:8091',
    '  model: Qwen3-Embedding-8B-Q8_0',
    '  dim: 2048',
    ''
  ].join('\n'));
  fs.mkdirSync(path.dirname(settingsFile(stateDir)), { recursive: true });
  fs.writeFileSync(settingsFile(stateDir), JSON.stringify({
    version: 1, kind: 'cloud', cloud: CLOUD_SEG
  }));
  fs.writeFileSync(embeddingApiFile(stateDir), JSON.stringify({ apiKey: SECRETS[3], localApiKey: SECRETS[4] }));
  fs.writeFileSync(distillFile(stateDir), JSON.stringify({ useShared: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: SECRETS[5] }));

  const { hub } = makeHub({
    root,
    stateDir,
    getPersonaConsole: () => fakePersona({ key: SECRETS[0] }),
    ttsApi: fakeTts({ apiKey: SECRETS[2] })
  });
  const r = await hub.summary();
  assert.equal(r.status, 200);
  const body = r.body;
  assert.equal(body.ok, true);
  for (const key of ['dsh', 'persona', 'webSearch', 'tts', 'embedding', 'distill']) {
    assert.ok(body.items[key], `items.${key} 必须存在`);
  }
  assert.ok(body.rag, 'rag 状态必须存在');
  assert.equal(body.items.persona.baseUrl, 'https://api.deepseek.com');
  assert.equal(body.items.persona.model, 'deepseek-flash');
  assert.equal(body.items.webSearch.keySource, 'own');
  assert.equal(body.items.webSearch.effective, 'config');
  assert.equal(body.items.tts.endpoint, 'https://api.xiaomimimo.com/v1/chat/completions');
  assert.equal(body.items.embedding.kind, 'cloud');
  assert.equal(body.items.embedding.source, 'settings');
  assert.equal(body.items.embedding.bundled.model, 'Qwen3-Embedding-8B-Q8_0');
  assert.equal(body.items.embedding.bundled.dim, 2048);
  assert.equal(body.items.embedding.cloud.hasKey, true);
  assert.equal(body.items.embedding.local.hasKey, true);
  assert.equal(body.items.distill.useShared, false);
  assert.equal(body.items.distill.hasKey, true);
  assert.equal(body.items.distill.shared.hasKey, true);
  const json = JSON.stringify(body);
  for (const secret of SECRETS) assert.ok(!json.includes(secret), `响应里不能出现密钥原文：${secret}`);
  assert.ok(!json.includes('SECRET'), '连密钥中段也不能出现');
});

await test('summary：没有设置文件时按 config.yml 推 bundled', async () => {
  const root = tempDir('root');
  const stateDir = tempDir('state');
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  fs.mkdirSync(path.join(root, 'sidecars', 'memory-rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sidecars', 'memory-rag', 'config.yml'), [
    'embedding:',
    '  provider: local',
    '  base_url: http://127.0.0.1:8091',
    '  model: Qwen3-Embedding-8B-Q8_0',
    '  dim: 2048',
    ''
  ].join('\n'));
  const { hub } = makeHub({ root, stateDir });
  const r = await hub.summary();
  assert.equal(r.body.items.embedding.kind, 'bundled');
  assert.equal(r.body.items.embedding.source, 'config.yml');
  assert.equal(r.body.items.distill.useShared, true);
});

// ── 3. savePersona ──────────────────────────────────────────────────────

await test('savePersona：只改 baseUrl 时 mode / dailyLimit 不被重置', () => {
  const persona = fakePersona();
  const { hub } = makeHub({ getPersonaConsole: () => persona });
  const r = hub.savePersona({ baseUrl: 'https://api.example.com/v1' });
  assert.equal(r.status, 200);
  const patched = persona._patches[0].settings.appraisal;
  assert.equal(patched.baseUrl, 'https://api.example.com/v1');
  assert.equal(patched.mode, 'model', 'mode 不能被重置成默认值');
  assert.equal(patched.dailyLimit, 400);
  assert.equal(patched.timeoutMs, 20000);
  assert.equal(patched.model, 'deepseek-flash');
});

await test('savePersona：clearKey 生效、非 https 回 400', () => {
  const persona = fakePersona({ key: 'sk-persona-SECRET-9f0e' });
  const { hub } = makeHub({ getPersonaConsole: () => persona });
  const cleared = hub.savePersona({ clearKey: true });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.hasKey, false);
  assert.equal(persona._config().apiKey, '');

  const bad = hub.savePersona({ baseUrl: 'http://api.example.com/v1' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'baseUrl');
});

await test('savePersona：人格模块没启用回 503', () => {
  const { hub } = makeHub({ getPersonaConsole: () => null });
  assert.equal(hub.savePersona({}).status, 503);
});

// ── 4. saveTts ─────────────────────────────────────────────────────────

await test('saveTts：不传 endpoint 时 patch 里没有 endpoint（不会重置成默认地址）', () => {
  const tts = fakeTts({ endpoint: 'https://my.custom.endpoint/v1/chat/completions' });
  const { hub } = makeHub({ ttsApi: tts });
  const r = hub.saveTts({ apiKey: 'sk-tts-xxxxxxxxxxxx' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(tts._patches[0]), ['apiKey']);
  assert.equal(tts._config().endpoint, 'https://my.custom.endpoint/v1/chat/completions');
});

// ── 5. saveWebSearch ───────────────────────────────────────────────────

await test('saveWebSearch：own + 新密钥写入 config.json，其它键原样，权限 600', () => {
  const root = tempDir('root');
  const stateDir = tempDir('state');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    ownerQQ: 123, allow: { private: ['123'] }, other: { keep: true }, webSearch: { maxUses: 3, model: 'deepseek-v4-flash' }
  }));
  const { hub } = makeHub({ root, stateDir });
  const r = hub.saveWebSearch({ keySource: 'own', apiKey: 'sk-websearch-SECRET-1234' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(file.webSearch.apiKey, 'sk-websearch-SECRET-1234');
  assert.equal(file.webSearch.maxUses, 3, '其它 webSearch 键原样保留');
  assert.equal(file.ownerQQ, 123);
  assert.deepEqual(file.other, { keep: true });
  assertPosixMode(path.join(root, 'config.json'), 0o600);
  assert.equal(r.body.hasOwnKey, true);
});

await test('saveWebSearch：keySource=dsh 把 apiKey 置空；own 却没有密钥回 400', () => {
  const root = tempDir('root');
  const stateDir = tempDir('state');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ webSearch: { apiKey: 'sk-old-xxxxxxxxxxxx' } }));
  const { hub } = makeHub({ root, stateDir });
  const r = hub.saveWebSearch({ keySource: 'dsh' });
  assert.equal(r.status, 200);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(file.webSearch.apiKey, '');
  assert.equal(r.body.effective, 'none');

  const bad = hub.saveWebSearch({ keySource: 'own' });
  assert.equal(bad.status, 400, '没有已存密钥时不能选 own');
});

await test('saveWebSearch：baseURL 为 http 回 400；带凭据也回 400', () => {
  const { hub } = makeHub();
  const http = hub.saveWebSearch({ keySource: 'dsh', baseURL: 'http://api.example.com/v1' });
  assert.equal(http.status, 400);
  assert.equal(http.body.field, 'baseURL');
  const cred = hub.saveWebSearch({ keySource: 'dsh', baseURL: 'https://k:s@api.example.com/v1' });
  assert.equal(cred.status, 400);
});

// ── 6. saveEmbedding ───────────────────────────────────────────────────

const fixtureRoot = () => {
  const root = tempDir('root');
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  fs.mkdirSync(path.join(root, 'sidecars', 'memory-rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sidecars', 'memory-rag', 'config.yml'), [
    'embedding:',
    '  provider: local',
    '  base_url: http://127.0.0.1:8091',
    '  model: Qwen3-Embedding-8B-Q8_0',
    '  dim: 2048',
    ''
  ].join('\n'));
  return root;
};

await test('saveEmbedding：RAG 关着回 409 off', async () => {
  const { hub } = makeHub({ ragControl: fakeRagControl({ enabled: false }) });
  const r = await hub.saveEmbedding({ kind: 'bundled' });
  assert.equal(r.status, 409);
  assert.equal(r.body.off, true);
});

await test('saveEmbedding：字段非法回 400（带字段名）', async () => {
  const { hub } = makeHub();
  for (const body of [
    { kind: 'nope' },
    { kind: 'cloud', cloud: { ...CLOUD_SEG, baseUrl: 'http://api.example.com/v1' } },
    { kind: 'local', local: { ...CLOUD_SEG, baseUrl: '192.168.1.5:11434', model: 'bge-m3' } },
    { kind: 'cloud', cloud: { ...CLOUD_SEG, model: '' } },
    { kind: 'cloud', cloud: { ...CLOUD_SEG, dim: 0 } },
    { kind: 'cloud', cloud: { ...CLOUD_SEG, batch: 999 } }
  ]) {
    const r = await hub.saveEmbedding(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.field || r.body.error, JSON.stringify(r.body));
  }
});

await test('saveEmbedding：口径变了没确认 → 409 needRebuild + estimate（来自 /health）', async () => {
  const stateDir = tempDir('state');
  fs.mkdirSync(path.dirname(settingsFile(stateDir)), { recursive: true });
  fs.writeFileSync(settingsFile(stateDir), JSON.stringify({ version: 1, kind: 'bundled' }));
  const { hub } = makeHub({
    stateDir,
    rag: fakeRag({ store: { chunks: 12, chars: 3456 }, distill: { summaries: 7 } })
  });
  const r = await hub.saveEmbedding({ kind: 'cloud', cloud: CLOUD_SEG });
  assert.equal(r.status, 409);
  assert.equal(r.body.needRebuild, true);
  assert.deepEqual(r.body.estimate, { chunks: 12, summaries: 7, chars: 3456, cloud: true });
});

await test('saveEmbedding：确认了但没 testedDim → 400 needTest', async () => {
  const stateDir = tempDir('state');
  fs.mkdirSync(path.dirname(settingsFile(stateDir)), { recursive: true });
  fs.writeFileSync(settingsFile(stateDir), JSON.stringify({ version: 1, kind: 'bundled' }));
  const { hub } = makeHub({ stateDir });
  const r = await hub.saveEmbedding({ kind: 'cloud', cloud: CLOUD_SEG, confirmRebuild: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.needTest, true);
});

await test('saveEmbedding：完整提交 → 写设置 600、重启、重建，另一段保留', async () => {
  const stateDir = tempDir('state');
  fs.mkdirSync(path.dirname(settingsFile(stateDir)), { recursive: true });
  fs.writeFileSync(settingsFile(stateDir), JSON.stringify({
    version: 1,
    kind: 'local',
    local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', dim: 1024, instruct: '', appendEos: false, sendDimensions: false, batch: 32, timeoutS: 30 }
  }));
  const ragControl = fakeRagControl();
  const { hub } = makeHub({ stateDir, ragControl });
  const r = await hub.saveEmbedding({ kind: 'cloud', cloud: CLOUD_SEG, confirmRebuild: true, testedDim: 1024 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restarted, true);
  assert.equal(r.body.rebuild, true);
  const saved = JSON.parse(fs.readFileSync(settingsFile(stateDir), 'utf8'));
  assert.equal(saved.kind, 'cloud');
  assert.deepEqual(saved.cloud, CLOUD_SEG);
  assert.equal(saved.local.model, 'bge-m3', '切换部署方式不清空另一种的已填值');
  assertPosixMode(settingsFile(stateDir), 0o600);
  assert.equal(ragControl.calls.restarts.length, 1);
  assert.deepEqual(ragControl.calls.restarts[0], { embeddingBefore: 'local', embeddingAfter: 'cloud' });
  assert.equal(ragControl.calls.rebuilds, 1);
});

await test('saveEmbedding：只改密钥 → 只写 embedding-api.json、不重启、另一把保留', async () => {
  const stateDir = tempDir('state');
  fs.mkdirSync(path.dirname(settingsFile(stateDir)), { recursive: true });
  fs.writeFileSync(settingsFile(stateDir), JSON.stringify({ version: 1, kind: 'cloud', cloud: CLOUD_SEG }));
  fs.writeFileSync(embeddingApiFile(stateDir), JSON.stringify({ apiKey: 'sk-old-cloud-xxxx', localApiKey: 'sk-local-keep-yyyy' }));
  const ragControl = fakeRagControl();
  const { hub } = makeHub({ stateDir, ragControl });
  const r = await hub.saveEmbedding({ kind: 'cloud', cloud: CLOUD_SEG, apiKey: 'sk-new-cloud-SECRET-zzzz' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restarted, false);
  assert.equal(r.body.rebuild, false);
  const keys = JSON.parse(fs.readFileSync(embeddingApiFile(stateDir), 'utf8'));
  assert.equal(keys.apiKey, 'sk-new-cloud-SECRET-zzzz');
  assert.equal(keys.localApiKey, 'sk-local-keep-yyyy', '另一个键必须保留');
  assertPosixMode(embeddingApiFile(stateDir), 0o600);
  assert.equal(ragControl.calls.restarts.length, 0);
  assert.equal(ragControl.calls.rebuilds, 0);
});

await test('saveEmbedding：legacy-local 保存成 bundled 不算口径变化、只写设置文件不重启', async () => {
  const root = fixtureRoot();
  const stateDir = tempDir('state'); // 没有设置文件 = legacy-local
  const ragControl = fakeRagControl();
  const { hub } = makeHub({ root, stateDir, ragControl });
  const r = await hub.saveEmbedding({ kind: 'bundled' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rebuild, false, '口径没变，不重建');
  // APIHUB_PATCH：两种情况下 memory-rag 用的是同一个 LlamaCppEmbedder、同一个 model_id，
  // 重启只会白白中断一下 —— 设置文件照写，但不重启。
  assert.equal(r.body.restarted, false, 'legacy-local → bundled 不重启');
  assert.equal(ragControl.calls.restarts.length, 0, 'restartMemoryRag 不能被调用');
  assert.equal(ragControl.calls.rebuilds, 0, '不重建');
  const saved = JSON.parse(fs.readFileSync(settingsFile(stateDir), 'utf8'));
  assert.equal(saved.kind, 'bundled', '设置文件必须写下去，否则下次打开还是「旧行为」');
  assertPosixMode(settingsFile(stateDir), 0o600);
});

await test('saveEmbedding：忙时回 409 busy', async () => {
  const busy = Object.assign(new Error('busy'), { code: 'busy' });
  const { hub } = makeHub({ ragControl: fakeRagControl({ lockError: busy }) });
  const r = await hub.saveEmbedding({ kind: 'bundled' });
  assert.equal(r.status, 409);
  assert.equal(r.body.busy, true);
});

// ── 7. testEmbedding ───────────────────────────────────────────────────

async function startEmbedServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      handler(entry, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

await test('testEmbedding：本地服务返回 3 维向量 → ok, dim=3（带 model / encoding_format；还没填维度也能测）', async () => {
  const server = await startEmbedServer((entry, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
  });
  try {
    const { hub } = makeHub({ fetchImpl: fetch });
    const r = await hub.testEmbedding({
      kind: 'local',
      local: { baseUrl: server.base, model: 'bge-m3', instruct: '', appendEos: false, sendDimensions: false, batch: 32, timeoutS: 5 }
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, dim: 3, ms: r.body.ms });
    const sent = server.requests[0];
    assert.equal(sent.url, '/v1/embeddings');
    assert.equal(sent.body.model, 'bge-m3');
    assert.equal(sent.body.encoding_format, 'float');
    assert.deepEqual(sent.body.input, ['测试']);
    assert.equal(sent.headers.authorization, undefined, '本地没密钥时不带 Authorization');
  } finally { await server.close(); }
});

await test('testEmbedding：bundled 直接问 :8091，请求体只有 input', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: new Array(4096).fill(0) }] }) };
  };
  const { hub } = makeHub({ fetchImpl });
  const r = await hub.testEmbedding({ kind: 'bundled' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.dim, 4096);
  assert.equal(captured.url, 'http://127.0.0.1:8091/v1/embeddings');
  assert.deepEqual(JSON.parse(captured.init.body), { input: ['测试'] });
});

await test('testEmbedding：返回 404 → error=http 404', async () => {
  const server = await startEmbedServer((entry, res) => { res.writeHead(404); res.end('nope'); });
  try {
    const { hub } = makeHub({ fetchImpl: fetch });
    const r = await hub.testEmbedding({
      kind: 'local',
      local: { baseUrl: server.base, model: 'bge-m3', dim: 3, timeoutS: 5 }
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'http 404');
  } finally { await server.close(); }
});

await test('testEmbedding：超时 → error=timeout', async () => {
  const server = await startEmbedServer(() => { /* 不回应，等客户端超时 */ });
  try {
    const { hub } = makeHub({ fetchImpl: fetch });
    const started = Date.now();
    const r = await hub.testEmbedding({
      kind: 'local',
      local: { baseUrl: server.base, model: 'bge-m3', dim: 3, timeoutS: 1 }
    });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'timeout');
    assert.ok(Date.now() - started < 5000);
  } finally { await server.close(); }
});

await test('testEmbedding：cloud 没密钥 → no_key；有密钥时带 Authorization、重定向不跟随', async () => {
  const noKey = makeHub();
  const r0 = await noKey.hub.testEmbedding({ kind: 'cloud', cloud: CLOUD_SEG });
  assert.equal(r0.status, 200);
  assert.equal(r0.body.error, 'no_key');

  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2, 3, 4] }] }) };
  };
  const { hub } = makeHub({ fetchImpl });
  const r = await hub.testEmbedding({ kind: 'cloud', cloud: { ...CLOUD_SEG, dim: 4 }, apiKey: 'sk-test-key' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.dim, 4);
  assert.equal(captured.url, 'https://api.siliconflow.cn/v1/embeddings');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers.authorization, 'Bearer sk-test-key');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'BAAI/bge-m3');
  assert.equal(body.encoding_format, 'float');
});

await test('testEmbedding：返回比提交维度短 → short_vector', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2] }] }) });
  const { hub } = makeHub({ fetchImpl });
  const r = await hub.testEmbedding({ kind: 'cloud', cloud: CLOUD_SEG, apiKey: 'sk-test-key' });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'short_vector');
});

// ── 8. saveDistill ─────────────────────────────────────────────────────

await test('saveDistill：单独配置写文件 600；非 https 回 400；RAG 关 409', async () => {
  const stateDir = tempDir('state');
  const { hub } = makeHub({ stateDir });
  const r = hub.saveDistill({ useShared: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-distill-SECRET-mnop' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const saved = JSON.parse(fs.readFileSync(distillFile(stateDir), 'utf8'));
  assert.deepEqual(saved, { useShared: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-distill-SECRET-mnop' });
  assertPosixMode(distillFile(stateDir), 0o600);

  const bad = hub.saveDistill({ useShared: false, baseUrl: 'http://api.deepseek.com', model: 'deepseek-flash' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'baseUrl');

  const off = makeHub({ ragControl: fakeRagControl({ enabled: false }) });
  assert.equal(off.hub.saveDistill({ useShared: true }).status, 409);
});

// ── 9. 经 harness 跑真实 bridge.js ──────────────────────────────────────

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  const h = { 'content-type': 'application/json', ...CONSOLE, ...headers };
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: response.statusCode, json, body: data });
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

await test('harness：GET /api/apis 与 POST /api/apis/web-search 能通', async () => {
  const port = await freePort();
  const h = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}` } } });
  try {
    assert.ok(h.getRagControl(), 'RAG 开关必须创建成功');
    assert.ok(h.getApiHub(), 'API 管理必须创建成功');
    await withServer(h, async (p) => {
      const summary = await call(p, '/api/apis');
      assert.equal(summary.status, 200, summary.body);
      assert.equal(summary.json.ok, true);
      assert.ok(summary.json.rag && summary.json.rag.phase, '要带 RagState');
      assert.ok(summary.json.items.dsh && summary.json.items.embedding, '六项都要有');

      const saved = await call(p, '/api/apis/web-search', {
        method: 'POST', body: { keySource: 'own', apiKey: 'sk-ui-fixture-SECRET-7777' }
      });
      assert.equal(saved.status, 200, saved.body);
      const file = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
      assert.equal(file.webSearch.apiKey, 'sk-ui-fixture-SECRET-7777');
      assert.equal(file.ownerQQ, 123, '其它键原样保留');
    });
  } finally { await h.close(); }
});

await test('harness：带 agent 头访问 /api/apis 与 /api/rag/control 一律 403', async () => {
  const port = await freePort();
  const h = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}` } } });
  try {
    await withServer(h, async (p) => {
      const a = await call(p, '/api/apis', { headers: { 'x-agent-call': '1' } });
      assert.equal(a.status, 403, a.body);
      const b = await call(p, '/api/rag/control', { method: 'POST', headers: { 'x-agent-token': 'fixture-bad-token' }, body: { enabled: false } });
      assert.equal(b.status, 403, b.body);
    });
  } finally { await h.close(); }
});

await test('harness：RAG 关着时 /api/ltm/rag/status 409 off、history-search semantic=off', async () => {
  const port = await freePort();
  const h = await bridgeHarness({
    config: { memoryRag: { enabled: false, url: `http://127.0.0.1:${port}` } },
    files: {
      'state/long-memory/archive/private_123/2026-10.jsonl':
        `${JSON.stringify({ t: '2026-10-27T20:00:00.000Z', role: 'user', userId: '123', name: '我', text: '今天晚上吃火锅' })}\n`
    }
  });
  try {
    assert.equal(h.getRagControl().enabled(), false);
    await withServer(h, async (p) => {
      const status = await call(p, '/api/ltm/rag/status');
      assert.equal(status.status, 409, status.body);
      assert.equal(status.json.off, true);

      const search = await call(p, '/api/socialV2/history-search', { method: 'POST', body: { key: KEY, query: '火锅' } });
      assert.equal(search.status, 200, search.body);
      assert.equal(search.json.semantic, 'off');
      assert.equal(search.json.source, 'keyword');
      assert.equal(search.json.key, KEY);
    });
  } finally { await h.close(); }
});

await test('harness：POST /api/rag/control 只触发假 execFile（没有真实子进程）', async () => {
  const port = await freePort();
  const h = await bridgeHarness({ config: { memoryRag: { url: `http://127.0.0.1:${port}` } } });
  try {
    assert.equal(process.env.QQB_NO_SYSTEMCTL, '1', 'harness 必须设上第二道闸门');
    await withServer(h, async (p) => {
      const res = await call(p, '/api/rag/control', { method: 'POST', body: { enabled: false } });
      assert.equal(res.status, 202, res.body);
      assert.equal(res.json.busy, true);
      assert.equal(res.json.phase, 'stopping');
      // 后台任务要跑完再断言（写盘已在返回前完成）。
      const ctl = h.getRagControl();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const st = await ctl.state();
        if (!st.busy) break;
        await sleep(10);
      }
      const file = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
      assert.equal(file.memoryRag.enabled, false, '开关必须落盘');
      assert.equal(ctl.enabled(), false);
    });
    const stop = h.calls.ragExec.find((c) => c[0] === 'systemctl' && c.includes('stop') && c.includes('qq-memory-rag'));
    assert.ok(stop, `假 execFile 应收到 stop qq-memory-rag：${JSON.stringify(h.calls.ragExec)}`);
    assert.deepEqual(stop, ['systemctl', '--user', 'stop', 'qq-memory-rag']);
    // 假的 execFile 收到调用 = 默认实现没被用到（它会在 QQB_NO_SYSTEMCTL=1 下直接返回 127）。
    for (const c of h.calls.ragExec) assert.equal(c[0] === 'systemctl' || c[0] === 'systemd-run', true);
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 个测试失败`);
  process.exit(1);
}
console.log('\n全部通过');
