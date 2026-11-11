"""块表 + FTS5 全文索引（jieba 分词，bm25 打分）。

与 Chroma 同一批块、同一个块 ID，随增量索引一起写入/覆盖。块表同时是块元数据的「账」：
检索结果回原文、按会话过滤、统计都查这张表，不依赖 Chroma 的元数据查询能力。

关键词检索不再要求「全部命中」：查询词做 OR，命中越多、越稀有的词得分越高。
"""

from __future__ import annotations

import logging
import math
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterable, Sequence

import jieba

from .archive import is_channel_key

logger = logging.getLogger(__name__)

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
CREATE TABLE IF NOT EXISTS channel_terms (
    key TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, tokens TEXT NOT NULL,
    PRIMARY KEY (key, kind, id)
);
CREATE INDEX IF NOT EXISTS idx_channel_terms_id ON channel_terms(kind, id);
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


def write_terms(cur: sqlite3.Cursor, kind: str, key: str, doc_id: str, text: str) -> None:
    tokens = " ".join(tokenize(text))
    if is_channel_key(key):
        cur.execute("INSERT OR REPLACE INTO channel_terms(key, kind, id, tokens) VALUES (?,?,?,?)",
                    (key, kind, doc_id, tokens))
    elif kind == "chunk":
        cur.execute("DELETE FROM chunks_fts WHERE chunk_id=?", (doc_id,))
        cur.execute("INSERT INTO chunks_fts(tokens, chunk_id) VALUES (?,?)", (tokens, doc_id))
    else:
        cur.execute("DELETE FROM summaries_fts WHERE summary_id=?", (doc_id,))
        cur.execute("INSERT INTO summaries_fts(tokens, summary_id) VALUES (?,?)", (tokens, doc_id))


class ChunkDB:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        # UPGRADE_PATCH：先看数据版本，再决定动不动这个库（接口约定 §2.1）。
        # 比程序新 → 只读：连 journal_mode 都不设（改它会改文件头），也不建表；
        # query_only 是兜底，哪条写路径漏了拦截，SQLite 自己也会拒绝。
        from .migrations import LATEST, backup, migrate, user_version
        db_version = user_version(self.conn)
        self.readonly = db_version > LATEST
        self.migration: dict | None = None
        if self.readonly:
            self.conn.execute("PRAGMA query_only=ON")
            self.schema = {"db": db_version, "code": LATEST, "readonly": True}
            return
        # 老库（有表、版本号低）在建表 / 切 WAL 之前先备份，备份是原封不动的旧库
        bak = None
        if db_version < LATEST and self.conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]:
            bak = str(backup(self.conn, path, db_version))
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
        # Native BM25 uses the statistics of the whole FTS table, even with a key filter.
        # The temporary, memory-only corpus is loaded for one exact channel at a time.
        self.conn.execute("PRAGMA temp_store=MEMORY")
        self.conn.executescript("""
            CREATE VIRTUAL TABLE temp.scope_fts USING fts5(tokens, id UNINDEXED, tokenize='unicode61 remove_diacritics 0');
            CREATE VIRTUAL TABLE temp.scope_vocab USING fts5vocab(temp, scope_fts, 'row');
        """)
        # UPGRADE_PATCH：表都在了再按序迁移（备份已在上面做过，这里不再备份）
        if db_version < LATEST:
            self.migration = {**migrate(self.conn, path, has_data=False), "backup": bak}
        self.schema = {"db": user_version(self.conn), "code": LATEST, "readonly": False}
        try:
            path.chmod(0o600)
        except OSError:
            pass

    def check_writable(self) -> None:
        """UPGRADE_PATCH：只读模式（库比程序新）下所有写入口先调这个，抛 SchemaTooNew。"""
        if self.readonly:
            from .migrations import SchemaTooNew, readonly_message
            raise SchemaTooNew(readonly_message(int(self.schema["db"])))

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

    def set_meta(self, k: str, v: str, *, durable: bool = False) -> None:
        self.check_writable()  # UPGRADE_PATCH
        with self.lock:
            if durable:
                self.conn.execute("PRAGMA synchronous=FULL")
            try:
                with self.conn:
                    self.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)", (k, v))
            finally:
                if durable:
                    self.conn.execute("PRAGMA synchronous=NORMAL")

    def channel_keys(self, state_prefix: str) -> set[str]:
        with self.lock:
            rows = self.conn.execute("""
                SELECT substr(key, ?) AS key FROM meta WHERE key GLOB ?
                UNION SELECT key FROM chunks WHERE key GLOB 'c1_*'
                UNION SELECT key FROM summaries WHERE key GLOB 'c1_*'
            """, (len(state_prefix) + 1, state_prefix + "c1_*")).fetchall()
        return {r["key"] for r in rows if is_channel_key(r["key"])}

    # ---------------------------------------------------------------- 写入

    def upsert(self, chunks: Sequence[dict], now_ms: int) -> None:
        """chunks: [{chunk_id, text, **meta}]；块表和 FTS 在同一个事务里写，块 ID 一致。"""
        self.check_writable()  # UPGRADE_PATCH
        with self.lock, self.conn:
            cur = self.conn.cursor()
            for c in chunks:
                cur.execute(
                    """INSERT OR REPLACE INTO chunks
                       (chunk_id, key, t_start, t_end, day, speakers, speaker_names, title, cut_reason,
                        file_start, line_start, file_end, line_end, n_msgs, distilled, text, indexed_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (c["chunk_id"], c["key"], c["t_start"], c["t_end"], c["day"], c["speakers"],
                     c["speaker_names"], c.get("title", ""), c["cut_reason"], c["file_start"], c["line_start"],
                     c["file_end"], c["line_end"], c["n_msgs"], c.get("distilled", "pending"), c["text"], now_ms),
                )
                write_terms(cur, "chunk", c["key"], c["chunk_id"],
                            f"{c.get('title', '')}\n{c['speaker_names']}\n{c['text']}")

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
        # secure_delete 只清零被释放的单元；B 树重排页面时，页内未分配区域可能留着旧单元的字节，
        # 留不留取决于键的随机分布（CI 上偶发读到已遗忘的摘要）。只有 VACUUM 重写整个文件才算干净。
        self.conn.execute("VACUUM")
        self._truncate_wal()

    def _truncate_wal(self) -> None:
        """把 WAL 截断成 0 字节。检查点被别的读者挡住时 SQLite 不报错，只在结果里写 busy=1，所以要看结果重试。"""
        for _ in range(40):
            row = self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            if row is not None and row[0] == 0:
                return
            time.sleep(0.05)
        logger.warning("wal_checkpoint(TRUNCATE) 一直被挡住：WAL 里可能还留着已删内容，下一次检查点会清掉")

    def clear(self, keep_l2: bool = False) -> None:
        """RAG_PATCH（P3）：默认连 L2 表一起清空；全量重建时传 keep_l2=True，摘要留着靠对账挂回。"""
        self.check_writable()  # UPGRADE_PATCH
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM chunks")
            cur.execute("DELETE FROM chunks_fts")
            cur.execute("DELETE FROM channel_terms WHERE kind='chunk'")
            if not keep_l2:
                from .l2 import clear_rows
                clear_rows(cur)
            self.conn.commit()
            self._purge()

    def delete_key(self, key: str) -> int:
        """RAG_PATCH（P2）：删掉一个会话的全部块（块表 + FTS），返回删掉的块数。

        FTS 表只按 chunk_id 索引，没有 key 列，所以先在块表里查出本会话的 chunk_id 再删。
        """
        self.check_writable()  # UPGRADE_PATCH
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
        channel = is_channel_key(key)
        table, id_col = ("scope_fts", "id") if channel else ("chunks_fts", "chunk_id")
        sql = f"""SELECT c.chunk_id AS id, bm25({table}) AS s
                 FROM {table} JOIN chunks c ON c.chunk_id = {table}.{id_col}
                 WHERE {table} MATCH ? AND c.key = ?"""
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
            rows = self.fts_query(sql, args, scope=(key, "chunk") if channel else None)
        except sqlite3.OperationalError:
            return []
        # SQLite 的 bm25() 越小越好（负数），翻成越大越好
        return [(r["id"], -float(r["s"])) for r in rows]

    def fts_query(self, sql: str, args: Sequence, scope: tuple[str, str] | None = None) -> list:
        with self.lock:
            if scope is None:
                return self.conn.execute(sql, args).fetchall()
            # Roll back the temporary INSERT even when SQL fails. The shared connection
            # lock ensures no reader or writer can see another channel's temporary terms.
            self.conn.execute("SAVEPOINT scope_fts_query")
            try:
                self.conn.execute("INSERT INTO scope_fts(tokens,id) SELECT tokens,id FROM channel_terms WHERE key=? AND kind=?", scope)
                return self.conn.execute(sql, args).fetchall()
            finally:
                self.conn.execute("ROLLBACK TO scope_fts_query")
                self.conn.execute("RELEASE scope_fts_query")

    def doc_freq(self, tokens: Sequence[str], key: str | None = None) -> tuple[int, dict[str, int]]:
        # FIX1031_PATCH：两条语句要在同一把锁里取完，否则中间可能被重建的 clear() 插进来，
        # 拿到的总数和词频来自两个不同的时刻（理由见 get_meta）。
        with self.lock:
            channel = key is not None and is_channel_key(key)
            n = int(self.conn.execute("SELECT COUNT(*) AS n FROM chunks WHERE key=?" if channel else
                                      "SELECT COUNT(*) AS n FROM chunks WHERE key NOT GLOB 'c1_*'",
                                      (key,) if channel else ()).fetchone()["n"])
            if not tokens:
                return n, {}
            marks = ",".join("?" for _ in tokens)
            vocab = "scope_vocab" if channel else "chunks_vocab"
            rows = self.fts_query(f"SELECT term, doc FROM {vocab} WHERE term IN ({marks})", list(tokens),
                                  scope=(key, "chunk") if channel else None)
        return n, {r["term"]: int(r["doc"]) for r in rows}

    def stats(self) -> dict:
        # FIX1031_PATCH：/health 每次轮询都会走这里；必须整段持锁，否则会和 clear() 里的
        # VACUUM / wal_checkpoint(TRUNCATE) 在同一个连接上交错（database table is locked）。
        with self.lock:
            total = int(self.conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"])
            per_key = {r["key"]: int(r["n"]) for r in self.conn.execute("SELECT key, COUNT(*) AS n FROM chunks GROUP BY key")}
            reasons = {r["cut_reason"]: int(r["n"]) for r in self.conn.execute("SELECT cut_reason, COUNT(*) AS n FROM chunks GROUP BY cut_reason")}
        return {"chunks": total, "per_key": per_key, "cut_reason": reasons}

    # ---------------------------------------------------------------- 实时脑图（BRAIN_PATCH）

    def graph_chunks(self, keys: Sequence[str] | None, limit: int) -> tuple[list[dict], int]:
        """BRAIN_PATCH：脑图用的块元数据，按 t_end 取最新 limit 条，返回 (块, 没返回的条数)。

        **故意不 SELECT text**：脑图快照里不能有原文（规格 §12 Q1），在 SQL 层就不取，
        免得以后有人顺手把整行 dict 吐出去。keys 为 None = 全部会话；空列表 = 什么都不给。
        speakers / speaker_names 在库里是逗号拼接（segmenter.Chunk.meta），照 distill.py 的读法拆。
        """
        where, args = " WHERE key NOT GLOB 'c1_*'", []
        if keys is not None:
            keys = [str(k) for k in keys]
            if not keys:
                return [], 0
            where = f" WHERE key IN ({','.join('?' for _ in keys)})"
            args = list(keys)
        with self.lock:  # FIX1031_PATCH：理由见 get_meta；计数与取行在同一把锁里，两者一致
            total = int(self.conn.execute(f"SELECT COUNT(*) AS n FROM chunks{where}", args).fetchone()["n"])
            rows = self.conn.execute(
                "SELECT chunk_id, key, day, t_start, t_end, title, n_msgs, speakers, speaker_names "
                f"FROM chunks{where} ORDER BY t_end DESC, chunk_id ASC LIMIT ?", [*args, int(limit)],
            ).fetchall()
        out = [{"chunk_id": r["chunk_id"], "key": r["key"], "day": r["day"],
                "t_start": int(r["t_start"]), "t_end": int(r["t_end"]), "title": r["title"],
                "n_msgs": int(r["n_msgs"]),
                "speakers": [s for s in str(r["speakers"] or "").split(",") if s],
                "speaker_names": [s for s in str(r["speaker_names"] or "").split(",") if s]}
               for r in rows]
        return out, max(0, total - len(out))

    def chunk_text(self, key: str, chunk_id: str) -> dict | None:
        """BRAIN_PATCH：单块含原文（控制台点开某个话题块时才取）。key 不匹配与不存在一样返回 None。"""
        if not key or not chunk_id:
            return None
        with self.lock:  # FIX1031_PATCH：理由见 get_meta
            r = self.conn.execute(
                "SELECT chunk_id, key, day, title, t_start, t_end, n_msgs, text FROM chunks "
                "WHERE chunk_id=? AND key=?", (str(chunk_id), str(key))).fetchone()
        if r is None:
            return None
        return {"chunk_id": r["chunk_id"], "key": r["key"], "day": r["day"], "title": r["title"],
                "t_start": int(r["t_start"]), "t_end": int(r["t_end"]), "n_msgs": int(r["n_msgs"]),
                "text": r["text"]}

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

