"""embedding 客户端：本机 llama.cpp（Qwen3-Embedding）或 OpenAI 兼容的 embedding API。

两条路径对外接口相同（model_id / dim / embed_docs / embed_query / healthy）：
- 本地：外加三条用法要点（调用方不用操心）：
  1. 查询加指令前缀，文档不加 —— 冒烟实测不加前缀时 3 组查询里 2 组排错；
  2. 末尾补 <|endoftext|> —— llama-server 不会自动补，补上后区分度更好；
  3. 截到 dim 维后重新 L2 归一化 —— 不重新归一化时余弦从 0.48 掉到 0.25。
- EMBED_API_PATCH：`provider: api` 时走 OpenAI 兼容的 `POST {base_url}/embeddings`
  （OpenAI、硅基流动、阿里百炼等），查询前缀 / 补 EOS / 截断归一化与本地同一套。
  **缺省仍是本地**，本地模式的请求体与 model_id 与改动前逐字相同。

两种模式的 model_id 口径不同（API 带 `api:` 前缀），所以本地 ↔ API 切换、或换模型时
向量库会进入现有的 mismatch 流程提示全量重建，不会把两种向量混在一个库里。
"""

from __future__ import annotations

import ipaddress
import json
import urllib.parse
from pathlib import Path
from typing import Protocol, Sequence

import httpx
import numpy as np

EOS = "<|endoftext|>"
# EMBED_API_PATCH：密钥文件缺省位置（相对 state_dir）；只从文件读，绝不读环境变量
DEFAULT_KEY_FILE = "long-memory/rag/embedding-api.json"


class Embedder(Protocol):
    model_id: str
    dim: int

    def embed_docs(self, texts: Sequence[str]) -> np.ndarray: ...

    def embed_query(self, text: str) -> np.ndarray: ...


class EmbeddingUnavailable(RuntimeError):
    """embedding 服务不可用：调用方据此降级为只走 BM25。"""


class EmbeddingConfigError(ValueError):
    """EMBED_API_PATCH：配置本身不合法（缺项、明文 HTTP 发往远端等），启动时直接报错。"""


def truncate_normalize(mat: np.ndarray, dim: int) -> np.ndarray:
    m = np.asarray(mat, dtype=np.float32)[:, :dim]
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return m / n


class LlamaCppEmbedder:
    provider = "local"

    def __init__(self, cfg: dict):
        self.base_url = str(cfg.get("base_url", "http://127.0.0.1:8091")).rstrip("/")
        self.model = str(cfg.get("model", "unknown"))
        self.dim = int(cfg.get("dim", 2048))
        self.instruct = str(cfg.get("instruct", "")).strip()
        self.append_eos = bool(cfg.get("append_eos", True))
        self.batch = max(1, int(cfg.get("batch", 32)))
        self.client = httpx.Client(timeout=float(cfg.get("timeout_s", 30)))
        # 写进集合 metadata 的「向量口径」：任何一项变了，旧向量就不可比
        # EMBED_API_PATCH：这行是本地口径的原文，一个字符都不能动（线上库按它校验）
        self.model_id = f"{self.model}|dim={self.dim}|eos={int(self.append_eos)}|inst={self.instruct}"

    def _post(self, texts: list[str]) -> np.ndarray:
        try:
            r = self.client.post(f"{self.base_url}/v1/embeddings", json={"input": texts})
            r.raise_for_status()
            data = sorted(r.json()["data"], key=lambda d: d["index"])
        except (httpx.HTTPError, KeyError, ValueError) as e:
            raise EmbeddingUnavailable(str(e)) from e
        return np.asarray([d["embedding"] for d in data], dtype=np.float32)

    def _embed(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        suffix = EOS if self.append_eos else ""
        parts = []
        for i in range(0, len(texts), self.batch):
            parts.append(self._post([t + suffix for t in texts[i:i + self.batch]]))
        return truncate_normalize(np.vstack(parts), self.dim)

    def embed_docs(self, texts: Sequence[str]) -> np.ndarray:
        return self._embed(list(texts))

    def embed_query(self, text: str) -> np.ndarray:
        q = f"Instruct: {self.instruct}\nQuery: {text}" if self.instruct else text
        return self._embed([q])[0]

    def healthy(self) -> bool:
        try:
            return self.client.get(f"{self.base_url}/health", timeout=2).status_code == 200
        except httpx.HTTPError:
            return False


# ---------------------------------------------------------------- EMBED_API_PATCH：API 模式


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    h = host.strip("[]").lower()
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def _check_base_url(url: str) -> None:
    """聊天原文不能明文发出去：远端必须是 https，只有本机回环地址才允许 http。"""
    if not url:
        raise EmbeddingConfigError("embedding.api.base_url 未配置")
    p = urllib.parse.urlsplit(url)
    if p.scheme == "https" and p.hostname:
        return
    if p.scheme == "http" and _is_loopback(p.hostname):
        return
    raise EmbeddingConfigError("embedding.api.base_url 必须是 https（本机回环地址除外）")


class ApiEmbedder:
    """OpenAI 兼容的 embedding API（`POST {base_url}/embeddings`）。

    与本地模式的区别只在「怎么拿到向量」：查询前缀、补 EOS、截断归一化完全一致。
    密钥只从 `state_dir / key_file` 读（`{"apiKey": "..."}`），不读环境变量；
    异常信息只写类别与 HTTP 状态码，绝不带响应正文、请求内容或密钥。
    """

    provider = "api"

    def __init__(self, cfg: dict, state_dir: str | Path):
        self.base_url = str(cfg.get("base_url") or "").rstrip("/")
        self.model = str(cfg.get("model") or "").strip()
        self.dim = int(cfg.get("dim", 1024))
        self.instruct = str(cfg.get("instruct", "")).strip()
        self.append_eos = bool(cfg.get("append_eos", False))
        self.send_dimensions = bool(cfg.get("send_dimensions", False))
        self.batch = max(1, int(cfg.get("batch", 32)))
        if not self.model:
            raise EmbeddingConfigError("embedding.api.model 未配置")
        if self.dim <= 0:
            raise EmbeddingConfigError("embedding.api.dim 必须是正整数")
        _check_base_url(self.base_url)
        key_file = str(cfg.get("key_file") or DEFAULT_KEY_FILE)
        kp = Path(key_file)
        self.key_path = kp if kp.is_absolute() else Path(state_dir) / kp
        self.client = httpx.Client(timeout=float(cfg.get("timeout_s", 30)))
        # 密钥按文件 mtime 缓存，避免每个批次都读一次盘
        self._key_cache: tuple[int, str | None] | None = None
        # 最近一次请求是否失败：healthy() 靠它判断，不真的去调付费接口
        self._failed = False
        # 口径字符串与本地不同（前缀 api:），切模式 / 换模型都会触发向量库 mismatch
        self.model_id = (f"api:{self.model}|dim={self.dim}|eos={int(self.append_eos)}"
                         f"|inst={self.instruct}|dimensions={int(self.send_dimensions)}")

    def _read_key(self) -> str | None:
        try:
            st = self.key_path.stat()
        except OSError:
            self._key_cache = None
            return None
        if self._key_cache is not None and self._key_cache[0] == st.st_mtime_ns:
            return self._key_cache[1]
        key: str | None = None
        try:
            data = json.loads(self.key_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                key = str(data.get("apiKey") or "").strip() or None
        except (OSError, ValueError, TypeError):
            key = None
        self._key_cache = (st.st_mtime_ns, key)
        return key

    def _post(self, texts: list[str]) -> np.ndarray:
        key = self._read_key()
        if not key:
            self._failed = True
            raise EmbeddingUnavailable("没有配置 embedding API 密钥")
        body: dict = {"model": self.model, "input": texts, "encoding_format": "float"}
        if self.send_dimensions:
            body["dimensions"] = self.dim
        try:
            r = self.client.post(f"{self.base_url}/embeddings", json=body,
                                 headers={"Authorization": f"Bearer {key}"})
        except httpx.TimeoutException:
            # 只报类别：异常原文里可能带完整 URL / 请求体
            self._failed = True
            raise EmbeddingUnavailable("timeout") from None
        except httpx.HTTPError:
            self._failed = True
            raise EmbeddingUnavailable("network error") from None
        if r.status_code != 200:
            # 响应正文可能回显输入的聊天原文：只报状态码
            self._failed = True
            raise EmbeddingUnavailable(f"http {r.status_code}")
        try:
            payload = r.json()
        except ValueError:
            self._failed = True
            raise EmbeddingUnavailable("响应不是 JSON") from None
        try:
            data = sorted(payload["data"], key=lambda d: int(d["index"]))
            indices = [int(d["index"]) for d in data]
            vecs = [list(d["embedding"]) for d in data]
        except (KeyError, TypeError, ValueError):
            self._failed = True
            raise EmbeddingUnavailable("响应格式不对") from None
        if len(vecs) != len(texts) or indices != list(range(len(texts))):
            self._failed = True
            raise EmbeddingUnavailable("返回条数与输入不符")
        if any(len(v) < self.dim for v in vecs):
            self._failed = True
            raise EmbeddingUnavailable("返回向量短于 dim")
        self._failed = False
        # 比 dim 长就截断（重新归一化在 _embed 的 truncate_normalize 里做）
        return np.asarray([v[:self.dim] for v in vecs], dtype=np.float32)

    def _embed(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        suffix = EOS if self.append_eos else ""
        parts = []
        for i in range(0, len(texts), self.batch):
            parts.append(self._post([t + suffix for t in texts[i:i + self.batch]]))
        return truncate_normalize(np.vstack(parts), self.dim)

    def embed_docs(self, texts: Sequence[str]) -> np.ndarray:
        return self._embed(list(texts))

    def embed_query(self, text: str) -> np.ndarray:
        q = f"Instruct: {self.instruct}\nQuery: {text}" if self.instruct else text
        return self._embed([q])[0]

    def healthy(self) -> bool:
        """有密钥、且最近一次请求没有失败（失败后又成功过也算）就健康。

        绝不在这里发请求：API 是按次计费的，/health 每几秒就会被查一次。
        """
        return self._read_key() is not None and not self._failed


def make_embedder(cfg: dict, state_dir: str | Path) -> Embedder:
    """EMBED_API_PATCH：按 `embedding.provider` 造出对应实现；缺省 local。"""
    c = cfg or {}
    provider = str(c.get("provider") or "local").strip().lower()
    if provider == "local":
        return LlamaCppEmbedder(c)
    if provider == "api":
        return ApiEmbedder(c.get("api") or {}, state_dir)
    raise EmbeddingConfigError(f"未知的 embedding.provider「{provider}」，只能是 local 或 api")
