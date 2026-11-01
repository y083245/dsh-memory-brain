// 跨平台单元测试入口（npm test / CI 用）。
//
// 自动收集 scripts/test-*.mjs，排除需要真实 DSH/QQ、真实浏览器、或仓库里不存在的内部文档的测试。
// 新增测试默认会进来；如果是 e2e / probe，请同时更新下面的 EXCLUDED 注释。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const EXCLUDED = new Map([
  ['test-audit.mjs', '它是本目录测试的另一个汇总入口，单独运行'],
  ['test-unit.mjs', '本文件（测试入口本身，不能递归）'],
  ['test-mode.mjs', '共享测试助手（不是用例）'],
  ['test-links.mjs', '共享测试助手（不是用例）'],
  ['test-config.mjs', '共享测试助手（不是用例）'],
  ['test-console.mjs', '需要真实运行的桥接（控制台 :3100）'],
  ['test-console-ui.mjs', '需要 Playwright / 真实浏览器'],
  ['test-dsh-auth.mjs', '需要正在运行的 DSH'],
  ['test-dsh-session-retire.mjs', '需要正在运行的 DSH'],
  ['test-dsh-v2-wait.mjs', '需要正在运行的 DSH'],
  ['test-onebot-connection.mjs', '需要真实 SnowLuma / OneBot'],
  ['test-preset-local-tools.mjs', '需要本机已安装 DSH 的 node_modules（CI 不装 DSH）'],
  ['test-voice-system.mjs', '读取被 .gitignore 排除的内部文档 docs/guides/VOICE.md'],
]);

const tests = fs.readdirSync(SCRIPTS)
  .filter((name) => /^test-.*\.mjs$/.test(name) && !EXCLUDED.has(name))
  .sort();

let failed = 0;
for (const name of tests) {
  console.log(`\nRunning ${name}`);
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, name)], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 180000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.error || result.status !== 0) {
    failed += 1;
    console.error(`FAILED ${name}: ${result.error?.message || `exit ${result.status}`}`);
  }
}

console.log(`\nUnit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
for (const [name, reason] of EXCLUDED) console.log(`  excluded ${name} — ${reason}`);
process.exitCode = failed ? 1 : 0;
