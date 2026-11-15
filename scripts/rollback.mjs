#!/usr/bin/env node
// UPGRADE_PATCH：回到升级前（Linux / Windows 共用；入口 scripts/rollback.sh、rollback.bat 只是一层转发）。
//
// 用法：
//   node scripts/rollback.mjs [--yes] [<备份文件>]
//     缺省用 state/upgrade.json 里最后一条升级记录的备份；给了备份文件就找对应的那条记录（要它的 fromCommit）。
//
// 做什么：停桥接 / memory-rag → git checkout --detach <升级前的提交> → 把当前 state/、config.json 再打包一份
//   （rollback-pre-<时间>.tar.gz）→ 解包备份覆盖 state/、config.json → 首次迁移挪走的文件放回原处 →
//   恢复旧版依赖、重新生成派生 patch → 起服务 → 健康检查 → 记 result: rolled-back。
// 永远不碰 QQ、SnowLuma；DSH 只在那次升级重启过它时才重启，而且只按 PID 逐个停。
//
// 退出码：0 回滚完成；1 检查没通过（什么都没改）；2 中途失败；3 用户取消。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DERIVED, Exit, RAG_EXCLUDES, ask, binOf, createContext, dshPids, ensureBackupDir, err, git, gitOk, gitOut, hostMissing, hostRunning,
  info, ok, pgrepF, ragEnabled, restoreFirstRun, rollbackCommand, run, sdctl, sendSignal, startAll, startCommand, stepper, stopAll,
  tarCreate, tarExtract, tarList, timestamp, ujFind, ujPutRolledBack, unitInstalled, waitGone, waitHealthy, warn
} from './lib/upgrade-common.mjs';

const SELF = fileURLToPath(import.meta.url);
const step = stepper(8);

function missingRequiredQqSdk(repo) {
  if (fs.existsSync(path.join(repo, 'src', 'runtime', 'channel-config.mjs'))) return false;
  const manifest = path.join(repo, 'package.json');
  if (!fs.existsSync(manifest)) return false;
  const config = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
  if (!config?.dependencies?.['@snowluma/sdk'] || config.optionalDependencies?.['@snowluma/sdk']) return false;
  return !fs.statSync(path.join(repo, 'node_modules', '@snowluma', 'sdk', 'package.json'), { throwIfNoEntry: false })?.isFile();
}

function removeUnavailableChannelBundle(repo) {
  const name = 'channel-agent-presets';
  const bundle = path.join(fs.realpathSync(repo), 'plugins', name);
  if (fs.existsSync(path.join(bundle, 'package.json'))) return [];
  const home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const installLink = path.join(home, 'plugins', name);
  function normalizePath(file) {
    const normalized = path.normalize(file);
    if (process.platform !== 'win32') return normalized;
    return normalized.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase();
  }
  let target;
  try { target = fs.readlinkSync(installLink); }
  catch (error) {
    if (['ENOENT', 'EINVAL', 'UNKNOWN'].includes(error.code)) return [];
    throw error;
  }
  // readlink also works after checkout removed the link's target from the repository.
  const linkedToRepo = normalizePath(path.resolve(path.dirname(installLink), target)) === normalizePath(bundle);
  if (!linkedToRepo) return [];
  const profilesDir = path.join(home, 'profiles');
  let entries;
  try { entries = fs.readdirSync(profilesDir, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const changed = [];
  for (const profile of entries) {
    if (!profile.isDirectory() || profile.name === 'node_modules' || profile.name.startsWith('-')
      || /[\\/\x00-\x1f<>:"|?*]|[. ]$/.test(profile.name)) continue;
    const file = path.join(profilesDir, profile.name, 'package.json');
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    let manifest;
    const contents = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    try { manifest = JSON.parse(contents); }
    catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const dependency = manifest?.dependencies?.[name];
    if (typeof dependency !== 'string' || !dependency.startsWith('link:')
      || normalizePath(dependency.slice('link:'.length)) !== normalizePath(installLink)) continue;
    delete manifest.dependencies[name];
    const settings = manifest.dsh?.profile;
    if (Array.isArray(settings?.bundles)) settings.bundles = settings.bundles.filter((id) => id !== name);
    const temporary = `${file}.rollback-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    changed.push(profile.name);
  }
  return changed;
}

async function main() {
  process.umask(0o077);
  let yes = false;
  let backupArg = '';
  for (const a of process.argv.slice(2)) {
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(SELF, 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      throw new Exit(0);
    } else if (a.startsWith('-')) { err(`未知参数：${a}（可用：--yes [<备份文件>]）`); throw new Exit(1); }
    else if (backupArg) { err('只能给一个备份文件'); throw new Exit(1); }
    else backupArg = a;
  }
  const ctx = createContext(path.resolve(path.dirname(SELF), '..'));
  ctx.yes = yes;
  const { repo } = ctx;
  const G = (args, o) => git(ctx, args, o);
  const S = { changed: false, handled: false, preBackup: '' };
  const die1 = (msg) => { err(msg); S.handled = true; throw new Exit(1); };
  const fail2 = (msg) => {
    err(`回滚失败：${msg}`);
    if (S.preBackup) err(`回滚前的数据另存在 ${S.preBackup}`);
    S.handled = true;
    throw new Exit(2);
  };

  try {
    step(1, '找升级记录');
    if (!fs.existsSync(path.join(repo, 'src', 'bridge.js')) || !fs.existsSync(path.join(repo, '.git'))) die1(`${repo} 不像 qq-bridge 仓库`);
    if (fs.existsSync(path.join(repo, 'docs', 'design', 'HANDOFF.md'))) die1('这个目录里有 docs/design/HANDOFF.md（作者本机的线上目录），不要用 rollback.sh');
    let entry;
    try { entry = ujFind(repo, backupArg); } catch { entry = null; }
    if (!entry) die1(`state/upgrade.json 里找不到${backupArg ? '这个备份的' : ''}升级记录，不知道该回到哪个提交`);
    const fromCommit = String(entry.fromCommit ?? '').replace(/[^0-9a-f]/g, '');
    const restarted = Array.isArray(entry.restarted) ? entry.restarted : [];
    const backup = backupArg || String(entry.backup ?? '');
    if (!fromCommit || !gitOk(ctx, ['cat-file', '-e', `${fromCommit}^{commit}`])) die1(`记录里的升级前提交不存在：${fromCommit || '（空）'}`);
    if (!fs.existsSync(backup)) {
      if (entry.backupPruned === true) die1(`这次升级的备份已经按保留规则清理掉了（每类只留最新 3 份）：${backup}。没法用它回滚；可以指定 ~/qq-bridge-backups/ 里还在的备份：${rollbackCommand()} <备份文件>`);
      die1(`备份文件不存在：${backup}（可能被手动删了）。请指定 ~/qq-bridge-backups/ 里还在的备份：${rollbackCommand()} <备份文件>`);
    }
    // 备份里只许有 state/ 与 config.json，防止解包写到别处。
    const names = tarList(backup);
    if (names.some((n) => !/^(state(\/|$)|config\.json$)/.test(n))) die1('备份文件里有 state/、config.json 以外的东西，拒绝解包');
    if (names.some((n) => /(^|\/)\.\.(\/|$)/.test(n))) die1('备份文件里有 .. 路径，拒绝解包');
    ok(`记录：${entry.from} → ${entry.to}`);

    step(2, '确认');
    info(`将回到提交 ${fromCommit}（${entry.from}）`);
    info(`将用备份还原 state/ 与 config.json：${backup}`);
    info('当前的 state/、config.json 会先另存一份');
    if (!(await ask(ctx, '确定回滚吗？'))) { info('已取消，什么都没改'); S.handled = true; throw new Exit(3); }

    step(3, '检查工作区');
    const dirty = G(['status', '--porcelain=v1', '--untracked-files=all', '--no-renames']).stdout.split(/\r?\n/).filter(Boolean)
      .filter((l) => !DERIVED.some((d) => l.includes(d)));
    if (dirty.length) die1(`工作区有改动（${dirty.length} 个文件），先自己处理再回滚`);
    ok('工作区干净');

    step(4, '停桥接 / memory-rag（不碰 QQ、SnowLuma）');
    const stopByPids = async (pids) => {
      for (const p of pids) sendSignal(ctx, 'TERM', p);
      if (pids.length) await waitGone(ctx, pids);
    };
    S.changed = true;
    if (!ctx.linuxFlow) {
      if (!stopAll(ctx)) fail2('停桥接失败');
    } else if (unitInstalled('qq-bridge.service')) {
      if (sdctl(ctx, ['stop', 'qq-bridge.service']).code !== 0) fail2('停桥接失败');
    } else {
      await stopByPids(pgrepF(ctx, '^node src/bridge.js$'));
    }
    ok('桥接已停');
    if (ragEnabled(repo)) {
      if (ctx.linuxFlow && unitInstalled('qq-memory-rag.service')) {
        if (sdctl(ctx, ['stop', 'qq-memory-rag.service']).code !== 0) fail2('停 memory-rag 失败');
      } else if (!stopAll(ctx, ['--rag'])) {
        fail2('停向量记忆失败');
      }
      ok('memory-rag 已停');
    }

    step(5, `代码回到 ${fromCommit}`);
    for (const f of DERIVED) {
      if (gitOk(ctx, ['cat-file', '-e', `HEAD:${f}`])) G(['checkout', 'HEAD', '--', f], { orig: true });
    }
    if (G(['checkout', '--quiet', '--detach', fromCommit], { orig: true }).code !== 0) fail2('git checkout --detach 失败');
    ok(`HEAD = ${gitOut(ctx, ['rev-parse', '--short', 'HEAD'])}`);

    step(6, '还原 state/ 与 config.json');
    const backupDir = ensureBackupDir();
    let pre = path.join(backupDir, `rollback-pre-${timestamp()}.tar.gz`);
    for (let n = 1; fs.existsSync(pre); n += 1) pre = pre.replace(/(-\d+)?\.tar\.gz$/, `-${n}.tar.gz`);
    const t = tarCreate(repo, pre, RAG_EXCLUDES);
    if (!t.ok) fail2(`另存当前数据失败（tar 退出码 ${t.code}）`);
    try { fs.chmodSync(pre, 0o600); } catch { /* Windows */ }
    S.preBackup = pre;
    info(`当前数据另存在 ${pre}`);
    if (!tarExtract(backup, repo)) fail2('解包备份失败');
    ok('已用备份还原');
    const firstRun = String(entry.firstRunBackup ?? '');
    if (firstRun && fs.existsSync(path.join(firstRun, 'manifest.json'))) {
      let cnt;
      try { cnt = restoreFirstRun(repo, firstRun); } catch { fail2('放回首次迁移挪走的文件失败'); }
      ok(`首次迁移挪走的 ${cnt} 个文件已放回原处`);
    }

    step(7, '重新生成派生 patch、起服务');
    if (missingRequiredQqSdk(repo)) {
      const npm = binOf(ctx, 'npm');
      if (!npm || run(npm, ['ci'], { cwd: repo, orig: true }).code !== 0 || missingRequiredQqSdk(repo)) {
        fail2('旧版必需的 SnowLuma SDK 未恢复，请在当前版本运行 npm ci');
      }
      ok('已安装旧版所需的 SnowLuma SDK');
    }
    if (fs.existsSync(path.join(repo, 'scripts', 'build-agent-preset-patches.mjs'))
      && run(process.execPath, [path.join(repo, 'scripts', 'build-agent-preset-patches.mjs')], { cwd: repo, orig: true }).code !== 0) {
      fail2('重新生成 preset patch 失败');
    }
    const profiles = removeUnavailableChannelBundle(repo);
    if (profiles.length) {
      const setup = path.join(repo, 'scripts', 'setup-dsh.mjs');
      if (fs.existsSync(setup) && run(process.execPath, [setup, ...profiles], { cwd: repo, orig: true }).code !== 0) {
        fail2('恢复升级前的 DSH 预设失败，请在当前版本重新运行 node scripts/setup-dsh.mjs');
      }
      info('已同步升级前的 DSH profile，请重新载入 profile 以应用配置');
    }
    const ragOn = ragEnabled(repo);
    if (ragOn) {
      if (ctx.linuxFlow && unitInstalled('qq-memory-rag.service')) {
        if (sdctl(ctx, ['start', 'qq-memory-rag.service']).code !== 0) fail2('起 memory-rag 失败');
      } else if (!startAll(ctx, ['--rag'])) {
        fail2('起向量记忆失败');
      }
    }
    // 要走 start-all（不带 --rag）之前先确认 QQ、SnowLuma 都在跑，否则 Linux 上 start-all 会替用户把它们拉起来。
    // 桥接在第 4 步已经停了（还原数据时不能有桥接在写），这里只是不起它、提示用户。
    const hostOk = hostRunning(ctx);
    const skipped = [];
    const startCmd = startCommand();
    const skipStart = (what) => {
      warn(`${hostMissing(ctx)} 没在运行，为了不替你启动它们，本脚本没有拉起 ${what}；请先登录 QQ，再运行 ${startCmd}`);
      skipped.push(what);
    };
    const needDsh = restarted.includes('dsh');
    if (needDsh && ctx.linuxFlow) {
      if (hostOk) {
        await stopByPids(dshPids(ctx));
        info('DSH 已按 PID 停（那次升级重启过它，回滚后也要重启）');
      } else {
        skipStart('dsh');
        info(`  DSH 没停，仍是升级后的版本在跑；QQ 登录好以后请按 PID 停掉它再运行 ${startCmd}`);
      }
    }
    if (ctx.linuxFlow && unitInstalled('qq-bridge.service')) {
      if (sdctl(ctx, ['start', 'qq-bridge.service']).code !== 0) fail2('起桥接失败');
      if (needDsh && hostOk && !startAll(ctx)) fail2('起 DSH 失败');
    } else if (hostOk) {
      if (!startAll(ctx)) fail2(`起桥接失败（${startCmd}）`);
    } else {
      skipStart('bridge');
      info(`  桥接现在是停着的；QQ 登录好以后运行 ${startCmd} 把它起来`);
    }
    ok(`服务已起${skipped.length ? `（没起的：${skipped.join('、')}）` : ''}`);

    step(8, '健康检查');
    let health = 'ok';
    if (skipped.includes('bridge')) info('桥接这次没起，不检查');
    else if (!(await waitHealthy(ctx, 'bridge'))) health = 'fail';
    // 回到的老版本 memory-rag 没有 schema 字段也算正常（readonly 只在新版本里才可能为 true）。
    if (health === 'ok' && ragOn && !(await waitHealthy(ctx, 'rag'))) health = 'fail';
    try { ujPutRolledBack(repo, entry, { preBackup: pre, health, skipped }); } catch { warn('没能写 state/upgrade.json'); }
    if (health !== 'ok') {
      err('代码和数据已回到升级前，但健康检查没通过：请看 ~/.ai-companion-run/ 下的日志');
      S.handled = true;
      throw new Exit(2);
    }
    ok(`回滚完成：HEAD = ${gitOut(ctx, ['rev-parse', '--short', 'HEAD'])}；回滚前的数据另存在 ${pre}`);
    S.handled = true;
  } catch (error) {
    if (error instanceof Exit) throw error;
    if (S.changed && !S.handled) {
      err(`回滚中途出错（${error?.message ?? error}）；当前数据另存在 ${S.preBackup || '（还没来得及打包）'}`);
      throw new Exit(2);
    }
    err(error?.message ?? String(error));
    throw new Exit(1);
  }
}

main().then(() => { process.exitCode = 0; }).catch((error) => {
  if (error instanceof Exit) { process.exitCode = error.code; return; }
  err(error?.stack ?? String(error));
  process.exitCode = 1;
});
