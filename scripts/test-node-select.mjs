// src/runtime/node-select.mjs 与一键入口的单测：非交互 shell（ssh 命令、cron）下用哪个 node。
// 全部用临时目录和假 node，不碰真实服务；真要探测端口的用例发现端口被占就跳过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  dshNodeRequirement,
  hasPtraceCap,
  listNvmNodes,
  nodeVersionProblem,
  parseNodeVersion,
  pickStartNode,
  planStartNode,
  versionAtLeast
} from '../src/runtime/node-select.mjs';
import { resolveOrchestratorPaths } from '../src/runtime/paths.mjs';
import { checkNodeForServices, runStart } from '../src/runtime/orchestrator.mjs';
import { isPortOpen } from '../src/runtime/ports.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_MIN = '22.13.0';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-node-select-'));
let counter = 0;
function tempDir(label = 'dir') {
  counter += 1;
  const dir = path.join(ROOT, `${label}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(file, text = '', mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

const FAKE_NODE = '#!/bin/sh\necho "FAKE_NODE args=$*"\necho "NOTE=$QQB_NODE_SWITCH_NOTE"\necho "PATH=$PATH"\nexit 7\n';

/** 造一个 nvm 目录，装上给定版本的假 node。 */
function makeNvm(home, versions, { alias } = {}) {
  const nvm = path.join(home, '.nvm');
  for (const version of versions) writeFile(path.join(nvm, 'versions', 'node', version, 'bin', 'node'), FAKE_NODE, 0o755);
  if (alias) writeFile(path.join(nvm, 'alias', 'default'), `${alias}\n`);
  return nvm;
}

function nvmNode(home, version) {
  return path.join(home, '.nvm', 'versions', 'node', version, 'bin', 'node');
}

/** 一个 DSH 源码目录。 */
function makeDshDir(engines = '>=24.9.0') {
  const dir = tempDir('dsh');
  writeFile(path.join(dir, 'package.json'), JSON.stringify(engines ? { engines: { node: engines } } : {}));
  return dir;
}

await test('版本号解析与比较', () => {
  assert.deepEqual(parseNodeVersion('v24.22.1'), [24, 22, 1]);
  assert.deepEqual(parseNodeVersion('24.9'), [24, 9, 0]);
  assert.equal(parseNodeVersion('lts/iron'), null);
  assert.equal(versionAtLeast('24.10.0', '24.9.0'), true, '24.10 比 24.9 新，不能按字符串比');
  assert.equal(versionAtLeast('24.9.0', '24.9.0'), true);
  assert.equal(versionAtLeast('22.22.1', '24.9.0'), false);
  assert.equal(versionAtLeast('garbage', '24.9.0'), false);
});

await test('listNvmNodes：从新到旧，只认真的 node 文件，没装 nvm 返回空', () => {
  const home = tempDir('home');
  assert.deepEqual(listNvmNodes({ env: {}, home }), []);
  makeNvm(home, ['v22.22.1', 'v24.9.0', 'v24.10.0']);
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v26.0.0'), { recursive: true }); // 装了一半
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'not-a-version', 'bin'), { recursive: true });
  assert.deepEqual(listNvmNodes({ env: {}, home }).map((n) => n.version), ['24.10.0', '24.9.0', '22.22.1']);
  assert.equal(listNvmNodes({ env: {}, home })[0].path, nvmNode(home, 'v24.10.0'));
});

await test('listNvmNodes：nvm alias default 排最前，NVM_DIR 优先于 ~/.nvm', () => {
  const home = tempDir('home');
  makeNvm(home, ['v24.22.1', 'v25.1.0'], { alias: '24' });
  assert.deepEqual(listNvmNodes({ env: {}, home }).map((n) => n.version), ['24.22.1', '25.1.0']);
  writeFile(path.join(home, '.nvm', 'alias', 'default'), 'lts/*\n');
  assert.deepEqual(listNvmNodes({ env: {}, home }).map((n) => n.version), ['25.1.0', '24.22.1'], 'lts/* 认不出就按新旧');

  const other = tempDir('nvm-dir');
  writeFile(path.join(other, 'versions', 'node', 'v30.0.0', 'bin', 'node'), FAKE_NODE, 0o755);
  assert.deepEqual(listNvmNodes({ env: { NVM_DIR: other }, home }).map((n) => n.version), ['30.0.0']);
});

await test('dshNodeRequirement：源码版读 engines，读不到用默认值，都算硬要求', () => {
  const dshDir = makeDshDir('>=25.2.0');
  assert.deepEqual(
    dshNodeRequirement({ dshDir, dshCommand: { kind: 'source', command: 'pnpm' } }),
    { min: '25.2.0', source: path.join(dshDir, 'package.json'), strict: true }
  );
  const bare = makeDshDir(null);
  const req = dshNodeRequirement({ dshDir: bare, dshCommand: { kind: 'source', command: 'pnpm' } });
  assert.equal(req.min, '24.9.0');
  assert.equal(req.strict, true);
});

await test('dshNodeRequirement：自定义命令、自带运行时不管；npm 全局版只算软要求', () => {
  assert.equal(dshNodeRequirement({ dshCommand: { kind: 'custom', command: 'x' } }), null);
  const bundled = path.join(tempDir('desktop'), 'resources', 'runtime', 'cli', 'bin', 'dsh');
  writeFile(bundled, '#!/bin/sh\n', 0o755);
  assert.equal(dshNodeRequirement({ dshCommand: { kind: 'cli', command: bundled } }), null);
  const global = path.join(tempDir('global'), 'bin', 'dsh');
  writeFile(global, '#!/bin/sh\n', 0o755);
  assert.equal(dshNodeRequirement({ dshCommand: { kind: 'cli', command: global } }).strict, false);
  assert.equal(dshNodeRequirement({ dshCommand: { kind: 'cli', command: 'dsh' } }).min, '24.9.0', '还没在 PATH 里（装在 nvm 里）时也要往新版挑');
});

await test('hasPtraceCap：看 getcap 的输出，PATH 里没有 getcap 时试 /usr/sbin', () => {
  const file = path.join(tempDir('cap'), 'node');
  writeFile(file, '');
  const calls = [];
  const noPath = (cmd) => {
    calls.push(cmd);
    if (cmd === 'getcap') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return `${file} cap_sys_ptrace=ep\n`;
  };
  assert.equal(hasPtraceCap(file, { exec: noPath }), true);
  assert.deepEqual(calls, ['getcap', '/usr/sbin/getcap']);
  assert.equal(hasPtraceCap(file, { exec: () => '' }), false);
  assert.equal(hasPtraceCap(file, { exec: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), false);
  assert.equal(hasPtraceCap(path.join(ROOT, 'missing'), { exec: () => 'cap_sys_ptrace' }), false);
});

await test('pickStartNode：各种组合', () => {
  const sys = (version) => ({ path: '/usr/bin/node', version });
  const pick = (current, candidates, capable = [], minVersion = '24.9.0') => pickStartNode({
    current,
    candidates: candidates.map((version) => ({ path: `/nvm/${version}/node`, version })),
    minVersion,
    entryMin: ENTRY_MIN,
    hasCap: (file) => capable.includes(file)
  })?.version ?? null;

  assert.equal(pick(sys('22.22.1'), ['24.22.1'], ['/nvm/24.22.1/node']), '24.22.1', '线上那个场景：系统 v22，nvm v24 带权限');
  assert.equal(pick(sys('22.22.1'), []), null, '没有候选就留在当前，由后面报错');
  assert.equal(pick(sys('22.22.1'), ['22.13.0', '20.0.0']), null, '候选也不够新，不换');
  assert.equal(pick(sys('24.22.1'), ['25.0.0'], ['/usr/bin/node', '/nvm/25.0.0/node']), null, '当前已经合适就不换，哪怕 nvm 里有更新的');
  assert.equal(pick(sys('24.22.1'), ['24.22.1'], ['/nvm/24.22.1/node']), '24.22.1', '版本够但没权限，换带权限的');
  assert.equal(pick(sys('22.22.1'), ['25.0.0', '24.22.1'], ['/nvm/24.22.1/node']), '24.22.1', '新版没 setcap，优先带权限的');
  assert.equal(pick(sys('22.22.1'), ['25.0.0', '24.22.1']), '25.0.0', '都没权限时取靠前的，后面会提示 setcap');
  assert.equal(pick(sys('22.22.1'), ['22.14.0'], ['/usr/bin/node', '/nvm/22.14.0/node']), null, '版本都不够时不为了换而换');
  assert.equal(pick(sys('24.22.1'), ['22.14.0'], ['/nvm/22.14.0/node']), null, '版本比权限重要');
  assert.equal(pick(sys('18.20.4'), ['22.14.0']), '22.14.0', '当前跑不了编排器，至少换一个能跑的');
  assert.equal(pick(sys('18.20.4'), ['20.0.0']), null);
  assert.equal(pick(sys('22.22.1'), ['25.0.0'], ['/usr/bin/node'], ''), null, '没有版本要求（自定义 DSH 命令）时当前就合适');
});

await test('planStartNode：系统 v22 + nvm v24 → 换，不依赖 PATH，也不写死版本目录', () => {
  const home = tempDir('home');
  const root = tempDir('repo');
  makeNvm(home, ['v24.22.1']);
  const plan = planStartNode({
    root,
    entryMin: ENTRY_MIN,
    env: { PATH: '/usr/bin:/bin', DSH_DIR: makeDshDir() },
    platform: 'linux',
    home,
    execPath: '/usr/bin/node',
    version: '22.22.1',
    hasCap: () => false
  });
  assert.equal(plan.path, nvmNode(home, 'v24.22.1'));
  assert.match(plan.note, /v22\.22\.1/);
  assert.match(plan.note, /DSH 要 >= 24\.9\.0/);
});

await test('planStartNode：当前已合适、没有 nvm、DSH 不用这个 node，都不换', () => {
  const home = tempDir('home');
  const root = tempDir('repo');
  const base = { root, entryMin: ENTRY_MIN, platform: 'linux', home, execPath: '/usr/bin/node' };
  const dsh = { PATH: '', DSH_DIR: makeDshDir() };
  assert.equal(planStartNode({ ...base, env: dsh, version: '22.22.1', hasCap: () => false }), null, '没有 nvm');
  makeNvm(home, ['v24.22.1']);
  assert.equal(planStartNode({ ...base, env: dsh, version: '24.10.0', hasCap: () => true }), null, '当前合适');
  writeFile(path.join(root, 'config.json'), JSON.stringify({ orchestrator: { dshCommand: ['my-dsh'] } }));
  assert.equal(planStartNode({ ...base, env: dsh, version: '22.22.1', hasCap: () => true }), null, '自定义 DSH 命令，不要求版本');
});

await test('planStartNode：NODE_BIN / orchestrator.nodeBin 指定过的不改', () => {
  const home = tempDir('home');
  const root = tempDir('repo');
  makeNvm(home, ['v24.22.1']);
  const base = { root, entryMin: ENTRY_MIN, platform: 'linux', home, execPath: '/usr/bin/node', version: '22.22.1', hasCap: () => false };
  const DSH_DIR = makeDshDir();
  assert.equal(planStartNode({ ...base, env: { DSH_DIR, NODE_BIN: '/opt/my/node' } }), null);
  writeFile(path.join(root, 'config.json'), JSON.stringify({ orchestrator: { nodeBin: '/opt/my/node' } }));
  assert.equal(planStartNode({ ...base, env: { DSH_DIR } }), null);
});

await test('planStartNode：禁用 QQ 时不用 cap_sys_ptrace 来选择 Node', () => {
  const root = tempDir('repo-no-qq');
  const home = tempDir('home-no-qq');
  makeNvm(home, ['v24.22.1']);
  writeFile(path.join(root, 'config.json'), JSON.stringify({ channels: { qq: { enabled: false } } }));
  const plan = planStartNode({
    root, home, entryMin: ENTRY_MIN, platform: 'linux', env: { DSH_DIR: makeDshDir('>=24.9.0') },
    execPath: '/usr/bin/node', version: '22.22.1', hasCap: () => assert.fail('禁用 QQ 时不探测 cap_sys_ptrace')
  });
  assert.equal(plan?.version, '24.22.1');
});

await test('Windows 行为不变：不换 node，nodeBin 还是当前进程', () => {
  const home = tempDir('home');
  const root = tempDir('repo');
  makeNvm(home, ['v24.22.1']);
  assert.equal(planStartNode({
    root, entryMin: ENTRY_MIN, env: { DSH_DIR: makeDshDir() }, platform: 'win32', home, execPath: 'C:\\node\\node.exe', version: '22.22.1', hasCap: () => true
  }), null);
  const paths = resolveOrchestratorPaths({ root, env: {}, platform: 'win32', home, execPath: 'C:\\node\\node.exe' });
  assert.equal(paths.nodeBin, 'C:\\node\\node.exe');
  assert.equal(paths.nodeBinExplicit, false);
});

await test('nodeVersionProblem：报清版本、来源和怎么办', () => {
  const requirement = { min: '24.9.0', source: '/x/package.json', strict: true };
  const paths = { nodeBin: '/usr/bin/node', nodeBinExplicit: false };
  const lines = nodeVersionProblem({ paths, requirement, execPath: '/usr/bin/node', version: '22.22.1' });
  assert.match(lines[0], /v22\.22\.1/);
  assert.match(lines[0], /\/usr\/bin\/node/);
  assert.match(lines[0], /v24\.9\.0/);
  assert.match(lines[0], /\/x\/package\.json/);
  assert.ok(lines.some((l) => l.includes('nvm install 24')));
  assert.ok(lines.some((l) => l.includes('NODE_BIN')));
  assert.deepEqual(nodeVersionProblem({ paths, requirement, execPath: '/usr/bin/node', version: '24.9.0' }), []);
  assert.deepEqual(nodeVersionProblem({ paths, requirement: null, version: '18.0.0' }), []);
});

await test('nodeVersionProblem：NODE_BIN 指定的 node 现问版本，跑不起来也要说', () => {
  const requirement = { min: '24.9.0', source: 'x', strict: true };
  const paths = { nodeBin: '/opt/my/node', nodeBinExplicit: true };
  const asked = [];
  const old = nodeVersionProblem({
    paths, requirement, execPath: '/usr/bin/node', version: '24.22.1',
    exec: (file, args) => { asked.push([file, ...args]); return '22.0.0\n'; }
  });
  assert.deepEqual(asked, [['/opt/my/node', '-p', 'process.versions.node']]);
  assert.match(old[0], /v22\.0\.0/);
  assert.ok(old.some((l) => l.includes('指定')));
  const broken = nodeVersionProblem({ paths, requirement, execPath: '/usr/bin/node', exec: () => { throw new Error('boom'); } });
  assert.match(broken[0], /跑不起来/);
});

await test('checkNodeForServices：只查这次真要起的服务', async () => {
  const dshDir = makeDshDir('>=99.0.0');
  const paths = { dshDir, dshCommand: { kind: 'source', command: 'pnpm' }, nodeBin: process.execPath };
  const run = async ({ open = [], cap = true, target = paths }) => {
    const errors = [];
    const warnings = [];
    let capAsked = 0;
    const good = await checkNodeForServices({
      paths: target,
      platform: 'linux',
      warn: (m) => warnings.push(m),
      err: (m) => errors.push(m),
      portOpen: async (port) => open.includes(port),
      capCheck: async () => { capAsked += 1; return cap; }
    });
    return { good, errors, warnings, capAsked };
  };
  const down = await run({});
  assert.equal(down.good, false, 'DSH 要起而版本不够');
  assert.match(down.errors[0], /v99\.0\.0/);

  const dshUp = await run({ open: [3080] });
  assert.equal(dshUp.good, true, 'DSH 已在运行就不查版本');
  assert.equal(dshUp.capAsked, 1);

  const noCap = await run({ open: [3080], cap: false });
  assert.equal(noCap.good, false, 'SnowLuma 要起而没权限');

  const allUp = await run({ open: [3080, 5099], cap: false });
  assert.equal(allUp.good, true);
  assert.equal(allUp.capAsked, 0, 'SnowLuma 已在运行就不查权限');

  const noQq = await run({ open: [3080], cap: false, target: { ...paths, config: { channels: { qq: { enabled: false } } } } });
  assert.equal(noQq.good, true);
  assert.equal(noQq.capAsked, 0);

  const soft = await run({ open: [5099], target: { ...paths, dshCommand: { kind: 'cli', command: 'dsh' } } });
  if (!versionAtLeast(process.versions.node, '24.9.0')) {
    assert.equal(soft.good, true, 'npm 全局版只告警');
    assert.equal(soft.warnings.length, 1);
  } else {
    assert.equal(soft.warnings.length, 0);
  }
});

if (process.platform !== 'win32') {
  /** 拷出一棵只含入口的小仓库，PATH 里只放跑入口要用到的命令（故意没有 node）。 */
  function makeEntryTree() {
    const home = tempDir('home');
    const repo = path.join(home, 'repo');
    for (const file of ['start-all.sh', 'stop-all.sh', 'scripts/lib/ensure-node.sh']) {
      writeFile(path.join(repo, file), fs.readFileSync(path.join(REPO, file), 'utf8'));
    }
    const tools = path.join(home, 'tools');
    fs.mkdirSync(tools);
    for (const name of ['dirname', 'ls', 'sort', 'tail']) {
      const real = ['/usr/bin', '/bin'].map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
      fs.symlinkSync(real, path.join(tools, name));
    }
    return { home, repo, tools };
  }

  const runShell = (tree, script, args = []) => spawnSync('/bin/bash', [path.join(tree.repo, script), ...args], {
    encoding: 'utf8',
    env: { HOME: tree.home, PATH: tree.tools }
  });

  await test('.sh 入口：PATH 里没有 node 时用 nvm 里最新的，参数原样转发', () => {
    for (const name of ['start-all', 'stop-all']) {
      const tree = makeEntryTree();
      makeNvm(tree.home, ['v22.22.1', 'v24.22.1']);
      const r = runShell(tree, `${name}.sh`, ['--rag']);
      assert.equal(r.status, 7, r.stderr);
      assert.ok(r.stdout.includes(`args=${path.join(tree.repo, 'scripts', `${name}.mjs`)} --rag`), r.stdout);
      assert.ok(r.stdout.includes(`PATH=${path.join(tree.home, '.nvm', 'versions', 'node', 'v24.22.1', 'bin')}:`), r.stdout);
    }
  });

  await test('.sh 入口：哪儿都没有 node 时给出明确报错，不是 command not found', () => {
    const tree = makeEntryTree();
    const r = runShell(tree, 'start-all.sh');
    assert.equal(r.status, 127);
    assert.match(r.stderr, /\[fail\] 找不到 node/);
    assert.doesNotMatch(r.stderr, /command not found|未找到命令/);
  });

  await test('.sh 入口：PATH 里已有 node 就不碰 nvm', () => {
    const tree = makeEntryTree();
    makeNvm(tree.home, ['v24.22.1']);
    writeFile(path.join(tree.tools, 'node'), '#!/bin/sh\necho "PATH_NODE"\necho "PATH=$PATH"\nexit 9\n', 0o755);
    const r = runShell(tree, 'start-all.sh');
    assert.equal(r.status, 9, r.stderr);
    assert.ok(r.stdout.includes(`PATH=${tree.tools}`));
    assert.ok(!r.stdout.includes('.nvm'));
  });

  await test('start-all.mjs：当前 node 不够新时用 nvm 的再跑一遍，退出码和参数都传得回来', () => {
    const home = tempDir('home');
    makeNvm(home, ['v99.0.0']);
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'start-all.mjs'), '--web'], {
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        DSH_DIR: makeDshDir('>=99.0.0'),
        QQ_BIN: path.join(home, 'no-qq'),
        QQB_RUN_DIR: path.join(home, 'run')
      },
      timeout: 60000
    });
    assert.equal(r.status, 7, `${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes(`args=${path.join(REPO, 'scripts', 'start-all.mjs')} --web`), r.stdout);
    assert.match(r.stdout, /NOTE=当前 node 是 v/);
    assert.ok(r.stdout.includes(`PATH=${path.dirname(nvmNode(home, 'v99.0.0'))}:/usr/bin:/bin`), r.stdout);
  });

  // 这条真的走 runStart，靠「端口没人占」才能走到检查；开发机上服务在跑就跳过，交给 CI。
  const busy = (await Promise.all([3080, 5099].map((port) => isPortOpen(port)))).some(Boolean);
  if (busy) {
    console.log('SKIP runStart 前置检查：本机 3080 / 5099 有服务在跑');
  } else {
    await test('runStart：node 不满足时起任何服务之前就退出', async () => {
      const home = tempDir('home');
      const root = tempDir('repo');
      const runDir = path.join(home, 'run');
      writeFile(path.join(root, 'src', 'bridge.js'), '');
      const snowDir = tempDir('snow');
      writeFile(path.join(snowDir, 'index.mjs'), '');
      const pnpm = path.join(home, 'pnpm');
      writeFile(pnpm, '#!/bin/sh\nexit 1\n', 0o755);
      const lines = [];
      const say = (m) => lines.push(m);
      const code = await runStart({
        argv: [],
        root,
        platform: 'linux',
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          DSH_DIR: makeDshDir('>=99.0.0'),
          PNPM_BIN: pnpm,
          SNOW_DIR: snowDir,
          QQ_BIN: path.join(home, 'no-qq'),
          QQB_RUN_DIR: runDir
        },
        logger: { log: say, ok: say, warn: say, err: say, stopLog: say }
      });
      assert.equal(code, 1);
      assert.ok(lines.some((l) => l.includes('v99.0.0')), lines.join('\n'));
      assert.ok(!lines.some((l) => l.includes('启动 DSH')), lines.join('\n'));
      assert.deepEqual(fs.readdirSync(runDir).filter((name) => /\.(pid|log)$/.test(name)), [], '不该留下任何服务的 PID / 日志');
    });
  }
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nAll node-select tests passed.');
process.exitCode = failures ? 1 : 0;
