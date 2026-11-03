// UPGRADE_PATCH：仿真提示词覆盖层（src/preset-overlay.js + build-agent-preset-patches.mjs 读生效版本，
// 接口约定 §1.2）的单测。出厂 preset 只读：拷进临时仓库根再操作，开发副本的 dsh/agent-presets/ 前后 sha256 断言。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERLAY_PRESET_NAMES, effectivePresetYaml, overridePath, readOverride, removeOverride, writeOverride,
} from '../src/preset-overlay.js';
import { extractPresetPrefix, locatePresetPromptBlock } from '../src/preset-prompt.js';
import { PRESETS, buildPatches, patchFileFor, renderPatch } from './build-agent-preset-patches.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-test-preset-overlay-'));
// worker O 改动前用旧代码生成的产物（只在开发机上有；没有就只和仓库里的 patch 文件比）
const BEFORE_DIR = '/tmp/worker-O/before';
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function dirHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      h.update(path.relative(dir, p) + '\0');
      if (fs.statSync(p).isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const factoryDirHash = dirHash(path.join(REPO, 'dsh', 'agent-presets'));

function fixture(label) {
  const root = fs.mkdtempSync(path.join(BASE, `${label}-`));
  fs.cpSync(path.join(REPO, 'dsh', 'agent-presets'), path.join(root, 'dsh', 'agent-presets'), { recursive: true });
  return root;
}
const factoryText = (root, name) => fs.readFileSync(path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml'), 'utf8');
const silent = { log: () => {} };

await test('没有覆盖：effectivePresetYaml = 出厂原文；readOverride = null', () => {
  const root = fixture('none');
  for (const name of OVERLAY_PRESET_NAMES) {
    assert.equal(effectivePresetYaml(root, name), factoryText(root, name));
    assert.equal(readOverride(root, name), null);
  }
});

await test('没有覆盖：renderPatch 逐字节等于仓库里的派生 patch（以及改动前旧代码的产物）', () => {
  const root = fixture('bytes');
  for (const name of PRESETS) {
    const repoPatch = fs.readFileSync(patchFileFor(name), 'utf8');
    assert.equal(renderPatch(name), repoPatch, `${name}：缺省 root`);
    assert.equal(renderPatch(name, { root }), repoPatch, `${name}：临时 root`);
    const before = path.join(BEFORE_DIR, `${name}.patch.yml`);
    if (fs.existsSync(before)) assert.ok(Buffer.from(renderPatch(name)).equals(fs.readFileSync(before)), `${name}：与改动前产物逐字节相同`);
  }
});

await test('有覆盖：prefix 被替换，prefix 块以外逐字不变；派生 patch 含新提示词', () => {
  const root = fixture('override');
  for (const name of OVERLAY_PRESET_NAMES) {
    const base = factoryText(root, name);
    const content = `${extractPresetPrefix(base)}\n【覆盖测试】这一行来自 state/preset-overrides。`;
    writeOverride(root, name, content);
    const eff = effectivePresetYaml(root, name, silent);
    assert.equal(extractPresetPrefix(eff), content);
    const a = locatePresetPromptBlock(base);
    const b = locatePresetPromptBlock(eff);
    assert.deepEqual(b.lines.slice(0, b.keyLine), a.lines.slice(0, a.keyLine), `${name}：块前逐字不变`);
    assert.deepEqual(b.lines.slice(b.blockEnd), a.lines.slice(a.blockEnd), `${name}：块后逐字不变`);
    assert.equal(factoryText(root, name), base, '出厂文件没被写');
  }
  const results = buildPatches({ root });
  for (const r of results) {
    assert.ok(r.file.startsWith(root + path.sep), 'patch 只写进临时 root');
    assert.ok(fs.readFileSync(r.file, 'utf8').includes('【覆盖测试】这一行来自 state/preset-overrides。'));
  }
});

await test('覆盖文件 600、目录 700、原子写不留临时文件；removeOverride 回到出厂', () => {
  const root = fixture('perm');
  const name = 'qq-chat-v2';
  const file = writeOverride(root, name, '正文');
  assert.equal(file, overridePath(root, name));
  assert.equal(file, path.join(root, 'state', 'preset-overrides', 'qq-chat-v2.prefix.md'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['qq-chat-v2.prefix.md']);
  assert.equal(readOverride(root, name), '正文');
  assert.equal(removeOverride(root, name), true);
  assert.equal(removeOverride(root, name), false);
  assert.equal(effectivePresetYaml(root, name), factoryText(root, name));
});

await test('覆盖套不上（不满足安全不变量）→ 告警一次、按出厂生成', () => {
  const root = fixture('blocked');
  writeOverride(root, 'qq-chat-v2', '太短');
  const logs = [];
  assert.equal(effectivePresetYaml(root, 'qq-chat-v2', { log: (m) => logs.push(m) }), factoryText(root, 'qq-chat-v2'));
  assert.equal(logs.length, 1);
  assert.equal(renderPatch('qq-chat-v2', { root }), fs.readFileSync(patchFileFor('qq-chat-v2'), 'utf8'));
});

await test('覆盖文件读失败（是个目录）→ 按没有覆盖', () => {
  const root = fixture('unreadable');
  fs.mkdirSync(overridePath(root, 'qq-chat'), { recursive: true });
  assert.equal(readOverride(root, 'qq-chat'), null);
  assert.equal(effectivePresetYaml(root, 'qq-chat'), factoryText(root, 'qq-chat'));
});

await test('未知 preset 名被拒（含路径穿越）', () => {
  const root = fixture('unknown');
  for (const bad of ['standard', '../qq-chat', 'qq-chat/../../x', '', 'QQ-CHAT', 'qq-chat-v2 ']) {
    assert.throws(() => overridePath(root, bad), /未知预设/, bad);
    assert.throws(() => readOverride(root, bad), /未知预设/, bad);
    assert.throws(() => writeOverride(root, bad, 'x'), /未知预设/, bad);
    assert.throws(() => removeOverride(root, bad), /未知预设/, bad);
    assert.throws(() => effectivePresetYaml(root, bad), /未知预设/, bad);
  }
  assert.equal(fs.existsSync(path.join(root, 'state')), false);
});

await test('开发副本的出厂 dsh/agent-presets/ 前后 sha256 不变', () => {
  assert.equal(dirHash(path.join(REPO, 'dsh', 'agent-presets')), factoryDirHash);
});

fs.rmSync(BASE, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
console.log('\n全部通过');
