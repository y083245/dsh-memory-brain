// 测试读配置：优先用户本机的 config.json，全新 clone 没有它时回退 config.example.json。
// 这样单元测试不要求先复制配置，也不会因为用户改了本地配置而改变断言。
import fs from 'node:fs';
import path from 'node:path';

export function readTestConfig(root) {
  const errors = [];
  for (const name of ['config.json', 'config.example.json']) {
    const file = path.join(root, name);
    try {
      let text = fs.readFileSync(file, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return JSON.parse(text);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        errors.push(`${name} 不存在`);
        continue;
      }
      throw new Error(`读不了 ${file}：${error?.message ?? error}`);
    }
  }
  throw new Error(`找不到可用的测试配置（${errors.join('；')}）`);
}
