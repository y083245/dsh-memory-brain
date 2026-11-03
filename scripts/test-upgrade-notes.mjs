#!/usr/bin/env node
// UPGRADE_PATCH：scripts/lib/upgrade-notes.mjs 的单测（contract §5）。纯函数，不碰文件系统。
import assert from 'node:assert/strict';
import {
  parseChangelog, collectNotes, fallbackFromDiff, compareVersions, mergeUpgrade, emptyUpgrade, normalizeVersion,
} from './lib/upgrade-notes.mjs';

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n  ${error?.stack ?? error}`);
  }
}

const CHANGELOG = `# 更新日志

写在最前面的说明，不属于任何一版。

## 未发布

- 还没发的东西

## v0.4.0 — 2026-11-10

- 实时脑图
- 控制台新页

\`\`\`upgrade
restart: bridge, memory-rag     # 要重启哪些
deps: npm
setup-dsh: false
systemd: false
migrate: rag-db v2
cost: 无
colour: blue                    # 认不出的键忽略
\`\`\`

## v0.3.1 — 2026-11-03

- 升级脚本

\`\`\`upgrade
restart: dsh, bogus-service
deps:
setup-dsh: true
systemd: yes
migrate: first-run, rag-enabled-fix
cost: 重建摘要约 0.3 元   # 注释
\`\`\`

## v0.3.0 — 2026-11-02

- 首个标签，没有 upgrade 块

## [v0.2.9] - 2026-10-01

\`\`\`upgrade
restart: embedding
\`\`\`
`;

test('parseChangelog：只认版本号标题，按出现顺序', () => {
  const entries = parseChangelog(CHANGELOG);
  assert.deepEqual(entries.map((e) => e.version), ['v0.4.0', 'v0.3.1', 'v0.3.0', 'v0.2.9']);
  assert.equal(entries[0].date, '2026-11-10');
  assert.equal(entries[3].date, '2026-10-01');
});

test('parseChangelog：upgrade 块解析、注释去掉、未知键忽略', () => {
  const [v040] = parseChangelog(CHANGELOG);
  assert.deepEqual(v040.upgrade, {
    restart: ['memory-rag', 'bridge'], deps: ['npm'], setupDsh: false, systemd: false, migrate: ['rag-db v2'], cost: '无',
  });
  assert.ok(!('colour' in v040.upgrade));
  assert.ok(!v040.body.includes('```'), '正文里不含 upgrade 块');
  assert.ok(v040.body.includes('实时脑图'));
});

test('parseChangelog：空值、未知服务名、yes 当 true', () => {
  const v031 = parseChangelog(CHANGELOG)[1];
  assert.deepEqual(v031.upgrade.restart, ['dsh']);
  assert.deepEqual(v031.upgrade.deps, []);
  assert.equal(v031.upgrade.setupDsh, true);
  assert.equal(v031.upgrade.systemd, true);
  assert.deepEqual(v031.upgrade.migrate, ['first-run', 'rag-enabled-fix']);
  assert.equal(v031.upgrade.cost, '重建摘要约 0.3 元');
});

test('parseChangelog：没有 upgrade 块的节 upgrade 为 null', () => {
  const v030 = parseChangelog(CHANGELOG)[2];
  assert.equal(v030.upgrade, null);
  assert.equal(v030.body, '- 首个标签，没有 upgrade 块');
});

test('parseChangelog：一节里有两个块时取最后一个', () => {
  const text = '## v1.0.0\n\n```upgrade\nrestart: dsh\n```\n\n中间\n\n```upgrade\nrestart: bridge\n```\n';
  assert.deepEqual(parseChangelog(text)[0].upgrade.restart, ['bridge']);
});

test('parseChangelog：空文本 / CRLF', () => {
  assert.deepEqual(parseChangelog(''), []);
  const crlf = '## v1.2.3 — 2026-01-01\r\n- a\r\n```upgrade\r\nrestart: bridge\r\n```\r\n';
  const [e] = parseChangelog(crlf);
  assert.equal(e.version, 'v1.2.3');
  assert.deepEqual(e.upgrade.restart, ['bridge']);
});

test('compareVersions：语义版本（v0.10.0 > v0.9.1、预发布更小、有无 v 前缀一样）', () => {
  assert.equal(compareVersions('v0.10.0', 'v0.9.1'), 1);
  assert.equal(compareVersions('v0.9.1', 'v0.10.0'), -1);
  assert.equal(compareVersions('0.3.1', 'v0.3.1'), 0);
  assert.equal(compareVersions('v0.3.1-rc.1', 'v0.3.1'), -1);
  assert.equal(compareVersions('v0.3.1-rc.2', 'v0.3.1-rc.10'), -1);
  assert.equal(compareVersions('v1.0.0', 'v0.99.99'), 1);
  assert.equal(compareVersions('v0.2.1-r1', 'v0.3.0'), -1);
  assert.equal(compareVersions('not-a-version', 'v0.0.1'), -1);
  assert.equal(normalizeVersion('0.3.1'), 'v0.3.1');
  assert.equal(normalizeVersion('main'), null);
});

test('collectNotes：取 (from, to] 区间，新的在前，须知取并集', () => {
  const entries = parseChangelog(CHANGELOG);
  const r = collectNotes(entries, 'v0.3.0', 'v0.4.0');
  assert.deepEqual(r.entries.map((e) => e.version), ['v0.4.0', 'v0.3.1']);
  assert.deepEqual(r.upgrade.restart, ['memory-rag', 'dsh', 'bridge']);
  assert.deepEqual(r.upgrade.deps, ['npm']);
  assert.equal(r.upgrade.setupDsh, true);
  assert.equal(r.upgrade.systemd, true);
  assert.deepEqual(r.upgrade.migrate, ['rag-db v2', 'first-run', 'rag-enabled-fix']);
  assert.equal(r.upgrade.cost, '重建摘要约 0.3 元', '「无」与真实费用合并时只留真实费用');
});

test('collectNotes：from 本身不算、to 本身算；from 为空不设下限；to 为空不设上限', () => {
  const entries = parseChangelog(CHANGELOG);
  assert.deepEqual(collectNotes(entries, 'v0.3.1', 'v0.3.1').entries, []);
  assert.deepEqual(collectNotes(entries, null, 'v0.3.0').entries.map((e) => e.version), ['v0.3.0', 'v0.2.9']);
  assert.deepEqual(collectNotes(entries, 'v0.3.1', null).entries.map((e) => e.version), ['v0.4.0']);
  assert.deepEqual(collectNotes(entries, 'v0.4.0', 'v0.4.0').upgrade, emptyUpgrade());
});

test('collectNotes：按语义版本而不是字符串比较区间', () => {
  const text = '## v0.10.0\n```upgrade\nrestart: dsh\n```\n## v0.9.1\n```upgrade\nrestart: bridge\n```\n## v0.9.0\n';
  const r = collectNotes(parseChangelog(text), 'v0.9.0', 'v0.10.0');
  assert.deepEqual(r.entries.map((e) => e.version), ['v0.10.0', 'v0.9.1']);
  assert.deepEqual(r.upgrade.restart, ['dsh', 'bridge']);
});

const FB = (files) => fallbackFromDiff(files);
test('fallbackFromDiff：src/ → 重启 bridge', () => {
  assert.deepEqual(FB(['src/bridge.js']).restart, ['bridge']);
  assert.equal(FB(['src/bridge.js']).setupDsh, false);
});
test('fallbackFromDiff：public/ → 重启 bridge', () => {
  assert.deepEqual(FB(['public/console.html']).restart, ['bridge']);
});
test('fallbackFromDiff：sidecars/memory-rag/ → 重启 memory-rag', () => {
  assert.deepEqual(FB(['sidecars/memory-rag/memory_rag/app.py']).restart, ['memory-rag']);
});
test('fallbackFromDiff：src/mcp-*.js → 重启 dsh + bridge，setup-dsh', () => {
  const r = FB(['src/mcp-snowluma-safe.js']);
  assert.deepEqual(r.restart, ['dsh', 'bridge']);
  assert.equal(r.setupDsh, true);
});
test('fallbackFromDiff：dsh/ → 重启 dsh，setup-dsh', () => {
  const r = FB(['dsh/agent-presets/qq-chat-v2/agent.cordis.yml']);
  assert.deepEqual(r.restart, ['dsh']);
  assert.equal(r.setupDsh, true);
});
test('fallbackFromDiff：plugins/ → 重启 dsh，setup-dsh', () => {
  const r = FB(['plugins/qq-agent-presets/qq-tool-restrict.mjs']);
  assert.deepEqual(r.restart, ['dsh']);
  assert.equal(r.setupDsh, true);
});
test('fallbackFromDiff：package-lock.json → deps npm（子目录里的不算）', () => {
  assert.deepEqual(FB(['package-lock.json']).deps, ['npm']);
  assert.deepEqual(FB(['docs/package-lock.json']).deps, []);
});
test('fallbackFromDiff：pyproject.toml / uv.lock → deps python', () => {
  assert.deepEqual(FB(['sidecars/memory-rag/pyproject.toml']).deps, ['python']);
  assert.deepEqual(FB(['sidecars/memory-rag/uv.lock']).deps, ['python']);
});
test('fallbackFromDiff：scripts/systemd/ → systemd', () => {
  assert.equal(FB(['scripts/systemd/qq-bridge.service.in']).systemd, true);
  assert.equal(FB(['scripts/update.sh']).systemd, false);
});
test('fallbackFromDiff：只改文档 → 什么都不用做', () => {
  assert.deepEqual(FB(['README.md', 'docs/guides/x.md', '']), emptyUpgrade());
});
test('mergeUpgrade：须知 ∪ 兜底，重启按固定顺序', () => {
  const r = mergeUpgrade({ ...emptyUpgrade(), restart: ['bridge'], cost: '' }, FB(['sidecars/memory-rag/x.py', 'dsh/a']));
  assert.deepEqual(r.restart, ['memory-rag', 'dsh', 'bridge']);
  assert.equal(r.setupDsh, true);
  assert.equal(mergeUpgrade(null, null).cost, '');
});

console.log(`\n${failed ? `${failed} 个失败` : '全部通过'}（${passed} 通过）`);
process.exit(failed ? 1 : 0);
