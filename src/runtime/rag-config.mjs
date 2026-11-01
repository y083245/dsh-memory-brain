// RAG 开关与部署方式的 Node 实现 —— 与 scripts/rag-config.py 的规则逐条对齐。
//
// 为什么编排脚本不再依赖 python3：Windows 上不一定有 python3（只有 py / python），
// 而这里只做「读整份 config.json → 只改 memoryRag.enabled → 临时文件 + rename」，
// 用 Node 标准库就能可靠完成；rag-config.py 继续保留给 Linux systemd / 旧脚本与测试。
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import YAML from 'js-yaml';

const SETTINGS_REL = ['state', 'long-memory', 'rag', 'embedding-settings.json'];
const RAG_YML_REL = ['sidecars', 'memory-rag', 'config.yml'];
const RAG_KINDS = new Set(['bundled', 'local', 'cloud']);

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** memoryRag.enabled 只有正好是 true 才算开（缺省/非布尔/结构不对都算关）。 */
export function readRagEnabled(root) {
  try {
    const doc = readJson(path.join(root, 'config.json'));
    return isPlainObject(doc) && isPlainObject(doc.memoryRag) && doc.memoryRag.enabled === true;
  } catch {
    return false;
  }
}

async function renameWithRetry(from, to) {
  let lastError;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      // Windows 上杀软/备份进程短暂占住目标文件是常见现象；与桥接的原子写同样的退避。
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) break;
      await sleep(50 * (i + 1));
    }
  }
  throw lastError;
}

/** 写 config.json 的 memoryRag.enabled；失败抛错，原文件保持不变。 */
export async function writeRagEnabled(root, value) {
  const file = path.join(root, 'config.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`读不了 ${file}：${error?.message ?? error}`);
  }
  let doc;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error(`${file} 不是合法 JSON，没改`);
  }
  if (!isPlainObject(doc)) throw new Error(`${file} 的顶层不是对象，没改`);
  const rag = doc.memoryRag === undefined || doc.memoryRag === null ? {} : doc.memoryRag;
  if (!isPlainObject(rag)) throw new Error(`${file} 的 memoryRag 不是对象，没改`);
  rag.enabled = value === true;
  doc.memoryRag = rag;

  const dir = path.dirname(file);
  const temp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let mode = null;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* 读不到权限就按默认 */ }
  try {
    fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: mode ?? 0o600 });
    if (mode !== null && process.platform !== 'win32') {
      try { fs.chmodSync(temp, mode); } catch { /* 权限改不动不影响内容 */ }
    }
    await renameWithRetry(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 临时文件可能没建出来 */ }
    throw new Error(`写不了 ${file}：${error?.message ?? error}`);
  }
}

/**
 * embedding 归不归本项目管（控制台/start-all 是否该起 qq-embedding）。
 * 设置文件存在且 kind 认识时以它为准：bundled = 管，local / cloud = 不管；
 * 否则回落到 sidecars/memory-rag/config.yml 的 embedding.provider（api = 不管）。
 */
export function isEmbeddingManaged(root) {
  const settings = path.join(root, ...SETTINGS_REL);
  try {
    if (fs.existsSync(settings)) {
      const doc = readJson(settings);
      if (isPlainObject(doc) && typeof doc.kind === 'string' && RAG_KINDS.has(doc.kind)) {
        return doc.kind === 'bundled';
      }
      // 结构不认识：与 Python 版一致，继续按 config.yml 判断。
    }
  } catch {
    // 读不了也回落到 config.yml。
  }

  const yml = path.join(root, ...RAG_YML_REL);
  if (!fs.existsSync(yml)) return true;
  try {
    const doc = YAML.load(fs.readFileSync(yml, 'utf8')) ?? {};
    const embedding = isPlainObject(doc) && isPlainObject(doc.embedding) ? doc.embedding : null;
    return embedding?.provider !== 'api';
  } catch {
    return true;
  }
}
