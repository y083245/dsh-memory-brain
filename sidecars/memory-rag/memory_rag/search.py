"""检索：多路召回 → RRF 合并 → 回原文 → 前后各扩几条（方案 §3.2.6）。

P0 有两路加一路兜底：① 块向量、② 块 BM25、以及「进行中」消息的临时 BM25（还没切块入库的最新消息）。
RAG_PATCH（P3）：提炼层上线后接进 ③ 摘要向量、④ 关系图，五路一起做 RRF，返回的仍是原话。

不用线性加权：各路分数尺度不同（余弦 vs bm25），换模型就得重调；RRF 只看名次，稳。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Sequence

from .archive import NameBook, Row, RowCache, fmt_line, valid_key
from .embeddings import Embedder, EmbeddingUnavailable
from .fts import ChunkDB, bm25_lines, query_tokens
from .indexer import Indexer
from .l2 import L2, hubs_for_key
from .recall import score_linked
from .store import VectorStore


@dataclass
class Hit:
    id: str
    rows: tuple[int, int]            # 在会话消息序列里的 [起, 止]（含）——核心块，未扩展
    sources: list[str] = field(default_factory=list)
    score: float = 0.0
    title: str = ""


def day_range(s: str | None, end: bool = False) -> int | None:
    if not s:
        return None
    d = datetime.strptime(s, "%Y-%m-%d")
    if end:
        d = d.replace(hour=23, minute=59, second=59, microsecond=999000)
    return int(d.timestamp() * 1000)


def rrf(lists: dict[str, Sequence[str]], k: int = 60) -> list[tuple[str, float, list[str]]]:
    score: dict[str, float] = {}
    src: dict[str, list[str]] = {}
    for name, ids in lists.items():
        for rank, cid in enumerate(ids, start=1):
            score[cid] = score.get(cid, 0.0) + 1.0 / (k + rank)
            src.setdefault(cid, []).append(name)
    return sorted(((cid, s, src[cid]) for cid, s in score.items()), key=lambda x: -x[1])


class Searcher:
    def __init__(self, cfg: dict, embedder: Embedder | None, db: ChunkDB, vstore: VectorStore, indexer: Indexer):
        s = cfg.get("search") or {}
        self.top = int(s.get("route_top", 20))
        self.rrf_k = int(s.get("rrf_k", 60))
        self.top_chunks = int(s.get("top_chunks", 5))
        self.top_seeds = 5  # RAG_PATCH（P3）：关系图路取合并结果的前几块当作种子（规格 §5）
        self.expand = int(s.get("expand", 3))
        self.max_chars = int(s.get("max_chars", 1500))
        self.gap_ms = float((cfg.get("segmenter") or {}).get("gap_minutes", 30)) * 60_000
        self.embedder = embedder
        self.db = db
        self.vstore = vstore
        self.indexer = indexer
        # RAG_PATCH（P3）：L2 与 ChunkDB 同库同锁；L2() 构造是幂等的，不需要等 Service 装配
        self.l2 = L2(db)
        self.rows = RowCache(cfg["paths"].archive)

    @property
    def names(self) -> NameBook:
        return self.indexer.names

    def search(self, key: str, query: str = "", keywords: Sequence[str] = (), date_from: str | None = None,
               date_to: str | None = None, speaker: str = "", k: int | None = None, expand: int | None = None,
               routes: Sequence[str] = ("vector", "bm25", "pending", "summary", "graph"),
               use_keywords: bool = True, debug: bool = False) -> dict:
        if not valid_key(key):
            raise ValueError("key 必填且必须是 group:<号> 或 private:<号>")
        k = self.top_chunks if k is None else max(1, int(k))
        expand = self.expand if expand is None else max(0, int(expand))
        t_from, t_to = day_range(date_from), day_range(date_to, end=True)
        rows, index = self.rows.rows(key)
        kws = list(keywords or ()) if use_keywords else []
        tokens = query_tokens(query, kws)

        lists: dict[str, list[str]] = {}
        semantic = "ok"
        qv = None  # 查询向量：③ 摘要路复用 ① 算好的那份，不重复 embedding
        if "vector" in routes and query.strip():
            if self.embedder is None:
                semantic = "unavailable"
            else:
                try:
                    qv = self.embedder.embed_query(query.strip())
                    lists["vector"] = [cid for cid, _ in self.vstore.query(key, qv, self.top, t_from, t_to)]
                except EmbeddingUnavailable:
                    semantic = "unavailable"
        # RAG_PATCH（P3）：③ 摘要向量。摘要文字只在 SQLite，Chroma 里按 id 找回它的 chunk_id
        if "summary" in routes and query.strip():
            if self.embedder is None:
                semantic = "unavailable"
            else:
                try:
                    if qv is None:
                        qv = self.embedder.embed_query(query.strip())
                    sums = self.vstore.query_summaries(key, qv, self.top, t_from, t_to)
                    sum_rows = self.l2.get_summaries(key, [sid for sid, _ in sums])
                    ids, seen = [], set()
                    for sid, _ in sums:  # 按名次保序，同一块只留第一次出现（一条摘要挂一块）
                        row = sum_rows.get(sid)
                        if not row:
                            continue
                        cid = str(row["chunk_id"])
                        if cid not in seen:
                            seen.add(cid)
                            ids.append(cid)
                    if ids:
                        lists["summary"] = ids
                except EmbeddingUnavailable:
                    semantic = "unavailable"
        if "bm25" in routes and tokens:
            lists["bm25"] = [cid for cid, _ in self.db.bm25(key, tokens, self.top, t_from, t_to)]

        pending_hits: dict[str, int] = {}
        if "pending" in routes and tokens:
            pend = [r for r in self.indexer.pending_rows(key)
                    if (t_from is None or r.t >= t_from) and (t_to is None or r.t <= t_to)]
            if pend:
                n_docs, df = self.db.doc_freq(tokens)
                scores = bm25_lines([fmt_line(r, self.names) for r in pend], tokens, n_docs, df)
                ranked = sorted((s, i) for i, s in enumerate(scores) if s > 0)[::-1][: self.top]
                ids = []
                for _, i in ranked:
                    r = pend[i]
                    pos = index.get((r.file, r.line))
                    if pos is None:  # 两次读文件之间刚好写进来的新行，下次再算
                        continue
                    cid = f"pending:{r.file}:{r.line}"
                    pending_hits[cid] = pos
                    ids.append(cid)
                if ids:
                    lists["pending"] = ids

        # RAG_PATCH（P3）：④ 关系图，在①②③与 pending 都算完之后再走一步（它拿它们的结果当种子）。
        # 种子 = 前几块所挂的实体 ∪ query / keywords 里直接出现的实体名，去掉枢纽点；只走 1 跳。
        if "graph" in routes:
            pre = rrf({name: ids for name, ids in lists.items() if name != "graph"}, self.rrf_k)
            seed_chunks = [cid for cid, _, _ in pre if not cid.startswith("pending:")][:self.top_seeds]
            seed_ids = [str(r["summary_id"]) for r in self.l2.summaries_by_chunks(key, seed_chunks).values()]
            seeds = {e for ents in self.l2.entities_of(key, seed_ids).values() for e in ents}
            seeds |= set(self.l2.entities_in_text(key, query + " " + " ".join(kws), min_len=2))
            seeds -= hubs_for_key(key)
            if seeds:
                linked = self.l2.linked_summaries(key, sorted(seeds), exclude_ids=seed_ids)
                scores = score_linked(self.l2, key, linked)
                sum_rows = self.l2.get_summaries(key, list(scores))
                ranked = sorted(((-s, -int(sum_rows[sid]["t_end"]), sid) for sid, s in scores.items() if sid in sum_rows))
                ids = []
                for _, _, sid in ranked:
                    row = sum_rows[sid]
                    # 与块向量路同口径：块与时间窗有重叠就算（t_end >= from、t_start <= to）
                    if t_from is not None and int(row["t_end"]) < int(t_from):
                        continue
                    if t_to is not None and int(row["t_start"]) > int(t_to):
                        continue
                    ids.append(str(row["chunk_id"]))
                    if len(ids) >= self.top:
                        break
                if ids:
                    lists["graph"] = ids

        fused = rrf(lists, self.rrf_k)
        meta = self.db.get([cid for cid, _, _ in fused if not cid.startswith("pending:")])
        hits: list[Hit] = []
        for cid, s, src in fused:
            if cid in pending_hits:
                i = pending_hits[cid]
                hits.append(Hit(cid, (i, i), src, s))
                continue
            m = meta.get(cid)
            if not m or m["key"] != key:  # 双保险：任何不属于本会话的块都丢掉
                continue
            a, b = index.get((m["file_start"], m["line_start"])), index.get((m["file_end"], m["line_end"]))
            if a is None or b is None:
                continue
            hits.append(Hit(cid, (a, b), src, s, m.get("title") or ""))
        if speaker:
            hits = [h for h in hits if self._has_speaker(rows[h.rows[0]:h.rows[1] + 1], speaker)]

        ranked_out = [{"id": h.id, "score": round(h.score, 5), "sources": h.sources,
                       "core": self._span(rows, h.rows)} for h in hits]
        items = self._assemble(rows, hits[:k], expand)
        out = {"key": key, "semantic": semantic, "tokens": tokens, "items": items}
        if sum(len(it["ids"]) for it in items) < 2:
            out["hint"] = "结果很少：可以换个说法、多给几个近义词，或者放宽时间范围再查一次"
        if debug:
            out["ranked"] = ranked_out
            out["routes"] = {name: len(ids) for name, ids in lists.items()}
        return out

    # ---------------------------------------------------------------- 组装结果

    def _has_speaker(self, rs: Sequence[Row], speaker: str) -> bool:
        sp = speaker.strip().lower()
        for r in rs:
            if sp == "我" and r.is_self:
                return True
            if not r.is_self and (sp in (r.user_id or "") or sp in self.names.name(r).lower() or sp in r.name.lower()):
                return True
        return False

    @staticmethod
    def _span(rows: Sequence[Row], ab: tuple[int, int]) -> dict:
        a, b = ab
        return {"file": rows[a].file, "line_start": rows[a].line, "file_end": rows[b].file, "line_end": rows[b].line}

    def _expand(self, rows: Sequence[Row], a: int, b: int, n: int) -> tuple[int, int]:
        """前后各扩 n 条，但不跨 30 分钟段边界：段外的话和这件事无关。"""
        s = a
        while s > 0 and a - s < n and rows[s].t - rows[s - 1].t <= self.gap_ms:
            s -= 1
        e = b
        while e < len(rows) - 1 and e - b < n and rows[e + 1].t - rows[e].t <= self.gap_ms:
            e += 1
        return s, e

    def _assemble(self, rows: Sequence[Row], hits: Sequence[Hit], expand: int) -> list[dict]:
        spans = []
        for h in hits:
            s, e = self._expand(rows, h.rows[0], h.rows[1], expand)
            spans.append({"s": s, "e": e, "score": h.score, "sources": list(h.sources), "ids": [h.id],
                          "titles": [h.title] if h.title else []})
        spans.sort(key=lambda x: x["s"])
        # 每块单独成段，只去掉和前一段重叠的行。不把相邻块连成一大段：几块连着命中时，
        # 扩展后会首尾相接成几十行，超过字数上限只能从中间截断，反而丢掉后面相关的那几块。
        merged: list[dict] = []
        for sp in spans:
            if merged and sp["s"] <= merged[-1]["e"]:
                if sp["e"] <= merged[-1]["e"]:  # 整段都已经包含在前一段里
                    m = merged[-1]
                    m["score"] = max(m["score"], sp["score"])
                    m["sources"] = sorted(set(m["sources"]) | set(sp["sources"]))
                    m["ids"] += sp["ids"]
                    m["titles"] += sp["titles"]
                    continue
                sp["s"] = merged[-1]["e"] + 1
            merged.append(sp)
        for m in merged:
            m["text"] = "\n".join(fmt_line(r, self.names) for r in rows[m["s"]:m["e"] + 1])
        # 总长超限：按得分从低到高丢弃，至少留一段（过长就截断）
        keep = sorted(merged, key=lambda x: -x["score"])
        while len(keep) > 1 and sum(len(m["text"]) for m in keep) > self.max_chars:
            keep.pop()
        if keep and len(keep[0]["text"]) > self.max_chars:
            keep[0]["text"] = keep[0]["text"][: self.max_chars] + "…"
        keep.sort(key=lambda x: x["s"])
        out = []
        for m in keep:
            a, b = rows[m["s"]], rows[m["e"]]
            out.append({
                "ids": m["ids"], "score": round(m["score"], 5), "sources": m["sources"],
                "title": "；".join(t for t in m["titles"] if t), "day": datetime.fromtimestamp(a.t / 1000).strftime("%Y-%m-%d"),
                "t_start": int(a.t), "t_end": int(b.t), "text": m["text"],
                "file": a.file, "line_start": a.line, "file_end": b.file, "line_end": b.line,
            })
        return out
