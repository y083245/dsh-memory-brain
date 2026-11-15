#!/usr/bin/env node
// update.mjs / rollback.mjs 的 Windows 流程（QQ、SnowLuma 归用户管、不认 systemd）：真 git、真 tar、真 node，服务用替身脚本；Linux 那条路的细节在 test-update.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'qqb-update-cross-')));
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
const dev = (rel) => fs.readFileSync(path.join(DEV, rel));
const put = (dir, files) => {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
};
const standin = (name, log) => `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`;

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const health = `http://127.0.0.1:${server.address().port}`;

const remote = path.join(base, 'remote.git');
const author = path.join(base, 'author');
const user = path.join(base, 'user');
const home = path.join(base, 'home');
const dshHome = path.join(home, '.dsh');
const fake = path.join(base, 'bin');
// Windows 上测试保险只认系统临时目录，所以把 TEMP 设成 base 本身，仓库才算在它下面。
const tmp = process.platform === 'win32' ? base : path.join(base, 'tmp');
const log = path.join(base, 'cmd.log');
for (const d of [home, fake, tmp]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(log, '');
const sdkManifest = path.join(user, 'node_modules', '@snowluma', 'sdk', 'package.json');
const npmFixture = path.join(fake, 'npm.mjs');
fs.writeFileSync(npmFixture, `${standin('npm', log)}
fs.mkdirSync(${JSON.stringify(path.dirname(sdkManifest))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(sdkManifest)}, '{"name":"@snowluma/sdk"}');
`);
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(fake, 'npm.cmd'), `@"${process.execPath}" "%~dp0npm.mjs" %*\r\n`);
} else {
  fs.writeFileSync(path.join(fake, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${npmFixture}" "$@"\n`, { mode: 0o755 });
}
git(base, 'init', '-q', '--bare', '-b', 'main', remote);
git(base, 'clone', '-q', remote, author);
const tooling = {
  'scripts/update.mjs': dev('scripts/update.mjs'),
  'scripts/rollback.mjs': dev('scripts/rollback.mjs'),
  'scripts/lib/upgrade-common.mjs': dev('scripts/lib/upgrade-common.mjs'),
  'scripts/lib/upgrade-notes.mjs': dev('scripts/lib/upgrade-notes.mjs'),
  'scripts/migrate.mjs': dev('scripts/migrate.mjs'),
  'scripts/setup-dsh.mjs': standin('setup-dsh', log),
  'scripts/build-agent-preset-patches.mjs': '// Fixture has no generated presets.\n',
  'src/preset-prompt.js': dev('src/preset-prompt.js'),
  'scripts/start-all.mjs': standin('start-all', log),
  'scripts/stop-all.mjs': standin('stop-all', log),
  'start-all.sh': `#!/bin/sh\nexec node "$(dirname "$0")/scripts/start-all.mjs" "$@"\n`,
  'stop-all.sh': `#!/bin/sh\nexec node "$(dirname "$0")/scripts/stop-all.mjs" "$@"\n`
};
put(author, {
  ...tooling,
  '.gitignore': 'node_modules\nstate/\nconfig.json\n',
  '.gitattributes': '* -text\n',
  'src/bridge.js': '// v1\n',
  'package.json': '{ "name": "qq-bridge", "version": "0.1.0", "dependencies": { "@snowluma/sdk": "1.14.20" } }\n',
  'CHANGELOG.md': '# 更新日志\n\n## v0.1.0 — 2026-11-01\n\n- 首个标签\n'
});
for (const f of ['start-all.sh', 'stop-all.sh']) fs.chmodSync(path.join(author, f), 0o755);
git(author, 'add', '-A');
git(author, 'commit', '-q', '-m', 'v0.1.0');
git(author, 'tag', 'v0.1.0');
put(author, {
  'src/bridge.js': '// v2\n',
  'src/runtime/channel-config.mjs': '// Fixture supports disabling QQ.\n',
  'plugins/channel-agent-presets/package.json': '{"name":"channel-agent-presets"}\n',
  'package.json': '{ "name": "qq-bridge", "version": "0.2.0" }\n',
  'CHANGELOG.md': '# 更新日志\n\n## v0.2.0 — 2026-11-02\n\n- 第二版\n\n```upgrade\nrestart: bridge\n```\n\n## v0.1.0 — 2026-11-01\n\n- 首个标签\n'
});
git(author, 'add', '-A');
git(author, 'commit', '-q', '-m', 'v0.2.0');
git(author, 'tag', 'v0.2.0');
git(author, 'push', '-q', 'origin', 'main', '--tags');
git(base, 'clone', '-q', remote, user);
git(user, 'reset', '-q', '--hard', 'v0.1.0');
put(user, {
  'config.json': '{ "consolePort": 3100 }\n',
  'state/console-token': 'token-DO-NOT-PRINT\n',
  'state/people.json': '{"v":"原来的账本"}\n'
});

const env = {
  ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
  DSH_HOME: dshHome,
  QQB_UPDATE_TEST: '1', QQB_TEST_LINUX_FLOW: '0', QQB_FAKE_BIN: fake, QQB_HEALTH_BASE: health, QQB_HEALTH_WAIT: '5'
};
const script = (name, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(user, 'scripts', `${name}.mjs`), ...args], { cwd: user, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});
const sha = (ref) => git(user, 'rev-parse', `${ref}^{commit}`).trim();

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.log(`FAIL ${name}\n  ${error?.stack ?? error}`); }
}

await test('--check：显示版本，什么都不改', async () => {
  const r = await script('update', ['--check']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('v0.2.0'), r.out);
  assert.equal(sha('HEAD'), sha('v0.1.0'));
  assert.ok(!fs.existsSync(path.join(home, 'qq-bridge-backups')));
});

await test('升级：备份、快进、停桥接再 start-all、不打印令牌、临时目录清干净', async () => {
  const r = await script('update', ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(sha('HEAD'), sha('v0.2.0'));
  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => l.trim());
  assert.deepEqual(calls, ['setup-dsh', 'stop-all', 'start-all'], r.out);
  const names = fs.readdirSync(path.join(home, 'qq-bridge-backups'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^update-\d{8}-\d{6}-v0\.1\.0\.tar\.gz$/);
  assert.ok(!r.out.includes('token-DO-NOT-PRINT'));
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('qqb-')), []);
  const uj = JSON.parse(fs.readFileSync(path.join(user, 'state', 'upgrade.json'), 'utf8'));
  assert.equal(uj.history.at(-1).result, 'ok');
  assert.deepEqual(uj.history.at(-1).restarted, ['dsh', 'bridge']);
});

await test('回滚至旧版：恢复缺少的必需 SDK、旧 DSH profile 和备份状态', async () => {
  fs.writeFileSync(path.join(user, 'state', 'people.json'), '{"v":"升级后改过"}\n');
  fs.writeFileSync(log, '');
  const bundleName = 'channel-agent-presets';
  const installed = path.join(dshHome, 'plugins', bundleName);
  const managed = {
    dependencies: { [bundleName]: `link:${installed.replaceAll('\\', '/')}`, custom: '1.0.0' },
    dsh: { profile: { bundles: ['custom', bundleName] } },
  };
  const custom = {
    dependencies: { [bundleName]: 'link:../custom' },
    dsh: { profile: { bundles: [bundleName] } },
  };
  put(dshHome, {
    'profiles/web/package.json': JSON.stringify(managed),
    'profiles/custom/package.json': JSON.stringify(custom),
    'profiles/unrelated/package.json': '{',
  });
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.symlinkSync(path.join(user, 'plugins', bundleName), installed, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(sdkManifest), false);
  const r = await script('rollback', ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(sha('HEAD'), sha('v0.1.0'));
  assert.equal(fs.readFileSync(path.join(user, 'state', 'people.json'), 'utf8'), '{"v":"原来的账本"}\n');
  const manifest = (profile) => fs.readFileSync(path.join(dshHome, 'profiles', profile, 'package.json'), 'utf8');
  assert.deepEqual(JSON.parse(manifest('web')), { dependencies: { custom: '1.0.0' }, dsh: { profile: { bundles: ['custom'] } } });
  assert.equal(manifest('custom'), JSON.stringify(custom));
  assert.equal(manifest('unrelated'), '{');
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), true);
  assert.equal(fs.existsSync(sdkManifest), true);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => l.trim()), ['stop-all', 'npm ci', 'setup-dsh web', 'start-all']);
  const uj = JSON.parse(fs.readFileSync(path.join(user, 'state', 'upgrade.json'), 'utf8'));
  assert.equal(uj.history.at(-1).result, 'rolled-back');
  assert.ok(fs.readdirSync(path.join(home, 'qq-bridge-backups')).some((n) => n.startsWith('rollback-pre-')));
});

await test('不是终端又没 --yes：当作「否」，退出 3，什么都没改', async () => {
  git(user, 'checkout', '-q', '--detach', 'v0.1.0');
  const before = sha('HEAD');
  const r = await script('update', []);
  assert.equal(r.code, 3, r.out);
  assert.equal(sha('HEAD'), before);
});

await test('历史被重写：文件相同的老版本能升上去（--force 拿到新标签，HEAD 平移后快进）', async () => {
  const oldHead = sha('HEAD');
  const tree = (ref) => git(author, 'rev-parse', `${ref}^{tree}`).trim();
  const a = git(author, 'commit-tree', tree('v0.1.0'), '-m', 'v0.1.0 整理后').trim();
  const b = git(author, 'commit-tree', tree('v0.2.0'), '-p', a, '-m', 'v0.2.0 整理后').trim();
  git(author, 'update-ref', 'refs/heads/main', b);
  git(author, 'tag', '-f', 'v0.1.0', a);
  git(author, 'tag', '-f', 'v0.2.0', b);
  git(author, 'push', '-q', '--force', 'origin', 'main', '--tags');
  const r = await script('update', ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(sha('HEAD'), b);
  assert.notEqual(oldHead, b);
  const uj = JSON.parse(fs.readFileSync(path.join(user, 'state', 'upgrade.json'), 'utf8'));
  assert.equal(uj.history.at(-1).from, 'v0.1.0');
  assert.equal(uj.history.at(-1).fromCommit, oldHead);
});

server.close();
try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows 上可能有句柄没释放，不影响结论 */ }
console.log(failed ? `FAILED ${failed}` : 'OK');
process.exitCode = failed ? 1 : 0;
