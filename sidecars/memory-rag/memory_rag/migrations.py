"""UPGRADE_PATCH：rag.sqlite3 的数据版本（`PRAGMA user_version`）与按序迁移。

接口约定 docs/design/worker-kit/upgrade/contract.md §2.1：
- 版本号 < LATEST：先用 sqlite 备份接口复制一份 `rag.sqlite3.bak-v<旧>`（同目录、600），再按序迁移，
  每一步在自己的事务里，成功后才写 user_version——中途失败停在上一个版本，下次启动接着迁。
- 版本号 > LATEST（用户回滚了代码，库是新版本写的）：只读。读接口照常，所有写路径拒绝，
  库文件一个字节都不动，免得老代码把新结构写坏。

迁移只在服务进程里、打开库的时候做（`ChunkDB.__init__`）；不碰 Chroma（向量库能重建，结构大改时走 /rebuild）。
每一步必须可重复执行：`CREATE … IF NOT EXISTS`、先查列再 `ALTER`。

迁移备份不长期留（隐私，`CLAUDE.md` 坑 17）：`chunks` 表存着聊天原文，用户在控制台删存档时主库会被擦干净
（secure_delete、整理 FTS、截断 WAL），但 `rag.sqlite3.bak-v*` 是迁移那一刻的整库副本，删掉的聊天还在里面。所以：
- 服务每次真正执行删除（`/forget`、消费到遗忘请求）成功之后，同目录下所有 `rag.sqlite3.bak-v*`（含带时间后缀的）一律删掉；
- 服务启动时（库已是 LATEST、不是只读）删掉 mtime 超过 7 天的；
- 只读模式两条都不做：那时备份正是用户还原要用的；
- 清理失败只告警（不带路径），不影响删除本身和启动。
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Callable


log = logging.getLogger("memory_rag.migrations")

BACKUP_MAX_AGE_S = 7 * 86400  # 启动时清掉超过 7 天的迁移备份


class SchemaTooNew(RuntimeError):
    """库的版本比程序新：只读模式下的写操作抛这个，HTTP 层翻成 409。"""


def _v1_stamp(conn: sqlite3.Connection) -> None:
    """v0 → v1：只盖版本号。表结构由 fts / l2 现有的 `CREATE … IF NOT EXISTS` 保证，这里不动任何表。"""


LATEST = 1
MIGRATIONS: dict[int, Callable[[sqlite3.Connection], None]] = {1: _v1_stamp}


def user_version(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def readonly_message(db_version: int) -> str:
    return (f"向量记忆数据库是 v{db_version}，比当前程序支持的 v{LATEST} 新（多半是回滚过代码），"
            "现在是只读模式、拒绝写入。请先还原升级前的备份，或升级回新版本")


def _backup_path(db_path: Path, old: int) -> Path:
    base = db_path.with_name(f"{db_path.name}.bak-v{old}")
    if not base.exists():
        return base
    stamp = time.strftime("%Y%m%d-%H%M%S")
    cand = base.with_name(f"{base.name}-{stamp}")
    n = 2
    while cand.exists():  # 同一秒里第二次（测试里会发生）
        cand = base.with_name(f"{base.name}-{stamp}-{n}")
        n += 1
    return cand


def backup(conn: sqlite3.Connection, db_path: Path, old: int) -> Path:
    """用 sqlite 备份接口整库复制（含 WAL 里还没写回的页），文件先以 600 建好再写，不经过宽权限的窗口。"""
    dst = _backup_path(Path(db_path), old)
    fd = os.open(str(dst), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    try:
        out = sqlite3.connect(str(dst))
        try:
            conn.backup(out)
        finally:
            out.close()
        os.chmod(dst, 0o600)
    except BaseException:
        try:
            dst.unlink()
        except OSError:
            pass
        raise
    return dst


def migrate(conn: sqlite3.Connection, db_path: Path, has_data: bool) -> dict:
    """把库迁到 LATEST。返回 {"from", "to", "backup"}；调用方已经确认版本号 ≤ LATEST。

    has_data=False（新建的空库）不备份：没有东西可丢，备份只会留下一个空文件。
    """
    old = user_version(conn)
    out = {"from": old, "to": old, "backup": None}
    if old >= LATEST:
        return out
    conn.commit()  # 备份和迁移都要求没有未提交的事务
    if has_data:
        out["backup"] = str(backup(conn, db_path, old))
    for v in range(old + 1, LATEST + 1):
        conn.execute("BEGIN")
        try:
            MIGRATIONS[v](conn)
            conn.execute(f"PRAGMA user_version = {int(v)}")  # 写在同一个事务里：失败一起回滚
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        out["to"] = v
    return out


def backup_files(db_path: Path) -> list[Path]:
    """同目录下这个库的全部迁移备份（`<库名>.bak-v*`，含带时间后缀的）。"""
    db_path = Path(db_path)
    try:
        return sorted(db_path.parent.glob(f"{db_path.name}.bak-v*"))
    except OSError:
        return []


def remove_backups(db_path: Path, older_than_s: float | None = None, now: float | None = None) -> int:
    """删迁移备份；older_than_s 给了就只删 mtime 比它旧的。返回删掉的份数，单个失败只告警、接着删别的。"""
    now = time.time() if now is None else now
    removed = failed = 0
    for p in backup_files(db_path):
        try:
            if older_than_s is not None and now - p.stat().st_mtime <= older_than_s:
                continue
            p.unlink()
            removed += 1
        except OSError as e:
            failed += 1
            log.warning("迁移备份删除失败（%s）", type(e).__name__)
    if removed:
        log.info("已删除 %d 份迁移备份", removed)
    if failed:
        log.warning("有 %d 份迁移备份没删掉", failed)
    return removed
