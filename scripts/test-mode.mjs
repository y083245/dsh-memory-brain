// 测试里的 POSIX 权限断言助手。
//
// Windows 上 chmod 只切「只读」位，stat.mode 恒为 0666（或 0444），不能用来证明
// 600/700。真实保护由 state/ 的 ACL 负责（src/state-acl.mjs）；所以 Windows 上
// 明确跳过这几条断言并打印一次原因，其它平台保持原样。
import assert from 'node:assert/strict';
import fs from 'node:fs';

let notified = false;

export function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

export function assertPosixMode(file, expected, label = '') {
  if (process.platform === 'win32') {
    if (!notified) {
      console.log('SKIP POSIX mode 断言：Windows 的 chmod 只切只读位，mode 不反映 ACL（由 state/ ACL 负责）');
      notified = true;
    }
    return;
  }
  assert.equal(modeOf(file), expected, label || `权限应为 ${expected.toString(8)}`);
}
