"""Canonical identity keys shared with src/core/identity.mjs."""

from __future__ import annotations

import base64
import binascii
import json
import re
from functools import lru_cache

_KEY = re.compile(r"(c1|p1|m1)_([A-Za-z0-9_-]{1,2048})")
_ASCII_ID = r"[A-Za-z0-9_-]{1,128}"
_POSITIVE = r"[1-9][0-9]{0,15}"
_MAX_SAFE = (1 << 53) - 1
_MAX_TELEGRAM = (1 << 52) - 1
_ACCOUNT_FIELDS = ("platform", "accountId", "tenantId")
_CONVERSATION_FIELDS = (*_ACCOUNT_FIELDS, "chatType", "chatId", "threadId")


def _matches(value, pattern: str) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _numeric(value, pattern: str = _POSITIVE, maximum: int = _MAX_SAFE) -> bool:
    return _matches(value, pattern) and abs(int(value)) <= maximum


def _account(platform, account, tenant) -> bool:
    if platform == "feishu":
        return _matches(account, r"cli_[A-Za-z0-9_-]{1,124}") and _matches(tenant, _ASCII_ID)
    if platform == "telegram":
        return tenant is None and _numeric(account, maximum=_MAX_TELEGRAM)
    return platform == "qq" and tenant is None and _numeric(account)


def _chat(platform, kind, chat_id) -> bool:
    if platform == "feishu":
        return _matches(chat_id, r"oc_[A-Za-z0-9_-]{1,125}")
    if platform == "telegram":
        return _numeric(chat_id, "-" + _POSITIVE if kind == "group" else _POSITIVE, _MAX_TELEGRAM)
    return _numeric(chat_id)


def _thread(platform, thread) -> bool:
    if thread is None:
        return True
    if platform == "feishu":
        return _matches(thread, _ASCII_ID)
    return platform == "telegram" and _numeric(thread)


def _conversation(values) -> tuple:
    if isinstance(values, list) and len(values) == 6:
        platform, account, tenant, kind, chat_id, thread = values
        if (_account(platform, account, tenant) and kind in ("private", "group")
                and _chat(platform, kind, chat_id) and _thread(platform, thread)):
            return tuple(values)
    raise ValueError("Invalid identity key")


@lru_cache(maxsize=4096)
def _decode(key: str) -> tuple:
    match = _KEY.fullmatch(key)
    if match:
        prefix, payload = match.groups()
        try:
            values = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8"))
            encoded = base64.urlsafe_b64encode(json.dumps(values, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
            if encoded.rstrip(b"=").decode("ascii") == payload and isinstance(values, list):
                if prefix == "c1":
                    return _conversation(values)
                if prefix == "p1" and len(values) == 4:
                    platform, account, tenant, user = values
                    if _account(platform, account, tenant) and (
                        _matches(user, r"ou_[A-Za-z0-9_-]{1,125}") if platform == "feishu"
                        else _numeric(user, maximum=_MAX_TELEGRAM if platform == "telegram" else _MAX_SAFE)
                    ):
                        return tuple(values)
                if prefix == "m1" and len(values) == 3:
                    ref, chat_id, message = values
                    conversation = _conversation(ref)
                    platform, _, _, kind, _, _ = conversation
                    if _chat(platform, kind, chat_id) and (
                        _matches(message, r"om_[A-Za-z0-9_-]{1,125}") if platform == "feishu"
                        else _numeric(message, "-?" + _POSITIVE if platform == "qq" else _POSITIVE)
                    ):
                        return conversation, chat_id, message
        except (ValueError, binascii.Error, RecursionError):
            pass
    raise ValueError("Invalid identity key")


def decode_identity_key(key: str) -> dict:
    if not isinstance(key, str):
        raise ValueError("Invalid identity key")
    values = _decode(key)
    if key.startswith("c1_"):
        return dict(zip(_CONVERSATION_FIELDS, values))
    if key.startswith("p1_"):
        return dict(zip((*_ACCOUNT_FIELDS, "userId"), values))
    conversation, chat_id, message = values
    return {"conversation": dict(zip(_CONVERSATION_FIELDS, conversation)), "platformChatId": chat_id, "messageId": message}


def is_channel_key(key: str) -> bool:
    if not isinstance(key, str) or not key.startswith("c1_"):
        return False
    try:
        return _decode(key)[0] in ("feishu", "telegram")
    except ValueError:
        return False


def is_channel_person_key(key: str, person_key: str) -> bool:
    if not is_channel_key(key) or not isinstance(person_key, str) or not person_key.startswith("p1_"):
        return False
    try:
        return _decode(key)[:3] == _decode(person_key)[:3]
    except ValueError:
        return False
