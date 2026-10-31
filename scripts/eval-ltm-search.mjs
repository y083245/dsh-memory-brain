// 降级关键词检索（src/long-memory.js search）的离线评估（RAG P1 任务 B）。
//
//   node scripts/eval-ltm-search.mjs
//
// 用例：state/long-memory/rag/eval/cases.jsonl（含真实聊天原文，不入 git）。
// 只读真实存档：先把 archive/ 复制到系统临时目录，createLongMemory 指向副本，跑完删掉。
//
// 命中判定与 sidecars/memory-rag/eval/run.py 一致：返回的命中行落在任一期望行区间
// [line_start, line_end] 内（同一文件）就算命中，取第一个命中的排名。
// 「应无结果」用例（expected 为空）不计入 recall/MRR。
//
// 配置：
//   old_and   —— 用 JS 复刻旧实现（所有词都要命中、从新到旧取 30 条）当基线，输入 keywords.join(' ')
//   new_kw    —— 新实现，只给 keywords
//   new_query —— 新实现，只给 query（模拟 AI 没给 keywords）
//   new_both  —— 新实现，query + keywords
//
// 报告里只打印汇总指标，**不打印任何聊天原文**。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLongMemory } from '../src/long-memory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_DIR = path.join(ROOT, 'state', 'long-memory', 'archive');
const CASES_FILE = path.join(ROOT, 'state', 'long-memory', 'rag', 'eval', 'cases.jsonl');

const CONFIGS = {
  old_and: '旧关键词：所有词都要命中（基线）',
  new_kw: '新实现：只给 keywords',
  new_query: '新实现：只给 query',
  new_both: '新实现：query + keywords'
};

/** 读一份 archive/ 副本，按会话 key 分组；每行带相对路径与 1 起行号（与 search 内部一致）。 */
function loadArchive(archiveDir) {
  const byKey = new Map();
  for (const dirName of fs.readdirSync(archiveDir).sort()) {
    if (!/^(group|private)_\d+$/.test(dirName)) continue;
    const dir = path.join(archiveDir, dirName);
    if (!fs.statSync(dir).isDirectory()) continue;
    const rows = [];
    for (const f of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      for (let n = 0; n < lines.length; n += 1) {
        if (!lines[n]) continue;
        try {
          const row = JSON.parse(lines[n]);
          if (!row || typeof row !== 'object') continue;
          row._file = `${dirName}/${f}`;
          row._line = n + 1;
          rows.push(row);
        } catch {}
      }
    }
    byKey.set(dirName.replace('_', ':'), rows);
  }
  return byKey;
}

function dayMs(s, end) {
  if (!s) return end ? Infinity : -Infinity;
  const t = Date.parse(`${s}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isFinite(t) ? t : (end ? Infinity : -Infinity);
}

/** P0 eval/run.py 里 old_search 的逐行移植：小写子串、所有词都命中、从新到旧取前 limit 条。 */
function oldSearch(rows, keywords, from, to, speaker = '', limit = 30) {
  const words = keywords.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  const fromT = dayMs(from, false);
  const toT = dayMs(to, true);
  const sp = String(speaker ?? '').trim().toLowerCase();
  const hits = [];
  for (let i = rows.length - 1; i >= 0 && hits.length < limit; i -= 1) {
    const r = rows[i];
    const tt = Date.parse(r.t);
    if (tt < fromT || tt > toT) continue;
    if (sp && !String(r.name ?? '').toLowerCase().includes(sp)
      && !String(r.userId ?? '').includes(sp)
      && !(sp === '我' && r.dir === 'out')) continue;
    const hay = String(r.text ?? '').toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    hits.push(r);
  }
  return hits;
}

/** 第一个落在期望区间内的命中排名（1 起），找不到返回 null。 */
function rankOf(hits, expected) {
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i];
    if (expected.some((e) => e.file === h.file && h.line >= e.line_start && h.line <= e.line_end)) return i + 1;
  }
  return null;
}

function metrics(ranks) {
  const n = ranks.length;
  if (!n) return { n: 0, 'R@1': 0, 'R@3': 0, 'R@5': 0, MRR: 0 };
  const at = (k) => Math.round((ranks.filter((r) => r !== null && r <= k).length / n) * 1000) / 1000;
  return {
    n,
    'R@1': at(1),
    'R@3': at(3),
    'R@5': at(5),
    MRR: Math.round((ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / n) * 1000) / 1000
  };
}

function main() {
  if (!fs.existsSync(ARCHIVE_DIR)) throw new Error(`找不到存档目录：${ARCHIVE_DIR}`);
  if (!fs.existsSync(CASES_FILE)) throw new Error(`找不到评估用例：${CASES_FILE}`);

  const cases = fs.readFileSync(CASES_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ltm-eval-'));
  const copyDir = path.join(tmp, 'archive');
  try {
    fs.cpSync(ARCHIVE_DIR, copyDir, { recursive: true });
    const lm = createLongMemory({ stateDir: tmp });
    const archive = loadArchive(copyDir);

    const ranks = Object.fromEntries(Object.keys(CONFIGS).map((c) => [c, []]));
    let skipped = 0;
    for (const c of cases) {
      const expected = Array.isArray(c.expected) ? c.expected : [];
      if (!expected.length) { skipped += 1; continue; } // 「应无结果」用例不进指标
      const from = c.from ?? '';
      const to = c.to ?? '';
      const speaker = c.speaker ?? '';
      const opts = { from, to, speaker, limit: 30, context: 0, debug: true };

      const oldHits = oldSearch(archive.get(c.key) ?? [], c.keywords ?? [], from, to, speaker, 30)
        .map((r) => ({ file: r._file, line: r._line }));
      ranks.old_and.push(rankOf(oldHits, expected));

      const kw = lm.search(c.key, { ...opts, keywords: c.keywords ?? [] });
      ranks.new_kw.push(rankOf(kw.hits ?? [], expected));

      const q = lm.search(c.key, { ...opts, query: c.query ?? '' });
      ranks.new_query.push(rankOf(q.hits ?? [], expected));

      const both = lm.search(c.key, { ...opts, query: c.query ?? '', keywords: c.keywords ?? [] });
      ranks.new_both.push(rankOf(both.hits ?? [], expected));
    }

    const answered = ranks.new_both.length;
    console.log(`用例：${cases.length} 条（有期望结果 ${answered} 条，应无结果 ${skipped} 条未计入）`);
    console.log(`存档：${[...archive.values()].reduce((n, rows) => n + rows.length, 0)} 条消息，${archive.size} 个会话\n`);
    console.log(`${'配置'.padEnd(10)} ${'R@1'.padStart(6)} ${'R@3'.padStart(6)} ${'R@5'.padStart(6)} ${'MRR'.padStart(6)}  说明`);
    for (const [name, list] of Object.entries(ranks)) {
      const m = metrics(list);
      console.log(`${name.padEnd(10)} ${m['R@1'].toFixed(3).padStart(6)} ${m['R@3'].toFixed(3).padStart(6)} ${m['R@5'].toFixed(3).padStart(6)} ${m.MRR.toFixed(3).padStart(6)}  ${CONFIGS[name]}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
