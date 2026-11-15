#!/usr/bin/env node
// setup-dsh.mjs — 安装渠道安全预设；按配置同步 QQ 预设、设置插件和 MCP server。
//
// 用法：
//   node scripts/setup-dsh.mjs            # 装进 web（dsh web）和 desktop（DSH 桌面版）两个 profile
//   node scripts/setup-dsh.mjs web        # 只装指定 profile（可写多个）
//   node scripts/setup-dsh.mjs --config=<file> web  # 使用指定的配置文件
//
// 桌面版固定使用 profiles/desktop，`dsh web` 默认使用 profiles/web；两边各有一份
// package.json / cordis.patch.yml，必须分别安装，否则换一个版本打开就没有 QQ 预设和 MCP。
// 不带参数时：web 总是装；desktop 在「已装桌面版或 profiles/desktop 已存在」时装。
// 可用环境变量 DSH_HOME 指定 DSH 根目录。
//
// 最后一行输出 `[setup-dsh] RESULT changed=<0|1> profiles=<…>`，供 start-all 判断是否需要重启 DSH。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
// UPGRADE_PATCH：effectiveSourceYaml —— 旧安装目录要和「生效版本」（出厂 + state/preset-overrides/）比，而不是只和出厂比。
import { BUNDLE_DIR, PRESETS, buildPatches, effectiveSourceYaml, patchFileFor } from './build-agent-preset-patches.mjs';
import { isQqEnabled } from '../src/runtime/channel-config.mjs';
import { commandSpec, findExecutable } from '../src/runtime/commands.mjs';
import { resolveStableNode } from '../src/runtime/node-bin.mjs';
import { findDshCli } from '../src/runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

// DSH 自带的 profile 模板（dsh-app-boot 的 PROFILE_TEMPLATES；桌面版也用 web 模板初始化 desktop）。
// profile 还不存在时必须带上它们，否则新建出来的 package.json 只有本项目的两个 bundle，
// DSH 会卡在「waiting for service: tools / settings / agentPresets」然后退出。
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** 桌面版是否装在这台机器上（dsh CLI 是桌面版的 Electron 垫片）。 */
function desktopInstalled() {
  const cli = findDshCli({ env: process.env });
  if (!cli) return false;
  try { return /ELECTRON_RUN_AS_NODE/i.test(fs.readFileSync(cli, 'utf8')); } catch { return false; }
}

function defaultProfiles() {
  const out = ['web'];
  if (fs.existsSync(path.join(DSH_HOME, 'profiles', 'desktop')) || desktopInstalled()) out.push('desktop');
  return out;
}

const args = process.argv.slice(2);
const configArgs = args.filter((arg) => arg.startsWith('--config='));
const explicitConfig = configArgs[0]?.slice('--config='.length);
if (configArgs.length > 1 || explicitConfig === '') fatal('Specify one nonempty --config=<file>');
const profileArgs = args.filter((arg) => !arg.startsWith('--config='));
const PROFILES = profileArgs.length ? [...new Set(profileArgs)] : defaultProfiles();
// 当前正在安装的 profile；下面的函数沿用原来的全局写法，由主循环逐个赋值。
let PROFILE = PROFILES[0];
// 本次是否改动了任何 DSH 侧文件（改了就要重启 DSH 才生效）。
let CHANGED = false;

// A profile is a directory name, never a path (same boundary as DSH itself).
for (const name of PROFILES) {
  if (name === '.' || name === '..' || name === 'node_modules'
      || /[\\/\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
    fatal(`invalid profile name: ${JSON.stringify(name)}`);
  }
}

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function readChannelConfig() {
  const file = explicitConfig ?? path.join(REPO_ROOT, 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      fatal('The channel configuration must be a JSON object');
    }
    return config;
  } catch (error) {
    if (error.code === 'ENOENT' && explicitConfig === undefined) return {};
    fatal(`无法读取渠道配置：${file}（${error.code ?? 'invalid JSON'}）`);
  }
}

const QQ_ENABLED = isQqEnabled(readChannelConfig());

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * 备份一个即将被覆盖的文件。
 *
 * 为什么不用 `flag: 'wx'`（写一次就永不更新）：那样第一次安装会留下一个备份，
 * 之后每次 setup 都静默跳过 —— 用户后来手工改过的内容再被覆盖时，桌上那份备份
 * 早已过期，等于「有备份但救不回来」。改为每次覆盖前打时间戳快照，只保留最近 N 份。
 */
function backupBeforeOverwrite(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch (error) {
    log(`⚠️ 备份失败（${file}）：${error?.message ?? error}；继续但请自行确认原内容`);
    return null;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    // 时间戳升序 ⇒ 前面的是最旧的，只保留最后 keep 份
    for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {}
  return dest;
}

// ── agent preset：DSH 0.1.7 机制 ─────────────────────────────────────────────
//
// 0.1.5：preset 是 ~/.dsh/.agent-presets/<preset>/ 下的目录，DSH 启动时扫目录装载。
// 0.1.7：注册表既不扫目录也不接受 preset 路径；preset 是一条普通 loader 行
//        （@deepseek-ai/dsh-agent-preset，config.plugins 内联子行列表），
//        由 bundle 的 patch 文件插入。因此这里做两件事：
//          ① 把 qq-agent-presets bundle 注册进 profile（link: 依赖 + bundles + junction）；
//          ② 从仓库权威源（dsh/agent-presets/<preset>/）重新生成 patch 文件。
//        旧目录不再写入、也不删除（见 reportLegacyPresetDir）。
const QQ_BUNDLES = ['qq-mode-console', 'qq-agent-presets'];
const CHANNEL_BUNDLE = 'channel-agent-presets';
const MANAGED_BUNDLES = [...QQ_BUNDLES, CHANNEL_BUNDLE];
const ACTIVE_BUNDLES = QQ_ENABLED ? MANAGED_BUNDLES : [CHANNEL_BUNDLE];

/** 从仓库源重新生成 bundle 里的 patch 文件（人格正文/工具面改了就必须重跑）。 */
function regeneratePresetPatches() {
  const results = buildPatches({ log: () => {} });
  for (const { file, changed } of results) {
    if (changed) CHANGED = true;
    log(`preset patch ${changed ? '已生成' : '已是最新'}: ${path.relative(REPO_ROOT, file)}`);
  }
  for (const name of PRESETS) {
    const file = patchFileFor(name);
    if (!fs.existsSync(file)) fatal(`preset patch 未生成：${file}`);
  }
}

/**
 * 旧机制的安装目录：0.1.7 起 DSH 完全不再读它。
 *
 * 这里**只报告、不删除**——里面可能是用户手改过的人设（仓库源文件救不回来）。
 * 顺带对比仓库源：一致说明没丢东西，不一致说明用户改的那份已不再生效，需要人工合并。
 */
function reportLegacyPresetDir() {
  const legacy = path.join(DSH_HOME, '.agent-presets');
  if (!fs.existsSync(legacy)) return;
  log(`注意：${legacy} 是 DSH 0.1.5 的 preset 安装目录，0.1.7 起不再被读取（保留未删，可自行备份后清理）`);
  for (const name of PRESETS) {
    const installed = path.join(legacy, name, 'agent.cordis.yml');
    if (!fs.existsSync(installed)) continue;
    // UPGRADE_PATCH：用户改的提示词现在放在 state/preset-overrides/<preset>.prefix.md（控制台写），
    // 生效版本 = 出厂 + 覆盖；没有覆盖时就是出厂原文，与改动前的比较完全一样。
    let effective = null;
    try { effective = effectiveSourceYaml(name, REPO_ROOT); } catch {}
    const same = effective !== null && fs.readFileSync(installed, 'utf8') === effective;
    log(same
      ? `  · ${name}：旧目录副本与当前生效的预设一致（无内容丢失）`
      : `  ⚠️ ${name}：旧目录副本与当前生效的预设**不一致**——那份手改内容不会再生效；提示词部分请到控制台「仿真提示词」页重新保存（会存进 state/preset-overrides/${name}.prefix.md），不要改 dsh/agent-presets/${name}/agent.cordis.yml`);
  }
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 这些 id 由安装脚本托管。关闭 QQ 时只移除 SnowLuma MCP，通用网页查询仍可供普通 DSH 会话使用。
const QQ_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host'];
const MANAGED_MCP_IDS = [...QQ_MCP_IDS, 'mcp-web-search-safe'];
const MANAGED_INSERT_IDS = QQ_ENABLED
  ? MANAGED_MCP_IDS
  : [...MANAGED_MCP_IDS, 'qq-mode', ...PRESETS.map((name) => `preset-${name}`)];

// MCP 的 command 是「写一次、长期用」的绝对路径：DSH 每次启动都按它拉进程。
// 所以不能直接用 process.execPath —— 便携版/沙箱里的 node 被回收后，三个 MCP
// 会同时失效，日志只会说「MCP 启动失败」。优先换成系统安装的 node。
const MCP_NODE = resolveStableNode();

function reportMcpNode() {
  if (MCP_NODE.source === 'explicit') {
    log(`MCP node（QQ_BRIDGE_NODE_BIN）：${MCP_NODE.command}`);
    return;
  }
  if (MCP_NODE.ephemeral) {
    log(`⚠️ 当前 node 位于临时/便携目录，可能被宿主回收，届时 DSH 里所有 MCP 都会启动失败：`);
    log(`   ${MCP_NODE.command}`);
    log('   建议安装系统版 Node，或显式指定：set QQ_BRIDGE_NODE_BIN=C:\\Program Files\\nodejs\\node.exe');
    return;
  }
  log(`MCP node：${MCP_NODE.command}（${MCP_NODE.source}）`);
}

function mcpEntries() {
  const node = MCP_NODE.command;
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(REPO_ROOT, 'src', 'mcp-host-server.js') },
    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  for (const [id, s] of Object.entries(servers)) {
    if (!QQ_ENABLED && QQ_MCP_IDS.includes(id)) continue;
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${s.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(s.script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (s.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${s.toolCallTimeoutMs}\n`;
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function prepareCordisPatch() {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Repair only the historical invalid *root* [] followed by block operations.
  // A nested [] or a line inside a literal scalar is user data and must survive.
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try { doc = yaml.load(lines.join('\n')) ?? []; }
  catch (error) { fatal(`failed to parse ${patchFile}; file unchanged: ${error.message}`); }
  if (!Array.isArray(doc)) fatal(`${patchFile} must contain a YAML array; file unchanged`);
  let removed = 0;
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`invalid patch operation in ${patchFile}; file unchanged`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`insert must be an array in ${patchFile}; file unchanged`);
    const entries = operation.insert.filter((entry) => {
      if (!MANAGED_INSERT_IDS.includes(entry?.id)) return true;
      removed++;
      return false;
    });
    // Retain shared insert parents and their selectors/other operation fields.
    if (entries.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  const managed = mcpEntries();
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '') + managed;
  // 托管条目已经和要写的一模一样时**不动文件**：DSH 自己（尤其桌面版）会往这个
  // 文件末尾追加设置项，按文本比较会把「只是顺序 / 引号不同」误判成改动，既白白重写用户文件，
  // 又让 start-all 以为必须重启 DSH。
  const managedNow = [];
  for (const operation of doc) {
    for (const entry of operation.insert ?? []) if (MANAGED_INSERT_IDS.includes(entry?.id)) managedNow.push(entry);
  }
  const wanted = yaml.load(managed).flatMap((operation) => operation.insert);
  const unchanged = JSON.stringify(managedNow) === JSON.stringify(wanted);
  return { patchFile, original, text: unchanged ? original : text, removed, installed: wanted.length };
}

function patchCordis({ patchFile, original, text, removed, installed }) {
  ensureDir(path.dirname(patchFile));
  // Parsing/serialization normalizes formatting; keep the original text (including comments).
  if (original && original !== text) {
    backupBeforeOverwrite(patchFile);
  }
  if (original === text) {
    log(`cordis.patch.yml: MCP 条目已是最新（${PROFILE}）`);
    return;
  }
  CHANGED = true;
  const temporary = `${patchFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, patchFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${removed} 条，写入 ${installed} 条）`);
}

/**
 * 建一个指向本仓库的目录链接（Windows 用 junction，免管理员权限）。
 *
 * 链接已存在时校验指向：指向本仓库 ⇒ 跳过（幂等）；指向别处/悬空 ⇒ 重建。
 * 指向别处说明用户手工挪过文件，这里按"重装"处理并明确打印。
 */
function ensureDirLink(linkPath, targetDir, label) {
  if (!fs.existsSync(targetDir)) fatal(`${label} 源目录不存在: ${targetDir}`);
  ensureDir(path.dirname(linkPath));

  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`failed to inspect ${label}: ${error?.message ?? error}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`${label} 已存在且不是符号链接/junction: ${linkPath}。请先手工移走或删除，然后重跑。`);
    }
    let sameTarget = false;
    try {
      const target = fs.realpathSync(linkPath);
      const expected = fs.realpathSync(targetDir);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`${label} 已存在且指向本仓库: ${linkPath}`);
      return linkPath;
    }
    log(`${label} 存在但指向别处/失效，重建: ${linkPath}`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  CHANGED = true;
  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(targetDir, linkPath, 'junction');
    } else {
      fs.symlinkSync(targetDir, linkPath, 'dir');
    }
    log(`${label} 已创建: ${linkPath}`);
  } catch (e) {
    fatal(`failed to create ${label}: ${e.message}`);
  }
  return linkPath;
}

/**
 * 把仓库里的 bundle 包接进 profile。
 *
 * 两层链接，与 `dsh plugin install`（pnpm）物化出的形态一致：
 *   ~/.dsh/plugins/<name>  → 仓库目录（人工可读的"安装位"）
 *   <profile>/node_modules/<name> → ~/.dsh/plugins/<name>（Node 解析路径）
 * 第二层必须自己建：preset 子行按 profile 目录解析裸说明符
 * （qq-agent-presets/qq-tool-restrict.mjs），缺了它 preset 会整条挂载失败。
 */
function ensureBundle(name) {
  const repoDir = name === 'qq-agent-presets' ? BUNDLE_DIR : path.join(REPO_ROOT, 'plugins', name);
  const linkDir = ensureDirLink(path.join(DSH_HOME, 'plugins', name), repoDir, `bundle ${name} link`);
  ensureDirLink(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', name), linkDir, `bundle ${name} node_modules link`);
  return linkDir;
}

function patchProfilePackage(links) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  // 新建时按 DSH 自己的模板带上基础 bundle（见 BASE_BUNDLES 的说明）。
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [...BASE_BUNDLES] } } };
  let originalText = '';
  if (fs.existsSync(pkgFile)) {
    try {
      originalText = fs.readFileSync(pkgFile, 'utf8');
      pkg = JSON.parse(originalText.charCodeAt(0) === 0xfeff ? originalText.slice(1) : originalText);
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  // 修复旧版 setup 在「profile 不存在」时留下的残缺清单：只有本项目的 bundle、
  // 一个 DSH 自带 bundle 都没有（DSH 起不来）。用户自己的第三方 bundle 不在此列，原样保留。
  const ours = new Set(MANAGED_BUNDLES);
  if (pkg.dsh.profile.bundles.length && pkg.dsh.profile.bundles.every((name) => ours.has(name))) {
    pkg.dsh.profile.bundles.unshift(...BASE_BUNDLES);
    log(`package.json 缺少 DSH 基础 bundle，已补上：${BASE_BUNDLES.join(', ')}`);
  }
  if (!QQ_ENABLED) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => !QQ_BUNDLES.includes(name));
    for (const name of QQ_BUNDLES) delete pkg.dependencies[name];
  }
  for (const [name, linkDir] of Object.entries(links)) {
    const linkVal = `link:${linkDir.replace(/\\/g, '/')}`;
    if (pkg.dependencies[name] !== linkVal) {
      pkg.dependencies[name] = linkVal;
      log(`package.json dependency ${name} -> ${linkVal}`);
    }
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
      log(`package.json bundle added: ${name}`);
    }
  }
  const nextText = `${JSON.stringify(pkg, null, 2)}\n`;
  if (nextText !== originalText) {
    fs.writeFileSync(pkgFile, nextText, 'utf8');
    CHANGED = true;
  }
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  // DSH 0.1.5 起不再有 'router-standard' preset；留空表示「用 DSH 自己声明的默认 preset」，
  // 由 bridge.js 的 resolvePresetName() 兜底（硬编码已下线的名字只会换来每次启动的误导性告警）。
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// bundle 以 link: 依赖注册进 profile package.json 后，DSH 首次启动
// 需要先安装一次才能解析这些 bundle（否则 cold start 报 "cannot resolve profile bundle"）。
// dsh CLI 可用时自动执行。
function autoInstallProfileBundles() {
  if (process.env.QQ_BRIDGE_SKIP_DSH_INSTALL === '1') {
    log('auto-install skipped: QQ_BRIDGE_SKIP_DSH_INSTALL=1');
    return;
  }
  // 不再硬编码 'dsh.cmd'：dsh 可能装在非 PATH 目录、也可能是原生 dsh.exe。
  // QQ_BRIDGE_DSH_BIN 允许显式指定；否则 findDshCli 会按 PATH → 桌面版标准安装目录 →
  // 各盘便携目录的顺序找（桌面版装完不加 PATH 是常态）。
  // 找到之后交给 commandSpec 处理 Windows 的 .cmd 垫片
  // （Electron 启动器回退 cmd.exe，普通 npm 垫片解析成 node + JS）。
  const dshName = findDshCli({ env: process.env }) || 'dsh';
  let spec;
  try {
    spec = commandSpec(dshName, ['plugin', '--profile', PROFILE, 'install'], { env: process.env });
  } catch (error) {
    log(`auto-install 未能准备命令（${error?.message ?? error}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  const manual = findExecutable(dshName, { env: process.env });
  let command = spec.command;
  let args = spec.args;
  // 桌面版 dsh.cmd 被解析成「DeepSeek Harness.exe + ELECTRON_RUN_AS_NODE=1」，env 必须带上。
  let spawnEnv = spec.env ? { ...process.env, ...spec.env } : process.env;
  let verbatim = Boolean(spec.windowsVerbatimArguments);
  if (spec.via === 'cmd-shim') {
    // 走 cmd.exe 时**不能**把 profile 直接拼进命令行：cmd 会对命令行再做一次
    // %VAR% 展开，`test&name%CD%!` 这样的 profile 会被改写甚至执行。改成固定命令行
    // + 环境变量单次展开（/v:off 保留 '!'），profile 已经在上面校验过不含引号。
    // `/s /c` 会剥掉整行首尾各一个引号，所以整行再包一层，带空格的垫片路径才不会被截断。
    const exe = /\s/.test(spec.resolved) ? `"${spec.resolved}"` : spec.resolved;
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/v:off', '/s', '/c', `"${exe} plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install"`];
    spawnEnv = { ...process.env, QQ_BRIDGE_SETUP_PROFILE: PROFILE };
    verbatim = true;
  }
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: spawnEnv,
    ...(verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  if (r.error) {
    log(`auto-install failed to start/complete（${r.error.code || r.error.message}）。`);
    log(manual
      ? `已找到 dsh：${manual}；若 DSH 启动报“cannot resolve profile bundle”，请手动执行：dsh plugin --profile ${PROFILE} install`
      : `PATH 里没有 dsh，可用 QQ_BRIDGE_DSH_BIN 指定 dsh.cmd 的完整路径，然后重跑；或手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
    const hint = String(r.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' | ');
    if (hint) log(`  输出：${hint}`);
  }
}

// Validate every profile's existing YAML before changing any presets or configuration.
const prepared = PROFILES.map((name) => {
  PROFILE = name;
  return { name, cordisPatch: prepareCordisPatch() };
});
if (QQ_ENABLED) regeneratePresetPatches();
reportMcpNode();
const changedProfiles = [];
for (const { name, cordisPatch } of prepared) {
  PROFILE = name;
  log(`── profile: ${name} ──`);
  const before = CHANGED;
  CHANGED = false;
  patchCordis(cordisPatch);
  const links = {};
  for (const bundle of ACTIVE_BUNDLES) links[bundle] = ensureBundle(bundle);
  patchProfilePackage(links);
  // 文件都没变且 pnpm 状态已在时不再跑 install（每次都跑要十几秒）。
  const installed = fs.existsSync(path.join(DSH_HOME, 'profiles', name, 'node_modules', '.modules.yaml'));
  if (CHANGED || !installed) autoInstallProfileBundles();
  else log(`dsh plugin --profile ${name} install: 无改动，跳过`);
  if (CHANGED) changedProfiles.push(name);
  CHANGED = before || CHANGED;
}
if (QQ_ENABLED) {
  reportLegacyPresetDir();
  ensureLocalModeFile();
}
log(CHANGED
  ? 'Done. Restart DSH (or reload the profile) so the new presets/MCP take effect.'
  : 'Done. DSH 侧已是最新，无需重启。');
log(`RESULT changed=${CHANGED ? 1 : 0} profiles=${PROFILES.join(',')} changedProfiles=${changedProfiles.join(',')}`);
