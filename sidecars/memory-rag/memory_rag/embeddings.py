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
import time
import urllib.parse
from pathlib import Path
from typing import Protocol, Sequence

import httpx
import numpy as np

EOS = "<|endoftext|>"
# EMBED_API_PATCH：密钥文件缺省位置（相对 state_dir）；只从文件读，绝不读环境变量
DEFAULT_KEY_FILE = "long-memory/rag/embedding-api.json"
# APIHUB_PATCH：控制台「API 管理」保存的部署方式（不含密钥）。文件不存在 = 完全按 config.yml 走
DEFAULT_SETTINGS_FILE = "long-memory/rag/embedding-settings.json"


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
    # APIHUB_PATCH：/health 用 kind 区分「自带 llama.cpp」与「用户自己部署的本地服务」；
    # 没有设置文件时这一路就是旧行为，所以叫 legacy-local。
    kind = "legacy-local"

    def __init__(self, cfg: dict):
        self.base_url = str(cfg.get("base_url", "http://127.0.0.1:8091")).rstrip("/")
        self.model = str(cfg.get("model", "unknown"))
        self.dim = int(cfg.get("dim", 2048))
        self.instruct = str(cfg.get("instruct", "")).strip()
        self.append_eos = bool(cfg.get("append_eos", True))
        self.batch = max(1, int(cfg.get("batch", 32)))
        self.client = _client_for(self.base_url, float(cfg.get("timeout_s", 30)))
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


def _client_for(base_url: str, timeout: float) -> httpx.Client:
    """按目标地址决定要不要认系统代理。

    为什么回环地址必须关掉：httpx 默认 trust_env=True，会读 HTTP_PROXY/HTTPS_PROXY。
    Windows 上装了 Clash / v2ray 这类代理的用户，shell 里通常带着代理变量，于是发往
    `127.0.0.1:8091` 的 embedding 请求也会被塞进代理：慢、可能被改写成绝对 URI
    （服务端看到的 path 变成 `http://127.0.0.1:8091/v1/embeddings`），而且**聊天原文
    会离开本机**——正是「本地服务只允许回环」这条约束想避免的事。
    远端 https 接口反过来必须保留代理设置，用户就是靠它出网的。
    """
    try:
        host = urllib.parse.urlsplit(base_url).hostname
    except ValueError:
        host = None
    return httpx.Client(timeout=timeout, trust_env=not _is_loopback(host))


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
    # APIHUB_PATCH：见 LlamaCppEmbedder.kind
    kind = "legacy-api"

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
        self.client = _client_for(self.base_url, float(cfg.get("timeout_s", 30)))
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


# ---------------------------------------------------------------- APIHUB_PATCH：地址规范化
# 与桥接（src/api-hub.js）各实现一份，同一组用例（接口约定 §5）。控制台保存前先校验，
# 这里再校验一次：设置文件是控制台写的，但手改 / 旧版本写坏也不能让服务起不来。


def _split_url(value: str, default_scheme: str) -> urllib.parse.SplitResult:
    s = str(value or "").strip()
    if "://" not in s:
        s = f"{default_scheme}://{s}"
    try:
        return urllib.parse.urlsplit(s)
    except ValueError as e:  # 例如方括号不配对
        raise EmbeddingConfigError("地址格式不对") from e


def _url_host(host: str) -> str:
    """IPv6 在 URL 里要带方括号：URL 的 host 部分写成 `[::1]`。"""
    return f"[{host}]" if ":" in host else host


def _url_port(p: urllib.parse.SplitResult) -> int:
    try:
        port = p.port
    except ValueError:
        raise EmbeddingConfigError("端口不对") from None
    if port is None:
        raise EmbeddingConfigError("要写端口")
    if not (1 <= int(port) <= 65535):
        raise EmbeddingConfigError("端口不对")
    return int(port)


def _reject_userinfo(p: urllib.parse.SplitResult) -> None:
    if p.username is not None or p.password is not None:
        raise EmbeddingConfigError("地址里不能带账号密码")


def _reject_query(p: urllib.parse.SplitResult) -> None:
    if p.query or p.fragment:
        raise EmbeddingConfigError("地址不能带参数")


def normalize_local_base_url(value: str) -> str:
    """本机部署：只允许回环地址 + 必填端口；路径空就补 /v1。"""
    p = _split_url(value, "http")
    if p.scheme.lower() not in ("http", "https"):
        raise EmbeddingConfigError("只支持 http / https")
    _reject_userinfo(p)
    _reject_query(p)
    host = p.hostname
    if not _is_loopback(host):
        raise EmbeddingConfigError("只能填本机回环地址")
    port = _url_port(p)
    path = (p.path or "").rstrip("/")
    if not path:
        path = "/v1"
    return f"{p.scheme.lower()}://{_url_host(host)}:{port}{path}"


def normalize_cloud_base_url(value: str) -> str:
    """云端：必须 https，不自动补 /v1（各家路径不同）。"""
    p = _split_url(value, "https")
    if p.scheme.lower() != "https":
        raise EmbeddingConfigError("云端必须是 https")
    _reject_userinfo(p)
    _reject_query(p)
    host = p.hostname
    if not host:
        raise EmbeddingConfigError("地址里没有主机名")
    try:
        port = p.port
    except ValueError:
        raise EmbeddingConfigError("端口不对") from None
    netloc = _url_host(host) + (f":{int(port)}" if port else "")
    path = (p.path or "").rstrip("/")
    return f"https://{netloc}{path}"


def embedding_settings_path(state_dir: str | Path) -> Path:
    return Path(state_dir) / DEFAULT_SETTINGS_FILE


# ---------------------------------------------------------------- APIHUB_PATCH：自己部署的本地服务


class LocalOpenAIEmbedder:
    """用户自己部署的本地 embedding（Ollama / LM Studio / vLLM / 自己的 llama-server）。

    与 `ApiEmbedder` 的差别：**必须带 `model`**（Ollama 的 /v1/embeddings 没有它直接 400）、
    密钥可选（`embedding-api.json` 的 `localApiKey`）、健康检查走 `GET {baseUrl}/models`
    （这几种服务都有，Ollama 没有 `/health`）。
    查询前缀、补 EOS、截断归一化与另外两种完全一致；异常只写类别与状态码。
    """

    provider = "local"
    kind = "local"

    def __init__(self, cfg: dict, state_dir: str | Path, http: httpx.Client | None = None):
        self.base_url = str(cfg.get("base_url") or "").rstrip("/")
        self.model = str(cfg.get("model") or "").strip()
        self.dim = int(cfg.get("dim", 1024))
        self.instruct = str(cfg.get("instruct", "")).strip()
        self.append_eos = bool(cfg.get("append_eos", False))
        self.send_dimensions = bool(cfg.get("send_dimensions", False))
        self.batch = max(1, int(cfg.get("batch", 32)))
        p = urllib.parse.urlsplit(self.base_url)
        # 明文 http 只能发到本机：局域网地址会让聊天原文在网络上裸奔
        if p.scheme not in ("http", "https") or not _is_loopback(p.hostname):
            raise EmbeddingConfigError("本地地址必须是回环地址")
        if not self.model:
            raise EmbeddingConfigError("缺少 model")
        if self.dim <= 0:
            raise EmbeddingConfigError("dim 必须是正整数")
        key_file = str(cfg.get("key_file") or DEFAULT_KEY_FILE)
        kp = Path(key_file)
        self.key_path = kp if kp.is_absolute() else Path(state_dir) / kp
        self.http = http or _client_for(self.base_url, float(cfg.get("timeout_s", 30)))
        # 密钥与健康检查都按文件 mtime / 时间缓存，避免每批、每几秒读次盘 / 发次请求
        self._key_cache: tuple[int, str | None] | None = None
        self._health_cache: tuple[float, bool] | None = None
        self.model_id = (f"oai-local:{self.model}|dim={self.dim}|eos={int(self.append_eos)}"
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
                key = str(data.get("localApiKey") or "").strip() or None
        except (OSError, ValueError, TypeError):
            key = None
        self._key_cache = (st.st_mtime_ns, key)
        return key

    def _post(self, texts: list[str]) -> np.ndarray:
        body: dict = {"model": self.model, "input": texts, "encoding_format": "float"}
        if self.send_dimensions:
            body["dimensions"] = self.dim
        headers = {}
        key = self._read_key()  # 本地部署一般不要密钥；填了才带
        if key:
            headers["Authorization"] = f"Bearer {key}"
        try:
            r = self.http.post(f"{self.base_url}/embeddings", json=body,
                               headers=headers or None)
        except httpx.TimeoutException:
            raise EmbeddingUnavailable("timeout") from None
        except httpx.HTTPError:
            raise EmbeddingUnavailable("network error") from None
        if r.status_code != 200:
            raise EmbeddingUnavailable(f"http {r.status_code}")
        try:
            payload = r.json()
        except ValueError:
            raise EmbeddingUnavailable("响应不是 JSON") from None
        try:
            data = sorted(payload["data"], key=lambda d: int(d["index"]))
            indices = [int(d["index"]) for d in data]
            vecs = [list(d["embedding"]) for d in data]
        except (KeyError, TypeError, ValueError):
            raise EmbeddingUnavailable("响应格式不对") from None
        if len(vecs) != len(texts) or indices != list(range(len(texts))):
            raise EmbeddingUnavailable("返回条数与输入不符")
        if any(len(v) < self.dim for v in vecs):
            raise EmbeddingUnavailable("返回向量短于 dim")
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
        """`GET {baseUrl}/models` 200 即健康；结果缓存 10 秒（/health 每几秒被查一次）。"""
        now = time.monotonic()
        if self._health_cache is not None and now - self._health_cache[0] < 10:
            return self._health_cache[1]
        try:
            ok = self.http.get(f"{self.base_url}/models", timeout=2).status_code == 200
        except httpx.HTTPError:
            ok = False
        self._health_cache = (now, ok)
        return ok


# ---------------------------------------------------------------- APIHUB_PATCH：坏配置不崩


class BrokenConfigEmbedder:
    """设置文件坏了时的占位实现：服务照常启动，向量路降级为 BM25。

    `model_id` / `dim` 由调用方从向量库现有集合的元数据里取（集合不存在时用 `"invalid-config"`
    和 config.yml 的 dim），这样 `VectorStore` 不会误判 mismatch、更不会动旧的向量数据。
    """

    provider = "local"

    def __init__(self, error: str, model_id: str, dim: int, kind: str = "legacy-local"):
        self.error = str(error)
        self.model_id = str(model_id)
        self.dim = int(dim)
        self.kind = str(kind)
        self.provider = "api" if self.kind in ("legacy-api", "cloud") else "local"
        self.base_url = None  # /health 的 url 一项；坏配置没有可用的地址

    def embed_docs(self, texts: Sequence[str]) -> np.ndarray:
        raise EmbeddingUnavailable(f"embedding 配置有误：{self.error}")

    def embed_query(self, text: str) -> np.ndarray:
        raise EmbeddingUnavailable(f"embedding 配置有误：{self.error}")

    def healthy(self) -> bool:
        return False


def _broken(error: str, cfg: dict, existing_meta: dict | None, kind: str) -> BrokenConfigEmbedder:
    meta = existing_meta or {}
    model_id = str(meta.get("embed_model_id") or "invalid-config")
    try:
        dim = int(meta.get("dim") or cfg.get("dim") or 2048)
    except (TypeError, ValueError):
        dim = 2048
    return BrokenConfigEmbedder(error, model_id, dim, kind)


_NO_DEFAULT = object()


def _check_setting(value, name: str, lo, hi, *, number: bool = False, default=_NO_DEFAULT):
    if value is None:
        if default is _NO_DEFAULT:
            raise EmbeddingConfigError(f"缺少 {name}")
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float) if number else int):
        raise EmbeddingConfigError(f"{name} 不对")
    if not (lo <= value <= hi):
        raise EmbeddingConfigError(f"{name} 不对")
    return value


def _setting_section(raw, name: str, *, cloud: bool) -> dict:
    """校验设置文件里的 local / cloud 段，返回给 embedder 的 cfg 字典（snake_case）。"""
    if not isinstance(raw, dict):
        raise EmbeddingConfigError(f"缺少 {name} 段")
    base = raw.get("baseUrl")
    if not isinstance(base, str) or not base.strip():
        raise EmbeddingConfigError(f"缺少 {name} 地址")
    base_url = normalize_cloud_base_url(base) if cloud else normalize_local_base_url(base)
    model = raw.get("model")
    if not isinstance(model, str) or not model.strip():
        raise EmbeddingConfigError("缺少 model")
    model = model.strip()
    if len(model) > 200:
        raise EmbeddingConfigError("model 太长")
    dim = _check_setting(raw.get("dim"), "dim", 1, 8192)
    instruct = raw.get("instruct", "")
    if not isinstance(instruct, str):
        raise EmbeddingConfigError("指令前缀不对")
    if len(instruct) > 500:
        raise EmbeddingConfigError("指令前缀太长")
    for key, label in (("appendEos", "末尾补 EOS"), ("sendDimensions", "dimensions 开关")):
        if key in raw and not isinstance(raw[key], bool):
            raise EmbeddingConfigError(f"{label}不对")
    batch = _check_setting(raw.get("batch"), "每批条数", 1, 256, default=32)
    timeout_s = _check_setting(raw.get("timeoutS"), "超时秒数", 1, 300, number=True, default=30)
    return {"base_url": base_url, "model": model, "dim": int(dim), "instruct": instruct,
            "append_eos": bool(raw.get("appendEos", False)),
            "send_dimensions": bool(raw.get("sendDimensions", False)),
            "batch": int(batch), "timeout_s": float(timeout_s)}


def make_embedder_from_state(cfg: dict, state_dir: str | Path,
                             existing_meta: dict | None = None) -> Embedder:
    """APIHUB_PATCH：有 `embedding-settings.json` 就按它的 kind 造 embedder，否则完全照旧。

    任何设置文件问题（不是 JSON、版本不对、kind 不认识、段缺失、字段非法、构造时校验失败）
    都返回 `BrokenConfigEmbedder`，**绝不抛异常**：服务照常启动、索引与检索降级，
    `/health.embedding.error` 给出原因类别（不含密钥、不含地址里的凭据）。
    """
    c = cfg or {}
    provider = str(c.get("provider") or "local").strip().lower()
    legacy_kind = "legacy-api" if provider == "api" else "legacy-local"
    sfile = embedding_settings_path(state_dir)
    try:
        raw = sfile.read_text(encoding="utf-8")
    except FileNotFoundError:
        return make_embedder(c, state_dir)  # 旧行为：config.yml 说了算
    except OSError:
        return _broken("读不到设置文件", c, existing_meta, legacy_kind)

    try:
        data = json.loads(raw)
    except ValueError:
        return _broken("设置文件不是合法 JSON", c, existing_meta, legacy_kind)
    if not isinstance(data, dict):
        return _broken("设置文件格式不对", c, existing_meta, legacy_kind)
    if data.get("version") != 1:
        return _broken("设置文件版本不是 1", c, existing_meta, legacy_kind)
    kind = data.get("kind")
    if kind not in ("bundled", "local", "cloud"):
        return _broken("未知的部署方式", c, existing_meta, legacy_kind)
    try:
        if kind == "bundled":
            # 自带 llama.cpp：忽略 provider / api，口径字符串与改动前逐字相同
            emb = LlamaCppEmbedder(c)
            emb.kind = "bundled"  # 实例属性：类上的 legacy-local 是「没有设置文件」时的取值
            return emb
        if kind == "local":
            sec = _setting_section(data.get("local"), "local", cloud=False)
            return LocalOpenAIEmbedder(sec, state_dir)
        sec = _setting_section(data.get("cloud"), "cloud", cloud=True)
        emb = ApiEmbedder(sec, state_dir)
        emb.kind = "cloud"
        return emb
    except EmbeddingConfigError as e:
        return _broken(str(e), c, existing_meta, kind)
