"""命令行：不起服务也能索引、重建、检索。

    .venv/bin/python -m memory_rag.cli index
    .venv/bin/python -m memory_rag.cli rebuild
    .venv/bin/python -m memory_rag.cli search private:100000001 "他之前说想吃什么" -k 火锅 想吃
    .venv/bin/python -m memory_rag.cli health
"""

from __future__ import annotations

import argparse
import json

from .service import Service


def main():
    ap = argparse.ArgumentParser(prog="memory_rag")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("index")
    sub.add_parser("rebuild")
    sub.add_parser("health")
    s = sub.add_parser("search")
    s.add_argument("key")
    s.add_argument("query")
    s.add_argument("-k", "--keywords", nargs="*", default=[])
    s.add_argument("--from", dest="date_from")
    s.add_argument("--to", dest="date_to")
    s.add_argument("--debug", action="store_true")
    a = ap.parse_args()

    svc = Service()
    if a.cmd == "health":
        print(json.dumps(svc.health(), ensure_ascii=False, indent=1))
        return
    if svc.mismatch and a.cmd != "rebuild":
        raise SystemExit(f"{svc.mismatch}（运行 rebuild）")
    if a.cmd == "rebuild":
        svc.rebuild()
        print(json.dumps(svc.indexer.run(), ensure_ascii=False, indent=1))
    elif a.cmd == "index":
        print(json.dumps(svc.indexer.run(), ensure_ascii=False, indent=1))
    elif a.cmd == "search":
        res = svc.searcher.search(a.key, a.query, a.keywords, a.date_from, a.date_to, debug=a.debug)
        for it in res["items"]:
            print(f"【{it['day']} · {'+'.join(it['sources'])} · {it['score']}】")
            print(it["text"])
        print(json.dumps({k: v for k, v in res.items() if k != "items"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
