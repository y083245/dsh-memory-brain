#!/usr/bin/env node
// CI：用真实的 DSH 核对 QQ 和新渠道预设的注册与会话创建。
//
//   node scripts/ci-dsh-compat.mjs             # PATH 里的 dsh，web profile
//   node scripts/ci-dsh-compat.mjs --desktop   # 已安装的桌面版：按它 main 进程的方式无界面拉起 Host（Windows）
//
// 全部用隔离的 DSH_HOME，不碰本机已有的 ~/.dsh；不需要模型密钥，不发真实请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-dsh-compat-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = path.join(home, '.dsh');
for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'DSH_CHANNEL_TOOL_PORT', 'DSH_CHANNEL_TOOL_SECRET']) delete process.env[key];
const desktop = process.argv.includes('--desktop');

const { commandSpec, resolveElectronShim } = await import('../src/runtime/commands.mjs');
const { findDshCli } = await import('../src/runtime/paths.mjs');
const { checkDshPresets, diagnosePresetProfile } = await import('../src/dsh-discovery.js');
const { NodeApiClient, unwrap } = await import('../src/dsh-client.js');
const { CHANNEL_DSH_PRESET, CHANNEL_DSH_TEXT_PRESET, confirmChannelPreset } = await import('../src/core/channel-dsh-preset.mjs');
const { createChannelSessionId } = await import('../src/core/channel-turn-runner.mjs');
const { encodeConversationKey } = await import('../src/core/identity.mjs');

const cli = findDshCli({ env: process.env });
if (!cli) { console.error('找不到 dsh'); process.exit(1); }
console.log(`dsh CLI: ${cli}`);
const version = commandSpec(cli, ['--version'], { env: process.env, nodeBin: process.execPath });
const versionRun = spawnSync(version.command, version.args, { encoding: 'utf8', env: { ...process.env, ...version.env }, windowsVerbatimArguments: version.windowsVerbatimArguments });
console.log(`dsh version: ${String(versionRun.stdout ?? '').trim()}`);

const configFile = path.join(ROOT, 'config.json');
if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(ROOT, 'config.example.json'), configFile);

const profile = desktop ? 'desktop' : 'web';
const setup = spawnSync(process.execPath, ['scripts/setup-dsh.mjs', profile], { cwd: ROOT, encoding: 'utf8', env: process.env });
console.log(setup.stdout.split(/\r?\n/).filter((l) => /RESULT|install|ERROR|失败/.test(l)).join('\n'));
if (setup.status !== 0) { console.error(setup.stderr); process.exit(1); }

/** 启动 Host，返回 { child, baseUrl: Promise<string> }。 */
function startHost() {
  if (!desktop) {
    const port = 13080;
    const spec = commandSpec(cli, ['--profile', 'web', '--no-open', '--port', String(port)], { env: process.env, nodeBin: process.execPath });
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env }, stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, detached: process.platform !== 'win32'
    });
    return { child, baseUrl: Promise.resolve(`http://127.0.0.1:${port}`) };
  }
  // 桌面版不让 CLI 用 desktop profile（「managed exclusively by the Electron application」），
  // 所以照 apps/desktop/src/host-process.ts 的参数和 IPC 直接拉 Host，不开窗口。
  const exe = resolveElectronShim(cli)?.command;
  if (!exe || !fs.existsSync(exe)) { console.error('找不到桌面版主程序'); process.exit(1); }
  const resources = path.join(path.dirname(exe), 'resources');
  const runtimeDir = path.join(resources, 'app.asar', 'dsh');
  const entry = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js');
  const profileDir = path.join(process.env.DSH_HOME, 'profiles', 'desktop');
  const child = spawn(exe, ['--expose-internals', entry, runtimeDir, profileDir, path.join(resources, 'runtime', 'primary-runtime')], {
    cwd: profileDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true
  });
  const baseUrl = new Promise((resolve, reject) => {
    child.on('message', (m) => {
      if (m?.type === 'ready') resolve(new URL(m.url).origin);
      if (m?.type === 'fatal') reject(new Error(`Host fatal: ${JSON.stringify(m).slice(0, 2000)}`));
    });
    child.on('exit', (code) => reject(new Error(`Host 提前退出：${code}`)));
  });
  return { child, baseUrl };
}

function stopHost(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(desktop ? child.pid : -child.pid, 'SIGTERM'); } catch { /* 已经退了 */ } }
}

// 新版 DSH 加了危险工具而守卫名单没跟上时，这里先红（0.2.2 就加过 schedule_edit / apply_patch）。
if (!desktop) {
  const npmRoot = spawnSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm root -g'] : ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
  const modules = [path.join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules'), npmRoot].find((dir) => fs.existsSync(path.join(dir, '@deepseek-ai', 'dsh-agent-preset')));
  const scan = modules ? spawnSync(process.execPath, ['scripts/scan-dsh-tool-names.mjs'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_INSTALL_MODULES: modules, QQ_BRIDGE_DSH_MODULES: modules } }) : null;
  const summary = /候选里未覆盖的危险名 (\d+) 个/.exec(scan?.stdout ?? '');
  console.log((scan?.stdout ?? '').split(/\r?\n/).filter((l) => /守卫名单|←/.test(l) && !/\[/.test(l)).join('\n'));
  if (!summary) console.log('::warning::没能扫描 DSH 工具名');
  else if (summary[1] !== '0') { console.error(`::error::守卫名单漏了 ${summary[1]} 个危险工具名`); process.exit(1); }
}

const { child, baseUrl } = startHost();
const deadline = Date.now() + 180000;
let failed = false;
try {
  const base = await Promise.race([
    baseUrl,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Host 180 秒没有就绪')), 180000).unref())
  ]);
  console.log(`Host: ${base}`);
  let presets = { ok: null, ids: [], missing: [] };
  while (presets.ok === null && Date.now() < deadline) {
    presets = await checkDshPresets(base, { timeoutMs: 4000 });
    if (presets.ok === null) await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`agentPresets/list: ${presets.ids.join(', ') || '（空）'}`);
  if (presets.ok !== true) {
    failed = true;
    console.error(`::error::QQ 预设没注册上（缺 ${presets.missing.join(', ') || '查询失败'}）`);
    for (const line of diagnosePresetProfile({ home: process.env.DSH_HOME, profile })) console.error(`  ${line}`);
  } else {
    const api = new NodeApiClient(base, undefined, {});
    // 预设清单先于 sessionController 就绪：启动期内的 service-unavailable 不算失败，别的错误立刻报。
    let created;
    for (;;) {
      try {
        created = unwrap(await api.sessions.create({ cwd: home, agentPreset: 'qq-chat-v2' }), 'session.create');
        break;
      } catch (error) {
        if (!/service-unavailable/.test(String(error?.message ?? error)) || Date.now() >= deadline) throw error;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    console.log(`session/create qq-chat-v2: ${created.sessionId ?? JSON.stringify(created).slice(0, 80)}`);
    if (!await confirmChannelPreset(api)) throw new Error('新渠道安全预设或守卫不可用');
    const sessionId = createChannelSessionId(encodeConversationKey({
      platform: 'telegram', accountId: '101', chatType: 'group', chatId: '-1001',
    }));
    const channel = unwrap(await api.sessions.create({
      cwd: home, sessionId, agentPreset: CHANNEL_DSH_PRESET,
    }), 'session.create');
    if (channel.sessionId !== sessionId || channel.agentPreset !== CHANNEL_DSH_PRESET
        || !await confirmChannelPreset(api, { sessionId })) throw new Error('新渠道安全会话校验失败');
    console.log('session/create channel-chat-v2: 已确认安全预设和指定会话');
    const roster = unwrap(await api.callUnary('agentPresets/list', {}), 'agentPresets/list');
    const textPreset = roster.presets.find(row => row.id === CHANNEL_DSH_TEXT_PRESET);
    if (!Object.hasOwn(textPreset ?? {}, 'broken') || await confirmChannelPreset(api, { preset: CHANNEL_DSH_TEXT_PRESET })) {
      throw new Error('新渠道文本预设应在未配置回环端点时停用');
    }
    console.log('agentPresets/list channel-chat-v2-text: 未配置回环端点时不可用');
  }
} catch (error) {
  failed = true;
  console.error(`::error::${error?.message ?? error}`);
} finally {
  stopHost(child);
}
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
