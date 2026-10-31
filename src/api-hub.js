// api-hub.js · 控制台「API 管理」页的后端（各 API 的读写、校验、脱敏与向量模型测试）
//
// APIHUB_PATCH（docs/design/API_CONSOLE_SPEC.md §4～§7、§10；接口约定 §3.4 / §4.2 / §4.3 / §5）。
//
// 为什么单独成模块：这些配置散在 5 个地方（DSH 凭据、人格设置、config.json、TTS、RAG 设置文件），
// 每处的存储格式与合并规则都不同（尤其是「人格设置浅合并、appraisal 整个被替换」和
// 「TTS 地址传空串会被重置成默认值」）。把规则收在这里，桥接只做路由与令牌校验。
//
// 安全纪律：
//   - 密钥原文只在请求体与各自的状态文件里；返回值只带 hasKey / keyHint（末 4 位）。
//   - 日志不记密钥、不记请求体。
//   - 所有方法返回 { status, body }，不把异常抛到 HTTP 层以外。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'js-yaml';
import { loadSearchConfig, resolveSearchApiKey } from './web-search.js';

const KEY_MAX_LEN = 512;
const MODEL_MAX_LEN = 200;
const INSTRUCT_MAX_LEN = 500;
// 控制字符（含换行、制表）：密钥里出现一律拒绝。
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const SEGMENT_DEFAULTS = Object.freeze({
  baseUrl: '', model: '', dim: null, instruct: '',
  appendEos: false, sendDimensions: false, batch: 32, timeoutS: 30
});

const EMBEDDING_KINDS = new Set(['bundled', 'local', 'cloud']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}


// ── 地址规范化（接口约定 §5；Python 侧 memory-rag 有一份同规则实现） ──────────

function parseUrlOrThrow(raw, { defaultScheme, allowHttp }) {
  let s = String(raw ?? '').trim();
  if (!s) throw new Error('地址不能为空');
  if (!s.includes('://')) s = `${defaultScheme}://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    // 端口越界（如 :99999）时 URL 构造器直接抛 "Invalid URL"，单独识别一下更好提示。
    if (/(?:^|\/\/)[^\s/?#]+:\d{5,}(?:$|[/?#])/.test(s)) throw new Error('端口不对');
    throw new Error('地址不合法');
  }
  if (allowHttp) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http / https');
  } else if (url.protocol !== 'https:') {
    throw new Error('云端必须是 https');
  }
  if (url.username || url.password) throw new Error('地址里不能带账号密码');
  if (url.search) throw new Error('不能带参数');
  if (url.hash) throw new Error('不能带参数');
  if (!url.hostname) throw new Error('地址不合法');
  return url;
}

function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * 本地服务地址：只允许回环、必须写端口；路径空 / `/` 补 `/v1`。
 * 例：`127.0.0.1:11434` → `http://127.0.0.1:11434/v1`。
 */
export function normalizeLocalBaseUrl(input) {
  const url = parseUrlOrThrow(input, { defaultScheme: 'http', allowHttp: true });
  if (!isLoopbackHost(url.hostname)) throw new Error('只能填本机回环地址');
  // `new URL('http://127.0.0.1')` 的 port 是空串：必须显式写端口（规格 §4.3）。
  if (!url.port) throw new Error('要写端口');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口不对');
  let pathname = url.pathname || '/';
  pathname = pathname === '/' ? '/v1' : pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.hostname}:${port}${pathname}`;
}

/**
 * 云端地址：必须 https、不带凭据 / 参数；去掉末尾 `/`，**不**自动补 `/v1`。
 * 例：`api.siliconflow.cn/v1` → `https://api.siliconflow.cn/v1`。
 */
export function normalizeCloudBaseUrl(input) {
  const url = parseUrlOrThrow(input, { defaultScheme: 'https', allowHttp: false });
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

// ── 密钥输入 ────────────────────────────────────────────────────────────

/**
 * 统一规则（接口约定 §4.2）：trim 后为空 = 不改；clearKey = 删；> 512 或含控制字符 → 400。
 * 返回 { kind: 'none' | 'set' | 'clear', key? } 或 { error }。
 */
function readKeyInput(raw, clear) {
  if (clear === true) return { kind: 'clear' };
  if (raw === undefined || raw === null) return { kind: 'none' };
  if (typeof raw !== 'string') return { error: '密钥必须是字符串' };
  const key = raw.trim();
  if (!key) return { kind: 'none' };
  if (key.length > KEY_MAX_LEN) return { error: `密钥太长（最多 ${KEY_MAX_LEN} 个字符）` };
  if (CONTROL_RE.test(key)) return { error: '密钥里不能有换行或控制字符' };
  return { kind: 'set', key };
}

// ── embedding 设置文件 ─────────────────────────────────────────────────

function settingsPath(stateDir) { return path.join(stateDir, 'long-memory', 'rag', 'embedding-settings.json'); }
function embeddingApiPath(stateDir) { return path.join(stateDir, 'long-memory', 'rag', 'embedding-api.json'); }
function distillPath(stateDir) { return path.join(stateDir, 'long-memory', 'rag', 'distill-api.json'); }

/** 把设置文件里的一段归一成完整字段（坏值给默认），用于展示与口径比较。 */
function normalizeSegment(raw) {
  const seg = isPlainObject(raw) ? raw : {};
  return {
    baseUrl: typeof seg.baseUrl === 'string' ? seg.baseUrl : '',
    model: typeof seg.model === 'string' ? seg.model : '',
    dim: Number.isInteger(Number(seg.dim)) && Number(seg.dim) >= 1 ? Number(seg.dim) : null,
    instruct: typeof seg.instruct === 'string' ? seg.instruct : '',
    appendEos: seg.appendEos === true,
    sendDimensions: seg.sendDimensions === true,
    batch: clampInt(seg.batch, 1, 256, 32),
    timeoutS: clampNum(seg.timeoutS, 1, 300, 30)
  };
}

function readYamlConfig(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'sidecars', 'memory-rag', 'config.yml'), 'utf8');
    const doc = YAML.load(text);
    return isPlainObject(doc) ? doc : {};
  } catch {
    return {};
  }
}

/**
 * 读 config.yml 的 embedding 段（自带模式的固定参数 + provider）。
 * `bundled.*` 永远取这里的顶层字段（接口约定 §4.3）。
 */
function yamlEmbedding(root) {
  const yml = readYamlConfig(root);
  const top = isPlainObject(yml.embedding) ? yml.embedding : {};
  return { top, api: isPlainObject(top.api) ? top.api : {} };
}

function configYamlCloudSegment(api) {
  return {
    baseUrl: typeof api.base_url === 'string' ? api.base_url : '',
    model: typeof api.model === 'string' ? api.model : '',
    dim: Number.isInteger(Number(api.dim)) && Number(api.dim) >= 1 ? Number(api.dim) : null,
    instruct: typeof api.instruct === 'string' ? api.instruct : '',
    appendEos: api.append_eos === true,
    sendDimensions: api.send_dimensions === true,
    batch: clampInt(api.batch, 1, 256, 32),
    timeoutS: clampNum(api.timeout_s, 1, 300, 30)
  };
}

/**
 * ragControl 的 `embeddingKind`：设置文件存在就以它的 kind 为准；否则按 config.yml 的
 * `embedding.provider` 给 legacy-local / legacy-api（接口约定 §3.3）。
 */
export function readEmbeddingKind({ root, stateDir }) {
  return function embeddingKind() {
    const st = readJsonFile(settingsPath(stateDir));
    if (isPlainObject(st) && typeof st.kind === 'string' && st.kind) return st.kind;
    const { top } = yamlEmbedding(root);
    return top.provider === 'api' ? 'legacy-api' : 'legacy-local';
  };
}

// ── 主模块 ──────────────────────────────────────────────────────────────

export function createApiHub({
  root,
  stateDir,
  getPersonaConsole = () => null,
  ttsApi = null,
  dshCredentials = null,
  ragControl = null,
  rag = null,
  readConfigObject,
  atomicWriteJson,
  fetchImpl = globalThis.fetch,
  log = () => {},
  now = Date.now,
  // 测试可注入的 web-search 读取器；缺省用真模块（读 config.json，不读任何密钥文件）。
  searchConfigLoader = loadSearchConfig,
  searchKeyResolver = resolveSearchApiKey
} = {}) {
  const hint = (key) => {
    const value = String(key ?? '');
    if (!value) return '';
    if (dshCredentials && typeof dshCredentials.keyHint === 'function') return dshCredentials.keyHint(value);
    return value.length >= 12 ? `${value.slice(0, 4)}…${value.slice(-4)}（${value.length} 位）` : `（${value.length} 位）`;
  };

  /** 原子写 + 强制 600（rename 之后明确 chmod 一次，旧文件权限不一定是 600）。 */
  function writeJson600(file, obj) {
    atomicWriteJson(file, obj);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  function personaStatus() {
    const pc = getPersonaConsole?.();
    if (!pc || typeof pc.status !== 'function') return null;
    try { return pc.status(); } catch { return null; }
  }

  function personaAppraisal(status) {
    const a = status?.settings?.appraisal;
    return isPlainObject(a) ? a : {};
  }

  function off409() {
    return { status: 409, body: { ok: false, off: true, error: 'RAG 已关闭' } };
  }

  function badRequest(field, error) {
    return { status: 400, body: { ok: false, ...(field ? { field } : {}), error } };
  }

  const ragEnabled = () => !!ragControl && ragControl.enabled() === true;

  // ── GET /api/apis ──────────────────────────────────────────────────────

  async function embeddingSummary() {
    const { top, api } = yamlEmbedding(root);
    const keys = isPlainObject(readJsonFile(embeddingApiPath(stateDir))) ? readJsonFile(embeddingApiPath(stateDir)) : {};
    const cloudKey = typeof keys.apiKey === 'string' ? keys.apiKey : '';
    const localKey = typeof keys.localApiKey === 'string' ? keys.localApiKey : '';
    let unitInstalled = false;
    try { unitInstalled = ragControl ? await ragControl.unitInstalled('qq-embedding') : false; } catch { unitInstalled = false; }
    const bundled = {
      baseUrl: typeof top.base_url === 'string' ? top.base_url : '',
      model: typeof top.model === 'string' ? top.model : '',
      dim: Number.isInteger(Number(top.dim)) && Number(top.dim) >= 1 ? Number(top.dim) : null,
      unitInstalled
    };
    const settings = readJsonFile(settingsPath(stateDir));
    let kind;
    let source;
    let local = { ...SEGMENT_DEFAULTS, hasKey: !!localKey, keyHint: hint(localKey) };
    let cloud = { ...SEGMENT_DEFAULTS, hasKey: !!cloudKey, keyHint: hint(cloudKey) };
    if (isPlainObject(settings)) {
      source = 'settings';
      kind = typeof settings.kind === 'string' && settings.kind ? settings.kind : 'bundled';
      if (isPlainObject(settings.local)) local = { ...normalizeSegment(settings.local), hasKey: !!localKey, keyHint: hint(localKey) };
      if (isPlainObject(settings.cloud)) cloud = { ...normalizeSegment(settings.cloud), hasKey: !!cloudKey, keyHint: hint(cloudKey) };
      if (kind === 'legacy-api') kind = 'cloud';
      if (kind === 'legacy-local') kind = 'bundled';
    } else {
      // 没有设置文件 = 完全照旧走 config.yml（provider: local → bundled，api → cloud）。
      source = 'config.yml';
      if (top.provider === 'api') {
        kind = 'cloud';
        cloud = { ...configYamlCloudSegment(api), hasKey: !!cloudKey, keyHint: hint(cloudKey) };
      } else {
        kind = 'bundled';
      }
    }
    return { kind, source, bundled, local, cloud };
  }

  function distillSummary(status) {
    const file = isPlainObject(readJsonFile(distillPath(stateDir))) ? readJsonFile(distillPath(stateDir)) : {};
    const ownKey = typeof file.apiKey === 'string' ? file.apiKey : '';
    const appr = personaAppraisal(status);
    const sharedHint = String(status?.apiKeyHint ?? '');
    return {
      useShared: file.useShared !== false,
      baseUrl: typeof file.baseUrl === 'string' ? file.baseUrl : '',
      model: typeof file.model === 'string' ? file.model : '',
      hasKey: !!ownKey,
      keyHint: hint(ownKey),
      shared: {
        baseUrl: typeof appr.baseUrl === 'string' ? appr.baseUrl : '',
        model: typeof appr.model === 'string' ? appr.model : '',
        hasKey: !!sharedHint,
        keyHint: sharedHint
      }
    };
  }

  async function summary() {
    const items = {};
    // 1. 她聊天（DSH 凭据；只读状态，不读明文以外的任何东西）
    try {
      const st = dshCredentials && typeof dshCredentials.readDshKeyStatus === 'function'
        ? dshCredentials.readDshKeyStatus()
        : { hasKey: false, keyHint: '', writable: false, reason: '凭据模块未启用' };
      items.dsh = {
        hasKey: st?.hasKey === true,
        keyHint: String(st?.keyHint ?? ''),
        writable: st?.writable !== false,
        reason: st?.reason ?? null,
        dshUrl: 'http://127.0.0.1:3080'
      };
    } catch {
      items.dsh = { hasKey: false, keyHint: '', writable: false, reason: '读不到 DSH 凭据', dshUrl: 'http://127.0.0.1:3080' };
    }
    // 2. 人格判读
    const pStatus = personaStatus();
    if (pStatus) {
      const appr = personaAppraisal(pStatus);
      items.persona = {
        available: true,
        baseUrl: typeof appr.baseUrl === 'string' ? appr.baseUrl : '',
        model: typeof appr.model === 'string' ? appr.model : '',
        hasKey: !!pStatus.apiKeyHint,
        keyHint: String(pStatus.apiKeyHint ?? '')
      };
    } else {
      items.persona = { available: false };
    }
    // 3. 联网搜索
    try {
      const cfg = searchConfigLoader(root);
      const own = String(cfg?.apiKey ?? '');
      const effective = String(searchKeyResolver(cfg)?.source ?? 'none');
      items.webSearch = {
        keySource: own ? 'own' : 'dsh',
        hasOwnKey: !!own,
        ownKeyHint: hint(own),
        baseURL: String(cfg?.baseURL ?? ''),
        model: String(cfg?.model ?? ''),
        effective
      };
    } catch {
      items.webSearch = { keySource: 'dsh', hasOwnKey: false, ownKeyHint: '', baseURL: '', model: '', effective: 'none' };
    }
    // 4. 语音合成
    if (ttsApi && typeof ttsApi.publicConfig === 'function') {
      try {
        const c = ttsApi.publicConfig();
        items.tts = {
          available: true,
          endpoint: String(c?.endpoint ?? ''),
          hasKey: c?.hasApiKey === true,
          keyHint: String(c?.apiKeyHint ?? '')
        };
      } catch {
        items.tts = { available: false };
      }
    } else {
      items.tts = { available: false };
    }
    // 5. 向量模型 / 6. 话题提炼
    try { items.embedding = await embeddingSummary(); } catch { items.embedding = { kind: 'bundled', source: 'config.yml' }; }
    try { items.distill = distillSummary(pStatus); } catch { items.distill = { useShared: true }; }

    let ragState = null;
    if (ragControl) {
      try { ragState = await ragControl.state(); } catch { ragState = null; }
    }
    return { status: 200, body: { ok: true, rag: ragState, items } };
  }

  // ── POST /api/apis/persona ─────────────────────────────────────────────

  function savePersona(body = {}) {
    const pc = getPersonaConsole?.();
    if (!pc || typeof pc.saveConfig !== 'function') {
      return { status: 503, body: { ok: false, error: '人格与情绪模块没有启用（看 bridge.log）' } };
    }
    let baseUrl;
    if (body.baseUrl !== undefined && body.baseUrl !== null) {
      try { baseUrl = normalizeCloudBaseUrl(body.baseUrl); } catch (error) { return badRequest('baseUrl', error.message); }
    }
    let model;
    if (body.model !== undefined && body.model !== null) {
      model = String(body.model).trim();
      if (!model) return badRequest('model', '模型不能为空');
      if (model.length > MODEL_MAX_LEN) return badRequest('model', `模型名太长（最多 ${MODEL_MAX_LEN} 字）`);
    }
    const keyV = readKeyInput(body.apiKey, body.clearKey);
    if (keyV.error) return badRequest('apiKey', keyV.error);

    let status;
    try { status = pc.status(); } catch (error) {
      return { status: 500, body: { ok: false, error: String(error?.message ?? error) } };
    }
    // 关键：appraisal 在 saveConfig 里是**整个被替换**的，必须把当前值全部带上，
    // 只覆盖这次改的 baseUrl / model（否则 mode / dailyLimit / timeoutMs 会被重置成默认值）。
    const current = personaAppraisal(status);
    const merged = {
      ...current,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(model !== undefined ? { model } : {})
    };
    const patch = { settings: { appraisal: merged } };
    if (keyV.kind === 'clear') patch.clearApiKey = true;
    else if (keyV.kind === 'set') patch.apiKey = keyV.key;
    let saved;
    try { saved = pc.saveConfig(patch); } catch (error) { return badRequest(null, String(error?.message ?? error)); }
    const appr = personaAppraisal(saved);
    return {
      status: 200,
      body: {
        ok: true,
        baseUrl: appr.baseUrl ?? merged.baseUrl ?? '',
        model: appr.model ?? merged.model ?? '',
        hasKey: !!saved?.apiKeyHint,
        keyHint: String(saved?.apiKeyHint ?? '')
      }
    };
  }

  // ── POST /api/apis/web-search ──────────────────────────────────────────

  function saveWebSearch(body = {}) {
    const keySource = body.keySource === 'own' ? 'own' : body.keySource === 'dsh' ? 'dsh' : null;
    if (!keySource) return badRequest('keySource', '密钥来源只能是 dsh 或 own');
    const configFile = path.join(root, 'config.json');
    let file;
    try { file = readConfigObject(configFile); } catch (error) {
      return { status: 500, body: { ok: false, error: String(error?.message ?? error) } };
    }
    const current = isPlainObject(file.webSearch) ? file.webSearch : {};
    let ownKey = typeof current.apiKey === 'string' ? current.apiKey.trim() : '';
    if (keySource === 'dsh') {
      // 「沿用她聊天那把」= apiKey 置空（web-search 会退到环境变量 → DSH 凭据）。
      ownKey = '';
    } else {
      const keyV = readKeyInput(body.apiKey, body.clearKey);
      if (keyV.error) return badRequest('apiKey', keyV.error);
      if (keyV.kind === 'set') ownKey = keyV.key;
      else if (keyV.kind === 'clear') ownKey = '';
      if (!ownKey) return badRequest('apiKey', '选了「单独填」就要填密钥（没有已保存的可用）');
    }
    let baseURL = typeof current.baseURL === 'string' ? current.baseURL : '';
    if (body.baseURL !== undefined && body.baseURL !== null) {
      const raw = String(body.baseURL).trim();
      if (!raw) baseURL = '';
      else {
        try { baseURL = normalizeCloudBaseUrl(raw); } catch (error) { return badRequest('baseURL', error.message); }
      }
    }
    let model = typeof current.model === 'string' ? current.model : '';
    if (body.model !== undefined && body.model !== null) {
      const m = String(body.model).trim();
      if (!m) return badRequest('model', '模型不能为空');
      if (m.length > MODEL_MAX_LEN) return badRequest('model', `模型名太长（最多 ${MODEL_MAX_LEN} 字）`);
      model = m;
    }
    file.webSearch = { ...current, apiKey: ownKey, baseURL, model };
    try { atomicWriteJson(configFile, file); try { fs.chmodSync(configFile, 0o600); } catch {} } catch (error) {
      return { status: 500, body: { ok: false, error: String(error?.message ?? error) } };
    }
    // 实际用哪把：每次现读（loadSearchConfig / resolveSearchApiKey 不读密钥文件以外的任何东西）
    let effective = 'none';
    try { effective = String(searchKeyResolver(searchConfigLoader(root))?.source ?? 'none'); } catch {}
    log('[api-hub] 联网搜索配置已保存');
    return {
      status: 200,
      body: {
        ok: true,
        keySource,
        hasOwnKey: !!ownKey,
        ownKeyHint: hint(ownKey),
        baseURL,
        model,
        effective
      }
    };
  }

  // ── POST /api/apis/tts ─────────────────────────────────────────────────

  function saveTts(body = {}) {
    if (!ttsApi || typeof ttsApi.saveConfig !== 'function') {
      return { status: 503, body: { ok: false, error: '语音合成模块没有启用' } };
    }
    const patch = {};
    // 只把**真的传了且非空**的字段交给 saveConfig：`endpoint` 传空串会被它重置成默认地址。
    if (body.endpoint !== undefined && body.endpoint !== null) {
      const endpoint = String(body.endpoint).trim();
      if (endpoint) patch.endpoint = endpoint;
    }
    const keyV = readKeyInput(body.apiKey, body.clearKey);
    if (keyV.error) return badRequest('apiKey', keyV.error);
    if (keyV.kind === 'set') patch.apiKey = keyV.key;
    else if (keyV.kind === 'clear') patch.clearApiKey = true;
    if (Object.keys(patch).length) {
      try { ttsApi.saveConfig(patch); } catch (error) { return badRequest(null, String(error?.message ?? error)); }
      log('[api-hub] 语音合成配置已保存');
    }
    let config;
    try { config = ttsApi.publicConfig(); } catch { config = {}; }
    return {
      status: 200,
      body: {
        ok: true,
        endpoint: String(config?.endpoint ?? ''),
        hasKey: config?.hasApiKey === true,
        keyHint: String(config?.apiKeyHint ?? '')
      }
    };
  }

  // ── POST /api/apis/dsh ─────────────────────────────────────────────────

  async function saveDsh(body = {}) {
    if (!dshCredentials || typeof dshCredentials.writeDshKey !== 'function') {
      return { status: 503, body: { ok: false, error: '凭据模块没有启用' } };
    }
    const keyV = readKeyInput(body.apiKey, false);
    if (keyV.error) return badRequest('apiKey', keyV.error);
    if (keyV.kind !== 'set') return badRequest('apiKey', '请填写密钥');
    const key = keyV.key;
    // 规格 §8：≤ 256、只含可见 ASCII（YAML 文本替换，值里不能有奇怪字符）。
    if (key.length > 256) return badRequest('apiKey', '密钥太长（最多 256 个字符）');
    if (/[^\x20-\x7e]/.test(key)) return badRequest('apiKey', '密钥只能包含可见 ASCII 字符');

    let state;
    try { state = dshCredentials.readDshKeyStatus(); } catch { state = { writable: false, reason: '读不到 DSH 凭据' }; }
    if (state?.writable === false) {
      return { status: 409, body: { ok: false, writable: false, error: state.reason || 'DSH 凭据文件当前不可写' } };
    }
    let result;
    try { result = await dshCredentials.writeDshKey(key); } catch (error) {
      return { status: 500, body: { ok: false, error: String(error?.message ?? error) } };
    }
    if (result?.ok) {
      log('[api-hub] DSH 密钥已更新');
      return { status: 200, body: { ok: true, keyHint: String(result.keyHint ?? hint(key)) } };
    }
    const code = result?.code;
    if (code === 'locked') {
      return { status: 409, body: { ok: false, busy: true, error: result?.error || 'DSH 正在写凭据，稍后再试' } };
    }
    if (code === 'unrecognized' || code === 'perm' || code === 'invalid') {
      return { status: code === 'invalid' ? 400 : 409, body: { ok: false, writable: false, error: result?.error || '拒绝写入 DSH 凭据' } };
    }
    log(`[api-hub] 写 DSH 密钥失败（${code ?? 'unknown'}）`);
    return { status: 500, body: { ok: false, error: '写入 DSH 凭据失败' } };
  }

  // ── embedding：校验 / 口径 / 测试 ────────────────────────────────────

  /** 校验提交的一段向量模型设置；返回 { value } 或 { error: {field,error} }。 */
  function validateSegment(kind, raw, { requireDim = true } = {}) {
    const seg = isPlainObject(raw) ? raw : {};
    const field = (name) => `${kind}.${name}`;
    let baseUrl;
    try {
      baseUrl = kind === 'local' ? normalizeLocalBaseUrl(seg.baseUrl) : normalizeCloudBaseUrl(seg.baseUrl);
    } catch (error) {
      return { error: { field: field('baseUrl'), error: error.message } };
    }
    const model = String(seg.model ?? '').trim();
    if (!model) return { error: { field: field('model'), error: '模型不能为空' } };
    if (model.length > MODEL_MAX_LEN) return { error: { field: field('model'), error: `模型名太长（最多 ${MODEL_MAX_LEN} 字）` } };
    // 「测试连接」时页面还没拿到原生维度，所以测试路径允许先空着（requireDim=false）。
    let dim = null;
    const rawDim = seg.dim;
    if (rawDim !== undefined && rawDim !== null && rawDim !== '') {
      const n = Number(rawDim);
      if (!Number.isInteger(n) || n < 1 || n > 8192) {
        return { error: { field: field('dim'), error: '维度要填 1～8192 的整数（先点「测试连接」拿到原生维度）' } };
      }
      dim = n;
    } else if (requireDim) {
      return { error: { field: field('dim'), error: '维度要填 1～8192 的整数（先点「测试连接」拿到原生维度）' } };
    }
    const instruct = String(seg.instruct ?? '');
    if (instruct.length > INSTRUCT_MAX_LEN) return { error: { field: field('instruct'), error: `查询前缀太长（最多 ${INSTRUCT_MAX_LEN} 字）` } };
    const batch = seg.batch === undefined ? 32 : Number(seg.batch);
    if (!Number.isInteger(batch) || batch < 1 || batch > 256) return { error: { field: field('batch'), error: '每批条数要 1～256 的整数' } };
    const timeoutS = seg.timeoutS === undefined ? 30 : Number(seg.timeoutS);
    if (!Number.isFinite(timeoutS) || timeoutS < 1 || timeoutS > 300) return { error: { field: field('timeoutS'), error: '超时要 1～300 秒' } };
    return {
      value: {
        baseUrl,
        model,
        dim,
        instruct,
        appendEos: seg.appendEos === true,
        sendDimensions: seg.sendDimensions === true,
        batch,
        timeoutS
      }
    };
  }

  /** 当前生效的口径（设置文件不存在时 legacy-local 视作 bundled、legacy-api 视作 cloud + config.yml）。 */
  function currentCaliber(settings) {
    if (isPlainObject(settings)) {
      const kind = typeof settings.kind === 'string' ? settings.kind : '';
      if (kind === 'bundled') return { kind: 'bundled' };
      if (kind === 'local' || kind === 'cloud') {
        const seg = normalizeSegment(settings[kind]);
        return { kind, model: seg.model, dim: seg.dim, instruct: seg.instruct, appendEos: seg.appendEos, sendDimensions: seg.sendDimensions };
      }
      return { kind: 'unknown' };
    }
    const { top, api } = yamlEmbedding(root);
    if (top.provider === 'api') {
      const seg = configYamlCloudSegment(api);
      return { kind: 'cloud', model: seg.model, dim: seg.dim, instruct: seg.instruct, appendEos: seg.appendEos, sendDimensions: seg.sendDimensions };
    }
    return { kind: 'bundled' };
  }

  function caliberChanged(current, kind, seg) {
    if (kind === 'bundled') return current.kind !== 'bundled';
    if (current.kind !== kind) return true;
    return current.model !== seg.model
      || current.dim !== seg.dim
      || current.instruct !== seg.instruct
      || current.appendEos !== seg.appendEos
      || current.sendDimensions !== seg.sendDimensions;
  }

  async function estimateRebuild(nextKind) {
    let health = null;
    try { health = rag && typeof rag.health === 'function' ? await rag.health() : null; } catch { health = null; }
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      chunks: num(health?.store?.chunks),
      summaries: num(health?.distill?.summaries),
      chars: num(health?.store?.chars),
      cloud: nextKind === 'cloud'
    };
  }

  async function saveEmbedding(body = {}) {
    if (!ragEnabled()) return off409();
    const kind = String(body.kind ?? '');
    if (!EMBEDDING_KINDS.has(kind)) return badRequest('kind', '部署方式只能是 bundled / local / cloud');

    let seg = null;
    if (kind !== 'bundled') {
      const checked = validateSegment(kind, kind === 'local' ? body.local : body.cloud);
      if (checked.error) return { status: 400, body: { ok: false, ...checked.error } };
      seg = checked.value;
    }

    // 两把密钥都先校验（不因为当前 kind 用不到就放过坏输入）。
    const cloudKey = readKeyInput(body.apiKey, body.clearKey);
    if (cloudKey.error) return badRequest('apiKey', cloudKey.error);
    const localKey = readKeyInput(body.localApiKey, body.clearLocalKey);
    if (localKey.error) return badRequest('localApiKey', localKey.error);

    const existing = readJsonFile(settingsPath(stateDir));
    const settings = isPlainObject(existing) ? existing : null;
    const current = currentCaliber(settings);
    const changed = caliberChanged(current, kind, seg);

    // 口径变了：先要用户确认全量重建（这一步在拿锁之前，估算要现查 /health）。
    if (changed && body.confirmRebuild !== true) {
      const estimate = await estimateRebuild(kind);
      return { status: 409, body: { ok: false, needRebuild: true, estimate } };
    }
    // 口径变了且是本地 / 云端：本次提交必须带「测试连接」拿到的维度。
    if (changed && kind !== 'bundled') {
      const testedDim = Number(body.testedDim);
      if (!Number.isInteger(testedDim) || testedDim < seg.dim) {
        return { status: 400, body: { ok: false, needTest: true, error: '换向量模型前请先点「测试连接」' } };
      }
    }

    // 当前生效的是哪一种（设置文件不存在时按 config.yml 推 legacy-local / legacy-api）。
    // 提前算出来：下面判断「要不要重启」要用到它。
    const embeddingBefore = (() => {
      try { return readEmbeddingKind({ root, stateDir })(); } catch { return 'legacy-local'; }
    })();

    // 要不要重启：口径、kind、baseUrl、batch、超时任一变化都要让 memory-rag 重新读设置。
    let restartNeeded = false;
    if (!settings) {
      // APIHUB_PATCH：没有设置文件、当前就是 legacy-local、提交的又是 bundled 时，memory-rag
      // 两种情况用的是同一个 LlamaCppEmbedder、同一个 model_id（口径完全一样），重启只会白白
      // 中断一次服务 —— 只写设置文件、不重启。其它「从无到有」的情况照旧重启。
      restartNeeded = !(embeddingBefore === 'legacy-local' && kind === 'bundled');
    } else {
      if (String(settings.kind ?? '') !== kind) restartNeeded = true;
      if (kind !== 'bundled') {
        const prev = normalizeSegment(settings[kind]);
        if (!isPlainObject(settings[kind])) restartNeeded = true;
        else if (prev.baseUrl !== seg.baseUrl || prev.batch !== seg.batch || prev.timeoutS !== seg.timeoutS) restartNeeded = true;
      }
      if (changed) restartNeeded = true;
    }

    // 组装下一版设置：另一段原样保留（切换部署方式不清空另一种的已填值）。
    const nextSettings = { version: 1, kind };
    const keepLocal = kind === 'local' ? seg : (isPlainObject(settings?.local) ? normalizeSegment(settings.local) : null);
    const keepCloud = kind === 'cloud' ? seg : (isPlainObject(settings?.cloud) ? normalizeSegment(settings.cloud) : null);
    if (keepLocal) nextSettings.local = keepLocal;
    if (keepCloud) nextSettings.cloud = keepCloud;

    // 密钥文件：只去掉 / 替换被点名的那一把，另一个键保留。
    const keys = isPlainObject(readJsonFile(embeddingApiPath(stateDir))) ? { ...readJsonFile(embeddingApiPath(stateDir)) } : {};
    let keysChanged = false;
    if (kind === 'cloud') {
      if (cloudKey.kind === 'set') { keys.apiKey = cloudKey.key; keysChanged = true; }
      else if (cloudKey.kind === 'clear') { keys.apiKey = ''; keysChanged = true; }
    } else if (kind === 'local') {
      if (localKey.kind === 'set') { keys.localApiKey = localKey.key; keysChanged = true; }
      else if (localKey.kind === 'clear') { keys.localApiKey = ''; keysChanged = true; }
    }

    // APIHUB_PATCH：不重启时（第一次把 legacy-local 存成 bundled）设置文件也要写下去，
    // 否则用户以为保存了、下次打开还是「旧行为」。所以写文件与重启解耦。
    const settingsNeedsWrite = !settings || restartNeeded;

    try {
      return await ragControl.withLock(async () => {
        if (keysChanged) writeJson600(embeddingApiPath(stateDir), keys);
        if (settingsNeedsWrite) writeJson600(settingsPath(stateDir), nextSettings);
        if (restartNeeded) await ragControl.restartMemoryRag({ embeddingBefore, embeddingAfter: kind });
        if (changed) await ragControl.rebuild();
        log(`[api-hub] 向量模型设置已保存（kind=${kind}，重启=${restartNeeded}，重建=${changed}）`);
        return {
          status: 200,
          body: {
            ok: true,
            restarted: restartNeeded,
            rebuild: changed,
            rag: await ragControl.state()
          }
        };
      }, 'save-embedding');
    } catch (error) {
      if (error?.code === 'busy') return { status: 409, body: { ok: false, busy: true, error: '正在启停 / 保存向量记忆，请稍候' } };
      return { status: 500, body: { ok: false, error: String(error?.message ?? error) } };
    }
  }

  // ── POST /api/apis/embedding/test ─────────────────────────────────────

  /** 从响应体里取第一段向量；取不到返回 null。 */
  function firstEmbedding(data) {
    const item = Array.isArray(data?.data) ? data.data[0] : null;
    const vector = item?.embedding;
    if (!Array.isArray(vector) || !vector.length) return null;
    if (!vector.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    return vector;
  }

  async function testEmbedding(body = {}) {
    if (!ragEnabled()) return off409();
    const kind = String(body.kind ?? '');
    if (!EMBEDDING_KINDS.has(kind)) return badRequest('kind', '部署方式只能是 bundled / local / cloud');

    let url;
    let payload;
    let timeoutS = 30;
    let headers = { 'content-type': 'application/json' };
    if (kind === 'bundled') {
      // 自带 llama.cpp：不经过 memory-rag（它可能停着 / 配置坏了），直接问 :8091。
      url = 'http://127.0.0.1:8091/v1/embeddings';
      payload = { input: ['测试'] };
    } else {
      const checked = validateSegment(kind, kind === 'local' ? body.local : body.cloud, { requireDim: false });
      if (checked.error) return { status: 400, body: { ok: false, ...checked.error } };
      const seg = checked.value;
      timeoutS = seg.timeoutS;
      url = `${seg.baseUrl}/embeddings`;
      payload = { model: seg.model, input: ['测试'], encoding_format: 'float' };
      // 页面刚点「测试连接」时还没有维度：sendDimensions 只有在填了 dim 时才带上。
      if (seg.sendDimensions && seg.dim) payload.dimensions = seg.dim;
      const provided = String(kind === 'local' ? (body.localApiKey ?? '') : (body.apiKey ?? '')).trim();
      let key = provided;
      if (!key) {
        const saved = isPlainObject(readJsonFile(embeddingApiPath(stateDir))) ? readJsonFile(embeddingApiPath(stateDir)) : {};
        key = String(kind === 'local' ? (saved.localApiKey ?? '') : (saved.apiKey ?? '')).trim();
      }
      if (key) headers = { ...headers, authorization: `Bearer ${key}` };
      else if (kind === 'cloud') return { status: 200, body: { ok: false, error: 'no_key' } };
    }

    const startedAt = now();
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        // 不跟随重定向：地址是用户填的，跟到别处等于把「测试」发出去。
        redirect: 'error',
        signal: (() => { try { return AbortSignal.timeout(Math.max(1, timeoutS) * 1000); } catch { return undefined; } })()
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { status: 200, body: { ok: false, error: 'timeout' } };
      return { status: 200, body: { ok: false, error: 'network' } };
    }
    if (!response) return { status: 200, body: { ok: false, error: 'network' } };
    if (!response.ok) return { status: 200, body: { ok: false, error: `http ${response.status}` } };
    let data;
    try { data = await response.json(); } catch { return { status: 200, body: { ok: false, error: 'bad_response' } }; }
    const vector = firstEmbedding(data);
    if (!vector) return { status: 200, body: { ok: false, error: 'bad_response' } };
    // 云端 / 本地：返回比提交的维度短说明模型不支持（截短只能从长到短）。
    if (kind !== 'bundled') {
      const expected = Number(kind === 'local' ? body.local?.dim : body.cloud?.dim);
      if (Number.isInteger(expected) && expected > 0 && vector.length < expected) {
        return { status: 200, body: { ok: false, error: 'short_vector' } };
      }
    }
    return { status: 200, body: { ok: true, dim: vector.length, ms: Math.max(0, now() - startedAt) } };
  }

  // ── POST /api/apis/distill ─────────────────────────────────────────────

  function saveDistill(body = {}) {
    if (!ragEnabled()) return off409();
    if (typeof body.useShared !== 'boolean') return badRequest('useShared', 'useShared 必须是布尔值');
    const existing = isPlainObject(readJsonFile(distillPath(stateDir))) ? readJsonFile(distillPath(stateDir)) : {};
    const keyV = readKeyInput(body.apiKey, body.clearKey);
    if (keyV.error) return badRequest('apiKey', keyV.error);
    let apiKey = typeof existing.apiKey === 'string' ? existing.apiKey : '';
    if (keyV.kind === 'set') apiKey = keyV.key;
    else if (keyV.kind === 'clear') apiKey = '';
    let baseUrl = typeof existing.baseUrl === 'string' ? existing.baseUrl : '';
    if (body.baseUrl !== undefined && body.baseUrl !== null) {
      const raw = String(body.baseUrl).trim();
      if (raw) {
        try { baseUrl = normalizeCloudBaseUrl(raw); } catch (error) { return badRequest('baseUrl', error.message); }
      }
    }
    let model = typeof existing.model === 'string' ? existing.model : '';
    if (body.model !== undefined && body.model !== null) {
      const m = String(body.model).trim();
      if (m) {
        if (m.length > MODEL_MAX_LEN) return badRequest('model', `模型名太长（最多 ${MODEL_MAX_LEN} 字）`);
        model = m;
      }
    }
    if (!body.useShared) {
      if (!baseUrl) return badRequest('baseUrl', '单独配置时必须填接口地址');
      if (!model) return badRequest('model', '单独配置时必须填模型');
    }
    try { writeJson600(distillPath(stateDir), { useShared: body.useShared, baseUrl, model, apiKey }); } catch (error) {
      return { status: 500, body: { ok: false, error: String(error?.message ?? error) } };
    }
    log(`[api-hub] 话题提炼配置已保存（${body.useShared ? '共用判读' : '单独配置'}）`);
    return { status: 200, body: { ok: true, useShared: body.useShared, baseUrl, model, hasKey: !!apiKey, keyHint: hint(apiKey) } };
  }

  return {
    summary,
    savePersona,
    saveWebSearch,
    saveTts,
    saveDsh,
    saveEmbedding,
    testEmbedding,
    saveDistill,
    embeddingKind: readEmbeddingKind({ root, stateDir })
  };
}
