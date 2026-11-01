// 目录链接助手：Windows 上普通 symlink 需要开发者模式/管理员，junction 不需要。
import fs from 'node:fs';

export function linkDir(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
