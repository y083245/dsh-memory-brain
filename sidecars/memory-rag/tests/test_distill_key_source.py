"""APIHUB_PATCH：话题提炼的密钥来源（和人格判读共用 / 单独配置）。

全部用临时 state + `httpx.MockTransport` 假模型：不联网、不读真实 state/、不读任何真实密钥。
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx

from conftest import FAR_FUTURE, write_archive, write_persona_config
from memory_rag.distill import Distiller
from memory_rag.l2 import L2

PRIVATE = "private:111"
GROUP = "group:222"

ROWS = [
    (0, "in", "111", "平安", "今天加班到九点，饿死了"),
    (1, "in", "111", "平安", "周末想去吃那家重庆火锅"),
    (2, "out", None, "", "那家排队好久的？"),
]
GROUP_ROWS = [
    (0, "in", "111", "平安", "我改了一版蝴蝶效应的提示词"),
    (1, "out", None, "", "这版动画脚本结构清楚多了"),
]


class FakeChat:
    """记录每次请求（URL / 头 / 体），回一份合格的 JSON 摘要。"""

    def __init__(self):
        self.calls: list[dict] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append({
            "url": str(request.url),
            "headers": {k.lower(): v for k, v in request.headers.items()},
            "body": json.loads(request.content.decode("utf-8")),
        })
        content = json.dumps({"title": "周末吃火锅", "summary": "平安说周末想去吃重庆火锅。",
                              "importance": 0.6, "valence": 0.2,
                              "entities": [], "relations": []}, ensure_ascii=False)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
                      "completion_tokens": 10},
        })


def make_distiller(stack, cfg, fake: FakeChat) -> Distiller:
    return Distiller(cfg, stack.db, L2(stack.db), stack.vs, stack.emb,
                     http=httpx.Client(transport=httpx.MockTransport(fake.handle)))


def write_distill_api(state: Path, **kw) -> Path:
    p = state / "long-memory/rag/distill-api.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(kw, ensure_ascii=False), encoding="utf-8")
    p.chmod(0o600)
    return p


def test_no_file_uses_shared_persona_key(stack, cfg, state) -> None:
    write_archive(state, PRIVATE, ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state, api_key="sk-shared", model="deepseek-flash",
                         base_url="https://api.deepseek.com")
    fake = FakeChat()
    d = make_distiller(stack, cfg, fake)
    assert d.status()["source"] == "shared"
    assert d.status()["key"] is True

    d.run_once(now_ms=int(FAR_FUTURE))
    assert fake.calls
    c = fake.calls[0]
    assert c["url"] == "https://api.deepseek.com/chat/completions"
    assert c["headers"]["authorization"] == "Bearer sk-shared"
    assert c["body"]["model"] == "deepseek-flash"


def test_own_file_uses_its_key_url_and_model(stack, cfg, state) -> None:
    write_archive(state, PRIVATE, ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state, api_key="sk-shared")
    write_distill_api(state, useShared=False, baseUrl="https://own.example.com/v1/",
                      model="own-model", apiKey="sk-own")
    fake = FakeChat()
    d = make_distiller(stack, cfg, fake)
    st = d.status()
    assert st["source"] == "own" and st["key"] is True and st["model"] == "own-model"

    d.run_once(now_ms=int(FAR_FUTURE))
    c = fake.calls[0]
    assert c["url"] == "https://own.example.com/v1/chat/completions"
    assert c["headers"]["authorization"] == "Bearer sk-own"
    assert c["body"]["model"] == "own-model"


def test_own_without_key_does_not_fall_back(stack, cfg, state) -> None:
    write_archive(state, PRIVATE, ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state, api_key="sk-shared")  # 人格那把存在，但绝不能回落
    write_distill_api(state, useShared=False, baseUrl="https://own.example.com/v1",
                      model="own-model", apiKey="")
    fake = FakeChat()
    d = make_distiller(stack, cfg, fake)
    assert d.status()["key"] is False
    assert d.status()["source"] == "own"

    assert d.run_once(now_ms=int(FAR_FUTURE))["calls"] == 0
    assert fake.calls == []


def test_file_is_read_every_time_not_cached(stack, cfg, state) -> None:
    write_archive(state, PRIVATE, ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    write_persona_config(state, api_key="sk-shared")
    fake = FakeChat()
    d = make_distiller(stack, cfg, fake)
    d.run_once(now_ms=int(FAR_FUTURE))
    assert fake.calls[0]["headers"]["authorization"] == "Bearer sk-shared"
    assert d.status()["source"] == "shared"

    # 控制台保存后不重启服务：同一个 Distiller 立刻改用新文件
    write_distill_api(state, useShared=False, baseUrl="https://own.example.com/v1",
                      model="own-model", apiKey="sk-own-2")
    assert d.status()["source"] == "own" and d.status()["model"] == "own-model"

    # 再跑一轮（新会话的块）：请求改用新密钥 / 地址 / 模型
    write_archive(state, GROUP, GROUP_ROWS)
    stack.indexer.run(now_ms=FAR_FUTURE)
    d.run_once(now_ms=int(FAR_FUTURE))
    last = fake.calls[-1]
    assert last["url"] == "https://own.example.com/v1/chat/completions"
    assert last["headers"]["authorization"] == "Bearer sk-own-2"
    assert last["body"]["model"] == "own-model"
