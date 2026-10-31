#!/usr/bin/env bash
# SYSTEMD_PATCH：systemd 用户服务（qq-bridge / qq-memory-rag / qq-embedding）用到的小检查，
# start-all.sh 在 systemd 模式下也调它，两边判断标准一致。
#
# 用法：
#   qqb-helper.sh embed-check <llama-server> <模型.gguf>   # 能不能起 embedding；不能就打印原因、退出 1
#   qqb-helper.sh port-free <端口>                         # 端口空着退出 0，被占用打印原因、退出 1
#   qqb-helper.sh wait-health embed|rag <秒>               # 轮询 /health 直到就绪；超时退出 1
#
# 在 unit 里当 ExecCondition= 用：退出 1～254 表示「条件不满足」，单元回到 inactive，
# 不算失败、也不会触发 Restart=（显存被 ComfyUI 占着时不该每隔几秒重试一次）。
set -uo pipefail

port_up() { ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"; }

# 两个服务的健康响应形状不同（与 start-all.sh 的 rag_wait_health 一致）：
# llama-server 是 {"status":"ok"}，加载模型时是 503；memory-rag 用 "embedding" 字段判断进程起来了。
health_ok() {
  local port="$1" pat="$2"
  curl -s --max-time 2 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q "$pat"
}

cmd="${1:-}"
case "$cmd" in
  embed-check)
    bin="${2:-}" model="${3:-}"
    if port_up 8091; then
      echo "[qqb] 端口 8091 已被占用（可能是 systemd 之外拉起的 embedding），不再起一份"
      exit 1
    fi
    free_mib="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ')"
    if ! printf '%s' "$free_mib" | grep -qE '^[0-9]+$'; then
      echo "[qqb] 查不到显存空闲量（nvidia-smi 不可用），跳过 embedding；检索会自动只走 BM25"
      exit 1
    fi
    if [ "$free_mib" -lt 10000 ]; then
      echo "[qqb] 显存空闲 ${free_mib} MiB < 10000 MiB，跳过 embedding（ComfyUI 在生图？）；检索会自动只走 BM25"
      exit 1
    fi
    if [ ! -x "$bin" ] || [ ! -f "$model" ]; then
      echo "[qqb] 找不到 llama-server 或 embedding 模型，跳过 embedding；检索会自动只走 BM25"
      exit 1
    fi
    exit 0
    ;;
  port-free)
    if port_up "${2:-}"; then
      echo "[qqb] 端口 ${2:-} 已被占用（可能是 systemd 之外拉起的同一个服务），不再起一份"
      exit 1
    fi
    exit 0
    ;;
  wait-health)
    case "${2:-}" in
      embed) port=8091; pat='"ok"' ;;
      rag)   port=8093; pat='"embedding"' ;;
      *) echo "[qqb] wait-health 只认 embed / rag" >&2; exit 2 ;;
    esac
    secs="${3:-60}"
    for _ in $(seq 1 "$secs"); do
      health_ok "$port" "$pat" && exit 0
      sleep 1
    done
    echo "[qqb] ${secs}s 内 :$port/health 没就绪"
    exit 1
    ;;
  *)
    echo "用法：$0 embed-check <bin> <model> | port-free <port> | wait-health embed|rag <秒>" >&2
    exit 2
    ;;
esac
