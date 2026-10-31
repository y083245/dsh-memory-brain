from memory_rag.archive import NameBook, read_rows
from memory_rag.embeddings import truncate_normalize
from memory_rag.segmenter import Segmenter, chunk_id, closed_segments, depth_scores, split_segments

import numpy as np

from conftest import FakeEmbedder, write_archive


def _rows(state, key, spec):
    write_archive(state, key, spec)
    return read_rows(state / "long-memory" / "archive", key)


def _seg(cfg, state):
    names = NameBook(cfg["paths"].people, cfg["paths"].archive)
    return Segmenter(cfg["segmenter"], FakeEmbedder(), names)


def test_time_gap_splits_segments(state):
    rows = _rows(state, "private:111", [(0, "in", "111", "平安", "在吗"), (1, "out", None, "", "在"), (2, "in", "111", "平安", "好"),
                                        (40, "in", "111", "平安", "我回来了")])
    segs = split_segments(rows, 30 * 60_000)
    assert [len(s) for s in segs] == [3, 1]


def test_last_segment_stays_open_until_30_minutes_pass(state):
    rows = _rows(state, "private:111", [(0, "in", "111", "平安", "a"), (5, "in", "111", "平安", "b")])
    last = rows[-1].t
    closed, open_seg = closed_segments(rows, last + 10 * 60_000, 30 * 60_000)
    assert closed == [] and len(open_seg) == 2
    closed, open_seg = closed_segments(rows, last + 31 * 60_000, 30 * 60_000)
    assert len(closed) == 1 and open_seg == []


def test_topic_shift_is_cut(cfg, state):
    food = ["今天好饿", "想吃火锅", "那家火锅排队好久", "毛肚要多点", "吃完去哪", "饭后散步"]
    work = ["明天要加班", "项目又改需求", "老板开会说的", "上班好累", "需求改了三遍", "开会到九点"]
    spec = [(i, "in" if i % 2 == 0 else "out", "111" if i % 2 == 0 else None, "平安" if i % 2 == 0 else "", t)
            for i, t in enumerate(food + work)]
    rows = _rows(state, "private:111", spec)
    chunks = _seg(cfg, state).chunk_segment(rows)
    assert len(chunks) == 2
    assert [len(c.rows) for c in chunks] == [6, 6]
    assert chunks[0].cut_reason == "time_gap" and chunks[1].cut_reason == "topic_shift"


def test_small_pieces_are_merged(cfg, state):
    texts = ["想吃火锅", "饿了", "明天加班", "项目好多", "老板开会", "需求改了", "上班累", "开会开会"]
    rows = _rows(state, "private:111", [(i, "in", "111", "平安", t) for i, t in enumerate(texts)])
    chunks = _seg(cfg, state).chunk_segment(rows)
    assert all(len(c.rows) >= 3 for c in chunks)
    assert sum(len(c.rows) for c in chunks) == len(texts)


def test_long_segment_is_split_by_size(cfg, state):
    rows = _rows(state, "private:111", [(i, "in", "111", "平安", f"火锅第{i}次") for i in range(20)])
    chunks = _seg(cfg, state).chunk_segment(rows)
    assert all(3 <= len(c.rows) <= 15 for c in chunks)
    assert "size_limit" in {c.cut_reason for c in chunks}


def test_one_long_message_does_not_produce_tiny_chunks(cfg, state):
    rows = _rows(state, "private:111", [(0, "in", "111", "平安", "看看提示词"), (1, "in", "111", "平安", "提示词" * 400), (2, "out", None, "", "收到")])
    chunks = _seg(cfg, state).chunk_segment(rows)
    assert len(chunks) == 1


def test_fixed_name_and_deterministic_id(cfg, state):
    # 同一个 QQ 号前后用了不同的群名片：块里统一用账本名「平安」
    rows = _rows(state, "group:222", [(0, "in", "111", "平安在加班", "好饿"), (1, "in", "111", "平安·下班了", "去吃火锅"), (2, "out", None, "", "带我")])
    s = _seg(cfg, state)
    c = s.chunk_segment(rows)[0]
    assert "平安在加班" not in c.text and c.text.count("平安：") == 2 and "我：带我" in c.text
    assert c.speakers == ["111"] and c.speaker_names == ["平安"]
    assert c.id == chunk_id("group:222", rows) == s.chunk_segment(rows)[0].id


def test_depth_scores_find_the_valley():
    d = depth_scores([0.9, 0.85, 0.3, 0.8, 0.9])
    assert int(np.argmax(d)) == 2 and d[2] > 0.5


def test_truncate_normalize():
    m = np.array([[3.0, 4.0, 100.0], [0.0, 0.0, 1.0]])
    out = truncate_normalize(m, 2)
    assert out.shape == (2, 2)
    assert np.allclose(np.linalg.norm(out[0]), 1.0) and np.allclose(out[0], [0.6, 0.8])
    assert np.allclose(out[1], [0.0, 0.0])  # 截断后全零的行不除零
