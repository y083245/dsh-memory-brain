#!/usr/bin/env bash
# 兼容旧用法：真正的实现在 scripts/start-all.mjs（Linux/Windows 共用）。
# 用 $0 定位仓库根，从任意目录调用都能找到脚本。
exec node "$(cd "$(dirname "$0")" && pwd)/scripts/start-all.mjs" "$@"
