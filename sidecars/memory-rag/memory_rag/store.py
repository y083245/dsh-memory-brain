"""Chroma 向量库（块向量）。

向量由我们自己算好再写入（embedding_function=None），因为指令前缀、补 EOS、截断归一化都要自己控制。
「向量口径」（模型、维度、EOS、指令）写进集合 metadata：启动时和当前配置不一致就拒绝服务，
否则新旧向量混在一起不会报错，只会静默地检索不准。
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

import chromadb
import numpy as np
# APIHUB_PATCH：重建窗口里数向量 / 查询会撞上「集合不存在」，需要按类型精确捕获
from chromadb.errors import NotFoundError
from chromadb.config import Settings

COLLECTION = "chunks"
# RAG_PATCH（P3）：摘要向量单独一个集合。只放向量和 key / t_start / t_end，文字只在 SQLite。
SUMMARIES = "summaries"


class IndexMismatch(RuntimeError):
    """库里向量的口径和当前配置不一致，必须全量重建。"""


def drop_collections(path: Path) -> None:
    """APIHUB_PATCH：用 chromadb 的接口删掉块与摘要两个集合，替代「删 chroma 目录」。

    为什么不能删目录：chromadb 1.5.x 的 `PersistentClient` 在同一进程里**按路径缓存 System**
    （`SharedSystemClient`，键是路径的哈希）。`shutil.rmtree` 只删掉了磁盘文件，之后新建的
    客户端拿到的还是缓存里那份 System——旧集合、旧 metadata 全在，于是「换向量口径后全量重建」
    当场又抛 IndexMismatch（控制台「API 管理」换模型 → 桥接重启 memory-rag → /rebuild 走的就是
    这条路，用户会卡在「需要全量重建」里出不来）。按集合删除走的是那份 System 的真实接口，
    磁盘和缓存一起清干净；集合本来就不存在（首次启动、目录里什么都没有）时忽略。
    """
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    client = None
    try:
        client = chromadb.PersistentClient(
            path=str(path), settings=Settings(anonymized_telemetry=False, allow_reset=True))
        for name in (COLLECTION, SUMMARIES):
            try:
                client.delete_collection(name)
            except Exception:  # 集合不存在：本来就没有，没什么可删的
                pass
    finally:
        try:
            if client is not None:
                client.close()  # 引用计数归零时顺便停掉 System、清掉共享缓存
        except Exception:
            pass


def read_collection_meta(path: Path, name: str = COLLECTION) -> dict | None:
    """APIHUB_PATCH：只读现有集合的 metadata（坏配置要用旧口径，见 Service）。

    不创建集合、不改动任何数据：库文件不存在或集合不存在都返回 None。
    读完立刻关掉客户端，不和随后的 VectorStore 抢同一套 System。
    """
    db_file = Path(path) / "chroma.sqlite3"
    if not db_file.exists():
        return None
    client = None
    try:
        client = chromadb.PersistentClient(
            path=str(path), settings=Settings(anonymized_telemetry=False, allow_reset=True))
        col = client.get_collection(name, embedding_function=None)
        return dict(col.metadata or {})
    except Exception:  # 集合不存在 / 库版本不认：当作没有，交给调用方兜底
        return None
    finally:
        try:
            if client is not None:
                client.close()
        except Exception:
            pass


class VectorStore:
    def __init__(self, path: Path, model_id: str, dim: int):
        path.mkdir(parents=True, exist_ok=True)
        self.client = chromadb.PersistentClient(path=str(path), settings=Settings(anonymized_telemetry=False, allow_reset=True))
        self.model_id = model_id
        self.dim = dim
        # 摘要集合的口径和当前配置不一致时不会报错，而是删掉重建空集合，并让 Service 把摘要
        # 全部标成向量待补（文字还在 SQLite，重算一次就行，不用重调模型）。
        self.summaries_reset = False
        self.col = self._open()
        self.scol = self._open_summaries()

    def _meta(self) -> dict:
        return {"hnsw:space": "cosine", "embed_model_id": self.model_id, "dim": self.dim}

    def _open(self):
        col = self.client.get_or_create_collection(COLLECTION, metadata=self._meta(), embedding_function=None)
        got = (col.metadata or {}).get("embed_model_id")
        if got != self.model_id:
            raise IndexMismatch(f"向量库口径是「{got}」，当前配置是「{self.model_id}」，请全量重建")
        return col

    def _open_summaries(self):
        col = self.client.get_or_create_collection(SUMMARIES, metadata=self._meta(), embedding_function=None)
        got = (col.metadata or {}).get("embed_model_id")
        if got != self.model_id:
            # 摘要向量可以随时从 SQLite 重算：不拒绝服务，删掉重建空集合
            try:
                self.client.delete_collection(SUMMARIES)
            except Exception:
                pass
            self.summaries_reset = True
            col = self.client.get_or_create_collection(SUMMARIES, metadata=self._meta(), embedding_function=None)
        return col

    def reset(self) -> None:
        """只重置块集合（全量重建用）；摘要集合保留，靠对账挂回（规格 A1-a）。"""
        try:
            self.client.delete_collection(COLLECTION)
        except Exception:
            pass
        self.col = self._open()

    def reset_all(self) -> None:
        """块和摘要两个集合都重置（派生库整个不要了的时候用）。"""
        self.reset()
        try:
            self.client.delete_collection(SUMMARIES)
        except Exception:
            pass
        self.summaries_reset = True
        self.scol = self._open_summaries()

    def upsert(self, ids: Sequence[str], vectors: np.ndarray, metas: Sequence[dict], docs: Sequence[str] | None = None) -> None:
        """RAG_PATCH（P2）：Chroma 只存向量和过滤要用的三个字段，**不存块原文**。

        为什么：Chroma 的预写日志（`embeddings_queue` 表）会长期保留每次 upsert 的完整载荷，
        删块时只追加一条删除记录，旧载荷里的 `documents` 原文照样能从 SQL 里读出来；
        metadata 里的说话人、文件名同类。而检索时 Chroma 只用来按向量找 chunk_id
        （`query` 只取 `distances`），原文和元数据都从 `rag.sqlite3` 的 `chunks` 表读，
        那边能安全删除（见 `fts.ChunkDB._purge`）。所以这里把原文和其它元数据都丢给 SQLite 存。
        """
        if not ids:
            return
        # 过滤只需要 key 与时间范围：t_* 统一转 int，和 query 里的 where 条件类型一致
        slim = [{"key": str(m["key"]), "t_start": int(m["t_start"]), "t_end": int(m["t_end"])} for m in metas]
        self.col.upsert(ids=list(ids), embeddings=np.asarray(vectors, dtype=np.float32).tolist(),
                        metadatas=slim)

    def delete_key(self, key: str) -> None:
        """RAG_PATCH（P3）：块与摘要两个集合都按 key 删（遗忘要连 L2 一起干净）。"""
        self.col.delete(where={"key": key})
        self.scol.delete(where={"key": key})

    def query(self, key: str, vec: np.ndarray, n: int = 20, t_from: int | None = None, t_to: int | None = None) -> list[tuple[str, float]]:
        """返回 [(chunk_id, 余弦相似度)]。key 必填，作为 where 条件：别的会话的块根本不会被取出来。"""
        if not key:
            raise ValueError("key 必填")
        conds: list[dict] = [{"key": key}]
        if t_from is not None:
            conds.append({"t_end": {"$gte": int(t_from)}})
        if t_to is not None:
            conds.append({"t_start": {"$lte": int(t_to)}})
        where = conds[0] if len(conds) == 1 else {"$and": conds}
        # APIHUB_PATCH：这里连着两次碰旧集合（count 与 query），重建窗口里都可能抛
        # NotFoundError。调用方（search.search）只兜 EmbeddingUnavailable，不兜这个，
        # 于是控制台一搜就 500；这轮就当作向量路没结果，其余几路（BM25 / 摘要 / 图）照常。
        try:
            total = self.col.count()
            if total == 0:
                return []
            res = self.col.query(query_embeddings=[np.asarray(vec, dtype=np.float32).tolist()],
                                 n_results=min(int(n), total), where=where, include=["distances"])
        except NotFoundError:
            return []
        ids = (res.get("ids") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        return [(i, 1.0 - float(d)) for i, d in zip(ids, dists)]

    def count(self) -> int:
        # APIHUB_PATCH：reset() 是先 delete_collection 再重新打开的，这两步之间别的线程
        # 拿着旧 self.col 去数就会抛 NotFoundError；/health 被控制台每 2 秒轮询一次，
        # 撞上时整页会短暂显示成「启动失败」。重置中的集合本来就是空的，按 0 报即可；
        # 别的异常（比如库损坏）照旧往上抛，不在这里一起吞掉。
        try:
            return int(self.col.count())
        except NotFoundError:
            return 0

    # ---------------------------------------------------------------- 摘要向量（P3）

    def upsert_summaries(self, ids: Sequence[str], vectors: np.ndarray, metas: Sequence[dict]) -> None:
        """与块向量同样的瘦身做法：只写 key / t_start / t_end，**不传 documents**。

        摘要文字只在 SQLite 的 `summaries` 表里，按 id 回查。
        """
        if not ids:
            return
        slim = [{"key": str(m["key"]), "t_start": int(m["t_start"]), "t_end": int(m["t_end"])} for m in metas]
        self.scol.upsert(ids=list(ids), embeddings=np.asarray(vectors, dtype=np.float32).tolist(), metadatas=slim)

    def query_summaries(self, key: str, vec: np.ndarray, n: int = 20, t_from: int | None = None,
                        t_to: int | None = None, t_end_lte: int | None = None) -> list[tuple[str, float]]:
        """返回 [(summary_id, 余弦)]。where 必带 key：别的会话的摘要根本不会被取出来。"""
        if not key:
            raise ValueError("key 必填")
        conds: list[dict] = [{"key": key}]
        if t_from is not None:
            conds.append({"t_end": {"$gte": int(t_from)}})
        if t_to is not None:
            conds.append({"t_start": {"$lte": int(t_to)}})
        if t_end_lte is not None:
            conds.append({"t_end": {"$lte": int(t_end_lte)}})
        where = conds[0] if len(conds) == 1 else {"$and": conds}
        # APIHUB_PATCH：同 query()——reset_all() 窗口里调用方（search / recall）都没兜
        # NotFoundError，这里按「这轮摘要路没有结果」处理。
        try:
            total = self.scol.count()
            if total == 0:
                return []
            res = self.scol.query(query_embeddings=[np.asarray(vec, dtype=np.float32).tolist()],
                                  n_results=min(int(n), total), where=where, include=["distances"])
        except NotFoundError:
            return []
        ids = (res.get("ids") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        return [(i, 1.0 - float(d)) for i, d in zip(ids, dists)]

    def delete_summaries(self, ids: Sequence[str]) -> None:
        ids = [str(i) for i in (ids or ()) if i]
        if not ids:
            return  # Chroma 的 delete(ids=[]) 会抛 ValueError
        self.scol.delete(ids=ids)

    def count_summaries(self) -> int:
        # APIHUB_PATCH：同 count()——reset_all() 删掉摘要集合到重新打开之间，这里会抛
        # NotFoundError（service.health 与 recall 都会调，抛了就整条链路 500）。按 0 报。
        try:
            return int(self.scol.count())
        except NotFoundError:
            return 0
