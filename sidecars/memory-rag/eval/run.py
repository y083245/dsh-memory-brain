"""评估集跑分（方案 §3.10）。用例含聊天原文，放在 state/long-memory/rag/eval/cases.jsonl，不入 git。

    .venv/bin/python eval/run.py              # 先增量索引，再跑全部配置
    .venv/bin/python eval/run.py --rebuild    # 改了切块参数后，全量重建再跑
    # Windows: .venv\Scripts\python.exe eval\run.py [--rebuild]

命中的判定：返回的块（核心范围，不含前后扩展）和期望的行范围有重叠，就算命中；
多个期望范围的用例，命中任意一个即可。「应无结果」用例不进 recall/MRR，只检查隔离。
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory_rag.archive import Row  # noqa: E402
from memory_rag.service import Service  # noqa: E402

CONFIGS = {
    "old_and": "旧关键词：所有词都要命中（现有 qq_history_search）",
    "old_each": "旧关键词：每个词单独查一遍再合并（模拟 AI 换词重试）",
    "bm25": "BM25（keywords + query 分词，OR）",
    "vector": "块向量（query）",
    "hybrid_nokw": "混合 ①+②，AI 没给 keywords",
    "hybrid_kw": "混合 ①+②，AI 给了 keywords",
    # RAG_PATCH（P3）：提炼层上线后单看 ③ 摘要向量、④ 关系图各自的增益，以及五路一起
    "+summary": "混合 ①+②+③（多一路摘要向量）",
    "+graph": "混合 ①+②+④（多一路关系图）",
    "all5": "五路 ①+②+③+④（检索的缺省）",
}


def old_search(rows: list[Row], words: list[str], t_from: float, t_to: float, limit: int = 30) -> list[int]:
    """src/long-memory.js search() 的逐行移植：小写子串、全部命中、从新到旧取前 30 条。"""
    ws = [w for w in " ".join(words).lower().split() if w]
    hits = []
    for i in range(len(rows) - 1, -1, -1):
        if len(hits) >= limit:
            break
        r = rows[i]
        if r.t < t_from or r.t > t_to:
            continue
        if ws and not all(w in r.text.lower() for w in ws):
            continue
        hits.append(i)
    return hits  # 从新到旧：旧工具先找到的是最新的


def day_ms(s: str | None, end: bool) -> float:
    if not s:
        return float("inf") if end else float("-inf")
    d = datetime.strptime(s, "%Y-%m-%d")
    if end:
        d = d.replace(hour=23, minute=59, second=59, microsecond=999000)
    return d.timestamp() * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--show", action="store_true", help="打印每条用例的前 3 名")
    a = ap.parse_args()

    svc = Service()
    if svc.mismatch and not a.rebuild:
        raise SystemExit(svc.mismatch)
    if a.rebuild:
        svc.rebuild()
    idx = svc.indexer.run()
    paths = svc.cfg["paths"]
    cases = [json.loads(l) for l in (paths.rag / "eval" / "cases.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    s = svc.searcher

    per_cfg: dict[str, dict] = {c: {"ranks": [], "lat": [], "violations": 0} for c in CONFIGS}
    detail = []
    for case in cases:
        key = case["key"]
        rows, index = s.rows.rows(key)
        exp = []
        for e in case["expected"]:
            a_, b_ = index.get((e["file"], e["line_start"])), index.get((e["file"], e["line_end"]))
            if a_ is None or b_ is None:
                raise SystemExit(f"期望行不存在：{e}")
            exp.append((a_, b_))
        t_from, t_to = day_ms(case.get("from"), False), day_ms(case.get("to"), True)
        row_detail = {"query": case["query"], "key": key, "tags": case["tags"], "ranks": {}}
        for cfg_name in CONFIGS:
            t0 = time.perf_counter()
            spans: list[tuple[int, int]] = []
            if cfg_name == "old_and":
                spans = [(i, i) for i in old_search(rows, case["keywords"], t_from, t_to)]
            elif cfg_name == "old_each":
                seen = []
                for w in case["keywords"]:
                    for i in old_search(rows, [w], t_from, t_to):
                        if i not in seen:
                            seen.append(i)
                spans = [(i, i) for i in seen]
            else:
                # RAG_PATCH（P3）：原有配置的路由显式写死（search 的缺省已变成五路，
                # 这里每个配置的含义必须和改动前一模一样）；新配置多带 ③ / ④。
                routes = {"bm25": ("bm25", "pending"), "vector": ("vector",), "hybrid_nokw": ("vector", "bm25", "pending"),
                          "hybrid_kw": ("vector", "bm25", "pending"),
                          "+summary": ("vector", "bm25", "pending", "summary"),
                          "+graph": ("vector", "bm25", "pending", "graph"),
                          "all5": ("vector", "bm25", "pending", "summary", "graph")}[cfg_name]
                res = s.search(key, case["query"], case["keywords"], case.get("from"), case.get("to"),
                               routes=routes, use_keywords=cfg_name != "hybrid_nokw", debug=True)
                for r in res["ranked"]:
                    c = r["core"]
                    spans.append((index[(c["file"], c["line_start"])], index[(c["file_end"], c["line_end"])]))
                    if not r["id"].startswith("pending:"):
                        m = svc.db.get([r["id"]]).get(r["id"])
                        if not m or m["key"] != key:
                            per_cfg[cfg_name]["violations"] += 1
            per_cfg[cfg_name]["lat"].append((time.perf_counter() - t0) * 1000)
            rank = None
            for pos, (x, y) in enumerate(spans, start=1):
                if any(x <= eb and y >= ea for ea, eb in exp):
                    rank = pos
                    break
            if exp:
                per_cfg[cfg_name]["ranks"].append(rank)
            row_detail["ranks"][cfg_name] = rank if exp else ("-" if not spans else f"返回{len(spans)}")
            if a.show and cfg_name == "hybrid_kw":
                row_detail["top3"] = [rows[x].text[:30] for x, _ in spans[:3]]
        detail.append(row_detail)

    def metrics(ranks: list) -> dict:
        n = len(ranks) or 1
        at = lambda k: sum(1 for r in ranks if r is not None and r <= k) / n
        return {"n": len(ranks), "recall@1": round(at(1), 3), "recall@3": round(at(3), 3), "recall@5": round(at(5), 3),
                "MRR": round(sum(1 / r for r in ranks if r) / n, 3)}

    summary = {}
    for c, v in per_cfg.items():
        lat = sorted(v["lat"])
        summary[c] = {**metrics(v["ranks"]), "p50_ms": round(statistics.median(lat), 1),
                      "p95_ms": round(lat[int(len(lat) * 0.95) - 1], 1), "isolation_violations": v["violations"]}

    st = svc.db.stats()
    n_rows = sum(len(s.rows.rows(k)[0]) for k in st["per_key"])
    print(f"语料：{n_rows} 条消息 → {st['chunks']} 块（平均 {n_rows / max(1, st['chunks']):.1f} 条/块），切分原因 {st['cut_reason']}")
    print(f"用例：{len(cases)} 条，其中有期望结果的 {per_cfg['bm25']['ranks'].__len__()} 条\n")
    print(f"{'配置':<12}{'R@1':>6}{'R@3':>6}{'R@5':>6}{'MRR':>7}{'p50ms':>8}{'p95ms':>8}{'越界':>5}  说明")
    for c, m in summary.items():
        print(f"{c:<12}{m['recall@1']:>6.2f}{m['recall@3']:>6.2f}{m['recall@5']:>6.2f}{m['MRR']:>7.3f}{m['p50_ms']:>8.1f}{m['p95_ms']:>8.1f}{m['isolation_violations']:>5}  {CONFIGS[c]}")
    if a.show:
        print()
        for d in detail:
            print(d["ranks"], d["query"], d.get("top3", ""))

    out_dir = paths.rag / "eval" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{datetime.now():%Y-%m-%d-%H%M}.json"
    out.write_text(json.dumps({"at": datetime.now().isoformat(), "index": idx, "corpus": st, "summary": summary, "cases": detail},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n结果已写入 {out.relative_to(paths.state.parent)}")


if __name__ == "__main__":
    main()
