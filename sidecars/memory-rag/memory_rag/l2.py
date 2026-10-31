"""L2：话题块的摘要、实体与关系（RAG_PATCH（P3））。

L1 是块（`chunks` + `chunks_fts` + Chroma 的 `chunks` 集合）：原话与它的向量。
L2 是提炼出来的东西：每块一条摘要、摘要里的实体、实体之间的关系。和 L1 同库同锁
（`ChunkDB.conn` / `ChunkDB.lock`），所以遗忘、重建这些操作能在同一个事务里做完。

几条不变量：

- **文字只在 SQLite**：Chroma 的 `summaries` 集合只放向量和 `key / t_start / t_end`（P2 的教训：
  Chroma 的预写日志会长期保留载荷，删块也删不掉）。
- **摘要按「块编号 + 块原文哈希」挂**：全量重建时原文没变的块直接挂回旧摘要，不再调一次模型
  （规格 A1-a）；原文变了就删掉旧摘要重来。
- **读接口全部按会话 key 过滤**：从群里的实体只能走到群里的摘要，没有「不带 key 查摘要」的入口。
- 写操作一律在 `db.lock` 里、一个事务、最后 `commit`。

接口约定 C1：`l2.py` 的名字、参数、返回形状被 worker P2 直接使用，不能单方面改。
"""

from __future__ import annotations

import hashlib
import sqlite3
import unicodedata
from typing import TYPE_CHECKING, Sequence

if TYPE_CHECKING:  # 只为了类型提示：运行时不 import，避免 fts ↔ l2 循环引用
    from .fts import ChunkDB

SELF = "self"
ENTITY_TYPES = ("person", "place", "thing", "topic")

# 失败重试：第 1 次 10 分钟后，第 2 次 1 小时后，第 3 次标 failed
MAX_ATTEMPTS = 3
RETRY_MS = (10 * 60_000, 60 * 60_000)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS summaries (
  summary_id TEXT PRIMARY KEY,
  chunk_id   TEXT NOT NULL UNIQUE,
  key        TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  t_start INTEGER NOT NULL, t_end INTEGER NOT NULL, day TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL,
  importance REAL NOT NULL, valence REAL NOT NULL,
  model TEXT NOT NULL, created_at INTEGER NOT NULL,
  vec_state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_summaries_key_time ON summaries(key, t_end);
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(tokens, summary_id UNINDEXED, tokenize='unicode61 remove_diacritics 0');
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  norm TEXT NOT NULL,
  qq TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_norm ON entities(norm);
CREATE TABLE IF NOT EXISTS summary_entities (
  summary_id TEXT NOT NULL, entity_id TEXT NOT NULL, key TEXT NOT NULL,
  PRIMARY KEY (summary_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_se_entity_key ON summary_entities(entity_id, key);
CREATE TABLE IF NOT EXISTS relations (
  summary_id TEXT NOT NULL, key TEXT NOT NULL,
  src_id TEXT NOT NULL, dst_id TEXT NOT NULL, relation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS distill_state (
  chunk_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
);
-- SUGGEST_PATCH：账本建议（LEDGER_SUGGEST_SPEC §3.3）。候选文字和摘要同等对待：只在 SQLite，
-- 跟着摘要一起删；Chroma 不动、不存候选（坑 17：预写日志会长期保留载荷）。
CREATE TABLE IF NOT EXISTS ledger_notes (
  note_id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL,
  key TEXT NOT NULL,
  who TEXT NOT NULL,
  who_name TEXT NOT NULL DEFAULT '',
  cat TEXT NOT NULL,
  text TEXT NOT NULL,
  due TEXT,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_key_time ON ledger_notes(key, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_summary ON ledger_notes(summary_id);
-- SUGGEST_PATCH：每条摘要「抽没抽过候选」。上线前的旧摘要没有这一行 = 没抽过（回补的对象）。
CREATE TABLE IF NOT EXISTS notes_state (
  summary_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_state ON notes_state(state);
"""

_SUMMARY_COLS = ("summary_id", "chunk_id", "key", "t_start", "t_end", "day",
                 "title", "summary", "importance", "valence")


# ---------------------------------------------------------------- 编号与规范化


def text_hash(text: str) -> str:
    """块原文的哈希：块原文一变（比如账本改了称呼），挂在上面的摘要就不再有效。"""
    return hashlib.sha1(str(text or "").encode("utf-8")).hexdigest()


def summary_id_for(chunk_id: str, th: str) -> str:
    return "S" + hashlib.sha1(f"{chunk_id}|{th}".encode("utf-8")).hexdigest()[:16]


def note_id_for(summary_id: str, index: int) -> str:
    """SUGGEST_PATCH：候选的稳定编号 = 摘要编号 + 本块里的序号。

    摘要按「块编号 + 原文哈希」挂回，所以全量重建后原文没变的块 summary_id 不变，
    note_id 也就跟着不变——桥接状态文件里存的编号不会对不上（规格 §3.3 / 接口约定 §1）。
    """
    return hashlib.sha1(f"{summary_id}:{int(index)}".encode("utf-8")).hexdigest()[:16]


def normalize_name(s: str) -> str:
    """去掉 emoji、标点、符号、空白后转小写：实体名比对与编号都用它。

    用 unicodedata 的类别判断而不是写死一串标点：emoji 散落在 So/Sk 等好几个区段，
    中文标点又是 Pf/Po，按类别一刀切才不会漏。
    """
    out = []
    for ch in str(s or ""):
        if unicodedata.category(ch)[0] in ("P", "S", "Z", "C"):
            continue
        out.append(ch.lower())
    return "".join(out)


def hubs_for_key(key: str) -> set[str]:
    """枢纽点：连接一切、区分不了话题，联想与图谱都要把它们去掉。

    「她」是所有会话共有的点；私聊里对方本人是那个会话的枢纽点（私聊的每一块都提到他）。
    群会话只去掉 `self`：群里的每个人只出现在部分话题里，是有信息量的。"""
    hubs = {SELF}
    k = str(key or "")
    if k.startswith("private:") and k.split(":", 1)[1].isdigit():
        hubs.add(f"qq:{k.split(':', 1)[1]}")
    return hubs


def ensure_schema(conn: sqlite3.Connection) -> None:
    """建 L2 表：`ChunkDB.__init__` 会调用，所以任何时候的 `ChunkDB` 都有这些表。可重复调用。"""
    conn.executescript(_SCHEMA)
    conn.commit()


# ---------------------------------------------------------------- 内部小工具


def _marks(n: int) -> str:
    return ",".join("?" for _ in range(n))


def _summary(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in _SUMMARY_COLS}


def _delete_summary_rows(cur: sqlite3.Cursor, summary_id: str) -> None:
    """删一条摘要本身，以及它挂的 FTS、实体关联、关系。向量由调用方删（它才知道 vstore）。

    SUGGEST_PATCH：账本建议跟着摘要走——候选与抽没抽过的状态一起删，否则删掉的聊天
    还会从候选里漏出来（规格 §3.4）。
    """
    cur.execute("DELETE FROM summaries_fts WHERE summary_id=?", (summary_id,))
    cur.execute("DELETE FROM summary_entities WHERE summary_id=?", (summary_id,))
    cur.execute("DELETE FROM relations WHERE summary_id=?", (summary_id,))
    cur.execute("DELETE FROM ledger_notes WHERE summary_id=?", (summary_id,))
    cur.execute("DELETE FROM notes_state WHERE summary_id=?", (summary_id,))
    cur.execute("DELETE FROM summaries WHERE summary_id=?", (summary_id,))


def _delete_orphan_entities(cur: sqlite3.Cursor) -> None:
    """删掉不再被任何摘要引用的实体。实体名本身可能就是隐私（一个地名），不等以后的治理。"""
    cur.execute("DELETE FROM entities WHERE entity_id NOT IN (SELECT entity_id FROM summary_entities)")


def _write_note_rows(cur: sqlite3.Cursor, summary_id: str, key: str, notes: Sequence[dict],
                     source: str, now_ms: int) -> int:
    """SUGGEST_PATCH：写一条摘要的候选并标 `notes_state=done`（调用方已在事务里、已持锁）。

    同一摘要重写时先删旧候选——候选是按序号编号的，不清掉会混进上一次抽出来的条目。
    返回写进去的条数。
    """
    kept = list(notes or ())[:3]
    cur.execute("DELETE FROM ledger_notes WHERE summary_id=?", (summary_id,))
    for i, n in enumerate(kept):
        cur.execute(
            "INSERT OR REPLACE INTO ledger_notes"
            "(note_id, summary_id, key, who, who_name, cat, text, due, created_at, source) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (note_id_for(summary_id, i), summary_id, key, str(n.get("who") or ""),
             str(n.get("who_name") or ""), str(n.get("cat") or ""), str(n.get("text") or ""),
             None if n.get("due") is None else str(n.get("due")), int(now_ms), str(source)),
        )
    cur.execute("INSERT OR REPLACE INTO notes_state(summary_id, state, attempts, at) VALUES (?,'done',0,?)",
                (summary_id, int(now_ms)))
    return len(kept)


# ---------------------------------------------------------------- 给 fts.py 用（调用方已持锁）


def delete_key_rows(cur: sqlite3.Cursor, key: str) -> None:
    """删一个会话的全部 L2 行，再清掉孤儿实体。

    必须在删 `chunks` **之前**调用：`distill_state` 只按 chunk_id 记，要靠 `chunks` 子查询才能找到。
    """
    cur.execute("DELETE FROM summaries_fts WHERE summary_id IN (SELECT summary_id FROM summaries WHERE key=?)", (key,))
    cur.execute("DELETE FROM summary_entities WHERE key=?", (key,))
    cur.execute("DELETE FROM relations WHERE key=?", (key,))
    cur.execute("DELETE FROM distill_state WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE key=?)", (key,))
    # SUGGEST_PATCH：候选按 key 删；notes_state 没有 key 列，只能按本会话的摘要编号删——
    # 必须在删 summaries 之前做，否则子查询就空了（规格 §3.4）。
    cur.execute("DELETE FROM ledger_notes WHERE key=?", (key,))
    cur.execute("DELETE FROM notes_state WHERE summary_id IN (SELECT summary_id FROM summaries WHERE key=?)", (key,))
    cur.execute("DELETE FROM summaries WHERE key=?", (key,))
    _delete_orphan_entities(cur)


def clear_rows(cur: sqlite3.Cursor) -> None:
    """清空全部 L2 表（`ChunkDB.clear()` 默认也清 L2；全量重建时用 keep_l2=True 跳过）。"""
    for t in ("summaries_fts", "summary_entities", "relations", "distill_state",
              "ledger_notes", "notes_state", "summaries", "entities"):
        cur.execute(f"DELETE FROM {t}")


class L2:
    def __init__(self, db: "ChunkDB"):
        self.db = db
        self.conn = db.conn
        self.lock = db.lock

    # ---------------------------------------------------------------- 读（P2 用）

    def get_summaries(self, key: str, ids: Sequence[str]) -> dict[str, dict]:
        ids = [str(i) for i in (ids or ()) if i]
        if not key or not ids:
            return {}
        with self.lock:
            rows = self.conn.execute(
                f"SELECT {', '.join(_SUMMARY_COLS)} FROM summaries WHERE key=? AND summary_id IN ({_marks(len(ids))})",
                [key, *ids],
            ).fetchall()
        return {r["summary_id"]: _summary(r) for r in rows}

    def summaries_by_chunks(self, key: str, chunk_ids: Sequence[str]) -> dict[str, dict]:
        ids = [str(i) for i in (chunk_ids or ()) if i]
        if not key or not ids:
            return {}
        with self.lock:
            rows = self.conn.execute(
                f"SELECT {', '.join(_SUMMARY_COLS)} FROM summaries WHERE key=? AND chunk_id IN ({_marks(len(ids))})",
                [key, *ids],
            ).fetchall()
        return {r["chunk_id"]: _summary(r) for r in rows}

    def summary_covering(self, key: str, t_ms: int) -> dict | None:
        if not key:
            return None
        with self.lock:
            row = self.conn.execute(
                f"SELECT {', '.join(_SUMMARY_COLS)} FROM summaries "
                "WHERE key=? AND t_start<=? AND t_end>=? ORDER BY t_end DESC LIMIT 1",
                (key, int(t_ms), int(t_ms)),
            ).fetchone()
        return _summary(row) if row else None

    def entities_of(self, key: str, summary_ids: Sequence[str]) -> dict[str, list[str]]:
        ids = [str(i) for i in (summary_ids or ()) if i]
        if not key or not ids:
            return {}
        with self.lock:
            rows = self.conn.execute(
                f"SELECT summary_id, entity_id FROM summary_entities WHERE key=? AND summary_id IN ({_marks(len(ids))})",
                [key, *ids],
            ).fetchall()
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r["summary_id"], []).append(r["entity_id"])
        return out

    def entities_in_text(self, key: str, text: str, min_len: int = 2) -> list[str]:
        """本会话有关联的实体里，名字（规范化后）是这段文字子串的那些。按 norm 长度降序。"""
        if not key:
            return []
        hay = normalize_name(text)
        if not hay:
            return []
        with self.lock:
            rows = self.conn.execute(
                "SELECT DISTINCT e.entity_id AS entity_id, e.norm AS norm FROM entities e "
                "JOIN summary_entities se ON se.entity_id = e.entity_id "
                "WHERE se.key=? AND length(e.norm) >= ?",
                (key, int(min_len)),
            ).fetchall()
        hit = {r["entity_id"]: r["norm"] for r in rows if r["norm"] and r["norm"] in hay}
        return sorted(hit, key=lambda i: (-len(hit[i]), hit[i]))

    def linked_summaries(self, key: str, entity_ids: Sequence[str], exclude_ids: Sequence[str] = (),
                         t_end_lte: int | None = None) -> dict[str, list[str]]:
        """{summary_id: [和 entity_ids 共享的实体]}；只看本会话。"""
        ents = [str(i) for i in (entity_ids or ()) if i]
        if not key or not ents:
            return {}
        sql = ("SELECT se.summary_id AS summary_id, se.entity_id AS entity_id "
               "FROM summary_entities se JOIN summaries s ON s.summary_id = se.summary_id "
               f"WHERE se.key=? AND s.key=? AND se.entity_id IN ({_marks(len(ents))})")
        args: list = [key, key, *ents]
        extra = [str(i) for i in (exclude_ids or ()) if i]
        if extra:
            sql += f" AND se.summary_id NOT IN ({_marks(len(extra))})"
            args.extend(extra)
        if t_end_lte is not None:
            sql += " AND s.t_end <= ?"
            args.append(int(t_end_lte))
        with self.lock:
            rows = self.conn.execute(sql, args).fetchall()
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r["summary_id"], []).append(r["entity_id"])
        return out

    def entity_df(self, key: str, entity_ids: Sequence[str]) -> dict[str, int]:
        ents = [str(i) for i in (entity_ids or ()) if i]
        if not key or not ents:
            return {}
        with self.lock:
            rows = self.conn.execute(
                f"SELECT entity_id, COUNT(*) AS n FROM summary_entities WHERE key=? AND entity_id IN ({_marks(len(ents))}) "
                "GROUP BY entity_id",
                [key, *ents],
            ).fetchall()
        return {r["entity_id"]: int(r["n"]) for r in rows}

    def count_summaries(self, key: str) -> int:
        if not key:
            return 0
        with self.lock:
            return int(self.conn.execute("SELECT COUNT(*) AS n FROM summaries WHERE key=?", (key,)).fetchone()["n"])

    def bm25_summaries(self, key: str, tokens: Sequence[str], limit: int = 20,
                       t_end_lte: int | None = None) -> list[tuple[str, float]]:
        """[(summary_id, 分数)]，分数越大越相关（同 `ChunkDB.bm25` 的 OR 查询与翻符号做法）。"""
        if not key:
            raise ValueError("key 必填")
        toks = [str(t).replace('"', '""') for t in tokens if t]
        if not toks:
            return []
        match = " OR ".join(f'"{t}"' for t in toks)
        sql = ("SELECT s.summary_id AS id, bm25(summaries_fts) AS sc "
               "FROM summaries_fts JOIN summaries s ON s.summary_id = summaries_fts.summary_id "
               "WHERE summaries_fts MATCH ? AND s.key=?")
        args: list = [match, key]
        if t_end_lte is not None:
            sql += " AND s.t_end <= ?"
            args.append(int(t_end_lte))
        sql += " ORDER BY sc LIMIT ?"
        args.append(int(limit))
        try:
            with self.lock:
                rows = self.conn.execute(sql, args).fetchall()
        except sqlite3.OperationalError:
            return []
        return [(r["id"], -float(r["sc"])) for r in rows]

    def entity_names(self, entity_ids: Sequence[str]) -> dict[str, str]:
        ids = [str(i) for i in (entity_ids or ()) if i]
        if not ids:
            return {}
        with self.lock:
            rows = self.conn.execute(
                f"SELECT entity_id, name FROM entities WHERE entity_id IN ({_marks(len(ids))})", ids).fetchall()
        return {r["entity_id"]: r["name"] for r in rows}

    def stats(self) -> dict:
        with self.lock:
            def n(sql: str) -> int:
                return int(self.conn.execute(sql).fetchone()["n"])
            return {
                "summaries": n("SELECT COUNT(*) AS n FROM summaries"),
                "pending": n("SELECT COUNT(*) AS n FROM chunks WHERE distilled='pending'"),
                "failed": n("SELECT COUNT(*) AS n FROM chunks WHERE distilled='failed'"),
                "skipped": n("SELECT COUNT(*) AS n FROM chunks WHERE distilled='skipped'"),
                "vec_pending": n("SELECT COUNT(*) AS n FROM summaries WHERE vec_state='pending'"),
                "entities": n("SELECT COUNT(*) AS n FROM entities"),
                "relations": n("SELECT COUNT(*) AS n FROM relations"),
            }

    # ---------------------------------------------------------------- 账本建议（SUGGEST_PATCH）

    def notes_counts(self) -> dict:
        """`/health` 的 `distill.notes`：候选总数与回补队列（只有计数，没有原文）。"""
        with self.lock:
            def n(sql: str, args: Sequence = ()) -> int:
                return int(self.conn.execute(sql, args).fetchone()["n"])
            return {
                "total": n("SELECT COUNT(*) AS n FROM ledger_notes"),
                "queued": n("SELECT COUNT(*) AS n FROM notes_state WHERE state='queued'"),
                "failed": n("SELECT COUNT(*) AS n FROM notes_state WHERE state='failed'"),
            }

    def notes(self, key: str, since_ms: int = 0, limit: int = 100) -> list[dict]:
        """SUGGEST_PATCH：本会话的候选（接口约定 §1 的 `/notes`）。

        join `summaries` 是硬条件：摘要被删了，候选就不能再返回（级联已经删过，这里再兜一层）；
        `key` 在两张表上都过滤——会话隔离不允许有例外。
        """
        if not key:
            return []
        with self.lock:
            rows = self.conn.execute(
                "SELECT n.note_id, n.summary_id, s.day, s.t_end, n.who, n.who_name, n.cat, n.text,"
                "       n.due, s.importance, n.created_at, n.source "
                "FROM ledger_notes n JOIN summaries s ON s.summary_id = n.summary_id "
                "WHERE n.key=? AND s.key=? AND n.created_at >= ? "
                "ORDER BY n.created_at DESC, n.note_id ASC LIMIT ?",
                (key, key, int(since_ms), int(limit)),
            ).fetchall()
        return [{"note_id": r["note_id"], "summary_id": r["summary_id"], "day": r["day"],
                 "t_end": int(r["t_end"]), "who": r["who"], "who_name": r["who_name"],
                 "cat": r["cat"], "text": r["text"], "due": r["due"],
                 "importance": float(r["importance"]), "created_at": int(r["created_at"]),
                 "source": r["source"]} for r in rows]

    def queue_notes_backfill(self, hours: int, now_ms: int, dry_run: bool = False) -> int:
        """SUGGEST_PATCH：把「有摘要、t_end 在窗口内、还没有 notes_state」的摘要标成 queued。

        `notes_state` 里已有行（done / queued / failed）的一律不动，所以重复调用不会重复排队
        （接口约定 §1）。`dry_run` 只数、不写。
        """
        since = int(now_ms) - int(hours) * 3_600_000
        with self.lock:
            cur = self.conn.cursor()
            rows = cur.execute(
                "SELECT s.summary_id FROM summaries s LEFT JOIN notes_state n ON n.summary_id = s.summary_id "
                "WHERE s.t_end >= ? AND n.summary_id IS NULL", (since,)).fetchall()
            ids = [str(r["summary_id"]) for r in rows]
            if ids and not dry_run:
                cur.executemany(
                    "INSERT OR IGNORE INTO notes_state(summary_id, state, attempts, at) VALUES (?,'queued',0,?)",
                    [(sid, int(now_ms)) for sid in ids])
                self.conn.commit()
        return len(ids)

    def queued_notes(self, limit: int) -> list[dict]:
        """SUGGEST_PATCH：回补队列里的摘要与它那块原文（够 `_user_content` 用）。

        块已不在了也照样返回：提炼层要据此把它标成 failed，不能让它永远卡在队列里。
        """
        with self.lock:
            rows = self.conn.execute(
                "SELECT n.summary_id, s.chunk_id, s.key, s.text_hash, s.t_end, "
                "       c.text AS chunk_text, c.speakers AS speakers, c.speaker_names AS speaker_names "
                "FROM notes_state n JOIN summaries s ON s.summary_id = n.summary_id "
                "LEFT JOIN chunks c ON c.chunk_id = s.chunk_id "
                "WHERE n.state='queued' ORDER BY s.t_end ASC, s.summary_id ASC LIMIT ?",
                (int(limit),)).fetchall()
        return [{"summary_id": r["summary_id"], "chunk_id": r["chunk_id"], "key": r["key"],
                 "text_hash": r["text_hash"], "t_end": int(r["t_end"]),
                 "text": r["chunk_text"], "speakers": r["speakers"] or "",
                 "speaker_names": r["speaker_names"] or ""} for r in rows]

    def write_notes(self, summary_id: str, notes: Sequence[dict], source: str, now_ms: int) -> int:
        """SUGGEST_PATCH：只写候选（回补用）。不改摘要、实体、关系、向量；摘要没了就什么都不写。"""
        with self.lock:
            cur = self.conn.cursor()
            row = cur.execute("SELECT key FROM summaries WHERE summary_id=?", (summary_id,)).fetchone()
            if row is None:
                return 0
            n = _write_note_rows(cur, summary_id, str(row["key"]), notes, source, now_ms)
            self.conn.commit()
        return n

    def mark_notes_failed(self, summary_id: str, now_ms: int) -> str:
        """SUGGEST_PATCH：回补失败一次继续排队，满两次标 failed（规格 §3.5）。返回新状态。"""
        with self.lock:
            cur = self.conn.cursor()
            row = cur.execute("SELECT attempts FROM notes_state WHERE summary_id=?", (summary_id,)).fetchone()
            if cur.execute("SELECT 1 FROM summaries WHERE summary_id=?", (summary_id,)).fetchone() is None:
                # 调模型期间会话被忘了：摘要和它的队列行都没了，什么都不用留
                cur.execute("DELETE FROM notes_state WHERE summary_id=?", (summary_id,))
                self.conn.commit()
                return "gone"
            attempts = int(row["attempts"]) + 1 if row else 1
            state = "failed" if attempts >= 2 else "queued"
            cur.execute("INSERT OR REPLACE INTO notes_state(summary_id, state, attempts, at) VALUES (?,?,?,?)",
                        (summary_id, state, attempts, int(now_ms)))
            self.conn.commit()
        return state

    # ---------------------------------------------------------------- 写（提炼线程用）

    def reconcile(self) -> list[str]:
        """块被重写后，把还能挂回去的摘要挂回去；挂不回去的旧摘要删掉。

        返回被删掉的旧摘要 id，调用方负责删它们的向量。
        """
        stale: list[str] = []
        with self.lock:
            from .fts import tokenize  # 函数内 import：fts 模块导入时也会用到本模块

            cur = self.conn.cursor()
            chunks = cur.execute(
                "SELECT chunk_id, text, speaker_names FROM chunks WHERE distilled='pending'").fetchall()
            for c in chunks:
                th = text_hash(c["text"])
                row = cur.execute(
                    "SELECT summary_id, text_hash, title FROM summaries WHERE chunk_id=?", (c["chunk_id"],)).fetchone()
                if row is None:
                    continue
                if row["text_hash"] == th:
                    title = row["title"]
                    cur.execute("UPDATE chunks SET distilled='done', title=? WHERE chunk_id=?", (title, c["chunk_id"]))
                    cur.execute("DELETE FROM chunks_fts WHERE chunk_id=?", (c["chunk_id"],))
                    blob = " ".join(tokenize(f"{title}\n{c['speaker_names']}\n{c['text']}"))
                    cur.execute("INSERT INTO chunks_fts(tokens, chunk_id) VALUES (?,?)", (blob, c["chunk_id"]))
                    cur.execute("DELETE FROM distill_state WHERE chunk_id=?", (c["chunk_id"],))
                else:
                    sid = str(row["summary_id"])
                    _delete_summary_rows(cur, sid)
                    stale.append(sid)
            self.conn.commit()
        return stale

    def pending_chunks(self, now_ms: int, limit: int) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT c.chunk_id, c.key, c.t_start, c.t_end, c.day, c.speakers, c.speaker_names, "
                "       c.text, c.n_msgs "
                "FROM chunks c LEFT JOIN distill_state d ON d.chunk_id = c.chunk_id "
                "WHERE c.distilled='pending' AND (d.chunk_id IS NULL OR d.next_at <= ?) "
                "ORDER BY c.t_end ASC LIMIT ?",
                (int(now_ms), int(limit)),
            ).fetchall()
        return [{"chunk_id": r["chunk_id"], "key": r["key"], "t_start": int(r["t_start"]),
                 "t_end": int(r["t_end"]), "day": r["day"], "speakers": r["speakers"],
                 "speaker_names": r["speaker_names"], "text": r["text"], "n_msgs": int(r["n_msgs"]),
                 "text_hash": text_hash(r["text"])} for r in rows]

    def mark_skipped(self, chunk_id: str) -> None:
        with self.lock:
            self.conn.execute("UPDATE chunks SET distilled='skipped' WHERE chunk_id=?", (chunk_id,))
            self.conn.commit()

    def mark_failed(self, chunk_id: str, error: str, now_ms: int) -> int:
        """记一次失败，返回累计失败次数。第 3 次失败把块标成 failed（控制台可见、可手动重试）。"""
        err = str(error or "")[:64]
        with self.lock:
            # 调模型期间块可能已被遗忘：不要再给它留一条进度记录
            if self.conn.execute("SELECT 1 FROM chunks WHERE chunk_id=?", (chunk_id,)).fetchone() is None:
                return 0
            row = self.conn.execute("SELECT attempts FROM distill_state WHERE chunk_id=?", (chunk_id,)).fetchone()
            attempts = int(row["attempts"]) + 1 if row else 1
            if attempts >= MAX_ATTEMPTS:
                self.conn.execute("UPDATE chunks SET distilled='failed' WHERE chunk_id=?", (chunk_id,))
                next_at = int(now_ms)
            else:
                next_at = int(now_ms) + RETRY_MS[attempts - 1]
            self.conn.execute(
                "INSERT OR REPLACE INTO distill_state(chunk_id, attempts, next_at, last_error) VALUES (?,?,?,?)",
                (chunk_id, attempts, next_at, err),
            )
            self.conn.commit()
        return attempts

    def retry_failed(self) -> int:
        with self.lock:
            cur = self.conn.cursor()
            ids = [r["chunk_id"] for r in cur.execute("SELECT chunk_id FROM chunks WHERE distilled='failed'")]
            if ids:
                cur.execute(f"UPDATE chunks SET distilled='pending' WHERE chunk_id IN ({_marks(len(ids))})", ids)
                cur.execute(f"DELETE FROM distill_state WHERE chunk_id IN ({_marks(len(ids))})", ids)
            self.conn.commit()
        return len(ids)

    def write_summary(self, chunk_id: str, th: str, result: dict, model: str, now_ms: int) -> str | None:
        """写一条摘要及其实体、关系、向量待补标记；块已不存在或原文变了就什么都不写、返回 None。

        调用前不能持有索引锁：调模型要几十秒，拿着锁会挡住遗忘。所以这里重新核对一次。
        """
        with self.lock:
            from .fts import tokenize

            cur = self.conn.cursor()
            chunk = cur.execute(
                "SELECT key, t_start, t_end, day, text, speakers, speaker_names FROM chunks WHERE chunk_id=?",
                (chunk_id,)).fetchone()
            if chunk is None or text_hash(chunk["text"]) != th:
                return None
            sid = summary_id_for(chunk_id, th)
            title = str(result.get("title") or "")
            summary = str(result.get("summary") or "")
            cur.execute(
                "INSERT OR REPLACE INTO summaries"
                "(summary_id, chunk_id, key, text_hash, t_start, t_end, day, title, summary,"
                " importance, valence, model, created_at, vec_state) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')",
                (sid, chunk_id, chunk["key"], th, int(chunk["t_start"]), int(chunk["t_end"]), chunk["day"],
                 title, summary, float(result.get("importance", 0.4)), float(result.get("valence", 0.0)),
                 str(model or ""), int(now_ms)),
            )
            cur.execute("DELETE FROM summaries_fts WHERE summary_id=?", (sid,))
            cur.execute("INSERT INTO summaries_fts(tokens, summary_id) VALUES (?,?)",
                        (" ".join(tokenize(f"{title}\n{summary}")), sid))
            # 同一条摘要重写时先把旧的关联、关系清掉，免得关系无限累积
            cur.execute("DELETE FROM summary_entities WHERE summary_id=?", (sid,))
            cur.execute("DELETE FROM relations WHERE summary_id=?", (sid,))
            for e in result.get("entities") or ():
                eid = str(e.get("entity_id") or "")
                if not eid:
                    continue
                cur.execute(
                    "INSERT OR IGNORE INTO entities(entity_id, type, name, norm, qq, created_at) VALUES (?,?,?,?,?,?)",
                    (eid, str(e.get("type") or "thing"), str(e.get("name") or ""), str(e.get("norm") or ""),
                     None if e.get("qq") is None else str(e.get("qq")), int(now_ms)),
                )
                # 已存在的实体不改类型和名字；只有 qq: 实体的显示名跟着账本走（称呼会改）
                if e.get("qq") is not None:
                    cur.execute("UPDATE entities SET name=? WHERE entity_id=?", (str(e.get("name") or ""), eid))
                cur.execute("INSERT OR REPLACE INTO summary_entities(summary_id, entity_id, key) VALUES (?,?,?)",
                            (sid, eid, chunk["key"]))
            for r in result.get("relations") or ():
                cur.execute(
                    "INSERT INTO relations(summary_id, key, src_id, dst_id, relation) VALUES (?,?,?,?,?)",
                    (sid, chunk["key"], str(r.get("src_id") or ""), str(r.get("dst_id") or ""),
                     str(r.get("relation") or "")),
                )
            # SUGGEST_PATCH：候选与摘要在同一个事务里写（规格 §3.3）。`notes` 缺失（手工造摘要、
            # 老调用方）按空列表处理，并照样标 done——write_summary 本身就代表「这次提炼已完成」。
            _write_note_rows(cur, sid, str(chunk["key"]), result.get("notes") or (), "distill", now_ms)
            cur.execute("UPDATE chunks SET distilled='done', title=? WHERE chunk_id=?", (title, chunk_id))
            cur.execute("DELETE FROM chunks_fts WHERE chunk_id=?", (chunk_id,))
            blob = " ".join(tokenize(f"{title}\n{chunk['speaker_names']}\n{chunk['text']}"))
            cur.execute("INSERT INTO chunks_fts(tokens, chunk_id) VALUES (?,?)", (blob, chunk_id))
            cur.execute("DELETE FROM distill_state WHERE chunk_id=?", (chunk_id,))
            self.conn.commit()
        return sid

    # ---------------------------------------------------------------- 摘要向量

    def need_vectors(self, limit: int) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT summary_id, chunk_id, key, t_start, t_end, day, title, summary FROM summaries "
                "WHERE vec_state='pending' ORDER BY created_at ASC LIMIT ?", (int(limit),)).fetchall()
        return [{"summary_id": r["summary_id"], "chunk_id": r["chunk_id"], "key": r["key"],
                 "t_start": int(r["t_start"]), "t_end": int(r["t_end"]), "day": r["day"],
                 "title": r["title"], "summary": r["summary"]} for r in rows]

    def mark_vec_done(self, ids: Sequence[str]) -> None:
        ids = [str(i) for i in (ids or ()) if i]
        if not ids:
            return
        with self.lock:
            self.conn.execute(f"UPDATE summaries SET vec_state='done' WHERE summary_id IN ({_marks(len(ids))})", ids)
            self.conn.commit()

    def mark_all_vec_pending(self) -> None:
        with self.lock:
            self.conn.execute("UPDATE summaries SET vec_state='pending'")
            self.conn.commit()

    def count_vec_done(self) -> int:
        with self.lock:
            return int(self.conn.execute(
                "SELECT COUNT(*) AS n FROM summaries WHERE vec_state='done'").fetchone()["n"])

    # ---------------------------------------------------------------- 清理

    def prune_orphans(self) -> list[str]:
        """删掉块已不存在的摘要（重建后挂不回去的）和孤儿实体；返回删掉的摘要 id。"""
        ids: list[str] = []
        with self.lock:
            cur = self.conn.cursor()
            rows = cur.execute(
                "SELECT summary_id FROM summaries WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks)").fetchall()
            for r in rows:
                sid = str(r["summary_id"])
                _delete_summary_rows(cur, sid)
                ids.append(sid)
            cur.execute("DELETE FROM distill_state WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks)")
            _delete_orphan_entities(cur)
            self.conn.commit()
            self.db._purge()
        return ids
