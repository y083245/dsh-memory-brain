#!/usr/bin/env bash
set -euo pipefail
# 启动语音 MCP（属于外部的 ai-companion-kit）。所有路径都可以用环境变量覆盖，
# 缺省值只是作者本机的布局示例，请按自己的环境改。
KIT_DIR="${AI_COMPANION_KIT_DIR:-$HOME/ai-companion-kit/ai-companion-kit-main}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
export VOICE_CONFIG="${VOICE_CONFIG:-$REPO_DIR/voice-config.json}"
exec "$NODE_BIN" \
  "$KIT_DIR/packages/voice-mcp/src/voice-mcp.js"
