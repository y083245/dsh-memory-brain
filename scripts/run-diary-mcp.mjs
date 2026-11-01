#!/usr/bin/env node
// 启动 diary MCP（属于外部的 ai-companion-kit）。所有路径都可以用环境变量覆盖，
// 缺省值只是作者本机的布局示例，请按自己的环境改。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitDir, runMcp } from './run-mcp.mjs';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT_DIR = kitDir();
runMcp({
  label: 'diary-mcp',
  entry: path.join(KIT_DIR, 'packages', 'diary-mcp', 'src', 'diary-mcp.js'),
  env: { DIARY_DIR: process.env.DIARY_DIR || path.join(REPO_DIR, 'state', 'diary') }
});
