from __future__ import annotations

import base64
import hashlib
import json
import os

import pytest
from fastapi.testclient import TestClient

from conftest import FAR_FUTURE, ROOT, FakeEmbedder, close_rag, write_archive
from memory_rag.l2 import text_hash
from memory_rag.service import Service


def encoded(prefix, payload):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return prefix + "_" + base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


CONVERSATION = ["telegram", "41", None, "group", "-100123", "7"]
OTHER_CONVERSATION = ["telegram", "41", None, "group", "-100123", "8"]
KEY = encoded("c1", CONVERSATION)
OTHER = encoded("c1", OTHER_CONVERSATION)
PERSON = encoded("p1", [*CONVERSATION[:3], "42"])
LEGACY = "private:111"
SECRET = "obsoletemarker"
SAFE = "retainedmarker"


def publish(state, conversation, body, message_id, month="2026-10", name="聊天用户"):
    key = encoded("c1", conversation)
    directory = state / "long-memory" / "channel-archive" / ("c1_" + hashlib.sha256(key.encode()).hexdigest())
    directory.mkdir(parents=True, exist_ok=True)
    fields = ("platform", "accountId", "tenantId", "chatType", "chatId", "threadId")
    metadata = {"version": 1, "conversationKey": key, "conversation": dict(zip(fields, conversation))}
    (directory / "conversation.json").write_text(json.dumps(metadata), encoding="utf-8")
    message_key = encoded("m1", [conversation, conversation[4], str(message_id)])
    row = {"recordId": "record_" + hashlib.sha256(message_key.encode()).hexdigest(),
           "conversationKey": key, "personKey": encoded("p1", [*conversation[:3], "42"]),
           "messageKey": message_key, "replyToMessageKey": None, "t": month + "-01T12:00:00.000Z",
           "dir": "in", "userId": "42", "name": name, "text": body, "msgId": str(message_id)}
    path = directory / (month + ".jsonl")
    with path.open("ab") as stream:
        stream.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
    path.with_name(path.name + ".watermark.json").write_text(json.dumps({"bytes": path.stat().st_size}), encoding="utf-8")
    return path, row


def forget_first(path, row):
    original = path.read_bytes()
    marker = {field: row[field] for field in ("recordId", "conversationKey", "messageKey")}
    marker["deleted"] = True
    replacement = json.dumps(marker, separators=(",", ":")).encode()
    length = original.index(b"\n")
    assert len(replacement) < length
    before = path.stat()
    path.write_bytes(replacement.ljust(length) + original[length:])
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert path.stat().st_size == before.st_size


@pytest.fixture
def service_api(monkeypatch, state):
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state.parent / "app-bootstrap"))
    from memory_rag import app as app_module

    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    services = []

    def start():
        service = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
        services.append(service)
        monkeypatch.setattr(app_module, "svc", service)
        return service, TestClient(app_module.app)

    yield start
    for service in reversed(services):
        close_rag(service)


def seed_summary(svc, key, text):
    chunk = svc.db.graph_chunks([key], 1)[0][0]
    chunk = svc.db.get([chunk["chunk_id"]])[chunk["chunk_id"]]
    summary = {"title": "同名话题", "summary": text, "entities": [
        {"entity_id": "person:" + PERSON, "type": "person", "name": "聊天用户", "norm": "聊天用户"},
        {"entity_id": "thing:火锅", "type": "thing", "name": "火锅", "norm": "火锅"},
    ], "notes": [{"who": PERSON, "who_name": "聊天用户", "cat": "fact", "text": text}]}
    sid = svc.l2.write_summary(chunk["chunk_id"], text_hash(chunk["text"]), summary, "fake", int(FAR_FUTURE))
    assert sid
    svc.vstore.upsert_summaries([sid], svc.embedder.embed_docs([text]), [chunk])
    svc.l2.mark_vec_done([sid])
    return chunk["chunk_id"], sid


def scoped_calls(key, chunk_id, sid):
    return [
        ("/search", {"key": key, "query": SECRET}),
        ("/recall", {"key": key, "texts": [SECRET], "now": int(FAR_FUTURE)}),
        ("/associate", {"key": key, "people": [PERSON], "now": int(FAR_FUTURE)}),
        ("/summaries", {"key": key, "ids": [sid]}),
        ("/notes", {"key": key}),
        ("/graph", {"keys": [key]}),
        ("/chunk", {"key": key, "chunk_id": chunk_id}),
    ]


def test_channel_indexes_exact_scope_and_preserves_legacy_fts(state, service_api):
    write_archive(state, LEGACY, [(0, "in", "111", "平安", "火锅 legacyone"),
                                  (60, "in", "111", "平安", "火锅 legacytwo")])
    svc, client = service_api()
    svc.indexer.run(now_ms=FAR_FUTURE)
    old_scores = svc.db.bm25(LEGACY, ["火锅", "legacyone"])
    old_freq = svc.db.doc_freq(["火锅", "legacyone"])
    assert old_scores
    path, row = publish(state, CONVERSATION, f"火锅 {SECRET}", 1)
    publish(state, OTHER_CONVERSATION, f"火锅 {SAFE}", 1, name="异域同名")
    assert client.post("/search", json={"key": KEY, "query": SECRET}).status_code == 503
    svc.indexer.run(now_ms=FAR_FUTURE)
    assert svc.db.bm25(LEGACY, ["火锅", "legacyone"]) == old_scores
    assert svc.db.doc_freq(["火锅", "legacyone"]) == old_freq
    assert svc.db.bm25(KEY, [SECRET]) and not svc.db.bm25(OTHER, [SECRET])
    assert client.get("/health").json()["archive_protocol"] == {"identity": 1, "archive": 2, "index": 1}
    assert client.get("/health?protocol=channel").json()["ok"] is True
    res = client.post("/search", json={"key": KEY, "query": "火锅", "debug": True}).json()
    assert res["key"] == KEY and len(res["items"]) == 1
    evidence = res["items"][0]
    assert SECRET in evidence["text"] and SAFE not in evidence["text"]
    assert evidence["file"] == f"{path.parent.name}/{path.name}"
    assert evidence["line_start"] == 1 and evidence["byte_start"] == 0
    assert evidence["byte_end"] == path.stat().st_size and evidence["record_id_start"] == row["recordId"]

    cid, sid = seed_summary(svc, KEY, SECRET)
    _, other_sid = seed_summary(svc, OTHER, SAFE)
    for endpoint, payload in scoped_calls(KEY, cid, sid):
        response = client.post(endpoint, json=payload)
        assert response.status_code == 200, (endpoint, response.text)
        assert SECRET in response.text, endpoint
        assert SAFE not in response.text and other_sid not in response.text
    assert client.post("/chunk", json={"key": OTHER, "chunk_id": cid}).status_code == 404
    for payload in ({}, {"keys": []}):
        graph = client.post("/graph", json=payload).json()
        assert {chunk["key"] for chunk in graph["chunks"]} == {LEGACY}
        assert not graph["summaries"] and not graph["entities"]
    both = client.post("/graph", json={"keys": [KEY, OTHER]}).json()
    assert len(both["entities"]) == 4
    assert {edge["key"] for edge in both["summary_entities"]} == {KEY, OTHER}


def test_same_length_deletion_while_stopped_is_closed_then_purged(state, service_api):
    path, row = publish(state, CONVERSATION, f"火锅 {SECRET}", 1)
    publish(state, CONVERSATION, "火锅后续 stillhere", 2)
    publish(state, OTHER_CONVERSATION, SAFE, 1)
    svc, _ = service_api()
    svc.indexer.run(now_ms=FAR_FUTURE)
    cid, sid = seed_summary(svc, KEY, SECRET)
    backup = svc.db.path.with_name(svc.db.path.name + ".bak-v0")
    backup.write_text(SECRET, encoding="utf-8")
    close_rag(svc)
    forget_first(path, row)
    svc, client = service_api()
    for endpoint, payload in scoped_calls(KEY, cid, sid):
        response = client.post(endpoint, json=payload)
        assert response.status_code == 503, (endpoint, response.text)
        assert SECRET not in response.text
    assert client.post("/search", json={"key": OTHER, "query": SAFE}).status_code == 200
    svc.indexer.run(now_ms=FAR_FUTURE)
    assert not backup.exists()
    assert not svc.db.get([cid]) and not svc.l2.get_summaries(KEY, [sid])
    assert not svc.l2.bm25_summaries(KEY, [SECRET])
    assert sid not in svc.vstore.scol.get(where={"key": KEY})["ids"]
    assert cid not in svc.vstore.col.get(where={"key": KEY})["ids"]
    assert svc.l2.notes(KEY) == []
    found = client.post("/search", json={"key": KEY, "query": "stillhere"}).json()
    assert "stillhere" in found["items"][0]["text"] and SECRET not in json.dumps(found)


def test_read_guard_detects_deletion_during_response_assembly(state, service_api, monkeypatch):
    path, row = publish(state, CONVERSATION, SECRET, 1)
    svc, client = service_api()
    svc.indexer.run(now_ms=FAR_FUTURE)
    cid, _ = seed_summary(svc, KEY, SECRET)
    original = svc.db.chunk_text

    def read_and_delete(key, chunk_id):
        result = original(key, chunk_id)
        assert SECRET in result["text"]
        forget_first(path, row)
        return result

    monkeypatch.setattr(svc.db, "chunk_text", read_and_delete)
    response = client.post("/chunk", json={"key": KEY, "chunk_id": cid})
    assert response.status_code == 503 and SECRET not in response.text


def test_append_is_searchable_as_pending_without_waiting_for_next_index(state, service_api):
    path, _ = publish(state, CONVERSATION, "originaltopic", 1)
    svc, client = service_api()
    backup = svc.db.path.with_name(svc.db.path.name + ".bak-v0")
    backup.write_text("legacy migration backup", encoding="utf-8")
    svc.indexer.run(now_ms=FAR_FUTURE)
    assert backup.exists()
    _, sid = seed_summary(svc, KEY, "originaltopic")
    _, row = publish(state, CONVERSATION, "newappendtopic", 2)
    response = client.post("/search", json={"key": KEY, "keywords": ["newappendtopic"], "expand": 0})
    assert response.status_code == 200, response.text
    item, = response.json()["items"]
    assert item["sources"] == ["pending"] and "newappendtopic" in item["text"]
    assert item["file"] == f"{path.parent.name}/{path.name}" and item["line_start"] == 2
    assert item["record_id_end"] == row["recordId"]
    svc.indexer.run(now_ms=FAR_FUTURE)
    assert svc.l2.get_summaries(KEY, [sid]) and backup.exists()


def test_backfill_before_the_watermark_rebuilds_only_that_source(state, service_api):
    publish(state, CONVERSATION, "originaltopic", 1)
    publish(state, OTHER_CONVERSATION, SAFE, 1)
    svc, client = service_api()
    svc.indexer.run(now_ms=FAR_FUTURE)
    _, sid = seed_summary(svc, KEY, "originaltopic")
    _, other_sid = seed_summary(svc, OTHER, SAFE)
    publish(state, CONVERSATION, "olderbackfill", 2, month="2026-09")
    assert client.post("/summaries", json={"key": KEY, "ids": [sid]}).status_code == 503
    svc.indexer.run(now_ms=FAR_FUTURE)
    assert not svc.l2.get_summaries(KEY, [sid]) and svc.l2.get_summaries(OTHER, [other_sid])
    result = client.post("/search", json={"key": KEY, "query": "olderbackfill"}).json()
    assert any("olderbackfill" in it["text"] for it in result["items"])


def test_corrupt_archive_cannot_block_indexing_another_source(state, service_api):
    path, _ = publish(state, CONVERSATION, SECRET, 1)
    publish(state, OTHER_CONVERSATION, SAFE, 1)
    svc, client = service_api()
    svc.indexer.run(now_ms=FAR_FUTURE)
    cid, sid = seed_summary(svc, KEY, SECRET)
    path.with_name(path.name + ".watermark.json").write_text("invalid", encoding="utf-8")
    publish(state, OTHER_CONVERSATION, "anotherretained", 2)
    run = svc.indexer.run(now_ms=FAR_FUTURE)
    assert run["keys"][KEY]["error"] == "ChannelArchiveError"
    assert run["keys"][OTHER]["chunks"] == 1
    assert not svc.db.get([cid]) and not svc.l2.get_summaries(KEY, [sid])
    assert client.post("/search", json={"key": KEY, "query": SECRET}).status_code == 503
    other = client.post("/search", json={"key": OTHER, "query": "anotherretained"}).json()
    assert any("anotherretained" in it["text"] for it in other["items"])


def test_interrupted_dual_write_is_not_published_and_recovers_after_restart(state, service_api, monkeypatch):
    publish(state, CONVERSATION, SAFE, 1)
    svc, client = service_api()
    original = svc.vstore.upsert

    def interrupted(*args):
        original(*args)
        raise RuntimeError("test interruption after Chroma commit")

    monkeypatch.setattr(svc.vstore, "upsert", interrupted)
    with pytest.raises(RuntimeError, match="interruption"):
        svc.indexer.run(now_ms=FAR_FUTURE)
    assert svc.vstore.col.get(where={"key": KEY})["ids"]
    assert client.post("/search", json={"key": KEY, "query": SAFE}).status_code == 503
    close_rag(svc)
    svc, client = service_api()
    assert client.post("/search", json={"key": KEY, "query": SAFE}).status_code == 503
    svc.indexer.run(now_ms=FAR_FUTURE)
    assert len(svc.vstore.col.get(where={"key": KEY})["ids"]) == 1
    assert SAFE in client.post("/search", json={"key": KEY, "query": SAFE}).text


def test_stale_summary_embedding_does_not_resurrect_deleted_vector(state, service_api, monkeypatch):
    path, row = publish(state, CONVERSATION, SECRET, 1)
    svc, _ = service_api()
    svc.indexer.run(now_ms=FAR_FUTURE)
    _, sid = seed_summary(svc, KEY, SECRET)
    svc.vstore.delete_summaries([sid])
    svc.l2.mark_all_vec_pending()
    original = svc.embedder.embed_docs

    def embed_and_delete(texts):
        assert SECRET in texts[0]
        result = original(texts)
        forget_first(path, row)
        svc.indexer.run(now_ms=FAR_FUTURE)
        return result

    monkeypatch.setattr(svc.embedder, "embed_docs", embed_and_delete)
    assert svc.distiller._fill_vectors() == 0
    assert not svc.vstore.scol.get(where={"key": KEY})["ids"]
    assert not svc.l2.get_summaries(KEY, [sid])


def test_private_channel_partner_is_a_graph_hub(state, service_api):
    private = ["telegram", "41", None, "private", "42", None]
    key = encoded("c1", private)
    publish(state, private, "火锅 privatecontext", 1)
    svc, client = service_api()
    svc.indexer.run(now_ms=FAR_FUTURE)
    _, sid = seed_summary(svc, key, "privatecontext")
    response = client.post("/associate", json={"key": key, "people": [PERSON], "now": int(FAR_FUTURE)})
    assert response.status_code == 200
    assert response.json()["items"] == []
    assert svc.l2.get_summaries(key, [sid])
