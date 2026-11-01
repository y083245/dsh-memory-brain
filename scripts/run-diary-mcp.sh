#!/usr/bin/env bash
# 兼容旧用法：实现在 run-diary-mcp.mjs，用 process.execPath 定位 node。
exec node "$(cd "$(dirname "$0")" && pwd)/run-diary-mcp.mjs" "$@"
