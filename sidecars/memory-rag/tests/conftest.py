"""测试用的假存档和假 embedding：不连 GPU、不碰真实 state/。"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent

# 每个话题一组词，命中哪组词向量就偏向哪个轴：足够让切块器看出「话题换了」
TOPICS = {
    "food": ["吃", "火锅", "烧烤", "饿", "饭", "餐厅", "毛肚"],
    "work": ["加班", "项目", "老板", "上班", "开会", "需求"],
    "voice": ["声音", "语音", "试音", "唱"],
    "prompt": ["提示词", "prompt", "蝴蝶效应", "动画"],
}


class FakeEmbedder:
    model_id = "fake|dim=16"
    dim = 16

    def __init__(self):
        self.calls = 0

    def _one(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, dtype=np.float32)
        for i, words in enumerate(TOPICS.values()):
            v[i] += sum(text.count(w) for w in words)
        h = hashlib.sha1(text.encode("utf-8")).digest()
        v[4:] = np.frombuffer(h[:12], dtype=np.uint8).astype(np.float32) / 255.0 * 0.15
        n = np.linalg.norm(v)
        return v / (n or 1.0)

    def embed_docs(self, texts):
        self.calls += len(texts)
        return np.vstack([self._one(t) for t in texts]) if texts else np.zeros((0, self.dim), np.float32)

    def embed_query(self, text):
        return self._one(text)

    def healthy(self):
        return True


T0 = datetime(2026, 10, 1, 20, 0, 0)


def write_archive(state: Path, key: str, rows: list[tuple], month: str = "2026-10") -> Path:
    """rows: [(分钟偏移, dir, userId, name, text)]，时间以 T0 为起点。"""
    kind, num = key.split(":")
    d = state / "long-memory" / "archive" / f"{kind}_{num}"
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{month}.jsonl"
    with open(f, "a", encoding="utf-8") as fh:
        for m, direction, uid, name, text in rows:
            t = (T0 + timedelta(minutes=m)).astimezone().astimezone(tz=None)
            fh.write(json.dumps({"t": t.isoformat(), "dir": direction, "userId": uid, "name": name, "text": text, "msgId": None}, ensure_ascii=False) + "\n")
    return f


@pytest.fixture
def state(tmp_path: Path) -> Path:
    s = tmp_path / "state"
    (s / "long-memory" / "archive").mkdir(parents=True)
    (s / "long-memory" / "people.json").write_text(json.dumps({"version": 1, "people": {"111": {"name": "平安"}}}, ensure_ascii=False), encoding="utf-8")
    return s


@pytest.fixture
def cfg(tmp_path: Path, state: Path) -> dict:
    from memory_rag.config import load_config

    base = yaml.safe_load((ROOT / "config.yml").read_text(encoding="utf-8"))
    base["state_dir"] = str(state)
    p = tmp_path / "config.yml"
    p.write_text(yaml.safe_dump(base, allow_unicode=True), encoding="utf-8")
    return load_config(p)


# SUGGEST_PATCH：夹具每次用例都新建 Chroma 客户端（PersistentClient，底层是一组 SQLite
# 连接）和 ChunkDB 的 SQLite 连接；以前用完不关，句柄一路累积，默认 `ulimit -n 1024`
# 下整套测试跑到 test_recall_graph 时会撞上 "Too many open files"（chromadb 的 Rust
# 绑定直接 panic）。这里统一释放，任何夹具 / 用例自建的 Service、stack 都能复用。
# 只释放资源，不改夹具对外提供的对象与行为；重复调用安全。


def close_rag(obj) -> None:
    """释放 Service / stack 这类对象持有的向量库客户端与 SQLite 连接。"""
    seen: set[int] = set()
    for attr in ("vs", "vstore"):
        vs = getattr(obj, attr, None)
        if vs is None or id(vs) in seen:
            continue
        seen.add(id(vs))
        client = getattr(vs, "client", None)
        try:
            if client is not None and hasattr(client, "close"):
                # chromadb 1.5.x：close() 按引用计数停掉底层 System，最后一个引用释放时
                # 关掉 SQLite 等资源；不要直接 _system.stop()，同一路径可能有多个客户端。
                client.close()
            elif client is not None:
                # 老版本没有 close()：停 System 后清掉共享缓存，避免下次拿到已停的实例
                import chromadb.api.client

                client._system.stop()
                chromadb.api.client.SharedSystemClient.clear_system_cache()
        except Exception:  # 释放失败不该让用例失败
            pass
    db = getattr(obj, "db", None)
    conn = getattr(db, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


@pytest.fixture
def stack(cfg):
    """真 Chroma + 真 SQLite，假 embedding。"""
    from memory_rag.fts import ChunkDB
    from memory_rag.indexer import Indexer
    from memory_rag.search import Searcher
    from memory_rag.store import VectorStore

    emb = FakeEmbedder()
    rag = cfg["paths"].rag
    rag.mkdir(parents=True, exist_ok=True)
    db = ChunkDB(rag / "rag.sqlite3")
    vs = VectorStore(rag / "chroma", emb.model_id, emb.dim)

    class S:
        pass

    s = S()
    s.cfg, s.emb, s.db, s.vs = cfg, emb, db, vs
    s.make_indexer = lambda: Indexer(cfg, emb, db, vs)
    s.indexer = s.make_indexer()
    s.searcher = Searcher(cfg, emb, db, vs, s.indexer)
    yield s
    close_rag(s)


FAR_FUTURE = (T0 + timedelta(days=30)).timestamp() * 1000


def tombstone(file: Path, line_no: int) -> None:
    """RAG_PATCH（P2）测试辅助：把第 line_no 行（1 起）原地改成等长墓碑。

    与桥接的删除方式一致：内容换成 {"deleted": true}，用 ASCII 空格补齐到原字节数，
    所以文件大小、行号、后续各行的字节偏移都不变（索引服务的字节水位不会错位）。
    """
    p = Path(file)
    lines = p.read_bytes().split(b"\n")
    old = lines[line_no - 1]
    body = b'{"deleted": true}'
    assert len(old) >= len(body), f"第 {line_no} 行太短，放不下墓碑"
    if len(old) > len(body):
        body += b" " * (len(old) - len(body))
    start = sum(len(x) + 1 for x in lines[: line_no - 1])
    with open(p, "r+b") as fh:  # 原地改写，不新建文件
        fh.seek(start)
        fh.write(body)


def write_forget_request(state: Path, key: str, at: int) -> Path:
    """RAG_PATCH（P2）测试辅助：写一个桥接风格的遗忘请求（原子替换，文件 600）。"""
    kind, num = key.split(":")
    d = state / "long-memory" / "forget-requests"
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    p = d / f"{kind}_{num}.json"
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps({"key": key, "at": int(at)}, ensure_ascii=False), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(p)
    return p


def write_persona_config(state: Path, api_key: str = "sk-test-xxxx",
                         model: str = "deepseek-flash",
                         base_url: str = "https://api.deepseek.com") -> Path:
    """RAG_PATCH（P3）测试辅助：在**临时** state 下写人格判读配置（提炼层只从这里读密钥）。

    真实文件是 state/persona/config.json；测试只写临时目录里的假值，绝不碰真的，
    也绝不读环境变量或 ~/.dsh（提炼层本身就不读）。
    """
    d = state / "persona"
    d.mkdir(parents=True, exist_ok=True)
    p = d / "config.json"
    data = {"apiKey": api_key, "settings": {"appraisal": {"baseUrl": base_url, "model": model}}}
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    p.chmod(0o600)
    return p
