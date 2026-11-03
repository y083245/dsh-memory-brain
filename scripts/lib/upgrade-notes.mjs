// UPGRADE_PATCH：CHANGELOG.md 里「升级须知」的解析（约定 docs/design/worker-kit/upgrade/contract.md §5）。
//
// 谁在用：scripts/update.sh（从目标版本里 git show 出来再跑，见 contract §4 第 4 步）、
//         src/update-check.js（控制台的「有新版本」提示）。所以这里只依赖 node 内置模块，
//         放在临时目录里单独运行也不能缺东西。
//
// CHANGELOG 格式：每版一节 `## v0.3.1 — 2026-11-03`，节内最后一个 ```upgrade 代码块：
//   restart: bridge, memory-rag     # 要重启哪些：bridge / memory-rag / embedding / dsh
//   deps: npm, python               # 要重装哪些依赖
//   setup-dsh: false
//   systemd: false
//   migrate: rag-db v2
//   cost: 无
// 每行 `键: 值`；值是逗号分隔的列表或 true / false；`#` 后是注释；认不出的键忽略。
//
// 用法（给 update.sh 的命令行）：
//   node upgrade-notes.mjs plan --changelog <文件> --from <版本> --to <版本> --diff <文件> --out <文件>
//     → stdout 打印给人看的摘要；--out 写「键=值」行（值只含 [a-z0-9,.-]，shell 逐行读，不 source）。
//   node upgrade-notes.mjs compare <a> <b>   → 打印 -1 / 0 / 1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTART_SERVICES = ['memory-rag', 'embedding', 'dsh', 'bridge']; // 也是重启顺序（contract §4 第 11 步）
export const DEP_KINDS = ['npm', 'python'];

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 规范成带 v 的版本号；认不出返回 null。 */
export function normalizeVersion(value) {
  const text = String(value ?? '').trim();
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return `v${text.replace(/^v/, '')}`;
}

function parseVersion(value) {
  const m = VERSION_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * 语义版本比较（v0.10.0 > v0.9.1；v0.3.1-rc.1 < v0.3.1）。认不出的版本排在最前。
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // 有预发布后缀的比正式版小；都有时逐段比（数字段按数值，数字段 < 字母段）。
  if (!pa.pre.length || !pb.pre.length) {
    if (pa.pre.length === pb.pre.length) return 0;
    return pa.pre.length ? -1 : 1;
  }
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function emptyUpgrade() {
  return { restart: [], deps: [], setupDsh: false, systemd: false, migrate: [], cost: '' };
}

const NONE_WORDS = new Set(['', '无', '没有', 'none', 'no', 'false', '-', 'n/a']);

function splitList(value) {
  return String(value ?? '').split(/[,，、]/).map((s) => s.trim()).filter((s) => s && !NONE_WORDS.has(s.toLowerCase()));
}

function parseBool(value) {
  return /^(true|yes|1|是)$/i.test(String(value ?? '').trim());
}

const RESTART_ALIASES = new Map([
  ['bridge', 'bridge'], ['qq-bridge', 'bridge'], ['桥接', 'bridge'],
  ['memory-rag', 'memory-rag'], ['memory_rag', 'memory-rag'], ['memoryrag', 'memory-rag'], ['rag', 'memory-rag'],
  ['embedding', 'embedding'], ['embed', 'embedding'],
  ['dsh', 'dsh'],
]);
const DEP_ALIASES = new Map([
  ['npm', 'npm'], ['node', 'npm'],
  ['python', 'python'], ['uv', 'python'], ['pip', 'python'],
]);

function orderedUnique(values, order) {
  const set = new Set(values);
  const known = order.filter((v) => set.has(v));
  return known;
}

/** 解析一个 ```upgrade 块的正文。认不出的键、认不出的服务名一律忽略。 */
export function parseUpgradeBlock(text) {
  const out = emptyUpgrade();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/_/g, '-');
    const value = m[2].trim();
    if (key === 'restart') {
      const names = splitList(value).map((s) => RESTART_ALIASES.get(s.toLowerCase())).filter(Boolean);
      out.restart = orderedUnique([...out.restart, ...names], RESTART_SERVICES);
    } else if (key === 'deps') {
      const names = splitList(value).map((s) => DEP_ALIASES.get(s.toLowerCase())).filter(Boolean);
      out.deps = orderedUnique([...out.deps, ...names], DEP_KINDS);
    } else if (key === 'setup-dsh' || key === 'setupdsh') {
      out.setupDsh = parseBool(value);
    } else if (key === 'systemd') {
      out.systemd = parseBool(value);
    } else if (key === 'migrate') {
      out.migrate = [...new Set([...out.migrate, ...splitList(value)])];
    } else if (key === 'cost') {
      out.cost = value;
    }
  }
  return out;
}

const HEADING_RE = /^##\s+\[?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?\s*(?:[—–-]+\s*(.*?))?\s*$/;

/**
 * 解析整份 CHANGELOG。不是版本号的 `## ` 节（例如「## 未发布」）跳过。
 * @returns {{version:string,date:string,body:string,upgrade:object|null}[]} 按文件中出现的顺序
 */
export function parseChangelog(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      const m = HEADING_RE.exec(line);
      current = m ? { version: normalizeVersion(m[1]), date: (m[2] ?? '').trim(), lines: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    if (/^#\s/.test(line)) { current = null; continue; }
    if (current) current.lines.push(line);
  }
  return sections.map((s) => {
    // 取节内**最后一个** ```upgrade 块；正文里去掉它，只留给人看的部分。
    let block = null;
    let start = -1;
    for (let i = 0; i < s.lines.length; i += 1) {
      if (/^\s*(`{3,}|~{3,})\s*upgrade\s*$/.test(s.lines[i])) {
        const fence = s.lines[i].trim().match(/^(`{3,}|~{3,})/)[1];
        let end = -1;
        for (let j = i + 1; j < s.lines.length; j += 1) {
          if (s.lines[j].trim() === fence) { end = j; break; }
        }
        if (end < 0) break;
        block = { start: i, end };
        start = i;
        i = end;
      }
    }
    let bodyLines = s.lines;
    let upgrade = null;
    if (block) {
      upgrade = parseUpgradeBlock(s.lines.slice(block.start + 1, block.end).join('\n'));
      bodyLines = [...s.lines.slice(0, start), ...s.lines.slice(block.end + 1)];
    }
    return { version: s.version, date: s.date, body: bodyLines.join('\n').trim(), upgrade };
  });
}

/** 两份须知取并集。 */
export function mergeUpgrade(a, b) {
  const x = a ?? emptyUpgrade();
  const y = b ?? emptyUpgrade();
  const costs = [...new Set([x.cost, y.cost].map((c) => String(c ?? '').trim()).filter(Boolean))];
  const real = costs.filter((c) => !NONE_WORDS.has(c.toLowerCase()));
  return {
    restart: orderedUnique([...x.restart, ...y.restart], RESTART_SERVICES),
    deps: orderedUnique([...x.deps, ...y.deps], DEP_KINDS),
    setupDsh: Boolean(x.setupDsh || y.setupDsh),
    systemd: Boolean(x.systemd || y.systemd),
    migrate: [...new Set([...x.migrate, ...y.migrate])],
    cost: (real.length ? real : costs).join('；'),
  };
}

/**
 * 取 (from, to] 区间里的各节，新的在前；须知取并集。from 为空 = 不设下限。
 * @returns {{entries:object[], upgrade:object}}
 */
export function collectNotes(entries, fromVersion, toVersion) {
  const list = (entries ?? []).filter((e) => {
    if (!e?.version) return false;
    if (fromVersion && compareVersions(e.version, fromVersion) <= 0) return false;
    if (toVersion && compareVersions(e.version, toVersion) > 0) return false;
    return true;
  }).sort((a, b) => compareVersions(b.version, a.version));
  let upgrade = emptyUpgrade();
  for (const e of list) upgrade = mergeUpgrade(upgrade, e.upgrade);
  return { entries: list, upgrade };
}

/** 按改动的文件兜底判断（contract §5）；最终集合 = 须知 ∪ 兜底。 */
export function fallbackFromDiff(changedFiles) {
  const out = emptyUpgrade();
  const restart = new Set();
  const deps = new Set();
  for (const raw of changedFiles ?? []) {
    const file = String(raw ?? '').trim().replace(/^\.\//, '');
    if (!file) continue;
    const base = path.posix.basename(file);
    if (file.startsWith('src/') || file.startsWith('public/')) restart.add('bridge');
    if (file.startsWith('sidecars/memory-rag/')) restart.add('memory-rag');
    if (/^src\/mcp-[^/]*\.js$/.test(file) || file.startsWith('dsh/') || file.startsWith('plugins/')) {
      restart.add('dsh');
      out.setupDsh = true;
    }
    if (file === 'package-lock.json') deps.add('npm');
    if (base === 'pyproject.toml' || base === 'uv.lock') deps.add('python');
    if (file.startsWith('scripts/systemd/')) out.systemd = true;
  }
  out.restart = orderedUnique([...restart], RESTART_SERVICES);
  out.deps = orderedUnique([...deps], DEP_KINDS);
  return out;
}

/** 一节的简短摘要：正文里前几条非空行（去掉列表符号）。 */
export function summarizeEntry(entry, maxLines = 3) {
  return String(entry?.body ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(`{3,}|~{3,})/.test(l))
    .slice(0, maxLines).map((l) => l.replace(/^[-*+]\s+/, ''));
}

// ── 命令行（给 update.sh）────────────────────────────────────────────
function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function safeValue(list) {
  return list.map((v) => String(v).toLowerCase().replace(/[^a-z0-9.-]/g, '')).filter(Boolean).join(',');
}

function cliPlan(argv) {
  const changelogFile = argValue(argv, '--changelog');
  const diffFile = argValue(argv, '--diff');
  const outFile = argValue(argv, '--out');
  const from = argValue(argv, '--from') || null;
  const to = argValue(argv, '--to') || null;
  let text = '';
  try { text = changelogFile ? fs.readFileSync(changelogFile, 'utf8') : ''; } catch { text = ''; }
  let files = [];
  try { files = diffFile ? fs.readFileSync(diffFile, 'utf8').split('\n').filter(Boolean) : []; } catch { files = []; }
  const notes = collectNotes(parseChangelog(text), normalizeVersion(from) ?? from, normalizeVersion(to) ?? to);
  const fb = fallbackFromDiff(files);
  const all = mergeUpgrade(notes.upgrade, fb);
  if (!notes.entries.length) console.log('  （CHANGELOG 里没有这段区间的说明）');
  for (const e of notes.entries) {
    console.log(`  ${e.version}${e.date ? `（${e.date}）` : ''}`);
    for (const line of summarizeEntry(e)) console.log(`    - ${line}`);
  }
  console.log('  升级须知（CHANGELOG ∪ 按改动的文件兜底）：');
  console.log(`    要重启：${all.restart.length ? all.restart.join('、') : '无'}`);
  console.log(`    要装依赖：${all.deps.length ? all.deps.join('、') : '无'}`);
  console.log(`    重跑 setup-dsh：${all.setupDsh ? '是' : '否'}；重装 systemd 单元：${all.systemd ? '是（仅已安装时）' : '否'}`);
  console.log(`    数据迁移：${all.migrate.length ? all.migrate.join('、') : '无'}`);
  console.log(`    费用：${all.cost || '无'}`);
  if (outFile) {
    const lines = [
      `RESTART=${safeValue(all.restart)}`,
      `DEPS=${safeValue(all.deps)}`,
      `SETUP_DSH=${all.setupDsh ? 1 : 0}`,
      `SYSTEMD=${all.systemd ? 1 : 0}`,
    ];
    fs.writeFileSync(outFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'plan') {
    cliPlan(rest);
  } else if (cmd === 'compare') {
    console.log(String(compareVersions(rest[0], rest[1])));
  } else {
    console.error('用法：upgrade-notes.mjs plan --changelog <文件> --from <版本> --to <版本> --diff <文件> --out <文件> | compare <a> <b>');
    process.exit(2);
  }
}
