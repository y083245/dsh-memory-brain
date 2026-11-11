"""Read the JSONL prefixes published by Node's channel archive writer."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from .channel_identity import decode_identity_key, is_channel_key, is_channel_person_key

_DIR = re.compile(r"c1_[a-f0-9]{64}")
_MONTH = re.compile(r"(?:[0-9]{4}|\+[0-9]{6})-[0-9]{2}\.jsonl")
_ISO = re.compile(r"([0-9]{4}|\+[0-9]{6})-([0-9]{2})-([0-9]{2})T"
                  r"([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z")
_MARKER = ".watermark.json"
_DIGEST = re.compile(r"[a-f0-9]{64}")
_MAX_ROW_BYTES = 64 * 1024
_DAYS_PER_CYCLE = 146097
_MAX_SAFE = (1 << 53) - 1


class ChannelArchiveError(ValueError):
    def __init__(self):
        super().__init__("Invalid channel archive")


class ChannelArchiveChanged(ChannelArchiveError):
    """The published archive may have changed during the current read."""


def _sha256(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def channel_directory(key: str) -> str:
    if not is_channel_key(key):
        raise ChannelArchiveError()
    return f"c1_{_sha256(key)}"


def _fingerprint(info: os.stat_result) -> tuple:
    # CPython 3.12 uses creation time for Windows path st_ctime and can
    # report change time for fstat. Use the same field on both sides.
    change = info.st_birthtime_ns if os.name == "nt" else info.st_ctime_ns
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, change


def _is_safe(info: os.stat_result, directory: bool) -> bool:
    if getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        return False
    if directory:
        return stat.S_ISDIR(info.st_mode)
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def _stat(path: Path, directory: bool = False) -> os.stat_result | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        raise ChannelArchiveError() from None
    if not _is_safe(info, directory):
        raise ChannelArchiveError()
    return info


@contextmanager
def _open(path: Path, fingerprint: tuple):
    flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
             | getattr(os, "O_NONBLOCK", 0))
    try:
        with os.fdopen(os.open(path, flags), "rb") as stream:
            info = os.fstat(stream.fileno())
            if not _is_safe(info, False) or _fingerprint(info) != fingerprint:
                raise ChannelArchiveChanged()
            yield stream
            current = _stat(path)
            current_fd = os.fstat(stream.fileno())
            if (current is None or _fingerprint(current) != fingerprint
                    or current_fd.st_ctime_ns != info.st_ctime_ns):
                raise ChannelArchiveChanged()
    except FileNotFoundError:
        raise ChannelArchiveChanged() from None
    except OSError:
        raise ChannelArchiveError() from None


def _invalid_constant(_):
    raise ValueError


def _object(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode("utf-8-sig"), parse_constant=_invalid_constant)
    except (ValueError, RecursionError):
        raise ChannelArchiveError() from None
    if not isinstance(data, dict):
        raise ChannelArchiveError()
    return data


def _entries(dir_path: Path) -> list[Path]:
    try:
        return list(dir_path.iterdir())
    except OSError:
        raise ChannelArchiveError() from None


def _read_object(path: Path, info: os.stat_result) -> dict:
    with _open(path, _fingerprint(info)) as stream:
        data = stream.read(_MAX_ROW_BYTES + 1)
        if len(data) > _MAX_ROW_BYTES:
            raise ChannelArchiveError()
        return _object(data)


def _root(archive: Path) -> Path:
    return archive.parent / "channel-archive"


def _scope(dir_path: Path) -> str | None:
    if _stat(dir_path, directory=True) is None:
        return None
    meta = dir_path / "conversation.json"
    info = _stat(meta)
    if info is None:
        if any(entry.name != "conversation.json.tmp" for entry in _entries(dir_path)):
            if _stat(meta) is not None:
                raise ChannelArchiveChanged()
            raise ChannelArchiveError()
        return None
    data = _read_object(meta, info)
    key = data.get("conversationKey")
    if (type(data.get("version")) is not int or data["version"] != 1 or not is_channel_key(key)
            or channel_directory(key) != dir_path.name or data.get("conversation") != decode_identity_key(key)):
        raise ChannelArchiveError()
    return key


def channel_keys(archive: Path) -> list[str]:
    root = _root(archive)
    try:
        entries = _entries(root) if _stat(root, directory=True) is not None else []
    except ChannelArchiveError:
        return []
    keys = []
    for entry in entries:
        if _DIR.fullmatch(entry.name):
            try:
                key = _scope(entry)
            except ChannelArchiveError:
                continue
            if key is not None:
                keys.append(key)
    return sorted(keys)


@dataclass(frozen=True)
class PublishedFile:
    path: Path
    length: int
    fingerprint: tuple

    @property
    def rel(self) -> str:
        return f"{self.path.parent.name}/{self.path.name}"


def _month_order(name: str) -> tuple[int, str]:
    return len(name), name


def published_files(archive: Path, key: str) -> list[PublishedFile]:
    root = _root(archive)
    dir_path = root / channel_directory(key)
    if _stat(root, directory=True) is None or _scope(dir_path) is None:
        return []
    names = {entry.name.removesuffix(_MARKER) for entry in _entries(dir_path)}
    files = []
    for name in sorted(names, key=_month_order):
        if not _MONTH.fullmatch(name):
            continue
        file = dir_path / name
        marker = dir_path / (name + _MARKER)
        marker_info = _stat(marker)
        if marker_info is None:
            _stat(file)
            continue
        length = _read_object(marker, marker_info).get("bytes")
        info = _stat(file)
        if info is None or type(length) is not int or not 0 < length <= min(info.st_size, _MAX_SAFE):
            raise ChannelArchiveError()
        files.append(PublishedFile(file, length, _fingerprint(info)))
    return files


def _timestamp(value: str, month: str) -> int:
    match = _ISO.fullmatch(value) if isinstance(value, str) else None
    if match is None or f"{value[:match.end(2)]}.jsonl" != month:
        raise ChannelArchiveError()
    year, mo, day, h, m, s, ms = map(int, match.groups())
    if value.startswith("+") and year < 10000:
        raise ChannelArchiveError()
    # A 400-year Gregorian cycle has a fixed day count. Shift into datetime's
    # range while preserving leap years, then recover the JavaScript timestamp.
    cycles, year_in_cycle = divmod(year - 2000, 400)
    local = datetime(2000 + year_in_cycle, mo, day, h, m, s)
    delta = local - datetime(1970, 1, 1)
    timestamp = ((cycles * _DAYS_PER_CYCLE + delta.days) * 86400 + delta.seconds) * 1000 + ms
    if abs(timestamp) > 8_640_000_000_000_000:
        raise ChannelArchiveError()
    return timestamp


def _parse_row(raw: bytes, key: str, month: str) -> dict:
    row = _object(raw)
    try:
        message_key = row["messageKey"]
        if (row["conversationKey"] != key or not message_key.startswith("m1_")
                or row["recordId"] != "record_" + _sha256(message_key)):
            raise ChannelArchiveError()
        conversation = decode_identity_key(key)
        message = decode_identity_key(message_key)
        if message["conversation"] != conversation or message["platformChatId"] != conversation["chatId"]:
            raise ChannelArchiveError()
        if row.get("deleted") is True:
            if len(row) != 4:
                raise ChannelArchiveError()
            return row
        person_key = row["personKey"]
        if not is_channel_person_key(key, person_key):
            raise ChannelArchiveError()
        person = decode_identity_key(person_key)
        if (row["dir"] != "in" or row["msgId"] != message["messageId"] or row["userId"] != person["userId"]
                or not isinstance(row["text"], str)):
            raise ChannelArchiveError()
        reply_key = row["replyToMessageKey"]
        if reply_key is not None:
            reply = decode_identity_key(reply_key)
            if (not reply_key.startswith("m1_") or reply["conversation"] != conversation
                    or reply["platformChatId"] != message["platformChatId"]):
                raise ChannelArchiveError()
        row["timestamp"] = _timestamp(row["t"], month)
    except (ValueError, AttributeError, KeyError):
        raise ChannelArchiveError() from None
    return row


def records(file: PublishedFile, key: str, offset: int = 0, start_line: int = 1):
    """Yield the exact published lines, including tombstones for provenance."""
    with _open(file.path, file.fingerprint) as stream:
        if offset > file.length:
            raise ChannelArchiveError()
        if offset:
            stream.seek(offset - 1)
            if stream.read(1) != b"\n":
                raise ChannelArchiveError()
        end = offset
        line = start_line - 1
        while end < file.length:
            start = end
            raw = stream.readline(min(_MAX_ROW_BYTES, file.length - start))
            if not raw.endswith(b"\n"):
                raise ChannelArchiveError()
            end += len(raw)
            line += 1
            yield line, start, end, raw, _parse_row(raw[:-1], key, file.path.name)


def _file_digests(file: PublishedFile, key: str, prefix_bytes: int) -> tuple[str, str | None]:
    digest = hashlib.sha256()
    prefix = None
    for _, _, end, raw, _ in records(file, key):
        digest.update(raw)
        if end == prefix_bytes:
            prefix = digest.hexdigest()
    return digest.hexdigest(), prefix


# Windows st_ctime represents file creation time. Rehash there to also detect
# an in-place rewrite that restores both the original size and mtime.
_cached_file_digests = lru_cache(maxsize=2048)(_file_digests) if os.name != "nt" else _file_digests


def _valid_checkpoint(previous: dict) -> bool:
    return isinstance(previous, dict) and all(
        isinstance(rel, str) and isinstance(entry, dict)
        and type(entry.get("bytes")) is int and 0 < entry["bytes"] <= _MAX_SAFE
        and isinstance(entry.get("sha256"), str) and _DIGEST.fullmatch(entry["sha256"])
        for rel, entry in previous.items()
    )


def channel_snapshot(archive: Path, key: str, previous: dict | None = None) -> tuple[dict, bool]:
    """Return the published file sizes and digests and whether a cursor can be reused."""
    files = published_files(archive, key)
    snapshot = {}
    compatible = previous is None or _valid_checkpoint(previous)
    previous = (previous or {}) if compatible else {}
    old_last = max(previous, key=_month_order, default=None)
    compatible &= set(previous).issubset(file.rel for file in files)
    for file in files:
        rel = file.rel
        old = previous.get(rel)
        prefix_bytes = old["bytes"] if old and old["bytes"] < file.length else 0
        digest, prefix = _cached_file_digests(file, key, prefix_bytes)
        snapshot[rel] = {"bytes": file.length, "sha256": digest}
        if old is None:
            compatible &= old_last is None or _month_order(rel) > _month_order(old_last)
        elif file.length == old["bytes"]:
            compatible &= digest == old["sha256"]
        else:
            compatible &= rel == old_last and prefix == old["sha256"]
    return snapshot, compatible
