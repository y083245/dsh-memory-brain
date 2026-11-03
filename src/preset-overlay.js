// UPGRADE_PATCH：仿真提示词覆盖层（docs/design/UPGRADE_SPEC.md §3、接口约定 §1.2）。
//
// 为什么：控制台以前直接改写 dsh/agent-presets/<preset>/agent.cordis.yml（被 git 跟踪），
// 出厂 preset 一更新，用户改的提示词要么冲突要么丢。现在只把**提示词正文**存进
// state/preset-overrides/<preset>.prefix.md，生成 / 安装 preset 时再拼回出厂 YAML。
//
// 桥接（控制台读写）和 scripts/build-agent-preset-patches.mjs（生成派生 patch）共用这一份，
// 保证两边看到的「生效版本」是同一个东西。没有覆盖文件时 effectivePresetYaml 返回出厂原文，
// 派生 patch 与改动前逐字节相同。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renderPresetPromptYaml } from './preset-prompt.js';

/** 只接受这两个由桥接托管的预设（与 bridge.js 的 PRESET_NAMES / knownPresetName 一致）。 */
export const OVERLAY_PRESET_NAMES = Object.freeze(['qq-chat', 'qq-chat-v2']);

function checkName(name) {
  const n = String(name ?? '');
  if (!OVERLAY_PRESET_NAMES.includes(n)) throw new Error(`未知预设：${n.slice(0, 60)}`);
  return n;
}

/** 预设代次：决定 renderPresetPromptYaml 用哪一套安全不变量。 */
export function presetKind(name) {
  return checkName(name) === 'qq-chat' ? 'v1' : 'v2';
}

export function factoryPresetYamlPath(root, name) {
  return path.join(root, 'dsh', 'agent-presets', checkName(name), 'agent.cordis.yml');
}

export function overridePath(root, name) {
  return path.join(root, 'state', 'preset-overrides', `${checkName(name)}.prefix.md`);
}

/** 覆盖正文；文件不存在或读失败都返回 null（按「没有覆盖」处理，不让调用方起不来）。 */
export function readOverride(root, name) {
  const file = overridePath(root, name);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const warned = new Set();
function warnOnce(log, msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  try { log(msg); } catch {}
}

/**
 * 生效的 agent.cordis.yml 文本：出厂原文；有覆盖则用 renderPresetPromptYaml 替换 persona.prefix。
 * 覆盖套不上（出厂结构变了、覆盖不再满足安全不变量）→ 告警一次、退回出厂原文：
 * 宁可暂时用出厂提示词，也不能让 preset 生成失败、DSH 起不来。
 * 出厂文件读不到照样抛错（那是仓库坏了，不是覆盖层的问题）。
 */
export function effectivePresetYaml(root, name, { log = console.warn } = {}) {
  const text = fs.readFileSync(factoryPresetYamlPath(root, name), 'utf8');
  const override = readOverride(root, name);
  if (override === null) return text;
  try {
    return renderPresetPromptYaml(text, override, presetKind(name));
  } catch (error) {
    warnOnce(log, `⚠️ ${name} 的仿真提示词覆盖（state/preset-overrides/）套不上出厂预设，暂按出厂版本生成：${error?.message ?? error}`);
    return text;
  }
}

export function writeOverride(root, name, content) {
  const file = overridePath(root, name);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, String(content ?? ''), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return file;
}

export function removeOverride(root, name) {
  const file = overridePath(root, name);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed;
}
