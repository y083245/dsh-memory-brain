#!/usr/bin/env bash
# SYSTEMD_PATCH：把桥接、memory-rag、embedding 装成 systemd 用户服务（~/.config/systemd/user/）。
#
# 为什么：从 Claude 桌面版命令里拉起的服务挂在它的 cgroup 下，应用一重启就全被杀（CLAUDE.md 坑 21）；
# 装成用户服务后进程归 systemd 管，崩了还会自动拉起。QQ / SnowLuma / DSH 不在这里管。
#
# 用法：
#   scripts/systemd/install.sh               # 渲染模板、写 unit、daemon-reload；不启动、不设开机自启
#   scripts/systemd/install.sh --print       # 只把渲染结果打到终端，不写任何文件
#   scripts/systemd/install.sh --enable      # 另外设桥接开机自启（需要时顺带 loginctl enable-linger）
#   scripts/systemd/install.sh --enable-rag  # 另外设向量记忆（memory-rag + embedding）开机自启
#   scripts/systemd/install.sh --disable     # 取消三个服务的开机自启（unit 保留）
#   scripts/systemd/install.sh --uninstall   # 删掉 unit（服务还在跑时拒绝，先 stop-all.sh / systemctl --user stop）
#
# 装好后 start-all.sh / stop-all.sh 会自动改用 systemctl --user 启停这三个服务。
# 路径可用环境变量覆盖：NODE_BIN、PNPM_HOME、EMBED_BIN、EMBED_MODEL。
set -euo pipefail

# systemd 只存在于 Linux；Windows 原生（Git Bash 的 MINGW）没有 systemctl --user。
case "$(uname -s)" in
  Linux) ;;
  *) echo "[fail] scripts/systemd/install.sh 只支持 Linux；Windows 请用 start-all.bat / stop-all.bat（PID 文件管理）" >&2; exit 1 ;;
esac

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$SRC_DIR/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
RUN_DIR="$HOME/.ai-companion-run"
UNITS=(qq-bridge.service qq-memory-rag.service qq-embedding.service)

ok()   { printf '\033[1;32m  ok  \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; }
sd()   { XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user "$@"; }

MODE=install
for arg in "$@"; do
  case "$arg" in
    --print) MODE=print ;;
    --enable) MODE=enable ;;
    --enable-rag) MODE=enable-rag ;;
    --disable) MODE=disable ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) err "未知参数：$arg（可用：--print --enable --enable-rag --disable --uninstall）"; exit 2 ;;
  esac
done

if [ "$MODE" = disable ]; then
  sd disable "${UNITS[@]}" 2>&1 | sed 's/^/  /' || true
  ok "已取消开机自启（unit 还在，start-all.sh / stop-all.sh 照常用 systemd 启停）"
  exit 0
fi

if [ "$MODE" = uninstall ]; then
  for u in "${UNITS[@]}"; do
    st="$(sd show -p ActiveState --value "$u" 2>/dev/null || true)"
    case "$st" in
      ""|inactive|failed) ;;
      *) err "$u 现在是 $st，先停掉（stop-all.sh --rag / systemctl --user stop $u）再卸载"; exit 1 ;;
    esac
  done
  sd disable "${UNITS[@]}" >/dev/null 2>&1 || true
  for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u"; done
  sd daemon-reload
  sd reset-failed "${UNITS[@]}" >/dev/null 2>&1 || true
  ok "已删除 unit；start-all.sh / stop-all.sh 回到原来的 nohup 方式"
  exit 0
fi

# ── 解析路径（和 start-all.sh 的取法一致）──────────────────────────────
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { err "找不到 node"; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"
PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
EMBED_BIN="${EMBED_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
EMBED_MODEL="${EMBED_MODEL:-/path/to/Qwen3-Embedding-8B-Q8_0.gguf}"
RAG_DIR="$BRIDGE_DIR/sidecars/memory-rag"
RAG_PY="$RAG_DIR/.venv/bin/python"
UNIT_PATH="$NODE_DIR:$PNPM_HOME/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 24 ] 2>/dev/null || warn "node 是 v$node_major（$NODE_BIN），线上一直用的是 nvm 的 v24"
[ -x "$RAG_PY" ] || warn "找不到 memory-rag 的虚拟环境（$RAG_PY），qq-memory-rag 起不来"
[ -x "$EMBED_BIN" ] && [ -f "$EMBED_MODEL" ] || warn "找不到 llama-server 或 embedding 模型，qq-embedding 会一直被跳过"

# unit 文件里不做引号转义：路径带空白、% 或 | 就直接拒绝，免得渲染出的命令行被拆错。
for v in "$BRIDGE_DIR" "$HOME" "$RUN_DIR" "$NODE_BIN" "$PNPM_HOME" "$EMBED_BIN" "$EMBED_MODEL" "$RAG_DIR"; do
  case "$v" in
    *[[:space:]%\|]*) err "路径里有空白、% 或 |，unit 文件里没法直接用：$v"; exit 1 ;;
  esac
done

render() {
  sed -e "s|{{BRIDGE_DIR}}|$BRIDGE_DIR|g" \
      -e "s|{{HOME}}|$HOME|g" \
      -e "s|{{RUN_DIR}}|$RUN_DIR|g" \
      -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
      -e "s|{{PNPM_HOME}}|$PNPM_HOME|g" \
      -e "s|{{PATH}}|$UNIT_PATH|g" \
      -e "s|{{EMBED_BIN}}|$EMBED_BIN|g" \
      -e "s|{{EMBED_MODEL}}|$EMBED_MODEL|g" \
      -e "s|{{RAG_DIR}}|$RAG_DIR|g" \
      -e "s|{{RAG_PY}}|$RAG_PY|g" \
      "$SRC_DIR/$1.in"
}

if [ "$MODE" = print ]; then
  for u in "${UNITS[@]}"; do
    echo "# ───── $UNIT_DIR/$u"
    render "$u"
    echo
  done
  exit 0
fi

mkdir -p "$UNIT_DIR" "$RUN_DIR"
for u in "${UNITS[@]}"; do
  out="$(render "$u")"
  if grep -q '{{' <<<"$out"; then err "$u 还有没替换的占位符"; exit 1; fi
  printf '%s\n' "$out" >"$UNIT_DIR/$u.tmp"
  mv -f "$UNIT_DIR/$u.tmp" "$UNIT_DIR/$u"
  ok "已写入 $UNIT_DIR/$u"
done
sd daemon-reload
ok "systemctl --user daemon-reload"

for u in "${UNITS[@]}"; do
  st="$(sd show -p ActiveState --value "$u" 2>/dev/null || true)"
  case "$st" in
    active|activating|reloading) warn "$u 正在运行，新 unit 要 systemctl --user restart $u 之后才生效" ;;
  esac
done

case "$MODE" in
  enable|enable-rag)
    if [ "$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null)" != "yes" ]; then
      loginctl enable-linger "$(id -u)"
      ok "loginctl enable-linger（不登录桌面也会启动用户服务）"
    fi
    if [ "$MODE" = enable ]; then
      sd enable qq-bridge.service
      ok "已设桥接开机自启（QQ 仍要手动登录；桥接在那之前只是空转重连）"
    else
      sd enable qq-memory-rag.service qq-embedding.service
      ok "已设向量记忆开机自启（embedding 开机时显存不足会自动跳过）"
    fi
    ;;
esac

echo
echo "  状态     systemctl --user status qq-bridge qq-memory-rag qq-embedding"
echo "  启动     ~/qq-bridge/start-all.sh（--rag 只起向量记忆）"
echo "  只停向量记忆  ~/qq-bridge/stop-all.sh --rag"
echo "  只重启桥接    systemctl --user restart qq-bridge"
echo "  日志     $RUN_DIR/{bridge,memory-rag,embed}.log"
