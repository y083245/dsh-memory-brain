"""RAG_PATCH（P3）：检索四路（③ 摘要向量、④ 关系图）、自动想起、联想链与控制台接口。

L2 数据全部用 P1 的接口手写（`l2.pending_chunks` → 手写 result → `l2.write_summary`），不调模型、
不联网；摘要向量用 conftest 的假 embedding 补。HTTP 测试与 `test_forget_rebuild.py` 同一套做法：
**import `memory_rag.app` 之前**把 `MEMORY_RAG_STATE_DIR` 指到临时目录，import 完立刻还回去。

覆盖：图谱路有用、摘要路、会话隔离、枢纽点、recall 的跳过 / 时间窗 / 门槛、associate 的排除与 via、
四个新接口的形状与 400 / 遗忘请求处理。
"""

from __future__ import annotations

import os
import tempfile
from datetime import timedelta

_ORIG_STATE_DIR = os.environ.get("MEMORY_RAG_STATE_DIR")
_IMPORT_STATE = tempfile.mkdtemp(prefix="memory-rag-recall-")
os.environ["MEMORY_RAG_STATE_DIR"] = _IMPORT_STATE

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from memory_rag import app as app_module  # noqa: E402
from memory_rag.l2 import L2, SELF, hubs_for_key, normalize_name  # noqa: E402
from memory_rag.recall import associate, normalize_text, recall, summaries  # noqa: E402
from memory_rag.service import Service  # noqa: E402

# 模块级 Service() 已经建好，把环境变量还回去，别影响 conftest 的 cfg fixture
if _ORIG_STATE_DIR is None:
    os.environ.pop("MEMORY_RAG_STATE_DIR", None)
else:
    os.environ["MEMORY_RAG_STATE_DIR"] = _ORIG_STATE_DIR

from conftest import (  # noqa: E402  （顺序有意为之：环境变量要先设置）
    FAR_FUTURE, ROOT, T0, FakeEmbedder, write_archive, write_forget_request,
)

PRIVATE = "private:111"
GROUP = "group:900"


# ---------------------------------------------------------------- 造 L2 数据的小工具


def e(eid: str, name: str, etype: str | None = None, qq: str | None = None) -> dict:
    """手写一个「已解析」的实体（与 distill.py 的 _resolve 输出同形状）。"""
    if eid == SELF:
        etype = etype or "person"
    elif eid.startswith("qq:"):
        etype, qq = "person", qq or eid[3:]
    return {"entity_id": eid, "type": etype or "thing", "name": name,
            "norm": normalize_name(name), "qq": qq}


def sres(title: str, summary: str, entities=()) -> dict:
    """手写一份「已校验」的提炼结果：只填 write_summary 用到的字段。"""
    return {"title": title, "summary": summary, "importance": 0.4, "valence": 0.0,
            "entities": list(entities), "relations": []}


def parts(obj):
    """stack（有 emb / vs）与 Service（有 embedder / vstore）都能用。"""
    emb = getattr(obj, "embedder", None) or getattr(obj, "emb", None)
    vs = getattr(obj, "vstore", None) or getattr(obj, "vs", None)
    l2 = getattr(obj, "l2", None) or L2(obj.db)
    return emb, vs, l2


def distill(obj, now_ms: float, spec: list[tuple[str, dict]]) -> dict:
    """给每个块手写一条摘要（spec 按块原文里的特征词匹配），返回 {特征词: (summary_id, chunk_id)}。"""
    _, _, l2 = parts(obj)
    out: dict[str, tuple[str, str]] = {}
    for ch in l2.pending_chunks(int(now_ms), 100):
        for word, res in spec:
            if word in ch["text"]:
                sid = l2.write_summary(ch["chunk_id"], ch["text_hash"], res, "test", int(now_ms))
                if sid:
                    out[word] = (sid, ch["chunk_id"])
                break
    return out


def fill_vectors(obj) -> None:
    """摘要向量 = embed_docs(f"{title}：{summary}")，与提炼线程同一口径。"""
    emb, vs, l2 = parts(obj)
    items = l2.need_vectors(100)
    if not items:
        return
    vecs = emb.embed_docs([f"{it['title']}：{it['summary']}" for it in items])
    vs.upsert_summaries([it["summary_id"] for it in items], vecs,
                        [{"key": it["key"], "t_start": it["t_start"], "t_end": it["t_end"]} for it in items])
    l2.mark_vec_done([it["summary_id"] for it in items])


def svc_of(obj):
    """给 recall() / associate() / summaries() 用时，属性名与 Service 保持一致。"""
    emb, vs, l2 = parts(obj)

    class S:
        pass

    s = S()
    s.cfg, s.embedder, s.vstore, s.l2 = obj.cfg, emb, vs, l2
    return s


def t_ms(minutes: float = 0) -> int:
    return int((T0 + timedelta(minutes=minutes)).timestamp() * 1000)


def chunk_of(db, word: str) -> str:
    row = db.conn.execute("SELECT chunk_id FROM chunks WHERE text LIKE ?", (f"%{word}%",)).fetchone()
    assert row is not None, f"没有包含「{word}」的块"
    return str(row["chunk_id"])


# ---------------------------------------------------------------- 1. 关系图路有用

GRAPH_ROWS = [
    # 块 A：平安提到朋友小王（下面四段是只提到「朋友」的填充块，用来把 B 挤出前 5 名）
    (0, "in", "111", "平安", "我朋友小王下周要来"),
    (1, "in", "111", "平安", "他说想在这边找工作"),
    (2, "out", None, "", "那挺好的呀"),
    # 块 B：只提小王，不提平安（都是她自己的发言）
    (120, "out", None, "", "小王在深圳搞设计已经很多年"),
    (121, "out", None, "", "他打算明年回老家发展"),
    (122, "out", None, "", "到时候我们再聚一聚"),
    (240, "in", "111", "平安", "我朋友最近也说想过来玩"),
    (241, "in", "111", "平安", "朋友多了热闹"),
    (242, "out", None, "", "是呀"),
    (360, "in", "111", "平安", "我朋友那边天气还不错"),
    (361, "in", "111", "平安", "朋友说他下周休息"),
    (362, "out", None, "", "挺好"),
    (480, "in", "111", "平安", "我朋友问我借了本书"),
    (481, "in", "111", "平安", "朋友看得挺快"),
    (482, "out", None, "", "嗯"),
    (600, "in", "111", "平安", "我朋友发来了照片"),
    (601, "in", "111", "平安", "朋友说有空一起吃饭"),
    (602, "out", None, "", "好呀"),
]


def test_graph_route_reaches_the_linked_chunk(stack, state):
    write_archive(state, PRIVATE, GRAPH_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("小王下周要来", sres("朋友要来", "平安说他朋友小王下周要来",
                            [e("qq:111", "平安"), e("person:小王", "小王", "person")])),
        ("小王在深圳", sres("小王近况", "小王在深圳做设计已经很多年", [e("person:小王", "小王", "person")])),
        ("我朋友最近", sres("朋友来玩", "平安的朋友最近也想来玩", [e("qq:111", "平安")])),
        ("我朋友那边", sres("朋友那边天气", "平安的朋友那边天气不错", [e("qq:111", "平安")])),
        ("我朋友问我", sres("朋友借书", "平安的朋友问他借了本书", [e("qq:111", "平安")])),
        ("我朋友发来", sres("朋友发照片", "平安的朋友发来了照片", [e("qq:111", "平安")])),
    ])
    fill_vectors(stack)
    assert set(made) == {"小王下周要来", "小王在深圳", "我朋友最近", "我朋友那边", "我朋友问我", "我朋友发来"}
    b_chunk = made["小王在深圳"][1]

    res = stack.searcher.search(PRIVATE, "平安的朋友是做什么的", [],
                                routes=("vector", "bm25", "pending", "graph"), debug=True)
    assert "graph" in res["routes"] and res["routes"]["graph"] >= 1

    # B 只能在关系图这一路出现（它不提「平安」也不提「朋友」，不会进 BM25；向量噪声让它排不进前 5 名）
    hit = next(r for r in res["ranked"] if r["id"] == b_chunk)
    assert "graph" in hit["sources"], hit["sources"]
    assert any("小王在深圳" in it["text"] for it in res["items"])


# ---------------------------------------------------------------- 2. 摘要路

SUMMARY_ROWS = [
    (0, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (1, "in", "111", "平安", "排队也没关系"),
    (2, "out", None, "", "那就早点去"),
]


def test_summary_route_finds_the_chunk(stack, state):
    write_archive(state, PRIVATE, SUMMARY_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("重庆火锅", sres("周末吃火锅", "平安说周末想去吃那家重庆火锅",
                        [e("qq:111", "平安"), e("thing:火锅", "重庆火锅")])),
    ])
    fill_vectors(stack)

    res = stack.searcher.search(PRIVATE, "重庆火锅", [], routes=("summary",), debug=True)
    assert res["routes"].get("summary") == 1
    assert [i for it in res["items"] for i in it["ids"]] == [made["重庆火锅"][1]]
    assert any("重庆火锅" in it["text"] for it in res["items"])

    # 缺省五路里也有它
    res5 = stack.searcher.search(PRIVATE, "重庆火锅", [], debug=True)
    assert "summary" in res5["routes"]


# ---------------------------------------------------------------- 3. 会话隔离

ISO_PRIVATE_ROWS = [
    (0, "in", "111", "平安", "今晚想吃火锅"),
    (1, "in", "111", "平安", "那家店排队好久"),
    (2, "out", None, "", "早点去"),
]
ISO_GROUP_ROWS = [
    (0, "in", "111", "平安", "群里也在说火锅"),
    (1, "in", "111", "平安", "火锅店新开了一家"),
    (2, "out", None, "", "改天去尝尝"),
]


@pytest.fixture
def isolated(stack, state):
    write_archive(state, PRIVATE, ISO_PRIVATE_ROWS)
    write_archive(state, GROUP, ISO_GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("今晚想吃火锅", sres("私聊火锅", "平安说今晚想吃火锅",
                          [e("qq:111", "平安"), e("thing:火锅", "火锅")])),
        ("群里也在说火锅", sres("群里火锅", "群里也在聊火锅",
                          [e("qq:111", "平安"), e("thing:火锅", "火锅")])),
    ])
    fill_vectors(stack)
    return stack, made


def test_private_key_cannot_see_group_l2(isolated):
    stack, made = isolated
    svc = svc_of(stack)
    private_sid, private_chunk = made["今晚想吃火锅"]
    group_sid, group_chunk = made["群里也在说火锅"]

    res = stack.searcher.search(PRIVATE, "火锅", ["火锅"], debug=True)
    assert res["items"]
    ids = [i for it in res["items"] for i in it["ids"] if not i.startswith("pending:")]
    meta = stack.db.get(ids)
    assert meta and all(m["key"] == PRIVATE for m in meta.values())
    assert all("群里" not in it["text"] for it in res["items"])

    got = recall(svc, PRIVATE, ["还想吃火锅吗"], k=2, now_ms=int(FAR_FUTURE))
    assert got["skipped"] is None and got["candidates"]
    assert all(c["summary_id"] != group_sid for c in got["candidates"])
    assert all(c["summary_id"] in {private_sid} for c in got["candidates"])
    assert got["inject"] == [private_sid]

    assoc = associate(svc, PRIVATE, text="火锅", k=5, now_ms=int(FAR_FUTURE))
    assert all(it["summary_id"] != group_sid for it in assoc["items"])

    # 把群里的摘要编号塞进去：拿不到就返回空
    got2 = summaries(svc, PRIVATE, [group_sid, private_sid, "S不存在"])
    assert [it["summary_id"] for it in got2["items"]] == [private_sid]
    # 群会话自己查它，能拿到
    got3 = summaries(svc, GROUP, [group_sid])
    assert [it["summary_id"] for it in got3["items"]] == [group_sid]
    assert group_chunk != private_chunk


# ---------------------------------------------------------------- 4. 枢纽点

HUB_PRIVATE_ROWS = [
    (0, "in", "111", "平安", "今天天气不错"),
    (1, "in", "111", "平安", "外面有点风"),
    (2, "out", None, "", "是呀"),
    (120, "in", "111", "平安", "我刚才在看书"),
    (121, "in", "111", "平安", "那本书挺厚"),
    (122, "out", None, "", "慢慢看"),
]
HUB_GROUP_ROWS = [
    (0, "in", "111", "平安", "群里今天挺安静"),
    (1, "in", "111", "平安", "大家都忙"),
    (2, "out", None, "", "是啊"),
    (120, "in", "111", "平安", "刚才有人发了个链接"),
    (121, "in", "111", "平安", "点开看了挺有意思"),
    (122, "out", None, "", "回头看看"),
]


def test_hubs_are_not_bridges(stack, state):
    """私聊里对方本人是枢纽点：只靠他连起来的两条摘要不能互相联想；群会话只有 self 是枢纽。"""
    svc = svc_of(stack)
    write_archive(state, PRIVATE, HUB_PRIVATE_ROWS)
    write_archive(state, GROUP, HUB_GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    distill(stack, FAR_FUTURE, [
        ("今天天气不错", sres("天气", "说今天天气不错", [e("qq:111", "平安"), e(SELF, "我")])),
        ("我刚才在看书", sres("看书", "刚才在看书", [e("qq:111", "平安"), e(SELF, "我")])),
        # RAG_PATCH（P3）：两条各挂一个独有实体。联想链要求候选带出种子之外的新实体，
        # 只挂 qq:111 的摘要会被过滤掉；这里要保持「群里能顺着 qq:111 连到另一条」的覆盖。
        ("群里今天挺安静", sres("群里安静", "群里今天挺安静",
                          [e("qq:111", "平安"), e(SELF, "我"), e("thing:排队", "排队")])),
        ("刚才有人发了", sres("群里链接", "有人发了个链接",
                          [e("qq:111", "平安"), e(SELF, "我"), e("thing:天冷", "天冷")])),
    ])
    fill_vectors(stack)

    assert hubs_for_key(PRIVATE) == {SELF, "qq:111"}
    # 私聊：种子 qq:111 被当成枢纽点去掉 → 没有种子
    assert associate(svc, PRIVATE, people=["111"], k=5, now_ms=int(FAR_FUTURE))["items"] == []
    # 群会话：只有 self 是枢纽，qq:111 是有信息量的 → 能联想到另一条
    got = associate(svc, GROUP, people=["111"], k=5, now_ms=int(FAR_FUTURE))
    assert len(got["items"]) == 2
    assert all("平安" in it["via"] for it in got["items"])


# ---------------------------------------------------------------- 5. recall

def test_recall_skips_trivial_and_empty(stack, state):
    write_archive(state, PRIVATE, SUMMARY_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    svc = svc_of(stack)

    # 本会话还没有摘要（但来信不是废话）：no_summaries
    got = recall(svc, PRIVATE, ["还想吃火锅吗"], now_ms=int(FAR_FUTURE))
    assert got["skipped"] == "no_summaries" and got["candidates"] == [] and got["inject"] == []

    # 全是短句 / 停用句：trivial（在摘要之前就判掉）
    got = recall(svc, PRIVATE, ["在吗", "哈哈", "嗯"], now_ms=int(FAR_FUTURE))
    assert got["skipped"] == "trivial"
    assert got["candidates"] == [] and got["inject"] == []
    stack.cfg["recall"]["stopwords"] = ["今天好吗"]  # 长度够、但在停用表里
    got = recall(svc, PRIVATE, ["今天好吗"], now_ms=int(FAR_FUTURE))
    assert got["skipped"] == "trivial"
    assert normalize_text("  在吗！！😀 ") == "在吗"


RECENT_ROWS = [
    (0, "in", "111", "平安", "今天好饿想吃火锅"),
    (1, "in", "111", "平安", "那家店排队好久"),
    (2, "out", None, "", "早点去"),
    (1380, "in", "111", "平安", "半夜又想吃火锅了"),
    (1381, "in", "111", "平安", "宵夜就吃火锅吧"),
    (1382, "out", None, "", "好呀"),
]


def test_recall_excludes_recent_and_applies_tau(stack, state):
    write_archive(state, PRIVATE, RECENT_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("今天好饿想吃火锅", sres("周末火锅", "平安说想吃火锅",
                            [e("qq:111", "平安"), e("thing:火锅", "火锅")])),
        ("半夜又想吃火锅", sres("夜宵火锅", "宵夜也吃火锅",
                            [e("qq:111", "平安"), e("thing:火锅", "火锅")])),
    ])
    fill_vectors(stack)
    svc = svc_of(stack)
    old_sid = made["今天好饿想吃火锅"][0]
    recent_sid = made["半夜又想吃火锅"][0]
    now = t_ms(24 * 60)  # T0 之后 24 小时：12 小时的排除线在 T0+12h

    got = recall(svc, PRIVATE, ["今天好饿想吃火锅"], k=2, now_ms=now)
    assert got["skipped"] is None
    assert {c["summary_id"] for c in got["candidates"]} == {old_sid}
    cand = got["candidates"][0]
    assert cand["pass"] is True and cand["cosine"] >= stack.cfg["recall"]["tau"]
    assert set(cand["signals"]) >= {"vector", "bm25"}
    assert got["inject"] == [old_sid]
    assert recent_sid not in got["inject"]

    # tau 调高到不可能：一条都不通过
    stack.cfg["recall"]["tau"] = 2.0
    got = recall(svc, PRIVATE, ["今天好饿想吃火锅"], k=2, now_ms=now)
    assert got["tau"] == 2.0
    assert all(c["pass"] is False for c in got["candidates"]) and got["inject"] == []

    # tau 调低：过门槛只看「两路命中」，inject 不超过 k
    stack.cfg["recall"]["tau"] = 0.0
    got = recall(svc, PRIVATE, ["今天好饿想吃火锅"], k=1, now_ms=now)
    assert got["inject"] == [old_sid]
    assert all(c["pass"] == (len(c["signals"]) >= 2) for c in got["candidates"])


TWO_SIGNAL_ROWS = [
    (0, "in", "111", "平安", "今天好饿想吃火锅"),
    (1, "in", "111", "平安", "那家店排队好久"),
    (2, "out", None, "", "早点去"),
    (120, "in", "111", "平安", "那家店排队到半夜"),
    (121, "in", "111", "平安", "上次也是这样"),
    (122, "out", None, "", "别提了"),
]


def test_recall_pass_needs_cosine_and_two_signals(stack, state):
    write_archive(state, PRIVATE, TWO_SIGNAL_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("今天好饿想吃火锅", sres("周末火锅", "周末想吃重庆火锅",
                            [e("qq:111", "平安"), e("thing:火锅", "火锅")])),
        # 摘要里一个查询词都没有：只可能走进向量路
        ("排队到半夜", sres("餐厅排队", "那家餐厅上次排队到半夜", [e("qq:111", "平安")])),
    ])
    fill_vectors(stack)
    svc = svc_of(stack)
    a_sid, b_sid = made["今天好饿想吃火锅"][0], made["排队到半夜"][0]

    got = recall(svc, PRIVATE, ["今天好饿想吃火锅"], k=2, now_ms=int(FAR_FUTURE))
    by_id = {c["summary_id"]: c for c in got["candidates"]}
    assert set(by_id) == {a_sid, b_sid}
    assert set(by_id[a_sid]["signals"]) >= {"vector", "bm25"}
    assert by_id[a_sid]["pass"] is True
    assert by_id[b_sid]["signals"] == ["vector"]
    assert by_id[b_sid]["cosine"] is not None  # 意思够近，但只有一路命中
    assert by_id[b_sid]["pass"] is False
    assert got["inject"] == [a_sid]

    # 每条候选都自洽：pass ⇔ 余弦过线 且 至少两路
    tau = got["tau"]
    for c in got["candidates"]:
        assert c["pass"] == (c["cosine"] is not None and c["cosine"] >= tau and len(c["signals"]) >= 2)


# ---------------------------------------------------------------- 6. associate

ASSOC_ROWS = [
    (0, "in", "111", "平安", "今晚想吃火锅"),
    (1, "in", "111", "平安", "好久没吃了"),
    (2, "out", None, "", "走起"),
    (120, "in", "111", "平安", "那家火锅店人真多"),
    (121, "in", "111", "平安", "等了一个小时"),
    (122, "out", None, "", "下次早点"),
    (240, "in", "111", "平安", "明天还想吃火锅"),
    (241, "in", "111", "平安", "可以换一家"),
    (242, "out", None, "", "行"),
    (4320, "in", "111", "平安", "最近又想吃火锅了"),
    (4321, "in", "111", "平安", "天冷了"),
    (4322, "out", None, "", "是啊"),
]


@pytest.fixture
def assoc(stack, state):
    write_archive(state, PRIVATE, ASSOC_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        # RAG_PATCH（P3）：联想链要求候选带出种子之外的新实体，下面几条各挂一个独有实体，
        # 否则只共享「火锅」的摘要会被过滤掉，覆盖 / 时间窗 / exclude 就没法观察了。
        ("今晚想吃火锅", sres("第一次火锅", "平安说今晚想吃火锅",
                          [e("qq:111", "平安"), e("thing:火锅", "火锅"), e("thing:火锅店", "火锅店")])),
        # 同一条摘要里还有另一个人：via 要显示账本称呼，不是实体编号
        ("那家火锅店人真多", sres("排队火锅", "火锅店排了一个小时，小夏也在",
                            [e("qq:111", "平安"), e("thing:火锅", "火锅"), e("qq:100000002", "小夏")])),
        ("明天还想吃火锅", sres("明天火锅", "平安说明天还想吃火锅",
                          [e("qq:111", "平安"), e("thing:火锅", "火锅"), e("thing:排队", "排队")])),
        ("最近又想吃火锅", sres("天冷火锅", "天冷了又想吃火锅",
                          [e("qq:111", "平安"), e("thing:火锅", "火锅"), e("thing:天冷", "天冷")])),
    ])
    fill_vectors(stack)
    return svc_of(stack), made


def test_associate_excludes_covering_exclude_and_too_recent(assoc):
    svc, made = assoc
    s1, s2 = made["今晚想吃火锅"][0], made["那家火锅店人真多"][0]
    s3, s4 = made["明天还想吃火锅"][0], made["最近又想吃火锅"][0]
    now = t_ms(5 * 24 * 60)  # T0 之后 5 天

    # 覆盖 t 的那条要排除；min_age_days=2 把第 3 天的那条排除在外
    got = associate(svc, PRIVATE, text="火锅", t=t_ms(0), k=5, now_ms=now)
    sids = [it["summary_id"] for it in got["items"]]
    assert set(sids) == {s2, s3}
    assert all(it["score"] > 0 for it in got["items"])
    assert all("火锅" in it["via"] for it in got["items"])

    # min_age_days=0：刚过线的那条也能被联想
    got = associate(svc, PRIVATE, text="火锅", t=t_ms(0), min_age_days=0, k=5, now_ms=now)
    assert s4 in [it["summary_id"] for it in got["items"]]

    # exclude 生效
    got = associate(svc, PRIVATE, text="火锅", exclude=[s2], min_age_days=0, k=5, now_ms=now)
    sids = [it["summary_id"] for it in got["items"]]
    assert s2 not in sids and set(sids) == {s1, s3, s4}

    # via 是显示名（账本称呼），不是实体编号
    got = associate(svc, PRIVATE, people=["100000002"], k=5, now_ms=now)
    assert [it["summary_id"] for it in got["items"]] == [s2]
    assert got["items"][0]["via"] == ["小夏"]

    # 没有种子：空列表，不是错误
    assert associate(svc, PRIVATE, now_ms=now)["items"] == []


# ---------------------------------------------------------------- 7. HTTP

@pytest.fixture
def service(monkeypatch, state):
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    assert svc.cfg["paths"].state == state
    assert str(svc.cfg["paths"].state).startswith(tempfile.gettempdir())
    return svc


@pytest.fixture
def client(monkeypatch, service):
    monkeypatch.setattr(app_module, "svc", service)
    return TestClient(app_module.app)


def seed_http(service, state) -> dict:
    write_archive(state, PRIVATE, ISO_PRIVATE_ROWS)
    write_archive(state, GROUP, ISO_GROUP_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    made = distill(service, FAR_FUTURE, [
        ("今晚想吃火锅", sres("私聊火锅", "平安说今晚想吃火锅",
                          [e("qq:111", "平安"), e("thing:火锅", "火锅")])),
        ("群里也在说火锅", sres("群里火锅", "群里也在聊火锅",
                          [e("qq:111", "平安"), e("thing:火锅", "火锅")])),
    ])
    fill_vectors(service)
    return made


def test_http_recall_associate_summaries_shapes(client, service, state):
    made = seed_http(service, state)
    private_sid = made["今晚想吃火锅"][0]
    group_sid = made["群里也在说火锅"][0]

    r = client.post("/recall", json={"key": PRIVATE, "texts": ["还想吃火锅吗"], "k": 1,
                                     "now": int(FAR_FUTURE)})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"key", "skipped", "tau", "candidates", "inject"}
    assert body["key"] == PRIVATE and body["skipped"] is None
    assert isinstance(body["tau"], float)
    assert len(body["candidates"]) <= 5
    for c in body["candidates"]:
        assert set(c) == {"summary_id", "chunk_id", "day", "t_end", "title", "summary",
                          "cosine", "bm25_rank", "graph", "signals", "pass"}
    assert len(body["inject"]) <= 1
    assert set(body["inject"]) <= {c["summary_id"] for c in body["candidates"] if c["pass"]}

    r = client.post("/associate", json={"key": PRIVATE, "text": "火锅", "k": 2})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"key", "items"}
    for it in body["items"]:
        assert set(it) == {"summary_id", "day", "t_end", "title", "summary", "score", "via"}
        assert len(it["via"]) <= 3

    r = client.post("/summaries", json={"key": PRIVATE, "ids": [private_sid, group_sid, "S不存在"]})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"key", "items"}
    assert [it["summary_id"] for it in body["items"]] == [private_sid]
    assert set(body["items"][0]) == {"summary_id", "day", "title", "summary"}

    # 422 不合法请求体由 pydantic 挡；key 不合法是 400
    for path in ("/recall", "/associate", "/summaries"):
        assert client.post(path, json={"key": "不是 key"}).status_code == 400, path
        assert client.post(path, json={"key": ""}).status_code == 400, path


def test_http_distill_retry(client, service, state):
    made = seed_http(service, state)
    chunk_id = made["今晚想吃火锅"][1]
    assert client.post("/distill/retry", json={}).json() == {"ok": True, "retried": 0}

    service.db.conn.execute("UPDATE chunks SET distilled='failed' WHERE chunk_id=?", (chunk_id,))
    service.db.conn.commit()
    r = client.post("/distill/retry", json={})
    assert r.status_code == 200 and r.json() == {"ok": True, "retried": 1}
    assert service.db.get([chunk_id])[chunk_id]["distilled"] == "pending"


def test_http_recall_processes_forget_request_first(client, service, state):
    made = seed_http(service, state)
    private_sid = made["今晚想吃火锅"][0]
    req = write_forget_request(state, PRIVATE, 1234)

    r = client.post("/recall", json={"key": PRIVATE, "texts": ["还想吃火锅吗"], "now": int(FAR_FUTURE)})
    assert r.status_code in (200, 503)
    body = r.json()
    if r.status_code == 200:
        # 已删会话的摘要一条都不能返回
        assert body["skipped"] in (None, "no_summaries")
        assert all(c["summary_id"] != private_sid for c in body["candidates"])
        assert private_sid not in body["inject"]
    assert not req.exists()  # 遗忘请求被处理掉了
    assert service.l2.count_summaries(PRIVATE) == 0
    # 别的会话不受影响
    assert service.l2.count_summaries(GROUP) == 1


def test_http_recall_503_when_lock_held(client, service, state):
    seed_http(service, state)
    req = write_forget_request(state, PRIVATE, 4321)
    service.indexer.lock.acquire()
    try:
        r = client.post("/recall", json={"key": PRIVATE, "texts": ["还想吃火锅吗"]})
    finally:
        service.indexer.lock.release()
    assert r.status_code == 503
    assert r.json()["detail"] == "该会话有待处理的遗忘请求，稍后再试"
    assert req.exists()


# ---------------------------------------------------------------- 8. RAG_PATCH（P3）：联想链要带出新东西

ASSOC_R2_ROWS = [
    (0, "in", "111", "阿青", "阿青说橘猫大福要减肥"),
    (1, "in", "111", "阿青", "医生让它每天只吃两顿"),
    (2, "out", None, "", "可怜的大福"),
    (120, "in", "111", "阿青", "大福生日那天阿青给它买了小鱼干"),
    (121, "in", "111", "阿青", "它吃得可开心了"),
    (122, "out", None, "", "真幸福"),
]


def test_associate_drops_summary_with_no_new_entity(stack, state):
    """种子和候选除了种子实体以外没有共同点：候选没有新实体 → 整条丢掉。"""
    write_archive(state, PRIVATE, ASSOC_R2_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    distill(stack, FAR_FUTURE, [
        ("橘猫大福", sres("大福减肥", "阿青说她妈养的橘猫大福最近胖了，医生让每天只吃两顿",
                         [e("qq:111", "阿青"), e("thing:大福", "大福"), e("thing:橘猫", "橘猫")])),
    ])
    fill_vectors(stack)
    got = associate(svc_of(stack), PRIVATE, text="阿青说橘猫大福要减肥", k=3, now_ms=int(FAR_FUTURE))
    assert got["items"] == []


def test_associate_keeps_summary_with_new_entity(stack, state):
    """另一条摘要除了种子实体还挂着「小鱼干」→ 带出了新东西，保留，via 给账本显示名。"""
    write_archive(state, PRIVATE, ASSOC_R2_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("橘猫大福", sres("大福减肥", "阿青说她妈养的橘猫大福最近胖了，医生让每天只吃两顿",
                         [e("qq:111", "阿青"), e("thing:大福", "大福"), e("thing:橘猫", "橘猫")])),
        ("小鱼干", sres("大福生日", "大福生日那天阿青给它买了小鱼干",
                       [e("qq:111", "阿青"), e("thing:大福", "大福"), e("thing:小鱼干", "小鱼干")])),
    ])
    fill_vectors(stack)
    got = associate(svc_of(stack), PRIVATE, text="阿青说橘猫大福要减肥", k=3, now_ms=int(FAR_FUTURE))
    assert [it["summary_id"] for it in got["items"]] == [made["小鱼干"][0]]
    assert "大福" in got["items"][0]["via"]


ASSOC_R2_ROWS2 = [
    (0, "in", "111", "阿青", "阿青说小王周末约她去爬白云山，早上六点出发"),
    (1, "in", "111", "阿青", "她还带上了新买的相机"),
    (2, "out", None, "", "拍得好看"),
    (120, "in", "111", "阿青", "阿青面试通过要请小王吃饭感谢内推"),
    (121, "in", "111", "阿青", "她说这顿饭必须请"),
    (122, "out", None, "", "恭喜"),
]


def test_associate_drops_reworded_same_event(stack, state):
    """A 有独有实体「相机」能过 (a)，但种子的大多数字都在它里面（≥ 0.6）→ 讲的还是同一件事，丢掉；
    B 只共享小王，另有「内推」→ 保留。"""
    write_archive(state, PRIVATE, ASSOC_R2_ROWS2)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("爬白云山", sres("约爬白云山", "阿青说小王周末约她去爬白云山，早上六点出发",
                        [e("qq:111", "阿青"), e("person:小王", "小王", "person"),
                         e("thing:白云山", "白云山"), e("thing:相机", "相机")])),
        ("面试通过", sres("请吃饭", "阿青面试通过要请小王吃饭感谢内推",
                        [e("qq:111", "阿青"), e("person:小王", "小王", "person"), e("thing:内推", "内推")])),
    ])
    fill_vectors(stack)
    got = associate(svc_of(stack), PRIVATE, text="小王约阿青去爬白云山", k=3, now_ms=int(FAR_FUTURE))
    assert [it["summary_id"] for it in got["items"]] == [made["面试通过"][0]]


ASSOC_R2_ROWS3 = [
    (0, "in", "111", "阿青", "阿青养了只小猫"),
    (1, "in", "111", "阿青", "小猫特别黏人"),
    (2, "out", None, "", "真可爱"),
    (120, "in", "111", "阿青", "阿青最近在学吉他"),
    (121, "in", "111", "阿青", "弹得还不错"),
    (122, "out", None, "", "继续加油"),
]


def test_associate_empty_text_skips_overlap_check_but_keeps_new_entity_filter(stack, state):
    """只给 people、没有种子文字时 (b) 不生效，(a) 照旧：只挂种子的那条丢，另有「吉他」的保留。"""
    write_archive(state, GROUP, ASSOC_R2_ROWS3)
    stack.indexer.run(now_ms=FAR_FUTURE)
    made = distill(stack, FAR_FUTURE, [
        ("养了只小猫", sres("小猫", "阿青养了只小猫，特别黏人", [e("qq:111", "阿青")])),
        ("在学吉他", sres("吉他", "阿青最近在学吉他", [e("qq:111", "阿青"), e("thing:吉他", "吉他")])),
    ])
    fill_vectors(stack)
    got = associate(svc_of(stack), GROUP, people=["111"], k=3, now_ms=int(FAR_FUTURE))
    assert [it["summary_id"] for it in got["items"]] == [made["在学吉他"][0]]
