// plugins/qq-agent-presets/qq-persona-context.mjs 的单测（PERSONA_PATCH，子项目 1 任务 11）。假 ctx，不需要 DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, createLiveReader, contextText, coreText, inject, name } from '../plugins/qq-agent-presets/qq-persona-context.mjs';

let failures = 0;
async function test(label, run) {
  try { await run(); console.log('PASS', label); }
  catch (error) { failures++; console.error('FAIL', label, '—', error?.stack ?? error); }
}

const LIVE = { version: 1, core: '【你现在的性格】开放偏高', sessions: { 'session-a': 'private:1', 'session-b': 'group:2' }, byKey: { 'private:1': '【你此刻】有点委屈', 'group:2': '【你此刻】整体心情平平' } };

function withLive(obj, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-ctx-'));
  const file = path.join(dir, 'live.json');
  if (obj) fs.writeFileSync(file, JSON.stringify(obj));
  try { return run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

await test('导出名与依赖服务', () => {
  assert.equal(name, 'qq-persona-context');
  assert.deepEqual(inject, ['systemPrompt']);
});

await test('contextText / coreText：按会话 ID 找到对应 QQ 会话；未知会话或坏数据返回空串', () => {
  assert.equal(contextText(LIVE, 'session-a'), '【你此刻】有点委屈');
  assert.equal(contextText(LIVE, 'session-x'), '');
  assert.equal(contextText(LIVE, undefined), '');
  assert.equal(contextText(null, 'session-a'), '');
  assert.equal(coreText(LIVE), '【你现在的性格】开放偏高');
  assert.equal(coreText({ core: 5 }), '');
});

await test('createLiveReader：文件不存在返回 null；内容变了能读到新的', () => withLive(null, (file) => {
  const read = createLiveReader(file);
  assert.equal(read(), null);
  fs.writeFileSync(file, JSON.stringify(LIVE));
  assert.equal(read().core, LIVE.core);
  fs.writeFileSync(file, JSON.stringify({ ...LIVE, core: '变了，长度也变了' }));
  assert.equal(read().core, '变了，长度也变了');
  fs.writeFileSync(file, '{坏 json');
  assert.equal(read(), null);
}));

await test('apply：注册一个 section 和一个 context；context 用 assembly.agent.id 取当前会话', () => withLive(LIVE, (file) => {
  const reg = { sections: [], contexts: [] };
  const ctx = { systemPrompt: { section: (s) => reg.sections.push(s), context: (c) => reg.contexts.push(c) } };
  const diagFile = path.join(path.dirname(file), 'plugin.log');
  apply(ctx, { liveFile: file, diagFile });
  assert.equal(reg.sections.length, 1);
  assert.equal(reg.contexts.length, 1);
  assert.equal(reg.sections[0].interpolate, false);
  assert.equal(reg.sections[0].text({}), LIVE.core);
  assert.equal(reg.contexts[0].text({ agent: { id: 'session-b' } }), '【你此刻】整体心情平平');
  assert.equal(reg.contexts[0].text({}), '');
  assert.match(fs.readFileSync(diagFile, 'utf8'), /agent\.id 为空/);
}));

if (failures) { console.error(`\n${failures} 个用例失败`); process.exitCode = 1; }
else console.log('\n全部通过');
