"""读 config.yml，把相对路径换成绝对路径。

路径一律相对 config.yml 所在目录解析，不靠当前工作目录：服务、测试、评估脚本的 CWD 各不相同。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config.yml"


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


def load_config(path: str | os.PathLike | None = None) -> dict[str, Any]:
    p = Path(path or os.environ.get("MEMORY_RAG_CONFIG") or DEFAULT_CONFIG).resolve()
    with open(p, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    state = os.environ.get("MEMORY_RAG_STATE_DIR") or cfg.get("state_dir") or "../../state"
    state_path = Path(state)
    if not state_path.is_absolute():
        state_path = (p.parent / state_path).resolve()
    cfg["paths"] = Paths.from_state(state_path)
    return cfg
