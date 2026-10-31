#!/usr/bin/env node
// 探针：核对情绪判读要用的 DeepSeek 接口（PERSONA_PATCH，子项目 1 任务 0）。
//   ① GET /models 列出可用模型名（决定 settings.appraisal.model）；
//   ② 用一条合成消息走一次真实判读，确认 JSON 模式、usage 里的缓存字段、归一化结果。
// 密钥只从 state/persona/config.json 的 apiKey 读（先在控制台「人格与情绪」页填写）——
// 不读环境变量：2026-10-29 本机 shell 里恰好有 DEEPSEEK_API_KEY，探针在用户不知情时用了它。不打印密钥。
// 用法：node scripts/probe-persona-deepseek.mjs [模型名]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSettings } from '../src/persona-state.js';
import { createDeepSeekClient, buildMessages, normalizeAppraisal } from '../src/persona-appraisal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'persona', 'config.json'), 'utf8')); } catch {}
const key = String(cfg.apiKey || '');
if (!key) { console.error('没有密钥：先在控制台「人格与情绪」页填写判读密钥'); process.exit(1); }
const base = mergeSettings(cfg.settings ?? {});
const model = process.argv[2] || base.appraisal.model;

const res = await fetch(`${base.appraisal.baseUrl.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
console.log(`GET /models → HTTP ${res.status}`);
if (res.ok) console.log('可用模型：', ((await res.json())?.data ?? []).map((m) => m.id).join(', '));

const settings = () => mergeSettings({ ...(cfg.settings ?? {}), appraisal: { ...(cfg.settings?.appraisal ?? {}), model, timeoutMs: 20000 } });
const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => key });
const t = Date.now();
try {
  const { json, usage } = await client.chatJson(buildMessages({ persona: '傲娇嘴硬，心软', emotion: '整体心情平平', speaker: '阿青', context: ['阿青：在吗', '我：干嘛'], text: '你今天怎么这么菜啊哈哈哈' }));
  console.log(`判读用时 ${Date.now() - t} ms，模型 ${model}`);
  console.log('usage：', JSON.stringify(usage));
  console.log('原始 JSON：', JSON.stringify(json));
  console.log('归一化：', JSON.stringify(normalizeAppraisal(json)));
  console.log(normalizeAppraisal(json) ? '✅ 可用' : '❌ 字段不合法，检查模型或提示词');
} catch (error) {
  console.error(`❌ 判读失败：${error?.message ?? error}`);
  // 排查用：直接看一眼原始回复的形状（合成消息，不含聊天原文）
  const raw = await fetch(`${base.appraisal.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: buildMessages({ speaker: '阿青', text: '你今天怎么这么菜啊哈哈哈' }), response_format: { type: 'json_object' }, max_tokens: 1500, stream: false }),
    signal: AbortSignal.timeout(20000)
  }).then((r) => r.json()).catch((e) => ({ error: String(e?.message ?? e) }));
  const c = raw?.choices?.[0];
  console.error('finish_reason：', c?.finish_reason, '｜正文前 300 字：', JSON.stringify(String(c?.message?.content ?? '').slice(0, 300)), '｜有思考内容：', !!c?.message?.reasoning_content, raw?.error ? `｜错误：${JSON.stringify(raw.error)}` : '');
  process.exit(1);
}
