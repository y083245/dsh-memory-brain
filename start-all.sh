#!/usr/bin/env bash
# 一键按顺序启动：DSH → QQ → SnowLuma → 等 OneBot → qq-bridge
#
# 用法：
#   ./start-all.sh                  # 全部启动（向量记忆默认关，不占显存）
#   START_RAG=1 ./start-all.sh      # 连向量记忆一起起（embedding :8091 + memory-rag :8093）
#   ./start-all.sh --rag            # 只起向量记忆，起完就退出（不动 DSH/QQ/SnowLuma/桥接）
#
# 特点：
#   - 已经在跑的环节自动跳过，可以反复执行
#   - 不依赖 sudo（前提是 node 已经有 cap_sys_ptrace，脚本会检查）
#   - 日志统一放在 ~/.ai-companion-run/
#   - QQ 需要扫码时，脚本会等你最多 180 秒
#   - 桥接 / memory-rag / embedding 装成 systemd 用户服务后（scripts/systemd/install.sh），
#     这三个改用 systemctl --user 起，崩溃自动拉起；没装时照旧 nohup 起
#
# 注意：下文的程序路径（SnowLuma 版本目录、QQ 安装位置、llama.cpp / embedding 模型等）
# 是作者本机的示例，请按自己的环境修改。它们都可以用同名环境变量覆盖
# （DSH_DIR / SNOW_DIR / BRIDGE_DIR / QQ_BIN / GSV_DIR / EMBED_BIN / EMBED_MODEL /
# NODE_BIN），不设时用下面这些缺省值。
set -uo pipefail

HOME_DIR="$HOME"
RUN_DIR="$HOME_DIR/.ai-companion-run"
DSH_DIR="${DSH_DIR:-$HOME_DIR/deepseek-harness}"
SNOW_DIR="${SNOW_DIR:-$HOME_DIR/snowluma/SnowLuma-v2.2.0-linux-x64-lite}"
if [ ! -d "$SNOW_DIR" ]; then
  # 版本升级后目录名会变，自动找最新的 lite 包
  SNOW_DIR="$(ls -d "$HOME_DIR"/snowluma/SnowLuma-*-lite 2>/dev/null | sort -V | tail -n 1 || true)"
fi
BRIDGE_DIR="${BRIDGE_DIR:-$HOME_DIR/qq-bridge}"
QQ_BIN="${QQ_BIN:-/opt/QQ/qq}"
GSV_DIR="${GSV_DIR:-$HOME_DIR/gpt-sovits}"
GSV_PY="$GSV_DIR/.venv/bin/python"
# 本地 GPT-SoVITS 暂时停用（发语音走 MiMo）。需要时：START_GSV=1 ./start-all.sh
START_GSV="${START_GSV:-0}"
# RAG_PATCH：向量记忆（embedding + memory-rag）默认关 —— 8B embedding 常驻约 9 GB 显存，
# 会和 ComfyUI 生图抢。关着不影响桥接：检索会自动降级为关键词检索。
START_RAG="${START_RAG:-0}"
RAG_ONLY=0
RAG_DIR="$BRIDGE_DIR/sidecars/memory-rag"
RAG_PY="$RAG_DIR/.venv/bin/python"
EMBED_BIN="${EMBED_BIN:-$HOME_DIR/llama.cpp/build/bin/llama-server}"
EMBED_MODEL="${EMBED_MODEL:-/path/to/Qwen3-Embedding-8B-Q8_0.gguf}"

mkdir -p "$RUN_DIR"

# Node：优先用当前 nvm 版本，找不到再退回 PATH
NODE_BIN="${NODE_BIN:-$HOME_DIR/.nvm/versions/node/v24.22.1/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
NPM_BIN="$(dirname "$NODE_BIN" 2>/dev/null)/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"
# 非交互 shell（ssh 远程执行、cron、systemd）不加载 ~/.bashrc，里面 nvm 和 pnpm 的 PATH 都没有：
# DSH / 桥接里的 `node` 会落到系统自带的 /usr/bin/node（v22），pnpm 干脆找不到（DSH 起不来）。
# 这里按 .bashrc 的写法自己补上，让它们和交互终端里跑的一样，用 nvm 的 node（2026-10-30 子项目 2 上线时踩过）。
if [ -n "$NODE_BIN" ]; then
  NODE_DIR="$(dirname "$NODE_BIN")"
  case ":$PATH:" in *":$NODE_DIR:"*) ;; *) export PATH="$NODE_DIR:$PATH" ;; esac
fi
export PNPM_HOME="${PNPM_HOME:-$HOME_DIR/.local/share/pnpm}"
case ":$PATH:" in *":$PNPM_HOME/bin:"*) ;; *) export PATH="$PNPM_HOME/bin:$PATH" ;; esac
PNPM_BIN="$(command -v pnpm || true)"
[ -n "$PNPM_BIN" ] || PNPM_BIN="$PNPM_HOME/bin/pnpm"

log()  { printf '\033[1;36m[start]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok  \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; }

port_up() { ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"; }

# wait_port <port> <seconds> <label>
wait_port() {
  local p="$1" t="$2" label="$3" i=0
  while [ "$i" -lt "$t" ]; do
    port_up "$p" && return 0
    sleep 1
    i=$((i + 1))
  done
  err "$label 在 ${t}s 内没有监听端口 $p"
  return 1
}

qq_running() { pgrep -f '^/opt/QQ/qq( |$)' >/dev/null 2>&1; }

# ── SYSTEMD_PATCH：桥接 / memory-rag / embedding 可以装成 systemd 用户服务 ──────────────
# 装了（scripts/systemd/install.sh）就改用 systemctl --user 起：进程挂在 systemd 自己的 cgroup 里，
# 不会随 Claude 桌面版重启被一起杀掉（CLAUDE.md 坑 21），崩了 systemd 自动拉起。没装就走下面原来的 nohup 写法。
SYSTEMD_USER_DIR="$HOME_DIR/.config/systemd/user"
QQB_HELPER="$(cd "$(dirname "$0")" && pwd)/scripts/systemd/qqb-helper.sh"
sd() { XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user "$@"; }
sd_state() { sd show -p ActiveState --value "$1" 2>/dev/null || true; }
# use_unit <unit>：unit 文件装了且 systemd 认得它。
use_unit() {
  [ -f "$SYSTEMD_USER_DIR/$1" ] || return 1
  [ "$(sd show -p LoadState --value "$1" 2>/dev/null)" = "loaded" ] && return 0
  warn "$1 已安装，但 systemctl --user 连不上或还没加载它（要 daemon-reload？），这次按旧方式处理"
  return 1
}
# sd_start <unit>：清掉上次撞到重启频率上限留下的 failed，再起。
sd_start() {
  sd reset-failed "$1" >/dev/null 2>&1 || true
  sd start "$1"
}

for arg in "$@"; do
  case "$arg" in
    --rag) RAG_ONLY=1; START_RAG=1 ;;
    *) warn "未知参数：$arg（可用：--rag）" ;;
  esac
done

# rag_wait_health <port> <seconds> <grep-pattern>：轮询 /health 直到响应里出现 pattern。
# 两个服务的健康响应形状不同：llama-server 是 {"status":"ok"}，memory-rag 是 {"ok":true,...}，
# 而且 embedding 没起来时 memory-rag 的 ok 也会是 false —— 那说明服务本身是活的（会降级为 BM25），
# 所以 memory-rag 这里用 "embedding" 字段判断进程是否起来，而不是用 ok。
rag_wait_health() {
  local p="$1" t="$2" pat="$3" i=0
  while [ "$i" -lt "$t" ]; do
    curl -s --max-time 2 "http://127.0.0.1:$p/health" 2>/dev/null | grep -q "$pat" && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# SYSTEMD_PATCH：sd_running <unit> <label>：systemd 正管着它（在跑或正在起）就报一句、返回 0。
sd_running() {
  case "$(sd_state "$1")" in
    active|reloading) ok "$2 已在运行（systemd：$1）"; return 0 ;;
    activating) ok "$2 正在由 systemd 启动（$1）"; return 0 ;;
  esac
  return 1
}

# SYSTEMD_PATCH：向量记忆的 systemd 版。判断标准和 start_rag 里的 nohup 版一样（显存、程序、模型），
# 只是放在 qqb-helper.sh 里，unit 的 ExecCondition 也用它 —— 崩溃后自动重启前同样会再判一次显存。
start_rag_units() {
  local reason=""
  # ── embedding ──
  if sd_running qq-embedding.service embedding; then
    :
  elif port_up 8091; then
    ok "embedding 已在运行（8091，不是 systemd 起的，本次不管它）"
  elif ! reason="$("$QQB_HELPER" embed-check "$EMBED_BIN" "$EMBED_MODEL")"; then
    warn "${reason#\[qqb\] }"
  else
    log "启动 embedding 服务（systemd：qq-embedding.service，约占用 9 GB 显存）..."
    # unit 的 ExecStartPost 会等 /health 就绪（最多 90 秒），systemctl start 要等它返回。
    sd_start qq-embedding.service || warn "systemctl 启动 qq-embedding 失败，看：systemctl --user status qq-embedding"
    if rag_wait_health 8091 5 '"ok"'; then
      ok "embedding 已就绪（8091）"
    else
      warn "embedding 没就绪，检索会自动降级为只走 BM25；看日志：$RUN_DIR/embed.log"
    fi
  fi

  # ── memory-rag ──
  if sd_running qq-memory-rag.service memory-rag; then
    :
  elif port_up 8093; then
    ok "memory-rag 已在运行（8093，不是 systemd 起的，本次不管它）"
  elif [ ! -x "$RAG_PY" ]; then
    warn "找不到 memory-rag 的虚拟环境（$RAG_DIR/.venv），跳过；检索会自动降级"
  else
    log "启动 memory-rag 索引服务（systemd：qq-memory-rag.service）..."
    sd_start qq-memory-rag.service || warn "systemctl 启动 qq-memory-rag 失败，看：systemctl --user status qq-memory-rag"
    if rag_wait_health 8093 60 '"embedding"'; then
      ok "memory-rag 已就绪（8093）"
    else
      warn "memory-rag 60s 内没就绪，检索会降级为关键词；看日志：$RUN_DIR/memory-rag.log"
    fi
  fi
}

# 向量记忆（可选的两段）：embedding :8091 → memory-rag :8093。
# 为什么任何一步失败都只 warn 不 exit：桥接在 memory-rag 不可用时会自动降级为关键词检索，
# 「语义检索暂时不可用」不该拦住整个机器人启动。
start_rag() {
  local free_mib="" running=""
  echo
  if [ "$START_RAG" != "1" ]; then
    # 没开 START_RAG 不等于没在跑（可能之前用 --rag 起过）。如实说明，别让人以为服务被停了。
    port_up 8091 && running="8091"
    port_up 8093 && running="${running:+$running/}8093"
    if [ -n "$running" ]; then
      ok "向量记忆没有开启（START_RAG=0），但检测到在运行（$running），本次不管它"
    else
      ok "向量记忆已关闭，跳过（需要时 START_RAG=1 ./start-all.sh，或只起它：./start-all.sh --rag）"
    fi
    return 0
  fi
  log "向量记忆：embedding（8091）→ memory-rag（8093）"
  if use_unit qq-embedding.service && use_unit qq-memory-rag.service; then
    start_rag_units
    return 0
  fi

  # ── embedding ──
  if port_up 8091; then
    ok "embedding 已在运行（8091）"
  else
    free_mib="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ')"
    if ! printf '%s' "$free_mib" | grep -qE '^[0-9]+$'; then
      warn "查不到显存空闲量（nvidia-smi 不可用），跳过 embedding；检索会自动只走 BM25"
    elif [ "$free_mib" -lt 10000 ]; then
      warn "显存空闲 ${free_mib} MiB < 10000 MiB，跳过 embedding（ComfyUI 在生图？）；检索会自动只走 BM25"
    elif [ ! -x "$EMBED_BIN" ] || [ ! -f "$EMBED_MODEL" ]; then
      warn "找不到 llama-server 或 embedding 模型，跳过 embedding；检索会自动只走 BM25"
    else
      log "启动 embedding 服务（约占用 9 GB 显存）..."
      ( cd "$HOME_DIR" && exec nohup "$EMBED_BIN" -m "$EMBED_MODEL" \
          --embedding --pooling last --host 127.0.0.1 --port 8091 -ngl 99 -c 8192 -ub 8192 \
        ) >"$RUN_DIR/embed.log" 2>&1 </dev/null &
      echo $! >"$RUN_DIR/embed.pid"
      if rag_wait_health 8091 60 '"ok"'; then
        ok "embedding 已就绪（8091）"
      else
        warn "embedding 60s 内没就绪，检索会自动降级为只走 BM25；看日志：$RUN_DIR/embed.log"
      fi
    fi
  fi

  # ── memory-rag ──
  if port_up 8093; then
    ok "memory-rag 已在运行（8093）"
  elif [ ! -x "$RAG_PY" ]; then
    warn "找不到 memory-rag 的虚拟环境（$RAG_DIR/.venv），跳过；检索会自动降级"
  else
    log "启动 memory-rag 索引服务..."
    ( cd "$RAG_DIR" && exec nohup "$RAG_PY" -W ignore::SyntaxWarning -m memory_rag.app \
      ) >"$RUN_DIR/memory-rag.log" 2>&1 </dev/null &
    echo $! >"$RUN_DIR/memory-rag.pid"
    if rag_wait_health 8093 60 '"embedding"'; then
      ok "memory-rag 已就绪（8093）"
    else
      warn "memory-rag 60s 内没就绪，检索会降级为关键词；看日志：$RUN_DIR/memory-rag.log"
    fi
  fi
}

# --rag：只执行向量记忆这一节（跳过 DSH/QQ/SnowLuma/桥接），起完打印汇总就退出。
if [ "$RAG_ONLY" = "1" ]; then
  start_rag
  echo
  printf '\033[1;32m向量记忆（可选）\033[0m\n'
  if port_up 8091; then echo "  embedding        http://127.0.0.1:8091"; else echo "  embedding        未运行（检索只走 BM25）"; fi
  if port_up 8093; then echo "  memory-rag       http://127.0.0.1:8093"; else echo "  memory-rag       未运行（检索降级为关键词）"; fi
  echo "  日志目录         $RUN_DIR"
  echo
  exit 0
fi

echo
log "检查基础依赖"

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { err "找不到 node"; exit 1; }
[ -n "$NPM_BIN" ]  && [ -x "$NPM_BIN" ]  || { err "找不到 npm"; exit 1; }
[ -d "$DSH_DIR" ]    || { err "找不到 DSH 目录：$DSH_DIR"; exit 1; }
[ -d "$SNOW_DIR" ]   || { err "找不到 SnowLuma 目录：$SNOW_DIR"; exit 1; }
[ -d "$BRIDGE_DIR" ] || { err "找不到 qq-bridge 目录：$BRIDGE_DIR"; exit 1; }
ok "node: $NODE_BIN"
ok "日志目录: $RUN_DIR"

# ── 0. GPT-SoVITS API（语音生成）────────────────────────────────────────
echo
if [ "$START_GSV" != "1" ]; then
  ok "GPT-SoVITS 已停用，跳过（需要时 START_GSV=1 ./start-all.sh）"
elif port_up 9880; then
  ok "GPT-SoVITS API 已在运行（9880）"
elif [ -x "$GSV_PY" ] && [ -f "$GSV_DIR/api_v2.py" ]; then
  log "启动 GPT-SoVITS API（首次加载模型可能要几十秒）..."
  ( cd "$GSV_DIR" && exec nohup "$GSV_PY" api_v2.py -a 127.0.0.1 -p 9880 \
      -c GPT_SoVITS/configs/tts_infer.yaml ) >"$RUN_DIR/gsv.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/gsv.pid"
  if wait_port 9880 120 "GPT-SoVITS"; then
    ok "GPT-SoVITS API 已就绪（9880）"
  else
    warn "GPT-SoVITS 没起来，语音生成暂时不可用；看日志：$RUN_DIR/gsv.log"
  fi
else
  warn "没找到 GPT-SoVITS（$GSV_DIR），跳过语音生成"
fi

# ── 0b. 向量记忆（可选：embedding 8091 + memory-rag 8093）─────────────
start_rag

# ── 1. DSH ────────────────────────────────────────────────────────────
echo
if port_up 3080; then
  ok "DSH 已在运行（3080）"
else
  log "启动 DSH..."
  ( cd "$DSH_DIR" && exec nohup "$PNPM_BIN" dsh web ) >"$RUN_DIR/dsh.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/dsh.pid"
  wait_port 3080 45 "DSH" || { err "看日志：$RUN_DIR/dsh.log"; exit 1; }
  ok "DSH 已就绪（3080）"
fi

# ── 2. QQ ────────────────────────────────────────────────────────────
echo
if qq_running; then
  ok "QQ 已在运行"
else
  [ -x "$QQ_BIN" ] || { err "没找到 QQ：$QQ_BIN"; exit 1; }
  log "启动 QQ（需要桌面会话）..."
  export DISPLAY="${DISPLAY:-:0}"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
  nohup "$QQ_BIN" --no-sandbox --disable-gpu --disable-software-rasterizer --disable-gpu-compositing \
    >"$RUN_DIR/qq.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/qq.pid"
  sleep 3
  qq_running || { err "QQ 没起来，看日志：$RUN_DIR/qq.log"; exit 1; }
  ok "QQ 已启动"
fi

# ── 3. SnowLuma ──────────────────────────────────────────────────────
echo
if port_up 5099; then
  ok "SnowLuma 已在运行（5099）"
else
  CAP="$(getcap "$(readlink -f "$NODE_BIN")" 2>/dev/null || true)"
  if ! printf '%s' "$CAP" | grep -q 'cap_sys_ptrace'; then
    err "node 缺少 cap_sys_ptrace，SnowLuma 无法注入 QQ。先执行："
    echo "  sudo setcap cap_sys_ptrace=ep \"$(readlink -f "$NODE_BIN")\""
    exit 1
  fi
  log "启动 SnowLuma..."
  ( cd "$SNOW_DIR" && exec nohup "$NODE_BIN" ./index.mjs ) >"$RUN_DIR/snowluma.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/snowluma.pid"
  wait_port 5099 25 "SnowLuma" || { err "看日志：$RUN_DIR/snowluma.log"; exit 1; }
  ok "SnowLuma 已就绪（5099）"
fi

# ── 4. 等 OneBot（QQ 登录）─────────────────────────────────────────────
echo
if port_up 3000 && port_up 3001; then
  ok "OneBot 已就绪（3000/3001）"
else
  log "等待 QQ 登录并打开 OneBot（最多 180 秒）..."
  log "  如果 QQ 弹出扫码窗口，请现在扫码"
  deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if port_up 3000 && port_up 3001; then break; fi
    sleep 2
  done
  if ! (port_up 3000 && port_up 3001); then
    err "OneBot 没起来，通常是 QQ 还没登录完"
    echo "  1) 看一下 QQ 窗口，扫码/确认登录"
    echo "  2) 登录完成后重新运行本脚本（已启动的会自动跳过）"
    echo "  3) SnowLuma 日志：$RUN_DIR/snowluma.log"
    tail -n 8 "$RUN_DIR/snowluma.log" 2>/dev/null | sed 's/^/     /'
    exit 1
  fi
  ok "OneBot 已就绪（3000/3001）"
fi

# ── 5. qq-bridge ─────────────────────────────────────────────────────
# SYSTEMD_PATCH：装了 qq-bridge.service 就交给 systemd 起；日志是追加的，所以只在本次新增的部分里找「SnowLuma 已连接」。
start_bridge_unit() {
  local off
  if sd_running qq-bridge.service qq-bridge; then return 0; fi
  if port_up 3100; then
    warn "qq-bridge 在跑，但不是 systemd 起的（3100），本次不管它"
    echo "  要切换到 systemd：先停掉它（kill \$(pgrep -f '^node src/bridge.js\$')），再重跑本脚本"
    return 0
  fi
  log "启动 qq-bridge（systemd：qq-bridge.service）..."
  off="$(stat -c %s "$RUN_DIR/bridge.log" 2>/dev/null || echo 0)"
  sd_start qq-bridge.service || { err "systemctl 启动失败，看：systemctl --user status qq-bridge"; exit 1; }
  wait_port 3100 40 "qq-bridge" || { err "看：systemctl --user status qq-bridge；日志：$RUN_DIR/bridge.log"; exit 1; }
  for _ in $(seq 1 20); do
    tail -c +"$((off + 1))" "$RUN_DIR/bridge.log" 2>/dev/null | grep -q 'SnowLuma 已连接' && break
    sleep 1
  done
  if tail -c +"$((off + 1))" "$RUN_DIR/bridge.log" 2>/dev/null | grep -q 'SnowLuma 已连接'; then
    ok "qq-bridge 已连接 SnowLuma"
  else
    warn "qq-bridge 已启动，但还没看到「SnowLuma 已连接」，看日志：$RUN_DIR/bridge.log"
  fi
  ok "qq-bridge 已就绪（3100，崩溃会被 systemd 自动拉起）"
}

echo
if use_unit qq-bridge.service; then
  start_bridge_unit
elif port_up 3100; then
  ok "qq-bridge 已在运行（3100）"
else
  log "启动 qq-bridge..."
  ( cd "$BRIDGE_DIR" && exec nohup "$NPM_BIN" start ) >"$RUN_DIR/bridge.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/bridge.pid"
  wait_port 3100 40 "qq-bridge" || { err "看日志：$RUN_DIR/bridge.log"; exit 1; }
  # 再等一会儿，让它连上 SnowLuma / DSH
  for _ in $(seq 1 20); do
    grep -q 'SnowLuma 已连接' "$RUN_DIR/bridge.log" 2>/dev/null && break
    sleep 1
  done
  if grep -q 'SnowLuma 已连接' "$RUN_DIR/bridge.log" 2>/dev/null; then
    ok "qq-bridge 已连接 SnowLuma"
  else
    warn "qq-bridge 已启动，但还没看到「SnowLuma 已连接」，看日志：$RUN_DIR/bridge.log"
  fi
  ok "qq-bridge 已就绪（3100）"
fi

# ── 汇总 ─────────────────────────────────────────────────────────────
echo
printf '\033[1;32m全部就绪\033[0m\n'
echo "  DSH              http://127.0.0.1:3080"
[ "$START_GSV" = "1" ] && echo "  GPT-SoVITS API   http://127.0.0.1:9880/docs"
if [ "$START_RAG" = "1" ]; then
  echo "  embedding        http://127.0.0.1:8091"
  echo "  memory-rag       http://127.0.0.1:8093"
fi
echo "  SnowLuma WebUI   http://127.0.0.1:5099"
echo "  桥接控制台       http://127.0.0.1:3100/"
echo "  控制台令牌       cat $BRIDGE_DIR/state/console-token"
echo "  带令牌直接打开   xdg-open \"http://127.0.0.1:3100/?token=\$(cat $BRIDGE_DIR/state/console-token)\""
echo "  日志目录         $RUN_DIR"
[ -f "$SYSTEMD_USER_DIR/qq-bridge.service" ] && echo "  systemd 服务     systemctl --user status qq-bridge qq-memory-rag qq-embedding"
echo
