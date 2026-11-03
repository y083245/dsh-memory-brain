// scripts/rag-config.py 的 config.local.yml 覆盖层单测（UPGRADE_PATCH；约定 docs/design/worker-kit/upgrade/contract.md §1.3）。
//
// 做法同 test-rag-scripts.mjs：在临时目录里造一个假仓库根（只放 rag-config.py 的**副本**和一份出厂
// config.yml），假 HOME，子进程环境只有 HOME / PATH，只跑 `embedding-managed` 这一个只读动作。
// 验证：用户在 state/long-memory/rag/config.local.yml 里改 embedding.provider 后，结果跟着变；
// 覆盖坏了按没有覆盖算；覆盖里的 state_dir 忽略；合并规则与 fixtures 用例表一致（系统 python3 跑一遍）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const BASE_TMP = '/tmp/worker-M';
fs.mkdirSync(BASE_TMP, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(BASE_TMP, 'test-rag-config-local-'));
const CASES_FILE = path.join(REPO, 'sidecars', 'memory-rag', 'tests', 'fixtures', 'config_merge_cases.json');

let seq = 0;
/** 假仓库根：scripts/rag-config.py（副本）+ sidecars/memory-rag/config.yml（provider 可选）+ state/。 */
function makeRepo({ provider = 'local', stateDir = '../../state', settingsKind = null } = {}) {
  seq += 1;
  const home = path.join(ROOT, `home-${seq}`);
  const repo = path.join(home, 'qq-bridge');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'sidecars', 'memory-rag'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'state', 'long-memory', 'rag'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(REPO, 'scripts', 'rag-config.py'), path.join(repo, 'scripts', 'rag-config.py'));
  const yml = [
    `state_dir: ${stateDir}`,
    'embedding:',
    `  provider: ${provider}`,
    '  base_url: http://127.0.0.1:8091',
    'recall:',
    '  tau: 0.4',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(repo, 'sidecars', 'memory-rag', 'config.yml'), yml);
  if (settingsKind) {
    fs.writeFileSync(path.join(repo, 'state', 'long-memory', 'rag', 'embedding-settings.json'),
      JSON.stringify({ version: 1, kind: settingsKind }), { mode: 0o600 });
  }
  return { home, repo };
}

function writeLocal(stateRoot, text) {
  const dir = path.join(stateRoot, 'long-memory', 'rag');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'config.local.yml'), text, { mode: 0o600 });
}

function managed({ home, repo }, extraEnv = {}) {
  const result = spawnSync('python3', [path.join(repo, 'scripts', 'rag-config.py'), 'embedding-managed', repo], {
    env: { HOME: home, PATH: '/usr/bin:/bin', ...extraEnv },
    cwd: home,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
}

// 自检：系统 python3 要有 PyYAML，否则 rag-config.py 一律按 local，下面的断言没有意义
const probe = spawnSync('python3', ['-c', 'import yaml'], { env: { PATH: '/usr/bin:/bin' } });
if (probe.status !== 0) {
  console.error('FAIL 系统 python3 没有 PyYAML，无法验证覆盖层');
  process.exit(1);
}

await test('没有 config.local.yml：与改动前一致（provider local → yes，api → no）', () => {
  assert.deepEqual(managed(makeRepo({ provider: 'local' })), { code: 0, stdout: 'yes', stderr: '' });
  assert.deepEqual(managed(makeRepo({ provider: 'api' })), { code: 0, stdout: 'no', stderr: '' });
});

await test('覆盖把 provider 改成 api → no；改回 local → yes；删掉覆盖 → 回到出厂', () => {
  const r = makeRepo({ provider: 'local' });
  const state = path.join(r.repo, 'state');
  writeLocal(state, 'embedding:\n  provider: api\n');
  assert.equal(managed(r).stdout, 'no');
  writeLocal(state, 'embedding:\n  provider: local\n');
  assert.equal(managed(r).stdout, 'yes');
  fs.unlinkSync(path.join(state, 'long-memory', 'rag', 'config.local.yml'));
  assert.equal(managed(r).stdout, 'yes');

  const api = makeRepo({ provider: 'api' });
  writeLocal(path.join(api.repo, 'state'), 'embedding:\n  provider: local\n');
  assert.equal(managed(api).stdout, 'yes');
});

await test('覆盖里 provider: null = 删键，回到代码缺省（local → yes）', () => {
  const r = makeRepo({ provider: 'api' });
  writeLocal(path.join(r.repo, 'state'), 'embedding:\n  provider: null\n');
  assert.equal(managed(r).stdout, 'yes');
});

await test('只改别的键（recall.tau）不影响 provider', () => {
  const r = makeRepo({ provider: 'api' });
  writeLocal(path.join(r.repo, 'state'), 'recall:\n  tau: 0.5\n');
  assert.deepEqual(managed(r), { code: 0, stdout: 'no', stderr: '' });
});

await test('覆盖坏了（YAML 语法错 / 顶层是列表）：stderr 说明、按出厂判断、退出码 0', () => {
  for (const text of ['embedding: [provider: api\n', '- embedding\n- api\n']) {
    const r = makeRepo({ provider: 'local' });
    writeLocal(path.join(r.repo, 'state'), text);
    const out = managed(r);
    assert.equal(out.code, 0);
    assert.equal(out.stdout, 'yes');
    assert.match(out.stderr, /config\.local\.yml/);
  }
  // 空文件 = 没有覆盖，不出声
  const empty = makeRepo({ provider: 'api' });
  writeLocal(path.join(empty.repo, 'state'), '');
  assert.deepEqual(managed(empty), { code: 0, stdout: 'no', stderr: '' });
});

await test('覆盖里的 state_dir 忽略：覆盖文件仍在出厂 state_dir 下找，指向别处也不跟过去', () => {
  const r = makeRepo({ provider: 'local' });
  const elsewhere = path.join(r.home, 'elsewhere');
  writeLocal(elsewhere, 'embedding:\n  provider: local\n');
  writeLocal(path.join(r.repo, 'state'), `state_dir: ${elsewhere}\nembedding:\n  provider: api\n`);
  assert.equal(managed(r).stdout, 'no');
});

await test('state 的定位跟 memory-rag 一致：出厂 state_dir（相对 config.yml 目录）、MEMORY_RAG_STATE_DIR 优先', () => {
  const rel = makeRepo({ provider: 'local', stateDir: '../../custom-state' });
  writeLocal(path.join(rel.repo, 'custom-state'), 'embedding:\n  provider: api\n');
  assert.equal(managed(rel).stdout, 'no');

  const env = makeRepo({ provider: 'local' });
  const other = path.join(env.home, 'env-state');
  writeLocal(other, 'embedding:\n  provider: api\n');
  assert.equal(managed(env).stdout, 'yes', '没设环境变量时不看 env-state');
  assert.equal(managed(env, { MEMORY_RAG_STATE_DIR: other }).stdout, 'no');
});

await test('有 embedding-settings.json 时仍以它为准（覆盖层只影响回落到 config.yml 的那一支）', () => {
  const bundled = makeRepo({ provider: 'local', settingsKind: 'bundled' });
  writeLocal(path.join(bundled.repo, 'state'), 'embedding:\n  provider: api\n');
  assert.equal(managed(bundled).stdout, 'yes');
  const cloud = makeRepo({ provider: 'local', settingsKind: 'cloud' });
  writeLocal(path.join(cloud.repo, 'state'), 'embedding:\n  provider: local\n');
  assert.equal(managed(cloud).stdout, 'no');
});

await test('合并规则：系统 python3 下 rag-config.py 的 merge_config 通过全部 fixtures 用例', () => {
  const r = makeRepo();
  const script = [
    'import importlib.util, json, sys',
    'sys.dont_write_bytecode = True',
    'spec = importlib.util.spec_from_file_location("rc", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'cases = json.load(open(sys.argv[2], encoding="utf-8"))',
    'bad = [c["name"] for c in cases if mod.merge_config(c["base"], c["local"]) != c["expected"]]',
    'print(json.dumps({"n": len(cases), "bad": bad}, ensure_ascii=False))',
  ].join('\n');
  const out = spawnSync('python3', ['-c', script, path.join(r.repo, 'scripts', 'rag-config.py'), CASES_FILE], {
    env: { HOME: r.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(out.status, 0, out.stderr);
  const res = JSON.parse(out.stdout);
  assert.ok(res.n >= 12, `用例至少 12 条，实际 ${res.n}`);
  assert.deepEqual(res.bad, []);
});

fs.rmSync(ROOT, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} 个失败`);
  process.exit(1);
}
console.log('\n全部通过');
