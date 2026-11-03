#!/usr/bin/env bash
# UPGRADE_PATCH：回到升级前（约定 docs/design/worker-kit/upgrade/contract.md §4 末尾）。
#
# 用法：
#   bash scripts/rollback.sh [--yes] [<备份文件>]
#     缺省用 state/upgrade.json 里最后一条升级记录的备份；给了备份文件就找对应的那条记录（要它的 fromCommit）。
#
# 做什么：停桥接 / memory-rag → git checkout --detach <升级前的提交> → 把当前 state/、config.json 再打包一份
#   （rollback-pre-<时间>.tar.gz）→ 解包备份覆盖 state/、config.json → 首次迁移挪走的文件放回原处 →
#   重新生成派生 patch → 起服务 → 健康检查 → 记 result: rolled-back。
# 永远不碰 QQ、SnowLuma；DSH 只在那次升级重启过它时才重启，而且只按 PID 逐个停。
#
# 退出码：0 回滚完成；1 检查没通过（什么都没改）；2 中途失败；3 用户取消。
# 测试保险同 update.sh：QQB_UPDATE_TEST=1 时仓库必须在 /tmp/ 下，外部命令只走 QQB_FAKE_BIN，健康检查只打 QQB_HEALTH_BASE。
set -euo pipefail
# 备份、upgrade.json 等自己写的东西一律 077；git / npm / 启停脚本沿用用户原来的 umask（orig），
# 否则 merge 进来的出厂文件都会变成 600。
# 自复制后 exec 的那份继承的是 077，所以原来的 umask 经环境变量 QQB_ORIG_UMASK 传过去。
ORIG_UMASK="${QQB_ORIG_UMASK:-$(umask)}"
[[ "$ORIG_UMASK" =~ ^[0-7]{3,4}$ ]] || ORIG_UMASK=0022
export QQB_ORIG_UMASK="$ORIG_UMASK"
umask 077
orig() { (umask "$ORIG_UMASK"; "$@"); }

TOTAL=8
step() { printf '\n\033[1;36m[%s/%s]\033[0m %s\n' "$1" "$TOTAL" "$2"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok  \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; }

YES=0; BACKUP_ARG=""
ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) err "未知参数：$1（可用：--yes [<备份文件>]）"; exit 1 ;;
    *) [ -z "$BACKUP_ARG" ] || { err "只能给一个备份文件"; exit 1; }; BACKUP_ARG="$1" ;;
  esac
  shift
done

IS_TEST=0
test_guard() {
  [ "${QQB_UPDATE_TEST:-}" = "1" ] || return 0
  IS_TEST=1
  local real
  real="$(cd "$1" 2>/dev/null && pwd -P)" || { err "QQB_UPDATE_TEST=1：仓库路径不存在"; exit 1; }
  case "$real/" in
    /tmp/*|/private/tmp/*) ;;
    *) err "QQB_UPDATE_TEST=1 但仓库不在 /tmp/ 下（$real），拒绝运行"; exit 1 ;;
  esac
  [ -n "${QQB_FAKE_BIN:-}" ] && [ -d "$QQB_FAKE_BIN" ] || { err "QQB_UPDATE_TEST=1 但没有 QQB_FAKE_BIN"; exit 1; }
  [ -n "${QQB_HEALTH_BASE:-}" ] || { err "QQB_UPDATE_TEST=1 但没有 QQB_HEALTH_BASE"; exit 1; }
  case ":$PATH:" in "$QQB_FAKE_BIN:"*) ;; *) export PATH="$QQB_FAKE_BIN:$PATH" ;; esac
}

# 自复制：checkout 回老提交时本文件会消失（老版本里没有它）。
if [ -z "${QQB_ROLLBACK_SELF:-}" ] || [ ! -f "${QQB_ROLLBACK_SELF}/rollback.sh" ]; then
  REPO="${QQB_UPDATE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  test_guard "$REPO"
  SELF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qqb-rollback.XXXXXX")"
  cp "${BASH_SOURCE[0]}" "$SELF_DIR/rollback.sh"
  export QQB_UPDATE_REPO="$REPO" QQB_ROLLBACK_SELF="$SELF_DIR"
  exec bash "$SELF_DIR/rollback.sh" "${ARGS[@]+"${ARGS[@]}"}"
fi
REPO="$(cd "$QQB_UPDATE_REPO" && pwd)"
WORK="$QQB_ROLLBACK_SELF"
test_guard "$REPO"
CHANGED=0; HANDLED=0
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$HANDLED" != "1" ] && [ "$CHANGED" = "1" ]; then
    err "回滚中途出错（退出码 $rc）；当前数据另存在 ${PRE_BACKUP:-（还没来得及打包）}"
    rc=2
  fi
  case "$WORK" in */qqb-rollback.*) rm -rf "$WORK" ;; esac
  exit "$rc"
}
trap on_exit EXIT
die1() { err "$*"; HANDLED=1; exit 1; }
fail2() { err "回滚失败：$*"; [ -n "${PRE_BACKUP:-}" ] && err "回滚前的数据另存在 $PRE_BACKUP"; HANDLED=1; exit 2; }

G() { git -C "$REPO" -c core.quotepath=false "$@"; }
bin_of() {
  if [ "$IS_TEST" = "1" ]; then
    [ -x "$QQB_FAKE_BIN/$1" ] && printf '%s' "$QQB_FAKE_BIN/$1"
    return 0
  fi
  command -v "$1" 2>/dev/null || true
}
need_bin() {
  local b
  b="$(bin_of "$1")"
  [ -n "$b" ] || { err "找不到命令 $1"; return 1; }
  printf '%s' "$b"
}
sdctl() {
  local b
  b="$(need_bin systemctl)" || return 1
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" "$b" --user "$@"
}
send_signal() {
  local sig="$1" pid="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || { warn "跳过不合法的 PID：$pid"; return 1; }
  if [ "$IS_TEST" = "1" ]; then "$(need_bin kill)" "-$sig" "$pid"; else kill "-$sig" "$pid"; fi
}
pgrep_f() {
  local b
  b="$(need_bin pgrep)" || return 0
  "$b" -f "$1" 2>/dev/null || true
}
ps_field() {
  local b
  b="$(need_bin ps)" || return 0
  "$b" -o "$1=" -p "$2" 2>/dev/null || true
}

# ── UPGRADE_PATCH（第 2 轮）：QQ / SnowLuma 在不在跑 ─────────────────────────────
# ./start-all.sh 会把没在跑的 QQ、SnowLuma 一起拉起来（QQ 可能要扫码、SnowLuma 要重新注入），
# 所以凡是要走 ./start-all.sh（--rag 除外）之前都先确认这两个都在跑；不在跑就连停都不停，只提示。
# 只用 pgrep -x / ps 的输出 + /proc 核对，绝不 pgrep -f（CLAUDE.md 坑 3）。测试时不读真 /proc（替身 PID 不对应真进程）。
QQ_BIN="${QQ_BIN:-/opt/QQ/qq}"
use_proc() { [ "$IS_TEST" != "1" ] && [ -d /proc/self ]; }
qq_running() {
  local b pid exe args real_bin
  b="$(need_bin pgrep)" || return 1
  real_bin="$(readlink -f "$QQ_BIN" 2>/dev/null || printf '%s' "$QQ_BIN")"
  for pid in $("$b" -x qq 2>/dev/null || true); do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if use_proc && exe="$(readlink "/proc/$pid/exe" 2>/dev/null)"; then
      if [ "$exe" = "$QQ_BIN" ] || [ "$exe" = "$real_bin" ]; then return 0; fi
      continue
    fi
    args="$(ps_field args "$pid")"
    case "$args" in "$QQ_BIN"|"$QQ_BIN "*|"$real_bin"|"$real_bin "*) return 0 ;; esac
  done
  return 1
}
snowluma_running() {
  local b pid args first cwd
  b="$(need_bin ps)" || return 1
  while read -r pid args; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case "$args" in *index.mjs*) ;; *) continue ;; esac
    first="${args%% *}"
    case "${first##*/}" in node|node[0-9]*) ;; *) continue ;; esac
    if use_proc && cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"; then
      case "$cwd" in */SnowLuma-*) return 0 ;; esac
      continue
    fi
    return 0
  done < <("$b" -eo pid=,args= 2>/dev/null || true)
  return 1
}
host_running() { qq_running && snowluma_running; }
host_missing() {  # 打印哪个没在跑
  local m=()
  qq_running || m+=(QQ)
  snowluma_running || m+=(SnowLuma)
  local IFS=/
  printf '%s' "${m[*]}"
}
ask() {
  [ "$YES" = "1" ] && return 0
  if [ "$IS_TEST" = "1" ] && [ -n "${QQB_TEST_ANSWERS+x}" ]; then
    local a="${QQB_TEST_ANSWERS%%,*}"
    if [ "$QQB_TEST_ANSWERS" = "$a" ]; then QQB_TEST_ANSWERS=""; else QQB_TEST_ANSWERS="${QQB_TEST_ANSWERS#*,}"; fi
    printf '%s [y/N] %s\n' "$1" "$a"
    [[ "$a" =~ ^([yY]|yes|是)$ ]]
    return
  fi
  if [ ! -t 0 ]; then
    printf '%s\n' "$1"
    err "不是终端、也没有 --yes，按「否」处理"
    HANDLED=1
    exit 3
  fi
  local answer=""
  read -r -p "$1 [y/N] " answer || true
  [[ "$answer" =~ ^([yY]|yes|是)$ ]]
}

# upgrade.json 的读写（node，原子写 600）。
cat > "$WORK/uj.mjs" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
const [cmd, arg] = process.argv.slice(2);
const repo = process.env.UJ_REPO;
const file = path.join(repo, 'state', 'upgrade.json');
const read = () => {
  if (!fs.existsSync(file)) return { version: 1 };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : { version: 1 };
};
const write = (doc) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...doc, version: 1 }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
};
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (cmd === 'find') {
  // 找记录：给了备份路径就找最后一条 backup 相同的；否则最后一条。存到 entry 文件，给 shell 打印几个字段。
  const history = Array.isArray(read().history) ? read().history : [];
  const entry = arg ? [...history].reverse().find((h) => h?.backup && real(h.backup) === real(arg)) : history.at(-1);
  if (!entry) process.exit(4);
  fs.writeFileSync(process.env.UJ_ENTRY_FILE, JSON.stringify(entry), { mode: 0o600 });
  const safe = (v) => String(v ?? '').replace(/[\r\n]/g, ' ');
  console.log(`FROM_COMMIT=${safe(entry.fromCommit).replace(/[^0-9a-f]/g, '')}`);
  console.log(`FROM=${safe(entry.from)}`);
  console.log(`TO=${safe(entry.to)}`);
  console.log(`BACKUP=${safe(entry.backup)}`);
  console.log(`RESTARTED=${(Array.isArray(entry.restarted) ? entry.restarted : []).join(',').replace(/[^a-z,-]/g, '')}`);
  console.log(`FIRST_RUN_BACKUP=${safe(entry.firstRunBackup)}`);
  console.log(`BACKUP_PRUNED=${entry.backupPruned === true ? 1 : 0}`);
} else if (cmd === 'put') {
  // 解包后 upgrade.json 是升级前的版本：把这次的记录补回去，标成 rolled-back。
  const entry = JSON.parse(fs.readFileSync(process.env.UJ_ENTRY_FILE, 'utf8'));
  const doc = read();
  const history = Array.isArray(doc.history) ? doc.history : [];
  const next = { ...entry, result: 'rolled-back', rolledBackAt: new Date().toISOString() };
  if (process.env.UJ_PRE_BACKUP) next.rollbackPreBackup = process.env.UJ_PRE_BACKUP;
  if (process.env.UJ_HEALTH === 'fail') next.rollbackHealth = 'failed';
  const skipped = (process.env.UJ_SKIPPED || '').split(',').filter(Boolean);
  if (skipped.length) next.rollbackSkipped = skipped;
  const i = history.findIndex((h) => h?.at === entry.at && h?.backup === entry.backup);
  if (i >= 0) history[i] = next; else history.push(next);
  write({ ...doc, history });
} else if (cmd === 'restore-first-run') {
  // 首次迁移挪进覆盖层的文件放回原处（老版本程序只读 roles/ 和出厂文件），并删掉迁移新建的覆盖层文件。
  const dir = arg;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const inside = (rel) => {
    const abs = path.resolve(repo, rel);
    if (!abs.startsWith(path.resolve(repo) + path.sep)) throw new Error(`路径越界：${rel}`);
    return abs;
  };
  let n = 0;
  for (const item of manifest.items ?? []) {
    const abs = inside(item.path);
    const saved = path.join(dir, 'files', item.path);
    if (['role-modified', 'role-untracked', 'preset', 'rag-config'].includes(item.kind) && fs.existsSync(saved)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(saved, abs);
      n += 1;
    } else if (item.kind === 'role-deleted') {
      fs.rmSync(abs, { force: true });
      n += 1;
    }
    if (item.created) fs.rmSync(inside(item.created), { force: true });
  }
  if (manifest.hidden?.created) fs.rmSync(path.join(repo, 'state', 'roles', 'hidden.json'), { force: true });
  console.log(String(n));
} else {
  process.exit(2);
}
EOF

# ── 1. 找记录 ────────────────────────────────────────────────────────────
step 1 "找升级记录"
[ -f "$REPO/src/bridge.js" ] && [ -e "$REPO/.git" ] || die1 "$REPO 不像 qq-bridge 仓库"
[ -f "$REPO/docs/design/HANDOFF.md" ] && die1 "这个目录里有 docs/design/HANDOFF.md（作者本机的线上目录），不要用 rollback.sh"
ENTRY_FILE="$WORK/entry.json"
FROM_COMMIT=""; FROM=""; TO=""; BACKUP=""; RESTARTED=""; FIRST_RUN_BACKUP=""; BACKUP_PRUNED=0
frc=0
fields="$(UJ_REPO="$REPO" UJ_ENTRY_FILE="$ENTRY_FILE" node "$WORK/uj.mjs" find "$BACKUP_ARG")" || frc=$?
[ "$frc" -eq 0 ] || die1 "state/upgrade.json 里找不到${BACKUP_ARG:+这个备份的}升级记录，不知道该回到哪个提交"
while IFS='=' read -r k v; do
  case "$k" in
    FROM_COMMIT) FROM_COMMIT="$v" ;; FROM) FROM="$v" ;; TO) TO="$v" ;; BACKUP) BACKUP="$v" ;;
    RESTARTED) RESTARTED="$v" ;; FIRST_RUN_BACKUP) FIRST_RUN_BACKUP="$v" ;; BACKUP_PRUNED) BACKUP_PRUNED="$v" ;;
  esac
done <<< "$fields"
[ -n "$BACKUP_ARG" ] && BACKUP="$BACKUP_ARG"
[ -n "$FROM_COMMIT" ] && G cat-file -e "$FROM_COMMIT^{commit}" 2>/dev/null || die1 "记录里的升级前提交不存在：${FROM_COMMIT:-（空）}"
if [ ! -f "$BACKUP" ]; then
  if [ "$BACKUP_PRUNED" = "1" ]; then
    die1 "这次升级的备份已经按保留规则清理掉了（每类只留最新 3 份）：$BACKUP。没法用它回滚；可以指定 ~/qq-bridge-backups/ 里还在的备份：bash scripts/rollback.sh <备份文件>"
  fi
  die1 "备份文件不存在：$BACKUP（可能被手动删了）。请指定 ~/qq-bridge-backups/ 里还在的备份：bash scripts/rollback.sh <备份文件>"
fi
# 备份里只许有 state/ 与 config.json，防止解包写到别处。
bad="$(tar tzf "$BACKUP" | grep -vE '^(state(/|$)|config\.json$)' | sed -n 1p || true)"
[ -z "$bad" ] || die1 "备份文件里有 state/、config.json 以外的东西，拒绝解包"
if tar tzf "$BACKUP" | grep -qE '(^|/)\.\.(/|$)'; then die1 "备份文件里有 .. 路径，拒绝解包"; fi
ok "记录：$FROM → $TO"

# ── 2. 确认 ──────────────────────────────────────────────────────────────
step 2 "确认"
info "将回到提交 $FROM_COMMIT（$FROM）"
info "将用备份还原 state/ 与 config.json：$BACKUP"
info "当前的 state/、config.json 会先另存一份"
ask "确定回滚吗？" || { info "已取消，什么都没改"; HANDLED=1; exit 3; }

# ── 3. 检查工作区 ─────────────────────────────────────────────────────────
step 3 "检查工作区"
DERIVED=(plugins/qq-agent-presets/presets/qq-chat.patch.yml plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml)
dirty="$(G status --porcelain=v1 --untracked-files=all --no-renames | grep -vF -e "${DERIVED[0]}" -e "${DERIVED[1]}" || true)"
[ -z "$dirty" ] || die1 "工作区有改动（$(printf '%s' "$dirty" | wc -l | tr -d ' ') 个文件），先自己处理再回滚"
ok "工作区干净"

# ── 4. 停服务 ────────────────────────────────────────────────────────────
step 4 "停桥接 / memory-rag（不碰 QQ、SnowLuma）"
UNIT_DIR="$HOME/.config/systemd/user"
unit_installed() { [ -f "$UNIT_DIR/$1" ]; }
rag_enabled() {
  node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(c&&c.memoryRag&&c.memoryRag.enabled===true?0:1)}catch{process.exit(1)}' "$REPO/config.json"
}
wait_gone() {
  local pid i
  for pid in "$@"; do
    for i in $(seq 1 20); do send_signal 0 "$pid" 2>/dev/null || break; sleep 1; done
  done
}
start_all() { (cd "$REPO" && umask "$ORIG_UMASK" && ./start-all.sh "$@"); }
stop_all() { (cd "$REPO" && umask "$ORIG_UMASK" && ./stop-all.sh "$@"); }
dsh_pids() {
  local pid cur ppid args chain i
  for pid in $(pgrep_f 'apps/cli/src/bin\.ts web'); do
    [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || continue
    chain="$pid"; cur="$pid"
    for i in 1 2 3 4; do
      ppid="$(ps_field ppid "$cur" | tr -d ' ')"
      [[ "$ppid" =~ ^[0-9]+$ ]] && [ "$ppid" -gt 1 ] || break
      args="$(ps_field args "$ppid")"
      case "$args" in *pnpm*|*"bin.ts web"*) chain="$ppid $chain"; cur="$ppid" ;; *) break ;; esac
    done
    printf '%s\n' $chain
  done | awk '!seen[$0]++'
}
CHANGED=1
if unit_installed qq-bridge.service; then
  sdctl stop qq-bridge.service || fail2 "停桥接失败"
else
  pids="$(pgrep_f '^node src/bridge.js$')"
  for p in $pids; do send_signal TERM "$p" || true; done
  # shellcheck disable=SC2086
  if [ -n "$pids" ]; then wait_gone $pids; fi
fi
ok "桥接已停"
if rag_enabled; then
  if unit_installed qq-memory-rag.service; then sdctl stop qq-memory-rag.service || fail2 "停 memory-rag 失败"
  else stop_all --rag || fail2 "停向量记忆失败"
  fi
  ok "memory-rag 已停"
fi

# ── 5. 代码回到升级前 ─────────────────────────────────────────────────────
step 5 "代码回到 $FROM_COMMIT"
for f in "${DERIVED[@]}"; do
  if G cat-file -e "HEAD:$f" 2>/dev/null; then orig G checkout HEAD -- "$f" || true; fi
done
orig G checkout --quiet --detach "$FROM_COMMIT" || fail2 "git checkout --detach 失败"
ok "HEAD = $(G rev-parse --short HEAD)"

# ── 6. 还原数据 ──────────────────────────────────────────────────────────
step 6 "还原 state/ 与 config.json"
BACKUP_DIR="$HOME/qq-bridge-backups"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
PRE_BACKUP="$BACKUP_DIR/rollback-pre-$(date +%Y%m%d-%H%M%S).tar.gz"
n=1
while [ -e "$PRE_BACKUP" ]; do PRE_BACKUP="${PRE_BACKUP%.tar.gz}-$n.tar.gz"; n=$((n + 1)); done
ITEMS=()
[ -d "$REPO/state" ] && ITEMS+=(state)
[ -f "$REPO/config.json" ] && ITEMS+=(config.json)
rc=0
if [ "${#ITEMS[@]}" -gt 0 ]; then
  tar czf "$PRE_BACKUP" -C "$REPO" --exclude=state/long-memory/rag/chroma --exclude='state/long-memory/rag/rag.sqlite3*' \
    --exclude=state/long-memory/rag/watermarks.json "${ITEMS[@]}" || rc=$?
else
  tar czf "$PRE_BACKUP" -T /dev/null || rc=$?
fi
[ "$rc" -le 1 ] || fail2 "另存当前数据失败（tar 退出码 $rc）"
chmod 600 "$PRE_BACKUP"
info "当前数据另存在 $PRE_BACKUP"
tar xzf "$BACKUP" -C "$REPO" || fail2 "解包备份失败"
ok "已用备份还原"
if [ -n "$FIRST_RUN_BACKUP" ] && [ -f "$FIRST_RUN_BACKUP/manifest.json" ]; then
  cnt="$(UJ_REPO="$REPO" node "$WORK/uj.mjs" restore-first-run "$FIRST_RUN_BACKUP")" || fail2 "放回首次迁移挪走的文件失败"
  ok "首次迁移挪走的 $cnt 个文件已放回原处"
fi

# ── 7. 派生文件、起服务 ───────────────────────────────────────────────────
step 7 "重新生成派生 patch、起服务"
if [ -f "$REPO/scripts/build-agent-preset-patches.mjs" ]; then
  (cd "$REPO" && umask "$ORIG_UMASK" && node scripts/build-agent-preset-patches.mjs) || fail2 "重新生成 preset patch 失败"
fi
RAG_ON=0
rag_enabled && RAG_ON=1
if [ "$RAG_ON" = "1" ]; then
  if unit_installed qq-memory-rag.service; then sdctl start qq-memory-rag.service || fail2 "起 memory-rag 失败"
  else start_all --rag || fail2 "起向量记忆失败"
  fi
fi
# UPGRADE_PATCH（第 2 轮）：要走 ./start-all.sh（不带 --rag）之前先确认 QQ、SnowLuma 都在跑，
# 否则 start-all.sh 会替用户把它们拉起来。DSH 按「先检查再停」：不在跑就不停它；
# 桥接在第 4 步已经停了（还原数据时不能有桥接在写），这里只是不起它、提示用户。
HOST_OK=0
host_running && HOST_OK=1
SKIPPED=""
skip_start() {
  warn "$(host_missing) 没在运行，为了不替你启动它们，本脚本没有拉起 $1；请先登录 QQ，再运行 ./start-all.sh"
  SKIPPED="${SKIPPED:+$SKIPPED,}$1"
}
NEED_DSH=0
case ",$RESTARTED," in *",dsh,"*) NEED_DSH=1 ;; esac
if [ "$NEED_DSH" = "1" ]; then
  if [ "$HOST_OK" = "1" ]; then
    pids="$(dsh_pids)"
    for p in $pids; do send_signal TERM "$p" || true; done
    # shellcheck disable=SC2086
    if [ -n "$pids" ]; then wait_gone $pids; fi
    info "DSH 已按 PID 停（那次升级重启过它，回滚后也要重启）"
  else
    skip_start dsh
    info "  DSH 没停，仍是升级后的版本在跑；QQ 登录好以后请按 PID 停掉它再运行 ./start-all.sh"
  fi
fi
if unit_installed qq-bridge.service; then
  sdctl start qq-bridge.service || fail2 "起桥接失败"
  if [ "$NEED_DSH" = "1" ] && [ "$HOST_OK" = "1" ]; then start_all || fail2 "起 DSH 失败"; fi
elif [ "$HOST_OK" = "1" ]; then
  start_all || fail2 "起桥接失败（./start-all.sh）"
else
  skip_start bridge
  info "  桥接现在是停着的；QQ 登录好以后运行 ./start-all.sh 把它起来"
fi
ok "服务已起${SKIPPED:+（没起的：${SKIPPED//,/、}）}"

# ── 8. 健康检查、记录 ─────────────────────────────────────────────────────
step 8 "健康检查"
CONSOLE_PORT="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=Number(c.consolePort);process.stdout.write(String(p>0?p:3100))}catch{process.stdout.write("3100")}' "$REPO/config.json")"
if [ "$IS_TEST" = "1" ]; then BRIDGE_BASE="$QQB_HEALTH_BASE"; RAG_BASE="$QQB_HEALTH_BASE"
else BRIDGE_BASE="http://127.0.0.1:$CONSOLE_PORT"; RAG_BASE="http://127.0.0.1:8093"; fi
probe() {
  HC_KIND="$1" HC_BRIDGE="$BRIDGE_BASE" HC_RAG="$RAG_BASE" HC_TOKEN_FILE="$REPO/state/console-token" node --input-type=module -e '
    import fs from "node:fs";
    const kind = process.env.HC_KIND;
    const headers = {};
    let url;
    if (kind === "bridge") {
      url = process.env.HC_BRIDGE + "/api/status";
      try { headers["x-console-token"] = fs.readFileSync(process.env.HC_TOKEN_FILE, "utf8").trim(); } catch {}
    } else url = process.env.HC_RAG + "/health";
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000), redirect: "error" });
      if (!res.ok) process.exit(1);
      if (kind === "rag") {
        const body = await res.json().catch(() => null);
        if (!body || body?.schema?.readonly === true) process.exit(1);
      }
      process.exit(0);
    } catch { process.exit(1); }' >/dev/null 2>&1
}
wait_healthy() {
  local kind="$1" deadline=$((SECONDS + ${QQB_HEALTH_WAIT:-60}))
  while :; do
    probe "$kind" && return 0
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 1
  done
}
HEALTH=ok
case ",$SKIPPED," in
  *",bridge,"*) info "桥接这次没起，不检查" ;;
  *) wait_healthy bridge || HEALTH=fail ;;
esac
if [ "$HEALTH" = "ok" ] && [ "$RAG_ON" = "1" ]; then
  # 回到的老版本 memory-rag 没有 schema 字段也算正常（readonly 只在新版本里才可能为 true）。
  wait_healthy rag || HEALTH=fail
fi
UJ_REPO="$REPO" UJ_ENTRY_FILE="$ENTRY_FILE" UJ_PRE_BACKUP="$PRE_BACKUP" UJ_HEALTH="$HEALTH" UJ_SKIPPED="$SKIPPED" node "$WORK/uj.mjs" put \
  || warn "没能写 state/upgrade.json"
if [ "$HEALTH" != "ok" ]; then
  err "代码和数据已回到升级前，但健康检查没通过：请看 ~/.ai-companion-run/ 下的日志"
  HANDLED=1
  exit 2
fi
ok "回滚完成：HEAD = $(G rev-parse --short HEAD)；回滚前的数据另存在 $PRE_BACKUP"
HANDLED=1
exit 0
