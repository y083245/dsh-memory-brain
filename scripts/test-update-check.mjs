// UPGRADE_PATCH：版本检查（src/update-check.js，接口约定 §6）的单测。
// 一律假 fetch：断言收到的每个 URL 都在白名单主机上，绝不联网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareSemver, createUpdateCheck, parseGitConfigOrigin, parseGithubUrl, pickLatestTag,
} from '../src/update-check.js';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-update-check-'));
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const HTTPS_CONFIG = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = https://github.com/Derpyu520/qq-bridge.git
[remote "origin"]
\turl = https://github.com/y083245/dsh-memory-brain.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;
const SSH_CONFIG = `[remote "origin"]
\turl = git@github.com:y083245/dsh-memory-brain.git
`;

const CHANGELOG = `# CHANGELOG

## v0.3.2 — 2026-11-10

- 修好了一个小问题
- 第二条

\`\`\`upgrade
restart: bridge
deps: npm
\`\`\`

## v0.3.1 — 2026-11-03

- 一条命令升级

\`\`\`upgrade
restart: memory-rag
setup-dsh: true
\`\`\`

## v0.3.0 — 2026-11-02

- 旧版本
`;

/** 临时仓库根：package.json 的 version、.git/config、可选 state/upgrade.json。 */
function repo({ version = '0.3.0', gitConfig = HTTPS_CONFIG, upgrade } = {}) {
  const root = fs.mkdtempSync(path.join(BASE, 'repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version }));
  if (gitConfig !== null) {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), gitConfig);
  }
  if (upgrade) {
    fs.mkdirSync(path.join(root, 'state'));
    fs.writeFileSync(path.join(root, 'state', 'upgrade.json'), JSON.stringify(upgrade));
  }
  return root;
}

function response(status, text, headers = {}) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => text,
  };
}

/** 假 fetch：按 URL 回固定内容，并记下每次调用的 URL 与 init。 */
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && url.startsWith(k.slice(0, -1)))?.[1];
    if (typeof route === 'function') return route(url, init);
    if (route === undefined) return response(404, 'not found');
    return response(200, route);
  };
  fn.calls = calls;
  return fn;
}

const TAGS_URL = 'https://api.github.com/repos/y083245/dsh-memory-brain/tags?per_page=30';
const tagsJson = (names) => JSON.stringify(names.map((name) => ({ name })));

function assertAllowed(calls) {
  for (const { url, init } of calls) {
    const u = new URL(url);
    assert.equal(u.protocol, 'https:');
    assert.ok(['api.github.com', 'raw.githubusercontent.com'].includes(u.hostname), `不在白名单：${url}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['User-Agent'], 'qq-bridge-update-check');
    assert.ok(init.signal, '要带超时 signal');
  }
}

function make(root, fetch, extra = {}) {
  return createUpdateCheck({ root, fetch, env: {}, readConfig: () => ({}), setTimeout: () => ({}), setInterval: () => ({}), ...extra });
}

await test('.git/config：https 与 ssh 两种 origin 写法都能解析；只认 origin 段', () => {
  assert.deepEqual(parseGitConfigOrigin(HTTPS_CONFIG), { owner: 'y083245', repo: 'dsh-memory-brain' });
  assert.deepEqual(parseGitConfigOrigin(SSH_CONFIG), { owner: 'y083245', repo: 'dsh-memory-brain' });
  assert.deepEqual(parseGithubUrl('https://github.com/a/b'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseGithubUrl('git@github.com:a/b'), { owner: 'a', repo: 'b' });
  assert.equal(parseGitConfigOrigin('[remote "upstream"]\n\turl = https://github.com/a/b.git\n'), null);
});

await test('非 github / 形状不对 → null', () => {
  for (const url of [
    'https://gitlab.com/a/b.git', 'git@gitlab.com:a/b.git', 'http://github.com/a/b.git',
    'https://github.com.evil.com/a/b.git', 'https://evil.com/github.com/a/b', 'ssh://git@github.com/a/b.git',
    'https://github.com/a/b/c', 'https://github.com/a', '/tmp/backups/repo', '', 'https://github.com/a%2f/b',
  ]) assert.equal(parseGithubUrl(url), null, url);
});

await test('非 github 的 origin → state unknown-remote，零请求；没有 .git → 同样', async () => {
  for (const gitConfig of ['[remote "origin"]\n\turl = https://gitlab.com/a/b.git\n', null]) {
    const fetch = fakeFetch();
    const uc = make(repo({ gitConfig }), fetch);
    assert.equal(await uc.checkNow(), true);
    assert.equal(uc.status().state, 'unknown-remote');
    assert.equal(fetch.calls.length, 0);
  }
});

await test('tags 取最大语义版本（忽略非 v* 与认不出的）', () => {
  assert.equal(pickLatestTag([{ name: 'v0.2.1-r1' }, { name: 'v0.10.0' }, { name: 'v0.9.9' }, { name: 'latest' }, { name: '1.0.0' }, { name: 'v2' }]), 'v0.10.0');
  assert.equal(pickLatestTag([{ name: 'v1.0.0-rc.1' }, { name: 'v1.0.0' }]), 'v1.0.0');
  assert.equal(pickLatestTag([{ name: 'v1.0.0-rc.2' }, { name: 'v1.0.0-rc.10' }]), 'v1.0.0-rc.10');
  assert.equal(pickLatestTag([]), null);
  assert.equal(pickLatestTag(null), null);
  assert.equal(compareSemver('0.3.0', 'v0.3.0'), 0);
  assert.equal(compareSemver('v0.2.1-r1', 'v0.2.1'), -1);
});

await test('有更新：取 CHANGELOG、生成 notes（只含当前版本之后的）与升级须知并集；所有请求都在白名单主机', async () => {
  const fetch = fakeFetch({
    [TAGS_URL]: tagsJson(['v0.3.0', 'v0.3.2', 'v0.3.1', 'v0.2.1-r1']),
    'https://raw.githubusercontent.com/y083245/dsh-memory-brain/v0.3.2/CHANGELOG.md': CHANGELOG,
  });
  const uc = make(repo({ version: '0.3.0' }), fetch, { now: () => Date.parse('2026-11-02T00:00:00Z') });
  await uc.checkNow();
  const st = uc.status();
  assert.equal(st.state, 'ok');
  assert.equal(st.version, '0.3.0');
  assert.equal(st.latest, 'v0.3.2');
  assert.equal(st.newer, true);
  assert.deepEqual(st.notes.map((n) => n.version).sort(), ['v0.3.1', 'v0.3.2']);
  const n2 = st.notes.find((n) => n.version === 'v0.3.2');
  assert.equal(n2.date, '2026-11-10');
  assert.match(n2.summary, /修好了一个小问题/);
  assert.doesNotMatch(n2.summary, /restart/);
  assert.deepEqual([...st.upgrade.restart].sort(), ['bridge', 'memory-rag']);
  assert.equal(st.upgrade.setupDsh, true);
  assert.equal(st.command, 'bash scripts/update.sh');
  assert.equal(st.checkedAt, '2026-11-02T00:00:00.000Z');
  assert.equal(fetch.calls.length, 2);
  assertAllowed(fetch.calls);
});

await test('没有更新：只请求 tags，不取 CHANGELOG', async () => {
  const fetch = fakeFetch({ [TAGS_URL]: tagsJson(['v0.3.0', 'v0.2.1-r1']) });
  const uc = make(repo({ version: '0.3.0' }), fetch);
  await uc.checkNow();
  assert.equal(uc.status().state, 'ok');
  assert.equal(uc.status().newer, false);
  assert.deepEqual(uc.status().notes, []);
  assert.equal(fetch.calls.length, 1);
  assertAllowed(fetch.calls);
});

await test('非 200 / 超大（content-length 与实际长度两种）/ 坏 JSON → state error，error 是简短原因', async () => {
  const cases = [
    [() => response(403, 'rate limited'), /HTTP 403/],
    [() => response(200, 'x', { 'content-length': String(10 * 1024 * 1024) }), /过大/],
    [() => response(200, 'x'.repeat(600 * 1024)), /过大/],
    [() => response(200, '{not json'), /JSON/],
    [() => { throw new TypeError('fetch failed: redirect mode is set to error'); }, /网络错误/],
  ];
  for (const [route, re] of cases) {
    const fetch = fakeFetch({ [TAGS_URL]: route });
    const uc = make(repo(), fetch);
    await uc.checkNow();
    const st = uc.status();
    assert.equal(st.state, 'error');
    assert.match(st.error, re);
    assert.ok(st.error.length < 40);
  }
  // CHANGELOG 超过 256 KB 也算失败
  const fetch = fakeFetch({
    [TAGS_URL]: tagsJson(['v9.0.0']),
    'https://raw.githubusercontent.com/*': () => response(200, 'y'.repeat(300 * 1024)),
  });
  const uc = make(repo(), fetch);
  await uc.checkNow();
  assert.equal(uc.status().state, 'error');
  assert.match(uc.status().error, /过大/);
});

await test('超时 → state error（fetch 永远不回，timeoutMs 内放弃，并 abort signal）', async () => {
  let aborted = false;
  const fetch = fakeFetch({ [TAGS_URL]: (url, init) => new Promise(() => { init.signal.addEventListener('abort', () => { aborted = true; }); }) });
  const uc = make(repo(), fetch, { timeoutMs: 50 });
  const t0 = Date.now();
  await uc.checkNow();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(uc.status().state, 'error');
  assert.match(uc.status().error, /超时/);
  assert.equal(aborted, true);
});

await test('读 body 时超出上限（流式）→ error，并取消读取', async () => {
  let cancelled = false;
  const chunk = new Uint8Array(200 * 1024);
  let n = 0;
  const fetch = fakeFetch({
    [TAGS_URL]: () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => (n++ < 10 ? { done: false, value: chunk } : { done: true }), cancel: async () => { cancelled = true; } }) },
    }),
  });
  const uc = make(repo(), fetch);
  await uc.checkNow();
  assert.equal(uc.status().state, 'error');
  assert.equal(cancelled, true);
  assert.ok(n <= 4, '超限后不再继续读');
});

await test('update.check:false → off，零请求', async () => {
  const fetch = fakeFetch({ [TAGS_URL]: tagsJson(['v9.0.0']) });
  const uc = make(repo(), fetch, { readConfig: () => ({ update: { check: false } }) });
  uc.start();
  assert.equal(await uc.checkNow(), false);
  const st = uc.status();
  assert.equal(st.state, 'off');
  assert.equal(st.newer, false);
  assert.equal(fetch.calls.length, 0);
  // 字段不存在 = 开
  const uc2 = make(repo(), fakeFetch({ [TAGS_URL]: tagsJson(['v0.3.0']) }), { readConfig: () => ({ update: {} }) });
  await uc2.checkNow();
  assert.equal(uc2.status().state, 'ok');
});

await test('QQB_NO_UPDATE_CHECK=1 → off、零请求、不建定时器（env 参数与本进程环境变量两种都认）', async () => {
  for (const viaProcess of [false, true]) {
    const fetch = fakeFetch({ [TAGS_URL]: tagsJson(['v9.0.0']) });
    const timers = [];
    const prev = process.env.QQB_NO_UPDATE_CHECK;
    if (viaProcess) process.env.QQB_NO_UPDATE_CHECK = '1';
    try {
      const uc = createUpdateCheck({
        root: repo(), fetch, env: viaProcess ? {} : { QQB_NO_UPDATE_CHECK: '1' },
        setTimeout: (...a) => { timers.push(a); return {}; },
        setInterval: (...a) => { timers.push(a); return {}; },
      });
      uc.start();
      assert.equal(await uc.checkNow(), false);
      assert.equal(uc.status().state, 'off');
      assert.equal(fetch.calls.length, 0);
      assert.equal(timers.length, 0);
    } finally {
      if (prev === undefined) delete process.env.QQB_NO_UPDATE_CHECK; else process.env.QQB_NO_UPDATE_CHECK = prev;
    }
  }
});

await test('start：启动 60 秒后一次、之后每 24 小时（只建两个定时器）；状态起始为 pending', async () => {
  const fetch = fakeFetch({ [TAGS_URL]: tagsJson(['v0.3.0']) });
  const timeouts = []; const intervals = [];
  const uc = createUpdateCheck({
    root: repo(), fetch, env: {},
    setTimeout: (fn, ms) => { timeouts.push([fn, ms]); return {}; },
    setInterval: (fn, ms) => { intervals.push([fn, ms]); return {}; },
  });
  assert.equal(uc.status().state, 'pending');
  uc.start();
  uc.start();
  assert.deepEqual(timeouts.map((t) => t[1]), [60_000]);
  assert.deepEqual(intervals.map((t) => t[1]), [24 * 3600_000]);
  assert.equal(fetch.calls.length, 0, 'start 本身不发请求');
  timeouts[0][0]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetch.calls.length, 1);
});

await test('checkNow：60 秒内第二次不再请求；过了 60 秒才再查', async () => {
  let t = 1_000_000;
  const fetch = fakeFetch({ [TAGS_URL]: tagsJson(['v0.3.0']) });
  const uc = make(repo(), fetch, { now: () => t });
  assert.equal(await uc.checkNow(), true);
  t += 59_000;
  assert.equal(await uc.checkNow(), false);
  assert.equal(fetch.calls.length, 1);
  t += 2_000;
  assert.equal(await uc.checkNow(), true);
  assert.equal(fetch.calls.length, 2);
});

await test('lastUpgrade 取 state/upgrade.json 最后一条（不带备份路径）；文件坏了 → null', async () => {
  const root = repo({ upgrade: { version: 1, history: [
    { at: '2026-11-01T00:00:00Z', from: 'v0.2.1', to: 'v0.3.0', fromCommit: 'aaa', backup: '/tmp/backups/b.tgz', result: 'ok' },
    { at: '2026-11-03T00:00:00Z', from: 'v0.3.0', to: 'v0.3.1', fromCommit: 'bbb', backup: '/tmp/backups/c.tgz', result: 'rolled-back' },
  ] } });
  const uc = make(root, fakeFetch());
  assert.deepEqual(uc.status().lastUpgrade, { at: '2026-11-03T00:00:00Z', from: 'v0.3.0', to: 'v0.3.1', result: 'rolled-back' });
  fs.writeFileSync(path.join(root, 'state', 'upgrade.json'), '{坏');
  assert.equal(uc.status().lastUpgrade, null);
  assert.equal(make(repo(), fakeFetch()).status().lastUpgrade, null);
});

await test('status 形状', () => {
  const st = make(repo(), fakeFetch()).status();
  for (const k of ['version', 'state', 'latest', 'newer', 'notes', 'upgrade', 'command', 'checkedAt', 'lastUpgrade']) assert.ok(k in st, k);
});

fs.rmSync(BASE, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
console.log('\n全部通过');
