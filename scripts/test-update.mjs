#!/usr/bin/env node
// UPGRADE_PATCH：scripts/update.sh / scripts/rollback.sh 的端到端测试（contract §4）。
//
// 全部在 /tmp/worker-U/update/ 下：假远端（bare 仓库，v0.3.0 / v0.3.1 两个标签）、假用户仓库（clone 它）、
// 假 HOME、假命令（systemctl / npm / uv / pnpm / pgrep / kill / ps 的替身，只把调用记进日志）、
// 假健康服务（本进程起的 HTTP，端口 0）。每个用例都设 QQB_UPDATE_TEST=1。
// start-all.sh / stop-all.sh / build-agent-preset-patches.mjs / setup-dsh.mjs / install.sh 在假仓库里也是替身。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV = path.resolve(__dirname, '..');
const BASE = '/tmp/worker-U/update';
const TOKEN = 'console-token-DO-NOT-PRINT-7f3a9c';

let failed = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n  ${error?.stack ?? error}`);
  }
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── 假命令 ──────────────────────────────────────────────────────────────
const FAKE_JS = `
import fs from 'node:fs';
const [name, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.QQB_FAKE_LOG, JSON.stringify({ cmd: name, args }) + '\\n');
const procs = (() => { try { return JSON.parse(fs.readFileSync(process.env.QQB_FAKE_PROCS, 'utf8')); } catch { return []; } })();
const fail = (process.env.QQB_FAKE_FAIL || '').split(',');
if (fail.includes(name)) process.exit(1);
if (name === 'pgrep' && args[0] === '-x') {
  const hits = procs.filter((p) => p.comm === args[1]).map((p) => p.pid);
  if (hits.length) console.log(hits.join('\\n'));
  process.exit(hits.length ? 0 : 1);
}
if (name === 'ps' && args[0] === '-eo') {
  for (const p of procs) console.log(p.pid + ' ' + p.args);
  process.exit(0);
}
if (name === 'pgrep') {
  const re = new RegExp(args[args.indexOf('-f') + 1]);
  const hits = procs.filter((p) => re.test(p.args)).map((p) => p.pid);
  if (hits.length) console.log(hits.join('\\n'));
  process.exit(hits.length ? 0 : 1);
}
if (name === 'ps') {
  const field = args[args.indexOf('-o') + 1].replace(/=$/, '');
  const pid = Number(args[args.indexOf('-p') + 1]);
  const p = procs.find((x) => x.pid === pid);
  if (!p) process.exit(1);
  console.log(String(p[field]));
  process.exit(0);
}
if (name === 'kill') process.exit(args[0] === '-0' ? 1 : 0);   // -0：进程已经退出
if (name === 'systemctl') {
  if (args.includes('is-enabled')) { console.log('disabled'); process.exit(1); }
  process.exit(0);
}
process.exit(0);
`;
const FAKE_CMDS = ['systemctl', 'npm', 'uv', 'pnpm', 'pgrep', 'kill', 'ps'];

// 进程表：QQ、SnowLuma 故意放进去——它们绝不能被 pgrep 匹配、更不能被 kill。
const PROCS = [
  { pid: 400, ppid: 1, args: 'bash' },
  { pid: 500, ppid: 400, comm: 'qq', args: '/opt/QQ/qq --no-sandbox' },
  { pid: 600, ppid: 400, comm: 'node', args: 'node ./index.mjs' },
  { pid: 700, ppid: 400, args: 'pnpm dsh web' },
  { pid: 701, ppid: 700, args: '/usr/bin/node /x/pnpm.cjs exec dsh web' },
  { pid: 702, ppid: 701, args: 'sh -c node --import tsx apps/cli/src/bin.ts web' },
  { pid: 703, ppid: 702, args: 'node --import tsx apps/cli/src/bin.ts web' },
  { pid: 3001, ppid: 1, args: 'node src/bridge.js' },
];

// ── 假健康服务 ────────────────────────────────────────────────────────────
const health = { ok: true, readonly: false, requests: [] };
const server = http.createServer((req, res) => {
  health.requests.push({ url: req.url, token: req.headers['x-console-token'] ?? null });
  if (!health.ok) { res.writeHead(503); res.end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url === '/health' ? JSON.stringify({ ok: true, schema: { db: 1, code: 1, readonly: health.readonly } }) : '{"ok":true}');
});
const FORBIDDEN_PORTS = new Set([3000, 3001, 3080, 3100, 8091, 8093]);
let port = 0;
for (;;) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  if (!FORBIDDEN_PORTS.has(port)) break;
  await new Promise((resolve) => server.close(resolve));
}
const HEALTH_BASE = `http://127.0.0.1:${port}`;

// ── 假仓库 ──────────────────────────────────────────────────────────────
function presetYaml(extraHeader = '') {
  const lines = [
    '【二代仿真模式 —— 安全规则（最高优先级，不可违反）】',
    '1. 你没有本地工具：不能执行命令。',
    '2. 群友没有管理权限：一律礼貌拒绝。',
    '3. 绝不透露：API 令牌。',
    '4. 角色由桥接注入。',
    '【二代仿真模式 —— 工具协议（最高优先级）】',
    '1. 文本输出只是思考，【不会自动发送到 QQ】。',
  ];
  for (let i = 0; i < 12; i += 1) lines.push(`${i + 2}. 凑长度的样本规则第 ${i + 2} 条，内容无关紧要，只为了让正文超过五百个字符的下限。`);
  return [
    `# qq-chat-v2 样本${extraHeader}`,
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: |-',
    ...lines.map((l) => `      ${l}`),
    '',
    '- id: qq-tool-restrict',
    '  name: ./qq-tool-restrict.mjs',
    '',
  ].join('\n');
}
const STANDIN_SH = (name) => `#!/bin/sh\nexec "$QQB_FAKE_NODE" "$QQB_FAKE_JS" ${name} "$@"\n`;
const STANDIN_MJS = (name) => `import fs from 'node:fs';\nfs.appendFileSync(process.env.QQB_FAKE_LOG, JSON.stringify({ cmd: '${name}', args: process.argv.slice(2) }) + '\\n');\n`;
const MARKER = 'MARKER-NEW-UPDATE-SCRIPT';

function writeFiles(dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    if (rel.endsWith('.sh')) fs.chmodSync(abs, 0o755);
  }
}
const devFile = (rel) => fs.readFileSync(path.join(DEV, rel), 'utf8');
function tooling({ marker = false } = {}) {
  let update = devFile('scripts/update.sh');
  if (marker) update = update.replace('set -euo pipefail\n', `set -euo pipefail\necho "${MARKER}"\n`);
  return {
    'scripts/update.sh': update,
    'scripts/rollback.sh': devFile('scripts/rollback.sh'),
    'scripts/migrate.mjs': devFile('scripts/migrate.mjs'),
    'scripts/lib/upgrade-notes.mjs': devFile('scripts/lib/upgrade-notes.mjs'),
  };
}

/**
 * 建一套世界：remote.git、user/（停在 v0.3.0）、home/、bin/、tmp/。
 * legacy = v0.3.0 里还没有 update.sh / migrate.mjs（照现在线上的 main）。
 */
function makeWorld(name, { legacy = false, rag = true } = {}) {
  const root = path.join(BASE, name);
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of ['home', 'bin', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const remote = path.join(root, 'remote.git');
  const author = path.join(root, 'author');
  const user = path.join(root, 'user');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, author);
  const v030 = {
    '.gitignore': 'node_modules\nstate/\nconfig.json\n',
    'src/bridge.js': '// v0.3.0\n',
    'src/preset-prompt.js': devFile('src/preset-prompt.js'),
    'package.json': '{ "name": "qq-bridge", "version": "0.3.0" }\n',
    'package-lock.json': '{ "lockfileVersion": 3, "v": "0.3.0" }\n',
    'roles/A.md': '# A\n出厂的 A\n',
    'roles/B.md': '# B\n出厂的 B\n',
    'dsh/agent-presets/qq-chat-v2/agent.cordis.yml': presetYaml(),
    'sidecars/memory-rag/config.yml': 'state_dir: ../../state\nrecall:\n  tau: 0.5\n',
    'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml': '# 生成物\n',
    'scripts/build-agent-preset-patches.mjs': STANDIN_MJS('build-agent-preset-patches'),
    'scripts/setup-dsh.mjs': STANDIN_MJS('setup-dsh'),
    'scripts/systemd/install.sh': STANDIN_SH('install.sh'),
    'start-all.sh': STANDIN_SH('start-all.sh'),
    'stop-all.sh': STANDIN_SH('stop-all.sh'),
    'CHANGELOG.md': '# 更新日志\n\n## v0.3.0 — 2026-11-02\n\n- 首个标签\n',
    ...(legacy ? {} : tooling()),
  };
  writeFiles(author, v030);
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', 'v0.3.0');
  git(author, 'tag', 'v0.3.0');
  writeFiles(author, {
    'src/bridge.js': '// v0.3.1\n',
    'package-lock.json': '{ "lockfileVersion": 3, "v": "0.3.1" }\n',
    'dsh/agent-presets/qq-chat-v2/agent.cordis.yml': presetYaml('（v0.3.1）'),
    'roles/A.md': '# A\n出厂的 A（v0.3.1 版）\n',
    'CHANGELOG.md': `${v030['CHANGELOG.md']}\n## v0.3.1 — 2026-11-03\n\n- 升级脚本\n- 覆盖层\n\n\`\`\`upgrade\nrestart: bridge, memory-rag\ndeps: npm\nsetup-dsh: false\nsystemd: false\nmigrate: first-run\ncost: 无\n\`\`\`\n`,
    ...tooling({ marker: true }),
  });
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', 'v0.3.1');
  git(author, 'tag', 'v0.3.1');
  git(author, 'push', '-q', 'origin', 'main', '--tags');
  git(root, 'clone', '-q', remote, user);
  git(user, 'reset', '-q', '--hard', 'v0.3.0');
  fs.symlinkSync(path.join(DEV, 'node_modules'), path.join(user, 'node_modules'));
  // 用户数据
  writeFiles(user, {
    'config.json': `${JSON.stringify({ consolePort: 3100, memoryRag: { enabled: rag } }, null, 2)}\n`,
    'state/console-token': `${TOKEN}\n`,
    'state/people.json': '{"version":1,"people":{"1":"原来的账本"}}\n',
    'state/long-memory/rag/chroma/data.bin': 'vectors',
    'state/long-memory/rag/rag.sqlite3': 'sqlite',
    'state/long-memory/rag/rag.sqlite3-wal': 'wal',
    'state/long-memory/rag/watermarks.json': '{}',
    'state/long-memory/rag/embedding-settings.json': '{"kind":"bundled"}',
    'state/long-memory/rag/eval/cases.jsonl': '{"q":"x"}\n',
  });
  const bin = path.join(root, 'bin');
  fs.writeFileSync(path.join(bin, 'fake.mjs'), FAKE_JS);
  for (const c of FAKE_CMDS) {
    fs.writeFileSync(path.join(bin, c), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake.mjs')}" ${c} "$@"\n`, { mode: 0o755 });
  }
  const procsFile = path.join(root, 'procs.json');
  fs.writeFileSync(procsFile, JSON.stringify(PROCS));
  const log = path.join(root, 'cmd.log');
  fs.writeFileSync(log, '');
  return {
    root, remote, user, home: path.join(root, 'home'), bin, log, procsFile, tmp: path.join(root, 'tmp'),
    sha: (ref) => git(user, 'rev-parse', `${ref}^{commit}`).trim(),
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

function envFor(world, extra = {}) {
  return {
    ...process.env, ...GIT_ENV,
    HOME: world.home, TMPDIR: world.tmp, XDG_RUNTIME_DIR: path.join(world.tmp, 'xdg'),
    QQB_UPDATE_TEST: '1', QQB_FAKE_BIN: world.bin, QQB_FAKE_LOG: world.log, QQB_FAKE_PROCS: world.procsFile,
    QQB_FAKE_NODE: process.execPath, QQB_FAKE_JS: path.join(world.bin, 'fake.mjs'),
    QQB_HEALTH_BASE: HEALTH_BASE, QQB_HEALTH_WAIT: '2',
    ...extra,
  };
}
function run(world, script, args = [], extra = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], { cwd: world.user, env: envFor(world, extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}
const update = (w, args, extra) => run(w, path.join(w.user, 'scripts', 'update.sh'), args, extra);
const rollback = (w, args, extra) => run(w, path.join(w.user, 'scripts', 'rollback.sh'), args, extra);

function treeHash(root, { skip = ['.git', 'node_modules'] } = {}) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (dir === root && skip.includes(name)) continue;
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      const rel = path.relative(root, abs);
      if (st.isSymbolicLink()) out.push(`l ${rel} ${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) { out.push(`d ${rel} ${(st.mode & 0o777).toString(8)}`); walk(abs); }
      else out.push(`f ${rel} ${(st.mode & 0o777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(root);
  return out.join('\n');
}
const gitRefs = (w) => `${git(w.user, 'rev-parse', 'HEAD')}${git(w.user, 'for-each-ref', 'refs/heads')}`;
const backups = (w) => {
  const dir = path.join(w.home, 'qq-bridge-backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const upgradeJson = (w) => JSON.parse(fs.readFileSync(path.join(w.user, 'state', 'upgrade.json'), 'utf8'));
const read = (w, rel) => fs.readFileSync(path.join(w.user, rel), 'utf8');
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const callStr = (c) => [c.cmd, ...c.args].join(' ');

const ALL_WORLDS = [];
function world(name, opts) {
  const w = makeWorld(name, opts);
  ALL_WORLDS.push(w);
  return w;
}
const HOST_PROCS = PROCS.filter((p) => p.pid === 500 || p.pid === 600);
function assertSafeCalls(w) {
  for (const c of w.calls()) {
    const s = callStr(c);
    // 只读探测（pgrep -x qq、ps -eo pid=,args=）可以；pgrep -f 的模式绝不能匹配到 QQ / SnowLuma。
    if (c.cmd === 'pgrep' && c.args[0] === '-f') {
      const re = new RegExp(c.args[1]);
      assert.ok(!HOST_PROCS.some((p) => re.test(p.args)), `pgrep -f 的模式会匹配到 QQ / SnowLuma：${s}`);
    }
    if (c.cmd !== 'pgrep' && c.cmd !== 'ps') {
      assert.ok(!/(^|[\s/])qq( |$)|\/opt\/QQ|snowluma|index\.mjs/i.test(s), `碰了 QQ / SnowLuma：${s}`);
    }
    if (c.cmd === 'kill') {
      assert.equal(c.args.length, 2, s);
      assert.match(c.args[0], /^-(TERM|0)$/, s);
      assert.match(c.args[1], /^[1-9][0-9]*$/, `只能按正整数 PID 发信号：${s}`);
      assert.ok(!['500', '600', '400', '1'].includes(c.args[1]), `杀了不该杀的进程：${s}`);
    }
  }
}
function assertNoSelfCopyLeft(w) {
  assert.deepEqual(fs.readdirSync(w.tmp).filter((n) => n.startsWith('qqb-')), [], '临时目录没清掉');
}

fs.mkdirSync(BASE, { recursive: true });

await test('1. 干净仓库 v0.3.0 → v0.3.1：备份、快进、npm ci、按顺序重启、记录', async () => {
  const w = world('clean');
  health.ok = true; health.requests = [];
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[13\/13\]/);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.1'));
  // 备份
  const files = backups(w).filter((n) => n.startsWith('update-'));
  assert.equal(files.length, 1, backups(w).join(','));
  assert.match(files[0], /^update-\d{8}-\d{6}-v0\.3\.0\.tar\.gz$/);
  const backup = path.join(w.home, 'qq-bridge-backups', files[0]);
  assert.equal(mode(backup), '600');
  assert.equal(mode(path.dirname(backup)), '700');
  const members = execFileSync('tar', ['tzf', backup], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const m of ['config.json', 'state/console-token', 'state/people.json', 'state/long-memory/rag/eval/cases.jsonl',
    'state/long-memory/rag/embedding-settings.json']) {
    assert.ok(members.includes(m), `备份里缺 ${m}`);
  }
  for (const m of members) assert.ok(!/chroma|rag\.sqlite3|watermarks\.json/.test(m), `备份不该带派生库：${m}`);
  // 命令
  const calls = w.calls().map(callStr);
  assert.ok(calls.includes('npm ci'), calls.join('\n'));
  assert.ok(!calls.some((c) => c.startsWith('uv')), 'Python 依赖没变不该 uv sync');
  assert.ok(calls.includes('build-agent-preset-patches'), 'dsh/ 变了要重新生成 patch');
  assert.ok(calls.includes('setup-dsh'), 'dsh/ 变了要重跑 setup-dsh');
  // 重启顺序：memory-rag → DSH（外层 pnpm 先停）→ 桥接
  const restart = calls.filter((c) => /^(stop-all|start-all|kill -TERM|systemctl)/.test(c));
  assert.deepEqual(restart, [
    'stop-all.sh --rag', 'start-all.sh --rag',
    'kill -TERM 700', 'kill -TERM 701', 'kill -TERM 702', 'kill -TERM 703', 'start-all.sh',
    'kill -TERM 3001', 'start-all.sh',
  ]);
  assertSafeCalls(w);
  // 健康检查带了令牌，但输出里没有
  assert.ok(health.requests.some((q) => q.url === '/api/status' && q.token === TOKEN));
  assert.ok(health.requests.some((q) => q.url === '/health'));
  assert.ok(!r.out.includes(TOKEN), '输出里不能有令牌');
  assert.ok(r.out.includes('备份里有你的聊天存档原文；之后在控制台删除的聊天，在这些旧备份里不会被删除。不需要时可以直接删掉 ~/qq-bridge-backups/ 里的旧文件。'));
  // 记录
  const uj = upgradeJson(w);
  const last = uj.history.at(-1);
  assert.equal(uj.history.length, 1);
  assert.equal(last.result, 'ok');
  assert.equal(last.from, 'v0.3.0');
  assert.equal(last.to, 'v0.3.1');
  assert.equal(last.fromCommit, w.sha('v0.3.0'));
  assert.equal(last.backup, backup);
  assert.deepEqual(last.restarted, ['memory-rag', 'dsh', 'bridge']);
  assert.equal(mode(path.join(w.user, 'state', 'upgrade.json')), '600');
  // 出厂文件的权限沿用用户的 umask，不会被脚本的 077 带成 600
  assert.notEqual(mode(path.join(w.user, 'src', 'bridge.js')), '600');
  assert.equal(git(w.user, 'status', '--porcelain').trim(), '');
  assertNoSelfCopyLeft(w);
});

await test('2. --check / --dry-run：仓库、state/、HOME 前后完全一样', async () => {
  const w = world('readonly');
  fs.writeFileSync(path.join(w.user, 'roles', 'A.md'), '# A\n用户改过\n');
  const snap = () => [treeHash(w.user), treeHash(w.home), gitRefs(w)].join('\n---\n');
  const before = snap();
  const c = await update(w, ['--check']);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /v0\.3\.0/);
  assert.match(c.out, /v0\.3\.1/);
  assert.match(c.out, /要重启：memory-rag、dsh、bridge/);
  assert.equal(snap(), before);
  const d = await update(w, ['--dry-run']);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /将打包到/);
  assert.match(d.out, /--dry-run：只列出/);
  assert.match(d.out, /将快进到/);
  assert.match(d.out, /将运行 npm ci/);
  assert.match(d.out, /预演完成/);
  assert.equal(snap(), before);
  const writes = w.calls().filter((x) => !['pgrep', 'ps'].includes(x.cmd));
  assert.deepEqual(writes, [], `--check / --dry-run 不该调用：${writes.map(callStr).join('; ')}`);
  assertNoSelfCopyLeft(w);
});

await test('3. 第一次升级：v0.3.0 里没有脚本，git checkout origin/main -- scripts/update.sh 后运行；改过的角色卡进覆盖层', async () => {
  const w = world('legacy', { legacy: true });
  assert.ok(!fs.existsSync(path.join(w.user, 'scripts', 'update.sh')));
  assert.ok(!fs.existsSync(path.join(w.user, 'scripts', 'migrate.mjs')));
  fs.writeFileSync(path.join(w.user, 'roles', 'A.md'), '# A\n用户改过的 A（隐私）\n');
  // 仿真提示词也改过（控制台的改法）：迁移脚本在临时目录里 import 目标版本的 preset-prompt.js
  const { renderPresetPromptYaml, extractPresetPrefix } = await import(path.join(DEV, 'src', 'preset-prompt.js'));
  const presetRel = 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml';
  const userPrefix = `${extractPresetPrefix(read(w, presetRel))}\n99. 用户加的一条`;
  fs.writeFileSync(path.join(w.user, presetRel), renderPresetPromptYaml(read(w, presetRel), userPrefix, 'v2'));
  git(w.user, 'fetch', '-q', 'origin');
  git(w.user, 'checkout', 'origin/main', '--', 'scripts/update.sh');
  assert.match(git(w.user, 'status', '--porcelain'), /^A {2}scripts\/update\.sh/m, '新脚本是已暂存的新文件');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /与目标版本相同/);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.1'));
  assert.equal(read(w, 'state/roles/A.md'), '# A\n用户改过的 A（隐私）\n');
  assert.equal(read(w, 'roles/A.md'), '# A\n出厂的 A（v0.3.1 版）\n');
  assert.equal(git(w.user, 'status', '--porcelain').trim(), '');
  assert.ok(!r.out.includes('隐私'), '输出里不能有文件内容');
  if (process.env.SHOW_OUTPUT) console.log(r.out);
  assert.equal(read(w, 'state/preset-overrides/qq-chat-v2.prefix.md'), userPrefix);
  assert.equal(read(w, presetRel), git(w.user, 'show', `v0.3.1:${presetRel}`));
  assert.ok(w.calls().some((c) => c.cmd === 'build-agent-preset-patches'), '有覆盖文件要重新生成 patch');
  const uj = upgradeJson(w);
  assert.deepEqual(uj.firstRun.moved, ['preset:qq-chat-v2', 'roles/A.md']);
  assert.equal(uj.history.at(-1).result, 'ok');
  assert.ok(uj.history.at(-1).firstRunBackup);
  assertSafeCalls(w);
  assertNoSelfCopyLeft(w);
});

await test('4. 本地有自己的提交（不能快进）→ 退出 1，什么都没改', async () => {
  const w = world('diverged');
  fs.writeFileSync(path.join(w.user, 'local.txt'), '自己的\n');
  git(w.user, 'add', 'local.txt');
  git(w.user, 'commit', '-q', '-m', 'local');
  const head = w.sha('HEAD');
  const before = [treeHash(w.user), treeHash(w.home)].join('\n');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /本地有自己的提交/);
  assert.equal(w.sha('HEAD'), head);
  assert.equal([treeHash(w.user), treeHash(w.home)].join('\n'), before);
  assert.deepEqual(w.calls(), []);
});

await test('5. 有未知改动 → 退出 1，备份已做、代码未改', async () => {
  const w = world('unknown');
  fs.writeFileSync(path.join(w.user, 'src', 'bridge.js'), '// 用户自己改的\n');
  const derived = 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml';
  fs.writeFileSync(path.join(w.user, derived), '# 用户的生效版本生成的\n');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/bridge\.js/);
  assert.equal(read(w, derived), '# 用户的生效版本生成的\n', '停下时派生文件也不动（DSH 直接读它）');
  assert.equal(w.sha('HEAD'), w.sha('v0.3.0'));
  assert.equal(read(w, 'src/bridge.js'), '// 用户自己改的\n');
  assert.equal(backups(w).filter((n) => n.startsWith('update-')).length, 1);
  assert.ok(!fs.existsSync(path.join(w.user, 'state', 'upgrade.json')), '没升级就不写记录');
  assert.deepEqual(w.calls(), []);
});

await test('6. 目录里有 docs/design/HANDOFF.md → 退出 1', async () => {
  const w = world('handoff');
  fs.mkdirSync(path.join(w.user, 'docs', 'design'), { recursive: true });
  fs.writeFileSync(path.join(w.user, 'docs', 'design', 'HANDOFF.md'), '# 交接\n');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /HANDOFF\.md/);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.0'));
  assert.deepEqual(backups(w), []);
});

await test('7. 健康检查失败 → 退出 2 并提示 rollback.sh；rollback.sh --yes 回到 v0.3.0、state/ 还原、记 rolled-back', async () => {
  const w = world('health');
  fs.writeFileSync(path.join(w.user, 'roles', 'A.md'), '# A\n用户改过\n');
  health.ok = false;
  const r = await update(w, ['--yes']);
  health.ok = true;
  assert.equal(r.code, 2, r.out);
  const backup = path.join(w.home, 'qq-bridge-backups', backups(w).find((n) => n.startsWith('update-')));
  assert.ok(r.out.includes(`scripts/rollback.sh ${backup}`), r.out);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.1'));
  assert.equal(upgradeJson(w).history.at(-1).result, 'failed');
  // 升级后新版本写过的数据
  fs.writeFileSync(path.join(w.user, 'state', 'people.json'), '{"被新版本改过":true}\n');
  fs.writeFileSync(path.join(w.user, 'config.json'), '{"memoryRag":{"enabled":true},"changedByNew":1}\n');
  const logBefore = w.calls().length;
  const rb = await rollback(w, ['--yes']);
  assert.equal(rb.code, 0, rb.out);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.0'));
  assert.equal(read(w, 'state/people.json'), '{"version":1,"people":{"1":"原来的账本"}}\n');
  assert.deepEqual(JSON.parse(read(w, 'config.json')), { consolePort: 3100, memoryRag: { enabled: true } });
  assert.equal(read(w, 'roles/A.md'), '# A\n用户改过\n', '首次迁移挪走的改动放回原处');
  assert.ok(!fs.existsSync(path.join(w.user, 'state', 'roles', 'A.md')), '迁移新建的覆盖层文件删掉');
  assert.ok(fs.existsSync(path.join(w.user, 'state', 'long-memory', 'rag', 'chroma', 'data.bin')), '没备份的派生库不能被删');
  const last = upgradeJson(w).history.at(-1);
  assert.equal(last.result, 'rolled-back');
  assert.ok(last.rollbackPreBackup && fs.existsSync(last.rollbackPreBackup));
  assert.equal(mode(last.rollbackPreBackup), '600');
  const preMembers = execFileSync('tar', ['tzf', last.rollbackPreBackup], { encoding: 'utf8' });
  assert.match(preMembers, /state\/people\.json/);
  // 回滚：停桥接 + 向量记忆；那次升级重启过 DSH，所以 DSH 也按 PID 重启
  const rbCalls = w.calls().slice(logBefore).map(callStr).filter((c) => /^(stop-all|start-all|kill -TERM|systemctl)/.test(c));
  assert.deepEqual(rbCalls, [
    'kill -TERM 3001', 'stop-all.sh --rag', 'start-all.sh --rag',
    'kill -TERM 700', 'kill -TERM 701', 'kill -TERM 702', 'kill -TERM 703', 'start-all.sh',
  ]);
  assert.ok(!rb.out.includes(TOKEN));
  assertSafeCalls(w);
  assertNoSelfCopyLeft(w);
});

await test('8a. 重启答「否」：不调用任何重启命令，只打印命令', async () => {
  const w = world('restart-no');
  const r = await update(w, [], { QQB_TEST_ANSWERS: 'y,n' });
  assert.equal(r.code, 0, r.out);
  const calls = w.calls().map(callStr);
  assert.ok(!calls.some((c) => /^(stop-all|start-all|kill|systemctl)/.test(c)), calls.join('\n'));
  assert.match(r.out, /stop-all\.sh --rag && \.\/start-all\.sh --rag/);
  assert.match(r.out, /按 PID 逐个停 DSH（700 701 702 703）/);
  assert.match(r.out, /没有重启/);
  assert.deepEqual(upgradeJson(w).history.at(-1).restarted, []);
  assertSafeCalls(w);
});

await test('8b. memoryRag.enabled 为 false：不重启 memory-rag', async () => {
  const w = world('rag-off', { rag: false });
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  const calls = w.calls().map(callStr);
  assert.ok(!calls.some((c) => c.includes('--rag')), calls.join('\n'));
  assert.match(r.out, /memory-rag：向量记忆没开/);
  assert.deepEqual(upgradeJson(w).history.at(-1).restarted, ['dsh', 'bridge']);
  assertSafeCalls(w);
});

await test('8c. systemd 单元已安装：memory-rag、桥接用 systemctl --user restart，DSH 仍按 PID', async () => {
  const w = world('units');
  const unitDir = path.join(w.home, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  for (const u of ['qq-bridge.service', 'qq-memory-rag.service', 'qq-embedding.service']) fs.writeFileSync(path.join(unitDir, u), '[Unit]\n');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  const restart = w.calls().map(callStr).filter((c) => /^(stop-all|start-all|kill -TERM|systemctl)/.test(c));
  assert.deepEqual(restart, [
    'systemctl --user restart qq-memory-rag.service',
    'kill -TERM 700', 'kill -TERM 701', 'kill -TERM 702', 'kill -TERM 703', 'start-all.sh',
    'systemctl --user restart qq-bridge.service',
  ]);
  assertSafeCalls(w);
});

await test('8d. 所有用例的命令日志：不碰 QQ / SnowLuma，kill 只按正整数 PID', () => {
  assert.ok(ALL_WORLDS.length >= 8);
  for (const w of ALL_WORLDS) assertSafeCalls(w);
});

await test('9. QQB_UPDATE_TEST=1 但仓库不在 /tmp/ 下 → 退出 1（两个脚本都是）', async () => {
  const w = world('guard');
  // 链接在 /tmp 里，真实路径不在：守卫按真实路径判断。指向的目录也不是仓库（第二层保险）。
  const link = path.join(w.root, 'outside-link');
  fs.symlinkSync(path.join(DEV, 'docs'), link);
  for (const script of ['update.sh', 'rollback.sh']) {
    const r = await run(w, path.join(DEV, 'scripts', script), ['--check'].filter(() => script === 'update.sh'), { QQB_UPDATE_REPO: link });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /不在 \/tmp\/ 下/);
  }
  // 在 /tmp 里但没给替身目录也拒绝
  const r2 = await update(w, ['--check'], { QQB_FAKE_BIN: '' });
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /没有 QQB_FAKE_BIN/);
  assert.deepEqual(w.calls(), []);
});

await test('10. 自复制：运行中 scripts/update.sh 被拉取覆盖（目标版本内容不同）也能跑完', async () => {
  const w = world('selfcopy');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(read(w, 'scripts/update.sh').includes(MARKER), '仓库里的 update.sh 已换成目标版本');
  assert.ok(!r.out.includes(MARKER), '这次执行的仍是升级前那份（复制到临时目录的）');
  assert.match(r.out, /升级完成/);
  assertNoSelfCopyLeft(w);
});

await test('附：只有派生 patch 与出厂不同（已有覆盖层）→ 不做首次迁移，拉取前还原、拉取后重新生成', async () => {
  const w = world('derived-only');
  const derived = 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml';
  fs.writeFileSync(path.join(w.user, derived), '# 生效版本生成的\n');
  fs.mkdirSync(path.join(w.user, 'state', 'preset-overrides'), { recursive: true });
  fs.writeFileSync(path.join(w.user, 'state', 'preset-overrides', 'qq-chat-v2.prefix.md'), '用户的提示词');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /没有本地改动/);
  assert.match(r.out, /已还原派生文件/);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.1'));
  assert.ok(w.calls().some((c) => c.cmd === 'build-agent-preset-patches'));
  assert.ok(!fs.existsSync(path.join(w.user, 'state', 'upgrade.json')) || !upgradeJson(w).firstRun, '没做首次迁移');
});

// ── 第 2 轮：QQ / SnowLuma 不在跑时不调 start-all.sh；备份保留 ─────────────────────────
function setProcs(w, procs) {
  fs.writeFileSync(w.procsFile, JSON.stringify(procs));
}
const withoutPid = (...pids) => PROCS.filter((p) => !pids.includes(p.pid));
const startAllPlain = (w, from = 0) => w.calls().slice(from).map(callStr).filter((c) => c === 'start-all.sh');

await test('R2-1. QQ 不在跑（没装单元）：不停桥接 / DSH、不调 start-all.sh，提示，ok-partial', async () => {
  const w = world('host-noqq');
  setProcs(w, withoutPid(500));
  health.ok = true;
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  const calls = w.calls().map(callStr);
  assert.deepEqual(startAllPlain(w), [], calls.join('\n'));
  assert.ok(calls.includes('stop-all.sh --rag') && calls.includes('start-all.sh --rag'), '--rag 不受限制');
  assert.ok(!calls.some((c) => c.startsWith('kill -TERM')), '桥接、DSH 都不该被停');
  assert.match(r.out, /QQ 没在运行，为了不替你启动它们，本脚本没有拉起 dsh；请先登录 QQ，再运行 \.\/start-all\.sh/);
  assert.match(r.out, /本脚本没有拉起 bridge/);
  const last = upgradeJson(w).history.at(-1);
  assert.equal(last.result, 'ok-partial');
  assert.deepEqual(last.skipped, ['dsh', 'bridge']);
  assert.deepEqual(last.restarted, ['memory-rag']);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.1'));
  assertSafeCalls(w);
});

await test('R2-2. SnowLuma 不在跑：同样跳过', async () => {
  const w = world('host-nosnow');
  setProcs(w, withoutPid(600));
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(startAllPlain(w), []);
  assert.ok(!w.calls().some((c) => c.cmd === 'kill' && c.args[0] === '-TERM'));
  assert.match(r.out, /SnowLuma 没在运行/);
  assert.equal(upgradeJson(w).history.at(-1).result, 'ok-partial');
});

await test('R2-3. QQ 不在跑但桥接是 systemd 单元：桥接照常 systemctl 重启，只跳过 DSH', async () => {
  const w = world('host-units');
  setProcs(w, withoutPid(500, 600));
  const unitDir = path.join(w.home, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  for (const u of ['qq-bridge.service', 'qq-memory-rag.service']) fs.writeFileSync(path.join(unitDir, u), '[Unit]\n');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  const restart = w.calls().map(callStr).filter((c) => /^(stop-all|start-all|kill -TERM|systemctl)/.test(c));
  assert.deepEqual(restart, ['systemctl --user restart qq-memory-rag.service', 'systemctl --user restart qq-bridge.service']);
  assert.match(r.out, /QQ\/SnowLuma 没在运行/);
  const last = upgradeJson(w).history.at(-1);
  assert.equal(last.result, 'ok-partial');
  assert.deepEqual(last.skipped, ['dsh']);
  assert.ok(health.requests.length > 0);
});

await test('R2-4. QQ、SnowLuma 都在跑：照旧（--dry-run 也不提示跳过）', async () => {
  const w = world('host-ok');
  const d = await update(w, ['--dry-run']);
  assert.equal(d.code, 0, d.out);
  assert.ok(!d.out.includes('会跳过这一项'));
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(startAllPlain(w), ['start-all.sh', 'start-all.sh']);
  assert.equal(upgradeJson(w).history.at(-1).result, 'ok');
  assert.ok(!('skipped' in upgradeJson(w).history.at(-1)));
});

await test('R2-5. --dry-run 在 QQ 不在跑时提示会跳过', async () => {
  const w = world('host-dry');
  setProcs(w, withoutPid(500));
  const d = await update(w, ['--dry-run']);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /dsh：.*（QQ 没在运行：会跳过这一项，不停也不起）/);
});

await test('R2-6. 回滚时 QQ 不在跑：桥接停了但不调 start-all.sh，DSH 不动，记 rollbackSkipped', async () => {
  const w = world('host-rollback');
  health.ok = false;
  const r = await update(w, ['--yes']);
  health.ok = true;
  assert.equal(r.code, 2, r.out);
  setProcs(w, withoutPid(500));
  const from = w.calls().length;
  const rb = await rollback(w, ['--yes']);
  assert.equal(rb.code, 0, rb.out);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.0'));
  const calls = w.calls().slice(from).map(callStr).filter((c) => /^(stop-all|start-all|kill -TERM|systemctl)/.test(c));
  assert.deepEqual(calls, ['kill -TERM 3001', 'stop-all.sh --rag', 'start-all.sh --rag']);
  assert.match(rb.out, /QQ 没在运行，为了不替你启动它们，本脚本没有拉起 dsh/);
  assert.match(rb.out, /本脚本没有拉起 bridge/);
  const last = upgradeJson(w).history.at(-1);
  assert.equal(last.result, 'rolled-back');
  assert.deepEqual(last.rollbackSkipped, ['dsh', 'bridge']);
  assertSafeCalls(w);
});

// 伪造旧备份：每类 4～5 份，时间都早于今天；再放一个无关文件。
function seedBackups(w) {
  const dir = path.join(w.home, 'qq-bridge-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const updates = [1, 2, 3, 4].map((d) => path.join(dir, `update-2026010${d}-120000-v0.2.${d}.tar.gz`));
  const pres = [1, 2, 3, 4, 5].map((d) => path.join(dir, `rollback-pre-2026010${d}-120000.tar.gz`));
  const firsts = [1, 2, 3].map((d) => path.join(dir, `first-run-2026010${d}-120000`));
  for (const f of [...updates, ...pres]) fs.writeFileSync(f, 'x');
  for (const d of firsts) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'manifest.json'), '{}'); }
  fs.writeFileSync(path.join(dir, 'my-notes.txt'), '用户自己的笔记\n');
  fs.writeFileSync(path.join(dir, 'update-notes.tar.gz'), '名字像但不是时间戳格式');
  const history = updates.map((b, i) => ({ at: `2026-01-0${i + 1}T12:00:00Z`, from: 'v0.2.0', to: 'v0.2.1', fromCommit: 'a'.repeat(40), backup: b, result: 'ok', restarted: [], ...(firsts[i] ? { firstRunBackup: firsts[i] } : {}) }));
  history[4 - 1].rollbackPreBackup = pres[0];
  fs.mkdirSync(path.join(w.user, 'state'), { recursive: true });
  fs.writeFileSync(path.join(w.user, 'state', 'upgrade.json'), `${JSON.stringify({ version: 1, history }, null, 2)}\n`);
  return { dir, updates, pres, firsts };
}

await test('R2-7. 备份保留：成功后三类各只留最新 3 份，别的文件不碰，backupPruned 标记正确', async () => {
  const w = world('prune');
  const seeded = seedBackups(w);
  fs.writeFileSync(path.join(w.user, 'roles', 'A.md'), '# A\n改过\n');   // 让这次也产生一个 first-run 备份
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  const names = backups(w);
  const ups = names.filter((n) => /^update-\d{8}-\d{6}-/.test(n));
  const pres = names.filter((n) => n.startsWith('rollback-pre-'));
  const firsts = names.filter((n) => n.startsWith('first-run-'));
  assert.equal(ups.length, 3, names.join(','));
  assert.equal(pres.length, 3, names.join(','));
  assert.equal(firsts.length, 3, names.join(','));
  assert.ok(ups.some((n) => n.includes('-v0.3.0')), '这次的备份留着');
  assert.ok(names.includes('update-20260104-120000-v0.2.4.tar.gz') && names.includes('update-20260103-120000-v0.2.3.tar.gz'));
  assert.deepEqual(pres, ['rollback-pre-20260103-120000.tar.gz', 'rollback-pre-20260104-120000.tar.gz', 'rollback-pre-20260105-120000.tar.gz']);
  assert.ok(names.includes('my-notes.txt'), '无关文件不能删');
  assert.ok(names.includes('update-notes.tar.gz'), '不是时间戳格式的不算');
  assert.match(r.out, /已清理 \d+ 份旧备份/);
  const h = upgradeJson(w).history;
  assert.equal(h[0].backup, seeded.updates[0]);
  assert.equal(h[0].backupPruned, true);
  assert.equal(h[1].backupPruned, true);
  assert.ok(!('backupPruned' in h[2]) && !('backupPruned' in h[3]));
  assert.equal(h[0].firstRunBackupPruned, true);
  assert.ok(!('firstRunBackupPruned' in h[2]));
  assert.equal(h[3].rollbackPreBackupPruned, true);
  assert.ok(!('backupPruned' in h.at(-1)));
  assert.equal(h.at(-1).result, 'ok');
});

await test('R2-8. 升级失败时一份备份都不删', async () => {
  const w = world('prune-fail');
  seedBackups(w);
  const before = backups(w);
  health.ok = false;
  const r = await update(w, ['--yes']);
  health.ok = true;
  assert.equal(r.code, 2, r.out);
  const after = backups(w);
  for (const n of before) assert.ok(after.includes(n), `失败时不该删 ${n}`);
  assert.equal(after.length, before.length + 1);
  assert.ok(!upgradeJson(w).history.some((x) => x.backupPruned));
});

await test('R2-9. 连续升级 5 次（伪造）后再成功一次：update 备份只剩 3 份；ok-partial 也会清理', async () => {
  const w = world('prune-partial');
  const dir = path.join(w.home, 'qq-bridge-backups');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 5; i += 1) fs.writeFileSync(path.join(dir, `update-2026020${i}-080000-v0.2.${i}.tar.gz`), 'x');
  setProcs(w, withoutPid(500));
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(upgradeJson(w).history.at(-1).result, 'ok-partial');
  const ups = backups(w).filter((n) => n.startsWith('update-'));
  assert.equal(ups.length, 3, ups.join(','));
  assert.ok(ups.includes('update-20260205-080000-v0.2.5.tar.gz') && ups.includes('update-20260204-080000-v0.2.4.tar.gz'));
});

await test('R2-10. rollback.sh：记录里的备份已被清理 / 指定的备份不存在 → 中文提示，退出 1', async () => {
  const w = world('rollback-missing');
  const missing = path.join(w.home, 'qq-bridge-backups', 'update-20260101-120000-v0.2.9.tar.gz');
  fs.mkdirSync(path.join(w.user, 'state'), { recursive: true });
  fs.writeFileSync(path.join(w.user, 'state', 'upgrade.json'), JSON.stringify({
    version: 1,
    history: [{ at: 'x', from: 'v0.2.9', to: 'v0.3.0', fromCommit: w.sha('v0.3.0'), backup: missing, result: 'ok', restarted: [], backupPruned: true }],
  }));
  // v0.3.0 的世界里已经带着 rollback.sh（非 legacy）
  const r1 = await rollback(w, ['--yes']);
  assert.equal(r1.code, 1, r1.out);
  assert.match(r1.out, /已经按保留规则清理掉了/);
  const r2 = await rollback(w, ['--yes', path.join(w.home, 'qq-bridge-backups', 'nope.tar.gz')]);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /找不到这个备份的升级记录|备份文件不存在/);
  assert.equal(w.sha('HEAD'), w.sha('v0.3.0'));
  assert.deepEqual(w.calls().filter((c) => !['pgrep', 'ps'].includes(c.cmd)), []);
});

await test('附：已是最新 → 退出 0，什么都不做', async () => {
  const w = world('uptodate');
  git(w.user, 'merge', '-q', '--ff-only', 'v0.3.1');
  const r = await update(w, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /已是最新/);
  assert.deepEqual(backups(w), []);
});

await test('附：没有 --yes、stdin 不是终端 → 当作「否」，退出 3，什么都没改', async () => {
  const w = world('notty');
  const before = [treeHash(w.user), treeHash(w.home)].join('\n');
  const r = await update(w, []);
  assert.equal(r.code, 3, r.out);
  assert.equal([treeHash(w.user), treeHash(w.home)].join('\n'), before);
});

await test('附：npm ci 失败 → 退出 2，记 failed，提示回滚', async () => {
  const w = world('npmfail');
  const r = await update(w, ['--yes'], { QQB_FAKE_FAIL: 'npm' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /npm ci 失败/);
  assert.match(r.out, /rollback\.sh/);
  assert.equal(upgradeJson(w).history.at(-1).result, 'failed');
  assert.ok(!w.calls().some((c) => /^(start-all|stop-all|systemctl)/.test(c.cmd)), '失败后不重启');
});

await test('附：--with-rag 的备份带上向量派生库', async () => {
  const w = world('withrag');
  const r = await update(w, ['--yes', '--with-rag']);
  assert.equal(r.code, 0, r.out);
  const backup = path.join(w.home, 'qq-bridge-backups', backups(w).find((n) => n.startsWith('update-')));
  const members = execFileSync('tar', ['tzf', backup], { encoding: 'utf8' });
  assert.match(members, /state\/long-memory\/rag\/rag\.sqlite3/);
  assert.match(members, /state\/long-memory\/rag\/chroma\/data\.bin/);
});

await new Promise((resolve) => server.close(resolve));
console.log(`\n${failed ? `${failed} 个失败` : '全部通过'}（${passed} 通过）`);
process.exit(failed ? 1 : 0);
