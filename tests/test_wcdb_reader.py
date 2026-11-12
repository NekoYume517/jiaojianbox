import json
import threading
from pathlib import Path

import pytest

from collector import wcdb_reader


def test_sort_seq_is_monotonic_within_second():
    seqs = [wcdb_reader.sort_seq_for(1700000000, n) for n in (3, 9, 42)]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == 3
    assert wcdb_reader.sort_seq_for(1700000001, 1) > seqs[-1]


def test_message_type_names_cover_composite_codes():
    assert wcdb_reader.message_type_name(1) == "文本"
    assert wcdb_reader.message_type_name(49) == "文件/链接/卡片"
    assert wcdb_reader.message_type_name((57 << 32) | 49) == "文件/链接/卡片"
    assert wcdb_reader.message_type_name((17 << 32) | 11000) == "动画表情"


def test_find_session_db_accepts_account_directory(tmp_path):
    account = tmp_path / "wxid_demo_abcd"
    session = account / "db_storage" / "session" / "session.db"
    session.parent.mkdir(parents=True)
    session.write_bytes(b"fixture")
    assert wcdb_reader.find_session_db(str(account)) == str(session)
    assert wcdb_reader.find_session_db(str(session)) == str(session)


def test_find_session_db_prefers_requested_account(tmp_path):
    older = tmp_path / "wxid_old_0001" / "db_storage" / "session"
    newer = tmp_path / "wxid_new_0002" / "db_storage" / "session"
    older.mkdir(parents=True)
    newer.mkdir(parents=True)
    (older / "session.db").write_bytes(b"old")
    (newer / "session.db").write_bytes(b"new")
    found = Path(wcdb_reader.find_session_db(str(tmp_path), "wxid_old_0001"))
    assert found.parent.parent.parent.name == "wxid_old_0001"
    assert found.name == "session.db"


def test_extract_session_key_handles_hex_and_bytes():
    mapping = {
        "message/message_0.db": "aa" * 32,
        "session/session.db": "bb" * 32,
    }
    assert wcdb_reader._extract_session_key(mapping) == "bb" * 32
    assert wcdb_reader._extract_session_key(
        {"session\\session.db": bytes(range(32))}
    ) == bytes(range(32)).hex()
    assert wcdb_reader._normalize_hex("cc" * 48) == "cc" * 32


def test_find_session_key_reads_plain_cache(tmp_path, monkeypatch):
    account = "wxid_fixture_1234"
    local = tmp_path / "local"
    keys = local / "wechatauto_keys" / f"{account}.json"
    keys.parent.mkdir(parents=True)
    keys.write_text(json.dumps({"session/session.db": "dd" * 32}), encoding="utf-8")
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setenv("TEMP", str(tmp_path / "temp"))
    assert wcdb_reader.find_session_key({"_wechat_cache_root": str(tmp_path / "cache")}, account) == "dd" * 32


def test_row_maps_wcdb_fields():
    row = {
        "localId": 1200000007,
        "serverId": 9001,
        "create_time": 1700000000,
        "sender_username": "wxid_sender",
        "message_content": "hello",
        "localType": 1,
    }
    out = wcdb_reader.WcdbReader._row(row, "123@chatroom", 0)
    assert out["local_id"] == 1200000007
    assert out["server_id"] == 9001
    assert out["sender_username"] == "wxid_sender"
    assert out["content"] == "hello"
    assert out["type"] == "文本"
    assert out["sort_seq"] == 1700000000 * 1_000_000 + (1200000007 % 1_000_000)


def test_incremental_messages_paginate_past_500():
    class Client:
        def __init__(self):
            self.offsets = []
            self.rows = [
                {
                    "localId": local_id,
                    "create_time": 1700000000,
                    "message_content": str(local_id),
                    "localType": 1,
                }
                for local_id in range(701, 0, -1)
            ]

        def get_messages(self, talker, limit, offset):
            self.offsets.append(offset)
            return self.rows[offset:offset + limit]

    reader = object.__new__(wcdb_reader.WcdbReader)
    reader.client = Client()
    reader._lock = threading.RLock()
    since_seq = wcdb_reader.sort_seq_for(1700000000, 100)

    rows = reader.get_new_messages("chat", since_seq=since_seq)

    assert [row["local_id"] for row in rows] == list(range(101, 702))
    assert reader.client.offsets == [0, 500]
