"""读 config.yml，把相对路径换成绝对路径。

路径一律相对 config.yml 所在目录解析，不靠当前工作目录：服务、测试、评估脚本的 CWD 各不相同。

UPGRADE_PATCH：用户改过的参数放 `<state>/long-memory/rag/config.local.yml`（只放改过的键），
深合并到出厂 config.yml 上；出厂文件程序永远不写，`git pull` 更新它也不会和用户的修改冲突。
合并规则与 `scripts/rag-config.py`、`src/api-hub.js` 三处一致，用例在 `tests/fixtures/config_merge_cases.json`。
"""

from __future__ import annotations

import copy
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config.yml"
# UPGRADE_PATCH：用户覆盖文件，相对 state 目录
LOCAL_CONFIG_REL = ("long-memory", "rag", "config.local.yml")

log = logging.getLogger("memory_rag.config")
_warned: set[tuple[str, str]] = set()  # 同一个坏文件只告警一次（load_config 可能被多次调用）


def _warn_once(path: Path, msg: str) -> None:
    if (str(path), msg) in _warned:
        return
    _warned.add((str(path), msg))
    log.warning(msg)


@dataclass
class Paths:
    state: Path          # qq-bridge/state
    long_memory: Path    # state/long-memory
    archive: Path        # state/long-memory/archive
    people: Path         # state/long-memory/people.json
    rag: Path            # state/long-memory/rag（派生数据，随时可删可重建）
    # RAG_PATCH（P2）：桥接删完存档后写的遗忘请求（每个会话一个 JSON），本服务消费
    forget_requests: Path  # state/long-memory/forget-requests

    @classmethod
    def from_state(cls, state: Path) -> "Paths":
        lm = state / "long-memory"
        return cls(state=state, long_memory=lm, archive=lm / "archive", people=lm / "people.json",
                   rag=lm / "rag", forget_requests=lm / "forget-requests")


def _merge(base: Any, local: Any) -> Any:
    if not (isinstance(base, dict) and isinstance(local, dict)):
        # 列表、标量、类型不同：整体替换。列表不拼接——用户写了 self_names 就是想要这一份
        return copy.deepcopy(local)
    out = copy.deepcopy(base)
    for k, v in local.items():
        if v is None:
            out.pop(k, None)  # null = 删掉这个键，回到代码里的缺省
        elif k in out:
            out[k] = _merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def merge_config(base: dict, local: Any) -> dict:
    """UPGRADE_PATCH：出厂配置 + 用户覆盖 → 新字典（两个参数都不改）。

    映射递归合并；列表与标量整体替换；值为 null 的键 = 删除该键。
    覆盖顶层不是映射（空文件、写成了列表）= 没有覆盖。覆盖里顶层的 state_dir 忽略：
    覆盖文件本身就放在 state 目录里，让它改 state 会成环。
    """
    if not isinstance(local, dict):
        return copy.deepcopy(base)
    local = {k: v for k, v in local.items() if k != "state_dir"}
    return _merge(base, local)


def _read_local(path: Path) -> Any:
    """读覆盖文件；不存在返回 None，坏了告警一次、也返回 None（服务照常起，按没有覆盖算）。"""
    try:
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f)
    except FileNotFoundError:
        return None
    except Exception as e:  # YAML 语法错、权限、编码……一律不拦启动
        _warn_once(path, f"config.local.yml 读不了（{type(e).__name__}），按没有覆盖处理")
        return None
    if doc is not None and not isinstance(doc, dict):
        _warn_once(path, "config.local.yml 顶层不是映射，按没有覆盖处理")
        return None
    return doc


def load_config(path: str | os.PathLike | None = None) -> dict[str, Any]:
    p = Path(path or os.environ.get("MEMORY_RAG_CONFIG") or DEFAULT_CONFIG).resolve()
    with open(p, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    state = os.environ.get("MEMORY_RAG_STATE_DIR") or cfg.get("state_dir") or "../../state"
    state_path = Path(state)
    if not state_path.is_absolute():
        state_path = (p.parent / state_path).resolve()
    # UPGRADE_PATCH：state 按出厂文件定好之后再合并覆盖；没有覆盖文件时 cfg 原样不动
    local = _read_local(state_path.joinpath(*LOCAL_CONFIG_REL))
    if local:
        cfg = merge_config(cfg, local)
    cfg["paths"] = Paths.from_state(state_path)
    return cfg
