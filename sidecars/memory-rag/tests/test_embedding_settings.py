"""APIHUB_PATCH：三种部署方式（自带 / 自己部署 / 云端）、地址规范化、坏配置不崩。

全部用临时 state + `httpx.MockTransport`（假 Ollama / 假云端）：
不连真实的 llama-server / embedding API，不读写真实 state/ 与任何密钥文件。
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import yaml

from conftest import FAR_FUTURE, ROOT, FakeEmbedder, close_rag, write_archive
from memory_rag.embeddings import (
    ApiEmbedder,
    BrokenConfigEmbedder,
    EmbeddingConfigError,
    EmbeddingUnavailable,
    LlamaCppEmbedder,
    LocalOpenAIEmbedder,
    make_embedder,
    make_embedder_from_state,
    normalize_cloud_base_url,
    normalize_local_base_url,
)
from memory_rag.service import Service

KEY_FILE = "long-memory/rag/embedding-api.json"
SETTINGS_FILE = "long-memory/rag/embedding-settings.json"
SECRET = "sk-SENTINEL-must-never-leak"
BUNDLED_MODEL_ID = ("Qwen3-Embedding-8B-Q8_0|dim=2048|eos=1|"
                    "inst=给定一个关于过往聊天的问题，检索能回答它的聊天记录片段")


# ---------------------------------------------------------------- 辅助


def write_settings(state: Path, data) -> Path:
    p = state / SETTINGS_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False), encoding="utf-8")
    p.chmod(0o600)
    return p


def write_key(state: Path, **kw) -> Path:
    p = state / KEY_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(kw, ensure_ascii=False), encoding="utf-8")
    p.chmod(0o600)
    return p


def write_cfg(tmp_path: Path, cfg: dict) -> str:
    """把夹具里的配置落成文件（去掉运行期加的 paths），Service 按路径读。"""
    data = {k: v for k, v in cfg.items() if k != "paths"}
    p = tmp_path / "service.yml"
    p.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    return str(p)


def section(**kw) -> dict:
    d = {"baseUrl": "http://127.0.0.1:11434/v1", "model": "bge-m3", "dim": 4, "instruct": "",
         "appendEos": False, "sendDimensions": False, "batch": 32, "timeoutS": 30}
    d.update(kw)
    return d


@pytest.fixture
def http_factory(monkeypatch: pytest.MonkeyPatch):
    """让 embeddings 里新建的 httpx.Client 都走 MockTransport（不联网）。"""
    real = httpx.Client

    def install(handler):
        transport = httpx.MockTransport(handler)

        def factory(*_args, **kw):
            kw.pop("timeout", None)
            return real(transport=transport)

        monkeypatch.setattr(httpx, "Client", factory)
        return transport

    return install


# ---------------------------------------------------------------- 1. 地址规范化（接口约定 §5）


@pytest.mark.parametrize("value,expected", [
    ("127.0.0.1:11434", "http://127.0.0.1:11434/v1"),
    ("localhost:1234", "http://localhost:1234/v1"),
    ("http://127.0.0.1:8000/v1/", "http://127.0.0.1:8000/v1"),
    ("[::1]:11434", "http://[::1]:11434/v1"),
    ("127.0.0.5:9000/api/v1", "http://127.0.0.5:9000/api/v1"),
])
def test_normalize_local_ok(value: str, expected: str) -> None:
    assert normalize_local_base_url(value) == expected


@pytest.mark.parametrize("value,error", [
    ("192.168.1.5:11434", "只能填本机回环地址"),
    ("127.0.0.1", "要写端口"),
    ("http://u:p@127.0.0.1:11434", "地址里不能带账号密码"),
    ("127.0.0.1:99999", "端口不对"),
    ("ftp://127.0.0.1:21", "只支持 http / https"),
    ("http://127.0.0.1:11434/v1?x=1", "不能带参数"),
])
def test_normalize_local_errors(value: str, error: str) -> None:
    with pytest.raises(EmbeddingConfigError) as ei:
        normalize_local_base_url(value)
    assert error in str(ei.value)


@pytest.mark.parametrize("value,expected,error", [
    ("https://api.siliconflow.cn/v1/", "https://api.siliconflow.cn/v1", None),
    ("api.siliconflow.cn/v1", "https://api.siliconflow.cn/v1", None),
    ("https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4", None),
    ("http://api.example.com/v1", None, "云端必须是 https"),
    ("https://k:s@api.example.com/v1", None, "地址里不能带账号密码"),
    ("https://api.example.com/v1#a", None, "不能带参数"),
])
def test_normalize_cloud(value: str, expected, error) -> None:
    if error:
        with pytest.raises(EmbeddingConfigError) as ei:
            normalize_cloud_base_url(value)
        assert error in str(ei.value)
    else:
        assert normalize_cloud_base_url(value) == expected


# ---------------------------------------------------------------- 2. 没有设置文件 = 旧行为


def test_no_settings_keeps_legacy_local(cfg) -> None:
    emb = make_embedder_from_state(cfg["embedding"], cfg["paths"].state)
    ref = make_embedder(cfg["embedding"], cfg["paths"].state)
    assert type(emb) is LlamaCppEmbedder
    assert emb.model_id == ref.model_id == BUNDLED_MODEL_ID


def test_no_settings_keeps_legacy_api(tmp_path: Path) -> None:
    emb_cfg = {"provider": "api",
               "api": {"base_url": "https://api.example.com/v1", "model": "your-embedding-model",
                       "dim": 1024}}
    emb = make_embedder_from_state(emb_cfg, tmp_path)
    ref = make_embedder(emb_cfg, tmp_path)
    assert type(emb) is ApiEmbedder
    assert emb.model_id == ref.model_id


def test_health_kind_legacy_local(tmp_path: Path, cfg, state) -> None:
    cfg["embedding"] = {"provider": "local", "base_url": "http://127.0.0.1:9", "model": "m",
                        "dim": 4, "instruct": "", "append_eos": False}
    svc = Service(write_cfg(tmp_path, cfg))
    try:
        h = svc.health()
        assert h["embedding"]["kind"] == "legacy-local"
        assert "error" not in h["embedding"]
    finally:
        close_rag(svc)


def test_health_kind_legacy_api(tmp_path: Path, cfg, state) -> None:
    write_key(state, apiKey="sk-local")
    cfg["embedding"] = {"provider": "api",
                        "api": {"base_url": "https://api.example.com/v1", "model": "m",
                                "dim": 8, "key_file": KEY_FILE}}
    svc = Service(write_cfg(tmp_path, cfg))
    try:
        h = svc.health()
        assert h["embedding"]["kind"] == "legacy-api"
        assert h["embedding"]["model_id"].startswith("api:")
    finally:
        close_rag(svc)


# ---------------------------------------------------------------- 3. bundled 的口径与线上逐字相同


def test_bundled_model_id_matches_repo_config(state) -> None:
    real = yaml.safe_load((ROOT / "config.yml").read_text(encoding="utf-8"))
    write_settings(state, {"version": 1, "kind": "bundled"})
    emb = make_embedder_from_state(real["embedding"], state)
    try:
        assert type(emb) is LlamaCppEmbedder
        assert emb.model_id == BUNDLED_MODEL_ID
        assert emb.kind == "bundled"
    finally:
        emb.client.close()


# ---------------------------------------------------------------- 4. 自己部署的本地服务（Ollama）


class LocalMock:
    """Ollama 风格：/v1/embeddings 缺 model 回 400；有 /v1/models；没有 /health。"""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.models = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "POST" and request.url.path == "/v1/embeddings":
            body = json.loads(request.content.decode("utf-8"))
            if "model" not in body:
                return httpx.Response(400, json={"error": "model is required"})
            data = [{"index": i, "embedding": [1.0, 2.0, 3.0, 4.0]}
                    for i in range(len(body.get("input") or []))]
            return httpx.Response(200, json={"data": data})
        if request.method == "GET" and request.url.path == "/v1/models":
            self.models += 1
            return httpx.Response(200, json={"object": "list", "data": []})
        return httpx.Response(404)


def test_local_ollama_compatible(cfg, state, http_factory) -> None:
    mock = LocalMock()
    http_factory(mock.handle)
    write_settings(state, {"version": 1, "kind": "local", "local": section()})
    emb = make_embedder_from_state(cfg["embedding"], state)
    assert type(emb) is LocalOpenAIEmbedder
    assert emb.model_id.startswith("oai-local:")
    assert emb.provider == "local" and emb.kind == "local"

    out = emb.embed_docs(["你好", "世界", "第三句"])
    assert out.shape == (3, 4)
    posts = [r for r in mock.requests if r.method == "POST"]
    assert posts and all(json.loads(r.content)["model"] == "bge-m3" for r in posts)
    # 没配 localApiKey 就绝不能带 Authorization
    assert all("authorization" not in r.headers for r in mock.requests)
    # 健康检查走 /v1/models；10 秒内不重复问；从不访问 Ollama 没有的 /health
    assert emb.healthy() is True
    assert emb.healthy() is True
    assert mock.models == 1
    assert not any(r.url.path == "/health" for r in mock.requests)


def test_local_optional_key(cfg, state, http_factory) -> None:
    mock = LocalMock()
    http_factory(mock.handle)
    write_key(state, localApiKey="sk-local-only", apiKey="sk-cloud-must-not-be-used")
    write_settings(state, {"version": 1, "kind": "local", "local": section()})
    emb = make_embedder_from_state(cfg["embedding"], state)
    emb.embed_docs(["x"])
    posts = [r for r in mock.requests if r.method == "POST"]
    assert posts[0].headers["authorization"] == "Bearer sk-local-only"


def test_local_health_cache_expires(state, http_factory, monkeypatch) -> None:
    """10 秒后重新检查：缓存不能永久挡住恢复。"""
    mock = LocalMock()
    http_factory(mock.handle)
    write_settings(state, {"version": 1, "kind": "local", "local": section()})
    emb = make_embedder_from_state({}, state)
    assert emb.healthy() is True
    clock = [emb._health_cache[0]]
    monkeypatch.setattr("memory_rag.embeddings.time.monotonic", lambda: clock[0] + 11)
    assert emb.healthy() is True
    assert mock.models == 2


# ---------------------------------------------------------------- 5. 本地填了非回环 = 坏配置不崩


def test_local_non_loopback_becomes_broken_not_crash(cfg, state) -> None:
    write_settings(state, {"version": 1, "kind": "local",
                           "local": section(baseUrl="http://192.168.1.5:11434/v1")})
    emb = make_embedder_from_state(cfg["embedding"], state)  # 不抛
    assert type(emb) is BrokenConfigEmbedder
    assert "回环" in emb.error
    assert emb.healthy() is False
    with pytest.raises(EmbeddingUnavailable):
        emb.embed_docs(["x"])


# ---------------------------------------------------------------- 6. cloud 的 batch 来自设置文件


def test_cloud_batch_from_settings(cfg, state, http_factory) -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        bodies.append(body)
        if len(body["input"]) > 10:  # 假服务：每批最多 10 条
            return httpx.Response(400, json={"error": "too many inputs"})
        data = [{"index": i, "embedding": [1.0, 2.0, 3.0, 4.0]}
                for i in range(len(body["input"]))]
        return httpx.Response(200, json={"data": data})

    http_factory(handler)
    write_key(state, apiKey="sk-cloud")
    write_settings(state, {"version": 1, "kind": "cloud",
                           "cloud": {"baseUrl": "https://api.example.com/v1", "model": "BAAI/bge-m3",
                                     "dim": 4, "instruct": "", "appendEos": False,
                                     "sendDimensions": False, "batch": 10, "timeoutS": 30}})
    emb = make_embedder_from_state(cfg["embedding"], state)
    assert type(emb) is ApiEmbedder
    assert emb.model_id.startswith("api:")
    out = emb.embed_docs([f"t{i}" for i in range(25)])
    assert out.shape == (25, 4)
    assert [len(b["input"]) for b in bodies] == [10, 10, 5]
    assert all(b["model"] == "BAAI/bge-m3" and b["encoding_format"] == "float" for b in bodies)


# ---------------------------------------------------------------- 7. 坏配置：不崩、不 mismatch、不动向量库


ROWS = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
    (60, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (61, "out", None, "", "这版动画脚本结构清楚多了"),
]


class Seeded:
    pass


def seed_state(cfg, state):
    """先用假 embedding 建好库，模拟「线上本来有数据」，再让坏配置的 Service 打开它。"""
    from memory_rag.fts import ChunkDB
    from memory_rag.indexer import Indexer
    from memory_rag.store import VectorStore

    write_archive(state, "private:111", ROWS)
    emb = FakeEmbedder()
    db = ChunkDB(cfg["paths"].rag / "rag.sqlite3")
    vs = VectorStore(cfg["paths"].rag / "chroma", emb.model_id, emb.dim)
    Indexer(cfg, emb, db, vs).run(now_ms=FAR_FUTURE)
    chars = int(db.conn.execute("SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM chunks").fetchone()["n"])
    s = Seeded()
    s.db, s.vstore, s.emb = db, vs, emb
    meta, vectors = dict(vs.col.metadata), vs.count()
    close_rag(s)
    return meta, vectors, chars


BAD_SETTINGS = [
    ("{这不是 JSON", "不是合法 JSON"),
    (json.dumps({"version": 1, "kind": "xyz"}), "未知的部署方式"),
    (json.dumps({"version": 1, "kind": "local"}), "local 段"),
    (json.dumps({"version": 1, "kind": "local",
                 "local": {"baseUrl": "http://127.0.0.1:11434/v1", "dim": 1024,
                           "instruct": "", "appendEos": False, "sendDimensions": False,
                           "batch": 32, "timeoutS": 30}}), "model"),
]


@pytest.mark.parametrize("settings,error_part", BAD_SETTINGS)
def test_broken_settings_never_crash(tmp_path: Path, cfg, state, settings, error_part) -> None:
    meta, vectors, chars = seed_state(cfg, state)
    write_settings(state, settings)
    write_key(state, apiKey=SECRET, localApiKey=SECRET)

    svc = Service(write_cfg(tmp_path, cfg))  # 不抛异常
    try:
        assert svc.mismatch is None
        assert svc.vstore is not None
        h = svc.health()
        assert h["ok"] is False
        assert h["embedding"]["healthy"] is False
        assert error_part in h["embedding"]["error"]
        # 原因类别里绝不能出现密钥
        assert SECRET not in json.dumps(h, ensure_ascii=False)
        # 向量库没被删、没被改
        assert dict(svc.vstore.col.metadata) == meta
        assert svc.vstore.count() == vectors
        assert h["store"]["vectors"] == vectors
        # 8. store.chars = 全部块文本字数之和
        assert h["store"]["chars"] == chars
        # 检索降级为 BM25
        out = svc.searcher.search("private:111", query="火锅", keywords=["火锅"])
        assert out["semantic"] == "unavailable"
        assert out["items"] and out["items"][0]["ids"]
    finally:
        close_rag(svc)


# ---------------------------------------------------------------- 9. 密钥不泄露


def test_key_never_in_errors_or_health(cfg, state, http_factory, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": []})
        return httpx.Response(500, json={"error": f"bad key {SECRET}"})

    http_factory(handler)
    write_key(state, localApiKey=SECRET)
    write_settings(state, {"version": 1, "kind": "local", "local": section()})
    emb = make_embedder_from_state(cfg["embedding"], state)
    with pytest.raises(EmbeddingUnavailable) as ei:
        emb.embed_docs(["秘密聊天内容"])
    assert str(ei.value) == "http 500"
    assert SECRET not in str(ei.value)


def test_key_never_in_health_when_service_up(cfg, state, tmp_path: Path) -> None:
    # 端口 9 没有服务：healthy() 只得到连接失败，但 /health 序列化里不能出现密钥
    write_key(state, localApiKey=SECRET)
    write_settings(state, {"version": 1, "kind": "local",
                           "local": section(baseUrl="http://127.0.0.1:9/v1")})
    svc = Service(write_cfg(tmp_path, cfg))
    try:
        dumped = json.dumps(svc.health(), ensure_ascii=False)
        assert SECRET not in dumped
    finally:
        close_rag(svc)


def test_local_timeout_is_sanitized(cfg, state, http_factory) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("boom")

    http_factory(handler)
    write_key(state, localApiKey=SECRET)
    write_settings(state, {"version": 1, "kind": "local", "local": section()})
    emb = make_embedder_from_state(cfg["embedding"], state)
    with pytest.raises(EmbeddingUnavailable) as ei:
        emb.embed_docs(["x"])
    assert str(ei.value) == "timeout"
    assert SECRET not in str(ei.value)
