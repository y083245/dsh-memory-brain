"""Exercise the published Node archive from the sidecar without real account data."""

import base64
import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from memory_rag import archive as reader

ROOT = Path(__file__).resolve().parents[3]


def test_shared_channel_identity_vectors():
    vectors = json.loads((ROOT / "scripts/fixtures/channel-identity-vectors.json").read_text(encoding="utf-8"))
    valid = vectors["valid"]
    assert reader.valid_key(valid[0]["key"])
    assert not reader.valid_key(valid[1]["key"])
    assert not reader.valid_key(valid[2]["key"])
    from memory_rag.channel_identity import decode_identity_key
    for item in valid:
        assert decode_identity_key(item["key"]) == item["ref"]
    for key in vectors["invalid"]:
        with pytest.raises(ValueError):
            decode_identity_key(key)
    qq = base64.urlsafe_b64encode(b'["qq","41",null,"private","42",null]').decode().rstrip("=")
    assert not reader.is_channel_key("c1_" + qq)
    assert reader.valid_key("private:42")


@pytest.fixture
def node_archive(tmp_path):
    script = """
        import fs from 'node:fs';
        import path from 'node:path';
        import { createChannelArchive } from './src/core/channel-archive.mjs';
        import { encodeConversationKey, encodeMessageKey, encodePersonKey } from './src/core/identity.mjs';
        const root = process.argv[1];
        const account = { platform: 'telegram', accountId: '41', tenantId: null };
        const conversation = { ...account, chatType: 'group', chatId: '-100123', threadId: '7' };
        const actor = { ...account, userId: '42' };
        const personKey = encodePersonKey(actor);
        const conversationKey = encodeConversationKey(conversation);
        const archive = createChannelArchive(root, (s) => s);
        function add(messageId, text, replyTo = null, occurredAt = Date.UTC(2026, 10, 1)) {
            const message = { conversation, platformChatId: conversation.chatId, messageId };
            archive.project({ conversationKey, personKey, actor, message, messageKey: encodeMessageKey(message),
                text, occurredAt, replyTo }, 0);
            return message;
        }
        const first = add('19', 'fixture 🐋');
        add('20', 'second message', first);
        if (process.argv[2] === 'expanded') add('21', 'x'.repeat(3999) + '🐋', null, 8.64e15);
        const file = archive.files(conversationKey)[0];
        console.log(JSON.stringify({ key: conversationKey, file, messageKey: encodeMessageKey(first), personKey }));
    """
    root = tmp_path / "channel-archive"
    def build(*args):
        data = json.loads(subprocess.check_output(
            ["node", "--input-type=module", "-e", script, str(root), *args], cwd=ROOT,
        ))
        archive = tmp_path / "archive"
        file = Path(data["file"])
        return archive, data["key"], file, data["messageKey"], data["personKey"]
    return build


def publish(file, data):
    file.write_bytes(data)
    file.with_suffix(".jsonl.watermark.json").write_text(json.dumps({"bytes": len(data)}), encoding="utf-8")


def encoded_row(row):
    return (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def test_node_rows_use_only_published_bytes_and_keep_exact_provenance(node_archive):
    archive, key, file, message_key, person_key = node_archive()
    original = file.read_bytes()
    first_end = original.index(b"\n") + 1
    file.write_bytes(original + original + b"\xf0\x9f")
    expected_rel = f"{file.parent.name}/{file.name}"
    assert reader.list_keys(archive) == [key]
    assert reader.key_dir(key) == file.parent.name
    assert reader.key_files(archive, key) == [expected_rel]
    first, second = reader.read_rows(archive, key)
    assert first.text == "fixture 🐋"
    assert (first.file, first.line, first.offset, first.end) == (expected_rel, 1, 0, first_end)
    assert (second.file, second.line, second.offset, second.end) == (expected_rel, 2, first_end, len(original))
    assert first.person_key == person_key
    assert first.message_key == second.reply_to_message_key == message_key
    assert first.record_id == "record_" + hashlib.sha256(message_key.encode()).hexdigest()
    assert reader.read_rows(archive, key, expected_rel, first_end, 2) == [second]
    assert reader.read_rows(archive, key, expected_rel, len(original), 3) == []
    assert reader.read_rows(archive, key, expected_rel, first_end, 2, trusted_cursor=True) == [second]
    with pytest.raises(reader.ChannelArchiveError):
        reader.read_rows(archive, key, expected_rel, first_end - 1, 2, trusted_cursor=True)
    for start_file, offset, line in [
        (expected_rel, first_end - 1, 2), (expected_rel, first_end, 1),
        (expected_rel, len(original) + 1, 3), ("../other.jsonl", 0, 1),
    ]:
        with pytest.raises(reader.ChannelArchiveError):
            reader.read_rows(archive, key, start_file, offset, line)


def test_cache_and_snapshot_see_same_length_tombstone_with_restored_mtime(node_archive):
    archive, key, file, _, _ = node_archive()
    original = file.read_bytes()
    first, second = original.splitlines(keepends=True)
    snapshot, append_only = reader.channel_snapshot(archive, key)
    assert append_only
    rel = f"{file.parent.name}/{file.name}"
    assert snapshot == {rel: {"bytes": len(original), "sha256": hashlib.sha256(original).hexdigest()}}
    cache = reader.RowCache(archive)
    assert len(cache.rows(key)[0]) == 2
    old_stat = file.stat()
    marker = {"deleted": True, **{k: json.loads(first)[k] for k in ("recordId", "conversationKey", "messageKey")}}
    padded_marker = encoded_row(marker).rstrip().ljust(len(first) - 1) + b"\n"
    with file.open("r+b") as handle:
        handle.write(padded_marker)
    os.utime(file, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
    after, append_only = reader.channel_snapshot(archive, key, snapshot)
    assert not append_only
    assert after[rel]["bytes"] == snapshot[rel]["bytes"]
    rows, index = cache.rows(key)
    assert [row.text for row in rows] == ["second message"]
    assert index == {(rel, 2): 0}
    assert (rows[0].offset, rows[0].end) == (len(first), len(first) + len(second))


def test_snapshot_compares_exact_prefix_and_chronological_append_order(node_archive):
    archive, key, file, _, _ = node_archive()
    first, second = file.read_bytes().splitlines(keepends=True)
    publish(file, first)
    previous, _ = reader.channel_snapshot(archive, key)
    invalid_checkpoint = {next(iter(previous)): {"bytes": None, "sha256": "invalid"}}
    assert reader.channel_snapshot(archive, key, invalid_checkpoint) == (previous, False)
    publish(file, first + second)
    current, append_only = reader.channel_snapshot(archive, key, previous)
    assert append_only and previous != current

    def publish_month(month, row):
        record = {**json.loads(row), "t": f"{month}-01T00:00:00.000Z"}
        publish(file.with_name(f"{month}.jsonl"), encoded_row(record))

    publish_month("2026-12", second)
    later, append_only = reader.channel_snapshot(archive, key, current)
    assert append_only
    publish_month("2026-10", first)
    assert not reader.channel_snapshot(archive, key, later)[1]
    file.with_name("2026-10.jsonl").unlink()
    file.with_name("2026-10.jsonl.watermark.json").unlink()
    publish(file, first)
    assert not reader.channel_snapshot(archive, key, later)[1]


@pytest.mark.parametrize("corrupt", ["metadata", "watermark", "short", "row_scope", "row_person", "row_reply", "bad_date", "orphan"])
def test_invalid_channel_archive_fails_closed_without_affecting_qq(node_archive, corrupt):
    archive, key, file, message_key, _ = node_archive()
    first = json.loads(file.read_bytes().splitlines()[0])
    if corrupt == "metadata":
        meta = file.with_name("conversation.json")
        data = json.loads(meta.read_bytes())
        data["conversation"]["threadId"] = "8"
        meta.write_text(json.dumps(data), encoding="utf-8")
    elif corrupt == "watermark":
        file.with_suffix(".jsonl.watermark.json").write_text('{"bytes":true}', encoding="utf-8")
    elif corrupt == "short":
        file.write_bytes(b"\n")
    elif corrupt == "orphan":
        file.unlink()
    else:
        field, value = {
            "row_scope": ("conversationKey", key + "a"),
            "row_person": ("personKey", message_key),
            "row_reply": ("replyToMessageKey", first["personKey"]),
            "bad_date": ("t", "2026-11-31T00:00:00.000Z"),
        }[corrupt]
        first[field] = value
        publish(file, encoded_row(first))
    qq = archive / "private_42"
    qq.mkdir(parents=True)
    (qq / "2026-11.jsonl").write_bytes(b'{"t":"2026-11-01T00:00:00Z","text":"QQ"}\n')
    for read in (
        lambda: reader.channel_snapshot(archive, key),
        lambda: reader.read_rows(archive, key),
        lambda: reader.RowCache(archive).rows(key),
    ):
        with pytest.raises(reader.ChannelArchiveError, match="Invalid channel archive"):
            read()
    assert [row.text for row in reader.read_rows(archive, "private:42")] == ["QQ"]


def test_channel_alias_never_uses_or_changes_qq_name_book(node_archive):
    archive, key, file, _, _ = node_archive()
    first = json.loads(file.read_bytes().splitlines()[0])
    publish(file, encoded_row({**first, "name": "Channel Display"}))
    ledger = archive.parent / "people.json"
    ledger.write_text('{"people":{"42":{"name":"QQ Display"}}}', encoding="utf-8")
    names = reader.NameBook(ledger, archive)
    row, = reader.read_rows(archive, key)
    names.observe(row)
    assert names.name(row) == "Channel Display"
    assert names.all_names() == {"QQ Display"}


def test_channel_linked_content_is_rejected(node_archive):
    archive, key, file, _, _ = node_archive()
    linked = file.with_name("external.jsonl")
    os.link(file, linked)
    with pytest.raises(reader.ChannelArchiveError, match="Invalid channel archive"):
        reader.read_rows(archive, key)


def test_channel_linked_scope_directory_is_rejected(node_archive):
    archive, key, file, _, _ = node_archive()
    scope = file.parent
    renamed = scope.with_name("elsewhere")
    scope.rename(renamed)
    try:
        scope.symlink_to(renamed, target_is_directory=True)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows symbolic links require Developer Mode or SeCreateSymbolicLinkPrivilege")
        raise
    assert key not in reader.list_keys(archive)
    with pytest.raises(reader.ChannelArchiveError):
        reader.channel_snapshot(archive, key)


def test_concurrent_file_change_is_distinguished_from_corruption(node_archive, monkeypatch):
    from memory_rag import channel_archive

    archive, key, file, _, _ = node_archive()
    discover = channel_archive.published_files

    def append_after_discovery(archive, key):
        files = discover(archive, key)
        with file.open("ab") as handle:
            handle.write(b"unpublished")
        return files

    with monkeypatch.context() as patch:
        patch.setattr(channel_archive, "published_files", append_after_discovery)
        with pytest.raises(reader.ChannelArchiveChanged):
            reader.channel_snapshot(archive, key)
    assert len(reader.read_rows(archive, key)) == 2


def test_node_expanded_date_and_utf16_truncated_text_are_indexable(node_archive):
    archive, key, file, _, _ = node_archive("expanded")
    *_, row = reader.read_rows(archive, key)
    assert row.file == f"{file.parent.name}/+275760-09.jsonl"
    assert row.t == 8_640_000_000_000_000
    assert row.text == "x" * 3999 + "\ufffd"
    assert reader.timestamp_day(row.t) == "+275760-09-13"
    assert reader.fmt_line(row, reader.NameBook(archive.parent / "people.json")).startswith("+275760-09-13 00:00")
