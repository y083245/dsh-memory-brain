"""SUGGEST_PATCH：账本建议（LEDGER_SUGGEST_SPEC §3）——提炼时抽候选、存储与级联、回补、读接口。

全部用临时 state + 假 embedding + `httpx.MockTransport` 假 DeepSeek：不联网、不读真实 state/、
不读写任何密钥（临时 state 下的假值除外）。HTTP 测试与 `test_forget_rebuild.py` 同一套做法：
**import `memory_rag.app` 之前**把 `MEMORY_RAG_STATE_DIR` 指到临时目录，import 完立刻还回去。
"""

from __future__ import annotations

import importlib
import json
import os
import re
import tempfile
import time
from datetime import timedelta

_ORIG_STATE_DIR = os.environ.get("MEMORY_RAG_STATE_DIR")
_IMPORT_STATE = tempfile.mkdtemp(prefix="memory-rag-notes-")
os.environ["MEMORY_RAG_STATE_DIR"] = _IMPORT_STATE

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import memory_rag.distill as distill_module  # noqa: E402
from memory_rag import app as app_module  # noqa: E402
from memory_rag.distill import SYSTEM_PROMPT, Distiller, validate_notes  # noqa: E402
from memory_rag.l2 import L2, note_id_for, normalize_name, text_hash  # noqa: E402
from memory_rag.service import Service  # noqa: E402

# 模块级 Service() 已经建好，把环境变量还回去，别影响 conftest 的 cfg fixture
if _ORIG_STATE_DIR is None:
    os.environ.pop("MEMORY_RAG_STATE_DIR", None)
else:
    os.environ["MEMORY_RAG_STATE_DIR"] = _ORIG_STATE_DIR

from conftest import (  # noqa: E402  （顺序有意为之：环境变量要先设置）
    FAR_FUTURE, ROOT, T0, FakeEmbedder, close_rag, write_archive, write_persona_config,
)

PRIVATE = "private:111"
GROUP = "group:222"
NOTE_TEXT = "平安说周六中午一起去吃那家重庆火锅"

PRIVATE_ROWS = [
    (0, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (1, "in", "111", "平安", "排队也没关系"),
    (2, "out", None, "", "那就早点去"),
]
GROUP_ROWS = [
    (0, "in", "333", "老周", "明天开会吗"),
    (1, "in", "333", "老周", "项目要延期了"),
    (2, "out", None, "", "那就先别加班"),
]


# ---------------------------------------------------------------- 假 DeepSeek


def _speakers(user: str) -> list[str]:
    """从 `_user_content` 的【在场的人】里取出 QQ 号（「我（她自己）」没有号，自然不在里面）。"""
    head = user.split("【聊天】", 1)[0]
    return re.findall(r"（(\d+)）", head)


def _reply(text: str, speakers=()) -> dict:
    """一份「看着像模型输出」的 JSON：摘要合格，带一条关于某个在场的人的候选。"""
    who = speakers[0] if speakers else "111"
    if "火锅" in text or "提示词" in text:
        note = {"who": who, "cat": "pending", "text": NOTE_TEXT, "due": "2026-11-01"}
    elif "考完" in text:
        note = {"who": who, "cat": "pending", "text": "平安说下周五考完试来找我玩", "due": "2026-11-06"}
    else:
        note = {"who": who, "cat": "trait", "text": "老周喜欢下班后去江边散步", "due": None}
    return {"title": "周末吃火锅", "summary": "平安说周末想去吃那家重庆火锅，排队也没关系。",
            "importance": 0.6, "valence": 0.2,
            "entities": [{"name": "平安", "type": "person"}, {"name": "重庆火锅", "type": "thing"}],
            "relations": [{"src": "平安", "dst": "重庆火锅", "relation": "想吃"}],
            "notes": [note]}


class FakeDeepSeek:
    """按块原文回一份预设 JSON；`decide(text, n)` 可以按第几次调用换内容。"""

    def __init__(self, decide=None, status: int = 200):
        self.calls: list[dict] = []
        self.decide = decide
        self.status = status

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        user = body["messages"][1]["content"]
        text = user.split("【聊天】\n", 1)[-1]
        self.calls.append({"body": body, "text": text})
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "nope"})
        out = self.decide(text, len(self.calls)) if self.decide else _reply(text, _speakers(user))
        content = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_cache_hit_tokens": 10, "prompt_cache_miss_tokens": 20, "completion_tokens": 30},
        })

    def transport(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))


def make_distiller(cfg, stack_or_svc, fake: FakeDeepSeek, now=None) -> Distiller:
    """stack 与 Service 都能用（db / vstore / embedder 的属性名不同）。"""
    db = getattr(stack_or_svc, "db")
    vs = getattr(stack_or_svc, "vstore", None) or getattr(stack_or_svc, "vs")
    emb = getattr(stack_or_svc, "embedder", None) or getattr(stack_or_svc, "emb")
    return Distiller(cfg, db, L2(db), vs, emb, http=fake.transport(), now=now)


def distill_rows(state, stack, rows, fake: FakeDeepSeek):
    write_archive(state, PRIVATE, rows)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    return make_distiller(stack.cfg, stack, fake).run_once(now_ms=int(FAR_FUTURE))


def notes_of(stack, key: str = PRIVATE) -> list[dict]:
    return L2(stack.db).notes(key, 0, 200)


def _entity(eid: str, name: str, etype: str = "person", qq: str | None = None) -> dict:
    return {"entity_id": eid, "type": etype, "name": name, "qq": qq, "norm": normalize_name(name)}


def _res(title: str, summary: str, ents=()) -> dict:
    return {"title": title, "summary": summary, "importance": 0.4, "valence": 0.0,
            "entities": list(ents), "relations": []}


def write_summary_for(stack, word: str, res: dict, now=FAR_FUTURE) -> tuple[str, str]:
    """给包含 word 的那块手写一条摘要（不调模型）。返回 (summary_id, chunk_id)。"""
    l2 = L2(stack.db)
    for ch in l2.pending_chunks(int(now), 100):
        if word in ch["text"]:
            sid = l2.write_summary(ch["chunk_id"], ch["text_hash"], res, "test", int(now))
            assert sid
            return sid, ch["chunk_id"]
    raise AssertionError(f"没有包含「{word}」的块")


@pytest.fixture
def service(monkeypatch, state):
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    assert svc.cfg["paths"].state == state
    assert str(svc.cfg["paths"].state).startswith(tempfile.gettempdir())
    yield svc
    # SUGGEST_PATCH：Service 里的 Chroma 客户端和 SQLite 连接用完要关，否则句柄随用例累积
    close_rag(svc)


@pytest.fixture
def make_service(monkeypatch, state):
    """SUGGEST_PATCH：用例里按需自建 Service 时用，结束统一释放（同 service 夹具）。"""
    made = []

    def _make() -> Service:
        monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
        svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
        made.append(svc)
        return svc

    yield _make
    for svc in reversed(made):
        close_rag(svc)


# ---------------------------------------------------------------- 1. 提示词


def test_system_prompt_has_notes_rule_and_is_stable():
    prompt = distill_module.SYSTEM_PROMPT
    for word in ("notes", "who", "pending", "0～3 条", "不能是她自己"):
        assert word in prompt, word
    # 规则 12 排在 11 之后（前缀缓存靠逐字稳定）
    assert prompt.index("11. relations") < prompt.index("12. notes")
    # 两次 import 结果逐字相同
    assert importlib.reload(distill_module).SYSTEM_PROMPT == prompt


# ---------------------------------------------------------------- 2. 校验


CHUNK = {"speakers": "111,333", "speaker_names": "平安,老周"}


def _note(**kw) -> dict:
    base = {"who": "111", "cat": "trait", "text": "平安喜欢下班后去江边散步", "due": None}
    base.update(kw)
    return base


def test_validate_notes_drops_bad_items_without_failing():
    # who：不在发言人里 / 空 / 非数字
    for who in ("999", "", "abc", "111.0"):
        notes, dropped = validate_notes([_note(who=who)], CHUNK)
        assert notes == [] and dropped == 1, who
    # cat：只能是四类之一
    for cat in ("note", "other", ""):
        notes, dropped = validate_notes([_note(cat=cat)], CHUNK)
        assert notes == [] and dropped == 1, cat
    # text：5 字、81 字、含换行都丢
    for text in ("五个字啊哈", "长" * 81, "平安喜欢\n散步"):
        notes, dropped = validate_notes([_note(text=text)], CHUNK)
        assert notes == [] and dropped == 1, text
    # 6 字与 80 字都留
    for text in ("六个字啊啊啊", "长" * 80):
        notes, dropped = validate_notes([_note(text=text)], CHUNK)
        assert len(notes) == 1 and dropped == 0, len(text)
    # 不是 dict 的条目丢掉
    assert validate_notes(["一句字符串", 3], CHUNK) == ([], 2)
    # notes 整体不是列表：当作没有候选，也不算丢了一条
    assert validate_notes("一条字符串", CHUNK) == ([], 0)
    assert validate_notes({"who": "111"}, CHUNK) == ([], 0)
    assert validate_notes(None, CHUNK) == ([], 0)


def test_validate_notes_due_and_dedupe_and_cap():
    # 非 pending 的 due 一律置空
    notes, _ = validate_notes([_note(cat="fact", due="2026-11-01")], CHUNK)
    assert notes[0]["due"] is None
    # pending 的非法日期只置空，这条照样留
    for due in ("下周五", "2026-02-30", "", "2026/11/01"):
        notes, dropped = validate_notes([_note(cat="pending", due=due)], CHUNK)
        assert len(notes) == 1 and notes[0]["due"] is None and notes[0]["cat"] == "pending", due
        assert dropped == 0
    # 合法日期保留
    notes, _ = validate_notes([_note(cat="pending", due="2026-11-01")], CHUNK)
    assert notes[0]["due"] == "2026-11-01"

    # 同块完全相同的 text 只留一条（不计数）
    same = [_note(text="平安喜欢下班后去江边散步"), _note(text=" 平安喜欢下班后去江边散步 ")]
    notes, dropped = validate_notes(same, CHUNK)
    assert len(notes) == 1 and dropped == 0

    # 最多 3 条，第 4 条丢
    four = [_note(text=f"平安的第{i}件事啊啊") for i in range(4)]
    notes, dropped = validate_notes(four, CHUNK)
    assert len(notes) == 3 and dropped == 1

    # who_name 按发言人位置取；两边对不上就是空串
    notes, _ = validate_notes([{"who": "333", "cat": "trait", "text": "老周喜欢周末钓鱼", "due": None}], CHUNK)
    assert notes[0]["who_name"] == "老周"
    mismatch = {"speakers": "111,333", "speaker_names": "平安"}
    notes, _ = validate_notes([_note(who="111")], mismatch)
    assert notes[0]["who_name"] == ""


@pytest.mark.parametrize("bad", ["missing", "string", "dict"])
def test_bad_notes_never_fail_the_summary(stack, cfg, state, bad):
    """notes 是字符串 / dict / 缺失时摘要照常写入（规格 §3.2）。"""
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)

    def decide(text, n):
        out = _reply(text)
        if bad == "missing":
            out.pop("notes")
        elif bad == "string":
            out["notes"] = "一条字符串"
        else:
            out["notes"] = {"who": "111"}
        return out

    out = make_distiller(cfg, stack, FakeDeepSeek(decide=decide)).run_once(now_ms=int(FAR_FUTURE))
    assert out["ok"] == 1 and out["failed"] == 0, out
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM summaries").fetchone()["n"] == 1
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM ledger_notes").fetchone()["n"] == 0
    # 抽过（空列表也算抽过）
    assert stack.db.conn.execute("SELECT state FROM notes_state").fetchone()["state"] == "done"


# ---------------------------------------------------------------- 3. 正常提炼写候选 + 读接口


def test_distill_writes_notes_with_summary_in_one_transaction(stack, cfg, state):
    out = distill_rows(state, stack, PRIVATE_ROWS, FakeDeepSeek())
    assert out["ok"] == 1 and out["notes"] == 1 and out["notes_dropped"] == 0

    l2 = L2(stack.db)
    sid = stack.db.conn.execute("SELECT summary_id FROM summaries").fetchone()["summary_id"]
    rows = stack.db.conn.execute("SELECT * FROM ledger_notes").fetchall()
    assert len(rows) == 1
    r = dict(rows[0])
    assert r["note_id"] == note_id_for(sid, 0)
    assert len(r["note_id"]) == 16 and r["note_id"] == r["note_id"].lower()
    assert r["summary_id"] == sid and r["key"] == PRIVATE
    assert (r["who"], r["who_name"], r["cat"]) == ("111", "平安", "pending")
    assert r["text"] == NOTE_TEXT and r["due"] == "2026-11-01"
    assert r["source"] == "distill" and r["created_at"] == int(FAR_FUTURE)
    st = stack.db.conn.execute("SELECT * FROM notes_state WHERE summary_id=?", (sid,)).fetchone()
    assert st["state"] == "done" and st["attempts"] == 0

    # L2 读接口的形状与接口约定 §1 一致
    got = l2.notes(PRIVATE, 0, 100)
    assert len(got) == 1
    assert set(got[0]) == {"note_id", "summary_id", "day", "t_end", "who", "who_name", "cat", "text",
                           "due", "importance", "created_at", "source"}
    assert got[0]["day"] == "2026-10-01"
    assert got[0]["t_end"] == int((T0 + timedelta(minutes=2)).timestamp() * 1000)
    assert got[0]["importance"] == 0.6


def test_rewriting_a_summary_replaces_its_old_notes(stack, cfg, state):
    distill_rows(state, stack, PRIVATE_ROWS, FakeDeepSeek())
    l2 = L2(stack.db)
    sid = stack.db.conn.execute("SELECT summary_id, chunk_id FROM summaries").fetchone()
    cid = sid["chunk_id"]
    chunk = stack.db.get([cid])[cid]
    new_text = "平安喜欢周末去钓鱼啊啊"
    res = _res("重写摘要", "平安说他喜欢周末去钓鱼。")
    res["notes"] = [{"who": "111", "who_name": "平安", "cat": "trait", "text": new_text, "due": None}]
    sid2 = l2.write_summary(cid, text_hash(chunk["text"]), res, "test", int(FAR_FUTURE) + 1000)
    assert sid2 == sid["summary_id"]

    rows = stack.db.conn.execute("SELECT * FROM ledger_notes").fetchall()
    assert len(rows) == 1 and rows[0]["text"] == new_text
    assert rows[0]["created_at"] == int(FAR_FUTURE) + 1000
    assert stack.db.conn.execute("SELECT state FROM notes_state").fetchone()["state"] == "done"


def test_http_notes_returns_contract_shape(monkeypatch, service, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    make_distiller(service.cfg, service, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))

    monkeypatch.setattr(app_module, "svc", service)
    client = TestClient(app_module.app)
    r = client.post("/notes", json={"key": PRIVATE})
    assert r.status_code == 200
    body = r.json()
    assert body["key"] == PRIVATE and len(body["items"]) == 1
    item = body["items"][0]
    assert set(item) == {"note_id", "summary_id", "day", "t_end", "who", "who_name", "cat", "text",
                         "due", "importance", "created_at", "source"}
    assert item["text"] == NOTE_TEXT and item["who_name"] == "平安"
    assert item["source"] == "distill" and item["cat"] == "pending" and item["due"] == "2026-11-01"


# ---------------------------------------------------------------- 4. 级联


def test_notes_are_deleted_with_their_summary(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    out = make_distiller(cfg, stack, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))
    assert out["ok"] == 2
    assert len(notes_of(stack, PRIVATE)) == 1 and len(notes_of(stack, GROUP)) == 1

    # 整会话遗忘（ChunkDB.delete_key，与 /forget 同一条路径）
    stack.db.delete_key(PRIVATE)
    assert notes_of(stack, PRIVATE) == []
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM notes_state").fetchone()["n"] == 1
    assert len(notes_of(stack, GROUP)) == 1  # 别的会话不受影响

    # 清空全部
    stack.db.clear()
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM ledger_notes").fetchone()["n"] == 0
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM notes_state").fetchone()["n"] == 0


def test_prune_orphans_deletes_notes(stack, cfg, state):
    distill_rows(state, stack, PRIVATE_ROWS, FakeDeepSeek())
    assert len(notes_of(stack)) == 1
    cid = stack.db.conn.execute("SELECT chunk_id FROM chunks").fetchone()["chunk_id"]
    stack.db.conn.execute("DELETE FROM chunks WHERE chunk_id=?", (cid,))
    stack.db.conn.commit()

    removed = L2(stack.db).prune_orphans()
    assert removed
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM ledger_notes").fetchone()["n"] == 0
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM notes_state").fetchone()["n"] == 0


def test_forget_service_path_deletes_notes(stack, cfg, state, make_service):
    """Service.forget（/forget 调的就是它）连带删候选。"""
    distill_rows(state, stack, PRIVATE_ROWS, FakeDeepSeek())
    svc = make_service()
    assert svc.l2.notes(PRIVATE, 0, 100)
    svc.forget(PRIVATE)
    assert svc.l2.notes(PRIVATE, 0, 100) == []
    assert svc.db.conn.execute("SELECT COUNT(*) AS n FROM notes_state").fetchone()["n"] == 0


REBUILD_ROWS = [
    (0, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (1, "in", "111", "平安", "排队也没关系"),
    (2, "out", None, "", "那就早点去"),
    (120, "in", "111", "平安", "下周五考完试去找你玩"),
    (121, "in", "111", "平安", "考完就出发"),
    (122, "out", None, "", "好，我等你"),
]


def test_rebuild_keeps_notes_when_hash_unchanged_and_drops_them_when_changed(stack, cfg, state):
    write_archive(state, PRIVATE, REBUILD_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    out = make_distiller(cfg, stack, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))
    assert out["ok"] == 2
    before = {n["summary_id"]: n["note_id"] for n in notes_of(stack)}
    assert len(before) == 2

    # 全量重建、原文没变：摘要挂回，候选原样保留、编号不变
    stack.indexer.reset()
    stack.indexer.run(now_ms=FAR_FUTURE)
    fake2 = FakeDeepSeek()
    out2 = make_distiller(cfg, stack, fake2).run_once(now_ms=int(FAR_FUTURE))
    assert fake2.calls == [] and out2["reconciled"] == 0
    assert {n["summary_id"]: n["note_id"] for n in notes_of(stack)} == before

    # 改账本称呼 -> 块原文变了 -> 旧摘要与候选一起删，重新提炼出新候选
    people = state / "long-memory" / "people.json"
    people.write_text(json.dumps({"version": 1, "people": {"111": {"name": "阿安"}}}, ensure_ascii=False),
                      encoding="utf-8")
    st = people.stat()
    os.utime(people, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    stack.indexer.reset()
    stack.indexer.run(now_ms=FAR_FUTURE)

    out3 = make_distiller(cfg, stack, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))
    assert out3["reconciled"] == 2 and out3["ok"] == 2
    rows = stack.db.conn.execute("SELECT summary_id FROM ledger_notes").fetchall()
    assert rows and {r["summary_id"] for r in rows}.isdisjoint(before)
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM notes_state").fetchone()["n"] == 2


# ---------------------------------------------------------------- 5. 回补


# 三块：第 1 块在 72 小时窗口外（T0），第 2、3 块在窗口内（FAR_FUTURE 前 20～21 小时）
BACKFILL_ROWS = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
    (42000, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (42001, "in", "111", "平安", "动画脚本结构清楚多了"),
    (42002, "out", None, "", "这版不错"),
    (42100, "in", "111", "平安", "下周五考完试去找你玩"),
    (42101, "in", "111", "平安", "考完就出发"),
    (42102, "out", None, "", "好，我等你"),
]


@pytest.fixture
def backfill_ready(stack, cfg, state, monkeypatch):
    """三块摘要；前两块没有 notes_state（模拟上线前的老摘要），第三块已经抽过。"""
    write_archive(state, PRIVATE, BACKFILL_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    sids = {}
    sids["火锅"] = write_summary_for(stack, "重庆火锅", _res(
        "周末吃火锅", "平安说周末想去吃那家重庆火锅，排队也没关系。",
        [_entity("qq:111", "平安", qq="111"), _entity("thing:火锅", "重庆火锅", "thing")]))[0]
    sids["提示词"] = write_summary_for(stack, "蝴蝶效应", _res(
        "改提示词", "平安改了一版蝴蝶效应的提示词。",
        [_entity("qq:111", "平安", qq="111"), _entity("thing:提示词", "提示词", "thing")]))[0]
    sids["考完试"] = write_summary_for(stack, "考完试", _res(
        "考完试来玩", "平安说下周五考完试去找她玩。", [_entity("qq:111", "平安", qq="111")]))[0]
    stack.db.conn.execute("DELETE FROM notes_state WHERE summary_id IN (?,?)",
                          (sids["火锅"], sids["提示词"]))
    stack.db.conn.commit()
    write_persona_config(state)
    # 回补接口用真实时钟取 now；测试里把它固定在 FAR_FUTURE，窗口才对得上
    monkeypatch.setattr(app_module.time, "time", lambda: FAR_FUTURE / 1000)
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    monkeypatch.setattr(app_module, "svc", svc)
    yield {"stack": stack, "cfg": cfg, "sids": sids, "svc": svc}
    # SUGGEST_PATCH：这里另建了一个 Service（和 stack 指向同一个临时 rag 目录），用完要关
    close_rag(svc)


def test_backfill_marks_queues_and_only_backfills_notes(backfill_ready):
    stack = backfill_ready["stack"]
    cfg = backfill_ready["cfg"]
    svc = backfill_ready["svc"]
    sids = backfill_ready["sids"]
    client = TestClient(app_module.app)

    # dry_run：窗口内两块里只有「提示词」没抽过（「考完试」已有 notes_state）→ 1，且不标
    r = client.post("/notes/backfill", json={"hours": 72, "dry_run": True})
    assert r.status_code == 200 and r.json() == {"queued": 1, "dry_run": True}
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM notes_state").fetchone()["n"] == 1

    r = client.post("/notes/backfill", json={"hours": 72, "dry_run": False})
    assert r.json() == {"queued": 1, "dry_run": False}
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM notes_state").fetchone()["n"] == 2

    # 重复调用不会重复排队
    assert client.post("/notes/backfill", json={"hours": 72}).json()["queued"] == 0

    # 摘要向量先补好，快照才只反映回补本身的影响
    Distiller(cfg, stack.db, svc.l2, svc.vstore, svc.embedder,
              http=FakeDeepSeek().transport())._fill_vectors()

    sid = sids["提示词"]

    def snap():
        return (
            dict(stack.db.conn.execute(
                "SELECT summary_id, chunk_id, key, text_hash, t_start, t_end, day, title, summary,"
                " importance, valence, model, created_at FROM summaries WHERE summary_id=?",
                (sid,)).fetchone()),
            [dict(x) for x in stack.db.conn.execute(
                "SELECT * FROM summary_entities WHERE summary_id=? ORDER BY entity_id", (sid,))],
            [dict(x) for x in stack.db.conn.execute(
                "SELECT * FROM relations WHERE summary_id=? ORDER BY src_id, dst_id", (sid,))],
            {r["entity_id"]: dict(r) for r in stack.db.conn.execute("SELECT * FROM entities")},
            int(stack.vs.scol.count()),
        )

    before = snap()
    fake = FakeDeepSeek()
    out = Distiller(cfg, stack.db, svc.l2, svc.vstore, svc.embedder,
                    http=fake.transport()).run_once(now_ms=int(FAR_FUTURE))
    assert out["backfill_calls"] == 1 and out["calls"] == 1
    assert len(fake.calls) == 1 and "蝴蝶效应" in fake.calls[0]["text"]
    assert fake.calls[0]["body"]["messages"][0]["content"] == SYSTEM_PROMPT
    assert snap() == before  # 摘要 / 实体 / 关系 / 实体表 / 摘要向量都没动

    got = [n for n in svc.l2.notes(PRIVATE, 0, 100) if n["summary_id"] == sid]
    assert len(got) == 1
    assert got[0]["source"] == "backfill" and got[0]["created_at"] == int(FAR_FUTURE)
    assert got[0]["who"] == "111" and got[0]["cat"] == "pending"
    assert stack.db.conn.execute("SELECT state FROM notes_state WHERE summary_id=?",
                                 (sid,)).fetchone()["state"] == "done"

    # 再跑一轮：没有排队项，不再调模型
    fake2 = FakeDeepSeek()
    out2 = Distiller(cfg, stack.db, svc.l2, svc.vstore, svc.embedder,
                     http=fake2.transport()).run_once(now_ms=int(FAR_FUTURE) + 1000)
    assert out2["backfill_calls"] == 0 and fake2.calls == []


def test_backfill_fails_twice_then_gives_up(stack, cfg, state):
    write_archive(state, PRIVATE, [(42000, "in", "111", "平安", "周末想去吃那家重庆火锅"),
                                   (42001, "in", "111", "平安", "排队也没关系"),
                                   (42002, "out", None, "", "那就早点去")])
    stack.indexer.run(now_ms=FAR_FUTURE)
    l2 = L2(stack.db)
    sid = write_summary_for(stack, "重庆火锅", _res("吃火锅", "平安说想吃火锅。"))[0]
    stack.db.conn.execute("DELETE FROM notes_state WHERE summary_id=?", (sid,))
    stack.db.conn.commit()
    write_persona_config(state)
    now = int(FAR_FUTURE)
    assert l2.queue_notes_backfill(72, now) == 1

    fake = FakeDeepSeek(status=500)
    d = Distiller(cfg, stack.db, l2, stack.vs, stack.emb, http=fake.transport())
    out = d.run_once(now_ms=now)
    assert out["backfill_calls"] == 1 and out["failed"] == 1
    row = stack.db.conn.execute("SELECT * FROM notes_state WHERE summary_id=?", (sid,)).fetchone()
    assert row["state"] == "queued" and row["attempts"] == 1

    out2 = d.run_once(now_ms=now + 1000)
    assert out2["backfill_calls"] == 1
    row = stack.db.conn.execute("SELECT * FROM notes_state WHERE summary_id=?", (sid,)).fetchone()
    assert row["state"] == "failed" and row["attempts"] == 2

    fake2 = FakeDeepSeek()
    out3 = Distiller(cfg, stack.db, l2, stack.vs, stack.emb,
                     http=fake2.transport()).run_once(now_ms=now + 2000)
    assert out3["backfill_calls"] == 0 and fake2.calls == []


def test_backfill_respects_daily_limit(stack, cfg, state):
    rows = PRIVATE_ROWS + [(42000, "in", "111", "平安", "下周五考完试去找你玩"),
                           (42001, "in", "111", "平安", "考完就出发"),
                           (42002, "out", None, "", "好，我等你")]
    write_archive(state, PRIVATE, rows)
    stack.indexer.run(now_ms=FAR_FUTURE)
    l2 = L2(stack.db)
    sid = write_summary_for(stack, "考完试", _res("考完试来玩", "平安说考完试来找她玩。"))[0]
    stack.db.conn.execute("DELETE FROM notes_state WHERE summary_id=?", (sid,))
    stack.db.conn.commit()
    write_persona_config(state)
    assert l2.queue_notes_backfill(72, int(FAR_FUTURE)) == 1

    cfg["distill"]["daily_limit"] = 1
    fake = FakeDeepSeek()
    out = Distiller(cfg, stack.db, l2, stack.vs, stack.emb, http=fake.transport()).run_once(
        now_ms=int(FAR_FUTURE))
    assert out["calls"] == 1 and out["backfill_calls"] == 0  # 唯一一次额度给了新块
    row = stack.db.conn.execute("SELECT * FROM notes_state WHERE summary_id=?", (sid,)).fetchone()
    assert row["state"] == "queued"  # 回补项留在队列里等第二天
    assert all(n["summary_id"] != sid for n in l2.notes(PRIVATE, 0, 100))


def test_backfill_rejects_bad_hours(backfill_ready):
    client = TestClient(app_module.app)
    for hours in (0, 169, -1, "72", 72.5, True):
        assert client.post("/notes/backfill", json={"hours": hours}).status_code == 400, hours
    assert client.post("/notes/backfill", json={}).status_code == 200


# ---------------------------------------------------------------- 6. /notes 的过滤与夹紧


def test_http_notes_isolates_keys_and_filters_since(monkeypatch, stack, cfg, state, make_service):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    write_archive(state, GROUP, GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    make_distiller(cfg, stack, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))

    svc = make_service()
    monkeypatch.setattr(app_module, "svc", svc)
    client = TestClient(app_module.app)

    body = client.post("/notes", json={"key": PRIVATE, "since_ms": 0}).json()
    assert len(body["items"]) == 1 and body["items"][0]["who"] == "111"
    created = body["items"][0]["created_at"]

    # since_ms 边界：等于 created_at 算在内，加 1 就不返回；负数按 0
    assert len(client.post("/notes", json={"key": PRIVATE, "since_ms": created}).json()["items"]) == 1
    assert client.post("/notes", json={"key": PRIVATE, "since_ms": created + 1}).json()["items"] == []
    assert len(client.post("/notes", json={"key": PRIVATE, "since_ms": -5}).json()["items"]) == 1

    # 别的会话的候选不返回；没有候选的会话返回空列表
    group = client.post("/notes", json={"key": GROUP}).json()
    assert len(group["items"]) == 1 and group["items"][0]["who"] == "333"
    assert client.post("/notes", json={"key": "private:999"}).json()["items"] == []

    # limit 夹到 1～200
    assert len(client.post("/notes", json={"key": PRIVATE, "limit": 0}).json()["items"]) == 1
    assert len(client.post("/notes", json={"key": PRIVATE, "limit": 999}).json()["items"]) == 1

    for bad in ("", "不是 key", "group:abc"):
        assert client.post("/notes", json={"key": bad}).status_code == 400, bad


# ---------------------------------------------------------------- 7. 用量与 /health


def _today(cfg) -> dict:
    usage = json.loads((cfg["paths"].rag / "distill-usage.json").read_text(encoding="utf-8"))
    return usage["days"][time.strftime("%Y-%m-%d", time.localtime())]


def test_usage_counts_notes(stack, cfg, state):
    out = distill_rows(state, stack, PRIVATE_ROWS, FakeDeepSeek())
    assert out["notes"] == 1
    today = _today(cfg)
    assert (today["notes"], today["notes_dropped"], today["backfill_calls"]) == (1, 0, 0)
    assert today["calls"] == 1  # 回补没有另调模型


def test_usage_counts_dropped_notes(stack, cfg, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)

    def decide(text, n):
        out = _reply(text)
        out["notes"] = [{"who": "999", "cat": "trait", "text": "平安喜欢下班后去江边散步", "due": None}]
        return out

    out = make_distiller(cfg, stack, FakeDeepSeek(decide=decide)).run_once(now_ms=int(FAR_FUTURE))
    assert out["notes"] == 0 and out["notes_dropped"] == 1
    today = _today(cfg)
    assert (today["notes"], today["notes_dropped"], today["backfill_calls"]) == (0, 1, 0)
    assert stack.db.conn.execute("SELECT COUNT(*) AS n FROM summaries").fetchone()["n"] == 1


def test_usage_backfill_calls_are_counted(backfill_ready):
    cfg = backfill_ready["cfg"]
    stack = backfill_ready["stack"]
    svc = backfill_ready["svc"]
    TestClient(app_module.app).post("/notes/backfill", json={"hours": 72})
    Distiller(cfg, stack.db, svc.l2, svc.vstore, svc.embedder,
              http=FakeDeepSeek().transport()).run_once(now_ms=int(FAR_FUTURE))
    today = _today(cfg)
    assert today["backfill_calls"] == 1
    assert today["calls"] == 1 and today["ok"] == 1  # 回补也计入总调用与成功
    assert today["notes"] == 1


def test_health_reports_notes_counts(monkeypatch, service, state):
    write_archive(state, PRIVATE, PRIVATE_ROWS)
    service.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state)
    make_distiller(service.cfg, service, FakeDeepSeek()).run_once(now_ms=int(FAR_FUTURE))

    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    notes = service.health()["distill"]["notes"]
    assert set(notes) == {"total", "queued", "failed"}
    assert notes == {"total": 1, "queued": 0, "failed": 0}


# ---------------------------------------------------------------- 8. 隐私：向量库里没有候选原文


def test_notes_never_reach_the_vector_store(stack, cfg, state):
    distill_rows(state, stack, PRIVATE_ROWS, FakeDeepSeek())
    assert len(notes_of(stack)) == 1

    for col in (stack.vs.col, stack.vs.scol):
        got = col.get(include=["documents", "metadatas"])
        assert all(d is None for d in got["documents"]), "Chroma 不许存任何文字"
        for m in got["metadatas"]:
            assert set(m) == {"key", "t_start", "t_end"}
            assert NOTE_TEXT not in json.dumps(m, ensure_ascii=False)
    # 候选那一整句（含「周六中午一起去」）不会进向量库的载荷
    dumped = json.dumps([col.get(include=["documents", "metadatas"]) for col in (stack.vs.col, stack.vs.scol)],
                        ensure_ascii=False)
    assert "周六中午一起去" not in dumped
