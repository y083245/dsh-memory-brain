// Windows 一键启动 / DSH 双版本适配的回归测试（纯离线，CI 上 Linux 也能跑）。
//
// 覆盖 2026-11 审计留下的测试缺口：
//   - 桌面版 Host 命令行解析（profile 目录 / DSH_HOME，带空格路径）；
//   - netstat 监听行解析（状态列被本地化时也认得出）；
//   - 端点选择优先级：auto 先 dsh web、再桌面版；web / desktop 只认各自那一个；
//   - Electron 垫片（桌面版 dsh.cmd）直接解析成 exe + 参数，不经 cmd.exe；
//   - 走 cmd.exe 时整行带引号，含空格的垫片路径不会被截断；
//   - setup-dsh：profile 不存在时新建带 DSH 基础 bundle；旧版留下的残缺清单被修复；
//     DSH 往 cordis.patch.yml 末尾追加设置后再跑一次，判定为「无改动」且不重写文件；
//   - 机器上有两份 SnowLuma、同一个 QQ 号 token 不同时，WS token 取自 HTTP token 命中的同一文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseDesktopHostCommandLine,
  parseNetstatListening,
  resolveDshEndpoint,
  splitWindowsCommandLine
} from '../src/dsh-discovery.js';
import { commandSpec, resolveElectronShim } from '../src/runtime/commands.mjs';
import { dirsFromProcess } from '../src/runtime/snowluma-locate.mjs';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let total = 0;

async function test(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error?.stack ?? error}`);
  }
}

const HOST_CMD = String.raw`"D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals "D:\Program Files\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js" "D:\Program Files\DeepSeek Harness\resources\app.asar\dsh" "C:\Users\测试 用户\.dsh\profiles\desktop" "D:\Program Files\DeepSeek Harness\resources\runtime\primary-runtime"`;

await test('Windows 命令行拆分：引号、空格、反斜杠', () => {
  assert.deepEqual(splitWindowsCommandLine(String.raw`a "b c" d\e "f\"g" ""`), ['a', 'b c', String.raw`d\e`, 'f"g', '']);
});

await test('桌面版 Host 命令行：取出 profile 目录与 DSH_HOME（带空格、中文）', () => {
  const parsed = parseDesktopHostCommandLine(HOST_CMD, { platform: 'win32' });
  assert.equal(parsed.profileDir, String.raw`C:\Users\测试 用户\.dsh\profiles\desktop`);
  assert.equal(parsed.dshHome, String.raw`C:\Users\测试 用户\.dsh`);
});

await test('非桌面版 Host 的命令行（例如查询用的 PowerShell 自己）返回 null', () => {
  assert.equal(parseDesktopHostCommandLine(`powershell -Command "... LIKE '%dsh-desktop-host%' ..."`, { platform: 'win32' }), null);
});

await test('netstat：只认对端为 :0 的监听行，状态列本地化也能解析', () => {
  const text = [
    '  TCP    127.0.0.1:54309        0.0.0.0:0              LISTENING       12480',
    '  TCP    0.0.0.0:3080           0.0.0.0:0              ABHÖREN         777',
    '  TCP    127.0.0.1:50000        127.0.0.1:54309        ESTABLISHED     12480',
    '  UDP    0.0.0.0:5353           *:*                                    999'
  ].join('\r\n');
  const map = parseNetstatListening(text);
  assert.deepEqual([...map.get(12480)], [54309]);
  assert.deepEqual([...map.get(777)], [3080]);
  assert.equal(map.has(999), false);
});

const hosts = async () => [{ pid: 10, ppid: 9, appExe: 'x.exe', ports: [41000, 41001], profileDir: '', dshHome: '' }];
const probeOnly = (alive) => async (url) => alive.includes(url);

await test('auto：dsh web 能连时优先用它', async () => {
  const r = await resolveDshEndpoint({ target: 'auto', findHosts: hosts, probe: probeOnly(['http://127.0.0.1:3080', 'http://127.0.0.1:41001']) });
  assert.equal(r.kind, 'web');
  assert.equal(r.baseUrl, 'http://127.0.0.1:3080');
});

await test('auto：dsh web 不在时找到桌面版的随机端口（跳过不应答的端口）', async () => {
  const r = await resolveDshEndpoint({ target: 'auto', findHosts: hosts, probe: probeOnly(['http://127.0.0.1:41001']) });
  assert.equal(r.kind, 'desktop');
  assert.equal(r.baseUrl, 'http://127.0.0.1:41001');
  assert.equal(r.appPid, 9);
});

await test('web：只认 baseUrl；desktop：不碰 3080', async () => {
  assert.equal(await resolveDshEndpoint({ target: 'web', findHosts: hosts, probe: probeOnly(['http://127.0.0.1:41001']) }), null);
  const r = await resolveDshEndpoint({ target: 'desktop', findHosts: hosts, probe: probeOnly(['http://127.0.0.1:3080', 'http://127.0.0.1:41000']) });
  assert.equal(r.baseUrl, 'http://127.0.0.1:41000');
});

function fakeFs(files) {
  const norm = (p) => path.win32.resolve(String(p)).toLowerCase();
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    statSync: (p) => {
      if (!map.has(norm(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true, isDirectory: () => false };
    },
    readFileSync: (p) => {
      if (!map.has(norm(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return map.get(norm(p));
    }
  };
}

const SHIM = String.raw`D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`;
const EXE = String.raw`D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe`;
const SHIM_TEXT = '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n'
  + String.raw`"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*`
  + '\r\nexit /b %errorlevel%\r\n';

await test('桌面版 dsh.cmd：解析成 DeepSeek Harness.exe + ELECTRON_RUN_AS_NODE=1，不经 cmd.exe', () => {
  const fsImpl = fakeFs({ [SHIM]: SHIM_TEXT, [EXE]: '' });
  const shim = resolveElectronShim(SHIM, { fsImpl });
  assert.equal(shim.command, EXE);
  assert.equal(shim.args[1], String.raw`D:\Program Files\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`);
  assert.deepEqual(shim.env, { ELECTRON_RUN_AS_NODE: '1' });
  const spec = commandSpec(SHIM, ['web', '--no-open'], { platform: 'win32', fsImpl, env: {} });
  assert.equal(spec.via, 'electron-shim');
  assert.equal(spec.command, EXE);
  assert.deepEqual(spec.args.slice(-2), ['web', '--no-open']);
});

await test('普通 .cmd 走 cmd.exe 时整行再包一层引号（/s 会剥掉首尾引号）', () => {
  const file = String.raw`C:\Program Files\some tool\tool.cmd`;
  const spec = commandSpec(file, ['a b', 'c'], { platform: 'win32', fsImpl: fakeFs({ [file]: '@echo off\r\nfoo %*' }), env: {} });
  assert.equal(spec.via, 'cmd-shim');
  assert.equal(spec.args.at(-1), String.raw`""C:\Program Files\some tool\tool.cmd" "a b" c"`);
});

await test('SnowLuma 目录：从 SnowLuma.exe / 绝对路径 index.mjs / launcher.bat 的命令行猜候选', () => {
  assert.deepEqual(dirsFromProcess({ exe: String.raw`E:\snowluma\SnowLuma.exe`, cmd: '' }), [String.raw`E:\snowluma`]);
  assert.deepEqual(dirsFromProcess({ exe: '', cmd: String.raw`C:\WINDOWS\system32\cmd.exe /c ""D:\My Tools\SnowLuma\launcher.bat" "` }), [String.raw`D:\My Tools\SnowLuma`]);
  assert.deepEqual(dirsFromProcess({ exe: String.raw`C:\node\node.exe`, cmd: 'node ./index.mjs' }), []);
});

// ── setup-dsh（真跑脚本，DSH_HOME 指向临时目录，不调用真实 dsh）──
function runSetup(home, ...profiles) {
  fs.mkdirSync(home, { recursive: true });
  const configFile = path.join(home, 'config.json');
  fs.writeFileSync(configFile, '{}');
  const env = { ...process.env, DSH_HOME: home, HOME: home, USERPROFILE: home, QQ_BRIDGE_SKIP_DSH_INSTALL: '1' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), `--config=${configFile}`, ...profiles], {
    env, encoding: 'utf8', timeout: 60000,
  });
  if (r.status !== 0) throw new Error(`setup-dsh 退出码 ${r.status}：${r.stderr || r.stdout}`);
  return /RESULT changed=(\d)/.exec(r.stdout)?.[1];
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb win adapt '));
try {
  await test('setup-dsh：profile 不存在时新建，带上 DSH 基础 bundle（否则 DSH 起不来）', () => {
    const home = path.join(sandbox, 'fresh');
    assert.equal(runSetup(home, 'web', 'desktop'), '1');
    for (const profile of ['web', 'desktop']) {
      const pkg = JSON.parse(fs.readFileSync(path.join(home, 'profiles', profile, 'package.json'), 'utf8'));
      assert.deepEqual(pkg.dsh.profile.bundles.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
      assert.ok(pkg.dsh.profile.bundles.includes('qq-agent-presets'));
    }
  });

  await test('setup-dsh：修复旧版留下的残缺 bundles 清单', () => {
    const home = path.join(sandbox, 'broken');
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['qq-mode-console', 'qq-agent-presets'] } }
    }));
    runSetup(home, 'web');
    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dsh.profile.bundles,
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'qq-mode-console', 'qq-agent-presets', 'channel-agent-presets']);
  });

  await test('setup-dsh：DSH 在 cordis.patch.yml 末尾追加设置后，再跑判定无改动且不重写文件', () => {
    const home = path.join(sandbox, 'fresh');
    const patch = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
    const appended = `${fs.readFileSync(patch, 'utf8')}- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    transcriptView: standard\n`;
    fs.writeFileSync(patch, appended);
    assert.equal(runSetup(home, 'web', 'desktop'), '0');
    assert.equal(fs.readFileSync(patch, 'utf8'), appended);
  });

  await test('两份 SnowLuma、同一 QQ 号：WS token 取自 HTTP token 命中的那份，旧目录的作备选', async () => {
    // 假 OneBot HTTP：只认「正在运行那份」的 token。端口随机，配置文件里写同一个端口。
    const server = http.createServer((req, res) => {
      const ok = req.headers.authorization === 'Bearer http-live';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(ok ? JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 123456, nickname: 'bot' } }) : '{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const writeHome = (name, httpToken, wsToken) => {
      const dir = path.join(sandbox, name);
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'onebot_123456.json'), JSON.stringify({
        networks: {
          httpServers: [{ accessToken: httpToken, host: '127.0.0.1', port }],
          wsServers: [{ accessToken: wsToken, host: '127.0.0.1', port: 3001 }]
        }
      }));
      return dir;
    };
    try {
      const live = writeHome('SnowLuma-live', 'http-live', 'ws-live');
      const old = writeHome('snowluma-old', 'http-old', 'ws-old');
      // 旧目录排在后面（与真实场景一致：进程发现的在前、常见位置兜底的在后）；两种顺序都要对。
      for (const homeDirs of [[live, old], [old, live]]) {
        const r = await discoverSnowLumaConnection({ cfg: {}, baseUrl: `http://127.0.0.1:${port}`, homeDirs, timeoutMs: 3000 });
        assert.equal(r.ok, true);
        assert.equal(r.token, 'http-live');
        assert.equal(r.wsToken, 'ws-live', `顺序 ${homeDirs.map((d) => path.basename(d))} 时 WS token 错了`);
        assert.deepEqual(r.wsCandidates.map((w) => w.token), ['ws-live', 'ws-old']);
        assert.equal(path.resolve(r.homeDir), path.resolve(live));
      }
    } finally {
      server.close();
    }
  });
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures ? `\nFAILED  tests=${total} failures=${failures}` : `\n${total}/${total} Windows 适配回归通过`);
process.exitCode = failures ? 1 : 0;
