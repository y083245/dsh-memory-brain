#!/usr/bin/env node
// UPGRADE_PATCH：升级时的数据迁移（约定 docs/design/worker-kit/upgrade/contract.md §2.2、§2.3、§3）。
//
// 用法：
//   node scripts/migrate.mjs --first-run [--yes] [--dry-run] [--repo <dir>] [--target <rev>] [--backup-dir <dir>]
//       首次覆盖层迁移：把用户改过的跟踪文件（角色卡、仿真提示词、memory-rag 参数）挪进 state/ 覆盖层，
//       再把原文件还原成出厂版（HEAD）。由 update.sh 在**拉取前**、备份之后调用。
//   node scripts/migrate.mjs [--dry-run] [--repo <dir>]
//       非首次部分（每次升级拉取后都跑，幂等）：本版只有 U6 的 memoryRag.enabled 补救。
//
// 为什么要能在临时目录里跑：老版本仓库里没有本文件，update.sh 从目标提交里 git show 出来放到临时目录再跑
// （contract §4 第 6 步），所以仓库位置一律由 --repo 给，js-yaml 从 --repo 的 node_modules 解析。
//
// 退出码：0 完成（或没有要做的）；1 停下，需要用户自己处理（什么都没改）；2 中途失败（已还原）；3 用户取消。
// 输出：给人看的中文，一项一行；**绝不输出任何文件内容**（角色卡、提示词里可能有隐私）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EXIT = { OK: 0, STOP: 1, FAILED: 2, CANCELLED: 3 };

/** 派生的跟踪文件：由出厂 + 覆盖层生成，首次迁移直接还原（拉取后 update.sh 重新生成）。 */
export const DERIVED_FILES = [
  'plugins/qq-agent-presets/presets/qq-chat.patch.yml',
  'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml',
];
const RAG_CONFIG = 'sidecars/memory-rag/config.yml';
const PRESET_RE = /^dsh\/agent-presets\/([A-Za-z0-9._-]+)\/agent\.cordis\.yml$/;
const ROLE_RE = /^roles\/([^/]+)\.md$/;

function parseArgs(argv) {
  const opts = { firstRun: false, yes: false, dryRun: false, repo: null, target: null, backupDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--first-run') opts.firstRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--backup-dir') opts.backupDir = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── 文件工具：覆盖层目录 700、文件 600、原子写（contract §0.3）─────────────────────
function ensureDir(dir) {
  const missing = [];
  let cur = path.resolve(dir);
  while (!fs.existsSync(cur)) {
    missing.unshift(cur);
    cur = path.dirname(cur);
  }
  for (const d of missing) {
    fs.mkdirSync(d, { mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  return missing;
}

function writeFileAtomic(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── state/upgrade.json（contract §2.3）──────────────────────────────────────
export function upgradeJsonPath(repo) {
  return path.join(repo, 'state', 'upgrade.json');
}

export function readUpgradeJson(repo) {
  const file = upgradeJsonPath(repo);
  if (!fs.existsSync(file)) return { version: 1 };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isPlainObject(doc)) throw new Error('state/upgrade.json 不是 JSON 对象');
  return doc;
}

export function writeUpgradeJson(repo, doc) {
  writeFileAtomic(upgradeJsonPath(repo), `${JSON.stringify({ version: 1, ...doc }, null, 2)}\n`);
}

// ── git ─────────────────────────────────────────────────────────────────
function makeGit(repo) {
  const run = (args, opts = {}) => execFileSync('git', ['-C', repo, ...args], {
    encoding: opts.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    run,
    tryRun(args, opts) {
      try { return run(args, opts); } catch { return null; }
    },
    /** HEAD 里的原文（Buffer）；不存在返回 null。 */
    headBlob(rel) {
      try { return run(['cat-file', 'blob', `HEAD:${rel}`], { encoding: 'buffer' }); } catch { return null; }
    },
    headFiles() {
      const out = run(['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
      return new Set(out.split('\0').filter(Boolean));
    },
    status() {
      const out = run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
      const parts = out.split('\0').filter(Boolean);
      return parts.map((p) => ({ xy: p.slice(0, 2), path: p.slice(3) }));
    },
    restore(rel) {
      // 用 HEAD 而不是索引还原：暂存过的修改也要一起回到出厂版。
      run(['checkout', 'HEAD', '--', rel]);
    },
  };
}

// ── 依赖（从 --repo 解析，见文件头）──────────────────────────────────────────
function loadYaml(repo) {
  const tries = [path.join(repo, 'package.json'), import.meta.url];
  for (const base of tries) {
    try { return createRequire(base)('js-yaml'); } catch { /* 下一个 */ }
  }
  throw new Error('找不到 js-yaml（先在仓库里装好 npm 依赖）');
}

async function loadPresetPrompt(repo) {
  // 先用和本脚本同一版本的（update.sh 把目标版本的 src/preset-prompt.js 放在临时目录的同样相对位置），
  // 拿不到再用 --repo 里的。
  const candidates = [
    new URL('../src/preset-prompt.js', import.meta.url).href,
    pathToFileURL(path.join(repo, 'src', 'preset-prompt.js')).href,
  ];
  let lastError = null;
  for (const href of candidates) {
    try { return await import(href); } catch (error) { lastError = error; }
  }
  throw new Error(`载入 src/preset-prompt.js 失败：${lastError?.message ?? lastError}`);
}

// ── 交互 ────────────────────────────────────────────────────────────────
async function confirm(question, opts) {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question}（不是终端、也没有 --yes，按「否」处理）`);
    return null;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^(y|yes|是)$/i.test(String(answer).trim());
}

// ── 首次覆盖层迁移（contract §3）─────────────────────────────────────────────
function presetFlavor(name) {
  return name === 'qq-chat' ? 'v1' : 'v2';
}

/** 去掉 persona.prefix 块后的其余行（用来判断 prefix 以外有没有改动）。 */
function linesOutsidePrefix(text, presetPrompt) {
  const loc = presetPrompt.locatePresetPromptBlock(text);
  if (!loc) return null;
  return [...loc.lines.slice(0, loc.keyLine), ...loc.lines.slice(loc.blockEnd)].join('\n');
}

/** 工作区相对 HEAD 改过的键：映射递归；列表与标量整体；HEAD 有、工作区没有 = null（删除该键）。 */
export function diffKeys(head, work) {
  const out = {};
  for (const [k, v] of Object.entries(work)) {
    if (!(k in head)) out[k] = v;
    else if (isPlainObject(head[k]) && isPlainObject(v)) {
      const d = diffKeys(head[k], v);
      if (Object.keys(d).length) out[k] = d;
    } else if (!deepEqual(head[k], v)) out[k] = v;
  }
  for (const k of Object.keys(head)) {
    if (!(k in work)) out[k] = null;
  }
  return out;
}

/** 合并进已有的 config.local.yml：用户已有的键保留用户的值。 */
export function mergeKeepExisting(fresh, existing) {
  const out = { ...fresh };
  for (const [k, v] of Object.entries(existing)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeKeepExisting(out[k], v);
    else out[k] = v;
  }
  return out;
}

function fileHashOf(git, rel) {
  return git.tryRun(['hash-object', '--', rel])?.trim() ?? null;
}

/**
 * 看工作区，得出要做的事。
 * @returns {{items: object[], stops: {path:string, reason:string}[], skipped: string[]}}
 */
async function planFirstRun(repo, opts, git) {
  const headFiles = git.headFiles();
  const entries = git.status();
  const items = [];
  const stops = [];
  const skipped = [];
  const stateDir = path.join(repo, 'state');
  let yamlLib = null;
  let presetPrompt = null;
  const hidden = { names: null };

  for (const { xy, path: rel } of entries) {
    const abs = path.join(repo, rel);
    const inHead = headFiles.has(rel);
    const exists = fs.existsSync(abs);
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') {
      stops.push({ path: rel, reason: '有未解决的合并冲突' });
      continue;
    }
    // U5：按 README 先 `git checkout origin/main -- scripts/update.sh` 取到的新脚本（已暂存、与目标版本相同）不算改动。
    if (rel === 'scripts/update.sh' && opts.target && xy[1] === ' ') {
      const idx = git.tryRun(['rev-parse', `:${rel}`])?.trim();
      const tgt = git.tryRun(['rev-parse', `${opts.target}:${rel}`])?.trim();
      if (idx && tgt && idx === tgt && fileHashOf(git, rel) === tgt) {
        skipped.push(rel);
        continue;
      }
    }
    if (DERIVED_FILES.includes(rel) && inHead) {
      items.push({ kind: 'derived', path: rel });
      continue;
    }
    const role = ROLE_RE.exec(rel);
    if (role && !role[1].startsWith('.') && role[1].toLowerCase() !== 'readme') {
      const name = role[1];
      const dest = path.join(stateDir, 'roles', `${name}.md`);
      if (inHead && !exists) {
        items.push({ kind: 'role-deleted', path: rel, name });
        if (hidden.names === null) {
          const hf = path.join(stateDir, 'roles', 'hidden.json');
          if (fs.existsSync(hf)) {
            try {
              const doc = JSON.parse(fs.readFileSync(hf, 'utf8'));
              hidden.names = Array.isArray(doc?.names) ? doc.names.filter((n) => typeof n === 'string') : [];
            } catch {
              stops.push({ path: 'state/roles/hidden.json', reason: '已有的 hidden.json 读不懂' });
              hidden.names = [];
            }
          } else hidden.names = [];
        }
        continue;
      }
      if (!exists || !fs.statSync(abs).isFile()) {
        stops.push({ path: rel, reason: '不是普通文件' });
        continue;
      }
      const work = fs.readFileSync(abs);
      if (inHead) {
        const head = git.headBlob(rel);
        if (head && head.equals(work)) { items.push({ kind: 'restore-only', path: rel }); continue; }
      } else if (xy !== '??') {
        stops.push({ path: rel, reason: '已加入索引但还没提交的新文件' });
        continue;
      }
      if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(work)) {
        stops.push({ path: rel, reason: `覆盖层里已经有 state/roles/${name}.md，而且内容不一样` });
        continue;
      }
      items.push({ kind: inHead ? 'role-modified' : 'role-untracked', path: rel, name, dest });
      continue;
    }
    const preset = PRESET_RE.exec(rel);
    if (preset && inHead && exists) {
      presetPrompt ??= await loadPresetPrompt(repo);
      const name = preset[1];
      const headText = git.headBlob(rel).toString('utf8');
      const workText = fs.readFileSync(abs, 'utf8');
      const headOutside = linesOutsidePrefix(headText, presetPrompt);
      const workOutside = linesOutsidePrefix(workText, presetPrompt);
      const headPrefix = presetPrompt.extractPresetPrefix(headText);
      const workPrefix = presetPrompt.extractPresetPrefix(workText);
      if (headOutside === null || workOutside === null || headPrefix === null || workPrefix === null) {
        stops.push({ path: rel, reason: '找不到 persona.prefix 块或 YAML 读不懂（不是控制台改出来的）' });
        continue;
      }
      if (headOutside !== workOutside) {
        stops.push({ path: rel, reason: 'persona.prefix 以外也有改动（控制台只改得出 prefix，这部分请自己处理）' });
        continue;
      }
      if (workPrefix === headPrefix) { items.push({ kind: 'restore-only', path: rel }); continue; }
      try {
        presetPrompt.renderPresetPromptYaml(headText, workPrefix, presetFlavor(name));
      } catch {
        stops.push({ path: rel, reason: '改过的提示词放不回出厂预设（缺安全不变量或格式不对）' });
        continue;
      }
      const dest = path.join(stateDir, 'preset-overrides', `${name}.prefix.md`);
      if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') !== workPrefix) {
        stops.push({ path: rel, reason: `覆盖层里已经有 state/preset-overrides/${name}.prefix.md，而且内容不一样` });
        continue;
      }
      items.push({ kind: 'preset', path: rel, name, dest, content: workPrefix });
      continue;
    }
    if (rel === RAG_CONFIG && inHead && exists) {
      yamlLib ??= loadYaml(repo);
      let head;
      let work;
      try {
        head = yamlLib.load(git.headBlob(rel).toString('utf8')) ?? {};
        work = yamlLib.load(fs.readFileSync(abs, 'utf8')) ?? {};
      } catch {
        stops.push({ path: rel, reason: 'YAML 读不懂' });
        continue;
      }
      if (!isPlainObject(head) || !isPlainObject(work)) {
        stops.push({ path: rel, reason: '顶层不是映射' });
        continue;
      }
      const diff = diffKeys(head, work);
      if ('state_dir' in diff) {
        // 覆盖层里的 state_dir 不生效（contract §1.3），挪进去会让 memory-rag 换回出厂的数据目录。
        stops.push({ path: rel, reason: '改了 state_dir（覆盖层不支持这个键），请自己处理' });
        continue;
      }
      const dest = path.join(stateDir, 'long-memory', 'rag', 'config.local.yml');
      let existing = null;
      if (fs.existsSync(dest)) {
        try {
          existing = yamlLib.load(fs.readFileSync(dest, 'utf8')) ?? {};
        } catch {
          existing = undefined;
        }
        if (!isPlainObject(existing)) {
          stops.push({ path: rel, reason: '已有的 config.local.yml 读不懂' });
          continue;
        }
      }
      const merged = existing ? mergeKeepExisting(diff, existing) : diff;
      const changed = existing ? !deepEqual(merged, existing) : Object.keys(diff).length > 0;
      items.push({ kind: 'rag-config', path: rel, dest, keys: Object.keys(diff), merged, write: changed, yamlLib });
      continue;
    }
    stops.push({ path: rel, reason: inHead ? (exists ? '改过的文件（不在可迁移的范围里）' : '删掉的文件') : '未跟踪的文件' });
  }
  return { items, stops, skipped, hidden };
}

function describe(item) {
  switch (item.kind) {
    case 'role-modified': return `角色卡 ${item.path} → state/roles/${item.name}.md，原文件还原成出厂版`;
    case 'role-untracked': return `自建角色卡 ${item.path} → 移到 state/roles/${item.name}.md`;
    case 'role-deleted': return `删掉的出厂角色卡 ${item.path} → 记进 state/roles/hidden.json，原文件还原`;
    case 'preset': return `仿真提示词 ${item.path} → state/preset-overrides/${item.name}.prefix.md，原文件还原`;
    case 'rag-config': return item.write
      ? `memory-rag 参数 ${item.path} → state/long-memory/rag/config.local.yml（改过的键：${item.keys.join('、') || '无'}），原文件还原`
      : `memory-rag 参数 ${item.path} 没有要保留的键（只改了注释 / 已在覆盖层里），原文件还原`;
    case 'derived': return `派生文件 ${item.path} → 还原（升级后重新生成）`;
    case 'restore-only': return `${item.path} 与出厂版内容相同 → 还原`;
    default: return item.path;
  }
}

async function runFirstRun(repo, opts) {
  const git = makeGit(repo);
  const { items, stops, skipped, hidden } = await planFirstRun(repo, opts, git);
  for (const rel of skipped) console.log(`· ${rel}：与目标版本相同（第一次升级时取出的），不算改动`);
  if (stops.length) {
    console.log('✗ 下面这些改动没法自动挪进覆盖层，首次迁移整体不做（什么都没改）：');
    for (const s of stops) console.log(`  - ${s.path}：${s.reason}`);
    console.log('  请自己处理（提交到别处、还原，或手工复制到 state/ 下对应位置）后再升级。');
    return EXIT.STOP;
  }
  if (!items.length) {
    console.log('· 没有需要挪进覆盖层的文件');
    if (!opts.dryRun) {
      const doc = readUpgradeJson(repo);
      if (!doc.firstRun) {
        doc.firstRun = { at: nowIso(), moved: [] };
        writeUpgradeJson(repo, doc);
      }
    }
    return EXIT.OK;
  }
  console.log(`首次迁移：共 ${items.length} 项`);
  for (const item of items) console.log(`  - ${describe(item)}`);
  if (opts.dryRun) {
    console.log('（--dry-run：只列出，不改任何文件）');
    return EXIT.OK;
  }
  const ok = await confirm('按上面的清单迁移吗？', opts);
  if (ok === null || ok === false) {
    console.log('已取消，什么都没改');
    return EXIT.CANCELLED;
  }

  const stateDir = path.join(repo, 'state');
  const backupDir = path.resolve(opts.backupDir ?? path.join(os.homedir(), 'qq-bridge-backups', `first-run-${stamp()}`));
  const undo = [];
  const manifest = { version: 1, at: nowIso(), repo, items: [] };
  const moved = [];
  try {
    ensureDir(stateDir);
    // 复制前先备份：要被还原 / 移走的工作区原文、要被改写的覆盖层文件。
    const saveCopy = (srcAbs, relUnder) => {
      const dest = path.join(backupDir, relUnder);
      ensureDir(path.dirname(dest));
      fs.copyFileSync(srcAbs, dest);
      fs.chmodSync(dest, 0o600);
      return dest;
    };
    ensureDir(backupDir);
    for (const item of items) {
      const abs = path.join(repo, item.path);
      if (fs.existsSync(abs)) {
        item.mode = fs.statSync(abs).mode & 0o7777;
        item.backup = saveCopy(abs, path.join('files', item.path));
      }
    }
    // 覆盖层文件：先记下原状，失败时还原。
    const writeOverlay = (dest, data) => {
      const had = fs.existsSync(dest);
      const before = had ? fs.readFileSync(dest) : null;
      const createdDirs = ensureDir(path.dirname(dest));
      writeFileAtomic(dest, data);
      undo.push(() => {
        if (had) writeFileAtomic(dest, before);
        else fs.rmSync(dest, { force: true });
        for (const d of [...createdDirs].reverse()) { try { fs.rmdirSync(d); } catch { /* 非空就留着 */ } }
      });
      return !had;
    };
    const restoreTracked = (item) => {
      git.restore(item.path);
      undo.push(() => {
        const abs = path.join(repo, item.path);
        if (item.backup) {
          fs.copyFileSync(item.backup, abs);
          fs.chmodSync(abs, item.mode);
        } else fs.rmSync(abs, { force: true });
      });
    };

    const hiddenAdds = [];
    for (const item of items) {
      const record = { kind: item.kind, path: item.path };
      if (item.kind === 'role-modified' || item.kind === 'role-untracked') {
        const created = writeOverlay(item.dest, fs.readFileSync(path.join(repo, item.path)));
        if (created) record.created = path.relative(repo, item.dest);
        if (item.kind === 'role-modified') restoreTracked(item);
        else {
          const abs = path.join(repo, item.path);
          fs.rmSync(abs);
          undo.push(() => {
            fs.copyFileSync(item.backup, abs);
            fs.chmodSync(abs, item.mode);
          });
        }
        moved.push(item.path);
      } else if (item.kind === 'role-deleted') {
        hiddenAdds.push(item.name);
        restoreTracked(item);
        moved.push(`hidden:${item.path}`);
      } else if (item.kind === 'preset') {
        const created = writeOverlay(item.dest, item.content);
        if (created) record.created = path.relative(repo, item.dest);
        restoreTracked(item);
        moved.push(`preset:${item.name}`);
      } else if (item.kind === 'rag-config') {
        if (item.write) {
          const header = '# 用户的 memory-rag 参数（只放改过的键，覆盖 sidecars/memory-rag/config.yml）。\n'
            + '# UPGRADE_PATCH：首次升级时从你改过的 config.yml 里自动挪过来。值写 null = 回到代码缺省。\n';
          const body = item.yamlLib.dump(item.merged, { lineWidth: -1, noRefs: true });
          const created = writeOverlay(item.dest, header + body);
          if (created) record.created = path.relative(repo, item.dest);
          moved.push('rag-config');
        }
        restoreTracked(item);
      } else {
        restoreTracked(item);
      }
      manifest.items.push(record);
    }
    if (hiddenAdds.length) {
      const hf = path.join(stateDir, 'roles', 'hidden.json');
      const names = [...new Set([...(hidden.names ?? []), ...hiddenAdds])];
      const created = writeOverlay(hf, `${JSON.stringify({ version: 1, names }, null, 2)}\n`);
      manifest.hidden = { added: hiddenAdds, created };
    }

    const doc = readUpgradeJson(repo);
    const before = fs.existsSync(upgradeJsonPath(repo)) ? fs.readFileSync(upgradeJsonPath(repo)) : null;
    const entry = { at: nowIso(), moved, backup: backupDir };
    if (!doc.firstRun) doc.firstRun = entry;
    else doc.firstRun.repeats = [...(Array.isArray(doc.firstRun.repeats) ? doc.firstRun.repeats : []), entry];
    writeFileAtomic(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeUpgradeJson(repo, doc);
    undo.push(() => {
      if (before) writeFileAtomic(upgradeJsonPath(repo), before);
      else fs.rmSync(upgradeJsonPath(repo), { force: true });
    });
    console.log(`✓ 首次迁移完成（${moved.length} 项挪进覆盖层）；原文件备份在 ${backupDir}`);
    return EXIT.OK;
  } catch (error) {
    console.log(`✗ 首次迁移失败：${error?.message ?? error}；正在还原已改的文件……`);
    for (const fn of undo.reverse()) {
      try { fn(); } catch (e) { console.log(`  还原时出错：${e?.message ?? e}（原文件备份在 ${backupDir}）`); }
    }
    console.log('  已还原');
    return EXIT.FAILED;
  }
}

// ── 非首次部分（contract §2.2）──────────────────────────────────────────────
function detectIndent(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1].startsWith('\t') ? '\t' : m[1].length;
}

/** U6：按老缺省「关」部署、其实一直开着向量记忆的人，升级后别被悄悄关掉。 */
function migrateRagEnabled(repo, opts, doc) {
  const KEY = 'rag-enabled-fix';
  if (doc.migrations?.[KEY]) {
    console.log('· memoryRag.enabled 补救：以前做过，跳过');
    return false;
  }
  const cfgFile = path.join(repo, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    console.log('· memoryRag.enabled 补救：没有 config.json，跳过');
    return false;
  }
  const text = fs.readFileSync(cfgFile, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    console.log('· memoryRag.enabled 补救：config.json 读不懂，跳过（不改它）');
    return false;
  }
  const record = () => {
    if (opts.dryRun) return true;
    doc.migrations = { ...(isPlainObject(doc.migrations) ? doc.migrations : {}), [KEY]: nowIso() };
    return true;
  };
  if (!isPlainObject(cfg)) {
    console.log('· memoryRag.enabled 补救：config.json 不是对象，跳过（不改它）');
    return false;
  }
  if ('memoryRag' in cfg && !isPlainObject(cfg.memoryRag)) {
    console.log('· memoryRag.enabled 补救：memoryRag 不是对象，不动');
    return record();
  }
  if (isPlainObject(cfg.memoryRag) && 'enabled' in cfg.memoryRag) {
    console.log('· memoryRag.enabled 补救：已经设置过，不动');
    return record();
  }
  const db = path.join(repo, 'state', 'long-memory', 'rag', 'rag.sqlite3');
  let size = 0;
  try { size = fs.statSync(db).size; } catch { size = 0; }
  if (size <= 0) {
    console.log('· memoryRag.enabled 补救：没有向量索引数据，保持关');
    return record();
  }
  if (opts.dryRun) {
    console.log('· memoryRag.enabled 补救：将写入 memoryRag.enabled = true（--dry-run，没写）');
    return true;
  }
  const next = { ...cfg, memoryRag: { ...(cfg.memoryRag ?? {}), enabled: true } };
  const mode = fs.statSync(cfgFile).mode & 0o7777;
  const eol = text.endsWith('\n') ? '\n' : '';
  writeFileAtomic(cfgFile, `${JSON.stringify(next, null, detectIndent(text))}${eol}`, mode);
  console.log('✓ memoryRag.enabled 补救：发现已有向量索引，写入 memoryRag.enabled = true'
    + '（老版本缺省就是开着的，新版本缺省改成关；不想要就在控制台「API 管理」页关掉）');
  return record();
}

function runRegular(repo, opts) {
  const doc = readUpgradeJson(repo);
  const before = JSON.stringify(doc);
  migrateRagEnabled(repo, opts, doc);
  if (!opts.dryRun && JSON.stringify(doc) !== before) writeUpgradeJson(repo, doc);
  return EXIT.OK;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`migrate：${error.message}`);
    return EXIT.STOP;
  }
  const repo = path.resolve(opts.repo ?? path.join(__dirname, '..'));
  if (!fs.existsSync(path.join(repo, '.git')) || !fs.existsSync(path.join(repo, 'src', 'bridge.js'))) {
    console.error(`migrate：${repo} 不像 qq-bridge 仓库（缺 .git 或 src/bridge.js）`);
    return EXIT.STOP;
  }
  // 不改进程 umask：git checkout 还原出厂文件要沿用用户原来的权限；覆盖层与备份的 700 / 600 都是显式 chmod 的。
  try {
    return opts.firstRun ? await runFirstRun(repo, opts) : runRegular(repo, opts);
  } catch (error) {
    console.error(`migrate：失败：${error?.message ?? error}`);
    return EXIT.FAILED;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
