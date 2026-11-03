// 实时脑图（BRAIN_PATCH）：轨迹文件 state/brain/trace/<日期>.jsonl 的测试。
//
// 轨迹只许有编号和数字（约定 §6）：这里构造带原文、query、keywords、名字、令牌字样的事件，
// 断言文件里一个字都没有；再测权限、7 天清理、写失败不抛且只告警一次、开关关着不写、msg.* 不写。
// 全部在 /tmp 临时目录里跑，不碰真实 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrainFeed, filterTraceRecord, localDay } from '../src/brain-feed.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-brain-trace-'));
const newStateDir = () => fs.mkdtempSync(path.join(tmpRoot, 's-'));
const traceDirOf = (stateDir) => path.join(stateDir, 'brain', 'trace');
function readTrace(stateDir) {
  const dir = traceDirOf(stateDir);
  if (!fs.existsSync(dir)) return { text: '', rows: [] };
  const text = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
  return { text, rows: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const SECRETS = ['她喜欢吃火锅', '上周去了哪里', '火锅', '麻辣', '小明', 'tok-ABCDEF123456', '/home/someone', '令牌'];

await test('轨迹里一个原文 / query / keywords / 名字 / 令牌字样都没有（含白名单外字段、伪装成枚举的原文）', async () => {
  const stateDir = newStateDir();
  const feed = createBrainFeed({ stateDir });
  feed.emit('search', {
    key: 'private:100000001', origin: 'ai', nodes: ['chunk:c1', 'sum:s1'],
    n: { ms: 182, items: 3, rank: [1, 2, 3], query: '上周去了哪里', text: 5 },
    e: { src: 'rag', semantic: 'ok', query: '上周去了哪里', kind: '她喜欢吃火锅', tool: 'TOKEN tok-ABCDEF123456' },
    query: '上周去了哪里', keywords: ['火锅', '麻辣'], name: '小明', token: 'tok-ABCDEF123456',
    data: { query: '上周去了哪里', keywords: ['火锅', '麻辣'], items: [{ line: '她喜欢吃火锅' }] }
  });
  feed.emit('remember', { key: 'private:1', nodes: ['ltm:abc'], e: { kind: 'fact' }, text: '她喜欢吃火锅', data: { text: '她喜欢吃火锅', name: '小明' } });
  feed.emit('persona.appraisal', { key: 'private:1', nodes: ['persona:rel:1', 'msg:/home/someone'], n: { intensity: 0.4, salience: 0.6 }, e: { kind: 'tease', source: 'model', inject: true }, data: { label: '害羞' } });
  feed.emit('tool', { key: 'private:1', tool: 'qq_send_message', e: { tool: 'qq_send_message', status: 'ok' }, data: { name: 'qq_send_message' } });
  const { text, rows } = readTrace(stateDir);
  for (const s of SECRETS) assert.ok(!text.includes(s), `轨迹里不该出现「${s}」：${text}`);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    id: 1, at: rows[0].at, type: 'search', key: 'private:100000001', origin: 'ai',
    nodes: ['chunk:c1', 'sum:s1'], n: { ms: 182, items: 3, rank: [1, 2, 3] }, e: { src: 'rag', semantic: 'ok' }
  });
  assert.deepEqual(rows[1].e, { kind: 'fact' });
  assert.deepEqual(rows[2].nodes, ['persona:rel:1'], '含路径的编号被丢');
  assert.deepEqual(rows[2].e, { kind: 'tease', source: 'model', inject: true });
  assert.deepEqual(rows[3].e, { tool: 'qq_send_message', status: 'ok' });
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).filter((k) => !['id', 'at', 'type', 'key', 'origin', 'nodes', 'n', 'e', 'shadow'].includes(k)), [], '顶层只有白名单字段');
  }
});

await test('filterTraceRecord：非法 key / 编号 / 类型 / origin 被丢；缺 id / at 整行丢', async () => {
  const base = { id: 3, at: 1762070400000, type: 'recall' };
  assert.equal(filterTraceRecord({ ...base, id: '3' }), null);
  assert.equal(filterTraceRecord({ ...base, at: 1.5 }), null);
  assert.equal(filterTraceRecord({ ...base, type: 'evil' }), null);
  assert.equal(filterTraceRecord({ ...base, type: 'msg.in' }), null, 'msg.* 不写轨迹');
  assert.equal(filterTraceRecord(null), null);
  const r = filterTraceRecord({
    ...base, key: 'private:12a', origin: 'hacker', shadow: 'yes',
    nodes: ['ltm:ok_1', 'ltm:' + 'x'.repeat(81), 'ltm:has space', 'evil:1', 42, 'note:n-1.2'],
    n: { ms: Infinity, items: NaN, score: '3', tau: 0.5, rank: [1, 'a'] },
    e: { src: 'RAG', semantic: 'ok', pass: true, reason: 'x'.repeat(33) }
  });
  assert.deepEqual(r, { ...base, key: null, nodes: ['ltm:ok_1', 'note:n-1.2'], n: { tau: 0.5 }, e: { semantic: 'ok', pass: true } });
  const sixty = Array.from({ length: 60 }, (_, i) => `msg:${i}`);
  assert.equal(filterTraceRecord({ ...base, nodes: sixty }).nodes.length, 50);
  assert.deepEqual(filterTraceRecord({ ...base, shadow: true, key: 'group:456' }), { ...base, key: 'group:456', nodes: [], shadow: true });
});

// BRAIN_PATCH（返工 A2）：inject 的 recall / suggest 两个布尔要进轨迹的 e（回放从这里读），其它未知键照样被丢。
await test('inject 事件：e.recall / e.suggest 写进轨迹，其它未知键照样被丢', async () => {
  const stateDir = newStateDir();
  const feed = createBrainFeed({ stateDir });
  feed.emit('inject', {
    key: 'private:100000001', origin: 'bridge', nodes: ['ltm:abc'], n: { chars: 120, items: 1 },
    e: { recall: true, suggest: false, evil: true, query: 'ok' },
    data: { ltm: ['ltm:abc'], recall: true, suggest: false, chars: 120 }
  });
  feed.emit('inject', { key: 'private:1', origin: 'bridge', nodes: [], e: { recall: false, suggest: 'yes-1', note: '她喜欢吃火锅' } });
  const { text, rows } = readTrace(stateDir);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].e, { recall: true, suggest: false });
  assert.deepEqual(rows[1].e, { recall: false, suggest: 'yes-1' });
  assert.ok(!text.includes('evil') && !text.includes('她喜欢吃火锅') && !text.includes('query'), `未知键不该进轨迹：${text}`);
});

await test('目录 700、文件 600；按本地日期分文件', async () => {
  const stateDir = newStateDir();
  const feed = createBrainFeed({ stateDir });
  feed.emit('wake', { key: 'private:1', e: { reason: 'message' } });
  const dir = traceDirOf(stateDir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, 'brain')).mode & 0o777, 0o700);
  const file = path.join(dir, `${localDay(Date.now())}.jsonl`);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

await test('msg.in / msg.out 不写轨迹；开关关着什么都不写', async () => {
  const stateDir = newStateDir();
  let on = true;
  const feed = createBrainFeed({ stateDir, isEnabled: () => on });
  feed.emit('msg.in', { key: 'private:1', nodes: ['msg:1'], data: { text: '你好' } });
  feed.emit('msg.out', { key: 'private:1', nodes: ['msg:2'], data: { text: '在呢' } });
  assert.equal(readTrace(stateDir).rows.length, 0);
  on = false;
  feed.emit('remember', { key: 'private:1', nodes: ['ltm:a'] });
  assert.equal(readTrace(stateDir).rows.length, 0);
  on = true;
  feed.emit('remember', { key: 'private:1', nodes: ['ltm:a'] });
  assert.equal(readTrace(stateDir).rows.length, 1);
  // 脑区计数里 msg.* 照样算（快照的 regions 用）
  const counts = feed.regionCounts();
  assert.equal(counts.input, 1);
  assert.equal(counts.output, 1);
  assert.equal(counts.hippo, 1);
});

await test('7 天清理：创建时删掉 7 天前的，留下今天往前 6 天；不认识的文件不动', async () => {
  const stateDir = newStateDir();
  const dir = traceDirOf(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const dayAgo = (n) => { const d = new Date(now); return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime()); };
  for (const n of [0, 1, 6, 7, 8, 30]) fs.writeFileSync(path.join(dir, `${dayAgo(n)}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, 'README.txt'), 'keep');
  const feed = createBrainFeed({ stateDir });
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, [...[6, 1, 0].map((n) => `${dayAgo(n)}.jsonl`), 'README.txt'].sort());
  // 时间往后推 2 天再清一次
  let fake = now + 2 * 86400000;
  const later = createBrainFeed({ stateDir, now: () => fake });
  assert.ok(!fs.existsSync(path.join(dir, `${dayAgo(6)}.jsonl`)));
  assert.ok(fs.existsSync(path.join(dir, `${dayAgo(0)}.jsonl`)));
  assert.equal(later.cleanupTrace(), 0);
  void feed;
});

await test('写失败（目录不可写 / 是文件）不抛，只告警一次', async () => {
  const stateDir = newStateDir();
  // brain/trace 放成一个文件：mkdir / append 必然失败（root 也绕不过去）
  fs.mkdirSync(path.join(stateDir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'brain', 'trace'), 'not a dir');
  const logs = [];
  const feed = createBrainFeed({ stateDir, log: (m) => logs.push(m) });
  for (let i = 0; i < 5; i += 1) assert.doesNotThrow(() => feed.emit('recall', { key: 'private:1', nodes: ['ltm:a'] }));
  assert.equal(logs.filter((l) => l.includes('写轨迹')).length, 1, `只告警一次：${JSON.stringify(logs)}`);
  for (const l of logs) assert.ok(!l.includes('private:1'));

  const roDir = newStateDir();
  fs.mkdirSync(traceDirOf(roDir), { recursive: true });
  fs.chmodSync(traceDirOf(roDir), 0o500);
  const logs2 = [];
  const feed2 = createBrainFeed({ stateDir: roDir, log: (m) => logs2.push(m) });
  assert.doesNotThrow(() => { feed2.emit('recall', { key: 'private:1' }); feed2.emit('recall', { key: 'private:1' }); });
  // root 跑测试时只读目录挡不住写入：那种情况下不要求告警
  if (process.getuid?.() !== 0) assert.equal(logs2.filter((l) => l.includes('写轨迹')).length, 1);
  fs.chmodSync(traceDirOf(roDir), 0o700);
});

await test('重启后脑区计数从今天的轨迹补回', async () => {
  const stateDir = newStateDir();
  const a = createBrainFeed({ stateDir });
  a.emit('search', { key: 'private:1' });
  a.emit('tool', { key: 'private:1', tool: 'qq_tts_voice', e: { tool: 'qq_tts_voice' } });
  const b = createBrainFeed({ stateDir });
  const c = b.regionCounts();
  assert.equal(c.core, 1);
  assert.equal(c.audio, 1);
  assert.equal(b.lastId(), 0, '新进程 id 从 1 开始（不续号）');
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
