"""memory-rag HTTP 服务（只监听 127.0.0.1）。

    .venv/bin/python -m memory_rag.app

接口：GET /health、POST /index/run、POST /search、POST /forget、POST /rebuild。
/forget 消费桥接写的遗忘请求；/rebuild 在后台全量重建（口径不一致时也能跑，这正是它的用途）。
RAG_PATCH（P3）：另有 /recall（唤醒时自动想起）、/associate（联想链）、/summaries（按编号取摘要）、
/distill/retry（手动重试提炼失败的块）；前三个与 /search 一样按 key 隔离、先处理遗忘请求。
SUGGEST_PATCH：/notes（本会话的账本建议候选，同样按 key 隔离、先处理遗忘请求）与
/notes/backfill（把老摘要排进回补队列，真正回补在提炼循环里跑）。
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .archive import valid_key
from .indexer import IndexBusy
from .recall import associate as run_associate, recall as run_recall, summaries as run_summaries
from .service import RebuildRunning, Service, request_at

svc = Service()
app = FastAPI(title="memory-rag", docs_url=None, redoc_url=None, openapi_url=None)


class SearchReq(BaseModel):
    key: str = ""
    query: str = ""
    keywords: list[str] = Field(default_factory=list)
    date_from: str | None = Field(default=None, alias="from")
    date_to: str | None = Field(default=None, alias="to")
    speaker: str = ""
    k: int | None = None
    expand: int | None = None


class ForgetReq(BaseModel):
    key: str = ""


# RAG_PATCH（P3）：联想三接口 + 提炼重试（接口约定 C2）
class RecallReq(BaseModel):
    key: str = ""
    texts: list[str] = Field(default_factory=list)
    k: int | None = 2
    now: int | None = None


class AssociateReq(BaseModel):
    key: str = ""
    text: str = ""
    t: int | None = None
    people: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)
    min_age_days: float | None = None
    k: int | None = 3
    now: int | None = None


class SummariesReq(BaseModel):
    key: str = ""
    ids: list[str] = Field(default_factory=list)


# SUGGEST_PATCH：账本建议的读接口与回补（接口约定 §1）。`hours` 故意用 Any 接，
# 好把「不是整数 / 超范围」统一回 400，而不是 pydantic 默认的 422。
class NotesReq(BaseModel):
    key: str = ""
    since_ms: int | None = 0
    limit: int | None = 100


class NotesBackfillReq(BaseModel):
    hours: Any = 72
    dry_run: bool = False


def _ready():
    if svc.mismatch:
        raise HTTPException(503, f"{svc.mismatch}（运行 python -m memory_rag.cli rebuild）")


def _recall_ready(key: str) -> None:
    """RAG_PATCH（P3）：联想三接口共用的前置检查（顺序与 /search 一致）。

    key 非法 400 → 口径不一致 / L2 不可用 503 → 该会话有遗忘请求就先处理（拿不到索引锁则 503）。
    遗忘请求必须在查 L2 之前处理掉，否则可能把已删会话的摘要返回给桥接。
    """
    if not valid_key(key):
        raise HTTPException(400, "key 必填，格式 group:<群号> 或 private:<QQ号>")
    _ready()
    if svc.l2 is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    try:
        svc.process_forget_requests(only_key=key, blocking=False)
    except IndexBusy:
        raise HTTPException(503, "该会话有待处理的遗忘请求，稍后再试") from None


def _clamp(value, lo: int, hi: int, default: int) -> int:
    if value is None:
        return default
    return max(lo, min(hi, int(value)))


def _index_once(indexer) -> None:
    # 遗忘后立刻把该会话重建回来；拿不到锁就算了，60 秒的定时循环会补上
    try:
        indexer.run()
    except Exception as e:  # 后台线程的异常记进上一轮结果，/health 看得见
        indexer.last = {"at": int(time.time() * 1000), "chunks": 0, "error": repr(e)}


@app.get("/health")
def health():
    return svc.health()


@app.post("/index/run")
def index_run():
    _ready()
    return svc.indexer.run()


@app.post("/forget")
def forget(req: ForgetReq):
    """RAG_PATCH（P2）：忘掉一个会话的向量记忆（桥接删完存档后调用）。"""
    if not valid_key(req.key):
        raise HTTPException(400, "key 必填，格式 group:<群号> 或 private:<QQ号>")
    if svc.indexer is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    # 先记下请求文件与它的 at：处理完只有 at 没变才删（期间桥接可能又写了新请求）
    pending = {k: (p, at) for p, k, at in svc.forget_requests()}.get(req.key)
    try:
        out = svc.forget(req.key)
    except IndexBusy:
        raise HTTPException(409, "索引正忙，稍后重试") from None
    if pending is not None:
        path, at = pending
        if request_at(path) == at:
            try:
                path.unlink()
            except OSError:
                pass
    indexer = svc.indexer
    threading.Thread(target=_index_once, args=(indexer,), daemon=True).start()
    return out


@app.post("/rebuild", status_code=202)
def rebuild():
    """RAG_PATCH（P2）：后台全量重建。故意不调 _ready()：口径不一致时正需要它来修。"""
    try:
        job = svc.start_rebuild()
    except RebuildRunning:
        raise HTTPException(409, "已有重建任务在进行") from None
    return {"ok": True, "job": job}


@app.post("/search")
def search(req: SearchReq):
    # key 必填：会话隔离的第二道闸（第一道在桥接，key 由会话令牌校验得出）
    if not valid_key(req.key):
        raise HTTPException(400, "key 必填，格式 group:<群号> 或 private:<QQ号>")
    _ready()
    # RAG_PATCH（P2）：这个会话有待处理的遗忘请求时先清掉，免得把已删内容返回给桥接。
    # 拿不到索引锁就 503，桥接降级为关键词检索——宁可查不到，也不能返回已删除的内容。
    try:
        svc.process_forget_requests(only_key=req.key, blocking=False)
    except IndexBusy:
        raise HTTPException(503, "该会话有待处理的遗忘请求，稍后再试") from None
    try:
        return svc.searcher.search(req.key, req.query, req.keywords[:12], req.date_from, req.date_to,
                                   req.speaker, req.k, req.expand)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


# ---------------------------------------------------------------- 联想三接口（RAG_PATCH（P3））


@app.post("/recall")
def recall(req: RecallReq):
    """唤醒时自动想起：桥接把最近 1～3 条来信交过来，回候选摘要与要注入的编号（接口约定 C2）。"""
    _recall_ready(req.key)
    texts = [str(t or "")[:500] for t in (req.texts or [])[-3:]]  # 只看最近的来信，过长截断
    return run_recall(svc, req.key, texts, k=_clamp(req.k, 1, 5, 2), now_ms=req.now)


@app.post("/associate")
def associate(req: AssociateReq):
    """联想链：按文字 / 指定的人 / 某个时刻的块找本会话里另一件相关的旧事。"""
    _recall_ready(req.key)
    people = [str(p).strip() for p in (req.people or []) if str(p).strip().isdigit()][:5]
    return run_associate(svc, req.key, text=str(req.text or "")[:500], t=req.t, people=people,
                         exclude=[str(x) for x in (req.exclude or [])][:200],
                         min_age_days=req.min_age_days, k=_clamp(req.k, 1, 5, 3), now_ms=req.now)


@app.post("/summaries")
def summaries(req: SummariesReq):
    """控制台按编号取摘要文字：不属于该 key 或已删除的 id 不返回（桥接显示「已删除」）。"""
    _recall_ready(req.key)
    return run_summaries(svc, req.key, [str(i) for i in (req.ids or [])][:100])


@app.post("/notes")
def notes(req: NotesReq):
    """SUGGEST_PATCH：本会话的账本建议候选（接口约定 §1）。

    与 /recall 同一套前置检查：key 非法 400、口径不一致 503、该会话有遗忘请求就先处理掉——
    否则可能把已删会话的候选返回给桥接。
    """
    _recall_ready(req.key)
    since = max(0, int(req.since_ms or 0))
    limit = _clamp(req.limit, 1, 200, 100)
    return {"key": req.key, "items": svc.l2.notes(req.key, since, limit)}


@app.post("/notes/backfill")
def notes_backfill(req: NotesBackfillReq):
    """SUGGEST_PATCH：把最近 hours 小时内、还没抽过候选的摘要标成 queued（真的回补在提炼循环里）。"""
    hours = req.hours if req.hours is not None else 72
    if isinstance(hours, bool) or not isinstance(hours, int) or not (1 <= hours <= 168):
        raise HTTPException(400, "hours 必须是 1～168 的整数")
    if svc.l2 is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    now = int(time.time() * 1000)
    queued = svc.l2.queue_notes_backfill(hours, now, dry_run=bool(req.dry_run))
    return {"queued": queued, "dry_run": bool(req.dry_run)}


@app.post("/distill/retry")
def distill_retry():
    """手动重试提炼失败的块（控制台用）。不按会话查东西，所以不需要 key。"""
    if svc.distiller is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    return {"ok": True, "retried": svc.distiller.retry_failed()}


def _loop(interval: float):
    while True:
        try:
            if svc.indexer:
                # RAG_PATCH（P2）：先消费遗忘请求，再增量索引——否则可能先把墓碑前的旧内容又索引一遍
                svc.process_forget_requests()
                svc.indexer.run()
                # RAG_PATCH（P3）：索引完提炼一轮（对账 → 补向量 → 挑块调模型）。
                # 提炼的异常不能拖垮定时循环，记进 distiller 自己的 last_error（只写类别）。
                if svc.distiller:
                    try:
                        svc.distiller.run_once()
                    except Exception as e:
                        svc.distiller.last_error = f"run: {type(e).__name__}"
        except Exception as e:  # 定时任务不能因为一次异常就停掉
            if svc.indexer:
                svc.indexer.last = {"at": int(time.time() * 1000), "chunks": 0, "error": repr(e)}
        time.sleep(interval)


def main():
    import uvicorn

    srv = svc.cfg.get("server") or {}
    threading.Thread(target=_loop, args=(float(srv.get("index_interval_s", 60)),), daemon=True).start()
    uvicorn.run(app, host=str(srv.get("host", "127.0.0.1")), port=int(srv.get("port", 8093)), log_level="warning")


if __name__ == "__main__":
    main()
