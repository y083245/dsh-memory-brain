#!/usr/bin/env bash
# UPGRADE_PATCH：一条命令升级（约定 docs/design/worker-kit/upgrade/contract.md §4，规格 UPGRADE_SPEC.md §6）。
#
# 用法：
#   bash scripts/update.sh [--yes] [--to <tag>] [--with-rag] [--dry-run] [--check]
#     --check     只 fetch 并显示「当前 → 最新」与升级须知，不改任何东西
#     --dry-run   走完全部判断、打印将要做的每一步，不写、不拉、不重启
#     --to <tag>  升到指定标签（缺省：最新的正式版 v* 标签；没有标签时用 origin/main）
#     --with-rag  备份带上向量派生库（缺省不带：能重建、体积大）
#     --yes       所有询问都答「是」（无人值守用）
#
# 第一次升级（老版本里还没有本脚本）：
#   git fetch origin && git checkout origin/main -- scripts/update.sh
#   bash scripts/update.sh
#
# 退出码：0 成功 / 已是最新；1 检查没通过（代码没改）；2 升级中失败（会打印回滚命令）；3 用户取消。
#
# 几条硬规矩：
# - 永远不碰 QQ、SnowLuma（重启它们要扫码、要重新注入）；DSH 只按 PID 逐个停，绝不按进程组（CLAUDE.md 坑 19）。
# - 不打印任何令牌：state/console-token 只在健康检查的 node 进程里读，不进命令行参数。
# - 拒绝在含 docs/design/HANDOFF.md 的目录运行：那是作者本机的线上目录，走 merge-to-live.sh。
# - 测试保险：QQB_UPDATE_TEST=1 时仓库必须在 /tmp/ 下，所有外部命令只走 QQB_FAKE_BIN 里的替身，
#   健康检查只打 QQB_HEALTH_BASE。
set -euo pipefail
# 备份、upgrade.json 等自己写的东西一律 077；git / npm / 启停脚本沿用用户原来的 umask（orig），
# 否则 merge 进来的出厂文件都会变成 600。
# 自复制后 exec 的那份继承的是 077，所以原来的 umask 经环境变量 QQB_ORIG_UMASK 传过去。
ORIG_UMASK="${QQB_ORIG_UMASK:-$(umask)}"
[[ "$ORIG_UMASK" =~ ^[0-7]{3,4}$ ]] || ORIG_UMASK=0022
export QQB_ORIG_UMASK="$ORIG_UMASK"
umask 077
orig() { (umask "$ORIG_UMASK"; "$@"); }

TOTAL=13
step() { printf '\n\033[1;36m[%s/%s]\033[0m %s\n' "$1" "$TOTAL" "$2"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok  \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; }

YES=0; TO=""; WITH_RAG=0; DRY=0; CHECK=0
ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --to) [ $# -ge 2 ] || { err "--to 后面要跟标签"; exit 1; }; TO="$2"; shift ;;
    --to=*) TO="${1#--to=}" ;;
    --with-rag) WITH_RAG=1 ;;
    --dry-run) DRY=1 ;;
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) err "未知参数：$1（可用：--yes --to <tag> --with-rag --dry-run --check）"; exit 1 ;;
  esac
  shift
done
if [ -n "$TO" ] && ! [[ "$TO" =~ ^[A-Za-z0-9._/-]+$ ]]; then err "标签名不合法：$TO"; exit 1; fi

# ── 测试保险 ────────────────────────────────────────────────────────────
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

# ── 第 1 步：自复制（拉取时本文件会被覆盖，先挪到临时目录再 exec）────────────────
if [ -z "${QQB_UPDATE_SELF:-}" ] || [ ! -f "${QQB_UPDATE_SELF}/update.sh" ]; then
  REPO="${QQB_UPDATE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  test_guard "$REPO"
  SELF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qqb-update.XXXXXX")"
  cp "${BASH_SOURCE[0]}" "$SELF_DIR/update.sh"
  export QQB_UPDATE_REPO="$REPO" QQB_UPDATE_SELF="$SELF_DIR"
  exec bash "$SELF_DIR/update.sh" "${ARGS[@]+"${ARGS[@]}"}"
fi
REPO="$(cd "$QQB_UPDATE_REPO" && pwd)"
WORK="$QQB_UPDATE_SELF"
test_guard "$REPO"
cleanup() {
  case "$WORK" in */qqb-update.*) rm -rf "$WORK" ;; esac
}

G() { git -C "$REPO" -c core.quotepath=false "$@"; }

# 外部命令：测试时只认替身目录里的，绝不落到真命令上；找不到返回空。
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
send_signal() {  # send_signal <sig> <pid>：只认正整数 PID，绝不发给进程组
  local sig="$1" pid="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || { warn "跳过不合法的 PID：$pid"; return 1; }
  if [ "$IS_TEST" = "1" ]; then "$(need_bin kill)" "-$sig" "$pid"; else kill "-$sig" "$pid"; fi
}
pgrep_f() {
  local b
  b="$(need_bin pgrep)" || return 0
  "$b" -f "$1" 2>/dev/null || true
}
ps_field() {  # ps_field <ppid|args> <pid>
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

# ── 询问：--yes 直接是；不是终端又没 --yes 当作「否」并退出 3 ─────────────────────
# 测试时可用 QQB_TEST_ANSWERS="y,n" 依次给出回答（只在 QQB_UPDATE_TEST=1 时认）。
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

# ── 状态与收尾 ───────────────────────────────────────────────────────────
CHANGED=0; HANDLED=0; BACKUP=""; MERGED=0; FIRST_RUN_BACKUP=""; RESTARTED=""; SKIPPED=""
OLD_COMMIT=""; TARGET_COMMIT=""; OLD_LABEL=""; TARGET_LABEL=""

# state/upgrade.json 的读写（contract §2.3）：用 node，原子写、600、state/ 700。
write_uj_helper() {
  cat > "$WORK/uj.mjs" <<'UJEOF'
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
const list = (v) => (v || '').split(',').filter(Boolean);
if (cmd === 'append') {
  const doc = read();
  const entry = {
    at: new Date().toISOString(),
    from: process.env.UJ_FROM || '',
    to: process.env.UJ_TO || '',
    fromCommit: process.env.UJ_FROM_COMMIT || '',
    toCommit: process.env.UJ_TO_COMMIT || '',
    backup: process.env.UJ_BACKUP || '',
    result: process.env.UJ_RESULT || 'failed',
    restarted: list(process.env.UJ_RESTARTED),
  };
  if (list(process.env.UJ_SKIPPED).length) entry.skipped = list(process.env.UJ_SKIPPED);
  if (process.env.UJ_FIRST_RUN_BACKUP) entry.firstRunBackup = process.env.UJ_FIRST_RUN_BACKUP;
  doc.history = [...(Array.isArray(doc.history) ? doc.history : []), entry];
  write(doc);
} else if (cmd === 'prune') {
  // 保留规则：三类备份各自只留最新的 3 份（按文件名里的时间排序）；只认这三种文件名，目录里别的东西一概不碰。
  const dir = arg;
  const KEEP = 3;
  const protect = new Set(list(process.env.UJ_PROTECT).map((x) => path.resolve(x)));
  const kinds = [
    { re: /^update-\d{8}-\d{6}-.+\.tar\.gz$/, dir: false },
    { re: /^rollback-pre-\d{8}-\d{6}(-\d+)?\.tar\.gz$/, dir: false },
    { re: /^first-run-\d{8}-\d{6}$/, dir: true },
  ];
  const removed = new Set();
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const kind of kinds) {
    const hits = names.filter((n) => {
      if (!kind.re.test(n)) return false;
      const st = fs.lstatSync(path.join(dir, n));
      return kind.dir ? st.isDirectory() : st.isFile();
    }).sort().reverse();
    for (const n of hits.slice(KEEP)) {
      const abs = path.resolve(dir, n);
      if (protect.has(abs)) continue;
      fs.rmSync(abs, { recursive: kind.dir, force: true });
      removed.add(abs);
    }
  }
  if (removed.size && fs.existsSync(file)) {
    const doc = read();
    const gone = (x) => typeof x === 'string' && x !== '' && removed.has(path.resolve(x));
    for (const h of Array.isArray(doc.history) ? doc.history : []) {
      if (!h || typeof h !== 'object') continue;
      if (gone(h.backup)) h.backupPruned = true;
      if (gone(h.firstRunBackup)) h.firstRunBackupPruned = true;
      if (gone(h.rollbackPreBackup)) h.rollbackPreBackupPruned = true;
    }
    if (doc.firstRun && gone(doc.firstRun.backup)) doc.firstRun.backupPruned = true;
    write(doc);
  }
  console.log(String(removed.size));
} else {
  process.exit(2);
}
UJEOF
}
record_history() {  # record_history <ok|ok-partial|failed>
  [ "$DRY" = "1" ] && return 0
  [ -n "$BACKUP" ] || return 0
  UJ_REPO="$REPO" UJ_FROM="$OLD_LABEL" UJ_TO="$TARGET_LABEL" UJ_FROM_COMMIT="$OLD_COMMIT" UJ_TO_COMMIT="$TARGET_COMMIT" \
    UJ_BACKUP="$BACKUP" UJ_RESULT="$1" UJ_RESTARTED="$RESTARTED" UJ_SKIPPED="$SKIPPED" UJ_FIRST_RUN_BACKUP="$FIRST_RUN_BACKUP" \
    node "$WORK/uj.mjs" append || warn "没能写 state/upgrade.json"
}
rollback_hint() {
  if [ -n "$BACKUP" ]; then
    if [ "$MERGED" = "1" ] || [ -f "$REPO/scripts/rollback.sh" ]; then
      err "回滚：bash $REPO/scripts/rollback.sh $BACKUP"
    else
      err "回滚：QQB_UPDATE_REPO=$REPO bash <(git -C $REPO show $TARGET_COMMIT:scripts/rollback.sh) $BACKUP"
    fi
  fi
}
die1() { err "$*"; HANDLED=1; exit 1; }
fail2() {
  err "升级失败：$*"
  record_history failed
  rollback_hint
  HANDLED=1
  exit 2
}
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$HANDLED" != "1" ] && [ "$CHANGED" = "1" ]; then
    err "升级中途出错（退出码 $rc）"
    record_history failed
    rollback_hint
    rc=2
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT

step 1 "已把脚本复制到临时目录运行（拉取时仓库里的 update.sh 会被替换，不影响这次执行）"
[ "$IS_TEST" = "1" ] && info "测试模式：外部命令只用 $QQB_FAKE_BIN 里的替身"
[ "$DRY" = "1" ] && info "--dry-run：只打印将要做的事，不写、不拉、不重启"
write_uj_helper

# ── 第 2 步：检查 ─────────────────────────────────────────────────────────
step 2 "检查仓库"
[ -f "$REPO/src/bridge.js" ] && [ -e "$REPO/.git" ] || die1 "$REPO 不像 qq-bridge 仓库（缺 src/bridge.js 或 .git）"
if [ -f "$REPO/docs/design/HANDOFF.md" ]; then
  die1 "这个目录里有 docs/design/HANDOFF.md，是作者本机的线上目录：请走 merge-to-live.sh，不要用 update.sh"
fi
G remote get-url origin >/dev/null 2>&1 || die1 "没有 origin 远端（git remote get-url origin 失败）"
command -v node >/dev/null 2>&1 || die1 "找不到 node"
ok "仓库：$REPO"

# ── 第 3 步：获取更新、确定目标 ────────────────────────────────────────────
step 3 "获取更新（git fetch --tags origin）"
G fetch --tags --quiet origin || die1 "连不上 origin（git fetch 失败）"
if [ -n "$TO" ]; then
  TARGET_COMMIT="$(G rev-parse -q --verify "refs/tags/$TO^{commit}" 2>/dev/null)" || die1 "找不到标签 $TO"
  TARGET_LABEL="$TO"
else
  latest="$(G -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed -n 1p || true)"
  if [ -n "$latest" ]; then
    TARGET_COMMIT="$(G rev-parse "refs/tags/$latest^{commit}")"
    TARGET_LABEL="$latest"
  else
    TARGET_COMMIT="$(G rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null)" || die1 "没有 v* 标签，也没有 origin/main"
    TARGET_LABEL="origin/main@$(G rev-parse --short "$TARGET_COMMIT")"
  fi
fi
OLD_COMMIT="$(G rev-parse HEAD)"
pkg_version() { node -e 'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version;if(typeof v==="string")process.stdout.write("v"+v.replace(/^v/,""))}catch{}' "$1" 2>/dev/null || true; }
FROM_VER="$(G describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)"
[ -n "$FROM_VER" ] || FROM_VER="$(pkg_version "$REPO/package.json")"
OLD_LABEL="$(G describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null || true)"
[ -n "$OLD_LABEL" ] || OLD_LABEL="${FROM_VER:+$FROM_VER+}$(G rev-parse --short HEAD)"
TO_VER=""
[[ "$TARGET_LABEL" =~ ^v[0-9] ]] && TO_VER="$TARGET_LABEL"
info "当前：$OLD_LABEL（$(G rev-parse --short HEAD)）"
info "目标：$TARGET_LABEL（$(G rev-parse --short "$TARGET_COMMIT")）"
if [ "$TARGET_COMMIT" = "$OLD_COMMIT" ]; then ok "已是最新"; HANDLED=1; exit 0; fi
if G merge-base --is-ancestor "$TARGET_COMMIT" HEAD; then ok "当前版本已包含目标版本，不用升级"; HANDLED=1; exit 0; fi
G merge-base --is-ancestor HEAD "$TARGET_COMMIT" \
  || die1 "目标版本不是当前版本的后代：本地有自己的提交，没法快进。请先把自己的提交挪到别的分支再升级"

# ── 第 4 步：升级须知 ─────────────────────────────────────────────────────
step 4 "这次更新的内容与升级须知"
T="$WORK/t"
mkdir -p "$T/scripts/lib" "$T/src"
for f in scripts/migrate.mjs scripts/lib/upgrade-notes.mjs src/preset-prompt.js CHANGELOG.md; do
  if G cat-file -e "$TARGET_COMMIT:$f" 2>/dev/null; then G show "$TARGET_COMMIT:$f" > "$T/$f"; fi
done
# 临时目录里的 preset-prompt.js 要 import js-yaml：指回仓库的 node_modules。
[ -d "$REPO/node_modules" ] && ln -s "$REPO/node_modules" "$T/node_modules"
[ -f "$T/scripts/lib/upgrade-notes.mjs" ] && [ -f "$T/scripts/migrate.mjs" ] \
  || die1 "目标版本里没有 scripts/migrate.mjs / scripts/lib/upgrade-notes.mjs，不能用本脚本升级到它"
G diff --name-only "$OLD_COMMIT" "$TARGET_COMMIT" > "$WORK/diff.txt"
node "$T/scripts/lib/upgrade-notes.mjs" plan --changelog "$T/CHANGELOG.md" --from "$FROM_VER" --to "$TO_VER" \
  --diff "$WORK/diff.txt" --out "$WORK/plan.env" || die1 "解析升级须知失败"
PLAN_RESTART=""; PLAN_DEPS=""; PLAN_SETUP_DSH=0; PLAN_SYSTEMD=0
while IFS='=' read -r k v; do
  [[ "$v" =~ ^[a-z0-9,.-]*$ ]] || continue
  case "$k" in
    RESTART) PLAN_RESTART="$v" ;;
    DEPS) PLAN_DEPS="$v" ;;
    SETUP_DSH) PLAN_SETUP_DSH="$v" ;;
    SYSTEMD) PLAN_SYSTEMD="$v" ;;
  esac
done < "$WORK/plan.env"
has() { case ",$1," in *",$2,"*) return 0 ;; esac; return 1; }
diff_has() { grep -qE "$1" "$WORK/diff.txt"; }
if [ "$CHECK" = "1" ]; then
  info "要升级：bash scripts/update.sh$([ -n "$TO" ] && printf ' --to %s' "$TO")"
  HANDLED=1
  exit 0
fi
if [ "$DRY" != "1" ]; then
  ask "继续升级吗？" || { info "已取消，什么都没改"; HANDLED=1; exit 3; }
fi

# ── 第 5 步：备份 ─────────────────────────────────────────────────────────
step 5 "备份 state/ 与 config.json"
BACKUP_DIR="$HOME/qq-bridge-backups"
TS="$(date +%Y%m%d-%H%M%S)"
SAFE_LABEL="$(printf '%s' "$OLD_LABEL" | tr -c 'A-Za-z0-9._-' '_')"
BACKUP_PATH="$BACKUP_DIR/update-$TS-$SAFE_LABEL.tar.gz"
n=1
while [ -e "$BACKUP_PATH" ]; do BACKUP_PATH="$BACKUP_DIR/update-$TS-$SAFE_LABEL-$n.tar.gz"; n=$((n + 1)); done
ITEMS=()
[ -d "$REPO/state" ] && ITEMS+=(state)
[ -f "$REPO/config.json" ] && ITEMS+=(config.json)
EXCLUDES=()
if [ "$WITH_RAG" != "1" ]; then
  # 向量派生库能重建、体积大，缺省不带；rag/eval/（评估用例）与 rag/*.json（设置、密钥位置）必须带。
  EXCLUDES=(--exclude=state/long-memory/rag/chroma --exclude='state/long-memory/rag/rag.sqlite3*' --exclude=state/long-memory/rag/watermarks.json)
fi
if [ "$DRY" = "1" ]; then
  info "将打包到 $BACKUP_PATH（${ITEMS[*]:-（没有 state/ 与 config.json）}$([ "$WITH_RAG" = "1" ] && printf '，带向量库' || printf '，不带向量派生库')）"
else
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  rc=0
  if [ "${#ITEMS[@]}" -gt 0 ]; then
    tar czf "$BACKUP_PATH" -C "$REPO" "${EXCLUDES[@]+"${EXCLUDES[@]}"}" "${ITEMS[@]}" || rc=$?
  else
    tar czf "$BACKUP_PATH" -T /dev/null || rc=$?
  fi
  # GNU tar 退出码 1 = 打包时有文件在变（桥接还在写日志），备份照样可用。
  [ "$rc" -le 1 ] || { rm -f "$BACKUP_PATH"; die1 "备份失败（tar 退出码 $rc），什么都没改"; }
  [ "$rc" -eq 1 ] && warn "打包时有文件在变化（服务还在写），备份仍可用"
  chmod 600 "$BACKUP_PATH"
  BACKUP="$BACKUP_PATH"
  size="$(wc -c < "$BACKUP" | tr -d ' ')"
  if [ "$size" -ge 1048576 ]; then size="$((size / 1048576)) MB"; elif [ "$size" -ge 1024 ]; then size="$((size / 1024)) KB"; else size="$size 字节"; fi
  ok "备份：$BACKUP（$size）；旧提交 $OLD_COMMIT"
  info "备份里有你的聊天存档原文；之后在控制台删除的聊天，在这些旧备份里不会被删除。不需要时可以直接删掉 ~/qq-bridge-backups/ 里的旧文件。"
fi

# ── 第 6 步：派生文件还原 + 首次覆盖层迁移 ────────────────────────────────────
step 6 "检查本地改动（必要时做首次覆盖层迁移）"
# 派生的 preset patch（出厂 + 覆盖层生成的）不算用户改动：第 7 步拉取前还原、第 10 步重新生成。
DERIVED=(plugins/qq-agent-presets/presets/qq-chat.patch.yml plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml)
is_derived() { local f; for f in "${DERIVED[@]}"; do [ "$1" = "$f" ] && return 0; done; return 1; }
# dirty_list：被改 / 未跟踪的文件；第一次升级时取出的、与目标版本相同的 scripts/update.sh 不算。
dirty_list() {
  local e xy p idx tgt wt
  tgt="$(G rev-parse -q --verify "$TARGET_COMMIT:scripts/update.sh" 2>/dev/null || true)"
  while IFS= read -r -d '' e; do
    xy="${e:0:2}"; p="${e:3}"
    if is_derived "$p" && G cat-file -e "HEAD:$p" 2>/dev/null; then continue; fi
    if [ "$p" = "scripts/update.sh" ] && [ "${xy:1:1}" = " " ] && [ -n "$tgt" ]; then
      idx="$(G rev-parse -q --verify ":scripts/update.sh" 2>/dev/null || true)"
      wt="$(G hash-object -- scripts/update.sh 2>/dev/null || true)"
      [ "$idx" = "$tgt" ] && [ "$wt" = "$tgt" ] && continue
    fi
    printf '%s\n' "$p"
  done < <(G status --porcelain=v1 -z --untracked-files=all --no-renames)
}
DIRTY="$(dirty_list)"
if [ -n "$DIRTY" ]; then
  info "有本地改动，先把能挪的挪进 state/ 覆盖层（新版本程序只写覆盖层，出厂文件保持原样）："
  margs=(--first-run --repo "$REPO" --target "$TARGET_COMMIT" --backup-dir "$BACKUP_DIR/first-run-$TS")
  [ "$YES" = "1" ] && margs+=(--yes)
  [ "$DRY" = "1" ] && margs+=(--dry-run)
  [ "$DRY" = "1" ] || CHANGED=1
  mrc=0
  orig node "$T/scripts/migrate.mjs" "${margs[@]}" || mrc=$?
  case "$mrc" in
    0) ;;
    3) info "已取消；备份在 ${BACKUP:-（dry-run 未备份）}，代码没改"; HANDLED=1; exit 3 ;;
    *) die1 "首次迁移没做（见上面的清单）。备份在 ${BACKUP:-（dry-run 未备份）}，代码没改" ;;
  esac
  [ -d "$BACKUP_DIR/first-run-$TS" ] && FIRST_RUN_BACKUP="$BACKUP_DIR/first-run-$TS"
  if [ "$DRY" != "1" ]; then
    left="$(dirty_list)"
    [ -z "$left" ] || die1 "迁移后仍有改动：$(printf '%s' "$left" | tr '\n' ' ')"
  fi
else
  ok "没有本地改动"
fi

# ── 第 7 步：拉取 ─────────────────────────────────────────────────────────
step 7 "拉取（git merge --ff-only $TARGET_LABEL）"
RESTORED_DERIVED=0
for f in "${DERIVED[@]}"; do
  G cat-file -e "HEAD:$f" 2>/dev/null || continue
  if [ -e "$REPO/$f" ] && G diff --quiet HEAD -- "$f" 2>/dev/null; then continue; fi
  if [ "$DRY" = "1" ]; then info "将还原派生文件 $f（拉取后重新生成）"; continue; fi
  CHANGED=1
  orig G checkout HEAD -- "$f" || fail2 "还原派生文件 $f 失败"
  RESTORED_DERIVED=1
  info "已还原派生文件 $f（拉取后重新生成）"
done
if [ "$DRY" = "1" ]; then
  info "将快进到 $TARGET_COMMIT"
else
  CHANGED=1
  orig G merge --ff-only --quiet "$TARGET_COMMIT" || fail2 "git merge --ff-only 失败"
  MERGED=1
  ok "已到 $TARGET_LABEL"
fi

# ── 第 8 步：依赖 ─────────────────────────────────────────────────────────
step 8 "依赖"
NEED_NPM=0; NEED_PY=0
{ has "$PLAN_DEPS" npm || diff_has '^package-lock\.json$'; } && NEED_NPM=1
{ has "$PLAN_DEPS" python || diff_has '^sidecars/memory-rag/(pyproject\.toml|uv\.lock)$'; } && NEED_PY=1
[ "$NEED_NPM$NEED_PY" = "00" ] && ok "依赖没变"
if [ "$NEED_NPM" = "1" ]; then
  if [ "$DRY" = "1" ]; then info "将运行 npm ci"
  else
    npm_bin="$(need_bin npm)" || fail2 "要 npm ci 但找不到 npm"
    (cd "$REPO" && umask "$ORIG_UMASK" && "$npm_bin" ci) || fail2 "npm ci 失败"
    ok "npm ci"
  fi
fi
if [ "$NEED_PY" = "1" ]; then
  uv_bin="$(bin_of uv)"
  if [ -z "$uv_bin" ]; then
    warn "memory-rag 的 Python 依赖变了，但没装 uv：之后请自己在 sidecars/memory-rag 里运行 uv sync"
  elif [ "$DRY" = "1" ]; then info "将在 sidecars/memory-rag 里运行 uv sync"
  else
    (cd "$REPO/sidecars/memory-rag" && umask "$ORIG_UMASK" && "$uv_bin" sync) || fail2 "uv sync 失败"
    ok "uv sync"
  fi
fi

# ── 第 9 步：数据迁移 ─────────────────────────────────────────────────────
step 9 "数据迁移（node scripts/migrate.mjs）"
if [ "$DRY" = "1" ]; then
  node "$T/scripts/migrate.mjs" --repo "$REPO" --dry-run || warn "迁移预演失败"
else
  orig node "$REPO/scripts/migrate.mjs" --repo "$REPO" || fail2 "数据迁移失败"
fi

# ── 第 10 步：派生文件、setup-dsh、systemd 单元 ────────────────────────────────
step 10 "重新生成派生文件 / 补做安装步骤"
UNIT_DIR="$HOME/.config/systemd/user"
unit_installed() { [ -f "$UNIT_DIR/$1" ]; }
has_overrides=0
compgen -G "$REPO/state/preset-overrides/*.prefix.md" >/dev/null 2>&1 && has_overrides=1
if diff_has '^(dsh|plugins)/' || [ "$has_overrides" = "1" ] || [ "$RESTORED_DERIVED" = "1" ]; then
  if [ "$DRY" = "1" ]; then info "将运行 node scripts/build-agent-preset-patches.mjs"
  else
    (cd "$REPO" && umask "$ORIG_UMASK" && node scripts/build-agent-preset-patches.mjs) || fail2 "重新生成 preset patch 失败"
    ok "已重新生成 preset patch"
  fi
fi
if [ "$PLAN_SETUP_DSH" = "1" ] || diff_has '^(dsh|plugins)/'; then
  if [ "$DRY" = "1" ]; then info "将运行 node scripts/setup-dsh.mjs"
  else
    (cd "$REPO" && umask "$ORIG_UMASK" && node scripts/setup-dsh.mjs) || fail2 "setup-dsh.mjs 失败"
    ok "setup-dsh.mjs"
  fi
fi
SD_UNITS=(qq-bridge.service qq-memory-rag.service qq-embedding.service)
if [ "$PLAN_SYSTEMD" = "1" ] || diff_has '^scripts/systemd/'; then
  if unit_installed qq-bridge.service || unit_installed qq-memory-rag.service || unit_installed qq-embedding.service; then
    if [ "$DRY" = "1" ]; then info "将重装 systemd 单元（bash scripts/systemd/install.sh，保持原来的开机自启状态）"
    else
      WAS_ENABLED=()
      for u in "${SD_UNITS[@]}"; do
        WAS_ENABLED+=("$(sdctl is-enabled "$u" 2>/dev/null || true)")
      done
      (cd "$REPO" && umask "$ORIG_UMASK" && bash scripts/systemd/install.sh) || fail2 "重装 systemd 单元失败"
      i=0
      for u in "${SD_UNITS[@]}"; do
        was="${WAS_ENABLED[$i]}"; i=$((i + 1))
        now="$(sdctl is-enabled "$u" 2>/dev/null || true)"
        if [ "$was" = "enabled" ] && [ "$now" != "enabled" ]; then sdctl enable "$u" >/dev/null || warn "没能恢复 $u 的开机自启"
        elif [ "$was" != "enabled" ] && [ "$now" = "enabled" ]; then sdctl disable "$u" >/dev/null || warn "没能恢复 $u 的开机自启状态"
        fi
      done
      ok "已重装 systemd 单元"
    fi
  else
    info "systemd 单元没装，跳过"
  fi
fi

# ── 第 11 步：重启 ────────────────────────────────────────────────────────
step 11 "重启受影响的服务（永远不碰 QQ、SnowLuma）"
rag_enabled() {
  node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(c&&c.memoryRag&&c.memoryRag.enabled===true?0:1)}catch{process.exit(1)}' "$REPO/config.json"
}
RAG_ON=0
rag_enabled && RAG_ON=1
SERVICES=()
for s in memory-rag embedding dsh bridge; do
  has "$PLAN_RESTART" "$s" || continue
  if { [ "$s" = "memory-rag" ] || [ "$s" = "embedding" ]; } && [ "$RAG_ON" != "1" ]; then
    info "$s：向量记忆没开（memoryRag.enabled 不是 true），不重启"
    continue
  fi
  SERVICES+=("$s")
done

# DSH：node … apps/cli/src/bin.ts web 进程，加上它父链上的 pnpm / sh；输出外层在前。
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
wait_gone() {  # wait_gone <pid...>：最多等 20 秒
  local pid i
  for pid in "$@"; do
    for i in $(seq 1 20); do send_signal 0 "$pid" 2>/dev/null || break; sleep 1; done
  done
}
start_all() { (cd "$REPO" && umask "$ORIG_UMASK" && ./start-all.sh "$@"); }
stop_all() { (cd "$REPO" && umask "$ORIG_UMASK" && ./stop-all.sh "$@"); }

# needs_start_all <服务>：这一项是不是要靠 ./start-all.sh（不带 --rag）拉起。
needs_start_all() {
  case "$1" in
    dsh) return 0 ;;
    bridge) ! unit_installed qq-bridge.service ;;
    *) return 1 ;;
  esac
}
describe_restart() {
  case "$1" in
    memory-rag) unit_installed qq-memory-rag.service && echo "systemctl --user restart qq-memory-rag" || echo "./stop-all.sh --rag && ./start-all.sh --rag" ;;
    embedding) unit_installed qq-embedding.service && echo "systemctl --user restart qq-embedding" || echo "./stop-all.sh --rag && ./start-all.sh --rag" ;;
    dsh) echo "按 PID 逐个停 DSH（$(dsh_pids | paste -sd ' ' -)），再 ./start-all.sh" ;;
    bridge) unit_installed qq-bridge.service && echo "systemctl --user restart qq-bridge" || echo "停掉 node src/bridge.js（PID：$(pgrep_f '^node src/bridge.js$' | paste -sd ' ' -)），再 ./start-all.sh" ;;
  esac
}
RAG_SCRIPTED=0
do_restart() {
  case "$1" in
    memory-rag|embedding)
      local unit="qq-$1.service"
      if unit_installed "$unit"; then sdctl restart "$unit"
      elif [ "$RAG_SCRIPTED" = "0" ]; then RAG_SCRIPTED=1; stop_all --rag && start_all --rag
      fi ;;
    dsh)
      local pids
      pids="$(dsh_pids)"
      [ -n "$pids" ] || info "没找到在跑的 DSH，直接起"
      for p in $pids; do send_signal TERM "$p" || true; done
      # shellcheck disable=SC2086
      [ -n "$pids" ] && wait_gone $pids
      start_all ;;
    bridge)
      if unit_installed qq-bridge.service; then sdctl restart qq-bridge.service
      else
        local pids
        pids="$(pgrep_f '^node src/bridge.js$')"
        for p in $pids; do send_signal TERM "$p" || true; done
        # shellcheck disable=SC2086
        [ -n "$pids" ] && wait_gone $pids
        start_all
      fi ;;
  esac
}
if [ "${#SERVICES[@]}" -eq 0 ]; then
  ok "不需要重启"
else
  info "要重启（按顺序）："
  for s in "${SERVICES[@]}"; do
    note=""
    if needs_start_all "$s" && ! host_running; then note="（$(host_missing) 没在运行：会跳过这一项，不停也不起）"; fi
    info "  - $s：$(describe_restart "$s")$note"
  done
  if [ "$DRY" = "1" ]; then
    info "（--dry-run：不重启）"
  elif ask "现在按顺序重启这些服务吗？"; then
    for s in "${SERVICES[@]}"; do
      # 先检查再停：QQ / SnowLuma 不在跑就不动这个服务（保持旧版本在跑），免得 ./start-all.sh 替用户把它们拉起来。
      if needs_start_all "$s" && ! host_running; then
        warn "$(host_missing) 没在运行，为了不替你启动它们，本脚本没有拉起 $s；请先登录 QQ，再运行 ./start-all.sh"
        info "  $s 没停，仍是升级前的版本在跑；QQ 登录好以后请这样重启它：$(describe_restart "$s")"
        SKIPPED="${SKIPPED:+$SKIPPED,}$s"
        continue
      fi
      do_restart "$s" || fail2 "重启 $s 失败"
      RESTARTED="${RESTARTED:+$RESTARTED,}$s"
      ok "已重启 $s"
    done
  else
    info "没有重启。之后请自己按上面的命令（在仓库目录里）依次执行。"
  fi
fi

# ── 第 12 步：健康检查 ────────────────────────────────────────────────────
step 12 "健康检查"
CONSOLE_PORT="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=Number(c.consolePort);process.stdout.write(String(p>0?p:3100))}catch{process.stdout.write("3100")}' "$REPO/config.json")"
if [ "$IS_TEST" = "1" ]; then BRIDGE_BASE="$QQB_HEALTH_BASE"; RAG_BASE="$QQB_HEALTH_BASE"
else BRIDGE_BASE="http://127.0.0.1:$CONSOLE_PORT"; RAG_BASE="http://127.0.0.1:8093"; fi
# 令牌只在 node 里从文件读，不进命令行参数、不打印。
probe() {  # probe <bridge|rag>
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
if [ "$DRY" = "1" ]; then
  info "将检查桥接 /api/status$([ "$RAG_ON" = "1" ] && printf ' 与 memory-rag /health')"
elif [ -z "$RESTARTED" ]; then
  info "这次没有重启服务，跳过（重启后可再跑 bash scripts/update.sh --check 确认版本）"
else
  if has "$SKIPPED" bridge; then
    info "桥接这次跳过了重启，不检查"
  else
    wait_healthy bridge || fail2 "桥接 /api/status 在 ${QQB_HEALTH_WAIT:-60} 秒内没有就绪"
    ok "桥接正常"
  fi
  if [ "$RAG_ON" = "1" ]; then
    wait_healthy rag || fail2 "memory-rag /health 没有就绪（或处于只读模式）"
    ok "memory-rag 正常"
  fi
fi

# ── 第 13 步：记录 ────────────────────────────────────────────────────────
step 13 "记录"
if [ "$DRY" = "1" ]; then
  info "将在 state/upgrade.json 追加一条记录（--dry-run 没写）"
  ok "预演完成，什么都没改"
else
  RESULT=ok
  [ -n "$SKIPPED" ] && RESULT=ok-partial
  record_history "$RESULT"
  # 只有升级成功才清理旧备份（失败时回滚还要用）。
  pruned="$(UJ_REPO="$REPO" UJ_PROTECT="$BACKUP,$FIRST_RUN_BACKUP" node "$WORK/uj.mjs" prune "$BACKUP_DIR" 2>/dev/null || echo "?")"
  case "$pruned" in
    0) ;;
    "?") warn "清理旧备份失败（不影响升级）" ;;
    *) info "已清理 $pruned 份旧备份（升级备份、回滚前备份、首次迁移备份各只留最新 3 份）" ;;
  esac
  if [ "$RESULT" = "ok-partial" ]; then
    ok "升级完成（部分）：$OLD_LABEL → $TARGET_LABEL；没重启的：${SKIPPED//,/、}；备份 $BACKUP"
  else
    ok "升级完成：$OLD_LABEL → $TARGET_LABEL；备份 $BACKUP"
  fi
  info "出问题可回滚：bash scripts/rollback.sh $BACKUP"
fi
HANDLED=1
exit 0
