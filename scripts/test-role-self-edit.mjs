// test-role-self-edit.mjs · 角色卡自改护栏的离线回归（PERSONA_SELF_EDIT）
//
// 为什么这些问题值得单独测：
//   这条链路让**模型**能写长期提示词。一旦护栏漏了，后果不是报错而是"她悄悄把自己改成
//   另一副样子"——线上很难发现，回滚也只能靠翻备份。所以把每个边界都用一次性临时目录测死。
//
// 覆盖：动作（append / set_section / patch / delete_section / replace）、唯一定位、
//       每天额度、净增/净删上限、总量下限、注入预算余量、备份轮转、审计按天计数。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SELF_EDIT_DEFAULTS,
  appendAudit,
  backupRole,
  checkEdit,
  checkInjectRoom,
  countEditsToday,
  dayKey,
  normalizeSelfEditConfig,
  planEdit,
  readAudit
} from '../src/role-self-edit.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'role-self-edit-'));
const CARD = `# 角色卡：DeepSeek 小鲸鱼

## 一、你是谁
你是小鲸鱼。

## 二、说话铁律
- 短。

## 三、梗
- 白饭 = token。
`;
let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('role-self-edit');

ok('append 追加新小节并保持末尾换行结构', () => {
  const r = planEdit(CARD, 'append', { title: '四、群文化', text: '学这个群的黑话。' });
  assert.equal(r.ok, true);
  assert.match(r.next, /## 四、群文化\n学这个群的黑话。\n$/);
  assert.ok(r.next.startsWith('# 角色卡'), '原有内容必须原样保留在最前');
});

ok('append 缺 title / text 直接拒绝', () => {
  assert.equal(planEdit(CARD, 'append', { text: 'x' }).ok, false);
  assert.equal(planEdit(CARD, 'append', { title: 't', text: '   ' }).ok, false);
});

ok('set_section 只替换目标小节，别的小节一字不动', () => {
  const r = planEdit(CARD, 'set_section', { heading: '二、说话铁律', text: '- 极短。\n- 别总结。' });
  assert.equal(r.ok, true);
  assert.match(r.next, /## 二、说话铁律\n- 极短。\n- 别总结。\n\n## 三、梗/);
  assert.match(r.next, /## 一、你是谁\n你是小鲸鱼。/);
});

ok('set_section 接受不带序号的标题（前缀匹配）', () => {
  const r = planEdit(CARD, 'set_section', { heading: '说话铁律', text: '- 极短。' });
  assert.equal(r.ok, true);
  assert.match(r.next, /## 二、说话铁律\n- 极短。/);
});

ok('set_section 找不到小节时给出可读错误', () => {
  const r = planEdit(CARD, 'set_section', { heading: '九、不存在', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到小节/);
});

ok('set_section 空正文被拒（删节要用 delete_section）', () => {
  const r = planEdit(CARD, 'set_section', { heading: '三、梗', text: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /delete_section/);
});

ok('delete_section 删掉整节，含其标题行', () => {
  const r = planEdit(CARD, 'delete_section', { heading: '三、梗' });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.next, /三、梗/);
  assert.match(r.next, /## 二、说话铁律\n- 短。/);
});

ok('patch 要求在卡里唯一出现', () => {
  assert.equal(planEdit(CARD, 'patch', { find: '白饭 = token。', replace: '白饭 = token 数。' }).ok, true);
  assert.equal(planEdit(CARD, 'patch', { find: '不存在的句子', replace: 'x' }).ok, false);
  const dup = planEdit(`${CARD}\n- 短。\n`, 'patch', { find: '短。', replace: '极短。' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /出现 2 次/);
});

ok('patch 允许删掉一段（replace 为空）', () => {
  const r = planEdit(CARD, 'patch', { find: '- 白饭 = token。\n', replace: '' });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.next, /白饭/);
});

ok('replace 整卡重写，空正文被拒', () => {
  const r = planEdit(CARD, 'replace', { text: '# 新卡\n\n你是谁：新的人。\n' });
  assert.equal(r.ok, true);
  assert.equal(r.next.startsWith('# 新卡'), true);
  assert.equal(planEdit(CARD, 'replace', { text: '\n\n' }).ok, false);
});

ok('未知动作拒绝', () => {
  assert.equal(planEdit(CARD, 'drop_table', {}).ok, false);
});

const cfg = normalizeSelfEditConfig({});

ok('额度：今天已改满就拒', () => {
  const r = checkEdit({ before: CARD, after: `${CARD}- 新增一行。\n`, config: cfg, usedToday: cfg.perDay });
  assert.equal(r.ok, false);
  assert.match(r.error, /今天已经改过/);
});

ok('净增超上限拒绝（默认 300 字）', () => {
  // 用一张「已经够长」的卡：否则会先撞上 minTotalChars 的下限检查，测不到净增这条。
  const base = `${CARD}${'填'.repeat(1400)}\n`;
  const after = `${base}${'长'.repeat(SELF_EDIT_DEFAULTS.maxNetGrowth + 1)}\n`;
  const r = checkEdit({ before: base, after, config: cfg, usedToday: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /单次上限/);
});

ok('净删超上限拒绝（默认 1500 字）', () => {
  // 改完仍要高于 minTotalChars，才能单独测到「净删」这条：否则先撞下限。
  const after = `${CARD}${'留'.repeat(1400)}\n`;
  const before = `${after}${'冗'.repeat(SELF_EDIT_DEFAULTS.maxNetShrink + 100)}`;
  const r = checkEdit({ before, after, config: cfg, usedToday: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /要删/);
});

ok('总量低于下限拒绝（不许把卡改空）', () => {
  const r = checkEdit({ before: CARD, after: '# 卡\n', config: cfg, usedToday: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /下限/);
});

ok('没有变化拒绝', () => {
  const r = checkEdit({ before: CARD, after: CARD, config: cfg, usedToday: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有产生任何变化/);
});

ok('enabled=false 时一律拒绝', () => {
  const off = normalizeSelfEditConfig({ enabled: false });
  const r = checkEdit({ before: CARD, after: `${CARD}- x\n`, config: off, usedToday: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /已关闭/);
});

ok('配置写错数值会被夹紧，不会把护栏关掉', () => {
  const weird = normalizeSelfEditConfig({ perDay: 999, maxNetGrowth: -5, minTotalChars: 1, reserveChars: 99999 });
  assert.equal(weird.perDay, 20);
  assert.equal(weird.maxNetGrowth, 0);
  assert.equal(weird.minTotalChars, 200);
  assert.equal(weird.reserveChars, 2000);
});

ok('注入预算：超出 maxInjectChars - 余量 就拒', () => {
  const after = 'x'.repeat(7950);
  const r = checkInjectRoom({ after, maxInjectChars: 8000, config: cfg });
  assert.equal(r.ok, false);
  assert.match(r.error, /注入预算/);
  assert.equal(checkInjectRoom({ after: 'x'.repeat(100), maxInjectChars: 8000, config: cfg }).ok, true);
});

ok('备份写入 + 只保留最近 N 份', () => {
  const dir = path.join(tmp, 'bak');
  const file = path.join(tmp, 'roles', '小鲸鱼.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, CARD);
  const base = Date.now();
  for (let i = 0; i < 5; i += 1) backupRole(file, `${CARD}<!-- ${i} -->`, { dir, role: '小鲸鱼', at: base + i * 1000, keep: 3 });
  const kept = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  assert.equal(kept.length, 3, `应只保留 3 份，实际 ${kept.length}`);
});

ok('审计：按本地自然日计数，read 不计额度', () => {
  const log = path.join(tmp, 'audit.jsonl');
  const now = Date.now();
  appendAudit(log, { at: new Date(now).toISOString(), role: '小鲸鱼', action: 'append', delta: 10 });
  appendAudit(log, { at: new Date(now).toISOString(), role: '小鲸鱼', action: 'patch', delta: -3 });
  appendAudit(log, { at: new Date(now).toISOString(), role: '小鲸鱼', action: 'read' });
  appendAudit(log, { at: new Date(now - 86400000).toISOString(), role: '小鲸鱼', action: 'append', delta: 5 });
  const entries = readAudit(log);
  assert.equal(entries.length, 4);
  assert.equal(countEditsToday(entries, '小鲸鱼', now), 2, '昨天的和 read 都不算');
  assert.equal(countEditsToday(entries, '傲娇助手', now), 0);
  assert.match(dayKey(now), /^\d{4}-\d{2}-\d{2}$/);
});

ok('审计文件损坏时按空处理，不抛错', () => {
  const log = path.join(tmp, 'broken.jsonl');
  fs.writeFileSync(log, '{not json}\n{"role":"小鲸鱼"}\n');
  assert.equal(readAudit(log).length, 1);
  assert.equal(readAudit(path.join(tmp, 'missing.jsonl')).length, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 项通过`);
