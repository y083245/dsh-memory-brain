import json

import pytest

from memory_rag.fts import add_words, query_tokens, tokenize

from conftest import FAR_FUTURE, write_archive

PRIVATE = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
    (3, "in", "111", "平安", "排就排呗，好久没吃了"),
    (60, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (61, "out", None, "", "这版动画脚本结构清楚多了"),
    (62, "in", "111", "平安", "prompt 还要再改吗"),
]
GROUP = [
    (0, "in", "333", "老周", "明天开会吗"),
    (1, "in", "444", "糖糖", "项目要延期了"),
    (2, "out", None, "", "那就先别加班"),
]


@pytest.fixture
def indexed(stack, state):
    write_archive(state, "private:111", PRIVATE)
    write_archive(state, "group:222", GROUP)
    stack.indexer.run(now_ms=FAR_FUTURE)
    return stack


def test_index_and_watermark_are_idempotent(indexed, state):
    s = indexed
    n = s.db.stats()["chunks"]
    assert n >= 3 and s.vs.count() == n
    wm = s.indexer.watermarks()
    assert set(wm) == {"private:111", "group:222"}
    # 再跑一次不会重复入库
    assert s.indexer.run(now_ms=FAR_FUTURE)["chunks"] == 0
    # 崩溃重放：水位丢了，从头重来也只是覆盖同一批块 ID
    (s.cfg["paths"].rag / "watermarks.json").unlink()
    s.indexer.run(now_ms=FAR_FUTURE)
    assert s.db.stats()["chunks"] == n and s.vs.count() == n


def test_new_rows_and_new_month_file(indexed, state):
    s = indexed
    before = s.db.stats()["chunks"]
    write_archive(state, "private:111", [(24 * 60 * 31, "in", "111", "平安", "下个月见"), (24 * 60 * 31 + 1, "out", None, "", "好"),
                                         (24 * 60 * 31 + 2, "in", "111", "平安", "拜拜")], month="2026-11")
    s.indexer.run(now_ms=FAR_FUTURE + 40 * 86400_000)
    after = s.db.stats()["chunks"]
    assert after == before + 1
    assert s.indexer.watermarks()["private:111"]["file"] == "private_111/2026-11.jsonl"


def test_open_segment_is_pending_not_indexed(stack, state):
    write_archive(state, "private:111", PRIVATE)
    last_t = stack.indexer.pending_rows("private:111")[-1].t
    stack.indexer.run(now_ms=last_t + 5 * 60_000)
    pend = stack.indexer.pending_rows("private:111")
    assert [r.text for r in pend] == [r[4] for r in PRIVATE[4:]]
    # 进行中的消息仍能被关键词找到（临时打分兜底）
    res = stack.searcher.search("private:111", "", ["蝴蝶效应"], debug=True)
    assert any(i.startswith("pending:") for it in res["items"] for i in it["ids"])


def test_bm25_partial_or_match(indexed):
    res = indexed.searcher.search("private:111", "", ["火锅", "烧烤", "不存在的词"], routes=("bm25",), debug=True)
    assert res["items"] and "重庆火锅" in res["items"][0]["text"]


def test_jieba_custom_words_are_not_split():
    add_words(["阿哲"])
    assert "阿哲" in tokenize("阿哲说今天加班")
    toks = query_tokens("他之前说想吃什么", ["火锅", "23 年"])
    assert "火锅" in toks and "23年" in toks and "他" not in toks and "什么" not in toks


def test_group_cannot_see_private(indexed):
    s = indexed
    res = s.searcher.search("group:222", "蝴蝶效应的提示词", ["蝴蝶效应", "prompt", "火锅"], debug=True)
    ids = [i for it in res["items"] for i in it["ids"]]
    meta = s.db.get([i for i in ids if not i.startswith("pending:")])
    assert all(m["key"] == "group:222" for m in meta.values())
    assert all("蝴蝶效应" not in it["text"] and "火锅" not in it["text"] for it in res["items"])
    # 两路各自也都隔离
    assert s.db.bm25("group:222", ["蝴蝶效应", "火锅"]) == []
    for cid, _ in s.vs.query("group:222", s.emb.embed_query("蝴蝶效应 提示词 火锅"), 20):
        assert s.db.get([cid])[cid]["key"] == "group:222"


def test_key_is_required(indexed):
    with pytest.raises(ValueError):
        indexed.searcher.search("", "火锅")
    with pytest.raises(ValueError):
        indexed.db.bm25("", ["火锅"])
    with pytest.raises(ValueError):
        indexed.vs.query("", indexed.emb.embed_query("火锅"))


def test_expansion_stays_inside_the_segment(indexed):
    res = indexed.searcher.search("private:111", "提示词", ["蝴蝶效应"], expand=3)
    hit = [it for it in res["items"] if "蝴蝶效应" in it["text"]][0]
    # 30 分钟前的火锅那段不能被扩进来
    assert "火锅" not in hit["text"]


def test_items_do_not_overlap_and_fit_budget(indexed):
    res = indexed.searcher.search("private:111", "火锅 提示词", ["火锅", "蝴蝶效应", "加班", "prompt"], expand=3)
    spans = [(it["line_start"], it["line_end"]) for it in res["items"]]
    assert all(a[1] < b[0] for a, b in zip(spans, spans[1:]))  # 按时间排序且不重叠
    assert sum(len(it["text"]) for it in res["items"]) <= indexed.searcher.max_chars


def test_vector_route_finds_paraphrase(indexed):
    res = indexed.searcher.search("private:111", "他说想去吃什么", [], routes=("vector",), debug=True)
    assert res["items"] and "火锅" in res["items"][0]["text"]
