#!/usr/bin/env node
// 判读评估集：抽候选 + 逐条标注（PERSONA_PATCH，子项目 1 任务 10 预备）。
//
// 候选来自影子期的判读日志（appraisals/<会话>/*.jsonl，只有 msgId 和判读结果）按 msgId 回连聊天存档取原文，
// 再按 kind 分层抽；真骂太少时，从存档里按骂人词补几条（日志里没判过的，多半是群里攒批判读的）。
// 输出 state/persona/eval/cases.jsonl（含聊天原文：目录 700、文件 600，不入 git、不外发）。
// expected 留空，等用户在终端里逐条标注；eval-persona-appraisal.mjs 只算已标注的。
//
// 用法（在远程机 ~/qq-bridge 下）：
//   node scripts/persona-eval-cases.mjs sample [--n 30] [--force]   # 抽候选；已有 cases.jsonl 时不覆盖，除非 --force
//   node scripts/persona-eval-cases.mjs label                       # 逐条标注（交互式，要在真终端里跑）
//   node scripts/persona-eval-cases.mjs stats                       # 只打印分布，不打印原文
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { KINDS } from '../src/persona-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const EVAL_DIR = path.join(STATE, 'persona', 'eval');
const CASES = path.join(EVAL_DIR, 'cases.jsonl');
const args = process.argv.slice(2);
const cmd = args[0] ?? 'stats';
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);

function roleName() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, 'current-role.json'), 'utf8')).role || 'default'; } catch { return 'default'; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readCases() { return readJsonl(CASES); }

function writeCases(cases) {
  fs.mkdirSync(EVAL_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(EVAL_DIR, 0o700);
  const tmp = `${CASES}.tmp`;
  fs.writeFileSync(tmp, cases.map((c) => JSON.stringify(c)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CASES);
  fs.chmodSync(CASES, 0o600);
}

// 会话目录名：appraisals 与 archive 用同一种写法（group_200000001 / private_100000001）。
function archiveRows(dirName) {
  const dir = path.join(STATE, 'long-memory', 'archive', dirName);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const rows = [];
  for (const f of files) for (const r of readJsonl(path.join(dir, f))) if (!r.deleted) rows.push(r);
  return rows;
}

// 和线上一样：最近 6 句，自己的话记成「我」。
function contextOf(rows, i) {
  return rows.slice(Math.max(0, i - 6), i).map((r) => `${r.dir === 'out' ? '我' : (r.name || '对方')}：${String(r.text ?? '').slice(0, 200)}`);
}

// 只用来补候选，不是判读规则（判读规则在 src/persona-appraisal.js，这里不 import 它的私有表）。
const INSULT_HINT_RE = /傻[逼比bB]|\bsb\b|滚|废物|垃圾|蠢货|智障|去死|闭嘴|恶心|菜鸡|笨蛋|你好菜|真菜/i;

function sample() {
  if (fs.existsSync(CASES) && !args.includes('--force')) {
    console.error(`已有 ${path.relative(ROOT, CASES)}（${readCases().length} 条），不覆盖；要重抽加 --force（会丢掉已有标注）`);
    process.exit(1);
  }
  const n = Math.max(5, Number(opt('--n', 30)) || 30);
  const role = roleName();
  const apprRoot = path.join(STATE, 'persona', role, 'appraisals');
  let convs = [];
  try { convs = fs.readdirSync(apprRoot); } catch {}
  const pool = [];
  const seen = new Set();
  const rowCache = new Map();
  for (const conv of convs) {
    const rows = archiveRows(conv);
    rowCache.set(conv, rows);
    const byMsg = new Map(rows.map((r, i) => [String(r.msgId ?? ''), i]));
    const files = fs.readdirSync(path.join(apprRoot, conv)).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      for (const a of readJsonl(path.join(apprRoot, conv, f))) {
        if (a.msgId == null) continue; // 群气氛合批、系统事件：没有单条原文
        const i = byMsg.get(String(a.msgId));
        if (i == null) continue; // 存档里删掉了
        const r = rows[i];
        if (r.dir !== 'in' || !String(r.text ?? '').trim()) continue;
        const id = `${conv}#${a.msgId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        pool.push({
          id, conv, msgId: a.msgId, t: r.t, speaker: r.name || '对方', text: String(r.text), context: contextOf(rows, i),
          directed: conv.startsWith('private_') || a.target === 'me',
          shadow: { kind: a.kind, target: a.target, source: a.source, label: a.label ?? '' },
          expected: null
        });
      }
    }
  }
  // 分层：每个 kind 先拿一份保底，剩下的名额按 kind 轮流补。
  const byKind = new Map();
  for (const c of pool) {
    if (!byKind.has(c.shadow.kind)) byKind.set(c.shadow.kind, []);
    byKind.get(c.shadow.kind).push(c);
  }
  for (const list of byKind.values()) list.sort(() => Math.random() - 0.5);
  const picked = [];
  const kinds = [...byKind.keys()];
  while (picked.length < n && kinds.some((k) => byKind.get(k).length)) {
    for (const k of kinds) {
      const list = byKind.get(k);
      if (list.length && picked.length < n) picked.push(list.shift());
    }
  }
  // 骂 / 玩笑损是复盘重点：日志里的真骂太少，就从存档里按骂人词补，最多补到 8 条或总数的 1/4。
  const want = Math.min(8, Math.ceil(n / 4));
  const extra = [];
  const tagged = picked.filter((c) => ['insult', 'tease'].includes(c.shadow.kind)).length;
  if (tagged < want * 2) {
    for (const [conv, rows] of rowCache) {
      rows.forEach((r, i) => {
        const id = `${conv}#${r.msgId ?? `t${r.t}`}`;
        if (r.dir !== 'in' || seen.has(id) || !INSULT_HINT_RE.test(String(r.text ?? ''))) return;
        extra.push({
          id, conv, msgId: r.msgId ?? null, t: r.t, speaker: r.name || '对方', text: String(r.text), context: contextOf(rows, i),
          directed: conv.startsWith('private_'), shadow: null, expected: null
        });
      });
    }
    extra.sort(() => Math.random() - 0.5);
  }
  const cases = [...picked, ...extra.slice(0, Math.max(0, want * 2 - tagged))];
  cases.sort((a, b) => a.t - b.t);
  writeCases(cases);
  console.log(`候选 ${cases.length} 条（判读日志可回连 ${pool.length} 条，按骂人词补 ${cases.filter((c) => !c.shadow).length} 条）→ ${path.relative(ROOT, CASES)}（600）`);
  stats();
}

function stats() {
  const cases = readCases();
  const count = (f) => cases.reduce((m, c) => { const k = f(c); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  console.log(`共 ${cases.length} 条，已标注 ${cases.filter((c) => c.expected?.kind).length} 条`);
  console.log('影子判读 kind：', JSON.stringify(count((c) => c.shadow?.kind ?? '(补充)')));
  console.log('影子判读来源：', JSON.stringify(count((c) => c.shadow?.source ?? '(补充)')));
  console.log('会话：', JSON.stringify(count((c) => c.conv)));
  const labeled = cases.filter((c) => c.expected?.kind);
  if (labeled.length) {
    console.log('标注 kind：', JSON.stringify(count((c) => c.expected?.kind ?? '-')));
    const agree = labeled.filter((c) => c.shadow && c.shadow.kind === c.expected.kind).length;
    const withShadow = labeled.filter((c) => c.shadow).length;
    if (withShadow) console.log(`影子判读与标注一致：${agree} / ${withShadow}`);
  }
}

const TARGET_KEYS = { m: 'me', o: 'other', n: 'none' };

async function label() {
  const cases = readCases();
  if (!cases.length) { console.error('没有候选，先跑 sample'); process.exit(1); }
  if (!process.stdin.isTTY) { console.error('label 要在真终端里跑（ssh 后直接执行），不要接管道'); process.exit(1); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const kindMenu = KINDS.map((k, i) => `${i}=${k}`).join('  ');
  console.log('\n逐条标注「这句话对她来说是什么」。每条输入：');
  console.log('  回车          = 同意影子判读（补充的那几条没有影子判读，必须选）');
  console.log(`  数字 [m|o|n]  = 选 kind，可再跟 target（m=冲她 o=冲别人 n=无）：${kindMenu}`);
  console.log('  d = 切换「是否冲她说」   s = 跳过   b = 上一条   q = 保存退出\n');
  let i = cases.findIndex((c) => !c.expected?.kind);
  if (i < 0) i = 0;
  while (i < cases.length) {
    const c = cases[i];
    console.log(`\n—— ${i + 1} / ${cases.length} · ${c.conv} · ${new Date(c.t).toLocaleString('zh-CN', { hour12: false })}`);
    for (const l of c.context) console.log(`   ${l}`);
    console.log(`>> ${c.speaker}：${c.text}`);
    console.log(`   冲她说：${c.directed ? '是' : '否'}   影子判读：${c.shadow ? `${c.shadow.kind} / ${c.shadow.target}（${c.shadow.source}${c.shadow.label ? ' · ' + c.shadow.label : ''}）` : '（无）'}${c.expected?.kind ? `   已标：${c.expected.kind} / ${c.expected.target ?? '-'}` : ''}`);
    const ans = (await rl.question('标注> ')).trim().toLowerCase();
    if (ans === 'q') break;
    if (ans === 's') { i++; continue; }
    if (ans === 'b') { i = Math.max(0, i - 1); continue; }
    if (ans === 'd') { c.directed = !c.directed; writeCases(cases); continue; }
    if (ans === '') {
      if (!c.shadow) { console.log('   这条没有影子判读，请输入数字'); continue; }
      c.expected = { kind: c.shadow.kind, target: c.shadow.target };
    } else {
      const [k, t] = ans.split(/\s+/);
      const kind = KINDS[Number(k)];
      if (!/^\d+$/.test(k) || !kind) { console.log('   没看懂，再输一次'); continue; }
      const target = TARGET_KEYS[t] ?? c.expected?.target ?? c.shadow?.target ?? (c.directed ? 'me' : 'none');
      c.expected = { kind, target };
    }
    writeCases(cases); // 每条都落盘，中途退出不丢
    i++;
  }
  rl.close();
  stats();
}

if (cmd === 'sample') sample();
else if (cmd === 'label') await label();
else stats();
