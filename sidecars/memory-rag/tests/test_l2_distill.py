"""RAG_PATCH（P3）：L2 存储与提炼层。

全部用临时 state + 假 embedding + `httpx.MockTransport` 假 DeepSeek：
不联网、不读真实 state/、不读写任何密钥（临时 state 下的假值除外）。
"""

from __future__ import annotations

import json
import os
import time
from datetime import timedelta

import httpx
import pytest

from memory_rag.distill import SYSTEM_PROMPT, Distiller, parse_json_loose
from memory_rag.embeddings import EmbeddingUnavailable
from memory_rag.l2 import L2, SELF, hubs_for_key, normalize_name, summary_id_for, text_hash
from memory_rag.service import Service

from conftest import ROOT, T0, FAR_FUTURE, FakeEmbedder, write_archive, write_persona_config

PRIVATE = "private:111"
GROUP = "group:222"
KEY = "sk-test-xxxx"
SUMMARY_WORD_PRIVATE = "紫色的月亮"   # 只出现在私聊摘要里（原文没有）
SUMMARY_WORD_GROUP = "金色的星星"

# 两个会话、各两段话题（中间空 58 分钟 > 30 分钟分段线）；「蓝鲸邮票册」只在私聊，
# 「琥珀胸针」只在群里——遗忘测试靠这两个词判断有没有删干净
PRIVATE_ROWS = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
    (60, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (61, "in", "111", "平安", "蓝鲸邮票册的配色也想好了"),
    (62, "out", None, "", "这版动画脚本结构清楚多了"),
    (63, "in", "111", "平安", "prompt 还要再改吗"),
]
GROUP_ROWS = [
    (0, "in", "333", "老周", "明天开会吗"),
    (1, "in", "111", "平安", "项目要延期了"),
    (2, "out", None, "", "那就先别加班"),
    (60, "in", "333", "老周", "需求又变了"),
    (61, "in", "111", "平安", "琥珀胸针的订单到了"),
    (62, "out", None, "", "先改完再说"),
]


# ---------------------------------------------------------------- 假 DeepSeek


def reply_for(text: str) -> dict:
    """按块原文给一份「看着像模型输出」的 JSON；故意夹带会被丢掉的实体与关系。"""
    ents = [{"name": "我", "type": "person"}]
    for name in ("平安", "阿安"):
        if name in text:
            ents.append({"name": name, "type": "person"})
    word = next((w for w in ("蓝鲸邮票册", "琥珀胸针", "火锅", "提示词", "开会", "项目") if w in text), None)
    if word:
        ents.append({"name": word, "type": "thing"})
    ents.append({"name": "蓝鲸市", "type": "place"})  # 原文里没有：必须被丢掉
    rels = [{"src": "平安", "dst": "不存在的人", "relation": "认识"}]  # 端点不在实体里：丢掉
    if word:
        rels.insert(0, {"src": "平安", "dst": word, "relation": "提到"})
    if "蓝鲸邮票册" in text:
        tail = SUMMARY_WORD_PRIVATE
    elif "琥珀胸针" in text:
        tail = SUMMARY_WORD_GROUP
    else:
        tail = "淡蓝色的海"
    return {"title": "bluetitle" + (word or "日常"),
            "summary": f"聊到了{word or '今天的事'}，还提到{tail}。",
            "importance": 0.6, "valence": 0.2, "entities": ents, "relations": rels}


class FakeDeepSeek:
    """记录每次请求（头、体、块原文），按 `decide` 返回预设内容。"""

    def __init__(self, decide=None, status: int = 200, raw_content: str | None = None):
        self.calls: list[dict] = []
        self.decide = decide
        self.status = status
        self.raw_content = raw_content

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        user = body["messages"][1]["content"]
        text = user.split("【聊天】\n", 1)[-1]
        self.calls.append({"headers": {k.lower(): v for k, v in request.headers.items()},
                           "body": body, "text": text})
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "nope"})
        if self.raw_content is not None:
            content = self.raw_content
        else:
            out = self.decide(text) if self.decide else reply_for(text)
            content = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_cache_hit_tokens": 10, "prompt_cache_miss_tokens": 20, "completion_tokens": 30},
        })

    def transport(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))


def make_distiller(stack, cfg, fake: FakeDeepSeek, embedder=None, now=None) -> Distiller:
    return Distiller(cfg, stack.db, L2(stack.db), stack.vs, embedder or stack.emb,
                     http=fake.transport(), now=now)


def index_both(stack, state) -> None:
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)


def _rag_bytes(root) -> bytes:
    """递归读 rag 目录下每个文件的原始字节（SQLite 空闲页、WAL、Chroma 全算）。"""
    return b"\n".join(p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file())


# ---------------------------------------------------------------- 1. 建表与空库


def test_chunk_db_always_has_l2_tables(state):
    from memory_rag.fts import ChunkDB

    rag = state / "long-memory" / "rag"
    rag.mkdir(parents=True, exist_ok=True)
    db = ChunkDB(rag / "rag.sqlite3")
    names = {r["name"] for r in db.conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','index')")}
    for t in ("summaries", "summaries_fts", "entities", "summary_entities", "relations", "distill_state"):
        assert t in names, t
    assert "idx_summaries_key_time" in names and "idx_se_entity_key" in names

    # L2 为空时删会话、清空都正常
    assert db.delete_key(PRIVATE) == 0
    db.clear()
    assert L2(db).stats() == {"summaries": 0, "pending": 0, "failed": 0, "skipped": 0,
                              "vec_pending": 0, "entities": 0, "relations": 0}


def test_name_helpers():
    assert normalize_name("  平安 ！😀") == "平安"
    assert normalize_name("Blue Whale") == "bluewhale"
    assert summary_id_for("abc", "d") == "S" + __import__("hashlib").sha1(b"abc|d").hexdigest()[:16]
    assert text_hash("x") == text_hash("x") and text_hash("x") != text_hash("y")
    assert hubs_for_key(PRIVATE) == {SELF, "qq:111"}
    assert hubs_for_key(GROUP) == {SELF}


# ---------------------------------------------------------------- 2. 正常提炼


def test_distill_writes_summary_entities_and_vectors(stack, cfg, state):
    index_both(stack, state)
    write_persona_config(state)
    fake = FakeDeepSeek()
    d = make_distiller(stack, cfg, fake)

    out = d.run_once(now_ms=int(FAR_FUTURE))
    assert out["calls"] == 4 and out["ok"] == 4 and out["failed"] == 0, out

    # 摘要落库、块状态与标题回填
    l2 = L2(stack.db)
    sums = stack.db.conn.execute("SELECT * FROM summaries").fetchall()
    assert len(sums) == 4
    for s in sums:
        chunk = stack.db.get([s["chunk_id"]])[s["chunk_id"]]
        assert chunk["distilled"] == "done"
        assert chunk["title"] == s["title"]
        assert s["title"].startswith("bluetitle")
        assert s["text_hash"] == text_hash(chunk["text"])

    # 标题进了块的关键词索引：title 独有的词也能查到这块
    hits = stack.db.bm25(PRIVATE, ["bluetitle"])
    assert [cid for cid, _ in hits] and all(stack.db.get([cid])[cid]["key"] == PRIVATE for cid, _ in hits)

    # 实体：平安 -> qq:111（两个会话共享同一个人）、我 -> self、其它 -> <type>:<norm>
    ents = {r["entity_id"]: dict(r) for r in stack.db.conn.execute("SELECT * FROM entities")}
    assert ents["qq:111"]["name"] == "平安" and ents["qq:111"]["type"] == "person" and ents["qq:111"]["qq"] == "111"
    assert ents[SELF]["type"] == "person" and ents[SELF]["name"] == "我"
    assert "thing:火锅" in ents and ents["thing:火锅"]["norm"] == "火锅"
    assert "place:蓝鲸市" not in ents  # 原文里没有的实体名被丢掉

    # 关系落库，且两端都是留下来的实体、挂在本会话的摘要上
    rels = [dict(r) for r in stack.db.conn.execute("SELECT * FROM relations")]
    assert len(rels) == 4  # 四块各一条 平安 -> 那个东西
    assert {r["relation"] for r in rels} == {"提到"}
    assert all(r["src_id"] == "qq:111" and r["dst_id"].startswith("thing:") for r in rels)
    summary_key = {s["summary_id"]: s["key"] for s in sums}
    assert all(summary_key[r["summary_id"]] == r["key"] for r in rels)

    # summary_entities 带会话 key
    se = stack.db.conn.execute("SELECT DISTINCT key FROM summary_entities").fetchall()
    assert {r["key"] for r in se} == {PRIVATE, GROUP}

    # 摘要向量：只存 key / t_start / t_end，不存 documents
    got = stack.vs.scol.get(include=["documents", "metadatas"])
    assert len(got["ids"]) == 4
    assert all(doc is None for doc in got["documents"])
    for m in got["metadatas"]:
        assert set(m) == {"key", "t_start", "t_end"}
        assert isinstance(m["t_start"], int) and isinstance(m["t_end"], int)
    assert l2.count_vec_done() == 4 and l2.stats()["vec_pending"] == 0

    # 用量：当天 calls / cost 都记上了
    usage = json.loads((cfg["paths"].rag / "distill-usage.json").read_text(encoding="utf-8"))
    today = usage["days"][time.strftime("%Y-%m-%d", time.localtime())]
    assert today["calls"] == 4 and today["ok"] == 4 and today["cost"] > 0
    # SUGGEST_PATCH：当天条目新增三个候选相关计数（接口约定 §1）；这一段没有候选，所以是 0。
    assert set(today) == {"calls", "ok", "failed", "cacheHit", "cacheMiss", "output", "cost",
                          "notes", "notes_dropped", "backfill_calls"}
    assert (today["notes"], today["notes_dropped"], today["backfill_calls"]) == (0, 0, 0)
    # 每次命中 10 / 未命中 20 / 输出 30，四次；价格 0.02 / 1 / 4（元每百万 token）
    assert (today["cacheHit"], today["cacheMiss"], today["output"]) == (40, 80, 120)
    assert today["cost"] == pytest.approx((40 * 0.02 + 80 * 1 + 120 * 4) / 1e6)

    # 请求：Bearer 来自临时密钥文件；体有 response_format / model；system 逐字相同
    assert fake.calls[0]["headers"]["authorization"] == f"Bearer {KEY}"
    assert fake.calls[0]["body"]["response_format"] == {"type": "json_object"}
    assert fake.calls[0]["body"]["model"] == "deepseek-flash"
    systems = {c["body"]["messages"][0]["content"] for c in fake.calls}
    assert systems == {SYSTEM_PROMPT}
    assert all(c["body"]["messages"][0]["role"] == "system" for c in fake.calls)
    # user 里有在场的人（她自己排第一，人物带号码）与块原文
    user = fake.calls[0]["body"]["messages"][1]["content"]
    assert user.startswith("【在场的人】\n我（她自己）\n") and "【聊天】\n" in user
    assert "（111）" in user


def test_l2_read_api_stays_inside_one_key(stack, cfg, state):
    """P2 要用的一整套读接口：每个都按会话隔离，不允许越界。"""
    index_both(stack, state)
    write_persona_config(state)
    make_distiller(stack, cfg, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))
    l2 = L2(stack.db)

    private_sums = stack.db.conn.execute("SELECT * FROM summaries WHERE key=? ORDER BY t_end", (PRIVATE,)).fetchall()
    group_sums = stack.db.conn.execute("SELECT * FROM summaries WHERE key=?", (GROUP,)).fetchall()
    assert len(private_sums) == 2 and len(group_sums) == 2

    s0 = private_sums[0]
    got = l2.get_summaries(PRIVATE, [s0["summary_id"], group_sums[0]["summary_id"]])
    assert set(got) == {s0["summary_id"]}  # 别的会话的 id 不返回
    assert got[s0["summary_id"]]["title"] == s0["title"]
    by_chunk = l2.summaries_by_chunks(PRIVATE, [s0["chunk_id"], group_sums[0]["chunk_id"]])
    assert set(by_chunk) == {s0["chunk_id"]}

    covering = l2.summary_covering(PRIVATE, int(s0["t_start"]))
    assert covering and covering["summary_id"] == s0["summary_id"]
    # 两个会话在同一时刻都有块：拿到的必须是请求的那个会话的
    g0 = l2.summary_covering(GROUP, int(s0["t_start"]))
    assert g0 and g0["key"] == GROUP and g0["summary_id"] != s0["summary_id"]

    ids = [s["summary_id"] for s in private_sums]
    ents = l2.entities_of(PRIVATE, ids + [g["summary_id"] for g in group_sums])
    assert set(ents) <= set(ids) and ents
    assert all(e.startswith(("qq:", "self", "thing:", "person:", "place:", "topic:"))
               for e in sum(ents.values(), []))

    # 文字里直接出现的实体名：两个字的都算，按 norm 长度降序
    assert set(l2.entities_in_text(PRIVATE, "他说平安想吃火锅", min_len=2)) == {"qq:111", "thing:火锅"}
    assert l2.entities_in_text(PRIVATE, "他说平安想吃火锅", min_len=3) == []  # 平安只有两个字
    assert l2.entities_in_text(GROUP, "他说想吃火锅", min_len=2) == []  # 群里没有火锅这条关联

    linked = l2.linked_summaries(PRIVATE, ["qq:111"], exclude_ids=[ids[0]])
    assert set(linked) == {ids[1]} and linked[ids[1]] == ["qq:111"]
    assert l2.linked_summaries(GROUP, ["thing:火锅"]) == {}  # 别的会话的实体走不过来
    assert set(l2.linked_summaries(PRIVATE, ["qq:111"], t_end_lte=int(private_sums[0]["t_end"]))) == {ids[0]}
    assert l2.entity_df(PRIVATE, ["qq:111"]) == {"qq:111": 2}
    assert l2.entity_names(["qq:111", SELF]) == {"qq:111": "平安", SELF: "我"}
    assert l2.count_summaries(PRIVATE) == 2

    hits = l2.bm25_summaries(PRIVATE, ["bluetitle"])
    assert [sid for sid, score in hits] and set(s for s, _ in hits) == set(ids) and hits[0][1] > 0
    assert set(s for s, _ in l2.bm25_summaries(GROUP, ["bluetitle"])) == {g["summary_id"] for g in group_sums}
    assert l2.stats()["summaries"] == 4


# ---------------------------------------------------------------- 3. 校验与重试


def test_validation_retry_backoff_then_failed(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)

    fake = FakeDeepSeek(decide=lambda text: {"title": "x", "summary": "太短"})
    d = make_distiller(stack, cfg, fake)
    base = int(FAR_FUTURE)

    out = d.run_once(now_ms=base)
    assert out["failed"] == 2 and out["ok"] == 0
    chunk_id = stack.db.conn.execute("SELECT chunk_id FROM chunks ORDER BY t_end LIMIT 1").fetchone()["chunk_id"]
    row = stack.db.conn.execute("SELECT * FROM distill_state WHERE chunk_id=?", (chunk_id,)).fetchone()
    assert row["attempts"] == 1 and row["next_at"] == base + 10 * 60_000
    assert row["last_error"] == "invalid fields"

    # 10 分钟后重试：第 2 次失败改成 1 小时
    out2 = d.run_once(now_ms=base + 10 * 60_000 + 1)
    assert out2["failed"] == 2
    row = stack.db.conn.execute("SELECT * FROM distill_state WHERE chunk_id=?", (chunk_id,)).fetchone()
    assert row["attempts"] == 2 and row["next_at"] == base + 10 * 60_000 + 1 + 60 * 60_000

    # 第 3 次失败：块标 failed，不再自动重试
    out3 = d.run_once(now_ms=base + 10 * 60_000 + 60 * 60_000 + 2)
    assert out3["failed"] == 2
    assert stack.db.get([chunk_id])[chunk_id]["distilled"] == "failed"
    assert d.run_once(now_ms=base + 10 * 7 * 60_000)["calls"] == 0

    # 手动重试：回到 pending、清掉重试状态
    assert d.retry_failed() == 2
    assert stack.db.get([chunk_id])[chunk_id]["distilled"] == "pending"
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM distill_state").fetchone()["n"] == 0


def test_entities_and_relations_are_filtered(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])  # 只有一个块，方便看计数
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    fake = FakeDeepSeek()
    out = make_distiller(stack, cfg, fake).run_once(now_ms=int(FAR_FUTURE))
    # 「蓝鲸市」不在原文里；「不存在的人」不在实体里
    assert out["entities_dropped"] == 1 and out["relations_dropped"] == 1
    ents = {r["entity_id"] for r in stack.db.conn.execute("SELECT entity_id FROM entities")}
    assert ents == {SELF, "qq:111", "thing:火锅"}


def test_invalid_json_is_a_failure(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    fake = FakeDeepSeek(raw_content="我觉得这段聊天没什么好说的。")
    d = make_distiller(stack, cfg, fake)
    out = d.run_once(now_ms=int(FAR_FUTURE))
    assert out["failed"] == 1 and d.last_error == "invalid json"


def test_http_error_is_a_failure(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    fake = FakeDeepSeek(status=401)
    d = make_distiller(stack, cfg, fake)
    out = d.run_once(now_ms=int(FAR_FUTURE))
    assert out["failed"] == 1 and d.last_error == "http 401"


def test_parse_json_loose_accepts_fence_and_prose():
    assert parse_json_loose('{"a": 1}') == {"a": 1}
    assert parse_json_loose('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_loose('好的：{"a": 1} 以上') == {"a": 1}
    assert parse_json_loose("不是 JSON") is None


# ---------------------------------------------------------------- 4. 太短的块


def test_short_chunk_is_skipped_without_a_request(stack, cfg, state):
    write_archive(state, PRIVATE, [(0, "in", "111", "平安", "嗯"), (1, "out", None, "", "哦"), (2, "in", "111", "平安", "好")])
    write_archive(state, GROUP, [(100, "in", "111", "平安", "今天真是漫长的一天啊")])  # 只有一条：n_msgs < 2
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    fake = FakeDeepSeek()
    out = make_distiller(stack, cfg, fake).run_once(now_ms=int(FAR_FUTURE))
    assert out["skipped"] == 2 and out["calls"] == 0
    assert fake.calls == []
    states = {r["distilled"] for r in stack.db.conn.execute("SELECT distilled FROM chunks")}
    assert states == {"skipped"}


# ---------------------------------------------------------------- 5. 日上限


def test_daily_limit_is_shared_across_restarts(stack, cfg, state):
    cfg["distill"]["daily_limit"] = 2
    index_both(stack, state)
    write_persona_config(state)

    fake = FakeDeepSeek()
    out = make_distiller(stack, cfg, fake).run_once(now_ms=int(FAR_FUTURE))
    assert out["calls"] == 2 and len(fake.calls) == 2
    assert L2(stack.db).stats()["pending"] == 2  # 另外两块留到明天

    # 新建一个 Distiller（模拟重启）：当天已经用了 2 次，不再调用
    fake2 = FakeDeepSeek()
    out2 = make_distiller(stack, cfg, fake2).run_once(now_ms=int(FAR_FUTURE) + 1)
    assert out2["calls"] == 0 and fake2.calls == []


# ---------------------------------------------------------------- 6. 密钥


def test_no_key_means_no_request(stack, cfg, state, monkeypatch):
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    fake = FakeDeepSeek()
    d = make_distiller(stack, cfg, fake)
    assert d.status()["key"] is False
    assert d.run_once(now_ms=int(FAR_FUTURE))["calls"] == 0 and fake.calls == []

    # 空 apiKey 也不行
    write_persona_config(state, api_key="")
    assert d.run_once(now_ms=int(FAR_FUTURE))["calls"] == 0 and fake.calls == []

    # 环境变量里的密钥绝不能被读到
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-env")
    assert d.run_once(now_ms=int(FAR_FUTURE))["calls"] == 0 and fake.calls == []
    assert d.status()["key"] is False


def test_key_is_read_from_temp_file_and_never_logged(stack, cfg, state, capsys):
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state, api_key="sk-local-only")
    fake = FakeDeepSeek()
    d = make_distiller(stack, cfg, fake)
    d.run_once(now_ms=int(FAR_FUTURE))
    assert fake.calls[0]["headers"]["authorization"] == "Bearer sk-local-only"
    captured = capsys.readouterr()
    assert "sk-local-only" not in captured.out + captured.err


# ---------------------------------------------------------------- 7. 不重复花钱


def test_rebuild_reuses_summaries_and_only_redistills_changed_chunks(stack, cfg, state):
    index_both(stack, state)
    write_persona_config(state)
    fake = FakeDeepSeek()
    d = make_distiller(stack, cfg, fake)
    assert d.run_once(now_ms=int(FAR_FUTURE))["ok"] == 4
    assert len(fake.calls) == 4
    old_ids = {r["summary_id"] for r in stack.db.conn.execute("SELECT summary_id FROM summaries")}

    # 全量重建：原文没变 -> 一块都不调模型，摘要全部挂回、标题回填
    stack.indexer.reset()
    stack.indexer.run(now_ms=FAR_FUTURE)
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM summaries").fetchone()["n"] == 4  # L2 保留
    fake2 = FakeDeepSeek()
    out = make_distiller(stack, cfg, fake2).run_once(now_ms=int(FAR_FUTURE))
    assert fake2.calls == [] and out["calls"] == 0
    assert out["reconciled"] == 0
    assert {r["summary_id"] for r in stack.db.conn.execute("SELECT summary_id FROM summaries")} == old_ids
    titles = {r["title"] for r in stack.db.conn.execute("SELECT title FROM chunks")}
    assert titles and all(t.startswith("bluetitle") for t in titles)
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM chunks WHERE distilled='done'").fetchone()["n"] == 4

    # 改账本称呼 -> 块原文变了 -> 这些块重新提炼，旧摘要连同向量一起删掉
    people = state / "long-memory" / "people.json"
    people.write_text(json.dumps({"version": 1, "people": {"111": {"name": "阿安"}}}, ensure_ascii=False),
                      encoding="utf-8")
    st = people.stat()
    os.utime(people, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))

    stack.indexer.reset()
    stack.indexer.run(now_ms=FAR_FUTURE)
    assert "阿安" in stack.db.conn.execute("SELECT text FROM chunks LIMIT 1").fetchone()["text"]

    fake3 = FakeDeepSeek()
    out3 = make_distiller(stack, cfg, fake3).run_once(now_ms=int(FAR_FUTURE))
    assert out3["reconciled"] == 4  # 四块原文都带称呼，全部对不上
    assert out3["calls"] == 4 and out3["ok"] == 4
    new_ids = {r["summary_id"] for r in stack.db.conn.execute("SELECT summary_id FROM summaries")}
    assert new_ids.isdisjoint(old_ids)
    # 旧摘要的向量也不在了（只剩新的 4 条）
    assert stack.vs.scol.count() == 4
    assert set(stack.vs.scol.get()["ids"]) == new_ids


# ---------------------------------------------------------------- 8. 遗忘


def test_forget_key_removes_l2_and_leaves_group_alone(stack, cfg, state):
    index_both(stack, state)
    write_persona_config(state)
    d = make_distiller(stack, cfg, FakeDeepSeek())
    assert d.run_once(now_ms=int(FAR_FUTURE))["ok"] == 4

    l2 = L2(stack.db)
    assert l2.count_summaries(PRIVATE) == 2 and l2.count_summaries(GROUP) == 2
    private_ids = {r["summary_id"] for r in stack.db.conn.execute("SELECT summary_id FROM summaries WHERE key=?", (PRIVATE,))}
    assert private_ids
    # 造两条提炼进度：私聊的那条要跟着块一起删，群里的留着（删 chunks 之前必须先删它）
    priv_chunk = stack.db.conn.execute("SELECT chunk_id FROM chunks WHERE key=? LIMIT 1", (PRIVATE,)).fetchone()["chunk_id"]
    group_chunk = stack.db.conn.execute("SELECT chunk_id FROM chunks WHERE key=? LIMIT 1", (GROUP,)).fetchone()["chunk_id"]
    for cid in (priv_chunk, group_chunk):
        stack.db.conn.execute("INSERT INTO distill_state(chunk_id, attempts, next_at, last_error) VALUES (?,1,0,'')", (cid,))
    stack.db.conn.commit()

    stack.indexer.forget_key(PRIVATE)

    q = lambda sql, *a: stack.db.conn.execute(sql, a).fetchall()  # noqa: E731
    assert l2.count_summaries(PRIVATE) == 0
    assert q("SELECT COUNT(*) AS n FROM summaries_fts WHERE summary_id IN (SELECT summary_id FROM summaries WHERE key=?)", PRIVATE)[0]["n"] == 0
    assert q("SELECT COUNT(*) AS n FROM summary_entities WHERE key=?", PRIVATE)[0]["n"] == 0
    assert q("SELECT COUNT(*) AS n FROM relations WHERE key=?", PRIVATE)[0]["n"] == 0
    left = {r["chunk_id"] for r in q("SELECT chunk_id FROM distill_state")}
    assert left == {group_chunk}
    # 群会话不受影响
    assert l2.count_summaries(GROUP) == 2
    assert q("SELECT COUNT(*) AS n FROM relations WHERE key=?", GROUP)[0]["n"] == 2
    # 只出现在私聊的实体（孤儿）删掉；qq:111 群里还挂着，保留
    ents = {r["entity_id"] for r in q("SELECT entity_id FROM entities")}
    assert "thing:蓝鲸邮票册" not in ents and "thing:火锅" not in ents
    assert "qq:111" in ents and SELF in ents
    # 摘要向量也删了
    got = stack.vs.scol.get()
    assert got["ids"] and all(m["key"] == GROUP for m in got["metadatas"])

    blob = _rag_bytes(cfg["paths"].rag)
    for word in (SUMMARY_WORD_PRIVATE, "蓝鲸邮票册"):
        assert word.encode("utf-8") not in blob, f"遗忘后派生库里仍能读到 {word}"
    # 阴性对照：群里的东西还在
    assert SUMMARY_WORD_GROUP.encode("utf-8") in blob


# ---------------------------------------------------------------- 9. 竞态


def test_chunk_forgotten_while_calling_model_is_dropped_not_failed(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)

    def decide(text):
        # 调模型的这几十秒里，桥接把这个会话忘了
        stack.indexer.forget_key(PRIVATE)
        return reply_for(text)

    d = make_distiller(stack, cfg, FakeDeepSeek(decide=decide))
    out = d.run_once(now_ms=int(FAR_FUTURE))
    assert out["calls"] == 1 and out["dropped"] == 1 and out["failed"] == 0
    assert L2(stack.db).stats()["summaries"] == 0
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"] == 0


# ---------------------------------------------------------------- 10. 摘要向量待补


class FlakyEmbedder(FakeEmbedder):
    def __init__(self):
        super().__init__()
        self.broken = True

    def embed_docs(self, texts):
        if self.broken:
            raise EmbeddingUnavailable("假 embedding 挂了")
        return super().embed_docs(texts)


def test_embedding_down_writes_summary_then_backfills(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)

    flaky = FlakyEmbedder()
    d = make_distiller(stack, cfg, FakeDeepSeek(), embedder=flaky)
    out = d.run_once(now_ms=int(FAR_FUTURE))
    assert out["ok"] == 1 and out["vectors"] == 0
    l2 = L2(stack.db)
    assert l2.count_summaries(PRIVATE) == 1 and l2.stats()["vec_pending"] == 1

    flaky.broken = False
    out2 = d.run_once(now_ms=int(FAR_FUTURE) + 1)
    assert out2["vectors"] == 1 and l2.stats()["vec_pending"] == 0 and stack.vs.scol.count() == 1


def test_missing_summaries_collection_marks_all_pending(stack, cfg, state, monkeypatch):
    index_both(stack, state)
    write_persona_config(state)
    make_distiller(stack, cfg, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))
    l2 = L2(stack.db)
    assert l2.count_vec_done() == 4

    from memory_rag.store import VectorStore
    stack.vs.client.delete_collection("summaries")
    VectorStore(cfg["paths"].rag / "chroma", stack.emb.model_id, stack.emb.dim)

    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    assert svc.l2 is not None
    assert svc.l2.count_vec_done() == 0 and svc.l2.stats()["vec_pending"] == 4


# ---------------------------------------------------------------- 11. health


def test_health_distill_shape_and_no_secrets(stack, cfg, state, monkeypatch):
    index_both(stack, state)
    write_persona_config(state)
    make_distiller(stack, cfg, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))

    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    health = svc.health()
    d = health["distill"]
    # SUGGEST_PATCH：多了账本建议的计数（接口约定 §1）
    assert set(d) == {"enabled", "key", "model", "summaries", "pending", "failed", "skipped",
                      "vec_pending", "entities", "relations", "notes", "today", "daily_limit", "last_error"}
    assert set(d["notes"]) == {"total", "queued", "failed"}
    assert d["key"] is True and d["model"] == "deepseek-flash" and d["enabled"] is True
    assert set(d["today"]) == {"calls", "ok", "failed", "cost"}
    assert d["summaries"] == 4

    dumped = json.dumps(health, ensure_ascii=False)
    assert KEY not in dumped
    for word in (SUMMARY_WORD_PRIVATE, SUMMARY_WORD_GROUP, "蓝鲸邮票册", "重庆火锅"):
        assert word not in dumped

    # 口径可注入的 Service 也有这个字段（假 embedding 没有 base_url）
    assert health["embedding"]["url"] is None


# ---------------------------------------------------------------- 12. 日志里没有原文


def test_logs_contain_no_source_or_summary_text(stack, cfg, state, capsys):
    index_both(stack, state)
    write_persona_config(state)
    d = make_distiller(stack, cfg, FakeDeepSeek(decide=lambda text: reply_for(text)))
    d.run_once(now_ms=int(FAR_FUTURE))
    # 再跑一次失败路径：日志只该有块编号、计数与错误类别
    d2 = make_distiller(stack, cfg, FakeDeepSeek(status=401))
    d2.run_once(now_ms=int(FAR_FUTURE))
    captured = capsys.readouterr()
    blob = captured.out + captured.err
    for word in ("蓝鲸邮票册", "重庆火锅", "紫色的月亮", "金色的星星", "蓝鲸市", KEY):
        assert word not in blob, word


# ---------------------------------------------------------------- 13. RAG_PATCH（P3）返工
# 输出上限（deepseek-flash 的思考 token 也计入 completion_tokens）、成功口径、关系里的「我」。


def _usage_today(cfg) -> dict:
    usage = json.loads((cfg["paths"].rag / "distill-usage.json").read_text(encoding="utf-8"))
    return usage["days"][time.strftime("%Y-%m-%d", time.localtime())]


def _raw_client(content: str, finish_reason: str | None = None) -> httpx.Client:
    """只回一个固定 content 的假 DeepSeek；可以指定 finish_reason（模拟被截断）。"""
    usage = {"prompt_cache_hit_tokens": 10, "prompt_cache_miss_tokens": 20, "completion_tokens": 30}

    def handle(request: httpx.Request) -> httpx.Response:
        choice: dict = {"message": {"content": content}}
        if finish_reason is not None:
            choice["finish_reason"] = finish_reason
        return httpx.Response(200, json={"choices": [choice], "usage": usage})

    return httpx.Client(transport=httpx.MockTransport(handle))


def _distiller_with_client(stack, cfg, client: httpx.Client) -> Distiller:
    return Distiller(cfg, stack.db, L2(stack.db), stack.vs, stack.emb, http=client)


def test_request_max_tokens_follows_config_and_is_clamped(stack, cfg, state):
    """RAG_PATCH（P3）：缺省 1500；配置照用；离谱的值夹到 200～4000。"""
    write_persona_config(state)
    chunk = {"text": "2026-10-01 20:00 平安：下周想去白云山看日出",
             "speaker_names": "平安", "speakers": "111"}

    def sent_max_tokens() -> int:
        fake = FakeDeepSeek()
        d = make_distiller(stack, cfg, fake)
        assert d._call(chunk, KEY, "https://api.deepseek.com", "deepseek-flash")[1] is None
        return fake.calls[0]["body"]["max_tokens"]

    assert sent_max_tokens() == 1500  # config.yml 里的默认值
    cfg["distill"]["max_tokens"] = 300
    assert sent_max_tokens() == 300
    cfg["distill"]["max_tokens"] = 99999
    assert sent_max_tokens() == 4000
    cfg["distill"].pop("max_tokens")
    assert sent_max_tokens() == 1500


def test_truncated_output_is_a_failure_but_still_costs_tokens(stack, cfg, state):
    """RAG_PATCH（P3）：finish_reason=length -> 块失败、错误类别 truncated；token 照样记账。"""
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    client = _raw_client('{"title": "半个标题", "summary": "还没写完', finish_reason="length")
    d = _distiller_with_client(stack, cfg, client)

    out = d.run_once(now_ms=int(FAR_FUTURE))
    assert out["calls"] == 1 and out["failed"] == 1 and out["ok"] == 0
    assert d.last_error == "truncated"
    row = stack.db.conn.execute("SELECT * FROM distill_state").fetchone()
    assert row["last_error"] == "truncated" and row["attempts"] == 1

    today = _usage_today(cfg)
    assert today["calls"] == 1 and today["failed"] == 1 and today["ok"] == 0
    assert today["output"] == 30 and today["cost"] > 0  # 钱确实花了，token 要照记


def test_2xx_with_prose_counts_as_failed_not_ok(stack, cfg, state):
    """RAG_PATCH（P3）：2xx 但内容不是 JSON -> 失败，不能算进当天的「成功」。"""
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    d = _distiller_with_client(stack, cfg, _raw_client("抱歉，我不能帮你做这件事。"))

    out = d.run_once(now_ms=int(FAR_FUTURE))
    assert out["calls"] == 1 and out["failed"] == 1 and out["ok"] == 0
    assert d.last_error == "invalid json"

    today = _usage_today(cfg)
    assert today["calls"] == 1 and today["failed"] == 1 and today["ok"] == 0
    assert today["output"] == 30


def test_valid_reply_counts_as_ok(stack, cfg, state):
    """RAG_PATCH（P3）：真正拿到合格 JSON 才算成功。"""
    write_archive(state, PRIVATE, PRIVATE_ROWS[:3])
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    out = make_distiller(stack, cfg, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))
    assert out["ok"] == 1 and out["failed"] == 0

    today = _usage_today(cfg)
    assert today["calls"] == 1 and today["ok"] == 1 and today["failed"] == 0
    assert today["output"] == 30 and today["cost"] > 0


SELF_ROWS = [
    (0, "in", "111", "平安", "下周想去白云山看日出"),
    (1, "in", "111", "平安", "早上四点就得起床"),
    (2, "out", None, "", "好啊，我陪你去"),
]


def _self_relation_reply(src: str) -> dict:
    """模型常见写法：entities 里只列得出白云山，关系里却写「我」/她的别名。"""
    return {"title": "想去白云山",
            "summary": "平安说想去白云山看日出，她答应陪着一起去。",
            "importance": 0.5, "valence": 0.3,
            "entities": [{"name": "白云山", "type": "place"}],
            "relations": [{"src": src, "dst": "白云山", "relation": "想去"}]}


def _assert_self_relation(stack, cfg) -> None:
    rels = [dict(r) for r in stack.db.conn.execute("SELECT * FROM relations")]
    assert len(rels) == 1
    assert rels[0]["src_id"] == SELF and rels[0]["dst_id"] == "place:白云山"
    sid = stack.db.conn.execute("SELECT summary_id FROM summaries").fetchone()["summary_id"]
    assert rels[0]["summary_id"] == sid
    se = {r["entity_id"] for r in
          stack.db.conn.execute("SELECT entity_id FROM summary_entities WHERE summary_id=?", (sid,))}
    assert SELF in se  # 关系里出现了「我」，实体列表里就补上 self
    ents = {r["entity_id"]: dict(r) for r in stack.db.conn.execute("SELECT * FROM entities")}
    assert ents[SELF]["type"] == "person" and ents[SELF]["name"] == "我"
    today = _usage_today(cfg)
    assert today["calls"] == 1 and today["ok"] == 1


def test_relation_to_self_without_entity_is_kept(stack, cfg, state):
    """RAG_PATCH（P3）：entities 里没有「我」，关系里的「我」也要映射到 self，不计 dropped。"""
    write_archive(state, PRIVATE, SELF_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    fake = FakeDeepSeek(decide=lambda text: _self_relation_reply("我"))

    out = make_distiller(stack, cfg, fake).run_once(now_ms=int(FAR_FUTURE))
    assert out["ok"] == 1 and out["relations_dropped"] == 0, out
    _assert_self_relation(stack, cfg)


def test_self_alias_in_relation_maps_to_self(stack, cfg, state):
    """RAG_PATCH（P3）：self_names 里的别名（如「小鲸鱼」）出现在关系里同样落到 self。"""
    cfg["distill"]["self_names"] = ["小鲸鱼"]
    write_archive(state, PRIVATE, SELF_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    fake = FakeDeepSeek(decide=lambda text: _self_relation_reply("小鲸鱼"))

    out = make_distiller(stack, cfg, fake).run_once(now_ms=int(FAR_FUTURE))
    assert out["ok"] == 1 and out["relations_dropped"] == 0, out
    _assert_self_relation(stack, cfg)
