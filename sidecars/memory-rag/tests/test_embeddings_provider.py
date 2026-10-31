"""EMBED_API_PATCH：embedding 可选本地部署或 API 接入。

全部用测试里起的本地假 HTTP 服务（http.server，随机端口）和临时目录：
不连真实的 llama-server / embedding API，不读任何真实密钥或 state/。
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest
import yaml

from conftest import ROOT, close_rag
from memory_rag.config import load_config
from memory_rag.embeddings import (
    ApiEmbedder,
    EmbeddingConfigError,
    EmbeddingUnavailable,
    LlamaCppEmbedder,
    make_embedder,
)
from memory_rag.service import Service
from memory_rag.store import VectorStore

KEY = "sk-test-123"
KEY_FILE = "long-memory/rag/embedding-api.json"


# ---------------------------------------------------------------- 假 HTTP 服务


def default_post(path: str, body):
    """默认按输入条数返回：[长度, 1, 2, 3]（4 维，正好给 dim=4 的用例用）。"""
    texts = (body or {}).get("input") or []
    return 200, {"data": [{"index": i, "embedding": [float(len(t)), 1.0, 2.0, 3.0]}
                          for i, t in enumerate(texts)]}, 0


class FakeServer:
    """记录每个请求，按 post_fn / get_status 回应；跑在 127.0.0.1 的随机端口。"""

    def __init__(self):
        self.requests: list[dict] = []
        self.get_calls = 0
        self.get_status = 200
        self.post_fn = None  # (path, body) -> (status, payload, delay_seconds)

        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):  # 测试里不要打印访问日志
                pass

            def _send(self, status: int, payload) -> None:
                if isinstance(payload, (dict, list)):
                    raw, ctype = json.dumps(payload).encode("utf-8"), "application/json"
                elif isinstance(payload, str):
                    raw, ctype = payload.encode("utf-8"), "text/plain"
                else:
                    raw, ctype = (payload or b""), "application/octet-stream"
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # 客户端超时先断开是预期情况

            def do_GET(self):
                outer.get_calls += 1
                self._send(outer.get_status, {})

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = raw
                outer.requests.append({
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": body,
                })
                status, payload, delay = (outer.post_fn or default_post)(self.path, body)
                if delay:
                    time.sleep(delay)
                self._send(status, payload)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "FakeServer":
        self.thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


# ---------------------------------------------------------------- 辅助


def api_cfg(url: str, **kw) -> dict:
    cfg = {"base_url": url, "model": "your-embedding-model", "dim": 4,
           "batch": 32, "timeout_s": 5, "key_file": KEY_FILE}
    cfg.update(kw)
    return cfg


def write_key(state: Path, key: str = KEY) -> Path:
    p = state / KEY_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"apiKey": key}), encoding="utf-8")
    p.chmod(0o600)
    return p


def write_config(path: Path, state: Path, embedding: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump({"state_dir": str(state), "embedding": embedding},
                                   allow_unicode=True), encoding="utf-8")
    return path


# ---------------------------------------------------------------- 1. 缺省本地


LOCAL = {"model": "Qwen3-Embedding-8B-Q8_0", "dim": 4, "instruct": "检索聊天片段",
         "append_eos": True, "batch": 2, "timeout_s": 5}


def test_default_provider_is_local_and_request_unchanged(tmp_path: Path) -> None:
    with FakeServer() as s:
        cfg = dict(LOCAL, base_url=s.url)
        emb = make_embedder(cfg, tmp_path)
        assert isinstance(emb, LlamaCppEmbedder)
        # 本地口径字符串与改动前的公式逐字相同
        assert emb.model_id == (f"{cfg['model']}|dim={cfg['dim']}"
                                f"|eos={int(cfg['append_eos'])}|inst={cfg['instruct']}")
        out = emb.embed_docs(["你好", "世界", "第三句"])
        assert out.shape == (3, 4)
        assert [r["body"] for r in s.requests] == [
            {"input": ["你好<|endoftext|>", "世界<|endoftext|>"]},
            {"input": ["第三句<|endoftext|>"]},
        ]
        assert all("authorization" not in r["headers"] for r in s.requests)
        assert all(r["path"] == "/v1/embeddings" for r in s.requests)


def test_local_mode_ignores_api_section(tmp_path: Path) -> None:
    """provider: local 时 api 子段完全忽略（线上 config.yml 就是这么写的）。"""
    emb = make_embedder({"provider": "local", "base_url": "http://127.0.0.1:9", "dim": 8,
                         "api": {"base_url": "https://api.example.com/v1", "model": "x"}}, tmp_path)
    assert isinstance(emb, LlamaCppEmbedder)


def test_repo_config_is_local_with_same_model_id() -> None:
    cfg = load_config(ROOT / "config.yml")
    assert cfg["embedding"].get("provider") == "local"
    emb = make_embedder(cfg["embedding"], cfg["paths"].state)
    assert isinstance(emb, LlamaCppEmbedder)
    assert emb.model_id == ("Qwen3-Embedding-8B-Q8_0|dim=2048|eos=1|"
                            "inst=给定一个关于过往聊天的问题，检索能回答它的聊天记录片段")


# ---------------------------------------------------------------- 2. API 请求形状


def test_api_request_shape_and_batching(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        emb = ApiEmbedder(api_cfg(s.url, batch=2, send_dimensions=True), tmp_path)
        out = emb.embed_docs(["aa", "bbb", "cccc", "d", "ee"])
        assert out.shape == (5, 4)
        assert [len(r["body"]["input"]) for r in s.requests] == [2, 2, 1]
        for r in s.requests:
            assert r["path"] == "/embeddings"
            assert r["body"]["model"] == "your-embedding-model"
            assert r["body"]["encoding_format"] == "float"
            assert r["body"]["dimensions"] == 4
            assert r["headers"]["authorization"] == f"Bearer {KEY}"
        # 结果按 dim=4 正常归一化：[长度,1,2,3] / 范数
        v = np.array([2.0, 1.0, 2.0, 3.0])
        assert np.allclose(out[0], v / np.linalg.norm(v))


def test_api_without_send_dimensions_omits_field(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        ApiEmbedder(api_cfg(s.url), tmp_path).embed_docs(["x"])
        assert "dimensions" not in s.requests[0]["body"]


def test_api_sorts_by_index(tmp_path: Path) -> None:
    write_key(tmp_path)

    def shuffled(_path, body):
        data = [{"index": i, "embedding": [1.0 if j == i else 0.0 for j in range(4)]}
                for i in range(len(body["input"]))]
        return 200, {"data": list(reversed(data))}, 0

    with FakeServer() as s:
        s.post_fn = shuffled
        out = ApiEmbedder(api_cfg(s.url), tmp_path).embed_docs(["a", "b", "c"])
        assert np.array_equal(np.argmax(out, axis=1), np.arange(3))


def test_api_truncates_and_renormalizes(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        s.post_fn = lambda _p, _b: (
            200, {"data": [{"index": 0, "embedding": [3.0, 4.0, 100.0, 100.0]}]}, 0)
        out = ApiEmbedder(api_cfg(s.url, dim=2), tmp_path).embed_docs(["x"])
        assert np.allclose(out[0], [0.6, 0.8])


def test_api_vector_shorter_than_dim_raises(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        s.post_fn = lambda _p, _b: (200, {"data": [{"index": 0, "embedding": [1.0]}]}, 0)
        emb = ApiEmbedder(api_cfg(s.url, dim=2), tmp_path)
        with pytest.raises(EmbeddingUnavailable, match="短于 dim"):
            emb.embed_docs(["x"])


def test_api_count_mismatch_raises(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        s.post_fn = lambda _p, _b: (
            200, {"data": [{"index": 0, "embedding": [1, 0, 0, 0]}]}, 0)
        emb = ApiEmbedder(api_cfg(s.url), tmp_path)
        with pytest.raises(EmbeddingUnavailable, match="条数"):
            emb.embed_docs(["a", "b"])


# ---------------------------------------------------------------- 3. 错误信息不含内容


@pytest.mark.parametrize("status", [401, 429, 500])
def test_api_http_errors_are_sanitized(tmp_path: Path, status: int) -> None:
    secret_text = "秘密聊天内容XYZ"
    key = "sk-secret-key-abcdef"

    def echo(_path, body):
        return status, {"error": f"bad request: {body['input']} {key}"}, 0

    write_key(tmp_path, key)
    with FakeServer() as s:
        s.post_fn = echo
        emb = ApiEmbedder(api_cfg(s.url), tmp_path)
        with pytest.raises(EmbeddingUnavailable) as ei:
            emb.embed_docs([secret_text])
        msg = str(ei.value)
        assert msg == f"http {status}"
        assert key not in msg and secret_text not in msg


def test_api_timeout_is_sanitized(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        s.post_fn = lambda _p, _b: (200, {"data": []}, 0.6)
        emb = ApiEmbedder(api_cfg(s.url, timeout_s=0.15), tmp_path)
        with pytest.raises(EmbeddingUnavailable) as ei:
            emb.embed_docs(["超时测试"])
        assert str(ei.value) == "timeout"
        assert KEY not in str(ei.value)


def test_api_non_json_is_sanitized(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        s.post_fn = lambda _p, _b: (200, f"<html>echo {KEY}</html>", 0)
        emb = ApiEmbedder(api_cfg(s.url), tmp_path)
        with pytest.raises(EmbeddingUnavailable) as ei:
            emb.embed_docs(["x"])
        assert str(ei.value) == "响应不是 JSON"
        assert KEY not in str(ei.value)


# ---------------------------------------------------------------- 4. 密钥只从文件读


def test_api_without_key_file_never_calls_and_ignores_env(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # 环境变量里放假的密钥：必须没有被用上
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-openai")
    monkeypatch.setenv("EMBEDDING_API_KEY", "sk-env-embedding")
    with FakeServer() as s:
        emb = ApiEmbedder(api_cfg(s.url), tmp_path)
        assert emb.healthy() is False
        with pytest.raises(EmbeddingUnavailable, match="没有配置 embedding API 密钥"):
            emb.embed_docs(["hi"])
        assert s.requests == []
        assert s.get_calls == 0


# ---------------------------------------------------------------- 5. base_url / provider 校验


def test_api_rejects_plain_http_to_remote(tmp_path: Path) -> None:
    with pytest.raises(EmbeddingConfigError):
        ApiEmbedder(api_cfg("http://example.com/v1"), tmp_path)


def test_api_allows_loopback_http_and_https(tmp_path: Path) -> None:
    with FakeServer() as s:
        ApiEmbedder(api_cfg(s.url + "/v1"), tmp_path)
    ApiEmbedder(api_cfg("https://api.example.com/v1"), tmp_path)
    ApiEmbedder(api_cfg("http://localhost:1234/v1"), tmp_path)


def test_unknown_provider_is_config_error(tmp_path: Path) -> None:
    with pytest.raises(EmbeddingConfigError):
        make_embedder({"provider": "openai"}, tmp_path)


def test_api_requires_model(tmp_path: Path) -> None:
    with pytest.raises(EmbeddingConfigError):
        ApiEmbedder(api_cfg("https://api.example.com/v1", model=""), tmp_path)


# ---------------------------------------------------------------- 6. healthy 不调接口


def test_api_healthy_never_calls_api(tmp_path: Path) -> None:
    write_key(tmp_path)
    with FakeServer() as s:
        emb = ApiEmbedder(api_cfg(s.url), tmp_path)
        assert emb.healthy() is True
        assert s.requests == [] and s.get_calls == 0  # 一次请求都没发

        s.post_fn = lambda _p, _b: (500, {}, 0)
        with pytest.raises(EmbeddingUnavailable):
            emb.embed_docs(["x"])
        assert emb.healthy() is False

        s.post_fn = lambda _p, _b: (
            200, {"data": [{"index": 0, "embedding": [1, 0, 0, 0]}]}, 0)
        emb.embed_docs(["x"])
        assert emb.healthy() is True  # 失败后又成功过就恢复
        assert s.get_calls == 0


# ---------------------------------------------------------------- 7. 切换 provider 进 mismatch


def test_switch_local_to_api_hits_mismatch(tmp_path: Path) -> None:
    state = tmp_path / "state"
    (state / "long-memory" / "archive").mkdir(parents=True)
    local = make_embedder({"base_url": "http://127.0.0.1:9", "model": "Qwen3-Embedding-8B-Q8_0",
                           "dim": 2048, "instruct": "x", "append_eos": True}, state)
    old = VectorStore(state / "long-memory" / "rag" / "chroma", local.model_id, local.dim)
    old.client.close()

    cfg_path = write_config(tmp_path / "c.yml", state,
                            {"provider": "api",
                             "api": {"base_url": "https://api.example.com/v1",
                                     "model": "your-embedding-model", "dim": 1024}})
    svc = Service(str(cfg_path))
    try:
        assert svc.mismatch is not None
        assert "全量重建" in svc.mismatch
        assert svc.vstore is None  # 没有混写向量
    finally:
        close_rag(svc)


# ---------------------------------------------------------------- 8. /health 的 provider


def test_health_reports_provider_local(tmp_path: Path) -> None:
    state = tmp_path / "state_local"
    (state / "long-memory" / "archive").mkdir(parents=True)
    with FakeServer() as s:
        cfg_path = write_config(tmp_path / "local.yml", state,
                                {"provider": "local", "base_url": s.url, "model": "m",
                                 "dim": 4, "instruct": "", "append_eos": False})
        svc = Service(str(cfg_path))
        try:
            h = svc.health()
            assert h["embedding"]["provider"] == "local"
            assert h["embedding"]["url"] == s.url
            assert h["embedding"]["healthy"] is True
            assert h["ok"] is True
        finally:
            close_rag(svc)


def test_health_reports_provider_api(tmp_path: Path) -> None:
    state = tmp_path / "state_api"
    (state / "long-memory" / "archive").mkdir(parents=True)
    write_key(state)
    cfg_path = write_config(tmp_path / "api.yml", state,
                            {"provider": "api",
                             "api": {"base_url": "https://api.example.com/v1",
                                     "model": "your-embedding-model", "dim": 8,
                                     "key_file": KEY_FILE}})
    svc = Service(str(cfg_path))
    try:
        h = svc.health()
        assert h["embedding"]["provider"] == "api"
        assert h["embedding"]["url"] == "https://api.example.com/v1"
        assert h["embedding"]["healthy"] is True  # 有密钥，且没失败过，不发请求
        assert h["ok"] is True
    finally:
        close_rag(svc)
