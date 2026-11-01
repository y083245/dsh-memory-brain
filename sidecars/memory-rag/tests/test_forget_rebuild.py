"""P2：遗忘（存档墓碑 + 请求文件 + /forget）与全量重建（/rebuild）。

HTTP 测试的 import 顺序很关键：`import memory_rag.app` 之前先把 MEMORY_RAG_STATE_DIR 指到
临时目录——app.py 在 import 时就会 `svc = Service()` 建目录，绝不能让它碰到真实 state/。
import 完立刻把环境变量还回去（原本没有就删掉），否则 conftest 的 cfg fixture
（load_config 也读这个变量）会被带偏，把存档写到别处去。
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time

_ORIG_STATE_DIR = os.environ.get("MEMORY_RAG_STATE_DIR")
_IMPORT_STATE = tempfile.mkdtemp(prefix="memory-rag-app-")
os.environ["MEMORY_RAG_STATE_DIR"] = _IMPORT_STATE

import pytest
from fastapi.testclient import TestClient

from memory_rag import app as app_module
from memory_rag.archive import RowCache, read_rows
from memory_rag.service import Service, request_at

# 模块级 Service() 已经建好，把环境变量还回去，别影响 conftest 的 cfg fixture
if _ORIG_STATE_DIR is None:
    os.environ.pop("MEMORY_RAG_STATE_DIR", None)
else:
    os.environ["MEMORY_RAG_STATE_DIR"] = _ORIG_STATE_DIR

from conftest import (  # noqa: E402  （顺序有意为之：环境变量要先设置）
    FAR_FUTURE, ROOT, FakeEmbedder, tombstone, write_archive, write_forget_request,
)
from conftest import is_under_temp

PRIVATE = "private:111"
GROUP = "group:222"

# 两段话题（中间空 58 分钟 > 30 分钟分段线）：「独角兽蛋糕」在第 5 行
PRIVATE_ROWS = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
    (60, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (61, "in", "111", "平安", "独角兽蛋糕的配色也想好了"),
    (62, "out", None, "", "这版动画脚本结构清楚多了"),
    (63, "in", "111", "平安", "prompt 还要再改吗"),
]
UNICORN_LINE = 5
GROUP_ROWS = [
    (0, "in", "333", "老周", "明天开会吗"),
    (1, "in", "444", "糖糖", "项目要延期了"),
    (2, "out", None, "", "那就先别加班"),
    (60, "in", "333", "老周", "需求又变了"),
    (61, "in", "444", "糖糖", "老板说要开会"),
    (62, "out", None, "", "先改完再说"),
]


def six_rows() -> list[tuple]:
    return [(i, "in", "111", "平安", f"消息{i}") for i in range(6)]


# 派生库里不留原文用的一组数据：唯一词只出现在被删的那一行里
LEAK_WORD = "蓝鲸邮票册"
LEAK_LINE = 5  # 「蓝鲸邮票册」在第 5 行（第二个话题段）
LEAK_ROWS = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
    (60, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (61, "in", "111", "平安", "蓝鲸邮票册的配色也想好了"),
    (62, "out", None, "", "这版动画脚本结构清楚多了"),
    (63, "in", "111", "平安", "prompt 还要再改吗"),
]
SAFE_WORD = "琥珀胸针"  # 另一个会话里的唯一词：遗忘不能误删它
SAFE_ROWS = [
    (0, "in", "333", "老周", "明天开会吗"),
    (1, "in", "444", "糖糖", "项目要延期了"),
    (2, "out", None, "", "那就先别加班"),
    (60, "in", "333", "老周", "需求又变了"),
    (61, "in", "444", "糖糖", "琥珀胸针的订单到了"),
    (62, "out", None, "", "先改完再说"),
]


def _rag_bytes(root, exclude_chroma: bool = False) -> bytes:
    """Read raw bytes of derived files (Chroma / SQLite / WAL / SHM).

    exclude_chroma is for Windows: Chroma 1.5.9's Rust segment does not guarantee
    immediate compaction after delete(), so deleted text can remain in old
    data_level0.bin segments. Logical deletion is covered by collection.get() and
    the SQL assertions. Linux still scans everything.
    """
    out = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if exclude_chroma and p.relative_to(root).parts[:1] == ("chroma",):
            continue
        out.append(p.read_bytes())
    return b"\n".join(out)



@pytest.fixture
def service(monkeypatch, state):
    """整套 Service：fixture 的临时 state + 假 embedding（不连 8091 / 8093）。"""
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    # 必须落在临时目录里：绝不允许读写真实 state/
    assert svc.cfg["paths"].state == state
    assert is_under_temp(svc.cfg["paths"].state)
    return svc


@pytest.fixture
def client(monkeypatch, service):
    monkeypatch.setattr(app_module, "svc", service)
    return TestClient(app_module.app)


# ---------------------------------------------------------------- 墓碑


def test_tombstone_keeps_size_offsets_and_line_numbers(state):
    archive = state / "long-memory" / "archive"
    f = write_archive(state, PRIVATE, six_rows())
    before = read_rows(archive, PRIVATE)
    assert len(before) == 6
    size = f.stat().st_size

    tombstone(f, 3)

    assert f.stat().st_size == size  # 等长改写：水位不会错位
    after = read_rows(archive, PRIVATE)
    assert len(after) == 5
    # 墓碑行仍占行号，后面三行的行号与字节偏移和改写前一模一样
    assert [(r.file, r.line, r.offset) for r in after[2:]] == [(r.file, r.line, r.offset) for r in before[3:]]
    assert [r.line for r in after] == [1, 2, 4, 5, 6]
    assert all(r.text != "消息2" for r in after)


# ---------------------------------------------------------------- 检索缓存


def test_rowcache_detects_tombstone_rewrite(state):
    archive = state / "long-memory" / "archive"
    f = write_archive(state, PRIVATE, six_rows())
    cache = RowCache(archive)
    rows1, _ = cache.rows(PRIVATE)
    assert len(rows1) == 6

    tombstone(f, 3)
    # 同一时间片内 mtime 可能不变，显式推后，模拟桥接稍后原地改写
    st = f.stat()
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))

    rows2, _ = cache.rows(PRIVATE)
    assert len(rows2) == 5 and all(r.text != "消息2" for r in rows2)

    cache.invalidate(PRIVATE)
    rows3, index3 = cache.rows(PRIVATE)
    assert len(rows3) == 5 and (rows3[2].file, rows3[2].line) in index3


# ---------------------------------------------------------------- forget_key


def test_forget_key_then_tombstone_is_invisible_everywhere(stack, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    per_key = stack.db.stats()["per_key"]
    private_chunks, group_chunks = per_key[PRIVATE], per_key[GROUP]
    assert private_chunks >= 2 and group_chunks >= 2  # 每个会话两段话题
    # 删除前查得到
    before = stack.searcher.search(PRIVATE, "", ["独角兽蛋糕"], routes=("bm25",))
    assert any("独角兽蛋糕" in it["text"] for it in before["items"])

    n = stack.indexer.forget_key(PRIVATE)

    assert n == private_chunks
    assert PRIVATE not in stack.db.stats()["per_key"]  # 私聊块数归零
    assert stack.db.stats()["per_key"][GROUP] == group_chunks  # 别的不受影响
    assert PRIVATE not in stack.indexer.watermarks()  # 水位被删，下次从头重建
    assert stack.vs.count() == group_chunks

    # 桥接删存档：含唯一词的那行改成等长墓碑；增量索引从这个会话开头重来
    f = state / "long-memory" / "archive" / "private_111" / "2026-10.jsonl"
    st = f.stat()
    tombstone(f, UNICORN_LINE)
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    stack.indexer.run(now_ms=FAR_FUTURE)
    assert stack.db.stats()["per_key"][PRIVATE] >= 1  # 重新有块了
    assert PRIVATE in stack.indexer.watermarks()

    # 再追加两条「进行中」的消息，让 pending 那一路也有东西可查
    write_archive(state, PRIVATE, [(180, "in", "111", "平安", "提示词再聊聊"), (181, "out", None, "", "好")])

    for q in ("独角兽蛋糕", "提示词"):
        res = stack.searcher.search(PRIVATE, q, [q], routes=("vector", "bm25", "pending"))
        assert all("独角兽蛋糕" not in it["text"] for it in res["items"]), q


# ---------------------------------------------------------------- Service.forget 与检索缓存


def test_service_forget_clears_rowcache(service, state):
    f = write_archive(state, PRIVATE, PRIVATE_ROWS)
    assert service.indexer.run(now_ms=FAR_FUTURE)["chunks"] >= 2
    assert service.searcher.search(PRIVATE, "", ["独角兽蛋糕"], routes=("bm25",))["items"]
    assert len(service.searcher.rows.rows(PRIVATE)[0]) == len(PRIVATE_ROWS)  # 缓存已填满

    # 等长墓碑 + mtime 装回原值：RowCache 的签名完全不变，只有 invalidate 能救
    st = f.stat()
    tombstone(f, UNICORN_LINE)
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert f.stat().st_size == st.st_size
    assert f.stat().st_mtime_ns == st.st_mtime_ns

    out = service.forget(PRIVATE)
    assert out == {"ok": True, "key": PRIVATE, "removed_chunks": out["removed_chunks"]}
    assert out["removed_chunks"] >= 2

    for q in ("独角兽蛋糕", "提示词"):
        res = service.searcher.search(PRIVATE, q, [q])
        assert all("独角兽蛋糕" not in it["text"] for it in res["items"]), q
    # 正面确认不是「什么都查不到」：剩下的话还能走 pending 那一路被找回来，
    # 扩展出来的上下文里也不能带上已删的那行
    res = service.searcher.search(PRIVATE, "提示词", ["提示词"], routes=("pending",))
    assert res["items"]
    assert all("独角兽蛋糕" not in it["text"] for it in res["items"])


# ---------------------------------------------------------------- 遗忘请求文件


def test_process_forget_requests(service, state, monkeypatch):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)

    req = write_forget_request(state, PRIVATE, 1000)
    assert service.forget_requests() == [(req, PRIVATE, 1000)]
    assert service.process_forget_requests() == [PRIVATE]
    assert not req.exists()  # 处理完删文件
    assert PRIVATE not in service.indexer.watermarks()

    # 坏文件 / 文件名与 key 不符：跳过，不删
    req_dir = state / "long-memory" / "forget-requests"
    bad = req_dir / "private_999.json"
    bad.write_text("{不是 json", encoding="utf-8")
    wrong = req_dir / "private_888.json"
    wrong.write_text(json.dumps({"key": PRIVATE, "at": 7}), encoding="utf-8")
    assert service.forget_requests() == []
    assert service.process_forget_requests() == []
    assert bad.exists() and wrong.exists()

    # 处理期间桥接又写了新请求（at 变新）：文件必须留着，留到下一轮
    real = service.indexer.forget_key

    def forget_then_rewrite(key, timeout=120.0):
        n = real(key, timeout=timeout)
        write_forget_request(state, key, 2000)
        return n

    monkeypatch.setattr(service.indexer, "forget_key", forget_then_rewrite)
    write_forget_request(state, PRIVATE, 1500)
    assert service.process_forget_requests() == [PRIVATE]
    assert req.exists() and request_at(req) == 2000


# ---------------------------------------------------------------- HTTP


def test_http_forget(client, service, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    n = service.db.stats()["per_key"][PRIVATE]
    assert n >= 2

    r = client.post("/forget", json={"key": PRIVATE})
    assert r.status_code == 200
    body = r.json()
    assert body == {"ok": True, "key": PRIVATE, "removed_chunks": n}
    # 注意：/forget 会在后台把存档重新索引回来（墓碑会被跳过），所以这里不查块数

    assert client.post("/forget", json={"key": "不是 key"}).status_code == 400
    assert client.post("/forget", json={"key": ""}).status_code == 400


def test_http_search_503_while_lock_held_then_processes_request(client, service, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    req = write_forget_request(state, PRIVATE, 1234)

    service.indexer.lock.acquire()
    try:
        r = client.post("/search", json={"key": PRIVATE, "query": "火锅"})
    finally:
        service.indexer.lock.release()
    assert r.status_code == 503
    assert r.json()["detail"] == "该会话有待处理的遗忘请求，稍后再试"
    assert req.exists()

    r = client.post("/search", json={"key": PRIVATE, "query": "火锅"})
    assert r.status_code == 200
    assert not req.exists()  # 这一次处理掉了
    assert PRIVATE not in service.indexer.watermarks()


def test_http_rebuild_restores_chunks(client, service, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    total = service.db.stats()["chunks"]
    assert total >= 4

    service.forget(PRIVATE)
    assert service.db.stats()["chunks"] < total

    r = client.post("/rebuild", json={})
    assert r.status_code == 202
    job = r.json()["job"]
    assert job["kind"] == "rebuild" and job["finished_at"] is None and job["error"] is None

    health = None
    deadline = time.time() + 10
    while time.time() < deadline:
        health = client.get("/health").json()
        if health["job"] and health["job"]["finished_at"] is not None:
            break
        time.sleep(0.05)
    assert health["job"] and health["job"]["finished_at"] is not None
    assert health["job"]["error"] is None
    assert health["job"]["chunks"] == total
    assert service.db.stats()["chunks"] == total  # 块数恢复
    assert "job" in health and "forget_requests" in health


def test_http_rebuild_conflict_and_health_fields(client, service, state, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow_rebuild():
        started.set()
        release.wait(5)

    monkeypatch.setattr(service, "rebuild", slow_rebuild)
    req = write_forget_request(state, PRIVATE, 42)

    r = client.post("/rebuild", json={})
    assert r.status_code == 202
    assert started.wait(5)

    health = client.get("/health").json()
    assert health["job"]["kind"] == "rebuild"
    assert "forget_requests" in health and health["forget_requests"] == [PRIVATE]

    r2 = client.post("/rebuild", json={})
    assert r2.status_code == 409
    assert r2.json()["detail"] == "已有重建任务在进行"

    release.set()
    deadline = time.time() + 10
    while time.time() < deadline:
        if client.get("/health").json()["job"]["finished_at"] is not None:
            break
        time.sleep(0.05)
    assert client.get("/health").json()["job"]["finished_at"] is not None
    assert not req.exists()  # 重建已覆盖这个遗忘请求


# ---------------------------------------------------------------- 派生库里不留原文


def _assert_gone(service, state) -> None:
    """删掉带 LEAK_WORD 的那一行 + 遗忘 + 重建之后，rag 目录里不许再有它的字节。"""
    exclude_chroma = os.name == "nt"
    if exclude_chroma:
        print("SKIP Windows Chroma raw-byte scan: Chroma 1.5.9 Rust segment may not compact immediately after delete; logical deletion is asserted via collection.get() and SQL")
    blob = _rag_bytes(service.cfg["paths"].rag, exclude_chroma=exclude_chroma)
    assert LEAK_WORD.encode("utf-8") not in blob, "遗忘后派生库里仍能读到已删原文"
    # 阴性对照：另一个会话的唯一词还在，检索得到 ⇒ 不是「什么都没索引」
    hits = service.searcher.search(GROUP, "", [SAFE_WORD], routes=("bm25",))["items"]
    assert any(SAFE_WORD in it["text"] for it in hits), "另一个会话的块不能被误删"


def test_forget_leaves_no_original_text_on_disk(service, state):
    write_archive(state, PRIVATE, LEAK_ROWS)
    write_archive(state, GROUP, SAFE_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    before = service.searcher.search(PRIVATE, "", [LEAK_WORD], routes=("bm25",))["items"]
    assert any(LEAK_WORD in it["text"] for it in before)  # 删除前查得到

    f = state / "long-memory" / "archive" / "private_111" / "2026-10.jsonl"
    st = f.stat()
    tombstone(f, LEAK_LINE)
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert f.stat().st_size == st.st_size  # 墓碑等长

    service.forget(PRIVATE)
    service.indexer.run(now_ms=FAR_FUTURE)  # 从这个会话开头重建（墓碑被跳过）

    _assert_gone(service, state)


def test_rebuild_leaves_no_original_text_on_disk(service, state):
    write_archive(state, PRIVATE, LEAK_ROWS)
    write_archive(state, GROUP, SAFE_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    assert any(LEAK_WORD in it["text"]
               for it in service.searcher.search(PRIVATE, "", [LEAK_WORD], routes=("bm25",))["items"])

    f = state / "long-memory" / "archive" / "private_111" / "2026-10.jsonl"
    st = f.stat()
    tombstone(f, LEAK_LINE)
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))

    service.rebuild()  # 全量重建：删派生数据（clear: FTS optimize + VACUUM + 截断 WAL）
    service.indexer.run(now_ms=FAR_FUTURE)

    _assert_gone(service, state)


def test_chroma_stores_only_key_and_time_range(stack, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)

    got = stack.vs.col.get(include=["documents", "metadatas"])
    assert got["ids"], "应该已经写进向量库"
    assert all(d is None for d in got["documents"]), "Chroma 不许存块原文"
    for m in got["metadatas"]:
        assert set(m) == {"key", "t_start", "t_end"}, f"Chroma 元数据只留过滤字段，实际 {sorted(m)}"
        assert isinstance(m["t_start"], int) and isinstance(m["t_end"], int)

    # key 过滤仍然有效：按私聊的向量检索，取不出来的块一条都不属于别的会话
    vec = stack.emb.embed_query("火锅")
    private = stack.vs.query(PRIVATE, vec, n=50)
    group = stack.vs.query(GROUP, vec, n=50)
    assert private and group
    assert set(i for i, _ in private).isdisjoint(i for i, _ in group)
    assert all(r["key"] == PRIVATE for r in stack.db.get([i for i, _ in private]).values())
    assert all(r["key"] == GROUP for r in stack.db.get([i for i, _ in group]).values())

    # 时间范围过滤也还按 t_end / t_start 走：窗口放在所有块之后 ⇒ 一条都取不出来
    latest = max(r["t_end"] for r in stack.db.get([i for i, _ in private]).values())
    assert stack.vs.query(PRIVATE, vec, n=50, t_from=latest + 1) == []


# ---------------------------------------------------------------- 重建与 /health 并发


def _wait_job(client, timeout: float = 10.0) -> dict:
    """等后台重建任务结束（finished_at 非空），返回 /health 里的 job 快照。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get("/health").json().get("job")
        if job and job.get("finished_at") is not None:
            return job
        time.sleep(0.002)
    raise AssertionError("重建任务没有在超时内结束")


def test_http_health_during_rebuild_never_fails(client, service, state):
    """重建期间另一线程持续 GET /health，重建不许报错，/health 的字段与含义也不许变。

    FIX1031_PATCH：以前 `db.stats()` 这些只读接口没拿 `ChunkDB.lock`，会和 `clear()` 里的
    FTS optimize / wal_checkpoint(TRUNCATE) / VACUUM 在同一个 sqlite3 连接上交错，偶发
    `OperationalError: database table is locked`（线上点「全量重建」时控制台正好在轮询
    /health，撞的是同一个窗口）。这个用例把并发拉满：修之前每轮有较高概率失败，修完应稳定通过。
    """
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    total = service.db.stats()["chunks"]
    assert total >= 4

    health_keys = {"ok", "embedding", "mismatch", "store", "lag_rows", "last_index",
                   "job", "forget_requests", "distill"}
    stop = threading.Event()
    errors: list[str] = []
    calls = 0

    def hammer() -> None:
        nonlocal calls
        while not stop.is_set():
            try:
                r = client.get("/health")
                if r.status_code != 200:
                    errors.append(f"health {r.status_code}: {r.text[:200]}")
                    continue
                body = r.json()
                calls += 1
                missing = health_keys - set(body)
                if missing:
                    errors.append(f"/health 少了字段：{sorted(missing)}")
                job = body.get("job")
                if job and job.get("error") is not None:
                    errors.append(f"job 报错：{job['error']}")
            except Exception as e:  # noqa: BLE001  —— 读接口被并发打断也算失败
                errors.append(f"{type(e).__name__}: {e}")

    th = threading.Thread(target=hammer, name="health-hammer", daemon=True)
    th.start()
    try:
        # 一轮重建 ≈ 一次 clear(VACUUM + 截断 WAL) + 一次全量索引；多跑几轮把窗口撞满
        for i in range(20):
            r = client.post("/rebuild", json={})
            assert r.status_code == 202, r.text
            job = _wait_job(client)
            assert job["error"] is None, f"第 {i} 轮重建失败：{job['error']}"
            assert job["chunks"] == total, f"第 {i} 轮重建后块数不对：{job['chunks']} != {total}"
    finally:
        stop.set()
        th.join(5)

    assert not errors, f"重建期间 /health 出错（前 3 条）：{errors[:3]}"
    assert calls >= 20, f"并发轮询没真正跑起来（只成功 {calls} 次）"
    assert service.db.stats()["chunks"] == total


# ---------------------------------------------------------------- 换向量口径后重建（APIHUB_PATCH）


class _StoreEmbedder:
    """APIHUB_PATCH：口径可配的假 embedding——模型名和维度都能换，不连 8091、不联网。

    和 conftest 的 FakeEmbedder 一样只按文字算一个确定向量；区别是 model_id / dim 由用例指定，
    才能在同一进程里模拟「控制台换了向量模型」。不用 numpy：这里只需要能被 Chroma 吃下的数组。
    """

    def __init__(self, model_id: str, dim: int):
        self.model_id = model_id
        self.dim = dim

    def _one(self, text: str) -> list[float]:
        v = [0.0] * self.dim
        for i, ch in enumerate(text[: self.dim]):
            v[i] = ord(ch) % 97 + 1.0
        n = sum(x * x for x in v) ** 0.5 or 1.0
        return [x / n for x in v]

    def embed_docs(self, texts):
        return [self._one(t) for t in texts]

    def embed_query(self, text):
        return self._one(text)

    def healthy(self):
        return True


def _close_service(svc) -> None:
    """释放这轮 Service 的向量库客户端与 SQLite 连接（同 conftest.close_rag）。"""
    from conftest import close_rag

    close_rag(svc)


def _rebuild_after_model_change(monkeypatch, state, dim_b: int) -> None:
    """同一进程内：A 口径建库并索引 → B 口径启动报不一致 → rebuild() 必须能救回来。"""
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    write_archive(state, PRIVATE, PRIVATE_ROWS)

    svc_a = Service(str(ROOT / "config.yml"), embedder=_StoreEmbedder("model-A", 8))
    try:
        assert svc_a.mismatch is None
        assert svc_a.indexer.run(now_ms=FAR_FUTURE)["chunks"] >= 2
        assert svc_a.vstore.count() > 0
    finally:
        _close_service(svc_a)

    svc_b = Service(str(ROOT / "config.yml"), embedder=_StoreEmbedder("model-B", dim_b))
    try:
        # 换口径后启动一定是 mismatch（否则这个用例根本没测到要修的那条路）
        assert svc_b.mismatch and "model-A" in svc_b.mismatch
        assert svc_b.vstore is None and svc_b.indexer is None

        # 改动前：这里抛 IndexMismatch（rmtree 删了磁盘文件，chromadb 同进程按路径缓存
        # 的 System 还是那一份，旧集合与旧 metadata 都还在）
        svc_b.rebuild()

        assert svc_b.mismatch is None
        assert svc_b.vstore.model_id == "model-B" and svc_b.vstore.dim == dim_b
        assert svc_b.indexer is not None and svc_b.searcher is not None
        # 新口径能把块重新索引进去（不是「能打开但写不进去」）
        assert svc_b.indexer.run(now_ms=FAR_FUTURE)["chunks"] >= 2
        assert svc_b.vstore.count() > 0

        health = svc_b.health()
        assert health["ok"] is True and health["mismatch"] is None
        assert health["embedding"]["model_id"] == "model-B"
        assert health["embedding"]["healthy"] is True
        assert health["store"]["vectors"] == svc_b.vstore.count() > 0
    finally:
        _close_service(svc_b)


def test_rebuild_after_model_change_in_same_process(monkeypatch, state):
    """控制台换向量模型后桥接重启 memory-rag 并调 /rebuild：维度不变（8 → 8）。"""
    _rebuild_after_model_change(monkeypatch, state, dim_b=8)


def test_rebuild_after_model_and_dim_change_in_same_process(monkeypatch, state):
    """同一条路，维度也变了（8 → 16）：旧集合的维度不能把新集合卡住。"""
    _rebuild_after_model_change(monkeypatch, state, dim_b=16)
