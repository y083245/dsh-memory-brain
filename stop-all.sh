#!/usr/bin/env bash
# 按反序停止：qq-bridge → memory-rag → embedding → SnowLuma → QQ → DSH（DSH 是通用服务，默认保留）
#
# 用法：
#   ./stop-all.sh          # 停桥接、向量记忆、SnowLuma、QQ
#   ./stop-all.sh --all    # 连 DSH 一起停
#   ./stop-all.sh --rag    # 只停向量记忆（memory-rag 8093 + embedding 8091），其它一概不动
#
# 桥接 / memory-rag / embedding 装成 systemd 用户服务后（scripts/systemd/install.sh），先 systemctl --user stop
# 它们（主动停的不会被自动拉起），再按原来的办法清掉 systemd 之外的旧进程；没装时行为不变。
set -uo pipefail

# 注意：/opt/QQ/qq 是作者本机的 QQ 安装位置示例，请按自己的环境改。
# 可用 QQ_BIN 环境变量覆盖，缺省值保持作者本机原样。
QQ_BIN="${QQ_BIN:-/opt/QQ/qq}"
RUN_DIR="$HOME/.ai-companion-run"
STOP_DSH=0
RAG_ONLY=0

log()  { printf '\033[1;36m[stop]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok  \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# ── SYSTEMD_PATCH ────────────────────────────────────────────────────
# systemctl stop 只停这个 unit 自己 cgroup 里的进程，碰不到 DSH / QQ 的进程组（CLAUDE.md 坑 19）。
# 一定要先停 unit 再按 pgrep / PID 文件清旧进程：桥接 unit 是 Restart=always，先 kill 的话 5 秒后又被拉起来。
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
sd() { XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user "$@"; }
use_unit() {
  [ -f "$SYSTEMD_USER_DIR/$1" ] || return 1
  [ "$(sd show -p LoadState --value "$1" 2>/dev/null)" = "loaded" ] && return 0
  warn "$1 已安装，但 systemctl --user 连不上或还没加载它，这次按旧方式处理（systemd 若在管它，可能会被重新拉起）"
  return 1
}
# stop_unit <unit> <label>：在跑、正在起、或等着自动重启（activating）都要 stop，后者不 stop 的话几秒后又起来。
stop_unit() {
  local unit="$1" label="$2" st
  st="$(sd show -p ActiveState --value "$unit" 2>/dev/null || true)"
  case "$st" in
    inactive|failed|"") ok "$label 未运行（systemd：$unit）"; return 0 ;;
  esac
  log "停止 $label（systemctl --user stop $unit）"
  if sd stop "$unit"; then
    ok "$label 已停止"
  else
    warn "systemctl --user stop $unit 失败，看：systemctl --user status $unit"
  fi
}
port_up() { ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"; }

for arg in "$@"; do
  case "$arg" in
    --all) STOP_DSH=1 ;;
    --rag) RAG_ONLY=1 ;;
    *) warn "未知参数：$arg（可用：--all、--rag）" ;;
  esac
done

kill_pat() {
  local pat="$1" label="$2"
  local pids
  pids="$(pgrep -f "$pat" 2>/dev/null | grep -v -e "^$$\$" -e "^$PPID\$" || true)"
  if [ -z "$pids" ]; then
    ok "$label 未运行"
    return 0
  fi
  log "停止 $label（PIDs: $pids）"
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f "$pat" >/dev/null 2>&1 || { ok "$label 已停止"; return 0; }
    sleep 1
  done
  warn "$label 10 秒内未退出，强制结束"
  kill -KILL $pids 2>/dev/null || true
  ok "$label 已强制停止"
}

# ── RAG_PATCH：向量记忆（P1）的停止逻辑 ─────────────────────────────────
#
# 为什么不用 pkill -f / pgrep -f：命令行里带 `llama-server`、`memory_rag.app` 字样的进程
# 会被一起匹配 —— 包括正在执行这条命令的 shell 自己（CLAUDE.md 坑 3）。这里只认 PID 文件
# 和端口，并且在 kill 前用 /proc/<pid>/cmdline 核对身份，防止 PID 被复用后误杀别的进程。
# 重定向顺序要注意：`<"/proc/$1/cmdline" 2>/dev/null` 是**先**重定向 stdin 再重定向 stderr，
# 进程已退出时 shell 会先把「没有那个文件或目录」打到终端；整组重定向才能把它吞掉。
pid_cmdline() { { tr '\0' ' ' <"/proc/$1/cmdline"; } 2>/dev/null || true; }

# pid_matches <pid> <pattern>：这个 PID 的命令行里是否含 pattern。
pid_matches() {
  local cmd
  cmd="$(pid_cmdline "$1")"
  [ -n "$cmd" ] || return 1
  case "$cmd" in *"$2"*) return 0 ;; esac
  return 1
}

# port_pid <port>：监听这个端口的进程 PID（拿不到就输出空）。
port_pid() {
  ss -ltnp 2>/dev/null | grep -E "[:.]$1[[:space:]]" | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2
}

# stop_rag_service <pidfile> <port> <cmdline-pattern> <label>
#   有 PID 文件且 cmdline 对得上 → 用它；PID 文件陈旧 → 只删文件（不 kill）；
#   没有可信 PID 时按端口找，同样核对 cmdline 才停。
stop_rag_service() {
  local pidfile="$1" port="$2" pattern="$3" label="$4"
  local pid=""

  if [ -f "$pidfile" ]; then
    pid="$(tr -dc '0-9' <"$pidfile" 2>/dev/null || true)"
  fi

  if [ -n "$pid" ] && pid_matches "$pid" "$pattern"; then
    :
  elif [ -n "$pid" ]; then
    # 进程没了（正常退出/被系统清掉）和「PID 被别的进程复用」是两回事，提示要说准。
    if [ -d "/proc/$pid" ]; then
      warn "$label 的 PID 文件已失效（$pid 现在是别的进程，可能被系统复用了），删掉 PID 文件"
    else
      warn "$label 的 PID 文件里的进程 $pid 已经不在了，删掉 PID 文件"
    fi
    rm -f "$pidfile"
    pid=""
  fi

  if [ -z "$pid" ]; then
    pid="$(port_pid "$port")"
    if [ -n "$pid" ] && pid_matches "$pid" "$pattern"; then
      log "$label 没有 PID 文件，按端口 $port 找到进程 $pid"
    else
      if [ -n "$pid" ]; then warn "端口 $port 上的进程 $pid 不是 $label，不动它"; fi
      rm -f "$pidfile"
      ok "$label 未运行"
      return 0
    fi
  fi

  log "停止 $label（PID $pid）"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    [ -d "/proc/$pid" ] || { rm -f "$pidfile"; ok "$label 已停止"; return 0; }
    sleep 1
  done
  warn "$label 10 秒内未退出，强制结束"
  kill -KILL "$pid" 2>/dev/null || true
  sleep 1
  rm -f "$pidfile"
  if [ -d "/proc/$pid" ]; then
    warn "$label 已发 KILL，但 PID $pid 仍在（可能是等父进程回收的僵尸，不影响端口）"
  else
    ok "$label 已强制停止"
  fi
}

stop_rag() {
  # SYSTEMD_PATCH：先停 unit；之后端口还被占、或留着旧 PID 文件，才按原来的办法清 systemd 之外的那份。
  if use_unit qq-memory-rag.service; then
    stop_unit qq-memory-rag.service memory-rag
    if port_up 8093 || [ -f "$RUN_DIR/memory-rag.pid" ]; then
      stop_rag_service "$RUN_DIR/memory-rag.pid" 8093 'memory_rag.app' 'memory-rag（systemd 之外）'
    fi
  else
    stop_rag_service "$RUN_DIR/memory-rag.pid" 8093 'memory_rag.app' 'memory-rag'
  fi
  if use_unit qq-embedding.service; then
    stop_unit qq-embedding.service embedding
    if port_up 8091 || [ -f "$RUN_DIR/embed.pid" ]; then
      stop_rag_service "$RUN_DIR/embed.pid" 8091 'llama-server' 'embedding（systemd 之外）'
    fi
  else
    stop_rag_service "$RUN_DIR/embed.pid" 8091 'llama-server' 'embedding'
  fi
}

# --rag：只停向量记忆，其它服务（桥接/DSH/QQ/SnowLuma）一概不动。
if [ "$RAG_ONLY" = "1" ]; then
  echo
  log "只停向量记忆（--rag）"
  stop_rag
  echo
  exit 0
fi

echo
if use_unit qq-bridge.service; then
  stop_unit qq-bridge.service qq-bridge
  # systemd 之外还有一份（切换前用旧方式拉起的）也一起停
  if pgrep -f 'node src/bridge.js' 2>/dev/null | grep -qv -e "^$$\$" -e "^$PPID\$"; then
    kill_pat 'node src/bridge.js' 'qq-bridge（systemd 之外）'
  fi
else
  kill_pat 'node src/bridge.js' 'qq-bridge'
fi
# 桥接停了再停检索服务：桥接在跑时会不断请求 memory-rag。
stop_rag
kill_pat 'api_v2\.py' 'GPT-SoVITS API'
kill_pat 'SnowLuma-[^/]*/index\.mjs' 'SnowLuma'

# QQ 只杀 $QQ_BIN 下的进程，不会误伤脚本
if pgrep -f "^$QQ_BIN( |\$)" >/dev/null 2>&1; then
  log "停止 QQ"
  pkill -TERM -f "^$QQ_BIN( |\$)" 2>/dev/null || true
  sleep 2
  pgrep -f "^$QQ_BIN( |\$)" >/dev/null 2>&1 && pkill -KILL -f "^$QQ_BIN( |\$)" 2>/dev/null || true
  ok "QQ 已停止"
else
  ok "QQ 未运行"
fi

if [ "$STOP_DSH" = "1" ]; then
  kill_pat 'apps/cli/src/bin\.ts web' 'DSH'
  kill_pat 'pnpm dsh web' 'DSH(pnpm)'
else
  echo
  warn "DSH 保留运行；要一起停：$0 --all"
fi

rm -f "$RUN_DIR"/*.pid 2>/dev/null || true
echo
