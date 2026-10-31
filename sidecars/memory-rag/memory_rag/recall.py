"""RAG_PATCH（P3）：自动想起（/recall）、联想链（/associate）与按编号取摘要（/summaries）。

纯逻辑模块，不碰 HTTP、不写日志、不读存档：只读 L2（SQLite）与摘要向量（Chroma）。
所有查询都按会话 key 过滤，调用方拿到的一定是本会话的摘要。

- `recall`：唤醒时拿最近 1～3 条来信找「意思接近 / 关键词对得上 / 提到同一个人或东西」的旧事，
  三路里至少两路命中且余弦过门槛才算通过（影子 / 开由桥接决定，这里只管算）。
- `associate`：顺着一个人的名字或一件事的实体，在同一会话里找另一件也提到它们的事（只走 1 跳）。
- `summaries`：控制台按编号取摘要文字；不属于该 key 的 id 不返回。

打分（Σ ln(1 + N / df)）与 `search.py` 的关系图路同一套：这里导出 `score_linked`，
`search.py` 直接复用，免得两处走样。`_rrf` 与 `search.rrf` 是同一算法（不互相 import，避免成环）。
"""

from __future__ import annotations

import math
import time
from typing import Sequence

from .embeddings import EmbeddingUnavailable
from .fts import query_tokens
from .l2 import hubs_for_key, normalize_name

# 与 config.yml 的 recall.stopwords 缺省值一致；配置里给了就完全用配置的
DEFAULT_STOPWORDS = ("在吗", "嗯", "嗯嗯", "哈哈", "哈哈哈", "晚安", "早", "早安", "好的", "好", "收到", "ok", "行")

ROUTE_TOP = 20     # 每一路取前 20（与检索的 route_top 同口径）
CANDIDATES = 5     # /recall 最多回这么多条候选
RRF_K = 60
VIA_MAX = 3        # /associate 的 via 最多给几个显示名


def normalize_text(s: str) -> str:
    """去掉 emoji、标点、符号、空白并转小写：判「这句话是不是废话」用（与 l2.normalize_name 同法）。"""
    return normalize_name(s)


def _bigrams(s: str) -> set[str]:
    """RAG_PATCH（P3）：规范化、去掉 ASCII 数字后取相邻两字切片，判断两段文字是不是在讲同一件事。"""
    norm = "".join(ch for ch in normalize_name(s) if ch not in "0123456789")
    return {norm[i:i + 2] for i in range(len(norm) - 1)} if len(norm) >= 2 else set()


def _rrf(lists: dict[str, Sequence[str]], k: int = RRF_K) -> list[tuple[str, float, list[str]]]:
    """与 `search.rrf` 同一算法：只看名次，`1 / (k + rank)` 相加。"""
    score: dict[str, float] = {}
    src: dict[str, list[str]] = {}
    for name, ids in lists.items():
        for rank, sid in enumerate(ids, start=1):
            score[sid] = score.get(sid, 0.0) + 1.0 / (k + rank)
            src.setdefault(sid, []).append(name)
    return sorted(((sid, s, src[sid]) for sid, s in score.items()), key=lambda x: -x[1])


def score_linked(l2, key: str, linked: dict[str, list[str]]) -> dict[str, float]:
    """关系图得分：Σ 共享实体的 idf，`idf = ln(1 + N / df)`（N、df 都只数本会话）。"""
    if not linked:
        return {}
    n_sum = l2.count_summaries(key)
    df = l2.entity_df(key, sorted({e for ents in linked.values() for e in ents}))
    out: dict[str, float] = {}
    for sid, ents in linked.items():
        s = 0.0
        for e in ents:
            n = int(df.get(e, 0))
            if n > 0:  # 实体在本会话一条摘要都没挂，就不可能是种子里的那个
                s += math.log(1.0 + n_sum / n)
        out[sid] = s
    return out


def _recall_opts(cfg: dict) -> dict:
    r = cfg.get("recall") or {}
    sw = r.get("stopwords")
    if sw is None:
        sw = DEFAULT_STOPWORDS
    return {
        "tau": float(r.get("tau", 0.55)),
        "exclude_recent_hours": float(r.get("exclude_recent_hours", 12)),
        "min_chars": max(1, int(r.get("min_chars", 4))),
        "stopwords": {normalize_text(s) for s in sw if normalize_text(s)},
    }


def _min_age_days(cfg: dict, value) -> float:
    if value is not None:
        return float(value)
    a = cfg.get("associate") or {}
    return float(a.get("min_age_days", 2))


def _skipped(key: str, tau: float, why: str) -> dict:
    return {"key": key, "skipped": why, "tau": tau, "candidates": [], "inject": []}


def recall(svc, key: str, texts: Sequence[str], k: int = 2, now_ms: int | None = None) -> dict:
    """唤醒时自动想起：返回候选摘要与要注入的编号；跳过的原因写在 `skipped` 里。"""
    o = _recall_opts(svc.cfg)
    tau = o["tau"]
    l2 = svc.l2
    now = int(now_ms if now_ms is not None else time.time() * 1000)

    kept: list[str] = []
    for t in list(texts or ())[-3:]:  # 只看最近的来信
        t = str(t or "")[:500]
        norm = normalize_text(t)
        if len(norm) < o["min_chars"] or norm in o["stopwords"]:
            continue  # 短句 / 寒暄不查
        kept.append(t)
    if not kept:
        return _skipped(key, tau, "trivial")
    if l2.count_summaries(key) == 0:
        return _skipped(key, tau, "no_summaries")

    query = "\n".join(kept)
    cutoff = now - int(o["exclude_recent_hours"] * 3_600_000)  # 还在 DSH 上下文里的不算

    vec_hits: list[tuple[str, float]] = []
    if svc.embedder is not None:
        try:
            vec_hits = svc.vstore.query_summaries(key, svc.embedder.embed_query(query), ROUTE_TOP, t_end_lte=cutoff)
        except EmbeddingUnavailable:
            vec_hits = []  # 三路里少一路，照样按「至少两路」算
    bm_hits = l2.bm25_summaries(key, query_tokens(query), ROUTE_TOP, t_end_lte=cutoff)
    graph: dict[str, float] = {}
    seeds = set(l2.entities_in_text(key, query, min_len=2)) - hubs_for_key(key)
    if seeds:
        graph = score_linked(l2, key, l2.linked_summaries(key, sorted(seeds), t_end_lte=cutoff))

    lists = {name: ids for name, ids in (
        ("vector", [sid for sid, _ in vec_hits]),
        ("bm25", [sid for sid, _ in bm_hits]),
        ("graph", [sid for sid, _ in sorted(graph.items(), key=lambda x: (-x[1], x[0]))]),
    ) if ids}
    cos = dict(vec_hits)
    bm_rank = {sid: i for i, (sid, _) in enumerate(bm_hits, start=1)}

    fused = _rrf(lists)[:CANDIDATES]
    rows = l2.get_summaries(key, [sid for sid, _, _ in fused])
    cands: list[dict] = []
    for sid, _, src in fused:
        row = rows.get(sid)
        if not row:
            continue  # 并发删除：拿不到文字就丢，不返回半条
        c = cos.get(sid)
        signals = [name for name in ("vector", "bm25", "graph") if name in src]
        cands.append({
            "summary_id": sid,
            "chunk_id": str(row["chunk_id"]),
            "day": str(row["day"]),
            "t_end": int(row["t_end"]),
            "title": str(row["title"]),
            "summary": str(row["summary"]),
            "cosine": None if c is None else round(float(c), 4),
            "bm25_rank": bm_rank.get(sid),
            "graph": None if sid not in graph else round(float(graph[sid]), 4),
            "signals": signals,
            # 门槛：意思足够接近，且三路里至少两路命中
            "pass": bool(c is not None and c >= tau and len(signals) >= 2),
        })
    inject = [x["summary_id"] for x in cands if x["pass"]][:max(0, int(k))]
    return {"key": key, "skipped": None, "tau": tau, "candidates": cands, "inject": inject}


def associate(svc, key: str, text: str = "", t: int | None = None, people: Sequence = (),
              exclude: Sequence = (), min_age_days=None, k: int = 3, now_ms: int | None = None) -> dict:
    """联想链：拿种子（文字里出现的实体 / 指定的人 / 覆盖某时刻的那块）在同一会话里再走一步。"""
    l2 = svc.l2
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    text = str(text or "")[:500]

    seeds = set(l2.entities_in_text(key, text, min_len=2))
    seeds |= {f"qq:{p}" for p in people or () if str(p).strip()}
    covering = l2.summary_covering(key, int(t)) if t is not None else None
    if covering:
        seeds |= {e for ents in l2.entities_of(key, [covering["summary_id"]]).values() for e in ents}
    seeds -= hubs_for_key(key)

    skip = [str(s) for s in exclude or ()]
    if covering:
        skip.append(str(covering["summary_id"]))
    cutoff = now - int(_min_age_days(svc.cfg, min_age_days) * 86_400_000)

    items: list[dict] = []
    if seeds:
        linked = l2.linked_summaries(key, sorted(seeds), exclude_ids=skip, t_end_lte=cutoff)
        scores = {sid: s for sid, s in score_linked(l2, key, linked).items() if s > 0}
        rows = l2.get_summaries(key, list(scores))
        names = l2.entity_names(sorted({e for ents in linked.values() for e in ents}))
        ranked = sorted(((-s, -int(rows[sid]["t_end"]), sid) for sid, s in scores.items() if sid in rows))
        # RAG_PATCH（P3）：两道过滤——(a) 候选要带出种子之外的新实体，(b) 不能是种子那件事的复述。
        # 端到端验收加：种子来自账本 / 日记时没有 t，排除不了覆盖那一刻的块，
        # 只按共享实体返回的话，带出来的往往就是讲同一件事的那条摘要。
        hubs = hubs_for_key(key)
        seed_bigrams = _bigrams(text)
        need_overlap_check = len(seed_bigrams) >= 4  # 种子太短时不判 (b)
        cand_ents = l2.entities_of(key, [sid for _, _, sid in ranked])
        picked: list[str] = []
        for _, _, sid in ranked:
            ents = set(cand_ents.get(sid, ())) - hubs
            if not (ents - seeds):
                continue  # (a) 没有种子之外的新实体：还是同一件事
            if need_overlap_check:
                row = rows[sid]
                if len(seed_bigrams & _bigrams(f"{row['title']}{row['summary']}")) / len(seed_bigrams) >= 0.6:
                    continue  # (b) 种子的大多数字都在候选里：复述
            picked.append(sid)
            if len(picked) >= max(0, int(k)):
                break
        for sid in picked:
            row = rows[sid]
            via: list[str] = []
            for e in linked.get(sid, ()):
                name = names.get(e)
                if name and name not in via:
                    via.append(name)
            items.append({
                "summary_id": sid,
                "day": str(row["day"]),
                "t_end": int(row["t_end"]),
                "title": str(row["title"]),
                "summary": str(row["summary"]),
                "score": round(float(scores[sid]), 4),
                "via": via[:VIA_MAX],
            })
    return {"key": key, "items": items}


def summaries(svc, key: str, ids: Sequence[str]) -> dict:
    """按编号取摘要文字（控制台用）：按请求顺序返回，不属于该 key 或已删除的不返回。"""
    want = [str(i) for i in (ids or ()) if i][:100]
    rows = svc.l2.get_summaries(key, want) if want else {}
    items = []
    for sid in want:
        row = rows.get(sid)
        if not row:
            continue
        items.append({"summary_id": sid, "day": str(row["day"]), "title": str(row["title"]),
                      "summary": str(row["summary"])})
    return {"key": key, "items": items}
