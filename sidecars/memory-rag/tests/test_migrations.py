"""UPGRADE_PATCH：rag.sqlite3 的数据版本与迁移（接口约定 §2.1）。

- v0 老库打开后变成 v1，表结构与每一行数据都不变；迁移前有可用的备份（600、能打开、数据完整）。
- 版本比程序新：读接口照常，所有写路径 409，库文件 sha256 不变。
全部用 tmp_path，假 embedding，不连 8091 / 8093。
"""

from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import stat
import tempfile
import time
from pathlib import Path

_ORIG_STATE_DIR = os.environ.get("MEMORY_RAG_STATE_DIR")
_IMPORT_STATE = tempfile.mkdtemp(prefix="memory-rag-mig-")
os.environ["MEMORY_RAG_STATE_DIR"] = _IMPORT_STATE  # app.py import 时就建 Service，绝不能碰真实 state/

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from memory_rag import app as app_module  # noqa: E402
from memory_rag import migrations  # noqa: E402
from memory_rag.fts import _SCHEMA as FTS_SCHEMA, ChunkDB  # noqa: E402
from memory_rag.l2 import _SCHEMA as L2_SCHEMA  # noqa: E402
from memory_rag.migrations import LATEST, SchemaTooNew  # noqa: E402
from memory_rag.service import Service  # noqa: E402

if _ORIG_STATE_DIR is None:
    os.environ.pop("MEMORY_RAG_STATE_DIR", None)
else:
    os.environ["MEMORY_RAG_STATE_DIR"] = _ORIG_STATE_DIR

from conftest import FAR_FUTURE, ROOT, FakeEmbedder, close_rag, write_archive, write_forget_request  # noqa: E402

PRIVATE = "private:111"
GROUP = "group:222"
ROWS = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
    (60, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (61, "in", "111", "平安", "独角兽蛋糕的配色也想好了"),
    (62, "out", None, "", "这版动画脚本结构清楚多了"),
]
GROUP_ROWS = [
    (0, "in", "333", "老周", "明天开会吗"),
    (1, "in", "444", "糖糖", "项目要延期了"),
    (2, "out", None, "", "那就先别加班"),
]


def _chunk(i: int, key: str = PRIVATE) -> dict:
    return {"chunk_id": f"c{i}", "key": key, "t_start": 1000 + i, "t_end": 2000 + i, "day": "2026-10-01",
            "speakers": "111", "speaker_names": "平安", "title": f"标题{i}", "cut_reason": "gap",
            "file_start": "2026-10.jsonl", "line_start": i, "file_end": "2026-10.jsonl", "line_end": i + 1,
            "n_msgs": 2, "distilled": "pending", "text": f"第{i}块：火锅和独角兽蛋糕", "indexed_at": 5}


def make_v0(path: Path) -> None:
    """造一个改动前的库：同样的建表语句、WAL、user_version 0，写几行块与元数据。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(FTS_SCHEMA)
    conn.executescript(L2_SCHEMA)
    for i in range(3):
        c = _chunk(i)
        conn.execute(f"INSERT INTO chunks ({','.join(c)}) VALUES ({','.join('?' for _ in c)})", list(c.values()))
        conn.execute("INSERT INTO chunks_fts(tokens, chunk_id) VALUES (?,?)", (f"火锅 蛋糕 t{i}", c["chunk_id"]))
    conn.execute("INSERT INTO meta(key, value) VALUES ('k', 'v')")
    conn.commit()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    conn.close()


def dump(path: Path) -> dict:
    """表结构 + 每张普通表的全部行（有 WITHOUT ROWID 表，所以取出来按内容排序），逐表比较用。"""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        master = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").fetchall()
        tables = [r[1] for r in master if r[0] == "table" and r[3] and not r[3].upper().startswith("CREATE VIRTUAL")]
        rows = {t: sorted(conn.execute(f'SELECT * FROM "{t}"').fetchall(), key=repr) for t in tables}
        fts = conn.execute("SELECT tokens, chunk_id FROM chunks_fts ORDER BY rowid").fetchall()
        return {"master": master, "rows": rows, "fts": fts}
    finally:
        conn.close()


def version_of(path: Path) -> int:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def baks(path: Path) -> list[Path]:
    return sorted(path.parent.glob(path.name + ".bak-v*"))


# ---------------------------------------------------------------- 迁移


def test_latest_and_registry():
    assert LATEST == 1
    assert sorted(migrations.MIGRATIONS) == list(range(1, LATEST + 1))


def test_v0_upgrades_to_v1_without_changing_data(tmp_path: Path):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    make_v0(db_path)
    before = dump(db_path)
    db = ChunkDB(db_path)
    try:
        assert db.schema == {"db": 1, "code": LATEST, "readonly": False}
        assert db.migration["from"] == 0 and db.migration["to"] == 1
        assert db.readonly is False
    finally:
        db.conn.close()
    assert version_of(db_path) == 1
    assert dump(db_path) == before  # 表结构与每一行都不变


def test_backup_is_complete_and_private(tmp_path: Path):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    make_v0(db_path)
    before = dump(db_path)
    db = ChunkDB(db_path)
    db.conn.close()
    [bak] = baks(db_path)
    assert bak.name == "rag.sqlite3.bak-v0"
    assert db.migration["backup"] == str(bak)
    assert stat.S_IMODE(bak.stat().st_mode) == 0o600
    assert version_of(bak) == 0
    assert dump(bak) == before
    conn = sqlite3.connect(str(bak))
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    conn.close()


def test_second_open_does_not_backup_again(tmp_path: Path):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    make_v0(db_path)
    ChunkDB(db_path).conn.close()
    db = ChunkDB(db_path)
    db.conn.close()
    assert db.migration is None
    assert len(baks(db_path)) == 1


def test_backup_name_conflict_gets_time_suffix(tmp_path: Path):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    make_v0(db_path)
    old = db_path.with_name("rag.sqlite3.bak-v0")
    old.write_bytes(b"older backup")
    ChunkDB(db_path).conn.close()
    found = baks(db_path)
    assert len(found) == 2
    assert old.read_bytes() == b"older backup"  # 旧备份不被覆盖
    new = [p for p in found if p != old][0]
    assert new.name.startswith("rag.sqlite3.bak-v0-")
    assert stat.S_IMODE(new.stat().st_mode) == 0o600
    assert version_of(new) == 0


def test_backup_name_conflict_same_second(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    make_v0(db_path)
    monkeypatch.setattr(migrations.time, "strftime", lambda fmt: "20261102-120000")
    db_path.with_name("rag.sqlite3.bak-v0").write_bytes(b"a")
    db_path.with_name("rag.sqlite3.bak-v0-20261102-120000").write_bytes(b"b")
    ChunkDB(db_path).conn.close()
    assert db_path.with_name("rag.sqlite3.bak-v0-20261102-120000-2").exists()


def test_fresh_db_stamped_without_backup(tmp_path: Path):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    db = ChunkDB(db_path)
    db.conn.close()
    assert db.schema["db"] == LATEST
    assert baks(db_path) == []
    assert version_of(db_path) == LATEST


def test_migration_steps_repeatable(tmp_path: Path):
    db_path = tmp_path / "x.sqlite3"
    conn = sqlite3.connect(str(db_path))
    for _ in range(2):
        migrations._v1_stamp(conn)
    conn.close()


def test_failed_step_rolls_back_and_stays_on_previous_version(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    make_v0(db_path)
    ChunkDB(db_path).conn.close()  # 先到 v1
    before = dump(db_path)

    def boom(conn):
        conn.execute("CREATE TABLE half_done (x)")
        raise RuntimeError("迁移失败")

    monkeypatch.setattr(migrations, "LATEST", 2)
    monkeypatch.setitem(migrations.MIGRATIONS, 2, boom)
    with pytest.raises(RuntimeError):
        ChunkDB(db_path)
    assert version_of(db_path) == 1
    assert dump(db_path) == before  # half_done 随事务回滚
    assert [p.name for p in baks(db_path)] == ["rag.sqlite3.bak-v0", "rag.sqlite3.bak-v1"]


# ---------------------------------------------------------------- 版本比程序新：只读


def _bump(db_path: Path, v: int) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.execute(f"PRAGMA user_version = {v}")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()


def test_chunkdb_readonly_rejects_writes(tmp_path: Path):
    db_path = tmp_path / "rag" / "rag.sqlite3"
    make_v0(db_path)
    ChunkDB(db_path).conn.close()
    _bump(db_path, LATEST + 1)
    h = sha(db_path)
    db = ChunkDB(db_path)
    try:
        assert db.readonly is True
        assert db.schema == {"db": LATEST + 1, "code": LATEST, "readonly": True}
        assert db.stats()["chunks"] == 3
        assert set(db.get(["c0", "c1"])) == {"c0", "c1"}
        for call in (lambda: db.upsert([_chunk(9)], 1), lambda: db.set_meta("a", "b"),
                     lambda: db.delete_key(PRIVATE), lambda: db.clear()):
            with pytest.raises(SchemaTooNew):
                call()
        # 兜底：绕过拦截直接写，SQLite 自己也拒绝
        with pytest.raises(sqlite3.OperationalError):
            db.conn.execute("INSERT INTO meta(key, value) VALUES ('x', 'y')")
    finally:
        db.conn.close()
    assert sha(db_path) == h
    assert len(baks(db_path)) == 1  # 只读不备份


@pytest.fixture
def ro_service(monkeypatch, state: Path):
    """先用正常 Service 建好两个会话的索引，再把库版本调高，重新打开成只读。"""
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    write_archive(state, PRIVATE, ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    assert svc.health()["schema"] == {"db": LATEST, "code": LATEST, "readonly": False, "backups": 0}
    assert svc.indexer.run(now_ms=FAR_FUTURE)["chunks"] >= 2
    close_rag(svc)
    db_path = state / "long-memory" / "rag" / "rag.sqlite3"
    _bump(db_path, LATEST + 1)
    ro = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    yield ro, db_path
    close_rag(ro)


def test_readonly_http(monkeypatch, ro_service):
    svc, db_path = ro_service
    h = sha(db_path)
    assert svc.readonly is True
    monkeypatch.setattr(app_module, "svc", svc)
    client = TestClient(app_module.app)

    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["schema"] == {"db": LATEST + 1, "code": LATEST, "readonly": True, "backups": 0}

    r = client.post("/search", json={"key": PRIVATE, "query": "火锅"})
    assert r.status_code == 200 and r.json()["items"]
    for path, body in (("/recall", {"key": PRIVATE, "texts": ["火锅"]}),
                       ("/associate", {"key": PRIVATE, "text": "火锅"}),
                       ("/summaries", {"key": PRIVATE, "ids": []}),
                       ("/notes", {"key": PRIVATE})):
        assert client.post(path, json=body).status_code == 200, path

    for path, body in (("/index/run", {}), ("/forget", {"key": PRIVATE}), ("/rebuild", {}),
                       ("/notes/backfill", {"hours": 72}), ("/distill/retry", {})):
        r = client.post(path, json=body)
        assert r.status_code == 409, path
        assert "只读" in r.json()["detail"] and f"v{LATEST + 1}" in r.json()["detail"], path

    assert svc.job is None  # /rebuild 没起后台任务
    assert sha(db_path) == h
    assert client.post("/search", json={"key": PRIVATE, "query": "火锅"}).json()["items"]


def test_readonly_service_methods(ro_service):
    svc, db_path = ro_service
    h = sha(db_path)
    for call in (svc.rebuild, svc.start_rebuild, lambda: svc.forget(PRIVATE)):
        with pytest.raises(SchemaTooNew):
            call()
    assert sha(db_path) == h


def test_readonly_pending_forget_blocks_that_key_only(monkeypatch, state: Path, ro_service):
    svc, db_path = ro_service
    h = sha(db_path)
    req = write_forget_request(state, PRIVATE, 123)
    monkeypatch.setattr(app_module, "svc", svc)
    client = TestClient(app_module.app)
    # 有待删请求的会话：消费不了 → 503（桥接降级），不能把要删的内容返回出去
    assert client.post("/search", json={"key": PRIVATE, "query": "火锅"}).status_code == 503
    assert client.post("/notes", json={"key": PRIVATE}).status_code == 503
    # 别的会话照常
    assert client.post("/search", json={"key": GROUP, "query": "加班"}).status_code == 200
    assert req.exists()  # 请求文件留着，升级回去后再消费
    assert sha(db_path) == h


def test_normal_health_has_schema(monkeypatch, state: Path):
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    try:
        h = svc.health()
        assert h["schema"] == {"db": LATEST, "code": LATEST, "readonly": False, "backups": 0}
        assert svc.readonly is False
    finally:
        close_rag(svc)


# ---------------------------------------------------------------- 迁移备份的清理（隐私：备份里有删除前的原文）

DAY = 86400


def _age(p: Path, days: float) -> None:
    t = time.time() - days * DAY
    os.utime(p, (t, t))


def _fake_backup(db_path: Path, name: str, days: float = 0) -> Path:
    p = db_path.with_name(name)
    p.write_bytes(b"old copy with raw chat")
    p.chmod(0o600)
    if days:
        _age(p, days)
    return p


@pytest.fixture
def migrated(monkeypatch, state: Path):
    """v0 老库（含真实索引）→ 打开 Service 迁到 v1，留下一份 .bak-v0。"""
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    write_archive(state, PRIVATE, ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    assert svc.indexer.run(now_ms=FAR_FUTURE)["chunks"] >= 2
    close_rag(svc)
    db_path = state / "long-memory" / "rag" / "rag.sqlite3"
    _bump(db_path, 0)  # 退回 v0，模拟改动前的老库
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    assert [p.name for p in baks(db_path)] == ["rag.sqlite3.bak-v0"]
    yield svc, db_path
    close_rag(svc)


def test_forget_http_removes_all_backups(monkeypatch, migrated):
    svc, db_path = migrated
    _fake_backup(db_path, "rag.sqlite3.bak-v0-20261101-101010")
    _fake_backup(db_path, "rag.sqlite3.bak-v0-20261101-101010-2")
    other = _fake_backup(db_path, "people.json.bak-v0")  # 不是这个库的备份，不碰
    assert svc.health()["schema"]["backups"] == 3
    # 删除返回值形状不变：只有原来的三个键，不多出清理信息
    monkeypatch.setattr(app_module, "svc", svc)
    client = TestClient(app_module.app)
    r = client.post("/forget", json={"key": PRIVATE})
    assert r.status_code == 200
    assert set(r.json()) == {"ok", "key", "removed_chunks"}
    assert r.json()["ok"] is True and r.json()["key"] == PRIVATE and r.json()["removed_chunks"] >= 1
    assert baks(db_path) == []
    assert other.exists()
    assert client.get("/health").json()["schema"]["backups"] == 0


def test_forget_requests_consumed_remove_backups(state: Path, migrated):
    svc, db_path = migrated
    write_forget_request(state, GROUP, 42)
    assert svc.process_forget_requests() == [GROUP]
    assert baks(db_path) == []


def test_no_forget_request_keeps_backups(migrated):
    svc, db_path = migrated
    assert svc.process_forget_requests() == []  # 没删东西 → 不清
    assert len(baks(db_path)) == 1


def test_startup_prunes_backups_older_than_7_days(monkeypatch, state: Path):
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    db_path = state / "long-memory" / "rag" / "rag.sqlite3"
    close_rag(Service(str(ROOT / "config.yml"), embedder=FakeEmbedder()))  # 先有 v1 库
    old = _fake_backup(db_path, "rag.sqlite3.bak-v0", days=8)
    old2 = _fake_backup(db_path, "rag.sqlite3.bak-v0-20261020-080000", days=30)
    young = _fake_backup(db_path, "rag.sqlite3.bak-v0-20261028-080000", days=6)
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    try:
        assert not old.exists() and not old2.exists()
        assert young.exists()
        assert svc.health()["schema"]["backups"] == 1
    finally:
        close_rag(svc)


def test_fresh_migration_backup_survives_startup_prune(migrated):
    _, db_path = migrated
    assert len(baks(db_path)) == 1  # 刚做的备份 mtime 是现在，启动清理不删它


def test_readonly_keeps_backups(monkeypatch, state: Path, ro_service):
    svc, db_path = ro_service
    close_rag(svc)
    b1 = _fake_backup(db_path, "rag.sqlite3.bak-v0", days=30)
    b2 = _fake_backup(db_path, "rag.sqlite3.bak-v0-20261001-000000", days=30)
    h = sha(db_path)
    ro = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())  # 启动：只读，不清过期备份
    try:
        assert ro.readonly is True
        assert b1.exists() and b2.exists()
        assert ro.health()["schema"]["backups"] == 2
        write_forget_request(state, PRIVATE, 7)
        monkeypatch.setattr(app_module, "svc", ro)
        client = TestClient(app_module.app)
        assert client.post("/forget", json={"key": PRIVATE}).status_code == 409
        assert client.post("/search", json={"key": PRIVATE, "query": "火锅"}).status_code == 503
        assert b1.exists() and b2.exists()
    finally:
        close_rag(ro)
    assert sha(db_path) == h


def test_cleanup_failure_only_warns(monkeypatch, migrated, caplog):
    svc, db_path = migrated
    stuck = db_path.with_name("rag.sqlite3.bak-v0-20261102-000000")
    stuck.mkdir()  # 目录：unlink 会失败
    (stuck / "x").write_text("x")
    with caplog.at_level(logging.WARNING, logger="memory_rag.migrations"):
        out = svc.forget(PRIVATE)
    assert out["ok"] is True and out["key"] == PRIVATE and out["removed_chunks"] >= 1
    assert not db_path.with_name("rag.sqlite3.bak-v0").exists()  # 能删的照删
    assert stuck.exists()
    msgs = [r.getMessage() for r in caplog.records if r.name == "memory_rag.migrations"]
    assert msgs and all(str(db_path.parent) not in m for m in msgs)
    assert svc.health()["schema"]["backups"] == 1


def test_cleanup_unexpected_error_does_not_break_forget_or_startup(monkeypatch, migrated, state: Path):
    svc, db_path = migrated
    import memory_rag.service as service_mod

    def boom(*a, **k):
        raise RuntimeError("cleanup exploded")

    monkeypatch.setattr(service_mod, "remove_backups", boom)
    out = svc.forget(PRIVATE)
    assert out["ok"] is True and out["removed_chunks"] >= 1
    assert len(baks(db_path)) == 1
    svc2 = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())  # 启动时清理抛错也照常起
    try:
        assert svc2.health()["schema"]["readonly"] is False
    finally:
        close_rag(svc2)


def test_remove_backups_logs_count_only(tmp_path: Path, caplog):
    db_path = tmp_path / "rag.sqlite3"
    for n in ("rag.sqlite3.bak-v0", "rag.sqlite3.bak-v0-20261101-000000"):
        _fake_backup(db_path, n)
    with caplog.at_level(logging.INFO, logger="memory_rag.migrations"):
        assert migrations.remove_backups(db_path) == 2
    msgs = [r.getMessage() for r in caplog.records if r.name == "memory_rag.migrations"]
    assert msgs == ["已删除 2 份迁移备份"]
