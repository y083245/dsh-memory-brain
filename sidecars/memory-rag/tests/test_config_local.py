"""UPGRADE_PATCH：config.local.yml 覆盖层（接口约定 §1.3）。

- 合并规则：`tests/fixtures/config_merge_cases.json` 的每一条，config.py 与 scripts/rag-config.py 两份实现都要过；
  桥接的 JS 实现（api-hub.js 的 mergeRagConfig）读同一份文件。
- 没有覆盖文件时 load_config 与改动前**逐值相同**：改动前的实现原样复制在下面当基准。
- 覆盖坏了：告警一次、按没有覆盖处理、服务照常起。
全部用 tmp_path，不碰真实 state/。
"""

from __future__ import annotations

import copy
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

from memory_rag import config as config_mod
from memory_rag.config import Paths, load_config, merge_config

from conftest import ROOT, FakeEmbedder, close_rag

REPO = ROOT.parent.parent
CASES = json.loads((ROOT / "tests" / "fixtures" / "config_merge_cases.json").read_text(encoding="utf-8"))


def _load_rag_config_script():
    # 不往仓库的 scripts/ 下写 __pycache__
    old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec = importlib.util.spec_from_file_location("rag_config_script", REPO / "scripts" / "rag-config.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    return mod


RAG_CONFIG = _load_rag_config_script()


# ---------------------------------------------------------------- 改动前的 load_config（基准，逐字复制）


def load_config_before(path: str | os.PathLike | None = None) -> dict[str, Any]:
    p = Path(path or os.environ.get("MEMORY_RAG_CONFIG") or config_mod.DEFAULT_CONFIG).resolve()
    with open(p, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    state = os.environ.get("MEMORY_RAG_STATE_DIR") or cfg.get("state_dir") or "../../state"
    state_path = Path(state)
    if not state_path.is_absolute():
        state_path = (p.parent / state_path).resolve()
    cfg["paths"] = Paths.from_state(state_path)
    return cfg


def _local_path(state: Path) -> Path:
    return state / "long-memory" / "rag" / "config.local.yml"


@pytest.fixture
def factory(tmp_path: Path, state: Path) -> Path:
    """出厂 config.yml 的副本，state_dir 指到临时 state。"""
    base = yaml.safe_load((ROOT / "config.yml").read_text(encoding="utf-8"))
    base["state_dir"] = str(state)
    p = tmp_path / "config.yml"
    p.write_text(yaml.safe_dump(base, allow_unicode=True), encoding="utf-8")
    return p


def _write_local(state: Path, text: str) -> Path:
    p = _local_path(state)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


# ---------------------------------------------------------------- 合并规则


def test_fixture_has_enough_cases():
    assert len(CASES) >= 12
    assert len({c["name"] for c in CASES}) == len(CASES)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_merge_cases_config_py(case):
    base, local = copy.deepcopy(case["base"]), copy.deepcopy(case["local"])
    assert merge_config(base, local) == case["expected"]
    # 两个参数都不能被改
    assert base == case["base"] and local == case["local"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_merge_cases_rag_config_script(case):
    base, local = copy.deepcopy(case["base"]), copy.deepcopy(case["local"])
    assert RAG_CONFIG.merge_config(base, local) == case["expected"]
    assert base == case["base"] and local == case["local"]


def test_merge_result_does_not_alias_inputs():
    base = {"a": {"b": [1, 2]}, "c": {"d": 1}}
    local = {"c": {"e": [3]}}
    out = merge_config(base, local)
    out["a"]["b"].append(9)
    out["c"]["e"].append(9)
    assert base == {"a": {"b": [1, 2]}, "c": {"d": 1}}
    assert local == {"c": {"e": [3]}}


# ---------------------------------------------------------------- 没有覆盖：与改动前逐值相同


def test_no_override_equals_before_tmp_config(factory: Path):
    assert load_config(factory) == load_config_before(factory)


def test_no_override_equals_before_factory_config(monkeypatch, state: Path):
    # 出厂 config.yml 本身（state 用环境变量指到临时目录）
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    assert load_config(ROOT / "config.yml") == load_config_before(ROOT / "config.yml")
    monkeypatch.setenv("MEMORY_RAG_CONFIG", str(ROOT / "config.yml"))
    assert load_config() == load_config_before()


@pytest.mark.parametrize("text", ["", "# 只有注释\n", "{}\n", "null\n"])
def test_empty_override_equals_before(factory: Path, state: Path, text: str):
    _write_local(state, text)
    assert load_config(factory) == load_config_before(factory)


# ---------------------------------------------------------------- 有覆盖


def test_override_merges_and_keeps_paths(factory: Path, state: Path):
    _write_local(state, "recall:\n  tau: 0.5\ndistill:\n  self_names: [阿鱼]\n  daily_limit: null\n")
    before = load_config_before(factory)
    cfg = load_config(factory)
    assert cfg["recall"]["tau"] == 0.5
    assert cfg["recall"]["exclude_recent_hours"] == before["recall"]["exclude_recent_hours"]
    assert cfg["distill"]["self_names"] == ["阿鱼"]
    assert "daily_limit" not in cfg["distill"]
    assert cfg["paths"] == before["paths"]
    # 其余段落原样
    for k in before:
        if k not in ("recall", "distill"):
            assert cfg[k] == before[k], k


def test_override_state_dir_ignored(factory: Path, state: Path, tmp_path: Path):
    _write_local(state, f"state_dir: {tmp_path / 'elsewhere'}\nsearch:\n  top_chunks: 7\n")
    cfg = load_config(factory)
    assert cfg["paths"].state == state.resolve()
    assert cfg["state_dir"] == str(state)
    assert cfg["search"]["top_chunks"] == 7


def test_override_located_by_env_state_dir(monkeypatch, tmp_path: Path, factory: Path):
    # MEMORY_RAG_STATE_DIR 优先于 config.yml 的 state_dir：覆盖文件也跟着去那里找
    other = tmp_path / "other-state"
    _write_local(other, "search:\n  rrf_k: 61\n")
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(other))
    cfg = load_config(factory)
    assert cfg["paths"].state == other.resolve()
    assert cfg["search"]["rrf_k"] == 61


def test_override_relative_state_dir(tmp_path: Path):
    # state_dir 是相对路径时相对 config.yml 所在目录解析（与改动前一致），覆盖文件在解析后的 state 下
    d = tmp_path / "sidecar"
    d.mkdir()
    (d / "config.yml").write_text("state_dir: ../st\nsearch:\n  rrf_k: 60\n", encoding="utf-8")
    _write_local(tmp_path / "st", "search:\n  rrf_k: 42\n")
    cfg = load_config(d / "config.yml")
    assert cfg["paths"].state == (tmp_path / "st").resolve()
    assert cfg["search"]["rrf_k"] == 42


# ---------------------------------------------------------------- 坏覆盖：告警一次、按没有覆盖


@pytest.mark.parametrize("text", ["recall: [unclosed\n", "- a\n- b\n", "just a string\n", "42\n"])
def test_broken_override_falls_back(factory: Path, state: Path, caplog, text: str):
    p = _write_local(state, text)
    config_mod._warned.clear()
    with caplog.at_level(logging.WARNING, logger="memory_rag.config"):
        assert load_config(factory) == load_config_before(factory)
        assert load_config(factory) == load_config_before(factory)
    warns = [r for r in caplog.records if r.name == "memory_rag.config"]
    assert len(warns) == 1, [r.getMessage() for r in warns]
    assert "config.local.yml" in warns[0].getMessage()
    # 告警里不带路径（日志可能被贴出来），也不带文件内容
    assert str(p) not in warns[0].getMessage()


def test_broken_override_service_still_starts(monkeypatch, state: Path):
    _write_local(state, "recall: {tau: [\n")
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    from memory_rag.service import Service

    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    try:
        assert svc.cfg["recall"]["tau"] == load_config_before(ROOT / "config.yml")["recall"]["tau"]
        assert svc.health()["schema"]["readonly"] is False
    finally:
        close_rag(svc)


def test_service_uses_override(monkeypatch, state: Path):
    _write_local(state, "search:\n  top_chunks: 2\n")
    monkeypatch.setenv("MEMORY_RAG_STATE_DIR", str(state))
    from memory_rag.service import Service

    svc = Service(str(ROOT / "config.yml"), embedder=FakeEmbedder())
    try:
        assert svc.cfg["search"]["top_chunks"] == 2
    finally:
        close_rag(svc)
