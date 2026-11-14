"""增量索引：存档 → 切块 → 向量库 + FTS5 双写。

水位（watermarks.json）记的是每个会话「下一条还没入库的消息」在哪个文件、哪个字节、第几行。
只有已结束的段才切块入库；写入成功后才推进水位，崩溃重来不丢不重（块 ID 确定，重写即覆盖）。
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .archive import (ChannelArchiveChanged, ChannelArchiveError, NameBook, Row, RowCache, channel_snapshot,
                      is_channel_key, key_dir, key_files, list_keys, read_rows)
from .embeddings import Embedder, EmbeddingUnavailable
from .fts import ChunkDB, add_words
from .migrations import remove_backups
from .segmenter import Segmenter, closed_segments
from .store import VectorStore


class IndexBusy(RuntimeError):
    """拿不到索引锁：调用方决定是重试、降级还是回 409/503。"""


class ChannelIndexUnavailable(RuntimeError):
    """The archive no longer proves that this channel's derived views are current."""


ARCHIVE_PROTOCOL = {"identity": 1, "archive": 2, "index": 1}
CHANNEL_STATE_PREFIX = "channel:index:"
FILE_NAME = re.compile(r"(?:[0-9]{4}|\+[0-9]{6})-(?:0[1-9]|1[0-2])\.jsonl")
SHA256 = re.compile(r"[0-9a-f]{64}")


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
        # watermarks.json 的读（/health -> lag -> pending_rows）与写（_save_wm 的 os.replace）
        # 必须串行：Windows 上 os.replace 目标文件正被别的线程以普通读方式打开时会
        # WinError 5（拒绝访问），而 health 每 2 秒就会读一次。单独一把 RLock，避免
        # 与索引主锁 self.lock 形成非重入死锁。
        self.wm_lock = threading.RLock()
        self.last: dict = {"at": None, "chunks": 0, "error": None}
        self._people_mtime = None
        self.names = NameBook(self.paths.people, self.paths.archive)
        self.rows = RowCache(self.paths.archive)
        add_words(self.names.all_names())
        add_words(confirmed_slang(self.paths.state / "slang.json"))

    # ---------------------------------------------------------------- 水位

    def watermarks(self) -> dict:
        with self.wm_lock:
            try:
                return json.loads(self.wm_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return {}

    def _save_wm(self, wm: dict) -> None:
        with self.wm_lock:
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
        if is_channel_key(key):
            _, state = self._channel_state(key)
            return read_rows(self.paths.archive, key, *self._channel_cursor(state))
        f, off, line = self._start(key, self.watermarks())
        return read_rows(self.paths.archive, key, f, off, line)

    def _channel_state(self, key: str) -> tuple[str | None, dict]:
        raw = self.db.get_meta(CHANNEL_STATE_PREFIX + key)
        try:
            state = json.loads(raw) if raw else None
            if self._valid_channel_state(key, state):
                return raw, state
        except ValueError:
            pass
        return raw, {}

    @staticmethod
    def _valid_channel_state(key: str, state) -> bool:
        if (not isinstance(state, dict) or type(state.get("version")) is not int
                or state["version"] != ARCHIVE_PROTOCOL["index"] or not isinstance(state.get("generation"), str)):
            return False
        status = state.get("status")
        if status in ("dirty", "cleared"):
            return True
        if status != "ready" or not isinstance(state.get("snapshot"), dict) or "cursor" not in state:
            return False
        snapshot = state["snapshot"]
        scope = key_dir(key) + "/"
        for rel, item in snapshot.items():
            if (not rel.startswith(scope) or not FILE_NAME.fullmatch(rel[len(scope):]) or not isinstance(item, dict)
                    or type(item.get("bytes")) is not int or not 0 < item["bytes"] < 2**53
                    or not isinstance(item.get("sha256"), str) or not SHA256.fullmatch(item["sha256"])):
                return False
        cursor = state["cursor"]
        return cursor is None or (isinstance(cursor, dict) and isinstance(cursor.get("file"), str)
                                  and cursor["file"] in snapshot and type(cursor.get("offset")) is int
                                  and 0 <= cursor["offset"] <= snapshot[cursor["file"]]["bytes"]
                                  and type(cursor.get("line")) is int and 1 <= cursor["line"] <= cursor["offset"] + 1)

    def _save_channel_state(self, key: str, **fields) -> None:
        self.db.set_meta(CHANNEL_STATE_PREFIX + key, json.dumps({
            "version": ARCHIVE_PROTOCOL["index"], "generation": uuid.uuid4().hex, **fields,
        }), durable=True)

    @staticmethod
    def _channel_cursor(state: dict) -> tuple[str | None, int, int]:
        cursor = state.get("cursor")
        return (cursor["file"], cursor["offset"], cursor["line"]) if cursor else (None, 0, 1)

    def channel_proof(self, key: str, previous: tuple[str, dict] | None = None) -> tuple[str, dict]:
        """Compare published content and the committed generation before and after assembly."""
        raw, state = self._channel_state(key)
        if (self.db.readonly or not raw or state.get("status") != "ready"
                or (previous is not None and raw != previous[0])):
            raise ChannelIndexUnavailable()
        try:
            base = state["snapshot"] if previous is None else previous[1]
            current, compatible = channel_snapshot(self.paths.archive, key, base)
        except ChannelArchiveError as e:
            raise ChannelIndexUnavailable() from e
        if (not compatible or (previous is not None and current != previous[1])
                or raw != self.db.get_meta(CHANNEL_STATE_PREFIX + key)):
            raise ChannelIndexUnavailable()
        return raw, current

    @contextmanager
    def channel_read(self, key: str):
        if not is_channel_key(key):
            yield
            return
        proof = self.channel_proof(key)
        try:
            yield
        except ChannelArchiveError as e:
            raise ChannelIndexUnavailable() from e
        self.channel_proof(key, proof)

    def _purge_channel(self, key: str) -> int:
        # Dirty is committed before touching either backend. After an interruption,
        # repeating the entire scoped purge is safe even if one backend already finished.
        self._save_channel_state(key, status="dirty")
        self.rows.invalidate(key)
        n = self.db.delete_key(key)
        self.vstore.delete_key(key)
        remove_backups(self.db.path)
        self._save_channel_state(key, status="cleared")
        return n

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
            if is_channel_key(key):
                return self._purge_channel(key)
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
        added, error = 0, None
        result = {"keys": {}}
        archive_keys = list_keys(self.paths.archive)
        try:
            for key in archive_keys:
                if is_channel_key(key):
                    continue
                f, off, line = self._start(key, wm)
                rows = read_rows(self.paths.archive, key, f, off, line)
                for r in rows:
                    self.names.observe(r)
                stats, cursor = self._write_rows(rows, segmenter, now_ms)
                added += stats["chunks"]
                if cursor is not None:
                    wm[key] = cursor
                    self._save_wm(wm)
                result["keys"][key] = stats
        except EmbeddingUnavailable as e:
            error = f"embedding 不可用：{e}"
        # A previously indexed channel still needs purging if its directory disappears
        # or becomes invalid and is no longer discoverable through the archive.
        indexed_channels = self.db.channel_keys(CHANNEL_STATE_PREFIX)
        channels = {key for key in archive_keys if is_channel_key(key)} | indexed_channels
        for key in sorted(channels):
            try:
                stats = self._index_channel(key, segmenter, now_ms, key in indexed_channels)
            except (ChannelArchiveError, ChannelIndexUnavailable, EmbeddingUnavailable) as e:
                result["keys"][key] = {"error": type(e).__name__}
                continue
            result["keys"][key] = stats
            added += stats["chunks"]
        self.last = {"at": int(now_ms), "chunks": added, "error": error}
        result.update(self.last)
        return result

    def _write_rows(self, rows: list[Row], segmenter: Segmenter, now_ms: float,
                    before_embed=None, before_write=None) -> tuple[dict, dict | None]:
        closed, open_seg = closed_segments(rows, now_ms, self.gap_ms)
        chunks = [chunk for seg in closed for chunk in segmenter.chunk_segment(seg)]
        if chunks:
            if before_embed is not None:
                before_embed()
            vecs = self.embedder.embed_docs([c.text for c in chunks])
            if before_write is not None:
                before_write()
            metas = [c.meta() for c in chunks]
            self.vstore.upsert([c.id for c in chunks], vecs, metas, [c.text for c in chunks])
            self.db.upsert([{"chunk_id": c.id, "text": c.text, **m} for c, m in zip(chunks, metas)], int(now_ms))
        cursor = None
        if closed:
            nxt = open_seg[0] if open_seg else None
            last = closed[-1][-1]
            cursor = ({"file": nxt.file, "offset": nxt.offset, "line": nxt.line} if nxt
                      else {"file": last.file, "offset": last.end, "line": last.line + 1})
        return {"new_rows": len(rows), "chunks": len(chunks), "open_rows": len(open_seg)}, cursor

    def _index_channel(self, key: str, segmenter: Segmenter, now_ms: float, has_state: bool) -> dict:
        _, state = self._channel_state(key)
        previous = state.get("snapshot") if state.get("status") == "ready" else None
        try:
            snapshot, append_only = channel_snapshot(self.paths.archive, key, previous)
            if has_state and state.get("status") != "cleared" and (previous is None or not append_only):
                self._purge_channel(key)
                state = {}
            rows = read_rows(self.paths.archive, key, *self._channel_cursor(state), trusted_cursor=True)

            def confirm(allow_append: bool = True) -> None:
                latest, compatible = channel_snapshot(self.paths.archive, key, snapshot)
                if not compatible or (not allow_append and latest != snapshot):
                    raise ChannelIndexUnavailable()

            def begin_write() -> None:
                confirm()
                self._save_channel_state(key, status="dirty")

            # Pin the rows to the initial snapshot before cutting or embedding them.
            # Later tail appends can wait for the next run while this verified prefix commits.
            confirm(allow_append=False)
            stats, cursor = self._write_rows(rows, segmenter, now_ms,
                                             before_embed=confirm, before_write=begin_write)
            confirm()
            if cursor is not None or snapshot != previous or state.get("status") != "ready":
                self._save_channel_state(key, status="ready", snapshot=snapshot, cursor=cursor or state.get("cursor"))
            return stats
        except ChannelArchiveChanged:
            raise
        except ChannelArchiveError:
            if has_state and self._channel_state(key)[1].get("status") != "cleared":
                self._purge_channel(key)
            raise

    def lag(self) -> dict[str, int]:
        out = {}
        for key in list_keys(self.paths.archive):
            try:
                out[key] = len(self.pending_rows(key))
            except ChannelArchiveError:
                continue
        return out

    def reset(self) -> None:
        with self.lock:
            for key in self.db.channel_keys(CHANNEL_STATE_PREFIX):
                self._purge_channel(key)
            # RAG_PATCH（P3）：全量重建只清 L1（块、块向量、水位）；L2 的摘要留着，
            # 块重新写入后由提炼线程的对账按「块编号 + 原文哈希」挂回，不重复调模型（规格 A1-a）。
            self.db.clear(keep_l2=True)
            self.vstore.reset()
            with self.wm_lock:
                try:
                    self.wm_file.unlink()
                except FileNotFoundError:
                    pass
