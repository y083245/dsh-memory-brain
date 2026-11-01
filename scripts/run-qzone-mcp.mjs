#!/usr/bin/env node
// 启动 QQ 空间 MCP（属于外部的 ai-companion-kit）。所有路径都可以用环境变量覆盖，
// 缺省值只是作者本机的布局示例，请按自己的环境改。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitDir, runMcp } from './run-mcp.mjs';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT_DIR = kitDir();
runMcp({
  label: 'qzone-mcp',
  entry: path.join(KIT_DIR, 'packages', 'qzone-mcp', 'src', 'qzone-mcp.js'),
  env: {
    QZONE_CONFIG: process.env.QZONE_CONFIG || path.join(REPO_DIR, 'config.json'),
    SNOWLUMA_HTTP_URL: process.env.SNOWLUMA_HTTP_URL || 'http://127.0.0.1:3000',
    QZONE_IMAGE_DIRS: process.env.QZONE_IMAGE_DIRS || path.join(os.homedir(), 'qzone-images')
  }
});
