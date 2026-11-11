"""读聊天存档（L0）。存档是唯一原始数据：这里只读，从不改写。

存档格式见 src/long-memory.js archive()：每个会话一个目录、每月一个 JSONL，每行
{t, dir: in|out, userId, name, text, msgId}。同一会话的多个月份文件按文件名排序后首尾相接，
看成一条消息序列；每条记住它在哪个文件、第几行、从哪个字节开始，方便增量读取与回溯原文。
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .channel_archive import (
    ChannelArchiveChanged,
    ChannelArchiveError,
    channel_directory,
    channel_keys,
    channel_snapshot,
    published_files,
    records,
)
from .channel_identity import is_channel_key, is_channel_person_key

KEY_RE = re.compile(r"^(group|private):(\d+)$")
FILE_RE = re.compile(r"^\d{4}-\d{2}\.jsonl$")


def key_dir(key: str) -> str:
    if is_channel_key(key):
        return channel_directory(key)
    m = KEY_RE.match(str(key or ""))
    if not m:
        raise ValueError(f"会话 key 不合法：{key}")
    return f"{m.group(1)}_{m.group(2)}"


def valid_key(key: str) -> bool:
    return bool(KEY_RE.match(str(key or ""))) or is_channel_key(key)


@dataclass
class Row:
    key: str
    file: str        # 相对所在存档根目录的路径，如 private_100000001/2026-10.jsonl
    line: int        # 1 起
    offset: int      # 本行在文件里的起始字节
    end: int         # 本行结束（含换行）的字节，增量读取的水位推到这里
    t: float         # 毫秒时间戳
    dir: str
    user_id: str | None
    name: str
    text: str
    record_id: str | None = None
    person_key: str | None = None
    message_key: str | None = None
    reply_to_message_key: str | None = None

    @property
    def is_self(self) -> bool:
        return self.dir == "out"


def parse_ts(s: str) -> float:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000.0


def _legacy_keys(archive: Path) -> list[str]:
    out = []
    if archive.is_dir():
        for d in sorted(archive.iterdir()):
            k = d.name.replace("_", ":", 1)
            if d.is_dir() and KEY_RE.match(k):
                out.append(k)
    return out


def list_keys(archive: Path) -> list[str]:
    return _legacy_keys(archive) + channel_keys(archive)


def key_files(archive: Path, key: str) -> list[str]:
    if is_channel_key(key):
        return [file.rel for file in published_files(archive, key)]
    d = archive / key_dir(key)
    if not d.is_dir():
        return []
    return [f"{d.name}/{n.name}" for n in sorted(d.iterdir()) if FILE_RE.match(n.name)]


_SURROGATE = re.compile(r"[\ud800-\udfff]")


def _safe_display(value: str) -> str:
    # JS slice counts UTF-16 code units, so a published JSON string may
    # end in one half of an emoji. Tokenizers need a valid Unicode string.
    if _SURROGATE.search(value):
        return value.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="replace")
    return value


def _read_channel_rows(
    archive: Path, key: str, start_file: str | None, start_offset: int, start_line: int,
    trusted_cursor: bool,
) -> list[Row]:
    files = published_files(archive, key)
    if type(start_offset) is not int or start_offset < 0 or type(start_line) is not int or start_line < 1:
        raise ChannelArchiveError()
    if start_file is None:
        if start_offset != 0 or start_line != 1:
            raise ChannelArchiveError()
    else:
        for index, file in enumerate(files):
            if file.rel == start_file:
                files = files[index:]
                break
        else:
            raise ChannelArchiveError()

    rows = []
    for file in files:
        offset, expected_line = (start_offset, start_line) if file.rel == start_file else (0, 1)
        cursor_line = expected_line if trusted_cursor else (1 if offset == 0 else None)
        scan_from = (offset, expected_line) if trusted_cursor else (0, 1)
        for line, begin, end, _, row in records(file, key, *scan_from):
            if end == offset:
                cursor_line = line + 1
            if begin < offset or row.get("deleted") is True:
                continue
            name = row.get("name")
            rows.append(Row(
                key=key, file=file.rel, line=line, offset=begin, end=end, t=row["timestamp"],
                dir=row["dir"], user_id=row["userId"], name=_safe_display(name) if isinstance(name, str) else "",
                text=_safe_display(row["text"]), record_id=row["recordId"], person_key=row["personKey"],
                message_key=row["messageKey"], reply_to_message_key=row["replyToMessageKey"],
            ))
        if cursor_line != expected_line:
            raise ChannelArchiveError()
    return rows


def read_rows(
    archive: Path, key: str, start_file: str | None = None, start_offset: int = 0, start_line: int = 1,
    *, trusted_cursor: bool = False,
) -> list[Row]:
    """读取水位后的完整行。仅在已核对存档快照和持久化水位后使用 trusted_cursor。"""
    if is_channel_key(key):
        return _read_channel_rows(archive, key, start_file, start_offset, start_line, trusted_cursor)
    rows: list[Row] = []
    files = key_files(archive, key)
    if start_file is not None and start_file in files:
        files = files[files.index(start_file):]
    for rel in files:
        first = rel == start_file
        offset = start_offset if first else 0
        line_no = start_line if first else 1
        with open(archive / rel, "rb") as f:
            f.seek(offset)
            data = f.read()
        pos = 0
        while pos < len(data):
            nl = data.find(b"\n", pos)
            if nl < 0:
                break
            raw = data[pos:nl]
            begin = offset + pos
            pos = nl + 1
            cur = line_no
            line_no += 1
            if not raw.strip():
                continue
            try:
                r = json.loads(raw.decode("utf-8"))
                # RAG_PATCH（P2）：墓碑行是桥接原地改写的等长删除标记（{"deleted": true}），
                # 跳过但仍计行号。它本来也没有 t，下面会当坏行跳过；这里显式写清楚意图。
                if isinstance(r, dict) and r.get("deleted") is True:
                    continue
                rows.append(Row(
                    key=key, file=rel, line=cur, offset=begin, end=offset + pos,
                    t=parse_ts(r["t"]), dir=str(r.get("dir") or "in"),
                    user_id=None if r.get("userId") is None else str(r.get("userId")),
                    name=str(r.get("name") or ""), text=str(r.get("text") or ""),
                ))
            except (ValueError, KeyError):
                # 坏行跳过但仍计行号，保证 file/line 与 cat -n 对得上
                continue
    return rows


class RowCache:
    """按会话缓存整条消息序列，文件大小变了才重读。检索时扩展上下文要前后翻行，逐次读文件太慢。"""

    def __init__(self, archive: Path):
        self.archive = archive
        self._cache: dict[str, tuple[tuple, list[Row], dict[tuple[str, int], int]]] = {}

    def _sig(self, key: str) -> tuple:
        if is_channel_key(key):
            snapshot, _ = channel_snapshot(self.archive, key)
            return tuple((rel, file["bytes"], file["sha256"]) for rel, file in snapshot.items())
        sig = []
        for rel in key_files(self.archive, key):
            try:
                st = (self.archive / rel).stat()
            except OSError:
                continue
            # RAG_PATCH（P2）：只看大小发现不了等长墓碑改写（文件大小不变），会把旧缓存
            # 里的已删内容继续扩进检索结果；带上 st_mtime_ns 才能发现原地改写。
            sig.append((rel, st.st_size, st.st_mtime_ns))
        return tuple(sig)

    def invalidate(self, key: str) -> None:
        """RAG_PATCH（P2）：遗忘后必须清缓存——墓碑不改大小，不能只等签名变化。"""
        self._cache.pop(key, None)

    def rows(self, key: str) -> tuple[list[Row], dict[tuple[str, int], int]]:
        sig = self._sig(key)
        hit = self._cache.get(key)
        if hit and hit[0] == sig:
            return hit[1], hit[2]
        rows = read_rows(self.archive, key)
        if is_channel_key(key) and self._sig(key) != sig:
            raise ChannelArchiveChanged()
        index = {(r.file, r.line): i for i, r in enumerate(rows)}
        self._cache[key] = (sig, rows, index)
        return rows, index


class NameBook:
    """固定称呼：同一个 QQ 号在所有块里用同一个名字。

    优先人物账本的 name；没有就用该 QQ 号在存档里最常用的昵称；都没有才用 QQ 号。
    不用当时的群名片 —— 群名片会改，前后叫法不一会把检索打散。自己发的统一写「我」。
    """

    def __init__(self, people_file: Path, archive: Path | None = None):
        self.ledger: dict[str, str] = {}
        try:
            data = json.loads(people_file.read_text(encoding="utf-8"))
            for uid, p in (data.get("people") or {}).items():
                n = str((p or {}).get("name") or "").strip()
                if n and n != uid:
                    self.ledger[str(uid)] = n
        except (OSError, ValueError):
            pass
        self.seen: dict[str, Counter] = {}
        if archive is not None:
            for key in _legacy_keys(archive):
                for r in read_rows(archive, key):
                    self.observe(r)

    def observe(self, r: Row) -> None:
        if not is_channel_key(r.key) and r.user_id and r.name and r.name != r.user_id:
            self.seen.setdefault(r.user_id, Counter())[r.name] += 1

    def name(self, r: Row) -> str:
        if r.is_self:
            return "我"
        uid = r.user_id or ""
        if is_channel_key(r.key):
            return r.name or uid or "对方"
        if uid in self.ledger:
            return self.ledger[uid]
        c = self.seen.get(uid)
        if c:
            return c.most_common(1)[0][0]
        return r.name or uid or "对方"

    def all_names(self) -> set[str]:
        names = set(self.ledger.values())
        for c in self.seen.values():
            names.update(c.keys())
        return {n for n in names if len(n) >= 2}


def _display_timestamp(t: float) -> tuple[str, str]:
    try:
        d = datetime.fromtimestamp(t / 1000.0)
    except (ValueError, OverflowError, OSError):
        # JS Dates can exceed datetime's year range. Format such archive
        # dates in UTC by moving them into a complete Gregorian cycle.
        days, remainder = divmod(int(t), 86_400_000)
        cycles, day_in_cycle = divmod(days - 10957, 146097)
        d = datetime(2000, 1, 1) + timedelta(days=day_in_cycle, milliseconds=remainder)
        year = d.year + cycles * 400
        year_text = f"{year:04d}" if 0 <= year < 10000 else f"{year:+07d}"
        return f"{year_text}-{d:%m-%d}", f"{d:%H:%M}"
    return f"{d:%Y-%m-%d}", f"{d:%H:%M}"


def timestamp_day(t: float) -> str:
    return _display_timestamp(t)[0]


def fmt_line(r: Row, names: NameBook) -> str:
    day, clock = _display_timestamp(r.t)
    text = r.text.replace("\n", " / ")
    return f"{day} {clock} {names.name(r)}：{text}"
