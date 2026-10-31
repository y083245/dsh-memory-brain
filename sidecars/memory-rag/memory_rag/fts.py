"""块表 + FTS5 全文索引（jieba 分词，bm25 打分）。

与 Chroma 同一批块、同一个块 ID，随增量索引一起写入/覆盖。块表同时是块元数据的「账」：
检索结果回原文、按会话过滤、统计都查这张表，不依赖 Chroma 的元数据查询能力。

关键词检索不再要求「全部命中」：查询词做 OR，命中越多、越稀有的词得分越高。
"""

from __future__ import annotations

import math
import re
import sqlite3
import threading
from pathlib import Path
from typing import Iterable, Sequence

import jieba

jieba.setLogLevel(60)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    t_start INTEGER NOT NULL,
    t_end INTEGER NOT NULL,
    day TEXT NOT NULL,
    speakers TEXT NOT NULL DEFAULT '',
    speaker_names TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    cut_reason TEXT NOT NULL DEFAULT '',
    file_start TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    file_end TEXT NOT NULL,
    line_end INTEGER NOT NULL,
    n_msgs INTEGER NOT NULL,
    distilled TEXT NOT NULL DEFAULT 'pending',
    text TEXT NOT NULL,
    indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_key_time ON chunks(key, t_start);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(tokens, chunk_id UNINDEXED, tokenize='unicode61 remove_diacritics 0');
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vocab USING fts5vocab(chunks_fts, 'row');
"""

# 只在查询侧去掉的高频虚词：语料小的时候 idf 压不住它们
STOPWORDS = set("的 了 吗 呢 吧 啊 呀 嘛 么 我 你 他 她 它 我们 你们 他们 是 有 在 说 那 这 那个 这个 就 都 也 和 跟 给 过 没 不 什么 怎么 哪 一 个 些 之前 以前 时候 一下 有没有 是不是 来着".split())
_SPLIT = re.compile(r"[\s\W_]+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    toks = []
    for t in jieba.cut_for_search(str(text or "").lower()):
        t = _SPLIT.sub("", t)
        if t:
            toks.append(t)
    return toks


def query_tokens(query: str = "", keywords: Sequence[str] = ()) -> list[str]:
    """查询词：keywords 原样（整词）+ keywords/query 的分词结果，去掉虚词，去重保序。"""
    out: list[str] = []
    for k in keywords or ():
        w = _SPLIT.sub("", str(k or "").lower())
        if w and len(w) >= 2:
            out.append(w)
        out.extend(tokenize(k))
    out.extend(tokenize(query))
    seen, res = set(), []
    for t in out:
        if t in STOPWORDS or t in seen:
            continue
        seen.add(t)
        res.append(t)
    return res


def add_words(words: Iterable[str]) -> None:
    """人名、昵称、黑话加进 jieba 词典，避免被切碎（「小鲸鱼」不该切成「小/鲸鱼」）。"""
    for w in words:
        w = str(w or "").strip()
        if len(w) >= 2:
            jieba.add_word(w, freq=200000)


class ChunkDB:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        # RAG_PATCH（P2）：删除时把释放的页和单元清零。否则删掉的块原文会留在数据库的空闲页里，
        # 用 SQL（或直接 grep 文件）还能翻出来。
        self.conn.execute("PRAGMA secure_delete=ON")
        self.conn.executescript(_SCHEMA)
        self.conn.commit()
        # RAG_PATCH（P3）：L2 表与 chunks 同库同锁，这里一并建好——任何 ChunkDB 都有它们。
        # 函数内 import：fts 与 l2 互相引用，模块级 import 会成环。
        from .l2 import ensure_schema
        ensure_schema(self.conn)
        try:
            path.chmod(0o600)
        except OSError:
            pass

    # ---------------------------------------------------------------- 元数据

    def get_meta(self, k: str) -> str | None:
        # FIX1031_PATCH：读也要持锁。这个连接是 check_same_thread=False 共享给所有线程的，
        # Python 的 sqlite3 只保证「单次 C 调用」互斥，不保证「一条语句」的完整性；而 VACUUM /
        # wal_checkpoint(TRUNCATE) 要求连接上不能有别的语句在跑（SQLITE_LOCKED），
        # 未消费完的游标还会被别的线程 reset 掉（TypeError / no more rows available）。
        # 所以凡是碰 conn 的地方一律走同一把 RLock，重建的隐私清理才不会撞上并发读。
        with self.lock:
            row = self.conn.execute("SELECT value FROM meta WHERE key=?", (k,)).fetchone()
        return None if row is None else str(row["value"])

    def set_meta(self, k: str, v: str) -> None:
        with self.lock:
            self.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)", (k, v))
            self.conn.commit()

    # ---------------------------------------------------------------- 写入

    def upsert(self, chunks: Sequence[dict], now_ms: int) -> None:
        """chunks: [{chunk_id, text, **meta}]；块表和 FTS 在同一个事务里写，块 ID 一致。"""
        with self.lock:
            cur = self.conn.cursor()
            for c in chunks:
                cur.execute("DELETE FROM chunks_fts WHERE chunk_id=?", (c["chunk_id"],))
                cur.execute(
                    """INSERT OR REPLACE INTO chunks
                       (chunk_id, key, t_start, t_end, day, speakers, speaker_names, title, cut_reason,
                        file_start, line_start, file_end, line_end, n_msgs, distilled, text, indexed_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (c["chunk_id"], c["key"], c["t_start"], c["t_end"], c["day"], c["speakers"],
                     c["speaker_names"], c.get("title", ""), c["cut_reason"], c["file_start"], c["line_start"],
                     c["file_end"], c["line_end"], c["n_msgs"], c.get("distilled", "pending"), c["text"], now_ms),
                )
                blob = " ".join(tokenize(f"{c.get('title', '')}\n{c['speaker_names']}\n{c['text']}"))
                cur.execute("INSERT INTO chunks_fts(tokens, chunk_id) VALUES (?,?)", (blob, c["chunk_id"]))
            self.conn.commit()

    def _purge(self) -> None:
        """RAG_PATCH（P2）：删完之后把 FTS 整理干净、把 WAL 截断。调用方已持有 self.lock。

        `optimize` 把 FTS5 的多个段合并成一个：只被删除的文档不会带进新段，旧段（含它们的词条）
        随之释放（secure_delete 会清零）。`wal_checkpoint(TRUNCATE)` 再把 WAL 写回主库并截断成
        0 字节——否则 WAL 里还留着删除前的页面副本，原文照样能捞出来。
        """
        # RAG_PATCH（P3）：L2 的摘要也进了 FTS，删摘要（遗忘、原文变了重来）后同样要把词条清干净
        self.conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
        self.conn.execute("INSERT INTO summaries_fts(summaries_fts) VALUES('optimize')")
        self.conn.commit()
        self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def clear(self, keep_l2: bool = False) -> None:
        """RAG_PATCH（P3）：默认连 L2 表一起清空；全量重建时传 keep_l2=True，摘要留着靠对账挂回。"""
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM chunks")
            cur.execute("DELETE FROM chunks_fts")
            if not keep_l2:
                from .l2 import clear_rows
                clear_rows(cur)
            self.conn.commit()
            self._purge()
            # VACUUM 不能在事务里跑：_purge 已经 commit 过了，这里可以安全执行。
            # 它把主库重写成新文件，彻底不留旧页；随后再把 VACUUM 自己写出的 WAL 截断一次。
            self.conn.execute("VACUUM")
            self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def delete_key(self, key: str) -> int:
        """RAG_PATCH（P2）：删掉一个会话的全部块（块表 + FTS），返回删掉的块数。

        FTS 表只按 chunk_id 索引，没有 key 列，所以先在块表里查出本会话的 chunk_id 再删。
        """
        with self.lock:
            cur = self.conn.cursor()
            # RAG_PATCH（P3）：L2 一起删；必须在删 chunks 之前（distill_state 只按 chunk_id 记）
            from .l2 import delete_key_rows
            delete_key_rows(cur, key)
            cur.execute("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE key=?)", (key,))
            cur.execute("DELETE FROM chunks WHERE key=?", (key,))
            n = int(cur.rowcount or 0)
            self.conn.commit()
            self._purge()
            return n

    # ---------------------------------------------------------------- 查询

    def get(self, ids: Sequence[str]) -> dict[str, dict]:
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        with self.lock:  # FIX1031_PATCH：理由见 get_meta
            rows = self.conn.execute(f"SELECT * FROM chunks WHERE chunk_id IN ({marks})", list(ids)).fetchall()
        return {r["chunk_id"]: dict(r) for r in rows}

    def bm25(self, key: str, tokens: Sequence[str], limit: int = 20,
             t_from: int | None = None, t_to: int | None = None) -> list[tuple[str, float]]:
        """返回 [(chunk_id, 分数)]，分数越大越相关。key 必填：会话隔离在 SQL 层就做掉。"""
        if not key:
            raise ValueError("key 必填")
        toks = [t.replace('"', '""') for t in tokens if t]
        if not toks:
            return []
        match = " OR ".join(f'"{t}"' for t in toks)
        sql = """SELECT c.chunk_id AS id, bm25(chunks_fts) AS s
                 FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
                 WHERE chunks_fts MATCH ? AND c.key = ?"""
        args: list = [match, key]
        if t_from is not None:
            sql += " AND c.t_end >= ?"
            args.append(int(t_from))
        if t_to is not None:
            sql += " AND c.t_start <= ?"
            args.append(int(t_to))
        sql += " ORDER BY s LIMIT ?"
        args.append(int(limit))
        try:
            with self.lock:  # FIX1031_PATCH：理由见 get_meta
                rows = self.conn.execute(sql, args).fetchall()
        except sqlite3.OperationalError:
            return []
        # SQLite 的 bm25() 越小越好（负数），翻成越大越好
        return [(r["id"], -float(r["s"])) for r in rows]

    def doc_freq(self, tokens: Sequence[str]) -> tuple[int, dict[str, int]]:
        # FIX1031_PATCH：两条语句要在同一把锁里取完，否则中间可能被重建的 clear() 插进来，
        # 拿到的总数和词频来自两个不同的时刻（理由见 get_meta）。
        with self.lock:
            n = int(self.conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"])
            if not tokens:
                return n, {}
            marks = ",".join("?" for _ in tokens)
            rows = self.conn.execute(f"SELECT term, doc FROM chunks_vocab WHERE term IN ({marks})", list(tokens)).fetchall()
        return n, {r["term"]: int(r["doc"]) for r in rows}

    def stats(self) -> dict:
        # FIX1031_PATCH：/health 每次轮询都会走这里；必须整段持锁，否则会和 clear() 里的
        # VACUUM / wal_checkpoint(TRUNCATE) 在同一个连接上交错（database table is locked）。
        with self.lock:
            total = int(self.conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"])
            per_key = {r["key"]: int(r["n"]) for r in self.conn.execute("SELECT key, COUNT(*) AS n FROM chunks GROUP BY key")}
            reasons = {r["cut_reason"]: int(r["n"]) for r in self.conn.execute("SELECT cut_reason, COUNT(*) AS n FROM chunks GROUP BY cut_reason")}
        return {"chunks": total, "per_key": per_key, "cut_reason": reasons}

    def total_chars(self) -> int:
        """APIHUB_PATCH：全部块正文的字数之和（给桥接估算重建量）。读也要持锁，理由同 stats。"""
        with self.lock:
            row = self.conn.execute("SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM chunks").fetchone()
        return int(row["n"] or 0)


def bm25_lines(lines: Sequence[str], tokens: Sequence[str], n_docs: int, df: dict[str, int],
               k1: float = 1.2, b: float = 0.75) -> list[float]:
    """给还没入库的「进行中」消息临时打分：行数很少，直接在内存里算。idf 借用已入库块的文档频率。"""
    if not lines or not tokens:
        return [0.0] * len(lines)
    docs = [tokenize(x) for x in lines]
    avgdl = sum(len(d) for d in docs) / max(1, len(docs)) or 1.0
    N = n_docs + len(lines)
    scores = []
    for d in docs:
        tf: dict[str, int] = {}
        for t in d:
            tf[t] = tf.get(t, 0) + 1
        s = 0.0
        for t in tokens:
            f = tf.get(t, 0)
            if not f:
                continue
            dfi = df.get(t, 0) + sum(1 for dd in docs if t in dd)
            idf = max(1e-6, math.log((N - dfi + 0.5) / (dfi + 0.5) + 1.0))
            s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * len(d) / avgdl))
        scores.append(s)
    return scores

