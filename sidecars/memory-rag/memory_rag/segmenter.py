"""切块：先按时间分段，再在段内按话题切块（方案 §3.2.2）。

为什么不按固定字数切：单条聊天大多是「好啊」「哈哈」，单独做向量没有语义；一块里混了几件事，
向量被平均掉、哪件都不像。所以先按 30 分钟空档分段，段内再找话题低谷（TextTiling 思路）：
在每个相邻消息之间，比较「左边 3 条」和「右边 3 条」的向量相似度，相似度明显下凹的地方就是话题换了。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Sequence

import numpy as np

from .archive import NameBook, Row, fmt_line
from .embeddings import Embedder

MAX_LINE_CHARS = 1000  # 块里单条消息最多保留这么多字；原文全文仍在存档里


@dataclass
class Chunk:
    key: str
    rows: list[Row]
    cut_reason: str
    text: str = ""
    id: str = ""
    speakers: list[str] = field(default_factory=list)
    speaker_names: list[str] = field(default_factory=list)

    @property
    def t_start(self) -> float:
        return self.rows[0].t

    @property
    def t_end(self) -> float:
        return self.rows[-1].t

    def meta(self) -> dict:
        return {
            "key": self.key,
            "t_start": int(self.t_start),
            "t_end": int(self.t_end),
            "day": datetime.fromtimestamp(self.t_start / 1000.0).strftime("%Y-%m-%d"),
            "speakers": ",".join(self.speakers),
            "speaker_names": ",".join(self.speaker_names),
            "title": "",
            "cut_reason": self.cut_reason,
            "file_start": self.rows[0].file,
            "line_start": self.rows[0].line,
            "file_end": self.rows[-1].file,
            "line_end": self.rows[-1].line,
            "n_msgs": len(self.rows),
            "distilled": "pending",
        }


def chunk_id(key: str, rows: Sequence[Row]) -> str:
    """确定性 ID：同一批消息永远得到同一个 ID，重复写入即覆盖（upsert）。"""
    raw = f"{key}|{int(rows[0].t)}|{int(rows[-1].t)}|{rows[0].text}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def split_segments(rows: Sequence[Row], gap_ms: float) -> list[list[Row]]:
    segs: list[list[Row]] = []
    for r in rows:
        if segs and r.t - segs[-1][-1].t <= gap_ms:
            segs[-1].append(r)
        else:
            segs.append([r])
    return segs


def closed_segments(rows: Sequence[Row], now_ms: float, gap_ms: float) -> tuple[list[list[Row]], list[Row]]:
    """分出已结束的段和进行中的段。

    最后一段在出现 30 分钟空档前视为进行中：不切块、不做向量，由关键词检索临时兜底。
    「空档」既可以是后面来了新消息，也可以是到现在已经 30 分钟没人说话。
    """
    segs = split_segments(rows, gap_ms)
    if segs and now_ms - segs[-1][-1].t <= gap_ms:
        return segs[:-1], segs[-1]
    return segs, []


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))  # 向量已归一化


def depth_scores(sims: Sequence[float]) -> list[float]:
    """低谷深度 = 两侧峰值均值 − 谷值。峰值是从该点向左/右一路爬升到不再升高为止的最高点。"""
    n = len(sims)
    out = []
    for g in range(n):
        i = g
        while i - 1 >= 0 and sims[i - 1] >= sims[i]:
            i -= 1
        j = g
        while j + 1 < n and sims[j + 1] >= sims[j]:
            j += 1
        out.append((sims[i] + sims[j]) / 2.0 - sims[g])
    return out


class Segmenter:
    def __init__(self, cfg: dict, embedder: Embedder | None, names: NameBook):
        self.gap_ms = float(cfg.get("gap_minutes", 30)) * 60_000
        self.pause_ms = float(cfg.get("pause_minutes", 10)) * 60_000
        self.window = int(cfg.get("window", 3))
        self.min_msgs = int(cfg.get("min_msgs", 3))
        self.max_msgs = int(cfg.get("max_msgs", 15))
        self.max_chars = int(cfg.get("max_chars", 800))
        self.std_k = float(cfg.get("depth_std_k", 0.5))
        self.min_depth = float(cfg.get("min_depth", 0.05))
        self.cue_factor = float(cfg.get("cue_factor", 0.6))
        self.cue_words = tuple(cfg.get("cue_words") or ())
        self.embedder = embedder
        self.names = names

    # ------------------------------------------------------------------ 边界相似度

    def _win_text(self, rows: Sequence[Row]) -> str:
        # 判断话题边界只看说了什么，不带时间戳（时间对语义是噪声）
        return "\n".join(f"{self.names.name(r)}：{r.text[:300]}" for r in rows)

    def gap_sims(self, seg: Sequence[Row]) -> list[float]:
        """sims[g] = 第 g 条和第 g+1 条之间，左右两侧各 window 条的相似度。"""
        n, w = len(seg), self.window
        if n < 2:
            return []
        spans: dict[tuple[int, int], int] = {}
        pairs = []
        for g in range(n - 1):
            left = (max(0, g - w + 1), g + 1)
            right = (g + 1, min(n, g + 1 + w))
            for s in (left, right):
                spans.setdefault(s, len(spans))
            pairs.append((spans[left], spans[right]))
        order = sorted(spans, key=spans.get)
        vecs = self.embedder.embed_docs([self._win_text(seg[a:b]) for a, b in order])
        return [_cos(vecs[a], vecs[b]) for a, b in pairs]

    # ------------------------------------------------------------------ 切块

    def _is_cue(self, seg: Sequence[Row], g: int) -> bool:
        nxt = seg[g + 1]
        if nxt.t - seg[g].t > self.pause_ms:
            return True
        return nxt.text.lstrip().startswith(self.cue_words) if self.cue_words else False

    def _chars(self, rows: Sequence[Row]) -> int:
        return sum(len(r.text) for r in rows)

    def chunk_segment(self, seg: list[Row], first_reason: str = "time_gap") -> list[Chunk]:
        n = len(seg)
        need_topic = n >= 2 * self.min_msgs
        need_size = n > self.max_msgs or self._chars(seg) > self.max_chars
        sims: list[float] = []
        if (need_topic or need_size) and self.embedder is not None:
            sims = self.gap_sims(seg)

        # cuts[g] = 原因：在第 g 条之后切开
        cuts: dict[int, str] = {}
        if need_topic and sims:
            depth = depth_scores(sims)
            base = max(self.min_depth, float(np.mean(depth) + self.std_k * np.std(depth)))
            for g, d in enumerate(depth):
                # 只在谷底切：下坡途中的点也有深度，但切在那里会把话题边界前后的半句话分错边
                if d <= 0 or (g > 0 and sims[g] > sims[g - 1]) or (g < len(sims) - 1 and sims[g] > sims[g + 1]):
                    continue
                if d >= base:
                    cuts[g] = "topic_shift"
                elif self._is_cue(seg, g) and d >= base * self.cue_factor:
                    cuts[g] = "cue_word"

        pieces = self._pieces(n, cuts)
        pieces = self._merge_small(pieces, cuts, sims)
        pieces = self._split_large(seg, pieces, cuts, sims)

        out = []
        for idx, (a, b) in enumerate(pieces):
            reason = first_reason if idx == 0 else cuts.get(a - 1, "topic_shift")
            out.append(self._make(seg[0].key, seg[a:b], reason))
        return out

    @staticmethod
    def _pieces(n: int, cuts: dict[int, str]) -> list[tuple[int, int]]:
        bounds = [0] + [g + 1 for g in sorted(cuts)] + [n]
        return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1) if bounds[i] < bounds[i + 1]]

    def _merge_small(self, pieces, cuts, sims):
        """不足 min_msgs 条的块并入相似度更高的那一侧（去掉相似度更高的那条边界）。"""
        pieces = list(pieces)
        while len(pieces) > 1:
            small = [i for i, (a, b) in enumerate(pieces) if b - a < self.min_msgs]
            if not small:
                break
            i = small[0]
            left_sim = sims[pieces[i][0] - 1] if i > 0 and sims else -1.0
            right_sim = sims[pieces[i][1] - 1] if i < len(pieces) - 1 and sims else -1.0
            if i == 0 or (i < len(pieces) - 1 and right_sim >= left_sim):
                cuts.pop(pieces[i][1] - 1, None)
                pieces[i:i + 2] = [(pieces[i][0], pieces[i + 1][1])]
            else:
                cuts.pop(pieces[i][0] - 1, None)
                pieces[i - 1:i + 1] = [(pieces[i - 1][0], pieces[i][1])]
        return pieces

    def _split_large(self, seg, pieces, cuts, sims):
        """超过 max_msgs 条或 max_chars 字的块，在块内相似度最低处再切。

        字数超限时只在两边都还能保住 min_msgs 条时才切：一条很长的消息（比如贴过来的整段提示词）
        宁可让块超长，也不要切出一两条的碎块。
        """
        out = []
        stack = list(reversed(pieces))
        while stack:
            a, b = stack.pop()
            length = b - a
            too_many = length > self.max_msgs
            too_long = self._chars(seg[a:b]) > self.max_chars and length >= 2 * self.min_msgs
            if not (too_many or too_long) or length < 2:
                out.append((a, b))
                continue
            lo, hi = a + self.min_msgs - 1, b - self.min_msgs - 1
            if lo > hi:  # 保不住两边各 min_msgs 条，就从中间切
                lo = hi = a + length // 2 - 1
            cand = range(lo, hi + 1)
            g = min(cand, key=lambda k: sims[k] if sims else 0.0) if sims else (a + b) // 2 - 1
            cuts[g] = "size_limit"
            stack.append((g + 1, b))
            stack.append((a, g + 1))
        return out

    def _make(self, key: str, rows: list[Row], reason: str) -> Chunk:
        c = Chunk(key=key, rows=rows, cut_reason=reason)
        lines = []
        for r in rows:
            line = fmt_line(r, self.names)
            lines.append(line if len(line) <= MAX_LINE_CHARS + 30 else line[:MAX_LINE_CHARS + 30] + "…")
        c.text = "\n".join(lines)
        c.id = chunk_id(key, rows)
        seen_ids, seen_names = [], []
        for r in rows:
            if r.is_self or not r.user_id:
                continue
            if r.user_id not in seen_ids:
                seen_ids.append(r.user_id)
                seen_names.append(self.names.name(r))
        c.speakers, c.speaker_names = seen_ids, seen_names
        return c
