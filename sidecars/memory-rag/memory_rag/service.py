"""把各组件装配起来；FastAPI 服务、命令行、评估脚本共用同一套。"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

from .archive import key_dir, valid_key
from .config import load_config
from .distill import Distiller
from .embeddings import Embedder, make_embedder
from .fts import ChunkDB
from .indexer import IndexBusy, Indexer
from .l2 import L2
from .search import Searcher
from .store import IndexMismatch, VectorStore


class RebuildRunning(RuntimeError):
    """已有没跑完的重建任务：同一时间只允许一个。"""


def request_at(path: Path) -> int | None:
    """RAG_PATCH（P2）：读遗忘请求文件里的 at；读不出来返回 None（当作无法判断）。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return int(data.get("at") or 0) if isinstance(data, dict) else None
    except (OSError, ValueError, TypeError):
        return None


class Service:
    # RAG_PATCH（P2）：embedder 可注入，测试用假 embedding 构造整套服务，不碰 GPU
    def __init__(self, config_path: str | None = None, embedder: Embedder | None = None):
        os.umask(0o077)  # 派生数据和存档一样：目录 700、文件 600
        self.cfg = load_config(config_path)
        paths = self.cfg["paths"]
        paths.rag.mkdir(parents=True, exist_ok=True)
        os.chmod(paths.rag, 0o700)
        # EMBED_API_PATCH：provider local（缺省）/ api 由工厂决定，注入用法不变
        self.embedder = embedder or make_embedder(self.cfg.get("embedding") or {}, paths.state)
        self.db = ChunkDB(paths.rag / "rag.sqlite3")
        self.mismatch: str | None = None
        try:
            self.vstore = VectorStore(paths.rag / "chroma", self.embedder.model_id, self.embedder.dim)
        except IndexMismatch as e:
            self.mismatch = str(e)
            self.vstore = None
        self.indexer = Indexer(self.cfg, self.embedder, self.db, self.vstore) if self.vstore else None
        self.searcher = Searcher(self.cfg, self.embedder, self.db, self.vstore, self.indexer) if self.indexer else None
        # RAG_PATCH（P3）：L2 与提炼线程。口径不一致（vstore 为 None）时二者都不可用。
        self.l2: L2 | None = None
        self.distiller: Distiller | None = None
        if self.indexer:
            self._bind_l2()
            self._reconcile_vectors()
        # 最近一次重建任务：{kind, started_at, finished_at, chunks, error}，从没跑过是 None
        self.job: dict | None = None
        self._job_lock = threading.Lock()

    def _bind_l2(self) -> None:
        self.l2 = L2(self.db)
        self.distiller = Distiller(self.cfg, self.db, self.l2, self.vstore, self.embedder)

    def _reconcile_vectors(self) -> None:
        """摘要集合被删过 / 换过口径 / 数量少于「已标 done」的摘要 → 全部标成待补，重算向量。

        摘要是从 SQLite 的文字重算向量的，不调模型，也不花钱。
        """
        if not (self.l2 and self.vstore):
            return
        if self.vstore.summaries_reset or self.vstore.count_summaries() < self.l2.count_vec_done():
            self.l2.mark_all_vec_pending()

    def rebuild(self) -> None:
        """删掉派生数据从头建：换模型、改维度、改切块参数之后用。原始存档不动。"""
        if self.vstore is None:
            import shutil
            shutil.rmtree(self.cfg["paths"].rag / "chroma", ignore_errors=True)
            self.mismatch = None
            self.vstore = VectorStore(self.cfg["paths"].rag / "chroma", self.embedder.model_id, self.embedder.dim)
            self.indexer = Indexer(self.cfg, self.embedder, self.db, self.vstore)
            self.searcher = Searcher(self.cfg, self.embedder, self.db, self.vstore, self.indexer)
            self._bind_l2()
            self._reconcile_vectors()
        self.indexer.reset()

    # ---------------------------------------------------------------- 遗忘（P2）

    def forget(self, key: str) -> dict:
        """把一个会话从向量记忆里清掉（块、向量、水位、检索缓存）。存档由桥接负责。"""
        if not valid_key(key):
            raise ValueError(f"会话 key 不合法：{key}")
        if self.indexer is None:
            raise RuntimeError("向量库口径不一致")
        n = self.indexer.forget_key(key)
        self.searcher.rows.invalidate(key)
        return {"ok": True, "key": key, "removed_chunks": n}

    def forget_requests(self) -> list[tuple[Path, str, int]]:
        """列出待处理的遗忘请求：[(文件, key, at)]。坏文件、文件名与 key 不符的跳过且不删。"""
        d = self.cfg["paths"].forget_requests
        try:
            files = sorted(d.glob("*.json"))
        except OSError:
            return []
        out = []
        for p in files:
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                key = str(data.get("key") or "")
                at = int(data.get("at") or 0)
            except (OSError, ValueError, TypeError, AttributeError) as e:
                # 不删：删了就等于悄悄丢了桥接的请求；留给人看一眼
                print(f"遗忘请求文件无法解析，跳过：{p.name}（{e}）", file=sys.stderr)
                continue
            if not valid_key(key) or p.name != f"{key_dir(key)}.json":
                print(f"遗忘请求文件与 key 不符，跳过：{p.name}", file=sys.stderr)
                continue
            out.append((p, key, at))
        return out

    def process_forget_requests(self, only_key: str | None = None, blocking: bool = True) -> list[str]:
        """消费遗忘请求，返回处理过的 key。处理期间文件里的 at 变了（桥接又写了新请求）就留着。"""
        if self.indexer is None:
            raise RuntimeError("向量库口径不一致")
        done: list[str] = []
        for path, key, at in self.forget_requests():
            if only_key is not None and key != only_key:
                continue
            try:
                self.indexer.forget_key(key, timeout=120.0 if blocking else 0)
            except IndexBusy:
                if blocking:
                    # 等满超时还拿不到锁：这一轮先放弃，下一轮再试（文件留着）
                    continue
                raise
            self.searcher.rows.invalidate(key)
            # 处理期间桥接可能又写了新请求（at 变新）：只有 at 没变才删
            if request_at(path) == at:
                try:
                    path.unlink()
                except OSError:
                    pass
            done.append(key)
        return done

    # ---------------------------------------------------------------- 重建任务（P2）

    def start_rebuild(self) -> dict:
        """起一个后台全量重建任务，立刻返回任务快照。已有任务没跑完则抛 RebuildRunning。"""
        with self._job_lock:
            if self.job is not None and self.job.get("finished_at") is None:
                raise RebuildRunning("已有重建任务在进行")
            job = {"kind": "rebuild", "started_at": int(time.time() * 1000),
                   "finished_at": None, "chunks": None, "error": None}
            self.job = job
        threading.Thread(target=self._rebuild_job, args=(job,), daemon=True).start()
        return dict(job)

    def _rebuild_job(self, job: dict) -> None:
        try:
            # 先记下此刻的遗忘请求：全量重建会从存档重建，这些请求自然被覆盖，完成时再删
            pending = [(p, at) for p, _, at in self.forget_requests()]
            self.rebuild()
            r = self.indexer.run(blocking=True)
            job["chunks"] = r.get("chunks")
            # RAG_PATCH（P3）：重建后清掉挂不回去的摘要（块已不在）与孤儿实体，向量一并删
            if self.l2:
                ids = self.l2.prune_orphans()
                if ids and self.vstore:
                    self.vstore.delete_summaries(ids)
            for path, at in pending:
                if request_at(path) == at:
                    try:
                        path.unlink()
                    except OSError:
                        pass
        except Exception as e:  # 后台线程里的异常只能写进任务，让 /health 看得见
            job["error"] = repr(e)
        finally:
            job["finished_at"] = int(time.time() * 1000)

    def health(self) -> dict:
        out = {"ok": self.mismatch is None and self.embedder.healthy(),
               # RAG_PATCH（P2）：embedder 可注入，测试的假 embedding 没有 base_url
               "embedding": {"url": getattr(self.embedder, "base_url", None),
                             # EMBED_API_PATCH：只加这一个字段，其余不变
                             "provider": getattr(self.embedder, "provider", "local"),
                             "model_id": self.embedder.model_id, "healthy": self.embedder.healthy()},
               "mismatch": self.mismatch}
        if self.indexer:
            out["store"] = {**self.db.stats(), "vectors": self.vstore.count()}
            out["lag_rows"] = self.indexer.lag()
            out["last_index"] = self.indexer.last
        out["job"] = dict(self.job) if self.job else None
        out["forget_requests"] = [key for _, key, _ in self.forget_requests()]
        # RAG_PATCH（P3）：提炼层状态（只有计数与错误类别，不含原文与密钥）
        out["distill"] = self.distiller.status() if self.distiller else None
        return out
