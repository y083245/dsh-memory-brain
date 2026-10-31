// tts-api.js · 远程语音合成接口（默认小米 MiMo TTS，兼容其它 OpenAI 风格接口）
//
// 三类模型，三种请求方式（与 MiMo 官方文档一致）：
//   - preset  预置音色      mimo-v2.5-tts            audio.voice = 预置音色 ID
//   - design  文字描述音色  mimo-v2.5-tts-voicedesign user 消息 = 音色描述（必填）
//   - clone   音频复刻音色  mimo-v2.5-tts-voiceclone  audio.voice = data:{mime};base64,{样本}
//   - custom  其它接口      完全由「请求头 / 请求体」两段模板决定
//
// design / custom 走**模板原文**：
//   - 请求头：按行解析成键值后，只做占位符替换，原样作为 HTTP 头发送；
//             不自动补 Content-Type、Authorization。
//   - 请求体：占位符替换后原样作为字节发送；不 JSON.parse、不重新序列化、不 pretty-print、
//             不加任何前后缀。
//   - 落盘保存的就是这两段原文（UTF-8 原字节），读回来与写进去字节一致。
//
// 发送用 node:http(s) 而不是 fetch：fetch 会在字符串请求体上自动补 text/plain 的
// Content-Type，并附带 accept-language / sec-fetch-mode 等头，违背「原样发送」。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

export const DEFAULT_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';

/** 官方预置音色（mimo-v2.5-tts）。id 是请求里填的值，name 是界面上显示的中文名。 */
export const PRESET_VOICES = Object.freeze([
  { id: 'mimo_default', name: 'MiMo 默认', lang: '跟随集群', gender: '—', note: '中国集群默认为「冰糖」' },
  { id: '冰糖', name: '冰糖', lang: '中文', gender: '女声', note: '' },
  { id: '茉莉', name: '茉莉', lang: '中文', gender: '女声', note: '' },
  { id: '苏打', name: '苏打', lang: '中文', gender: '男声', note: '' },
  { id: '白桦', name: '白桦', lang: '中文', gender: '男声', note: '' },
  { id: 'Mia', name: '米娅（Mia）', lang: '英文', gender: '女声', note: '' },
  { id: 'Chloe', name: '克洛伊（Chloe）', lang: '英文', gender: '女声', note: '' },
  { id: 'Milo', name: '米洛（Milo）', lang: '英文', gender: '男声', note: '' },
  { id: 'Dean', name: '迪恩（Dean）', lang: '英文', gender: '男声', note: '' }
]);

export const MODES = Object.freeze({
  preset: '预置音色',
  design: '文字描述音色（请求头 / 请求体模板）',
  clone: '语音克隆',
  custom: '自定义接口（请求头 / 请求体模板）'
});

/** 模板里可用的占位符。*_json 版本是 JSON 字符串转义后的内容（不含两侧引号）。 */
export const PLACEHOLDERS = Object.freeze([
  ['api_key', 'API 密钥'],
  ['model', '当前模型 ID'],
  ['endpoint', '接口地址'],
  ['format', '音频格式（wav / mp3 / pcm16）'],
  ['text', '要合成的文字（原文）'],
  ['text_json', '要合成的文字（JSON 字符串转义）'],
  ['instruction', '音色描述 / 风格指令（原文）'],
  ['instruction_json', '音色描述 / 风格指令（JSON 转义）'],
  ['style', '本次调用附带的风格（AI 可选传入，原文）'],
  ['style_json', '本次调用附带的风格（JSON 转义）'],
  ['voice', '音色值（预置音色 ID 或克隆样本 data URI，原文）'],
  ['voice_json', '音色值（JSON 转义）']
]);
const PLACEHOLDER_NAMES = new Set(PLACEHOLDERS.map(([k]) => k));

export const DEFAULT_HEADERS_TEMPLATE = [
  'Authorization: Bearer {{api_key}}',
  'Content-Type: application/json'
].join('\n');

// voicedesign：user 消息是音色描述（必填），assistant 消息是要合成的文字。
export const DEFAULT_BODY_TEMPLATE =
  '{"model":"{{model}}","messages":[{"role":"user","content":"{{instruction_json}}"},{"role":"assistant","content":"{{text_json}}"}],"audio":{"format":"{{format}}"}}';

const MAX_CLONE_RAW_BYTES = Math.floor(10 * 1024 * 1024 * 3 / 4) - 1024; // base64 后 ≤ 10MB
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  enabled: true,
  endpoint: DEFAULT_ENDPOINT,
  modelsUrl: '',
  apiKey: '',
  model: 'mimo-v2.5-tts',
  mode: 'auto',
  format: 'wav',
  timeoutMs: 120000,
  maxChars: 200,
  preset: { voice: '冰糖', instruction: '' },
  design: { prompt: '' },
  clone: { file: '', instruction: '' },
  models: [],
  modelsFetchedAt: 0
});

// ── 小工具 ──────────────────────────────────────────────────────────────

function jsonEscape(s) {
  return JSON.stringify(String(s ?? '')).slice(1, -1);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeBaseName(name) {
  const base = path.basename(String(name ?? '')).replace(/\.[^.]*$/, '');
  const cleaned = base.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return cleaned || 'sample';
}

/** 根据模型 ID 推断模式。 */
export function classifyModel(id) {
  const s = String(id ?? '').toLowerCase();
  if (/clone/.test(s)) return 'clone';
  if (/design/.test(s)) return 'design';
  if (/tts|speech|audio|voice/.test(s)) return 'preset';
  return 'custom';
}

/** 由接口地址推出模型列表地址：…/chat/completions → …/models。 */
export function deriveModelsUrl(endpoint, explicit = '') {
  if (explicit) return explicit;
  const u = new URL(endpoint);
  const p = u.pathname.replace(/\/+$/, '');
  const m = /^(.*?)\/(chat\/completions|audio\/speech|completions|responses)$/.exec(p);
  u.pathname = m ? `${m[1]}/models` : `${p.replace(/\/v1\/.*$/, '/v1') || '/v1'}/models`;
  u.search = '';
  return u.toString();
}

/** 替换 {{name}}。只认已知占位符，未知的原样保留（检查时会报出来）。 */
export function fillTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, name) =>
    (PLACEHOLDER_NAMES.has(name) && Object.hasOwn(vars, name) ? String(vars[name]) : m));
}

export function unknownPlaceholders(tpl) {
  const out = new Set();
  for (const m of String(tpl ?? '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    if (!PLACEHOLDER_NAMES.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * 请求头模板 → [[名, 值], …]。
 * 一行一个「名: 值」，空行与 # 开头的行忽略。先解析再对每个名/值做占位符替换，
 * 不增不删、不改大小写、不补任何默认头。
 */
export function parseHeaderTemplate(tpl, vars = null) {
  const out = [];
  const errors = [];
  const lines = String(tpl ?? '').split('\n');
  lines.forEach((rawLine, i) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const idx = line.indexOf(':');
    if (idx <= 0) { errors.push(`第 ${i + 1} 行缺少「名: 值」里的冒号`); return; }
    let name = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).replace(/^[ \t]+/, '');
    if (vars) {
      name = fillTemplate(name, vars);
      value = fillTemplate(value, vars);
    }
    if (!HEADER_NAME_RE.test(name)) { errors.push(`第 ${i + 1} 行的头名「${name}」不合法`); return; }
    if (/[\r\n\0]/.test(value)) { errors.push(`第 ${i + 1} 行（${name}）替换后含换行或空字符`); return; }
    // HTTP 头只能是 Latin-1 字节，中文等字符 node 会直接拒发；在检查阶段就讲清楚
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) { errors.push(`第 ${i + 1} 行（${name}）含中文等非 ASCII 字符，HTTP 头不支持，请改放到请求体里`); return; }
    out.push([name, value]);
  });
  return { headers: out, errors };
}

function detectAudio(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  return null;
}

/** 裸 PCM16LE 单声道 → WAV（MiMo 流式/pcm16 输出为 24kHz）。 */
export function wrapPcm16(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decodeB64(s) {
  const str = String(s ?? '').replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!str) return null;
  const buf = Buffer.from(str, 'base64');
  return buf.length ? buf : null;
}

function pickAudioField(json) {
  if (!json || typeof json !== 'object') return null;
  const cands = [
    json.choices?.[0]?.message?.audio?.data,
    json.choices?.[0]?.delta?.audio?.data,
    json.data?.[0]?.b64_json,
    json.audio?.data,
    typeof json.audio === 'string' ? json.audio : null,
    json.data?.audio,
    json.output?.audio?.data,
    json.result?.audio
  ];
  return cands.find((x) => typeof x === 'string' && x.length > 16) ?? null;
}

function errorFromJson(json) {
  const e = json?.error;
  if (!e) return '';
  if (typeof e === 'string') return e;
  return [e.message, e.param, e.code].filter(Boolean).join(' · ') || JSON.stringify(e).slice(0, 300);
}

/** 从 HTTP 响应里取出音频字节。 */
export function extractAudio(res, { format = 'wav' } = {}) {
  const ct = String(res.headers['content-type'] ?? '').toLowerCase();
  const body = res.body;
  if (res.status < 200 || res.status >= 300) {
    let msg = '';
    try { msg = errorFromJson(JSON.parse(body.toString('utf8'))); } catch {}
    throw new Error(`接口返回 HTTP ${res.status}${msg ? `：${msg}` : `：${body.toString('utf8').slice(0, 300)}`}`);
  }
  if (ct.startsWith('audio/') || ct.includes('octet-stream')) {
    const det = detectAudio(body);
    if (det) return { buf: body, ...det };
    return { buf: wrapPcm16(body), ext: 'wav', mime: 'audio/wav', wrapped: true };
  }
  const text = body.toString('utf8');
  // SSE（stream=true 的模板）：拼 delta.audio.data
  if (ct.includes('event-stream') || /^\s*data:/.test(text)) {
    const parts = [];
    for (const line of text.split('\n')) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === '[DONE]') continue;
      let j; try { j = JSON.parse(m[1]); } catch { continue; }
      const err = errorFromJson(j);
      if (err) throw new Error(`接口返回错误：${err}`);
      const b = decodeB64(pickAudioField(j));
      if (b) parts.push(b);
    }
    if (!parts.length) throw new Error('流式响应里没有音频数据');
    const all = Buffer.concat(parts);
    const det = detectAudio(all);
    return det ? { buf: all, ...det } : { buf: wrapPcm16(all), ext: 'wav', mime: 'audio/wav', wrapped: true };
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`响应既不是音频也不是 JSON：${text.slice(0, 200)}`); }
  const err = errorFromJson(json);
  if (err) throw new Error(`接口返回错误：${err}`);
  const buf = decodeB64(pickAudioField(json));
  if (!buf) throw new Error(`响应里找不到音频数据（choices[0].message.audio.data）：${text.slice(0, 300)}`);
  const det = detectAudio(buf);
  if (det) return { buf, ...det };
  return { buf: wrapPcm16(buf), ext: 'wav', mime: 'audio/wav', wrapped: true, assumed: format };
}

/**
 * 原样发送：headers 是 [[名, 值]]，按给出的顺序、大小写发出；body 是 Buffer。
 * 只追加传输层必需的 Host（node 自动）与 Content-Length（模板没写时）。
 */
export function rawRequest({ url, method = 'POST', headers = [], body = null, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error(`接口地址不合法：${url}`)); return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { reject(new Error('接口地址只支持 http / https')); return; }
    // 数组形式的请求头 node 不会自动补 Host；Host / Content-Length 是 HTTP/1.1 传输层必需的，
    // 模板里没写才补，写了就用模板的值。
    const flat = [];
    let hasLength = false;
    let hasHost = false;
    for (const [k, v] of headers) {
      const lk = k.toLowerCase();
      if (lk === 'content-length') hasLength = true;
      if (lk === 'host') hasHost = true;
      flat.push(k, v);
    }
    if (!hasHost) flat.unshift('Host', u.host);
    if (body && !hasLength) flat.push('Content-Length', String(body.length));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: flat }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_RESPONSE_BYTES) { req.destroy(new Error('响应过大（超过 40MB）')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

/** 读一个可能比 1MB 大的 JSON 请求体（克隆样本上传用）。 */
export function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { const e = new Error(`请求体过大（超过 ${Math.round(limit / 1024 / 1024)}MB）`); e.statusCode = 413; reject(e); return; }
    const chunks = [];
    let total = 0;
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; const e = new Error('请求体读取超时'); e.statusCode = 400; reject(e); } }, 120000);
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > limit) { done = true; clearTimeout(timer); req.pause(); const e = new Error('请求体过大'); e.statusCode = 413; reject(e); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('x');
        resolve(j);
      } catch { const e = new Error('请求体必须是 JSON 对象'); e.statusCode = 400; reject(e); }
    });
    req.on('error', () => { if (!done) { done = true; clearTimeout(timer); const e = new Error('请求体读取失败'); e.statusCode = 400; reject(e); } });
  });
}

// ── 主体 ────────────────────────────────────────────────────────────────

export function createTtsApi({ stateDir, log = () => {} }) {
  const CONFIG_FILE = path.join(stateDir, 'config.json');
  const HEADERS_FILE = path.join(stateDir, 'request-headers.txt');
  const BODY_FILE = path.join(stateDir, 'request-body.txt');
  const CLONE_DIR = path.join(stateDir, 'clone');
  const PREVIEW_DIR = path.join(stateDir, 'previews');
  const TEST_DIR = path.join(stateDir, 'tests');

  function readConfig() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')); } catch {}
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      preset: { ...DEFAULT_CONFIG.preset, ...(raw.preset ?? {}) },
      design: { ...DEFAULT_CONFIG.design, ...(raw.design ?? {}) },
      clone: { ...DEFAULT_CONFIG.clone, ...(raw.clone ?? {}) },
      models: Array.isArray(raw.models) ? raw.models : []
    };
  }

  function writeConfig(c) {
    writeFileAtomic(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n', 0o600);
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  }

  function resolvedMode(c = readConfig()) {
    return c.mode && c.mode !== 'auto' && Object.hasOwn(MODES, c.mode) ? c.mode : classifyModel(c.model);
  }

  /** 给前端的配置视图：密钥只给提示，不回传原文。 */
  function publicConfig() {
    const c = readConfig();
    const key = String(c.apiKey ?? '');
    const { apiKey, ...rest } = c;
    return {
      ...rest,
      hasApiKey: !!key,
      apiKeyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}（${key.length} 位）` : '',
      resolvedMode: resolvedMode(c),
      modelsUrlResolved: (() => { try { return deriveModelsUrl(c.endpoint, c.modelsUrl); } catch { return ''; } })()
    };
  }

  function saveConfig(patch) {
    const c = readConfig();
    const next = { ...c };
    const str = (v, max = 2000) => String(v ?? '').slice(0, max);
    if (patch.endpoint !== undefined) {
      const e = str(patch.endpoint).trim() || DEFAULT_ENDPOINT;
      const u = new URL(e);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('接口地址只支持 http / https');
      next.endpoint = e;
    }
    if (patch.modelsUrl !== undefined) {
      const m = str(patch.modelsUrl).trim();
      if (m) new URL(m);
      next.modelsUrl = m;
    }
    if (patch.clearApiKey === true) next.apiKey = '';
    else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
    if (patch.model !== undefined) next.model = str(patch.model, 200).trim();
    if (patch.mode !== undefined) {
      const m = String(patch.mode);
      if (m !== 'auto' && !Object.hasOwn(MODES, m)) throw new Error(`未知模式：${m}`);
      next.mode = m;
    }
    if (patch.format !== undefined) {
      const f = String(patch.format);
      if (!['wav', 'mp3', 'pcm16'].includes(f)) throw new Error('音频格式只支持 wav / mp3 / pcm16');
      next.format = f;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
    if (patch.timeoutMs !== undefined) next.timeoutMs = Math.min(600000, Math.max(5000, Number(patch.timeoutMs) || 120000));
    if (patch.maxChars !== undefined) next.maxChars = Math.min(2000, Math.max(10, Number(patch.maxChars) || 200));
    if (patch.preset) {
      next.preset = { ...c.preset };
      if (patch.preset.voice !== undefined) next.preset.voice = str(patch.preset.voice, 100).trim();
      if (patch.preset.instruction !== undefined) next.preset.instruction = str(patch.preset.instruction);
    }
    if (patch.design) {
      next.design = { ...c.design };
      if (patch.design.prompt !== undefined) next.design.prompt = str(patch.design.prompt);
    }
    if (patch.clone) {
      next.clone = { ...c.clone };
      if (patch.clone.file !== undefined) {
        const f = path.basename(str(patch.clone.file, 200));
        if (f && !fs.existsSync(path.join(CLONE_DIR, f))) throw new Error(`克隆样本不存在：${f}`);
        next.clone.file = f;
      }
      if (patch.clone.instruction !== undefined) next.clone.instruction = str(patch.clone.instruction);
    }
    writeConfig(next);
    return publicConfig();
  }

  // 模板：原文读写。文件不存在时给默认模板（saved=false）。
  function templateFile(which) {
    if (which === 'headers') return HEADERS_FILE;
    if (which === 'body') return BODY_FILE;
    throw new Error('which 只能是 headers 或 body');
  }

  function readTemplate(which) {
    const file = templateFile(which);
    try {
      const buf = fs.readFileSync(file);
      return { text: buf.toString('utf8'), saved: true, bytes: buf.length, sha256: sha256(buf) };
    } catch {
      const text = which === 'headers' ? DEFAULT_HEADERS_TEMPLATE : DEFAULT_BODY_TEMPLATE;
      const buf = Buffer.from(text, 'utf8');
      return { text, saved: false, bytes: buf.length, sha256: sha256(buf) };
    }
  }

  function saveTemplate(which, text) {
    if (typeof text !== 'string') throw new Error('模板必须是字符串');
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > 256 * 1024) throw new Error('模板过大（超过 256KB）');
    writeFileAtomic(templateFile(which), buf, 0o600);
    const back = fs.readFileSync(templateFile(which));
    if (!back.equals(buf)) throw new Error('模板写入后回读不一致');
    return { saved: true, bytes: back.length, sha256: sha256(back) };
  }

  function resetTemplate(which) {
    try { fs.unlinkSync(templateFile(which)); } catch {}
    return readTemplate(which);
  }

  // 克隆样本
  function listCloneSamples() {
    let names = [];
    try { names = fs.readdirSync(CLONE_DIR); } catch {}
    return names.filter((n) => /\.(wav|mp3)$/i.test(n)).sort().map((n) => {
      const st = fs.statSync(path.join(CLONE_DIR, n));
      return { name: n, bytes: st.size, mtimeMs: st.mtimeMs };
    });
  }

  function saveCloneSample(filename, buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('样本是空的');
    if (buf.length > MAX_CLONE_RAW_BYTES) throw new Error(`样本过大：官方要求 Base64 后不超过 10MB（原文件约 ${(MAX_CLONE_RAW_BYTES / 1024 / 1024).toFixed(1)}MB 以内）`);
    const det = detectAudio(buf);
    if (!det || (det.ext !== 'wav' && det.ext !== 'mp3')) throw new Error('只支持 mp3 / wav 格式的样本');
    const name = `${stamp()}-${safeBaseName(filename)}.${det.ext}`;
    writeFileAtomic(path.join(CLONE_DIR, name), buf, 0o600);
    return { name, bytes: buf.length, mime: det.mime };
  }

  function deleteCloneSample(name) {
    const n = path.basename(String(name ?? ''));
    if (!n) throw new Error('缺少文件名');
    fs.unlinkSync(path.join(CLONE_DIR, n));
    const c = readConfig();
    if (c.clone.file === n) { c.clone.file = ''; writeConfig(c); }
    return { deleted: n };
  }

  function cloneDataUri(name) {
    const n = path.basename(String(name ?? ''));
    if (!n) throw new Error('语音克隆模式需要先上传并选择一个音频样本');
    const file = path.join(CLONE_DIR, n);
    if (!fs.existsSync(file)) throw new Error(`克隆样本不存在：${n}`);
    const buf = fs.readFileSync(file);
    const det = detectAudio(buf);
    const mime = det?.ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  /** 组出一次请求（不发送）。opts.voice 可临时指定预置音色（试听用）。 */
  function buildRequest({ text, style = '', voice = null } = {}, c = readConfig()) {
    const mode = resolvedMode(c);
    const content = String(text ?? '');
    if (!content.trim()) throw new Error('要合成的文字是空的');
    if (!c.model) throw new Error('还没有选择模型');
    const styleText = String(style ?? '').trim();
    const join = (...xs) => xs.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n');

    if (mode === 'preset' || mode === 'clone') {
      const voiceValue = mode === 'preset'
        ? (voice || c.preset.voice || 'mimo_default')
        : cloneDataUri(c.clone.file);
      const instruction = join(mode === 'preset' ? c.preset.instruction : c.clone.instruction, styleText);
      const messages = [];
      if (instruction || mode === 'clone') messages.push({ role: 'user', content: instruction });
      messages.push({ role: 'assistant', content });
      const payload = { model: c.model, messages, audio: { format: c.format === 'pcm16' ? 'wav' : c.format, voice: voiceValue } };
      const headers = [['Content-Type', 'application/json']];
      if (c.apiKey) headers.unshift(['Authorization', `Bearer ${c.apiKey}`]);
      return { mode, url: c.endpoint, headers, body: Buffer.from(JSON.stringify(payload), 'utf8'), voice: mode === 'preset' ? voiceValue : c.clone.file };
    }

    // design / custom：模板原文
    const instruction = String(c.design.prompt ?? '').trim();
    if (mode === 'design' && !instruction) throw new Error('文字描述音色模式需要先填写「音色描述」');
    const voiceValue = voice || c.preset.voice || '';
    const vars = {
      api_key: c.apiKey ?? '',
      model: c.model,
      endpoint: c.endpoint,
      format: c.format,
      text: content,
      text_json: jsonEscape(content),
      instruction,
      instruction_json: jsonEscape(instruction),
      style: styleText,
      style_json: jsonEscape(styleText),
      voice: voiceValue,
      voice_json: jsonEscape(voiceValue)
    };
    const ht = readTemplate('headers').text;
    const bt = readTemplate('body').text;
    const { headers, errors } = parseHeaderTemplate(ht, vars);
    if (errors.length) throw new Error(`请求头模板有误：${errors.join('；')}`);
    const body = Buffer.from(fillTemplate(bt, vars), 'utf8');
    return { mode, url: c.endpoint, headers, body, voice: '' };
  }

  async function synthesize(opts = {}) {
    const c = readConfig();
    if (String(opts.text ?? '').length > c.maxChars && !opts.ignoreLimit) {
      throw new Error(`文字太长（${String(opts.text).length} 字，上限 ${c.maxChars}）`);
    }
    const reqSpec = buildRequest(opts, c);
    const t0 = Date.now();
    const res = await rawRequest({ url: reqSpec.url, headers: reqSpec.headers, body: reqSpec.body, timeoutMs: c.timeoutMs });
    const audio = extractAudio(res, { format: c.format });
    return { ...audio, mode: reqSpec.mode, model: c.model, voice: reqSpec.voice, ms: Date.now() - t0 };
  }

  function writeAudio(dir, prefix, audio) {
    const name = `${prefix}-${stamp()}-${crypto.randomBytes(2).toString('hex')}.${audio.ext}`;
    const file = path.join(dir, name);
    writeFileAtomic(file, audio.buf);
    return { name, file };
  }

  function pruneDir(dir, keep) {
    let files = [];
    try { files = fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })); } catch { return; }
    files.sort((a, b) => b.t - a.t).slice(keep).forEach(({ n }) => { try { fs.unlinkSync(path.join(dir, n)); } catch {} });
  }

  async function testSynthesize({ text, style }) {
    const audio = await synthesize({ text, style, ignoreLimit: true });
    const saved = writeAudio(TEST_DIR, 'test', audio);
    pruneDir(TEST_DIR, 20);
    return { ...saved, bytes: audio.buf.length, mime: audio.mime, mode: audio.mode, model: audio.model, voice: audio.voice, ms: audio.ms };
  }

  /** 合成到指定目录（AI 发语音用）。 */
  async function synthesizeTo(dir, { text, style }) {
    const audio = await synthesize({ text, style });
    const saved = writeAudio(dir, 'tts', audio);
    pruneDir(dir, 60);
    return { ...saved, bytes: audio.buf.length, mime: audio.mime, mode: audio.mode, model: audio.model, voice: audio.voice, ms: audio.ms };
  }

  function previewText(v) {
    if (v.lang === '英文') return `Hi, I'm ${v.id}. It's lovely to meet you — hope your day is going well.`;
    return `你好呀，我是${v.id === 'mimo_default' ? '默认音色' : v.name}，很高兴认识你。今天也要开开心心的哦。`;
  }

  /** 预置音色试听：缓存到 previews/，同一模型同一音色只合成一次。 */
  async function previewVoice(voiceId, { force = false } = {}) {
    const v = PRESET_VOICES.find((x) => x.id === voiceId);
    if (!v) throw new Error(`未知的预置音色：${voiceId}`);
    const c = readConfig();
    if (resolvedMode(c) !== 'preset') throw new Error('试听预置音色需要先选择预置音色模型（如 mimo-v2.5-tts）');
    const key = sha256(Buffer.from(`${c.endpoint}|${c.model}|${v.id}`)).slice(0, 16);
    let names = [];
    try { names = fs.readdirSync(PREVIEW_DIR); } catch {}
    const hit = names.find((n) => n.startsWith(`${key}.`));
    if (hit && !force) return { name: hit, cached: true, voice: v.id };
    if (hit) { try { fs.unlinkSync(path.join(PREVIEW_DIR, hit)); } catch {} }
    const audio = await synthesize({ text: previewText(v), voice: v.id, ignoreLimit: true });
    const name = `${key}.${audio.ext}`;
    writeFileAtomic(path.join(PREVIEW_DIR, name), audio.buf);
    return { name, cached: false, voice: v.id, ms: audio.ms };
  }

  /** 取试听/测试/样本文件（只认三个目录里的 basename）。 */
  function audioFile(kind, name) {
    const dir = kind === 'test' ? TEST_DIR : kind === 'preview' ? PREVIEW_DIR : kind === 'clone' ? CLONE_DIR : null;
    if (!dir) throw new Error('kind 只能是 test / preview / clone');
    const n = path.basename(String(name ?? ''));
    const file = path.join(dir, n);
    if (!n || !fs.existsSync(file)) throw new Error('文件不存在');
    const buf = fs.readFileSync(file);
    return { buf, mime: detectAudio(buf)?.mime ?? 'application/octet-stream' };
  }

  async function fetchModels(override = {}) {
    const c = readConfig();
    const endpoint = override.endpoint || c.endpoint;
    const apiKey = (typeof override.apiKey === 'string' && override.apiKey.trim()) ? override.apiKey.trim() : c.apiKey;
    const url = deriveModelsUrl(endpoint, override.modelsUrl ?? c.modelsUrl);
    const headers = apiKey ? [['Authorization', `Bearer ${apiKey}`]] : [];
    const res = await rawRequest({ url, method: 'GET', headers, timeoutMs: 30000 });
    let json = null;
    try { json = JSON.parse(res.body.toString('utf8')); } catch {}
    if (res.status < 200 || res.status >= 300) throw new Error(`获取模型失败：HTTP ${res.status}${errorFromJson(json) ? `：${errorFromJson(json)}` : ''}`);
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const models = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean)
      .map((id) => ({ id: String(id), mode: classifyModel(id) }))
      .sort((a, b) => (a.mode === 'custom') - (b.mode === 'custom') || a.id.localeCompare(b.id));
    const next = readConfig();
    next.models = models;
    next.modelsFetchedAt = Date.now();
    writeConfig(next);
    return { url, models };
  }

  async function check() {
    const c = readConfig();
    const items = [];
    const add = (name, ok, detail = '', level = ok ? 'ok' : 'error') => items.push({ name, ok, level, detail });
    let urlOk = false;
    try { const u = new URL(c.endpoint); urlOk = u.protocol === 'https:' || u.protocol === 'http:'; } catch {}
    add('接口地址', urlOk, c.endpoint);
    const mode = resolvedMode(c);
    add('模型', !!c.model, c.model ? `${c.model} → ${MODES[mode]}` : '未选择');
    const usesKey = mode === 'preset' || mode === 'clone' || /\{\{\s*api_key\s*\}\}/.test(readTemplate('headers').text + readTemplate('body').text);
    if (usesKey) add('API 密钥', !!c.apiKey, c.apiKey ? '已填写' : '未填写');
    else add('API 密钥', true, c.apiKey ? '已填写（模板未引用）' : '模板未引用 {{api_key}}', 'ok');

    if (mode === 'preset') {
      const known = PRESET_VOICES.some((v) => v.id === c.preset.voice);
      add('预置音色', !!c.preset.voice, known ? c.preset.voice : `${c.preset.voice || '未选择'}（不在官方列表，按原值发送）`, known ? 'ok' : 'warn');
    } else if (mode === 'clone') {
      const s = listCloneSamples().find((x) => x.name === c.clone.file);
      add('克隆样本', !!s, s ? `${s.name}（${(s.bytes / 1024).toFixed(0)} KB）` : '未上传或未选择');
    } else {
      const ht = readTemplate('headers');
      const bt = readTemplate('body');
      const ph = parseHeaderTemplate(ht.text);
      add('请求头模板', !ph.errors.length, ph.errors.length ? ph.errors.join('；') : `${ph.headers.length} 个头${ht.saved ? '' : '（默认模板，尚未保存）'}`);
      add('请求体模板', !!bt.text.trim(), bt.text.trim() ? `${bt.bytes} 字节${bt.saved ? '' : '（默认模板，尚未保存）'}` : '为空');
      const unk = unknownPlaceholders(ht.text + '\n' + bt.text);
      add('占位符', !unk.length, unk.length ? `未知占位符：${unk.map((x) => `{{${x}}}`).join(' ')}` : '全部可识别', unk.length ? 'warn' : 'ok');
      if (mode === 'design') add('音色描述', !!c.design.prompt.trim(), c.design.prompt.trim() ? `${c.design.prompt.trim().length} 字` : 'voicedesign 模型必填');
    }

    if (urlOk && c.apiKey) {
      try {
        const r = await fetchModels();
        const found = r.models.some((m) => m.id === c.model);
        add('连通性 / 鉴权', true, `模型列表可访问（${r.models.length} 个）`);
        add('模型可用', found, found ? '在模型列表中' : '当前模型不在接口返回的列表里（自定义接口可忽略）', found ? 'ok' : 'warn');
      } catch (e) {
        add('连通性 / 鉴权', false, e?.message ?? String(e));
      }
    }
    const ok = items.every((i) => i.ok || i.level === 'warn');
    return { ok, mode, items };
  }

  function overview() {
    return {
      config: publicConfig(),
      templates: { headers: readTemplate('headers'), body: readTemplate('body') },
      presetVoices: PRESET_VOICES,
      cloneSamples: listCloneSamples(),
      modes: MODES,
      placeholders: PLACEHOLDERS,
      defaults: { endpoint: DEFAULT_ENDPOINT, headers: DEFAULT_HEADERS_TEMPLATE, body: DEFAULT_BODY_TEMPLATE }
    };
  }

  return {
    readConfig, publicConfig, saveConfig, resolvedMode,
    readTemplate, saveTemplate, resetTemplate,
    listCloneSamples, saveCloneSample, deleteCloneSample,
    buildRequest, synthesize, synthesizeTo, testSynthesize, previewVoice, audioFile,
    fetchModels, check, overview
  };
}
