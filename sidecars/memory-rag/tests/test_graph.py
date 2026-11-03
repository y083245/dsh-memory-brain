"""BRAIN_PATCH：实时脑图的 `/graph`、`/chunk` 与 `/search` 的 `debug`（接口约定 §5.1）。

全部用临时 state + 假 embedding，摘要 / 实体 / 关系 / 候选用 `l2.write_summary` 手写，不调模型、不联网。
HTTP 测试与 `test_forget_rebuild.py` 同一套做法：**import `memory_rag.app` 之前**把
`MEMORY_RAG_STATE_DIR` 指到临时目录，import 完立刻还回去。
"""

from __future__ import annotations

import json
import os
import tempfile

_ORIG_STATE_DIR = os.environ.get("MEMORY_RAG_STATE_DIR")
_IMPORT_STATE = tempfile.mkdtemp(prefix="memory-rag-graph-")
os.environ["MEMORY_RAG_STATE_DIR"] = _IMPORT_STATE

import pytest  # noqa: E402
from fastapi.encoders import jsonable_encoder  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from memory_rag import app as app_module  # noqa: E402
from memory_rag.embeddings import EmbeddingUnavailable  # noqa: E402
from memory_rag.l2 import L2, SELF, normalize_name  # noqa: E402
from memory_rag.service import Service  # noqa: E402

if _ORIG_STATE_DIR is None:
    os.environ.pop("MEMORY_RAG_STATE_DIR", None)
else:
    os.environ["MEMORY_RAG_STATE_DIR"] = _ORIG_STATE_DIR

from conftest import (  # noqa: E402  （顺序有意为之：环境变量要先设置）
    FAR_FUTURE, ROOT, FakeEmbedder, close_rag, tombstone, write_archive, write_forget_request,
)

PRIVATE = "private:111"
GROUP = "group:222"

# 每个话题段里放一个独一无二的词：断言 /graph 的 JSON 里绝不出现块原文
P_SECRET_1 = "紫水晶灯塔"
P_SECRET_2 = "独角兽蛋糕"
G_SECRET_1 = "琥珀胸针"
G_SECRET_2 = "银杏书签"
SECRETS = (P_SECRET_1, P_SECRET_2, G_SECRET_1, G_SECRET_2)

# 两段话题（中间空 58 分钟 > 30 分钟分段线）；群的时间整体错开几分钟，块的 t_end 互不相同
PRIVATE_ROWS = [
    (0, "in", "111", "平安", f"周末想去吃那家重庆火锅，{P_SECRET_1}也想看"),
    (1, "in", "111", "平安", "排队也没关系"),
    (2, "out", None, "", "那就早点去"),
    (60, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (61, "in", "111", "平安", f"{P_SECRET_2}的配色也想好了"),
    (62, "out", None, "", "这版动画脚本结构清楚多了"),
]
P_LINE_2 = 5  # P_SECRET_2 所在行（1 起）
GROUP_ROWS = [
    (5, "in", "333", "老周", f"明天开会吗，{G_SECRET_1}到了"),
    (6, "in", "444", "糖糖", "项目要延期了"),
    (7, "out", None, "", "那就先别加班"),
    (70, "in", "333", "老周", "需求又变了"),
    (71, "in", "444", "糖糖", f"老板说要开会，{G_SECRET_2}丢了"),
    (72, "out", None, "", "先改完再说"),
]


def ent(eid: str, name: str, etype: str = "thing", qq: str | None = None) -> dict:
    if eid == SELF:
        etype = "person"
    elif eid.startswith("qq:"):
        etype, qq = "person", eid[3:]
    return {"entity_id": eid, "type": etype, "name": name, "norm": normalize_name(name), "qq": qq}


def _result(key: str, idx: int) -> dict:
    """手写一份提炼结果：两个会话共用实体 `self` 和 `t:hotpot`，各自还有专属实体。"""
    if key == PRIVATE:
        own = ent("qq:111", "平安")
        who = "111"
    else:
        own = ent("qq:333", "老周")
        who = "333"
    extra = ent(f"t:{key}:{idx}", f"专属{key}{idx}")
    shared = ent("t:hotpot", "火锅")
    return {"title": f"{key} 话题{idx}", "summary": f"{key} 的第 {idx} 段摘要",
            "importance": 0.5, "valence": 0.1,
            "entities": [ent(SELF, "我"), own, shared, extra],
            "relations": [{"src_id": own["entity_id"], "dst_id": shared["entity_id"], "relation": "想吃"},
                          {"src_id": own["entity_id"], "dst_id": "t:missing", "relation": "悬空"}],
            "notes": [{"who": who, "cat": "pending", "text": f"{key} 候选{idx}", "due": None}]}


def distill_all(svc) -> dict[str, list[str]]:
    """给每个块手写一条摘要，返回 {key: [chunk_id, ...]}（按时间先后）。"""
    l2 = L2(svc.db)
    out: dict[str, list[str]] = {}
    now = int(FAR_FUTURE)
    for i, ch in enumerate(l2.pending_chunks(now, 100)):
        sid = l2.write_summary(ch["chunk_id"], ch["text_hash"], _result(ch["key"], len(out.get(ch["key"], []))), "test", now + i)
        assert sid
        out.setdefault(ch["key"], []).append(ch["chunk_id"])
    return out


@pytest.fixture
def service(monkeypatch, state):
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    assert svc.cfg["paths"].state == state
    assert str(svc.cfg["paths"].state).startswith(tempfile.gettempdir())
    yield svc
    close_rag(svc)


@pytest.fixture
def filled(service, state):
    pf = write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    chunks = distill_all(service)
    assert len(chunks[PRIVATE]) == 2 and len(chunks[GROUP]) == 2
    service.private_file = pf
    service.chunk_ids = chunks
    return service


@pytest.fixture
def client(monkeypatch, filled):
    monkeypatch.setattr(app_module, "svc", filled)
    return TestClient(app_module.app)


def _graph(client, **body):
    r = client.post("/graph", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- 1. 范围与 400


def test_graph_all_keys_and_shape(client, filled):
    g = _graph(client)
    assert g["ok"] is True
    assert set(g) == {"ok", "chunks", "summaries", "entities", "summary_entities", "relations", "notes", "truncated"}
    assert {c["key"] for c in g["chunks"]} == {PRIVATE, GROUP}
    assert len(g["chunks"]) == 4 and len(g["summaries"]) == 4 and len(g["notes"]) == 4
    assert g["truncated"] == {"chunks": 0, "summaries": 0, "entities": 0, "notes": 0}
    c = g["chunks"][0]
    assert set(c) == {"chunk_id", "key", "day", "t_start", "t_end", "title", "n_msgs", "speakers", "speaker_names"}
    priv = [c for c in g["chunks"] if c["key"] == PRIVATE]
    assert all(c["speakers"] == ["111"] and c["speaker_names"] == ["平安"] for c in priv)
    grp = [c for c in g["chunks"] if c["key"] == GROUP]
    assert all(set(c["speakers"]) == {"333", "444"} for c in grp)
    s = g["summaries"][0]
    assert set(s) == {"summary_id", "chunk_id", "key", "day", "t_start", "t_end", "title", "summary",
                      "importance", "valence"}
    assert set(g["entities"][0]) == {"entity_id", "type", "name", "qq", "n"}
    assert set(g["summary_entities"][0]) == {"summary_id", "entity_id", "key"}
    assert set(g["relations"][0]) == {"summary_id", "key", "src_id", "dst_id", "relation"}
    assert set(g["notes"][0]) == {"note_id", "summary_id", "key", "who", "who_name", "cat", "text", "due", "created_at"}
    # 指向不存在实体的关系不返回（页面不会连到不存在的点）
    assert all(r["dst_id"] != "t:missing" for r in g["relations"])
    assert len(g["relations"]) == 4
    # 空列表 / null 都等于全部
    assert _graph(client, keys=[]) == g
    assert _graph(client, keys=None) == g


def test_graph_single_key_isolated(client, filled):
    g = _graph(client, keys=[PRIVATE])
    assert {c["key"] for c in g["chunks"]} == {PRIVATE}
    assert {s["key"] for s in g["summaries"]} == {PRIVATE}
    assert {n["key"] for n in g["notes"]} == {PRIVATE}
    assert {x["key"] for x in g["summary_entities"]} == {PRIVATE}
    assert {r["key"] for r in g["relations"]} == {PRIVATE}
    eids = {e["entity_id"] for e in g["entities"]}
    assert "qq:333" not in eids and not any(e.startswith(f"t:{GROUP}") for e in eids)
    assert {"qq:111", SELF, "t:hotpot"} <= eids
    sids = {s["summary_id"] for s in g["summaries"]}
    assert all(x["summary_id"] in sids for x in g["summary_entities"])
    # 重复的 key 去重
    assert _graph(client, keys=[PRIVATE, PRIVATE]) == g


@pytest.mark.parametrize("keys", [["private:abc"], ["bad"], [PRIVATE, "group:"], [""]])
def test_graph_bad_key_400(client, keys):
    assert client.post("/graph", json={"keys": keys}).status_code == 400


# ---------------------------------------------------------------- 2. 不含原文


def test_graph_has_no_chunk_text(client, filled):
    for body in ({}, {"keys": [PRIVATE]}, {"keys": [GROUP]}):
        raw = client.post("/graph", json=body).content.decode("utf-8")
        for w in SECRETS + ("排队也没关系", "先改完再说"):
            assert w not in raw
        assert all("text" not in c for c in json.loads(raw)["chunks"])


# ---------------------------------------------------------------- 3. limit 截断


def test_graph_limit_takes_newest(client, filled):
    full = _graph(client)
    g = _graph(client, limit=1)
    newest_chunk = max(full["chunks"], key=lambda c: c["t_end"])
    assert [c["chunk_id"] for c in g["chunks"]] == [newest_chunk["chunk_id"]]
    newest_sum = max(full["summaries"], key=lambda s: s["t_end"])
    assert [s["summary_id"] for s in g["summaries"]] == [newest_sum["summary_id"]]
    newest_note = max(full["notes"], key=lambda n: n["created_at"])
    assert [n["note_id"] for n in g["notes"]] == [newest_note["note_id"]]
    assert len(g["entities"]) == 1
    # 只有一条摘要：它关联 4 个实体，留下 1 个，截掉 3 个
    assert g["truncated"] == {"chunks": 3, "summaries": 3, "entities": 3, "notes": 3}
    kept = {e["entity_id"] for e in g["entities"]}
    assert all(x["entity_id"] in kept for x in g["summary_entities"])
    assert all(r["src_id"] in kept and r["dst_id"] in kept for r in g["relations"])

    g2 = _graph(client, limit=2, keys=[GROUP])
    assert len(g2["chunks"]) == 2 and g2["truncated"]["chunks"] == 0
    # limit 夹到 1～2000
    assert len(_graph(client, limit=0)["chunks"]) == 1
    assert len(_graph(client, limit=99999)["chunks"]) == 4


# ---------------------------------------------------------------- 4. 实体计数


def test_graph_entity_counts(client, filled):
    def counts(body):
        return {e["entity_id"]: e["n"] for e in _graph(client, **body)["entities"]}

    allc = counts({})
    assert allc[SELF] == 4 and allc["t:hotpot"] == 4
    assert allc["qq:111"] == 2 and allc["qq:333"] == 2
    assert allc[f"t:{PRIVATE}:0"] == 1
    pc = counts({"keys": [PRIVATE]})
    # 跨会话共用的实体在单会话请求里只数该会话的摘要
    assert pc[SELF] == 2 and pc["t:hotpot"] == 2 and pc["qq:111"] == 2
    gc = counts({"keys": [GROUP]})
    assert gc[SELF] == 2 and "qq:111" not in gc


# ---------------------------------------------------------------- 5. 遗忘之后


def test_forget_then_graph_and_chunk_hide_deleted(client, filled, state):
    old_chunks = list(filled.chunk_ids[PRIVATE])
    before = _graph(client, keys=[PRIVATE])
    old_sids = {s["summary_id"] for s in before["summaries"]}
    old_notes = {n["note_id"] for n in before["notes"]}
    assert client.post("/chunk", json={"key": PRIVATE, "chunk_id": old_chunks[1]}).status_code == 200

    tombstone(filled.private_file, P_LINE_2)
    write_forget_request(state, PRIVATE, at=1)

    g = _graph(client)  # 不带 keys 也要先消费全部遗忘请求
    assert not (state / "long-memory" / "forget-requests" / "private_111.json").exists()
    assert not any(c["chunk_id"] in old_chunks for c in g["chunks"])
    assert not any(s["summary_id"] in old_sids for s in g["summaries"])
    assert not any(n["note_id"] in old_notes for n in g["notes"])
    assert {c["key"] for c in g["chunks"]} == {GROUP}  # 别的会话不受影响
    assert P_SECRET_2 not in json.dumps(g, ensure_ascii=False)
    for cid in old_chunks:
        assert client.post("/chunk", json={"key": PRIVATE, "chunk_id": cid}).status_code == 404

    # 重新索引回来的块不含被删那行
    filled.indexer.run(now_ms=FAR_FUTURE)
    for c in _graph(client, keys=[PRIVATE])["chunks"]:
        r = client.post("/chunk", json={"key": PRIVATE, "chunk_id": c["chunk_id"]})
        assert r.status_code == 200 and P_SECRET_2 not in r.json()["text"]


def test_chunk_consumes_forget_request(client, filled, state):
    cid = filled.chunk_ids[PRIVATE][0]
    write_forget_request(state, PRIVATE, at=1)
    assert client.post("/chunk", json={"key": PRIVATE, "chunk_id": cid}).status_code == 404
    assert not (state / "long-memory" / "forget-requests" / "private_111.json").exists()


def test_graph_503_when_index_busy(client, filled, state):
    write_forget_request(state, PRIVATE, at=1)
    lock = filled.indexer.lock
    assert lock.acquire(timeout=5)
    try:
        assert client.post("/graph", json={"keys": [PRIVATE]}).status_code == 503
        assert client.post("/graph", json={}).status_code == 503
        assert client.post("/chunk", json={"key": PRIVATE, "chunk_id": "x"}).status_code == 503
        # 没有待处理请求的会话照常
        assert client.post("/graph", json={"keys": [GROUP]}).status_code == 200
    finally:
        lock.release()
    assert client.post("/graph", json={"keys": [PRIVATE]}).status_code == 200


# ---------------------------------------------------------------- 6. /chunk


def test_chunk_returns_text_and_uniform_404(client, filled):
    cid = filled.chunk_ids[PRIVATE][0]
    r = client.post("/chunk", json={"key": PRIVATE, "chunk_id": cid})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"ok", "chunk_id", "key", "day", "title", "t_start", "t_end", "n_msgs", "text"}
    assert body["ok"] is True and body["chunk_id"] == cid and body["key"] == PRIVATE
    assert P_SECRET_1 in body["text"] and body["n_msgs"] == 3

    wrong = client.post("/chunk", json={"key": GROUP, "chunk_id": cid})
    missing = client.post("/chunk", json={"key": PRIVATE, "chunk_id": "no-such-chunk"})
    empty = client.post("/chunk", json={"key": PRIVATE, "chunk_id": ""})
    assert wrong.status_code == missing.status_code == empty.status_code == 404
    assert wrong.content == missing.content == empty.content
    assert client.post("/chunk", json={"key": "bad", "chunk_id": cid}).status_code == 400


# ---------------------------------------------------------------- 7. /search 的 debug


def _old_search_bytes(svc, body: dict) -> bytes:
    """改动前 /search 的做法：同样的位置参数、不传 debug，按 FastAPI 默认方式序列化。"""
    out = svc.searcher.search(body["key"], body.get("query", ""), body.get("keywords", [])[:12],
                              None, None, "", None, None)
    return JSONResponse(content=jsonable_encoder(out)).body


def test_search_without_debug_unchanged(client, filled):
    for body in ({"key": PRIVATE, "query": "火锅", "keywords": ["火锅"]},
                 {"key": GROUP, "query": "开会"},
                 {"key": PRIVATE, "query": "提示词", "debug": False}):
        r = client.post("/search", json=body)
        assert r.status_code == 200
        assert r.content == _old_search_bytes(filled, body)
        assert "ranked" not in r.json() and "routes" not in r.json()


def test_search_with_debug_adds_trace(client, filled):
    body = {"key": PRIVATE, "query": "火锅", "keywords": ["火锅"]}
    plain = client.post("/search", json=body).json()
    dbg = client.post("/search", json={**body, "debug": True}).json()
    assert set(dbg) - set(plain) == {"ranked", "routes"}
    assert isinstance(dbg["ranked"], list) and isinstance(dbg["routes"], dict)
    assert {k: v for k, v in dbg.items() if k not in ("ranked", "routes")} == plain


# ---------------------------------------------------------------- 8. embedding 不可用 / 口径不一致


class _BrokenEmbedder(FakeEmbedder):
    def embed_docs(self, texts):
        raise EmbeddingUnavailable("down")

    def embed_query(self, text):
        raise EmbeddingUnavailable("down")

    def healthy(self):
        return False


class _OtherEmbedder(FakeEmbedder):
    model_id = "other|dim=8"
    dim = 8


def test_graph_ok_when_embedding_down(monkeypatch, filled):
    filled.embedder = _BrokenEmbedder()
    filled.indexer.embedder = filled.embedder
    filled.searcher.embedder = filled.embedder
    monkeypatch.setattr(app_module, "svc", filled)
    c = TestClient(app_module.app)
    g = c.post("/graph", json={})
    assert g.status_code == 200 and len(g.json()["chunks"]) == 4
    cid = filled.chunk_ids[GROUP][0]
    assert c.post("/chunk", json={"key": GROUP, "chunk_id": cid}).status_code == 200


def test_graph_ok_when_mismatch(monkeypatch, client, filled, state):
    expected = client.post("/graph", json={}).json()
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc_b = Service(str(ROOT / "config.yml"), embedder=_OtherEmbedder())
    try:
        assert svc_b.mismatch and svc_b.indexer is None and svc_b.l2 is None
        monkeypatch.setattr(app_module, "svc", svc_b)
        c = TestClient(app_module.app)
        # 别的接口照旧 503，/graph 与 /chunk 照常
        assert c.post("/search", json={"key": PRIVATE, "query": "火锅"}).status_code == 503
        g = c.post("/graph", json={})
        assert g.status_code == 200 and g.json() == expected
        cid = filled.chunk_ids[PRIVATE][0]
        assert c.post("/chunk", json={"key": PRIVATE, "chunk_id": cid}).status_code == 200

        # 口径不一致时消费不了遗忘请求：涉及的会话一律 503，别的会话照常
        write_forget_request(state, PRIVATE, at=1)
        assert c.post("/graph", json={}).status_code == 503
        assert c.post("/graph", json={"keys": [PRIVATE]}).status_code == 503
        assert c.post("/chunk", json={"key": PRIVATE, "chunk_id": cid}).status_code == 503
        assert c.post("/graph", json={"keys": [GROUP]}).status_code == 200
    finally:
        close_rag(svc_b)
