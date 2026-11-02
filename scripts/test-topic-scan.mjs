// test-topic-scan.mjs · 话题巡检纯函数单测
//   node scripts/test-topic-scan.mjs
// 覆盖：配置规范化、该不该巡检的每个闸门、批次挑选/截断、提示正文、太水批次判定。
import assert from 'node:assert/strict';
import {
  INTEREST_DEFAULTS,
  normalizeInterestConfig,
  createLedger,
  shouldScan,
  applyScan,
  pickTopicBatch,
  buildTopicScanBlock,
  isTrivialBatch,
  TOPIC_SCAN_REASON,
} from '../src/topic-scan.js';

let pass = 0;
function ok(name, fn) {
  fn();
  pass += 1;
  console.log(`✅ ${name}`);
}

const cfg = normalizeInterestConfig({ enabled: true });

ok('默认关；开必须显式 true', () => {
  assert.equal(normalizeInterestConfig({}).enabled, false);
  assert.equal(normalizeInterestConfig({ enabled: 1 }).enabled, false);
  assert.equal(normalizeInterestConfig({ enabled: true }).enabled, true);
  assert.equal(normalizeInterestConfig(null).enabled, false);
});

ok('坏值全部回落/夹到区间，不炸', () => {
  const c = normalizeInterestConfig({ minMessages: 999, windowMs: -5, cooldownMs: 'x', maxScansPerHour: 1e9 });
  assert.equal(c.minMessages, 40);
  assert.equal(c.windowMs, 5000); // 负数夹到下限，而不是回落默认
  assert.equal(c.cooldownMs, INTEREST_DEFAULTS.cooldownMs); // NaN 回落默认
  assert.equal(c.maxScansPerHour, 120);
});

const msgs = (n, text = '这个话题挺有意思的') =>
  Array.from({ length: n }, (_, i) => ({ sender: `群友${i}`, text, at: 1000 + i }));

ok('条数不够 → wait-more', () => {
  const gate = shouldScan({ buffer: msgs(2), now: 1000, ledger: createLedger(), cfg });
  assert.equal(gate.scan, false);
  assert.equal(gate.why, 'wait-more');
  assert.equal(gate.pending, 2);
});

ok('够条数但太水 → too-shallow', () => {
  const gate = shouldScan({ buffer: msgs(8, '哈'), now: 1000, ledger: createLedger(), cfg });
  assert.equal(gate.scan, false);
  assert.equal(gate.why, 'too-shallow');
});

ok('正常一批 → ok', () => {
  const gate = shouldScan({ buffer: msgs(cfg.minMessages), now: 1_000_000, ledger: createLedger(), cfg });
  assert.equal(gate.scan, true);
  assert.equal(gate.why, 'ok');
});

ok('冷却期内不巡检，过了就放行', () => {
  const ledger = applyScan(createLedger(), 1_000_000, cfg);
  const inside = shouldScan({ buffer: msgs(8), now: 1_000_000 + cfg.cooldownMs - 1, ledger, cfg });
  assert.equal(inside.why, 'cooldown');
  const after = shouldScan({ buffer: msgs(8), now: 1_000_000 + cfg.cooldownMs + 1, ledger, cfg });
  assert.equal(after.scan, true);
});

ok('每小时配额会挡住（冷却已过时）', () => {
  let ledger = createLedger();
  const base = 5_000_000;
  for (let i = 0; i < cfg.maxScansPerHour; i += 1) ledger = applyScan(ledger, base + i * 1000, cfg);
  // 冷却已过（> cooldownMs）但仍在同一小时内 → 只剩配额这道闸
  const gate = shouldScan({ buffer: msgs(8), now: base + cfg.cooldownMs + 60_000, ledger, cfg });
  assert.equal(gate.why, 'hourly-budget');
  // 一小时后配额滚出窗口
  const later = shouldScan({ buffer: msgs(8), now: base + 3_700_000, ledger, cfg });
  assert.equal(later.scan, true);
});

ok('关掉总开关就永远不巡检', () => {
  const gate = shouldScan({ buffer: msgs(50), now: 9e9, ledger: createLedger(), cfg: normalizeInterestConfig({}) });
  assert.equal(gate.why, 'disabled');
});

ok('批次只取最新若干条，单条截断', () => {
  const long = 'x'.repeat(500);
  const buf = [...msgs(20, long)];
  const lines = pickTopicBatch(buf, cfg);
  assert.ok(lines.length <= cfg.maxBatchMessages, `条数 ${lines.length}`);
  for (const l of lines) assert.ok(l.length <= cfg.maxLineChars + 30, `单行 ${l.length}`);
  const total = lines.join('\n').length;
  assert.ok(total <= cfg.maxBatchChars + cfg.maxLineChars, `总量 ${total}`);
});

ok('批次保留最新、丢掉最旧', () => {
  const buf = [
    { sender: 'A', text: '最早的一条旧消息内容' },
    ...msgs(13),
  ];
  const lines = pickTopicBatch(buf, cfg);
  assert.equal(lines.length, cfg.maxBatchMessages);
  assert.ok(!lines.some((l) => l.includes('最早')), '最旧的一条应该被丢掉');
});

ok('提示正文包含原话、且明确允许不接', () => {
  const block = buildTopicScanBlock({ buffer: msgs(7, '新出的那个游戏你玩了吗'), cfg });
  assert.ok(block.includes('新出的那个游戏你玩了吗'));
  assert.ok(block.includes('话题巡检'));
  assert.ok(block.includes('qq_mark_read'));
  assert.ok(/宁可少说/.test(block));
});

ok('空批次不产生提示', () => {
  assert.equal(buildTopicScanBlock({ buffer: [], cfg }), '');
});

ok('太水批次判定：语气词/空 都算水', () => {
  assert.equal(isTrivialBatch([], cfg), true);
  assert.equal(isTrivialBatch(msgs(3, '哈哈哈'), cfg), true);
  assert.equal(isTrivialBatch(msgs(3, '？？？'), cfg), true);
  assert.equal(isTrivialBatch(msgs(3, '我在看那个新番，第三集崩了'), cfg), false);
});

ok('唤醒原因常量与桥接约定一致', () => {
  assert.equal(TOPIC_SCAN_REASON, 'topicScan');
});

console.log(`\n全部通过：${pass} 项`);
