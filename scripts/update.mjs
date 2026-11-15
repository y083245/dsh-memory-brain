#!/usr/bin/env node
// UPGRADE_PATCH：一条命令升级（Linux / Windows 共用；入口 scripts/update.sh、update.bat 只是一层转发）。
//
// 用法：
//   node scripts/update.mjs [--yes] [--to <tag>] [--with-rag] [--dry-run] [--check]
//     --check     只 fetch 并显示「当前 → 最新」与升级须知，不改任何东西
//     --dry-run   走完全部判断、打印将要做的每一步，不写、不拉、不重启
//     --to <tag>  升到指定标签（缺省：最新的正式版 v* 标签；没有标签时用 origin/main）
//     --with-rag  备份带上向量派生库（缺省不带：能重建、体积大）
//     --yes       所有询问都答「是」（无人值守用）
//
// 退出码：0 成功 / 已是最新；1 检查没通过（代码没改）；2 升级中失败（会打印回滚命令）；3 用户取消。
// 规矩与共用函数见 scripts/lib/upgrade-common.mjs。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DERIVED, Exit, RAG_EXCLUDES, ask, binOf, createContext, dshPids, ensureBackupDir, err, git, gitOk, gitOut,
  healthWaitSeconds, hostMissing, hostRunning, info, needsQqHost, ok, pgrepF, pruneBackups, ragEnabled, rollbackCommand, run, sdctl,
  sendSignal, startAll, startCommand, stepper, stopAll, tarCreate, timestamp, ujAppend, unitInstalled, updateCommand,
  waitGone, waitHealthy, warn
} from './lib/upgrade-common.mjs';

const SELF = fileURLToPath(import.meta.url);
const step = stepper(13);
// 第一次升级时用户手动取出来的新脚本（已暂存、与目标版本相同）不算本地改动。
const BOOTSTRAP_FILES = ['scripts/update.sh', 'scripts/update.mjs', 'scripts/lib/upgrade-common.mjs'];
const SD_UNITS = ['qq-bridge.service', 'qq-memory-rag.service', 'qq-embedding.service'];

function parseArgs(argv) {
  const o = { yes: false, to: '', withRag: false, dry: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--to') {
      if (i + 1 >= argv.length) { err('--to 后面要跟标签'); throw new Exit(1); }
      o.to = argv[++i];
    } else if (a.startsWith('--to=')) o.to = a.slice(5);
    else if (a === '--with-rag') o.withRag = true;
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--check') o.check = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(SELF, 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      throw new Exit(0);
    } else { err(`未知参数：${a}（可用：--yes --to <tag> --with-rag --dry-run --check）`); throw new Exit(1); }
  }
  if (o.to && !/^[A-Za-z0-9._/-]+$/.test(o.to)) { err(`标签名不合法：${o.to}`); throw new Exit(1); }
  return o;
}

async function main() {
  process.umask(0o077); // 备份、upgrade.json 等自己写的东西一律 077；git / npm / 启停脚本走 orig
  const opts = parseArgs(process.argv.slice(2));
  const ctx = createContext(path.resolve(path.dirname(SELF), '..'));
  ctx.yes = opts.yes;
  const { repo } = ctx;
  const { dry } = opts;
  const G = (args, o) => git(ctx, args, o);

  const S = { changed: false, handled: false, backup: '', merged: false, firstRun: '', restarted: [], skipped: [], oldCommit: '', targetCommit: '', oldLabel: '', targetLabel: '' };
  const record = (result) => {
    if (dry || !S.backup) return;
    try {
      const entry = {
        at: new Date().toISOString(), from: S.oldLabel, to: S.targetLabel, fromCommit: S.oldCommit, toCommit: S.targetCommit,
        backup: S.backup, result, restarted: S.restarted
      };
      if (S.skipped.length) entry.skipped = S.skipped;
      if (S.firstRun) entry.firstRunBackup = S.firstRun;
      ujAppend(repo, entry);
    } catch { warn('没能写 state/upgrade.json'); }
  };
  const rollbackHint = () => {
    if (!S.backup) return;
    if (S.merged || fs.existsSync(path.join(repo, 'scripts', 'rollback.mjs'))) err(`回滚：${rollbackCommand()} ${S.backup}`);
    else err(`回滚：git -C ${repo} checkout ${S.targetCommit} -- scripts/rollback.sh scripts/rollback.mjs scripts/lib/upgrade-common.mjs，再运行 ${rollbackCommand()} ${S.backup}`);
  };
  const die1 = (msg) => { err(msg); S.handled = true; throw new Exit(1); };
  const fail2 = (msg) => { err(`升级失败：${msg}`); record('failed'); rollbackHint(); S.handled = true; throw new Exit(2); };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-update.'));
  try {
    step(1, '准备（拉取时仓库里的脚本会被替换，不影响这次执行）');
    if (ctx.isTest) info(`测试模式：外部命令只用 ${process.env.QQB_FAKE_BIN} 里的替身`);
    if (dry) info('--dry-run：只打印将要做的事，不写、不拉、不重启');

    step(2, '检查仓库');
    if (!fs.existsSync(path.join(repo, 'src', 'bridge.js')) || !fs.existsSync(path.join(repo, '.git'))) die1(`${repo} 不像 qq-bridge 仓库（缺 src/bridge.js 或 .git）`);
    if (fs.existsSync(path.join(repo, 'docs', 'design', 'HANDOFF.md'))) die1('这个目录里有 docs/design/HANDOFF.md，是作者本机的线上目录：请走 merge-to-live.sh，不要用 update.sh');
    if (!gitOk(ctx, ['remote', 'get-url', 'origin'])) die1('没有 origin 远端（git remote get-url origin 失败）');
    ok(`仓库：${repo}`);

    step(3, '获取更新（git fetch --tags --force origin）');
    // --force：2026-11-04 整理过一次提交历史，旧 clone 里的同名标签指向旧提交，不带它 fetch 会拒绝更新并报错。
    if (!gitOk(ctx, ['fetch', '--tags', '--force', '--quiet', 'origin'])) die1('连不上 origin（git fetch 失败）');
    if (opts.to) {
      S.targetCommit = gitOut(ctx, ['rev-parse', '-q', '--verify', `refs/tags/${opts.to}^{commit}`]);
      if (!S.targetCommit) die1(`找不到标签 ${opts.to}`);
      S.targetLabel = opts.to;
    } else {
      const latest = gitOut(ctx, ['-c', 'versionsort.suffix=-', 'tag', '-l', 'v[0-9]*', '--sort=-v:refname'])
        .split(/\r?\n/).find((t) => /^v\d+\.\d+\.\d+$/.test(t));
      if (latest) {
        S.targetCommit = gitOut(ctx, ['rev-parse', `refs/tags/${latest}^{commit}`]);
        S.targetLabel = latest;
      } else {
        S.targetCommit = gitOut(ctx, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/main^{commit}']);
        if (!S.targetCommit) die1('没有 v* 标签，也没有 origin/main');
        S.targetLabel = `origin/main@${gitOut(ctx, ['rev-parse', '--short', S.targetCommit])}`;
      }
    }
    S.oldCommit = gitOut(ctx, ['rev-parse', 'HEAD']);
    const pkgVersion = () => {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
        return typeof v === 'string' ? `v${v.replace(/^v/, '')}` : '';
      } catch { return ''; }
    };
    // 整理过历史后，之前装的 HEAD 不在新历史里，提交号全变了但文件没变：目标版本的历史里
    // 有文件完全相同的提交，就认它是当前版本。版本号按它算（旧提交上已经没有新标签了），
    // 拉取前把 HEAD 平移过去再正常快进。有自己提交的 HEAD 对不上，仍走下面的报错。
    const sameContentCommit = () => {
      const tree = gitOut(ctx, ['rev-parse', 'HEAD^{tree}']);
      const line = gitOut(ctx, ['log', '--format=%H %T', S.targetCommit]).split(/\r?\n/).find((l) => l.endsWith(` ${tree}`));
      return line ? line.split(' ')[0] : '';
    };
    const onTargetLine = gitOk(ctx, ['merge-base', '--is-ancestor', 'HEAD', S.targetCommit])
      || gitOk(ctx, ['merge-base', '--is-ancestor', S.targetCommit, 'HEAD']);
    S.sameContentAs = onTargetLine ? '' : sameContentCommit();
    const headRef = S.sameContentAs || 'HEAD';
    const shortHead = gitOut(ctx, ['rev-parse', '--short', 'HEAD']);
    const fromVer = gitOut(ctx, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', headRef]) || pkgVersion();
    S.oldLabel = gitOut(ctx, ['describe', '--tags', '--exact-match', '--match', 'v[0-9]*', headRef]) || `${fromVer ? `${fromVer}+` : ''}${shortHead}`;
    const toVer = /^v\d/.test(S.targetLabel) ? S.targetLabel : '';
    info(`当前：${S.oldLabel}（${shortHead}）`);
    info(`目标：${S.targetLabel}（${gitOut(ctx, ['rev-parse', '--short', S.targetCommit])}）`);
    if (S.targetCommit === S.oldCommit) { ok('已是最新'); S.handled = true; throw new Exit(0); }
    if (gitOk(ctx, ['merge-base', '--is-ancestor', S.targetCommit, 'HEAD'])) { ok('当前版本已包含目标版本，不用升级'); S.handled = true; throw new Exit(0); }
    if (S.sameContentAs) info('仓库整理过提交历史（文件内容没变）：这次升级会把本地分支换到新历史上');
    else if (!gitOk(ctx, ['merge-base', '--is-ancestor', 'HEAD', S.targetCommit])) die1('目标版本不是当前版本的后代：本地有自己的提交，没法快进。请先把自己的提交挪到别的分支再升级（2026-11-04 之前装的，见 CHANGELOG 的 v0.5.2）');

    step(4, '这次更新的内容与升级须知');
    const T = path.join(work, 't');
    fs.mkdirSync(path.join(T, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(T, 'src'), { recursive: true });
    for (const f of ['scripts/migrate.mjs', 'scripts/lib/upgrade-notes.mjs', 'src/preset-prompt.js', 'CHANGELOG.md']) {
      const r = G(['show', `${S.targetCommit}:${f}`]);
      if (r.code === 0) fs.writeFileSync(path.join(T, f), r.stdout);
    }
    // 临时目录里的 preset-prompt.js 要 import js-yaml：指回仓库的 node_modules。
    if (fs.existsSync(path.join(repo, 'node_modules'))) fs.symlinkSync(path.join(repo, 'node_modules'), path.join(T, 'node_modules'), 'junction');
    if (!fs.existsSync(path.join(T, 'scripts/lib/upgrade-notes.mjs')) || !fs.existsSync(path.join(T, 'scripts/migrate.mjs'))) {
      die1('目标版本里没有 scripts/migrate.mjs / scripts/lib/upgrade-notes.mjs，不能用本脚本升级到它');
    }
    const diffNames = G(['diff', '--name-only', S.oldCommit, S.targetCommit]).stdout;
    const diffFile = path.join(work, 'diff.txt');
    const planFile = path.join(work, 'plan.env');
    fs.writeFileSync(diffFile, diffNames);
    const planRun = run(process.execPath, [path.join(T, 'scripts/lib/upgrade-notes.mjs'), 'plan', '--changelog', path.join(T, 'CHANGELOG.md'), '--from', fromVer, '--to', toVer, '--diff', diffFile, '--out', planFile]);
    if (planRun.code !== 0) die1('解析升级须知失败');
    const plan = { RESTART: '', DEPS: '', SETUP_DSH: '0', SYSTEMD: '0' };
    for (const line of fs.readFileSync(planFile, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i);
      const v = line.slice(i + 1);
      if (/^[a-z0-9,.-]*$/.test(v) && k in plan) plan[k] = v;
    }
    const has = (list, x) => list.split(',').includes(x);
    const diffHas = (re) => diffNames.split(/\r?\n/).some((l) => re.test(l));
    if (opts.check) {
      info(`要升级：${updateCommand()}${opts.to ? ` --to ${opts.to}` : ''}`);
      S.handled = true;
      throw new Exit(0);
    }
    if (!dry && !(await ask(ctx, '继续升级吗？'))) { info('已取消，什么都没改'); S.handled = true; throw new Exit(3); }

    step(5, '备份 state/ 与 config.json');
    const backupDir = path.join(os.homedir(), 'qq-bridge-backups');
    const ts = timestamp();
    const safeLabel = S.oldLabel.replace(/[^A-Za-z0-9._-]/g, '_');
    let backupPath = path.join(backupDir, `update-${ts}-${safeLabel}.tar.gz`);
    for (let n = 1; fs.existsSync(backupPath); n += 1) backupPath = path.join(backupDir, `update-${ts}-${safeLabel}-${n}.tar.gz`);
    const items = ['state', 'config.json'].filter((x) => fs.existsSync(path.join(repo, x)));
    if (dry) {
      info(`将打包到 ${backupPath}（${items.join(' ') || '（没有 state/ 与 config.json）'}${opts.withRag ? '，带向量库' : '，不带向量派生库'}）`);
    } else {
      ensureBackupDir();
      const t = tarCreate(repo, backupPath, opts.withRag ? [] : RAG_EXCLUDES);
      if (!t.ok) { fs.rmSync(backupPath, { force: true }); die1(`备份失败（tar 退出码 ${t.code}），什么都没改`); }
      if (t.changing) warn('打包时有文件在变化（服务还在写），备份仍可用');
      try { fs.chmodSync(backupPath, 0o600); } catch { /* Windows */ }
      S.backup = backupPath;
      const bytes = fs.statSync(backupPath).size;
      const size = bytes >= 1048576 ? `${Math.floor(bytes / 1048576)} MB` : bytes >= 1024 ? `${Math.floor(bytes / 1024)} KB` : `${bytes} 字节`;
      ok(`备份：${backupPath}（${size}）；旧提交 ${S.oldCommit}`);
      info('备份里有你的聊天存档原文；之后在控制台删除的聊天，在这些旧备份里不会被删除。不需要时可以直接删掉 ~/qq-bridge-backups/ 里的旧文件。');
    }

    step(6, '检查本地改动（必要时做首次覆盖层迁移）');
    // 派生的 preset patch（出厂 + 覆盖层生成的）不算用户改动：第 7 步拉取前还原、第 10 步重新生成。
    const dirtyList = () => {
      const out = [];
      for (const e of G(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout.split('\0').filter(Boolean)) {
        const xy = e.slice(0, 2);
        const p = e.slice(3);
        if (DERIVED.includes(p) && gitOk(ctx, ['cat-file', '-e', `HEAD:${p}`])) continue;
        if (BOOTSTRAP_FILES.includes(p) && xy[1] === ' ') {
          const tgt = gitOut(ctx, ['rev-parse', '-q', '--verify', `${S.targetCommit}:${p}`]);
          const idx = gitOut(ctx, ['rev-parse', '-q', '--verify', `:${p}`]);
          const wt = gitOut(ctx, ['hash-object', '--', p]);
          if (tgt && idx === tgt && wt === tgt) continue;
        }
        out.push(p);
      }
      return out;
    };
    if (dirtyList().length) {
      info('有本地改动，先把能挪的挪进 state/ 覆盖层（新版本程序只写覆盖层，出厂文件保持原样）：');
      const firstRunDir = path.join(backupDir, `first-run-${ts}`);
      const margs = ['--first-run', '--repo', repo, '--target', S.targetCommit, '--backup-dir', firstRunDir];
      if (opts.yes) margs.push('--yes');
      if (dry) margs.push('--dry-run');
      if (!dry) S.changed = true;
      const m = run(process.execPath, [path.join(T, 'scripts/migrate.mjs'), ...margs], { orig: true });
      if (m.code === 3) { info(`已取消；备份在 ${S.backup || '（dry-run 未备份）'}，代码没改`); S.handled = true; throw new Exit(3); }
      if (m.code !== 0) die1(`首次迁移没做（见上面的清单）。备份在 ${S.backup || '（dry-run 未备份）'}，代码没改`);
      if (fs.existsSync(firstRunDir)) S.firstRun = firstRunDir;
      if (!dry) {
        const left = dirtyList();
        if (left.length) die1(`迁移后仍有改动：${left.join(' ')}`);
      }
    } else {
      ok('没有本地改动');
    }

    step(7, `拉取（git merge --ff-only ${S.targetLabel}）`);
    let restoredDerived = false;
    for (const f of DERIVED) {
      if (!gitOk(ctx, ['cat-file', '-e', `HEAD:${f}`])) continue;
      if (fs.existsSync(path.join(repo, f)) && gitOk(ctx, ['diff', '--quiet', 'HEAD', '--', f])) continue;
      if (dry) { info(`将还原派生文件 ${f}（拉取后重新生成）`); continue; }
      S.changed = true;
      if (G(['checkout', 'HEAD', '--', f], { orig: true }).code !== 0) fail2(`还原派生文件 ${f} 失败`);
      restoredDerived = true;
      info(`已还原派生文件 ${f}（拉取后重新生成）`);
    }
    if (dry) {
      info(`将快进到 ${S.targetCommit}`);
    } else {
      S.changed = true;
      // 文件完全相同，只挪 HEAD，工作区和暂存区都不动。
      if (S.sameContentAs && G(['reset', '--soft', S.sameContentAs], { orig: true }).code !== 0) fail2('把本地分支换到新历史失败');
      if (G(['merge', '--ff-only', '--quiet', S.targetCommit], { orig: true }).code !== 0) fail2('git merge --ff-only 失败');
      S.merged = true;
      ok(`已到 ${S.targetLabel}`);
    }

    step(8, '依赖');
    const needNpm = has(plan.DEPS, 'npm') || diffHas(/^package-lock\.json$/);
    const needPy = has(plan.DEPS, 'python') || diffHas(/^sidecars\/memory-rag\/(pyproject\.toml|uv\.lock)$/);
    if (!needNpm && !needPy) ok('依赖没变');
    if (needNpm) {
      if (dry) info('将运行 npm ci');
      else {
        const npm = binOf(ctx, 'npm');
        if (!npm) { err('找不到命令 npm'); fail2('要 npm ci 但找不到 npm'); }
        const npmArgs = needsQqHost(repo) ? ['ci'] : ['ci', '--omit=optional'];
        if (run(npm, npmArgs, { cwd: repo, orig: true }).code !== 0) fail2('npm ci 失败');
        ok('npm ci');
      }
    }
    if (needPy) {
      const uv = binOf(ctx, 'uv');
      if (!uv) warn('memory-rag 的 Python 依赖变了，但没装 uv：之后请自己在 sidecars/memory-rag 里运行 uv sync');
      else if (dry) info('将在 sidecars/memory-rag 里运行 uv sync');
      else {
        if (run(uv, ['sync'], { cwd: path.join(repo, 'sidecars', 'memory-rag'), orig: true }).code !== 0) fail2('uv sync 失败');
        ok('uv sync');
      }
    }

    step(9, '数据迁移（node scripts/migrate.mjs）');
    if (dry) {
      if (run(process.execPath, [path.join(T, 'scripts/migrate.mjs'), '--repo', repo, '--dry-run']).code !== 0) warn('迁移预演失败');
    } else if (run(process.execPath, [path.join(repo, 'scripts/migrate.mjs'), '--repo', repo], { orig: true }).code !== 0) {
      fail2('数据迁移失败');
    }

    step(10, '重新生成派生文件 / 补做安装步骤');
    const overridesDir = path.join(repo, 'state', 'preset-overrides');
    const hasOverrides = fs.existsSync(overridesDir) && fs.readdirSync(overridesDir).some((n) => n.endsWith('.prefix.md'));
    const dshChanged = diffHas(/^(dsh|plugins)\//);
    const nodeInRepo = (script) => run(process.execPath, [path.join(repo, 'scripts', script)], { cwd: repo, orig: true }).code === 0;
    if (dshChanged || hasOverrides || restoredDerived) {
      if (dry) info('将运行 node scripts/build-agent-preset-patches.mjs');
      else {
        if (!nodeInRepo('build-agent-preset-patches.mjs')) fail2('重新生成 preset patch 失败');
        ok('已重新生成 preset patch');
      }
    }
    if (plan.SETUP_DSH === '1' || dshChanged) {
      if (dry) info('将运行 node scripts/setup-dsh.mjs');
      else {
        if (!nodeInRepo('setup-dsh.mjs')) fail2('setup-dsh.mjs 失败');
        ok('setup-dsh.mjs');
      }
    }
    if (ctx.linuxFlow && (plan.SYSTEMD === '1' || diffHas(/^scripts\/systemd\//))) {
      if (SD_UNITS.some(unitInstalled)) {
        if (dry) info('将重装 systemd 单元（bash scripts/systemd/install.sh，保持原来的开机自启状态）');
        else {
          const enabledState = (u) => sdctl(ctx, ['is-enabled', u], { capture: true }).stdout.trim();
          const was = SD_UNITS.map(enabledState);
          if (run('bash', ['scripts/systemd/install.sh'], { cwd: repo, orig: true }).code !== 0) fail2('重装 systemd 单元失败');
          SD_UNITS.forEach((u, i) => {
            const now = enabledState(u);
            if (was[i] === 'enabled' && now !== 'enabled') {
              if (sdctl(ctx, ['enable', u], { capture: true }).code !== 0) warn(`没能恢复 ${u} 的开机自启`);
            } else if (was[i] !== 'enabled' && now === 'enabled') {
              if (sdctl(ctx, ['disable', u], { capture: true }).code !== 0) warn(`没能恢复 ${u} 的开机自启状态`);
            }
          });
          ok('已重装 systemd 单元');
        }
      } else {
        info('systemd 单元没装，跳过');
      }
    }

    step(11, '重启受影响的服务（永远不碰 QQ、SnowLuma）');
    const ragOn = ragEnabled(repo);
    const services = [];
    for (const s of ['memory-rag', 'embedding', 'dsh', 'bridge']) {
      if (!has(plan.RESTART, s)) continue;
      if ((s === 'memory-rag' || s === 'embedding') && !ragOn) { info(`${s}：向量记忆没开（memoryRag.enabled 不是 true），不重启`); continue; }
      services.push(s);
    }
    const startCmd = startCommand();
    const bridgePidsPattern = '^node src/bridge.js$';
    const needsStartAll = (s) => s === 'dsh' || (s === 'bridge' && !unitInstalled('qq-bridge.service'));
    const describeRestart = (s) => {
      if (!ctx.linuxFlow) {
        if (s === 'dsh') return `${startCmd}（它会检查 DSH，需要重启时问你）`;
        if (s === 'bridge') return `停桥接，再 ${startCmd}`;
        return `${startCmd.replace('start-all', 'stop-all')} --rag，再 ${startCmd} --rag`;
      }
      if (s === 'memory-rag' || s === 'embedding') return unitInstalled(`qq-${s}.service`) ? `systemctl --user restart qq-${s}` : './stop-all.sh --rag && ./start-all.sh --rag';
      if (s === 'dsh') return `按 PID 逐个停 DSH（${dshPids(ctx).join(' ')}），再 ./start-all.sh`;
      return unitInstalled('qq-bridge.service') ? 'systemctl --user restart qq-bridge' : `停掉 node src/bridge.js（PID：${pgrepF(ctx, bridgePidsPattern).join(' ')}），再 ./start-all.sh`;
    };
    let ragScripted = false;
    const stopByPids = async (pids) => {
      for (const p of pids) sendSignal(ctx, 'TERM', p);
      if (pids.length) await waitGone(ctx, pids);
    };
    const doRestart = async (s) => {
      if (s === 'memory-rag' || s === 'embedding') {
        const unit = `qq-${s}.service`;
        if (ctx.linuxFlow && unitInstalled(unit)) return sdctl(ctx, ['restart', unit]).code === 0;
        if (ragScripted) return true;
        ragScripted = true;
        return stopAll(ctx, ['--rag']) && startAll(ctx, ['--rag']);
      }
      if (s === 'dsh') {
        if (!ctx.linuxFlow) return services.includes('bridge') ? true : startAll(ctx); // 桥接那一步的 start-all 会检查 DSH
        const pids = dshPids(ctx);
        if (!pids.length) info('没找到在跑的 DSH，直接起');
        await stopByPids(pids);
        return startAll(ctx);
      }
      if (!ctx.linuxFlow) return stopAll(ctx) && startAll(ctx);
      if (unitInstalled('qq-bridge.service')) return sdctl(ctx, ['restart', 'qq-bridge.service']).code === 0;
      await stopByPids(pgrepF(ctx, bridgePidsPattern));
      return startAll(ctx);
    };
    if (!services.length) {
      ok('不需要重启');
    } else {
      info('要重启（按顺序）：');
      for (const s of services) {
        const note = needsStartAll(s) && !hostRunning(ctx) ? `（${hostMissing(ctx)} 没在运行：会跳过这一项，不停也不起）` : '';
        info(`  - ${s}：${describeRestart(s)}${note}`);
      }
      if (dry) {
        info('（--dry-run：不重启）');
      } else if (await ask(ctx, '现在按顺序重启这些服务吗？')) {
        for (const s of services) {
          // 先检查再停：QQ / SnowLuma 不在跑就不动这个服务（保持旧版本在跑），免得 start-all 替用户把它们拉起来。
          if (needsStartAll(s) && !hostRunning(ctx)) {
            warn(`${hostMissing(ctx)} 没在运行，为了不替你启动它们，本脚本没有拉起 ${s}；请先登录 QQ，再运行 ${startCmd}`);
            info(`  ${s} 没停，仍是升级前的版本在跑；QQ 登录好以后请这样重启它：${describeRestart(s)}`);
            S.skipped.push(s);
            continue;
          }
          if (!(await doRestart(s))) fail2(`重启 ${s} 失败`);
          S.restarted.push(s);
          ok(`已重启 ${s}`);
        }
      } else {
        info('没有重启。之后请自己按上面的命令（在仓库目录里）依次执行。');
      }
    }

    step(12, '健康检查');
    if (dry) {
      info(`将检查桥接 /api/status${ragOn ? ' 与 memory-rag /health' : ''}`);
    } else if (!S.restarted.length) {
      info(`这次没有重启服务，跳过（重启后可再跑 ${updateCommand()} --check 确认版本）`);
    } else {
      if (S.skipped.includes('bridge')) {
        info('桥接这次跳过了重启，不检查');
      } else {
        if (!(await waitHealthy(ctx, 'bridge'))) fail2(`桥接 /api/status 在 ${healthWaitSeconds()} 秒内没有就绪`);
        ok('桥接正常');
      }
      if (ragOn) {
        if (!(await waitHealthy(ctx, 'rag'))) fail2('memory-rag /health 没有就绪（或处于只读模式）');
        ok('memory-rag 正常');
      }
    }

    step(13, '记录');
    if (dry) {
      info('将在 state/upgrade.json 追加一条记录（--dry-run 没写）');
      ok('预演完成，什么都没改');
    } else {
      const result = S.skipped.length ? 'ok-partial' : 'ok';
      record(result);
      // 只有升级成功才清理旧备份（失败时回滚还要用）。
      try {
        const pruned = pruneBackups(repo, ensureBackupDir(), [S.backup, S.firstRun]);
        if (pruned) info(`已清理 ${pruned} 份旧备份（升级备份、回滚前备份、首次迁移备份各只留最新 3 份）`);
      } catch { warn('清理旧备份失败（不影响升级）'); }
      if (result === 'ok-partial') ok(`升级完成（部分）：${S.oldLabel} → ${S.targetLabel}；没重启的：${S.skipped.join('、')}；备份 ${S.backup}`);
      else ok(`升级完成：${S.oldLabel} → ${S.targetLabel}；备份 ${S.backup}`);
      info(`出问题可回滚：${rollbackCommand()} ${S.backup}`);
    }
    S.handled = true;
  } catch (error) {
    if (error instanceof Exit) throw error;
    if (S.changed && !S.handled) {
      err(`升级中途出错（${error?.message ?? error}）`);
      record('failed');
      rollbackHint();
      throw new Exit(2);
    }
    err(error?.message ?? String(error));
    throw new Exit(1);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then(() => { process.exitCode = 0; }).catch((error) => {
  if (error instanceof Exit) { process.exitCode = error.code; return; }
  err(error?.stack ?? String(error));
  process.exitCode = 1;
});
