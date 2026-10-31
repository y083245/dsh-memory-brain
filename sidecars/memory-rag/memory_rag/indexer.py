"""增量索引：存档 → 切块 → 向量库 + FTS5 双写。

水位（watermarks.json）记的是每个会话「下一条还没入库的消息」在哪个文件、哪个字节、第几行。
只有已结束的段才切块入库；写入成功后才推进水位，崩溃重来不丢不重（块 ID 确定，重写即覆盖）。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from .archive import NameBook, Row, key_files, list_keys, read_rows
from .embeddings import Embedder, EmbeddingUnavailable
from .fts import ChunkDB, add_words
from .segmenter import Segmenter, closed_segments
from .store import VectorStore


class IndexBusy(RuntimeError):
    """拿不到索引锁：调用方决定是重试、降级还是回 409/503。"""


def confirmed_slang(path: Path) -> list[str]:
    """黑话表里已确认的词条（state/slang.json，由桥接的 slang-learner 维护）；候选词不加，免得误切。"""
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [str(x.get("content") or "") for x in items if isinstance(x, dict) and x.get("status") == "confirmed"]


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


class Indexer:
    def __init__(self, cfg: dict, embedder: Embedder | None, db: ChunkDB, vstore: VectorStore):
        self.paths = cfg["paths"]
        self.seg_cfg = cfg.get("segmenter") or {}
        self.gap_ms = float(self.seg_cfg.get("gap_minutes", 30)) * 60_000
        self.embedder = embedder
        self.db = db
        self.vstore = vstore
        self.wm_file = self.paths.rag / "watermarks.json"
        self.lock = threading.Lock()
        self.last: dict = {"at": None, "chunks": 0, "error": None}
        self._people_mtime = None
        self.names = NameBook(self.paths.people, self.paths.archive)
        add_words(self.names.all_names())
        add_words(confirmed_slang(self.paths.state / "slang.json"))

    # ---------------------------------------------------------------- 水位

    def watermarks(self) -> dict:
        try:
            return json.loads(self.wm_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_wm(self, wm: dict) -> None:
        self.wm_file.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(self.wm_file, wm)

    def _start(self, key: str, wm: dict) -> tuple[str | None, int, int]:
        w = wm.get(key)
        if not w:
            return None, 0, 1
        files = key_files(self.paths.archive, key)
        try:
            size = (self.paths.archive / w["file"]).stat().st_size
        except OSError:
            size = -1
        if w["file"] not in files or int(w["offset"]) > size:
            # 存档被删改过（遗忘操作）：这个会话从头重建
            # RAG_PATCH（P2）：与 forget_key 共用同一套删除，免得两处 SQL 走样
            self.db.delete_key(key)
            self.vstore.delete_key(key)
            return None, 0, 1
        return w["file"], int(w["offset"]), int(w["line"])

    def pending_rows(self, key: str) -> list[Row]:
        """水位之后、还没入库的消息（进行中的段，以及 embedding 挂掉期间攒下的）。"""
        f, off, line = self._start(key, self.watermarks())
        return read_rows(self.paths.archive, key, f, off, line)

    def _refresh_names(self) -> None:
        try:
            m = self.paths.people.stat().st_mtime
        except OSError:
            m = None
        if m != self._people_mtime:
            self._people_mtime = m
            fresh = NameBook(self.paths.people)
            self.names.ledger = fresh.ledger
            add_words(self.names.all_names())

    # ---------------------------------------------------------------- 索引

    def run(self, now_ms: float | None = None, blocking: bool = False) -> dict:
        # RAG_PATCH（P2）：重建任务要等前面的索引跑完，不能被「跳过」糊弄过去
        if blocking:
            self.lock.acquire()
        elif not self.lock.acquire(blocking=False):
            return {"skipped": "上一轮索引还没跑完"}
        try:
            return self._run(now_ms)
        finally:
            self.lock.release()

    def forget_key(self, key: str, timeout: float = 120.0) -> int:
        """RAG_PATCH（P2）：彻底忘掉一个会话：块、向量、水位一起删，返回删掉的块数。

        水位一并删掉，下一次增量索引才会从这个会话的开头重读（墓碑被跳过），否则水位还停在
        已删的字节上，这个会话再也不会被索引。timeout=0 即非阻塞，拿不到锁抛 IndexBusy。
        """
        if not self.lock.acquire(timeout=timeout):
            raise IndexBusy("索引正忙")
        try:
            n = self.db.delete_key(key)
            self.vstore.delete_key(key)
            wm = self.watermarks()
            if key in wm:
                del wm[key]
                self._save_wm(wm)
            return n
        finally:
            self.lock.release()

    def _run(self, now_ms: float | None) -> dict:
        now_ms = now_ms if now_ms is not None else time.time() * 1000
        self._refresh_names()
        segmenter = Segmenter(self.seg_cfg, self.embedder, self.names)
        wm = self.watermarks()
        added = 0
        result = {"keys": {}}
        try:
            for key in list_keys(self.paths.archive):
                f, off, line = self._start(key, wm)
                rows = read_rows(self.paths.archive, key, f, off, line)
                for r in rows:
                    self.names.observe(r)
                closed, open_seg = closed_segments(rows, now_ms, self.gap_ms)
                chunks = []
                for seg in closed:
                    chunks.extend(segmenter.chunk_segment(seg))
                if chunks:
                    vecs = self.embedder.embed_docs([c.text for c in chunks])
                    metas = [c.meta() for c in chunks]
                    self.vstore.upsert([c.id for c in chunks], vecs, metas, [c.text for c in chunks])
                    self.db.upsert([{"chunk_id": c.id, "text": c.text, **m} for c, m in zip(chunks, metas)], int(now_ms))
                    added += len(chunks)
                if closed:
                    nxt = open_seg[0] if open_seg else None
                    last = closed[-1][-1]
                    wm[key] = ({"file": nxt.file, "offset": nxt.offset, "line": nxt.line} if nxt
                               else {"file": last.file, "offset": last.end, "line": last.line + 1})
                    self._save_wm(wm)
                result["keys"][key] = {"new_rows": len(rows), "chunks": len(chunks), "open_rows": len(open_seg)}
            self.last = {"at": int(now_ms), "chunks": added, "error": None}
        except EmbeddingUnavailable as e:
            self.last = {"at": int(now_ms), "chunks": added, "error": f"embedding 不可用：{e}"}
        result.update(self.last)
        return result

    def lag(self) -> dict[str, int]:
        return {k: len(self.pending_rows(k)) for k in list_keys(self.paths.archive)}

    def reset(self) -> None:
        with self.lock:
            # RAG_PATCH（P3）：全量重建只清 L1（块、块向量、水位）；L2 的摘要留着，
            # 块重新写入后由提炼线程的对账按「块编号 + 原文哈希」挂回，不重复调模型（规格 A1-a）。
            self.db.clear(keep_l2=True)
            self.vstore.reset()
            try:
                self.wm_file.unlink()
            except FileNotFoundError:
                pass
