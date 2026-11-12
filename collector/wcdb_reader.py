"""WCDB 直读适配器。

对上层暴露与 ``wechatauto.db.WeChatDB`` 相同的读取接口，采集循环不需要
知道底层是整库解密还是 DLL 原地查询。

设计要点：
* 优先使用 WCDB 直读；找不到 DLL、密钥或 session.db 时抛 ``WcdbUnavailable``，
  由 ``agent.wechat_database`` 回退到原 ``wechatauto`` 读取器。
* 密钥只读缓存，不在本模块做整库解密；首次运行由兼容读取器提取并写入
  ``%LOCALAPPDATA%/wechatauto_keys/<account>.json``，下一次启动即可直读。
* ``sort_seq`` 用 ``create_time * 1_000_000 + local_id % 1_000_000``，
  与原有游标语义一致且单调。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path

from .wcdb_client import WcdbNativeClient, find_dll

logger = logging.getLogger(__name__)

MSG_TYPE_NAMES = {
    1: "文本",
    3: "图片",
    34: "语音",
    43: "视频",
    47: "动画表情",
    48: "位置",
    49: "文件/链接/卡片",
    50: "音视频通话",
    10000: "系统消息",
    11000: "动画表情",
    8594229559345: "红包",
}

SESSION_SUFFIX = ("/session/session.db", "\\session\\session.db", "session.db")


class WcdbUnavailable(RuntimeError):
    """WCDB 直读条件不满足，调用方应回退到兼容读取器。"""


def message_type_name(value) -> str:
    try:
        code = int(value)
    except (TypeError, ValueError):
        return str(value or "文本")
    if code in MSG_TYPE_NAMES:
        return MSG_TYPE_NAMES[code]
    if code > 0xFFFF:
        base = code & 0xFFFFFFFF
        if base in MSG_TYPE_NAMES:
            return MSG_TYPE_NAMES[base]
        low = base & 0xFF
        if low in MSG_TYPE_NAMES:
            return MSG_TYPE_NAMES[low]
    return str(code)


def sort_seq_for(create_time, local_id) -> int:
    try:
        ts = int(create_time or 0)
    except (TypeError, ValueError):
        ts = 0
    try:
        lid = int(local_id or 0)
    except (TypeError, ValueError):
        lid = 0
    return ts * 1_000_000 + (lid % 1_000_000)


def find_session_db(base: str, account: str = "") -> str:
    """从数据根目录、账号目录或 db_storage 定位 session.db。"""
    if not base:
        return ""
    root = Path(base).expanduser()
    if root.is_file() and root.name.lower() == "session.db":
        return str(root)
    direct = root / "db_storage" / "session" / "session.db"
    if direct.is_file():
        return str(direct)
    if not root.is_dir():
        return ""
    try:
        entries = sorted(
            [d for d in root.iterdir() if d.is_dir()],
            key=lambda d: d.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return ""
    if account:
        exact = [d for d in entries if d.name == account or d.name.startswith(account + "_")]
        entries = exact + [d for d in entries if d not in exact]
    for entry in entries:
        candidate = entry / "db_storage" / "session" / "session.db"
        if candidate.is_file():
            return str(candidate)
    return ""


def _unprotect(raw: bytes) -> bytes:
    try:
        from wechatauto.db import _unprotect_key_cache
        return _unprotect_key_cache(raw)
    except Exception:
        return raw


def _normalize_hex(value) -> str:
    """把 key 统一成 64 位 hex；无法识别时返回空串。"""
    if isinstance(value, bytes):
        if len(value) in (32, 48):
            return value[:32].hex()
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return ""
    text = str(value or "").strip()
    if len(text) == 64 and all(c in "0123456789abcdefABCDEF" for c in text):
        return text.lower()
    if len(text) == 96 and all(c in "0123456789abcdefABCDEF" for c in text):
        return text[:64].lower()
    if len(text) in (32, 48):
        return text.encode("utf-8")[:32].hex()
    return ""


def _extract_session_key(mapping) -> str:
    if not isinstance(mapping, dict):
        return ""
    for rel, value in mapping.items():
        path = str(rel).replace("\\", "/").lower()
        if path.endswith("session/session.db") or path == "session.db":
            key = _normalize_hex(value)
            if key:
                return key
    return ""


def _load_key_file(path: Path) -> dict:
    try:
        raw = _unprotect(path.read_bytes())
    except OSError:
        return {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def key_cache_paths(config: dict, account: str) -> list[Path]:
    paths: list[Path] = []
    explicit = str(config.get("wechat_key_file") or "").strip()
    if explicit:
        paths.append(Path(explicit).expanduser())
    local = os.environ.get("LOCALAPPDATA") or os.environ.get("USERPROFILE") or ""
    if local:
        paths.append(Path(local) / "wechatauto_keys" / f"{account}.json")
    temp = os.environ.get("TEMP") or tempfile.gettempdir()
    if temp:
        paths.append(Path(temp) / "wechatauto_db" / account / "keys.json")
    cache_root = config.get("_wechat_cache_root")
    if cache_root:
        root = Path(cache_root)
        digest = hashlib.sha256(str(account).encode()).hexdigest()[:16]
        paths.append(root / f"live-account-{digest}" / "keys.json")
        if root.is_dir():
            try:
                for entry in root.iterdir():
                    if entry.is_dir():
                        paths.append(entry / "keys.json")
            except OSError:
                pass
    return paths


def find_session_key(config: dict, account: str) -> str:
    direct = _normalize_hex(config.get("wechat_key"))
    if direct:
        return direct
    for path in key_cache_paths(config, account):
        if not path.is_file():
            continue
        key = _extract_session_key(_load_key_file(path))
        if key:
            logger.info("从密钥缓存读取 session.db key: %s", path)
            return key
    return ""


class WcdbReader:
    """WCDB 直读；接口与 WeChatDB 的采集子集一致。"""

    backend = "wcdb"

    def __init__(self, config: dict):
        if os.name != "nt":
            raise WcdbUnavailable("WCDB 直读仅支持 Windows")
        try:
            dll_dir, _ = find_dll()
        except FileNotFoundError as exc:
            raise WcdbUnavailable(str(exc)) from exc
        self.config = config
        self._lock = threading.RLock()
        self._names: dict[str, str] = {}
        self._account = str(config.get("wechat_account") or "")
        db_dir = str(config.get("wechat_db_dir") or "")
        session_db = find_session_db(db_dir, self._account)
        if not session_db:
            raise WcdbUnavailable("未找到 session.db，请确认微信 4.x 已登录")
        if not self._account:
            # session.db 的目录层级：<account>/db_storage/session/session.db
            self._account = Path(session_db).parents[2].name
        key = find_session_key(config, self._account)
        if not key:
            raise WcdbUnavailable("未找到 session.db 密钥，先用兼容模式完成一次读取")
        self._session_db = session_db
        self.client = WcdbNativeClient(
            dll_dir=dll_dir,
            wxid=self._account,
            db_path=db_dir or str(Path(session_db).parents[3]),
            key=key,
            session_db=session_db,
        )
        try:
            self.client.init()
            if not self.client.open():
                raise WcdbUnavailable("WCDB 打开 session.db 失败，密钥可能已过期")
        except WcdbUnavailable:
            raise
        except Exception as exc:
            raise WcdbUnavailable(f"WCDB 初始化失败: {exc}") from exc
        if not self._account:
            self._account = self.client.get_my_wxid()
        self._prefetch_names = getattr(self.client, "get_display_names", None)

    @property
    def account(self) -> str:
        return self._account

    def get_sessions(self, limit: int = 500) -> list[dict]:
        with self._lock:
            rows = self.client.get_sessions(limit=limit)
        out = []
        for row in rows:
            chat = str(row.get("username") or row.get("userName") or "")
            if not chat:
                continue
            out.append({
                "username": chat,
                "sort_seq": int(
                    row.get("sort_timestamp") or row.get("last_timestamp") or 0
                ),
            })
        return out

    def get_messages(self, chat: str, limit: int = 100) -> list[dict]:
        limit = max(1, min(int(limit), 500))
        with self._lock:
            rows = self.client.get_messages(talker=chat, limit=limit)
        out = [self._row(row, chat, index) for index, row in enumerate(rows)]
        out.sort(key=lambda item: item["sort_seq"], reverse=True)
        return out

    def get_new_messages(self, chat: str, since_seq: int = 0,
                         limit: int = 500) -> list[dict]:
        if int(since_seq or 0) <= 0:
            # 首次由 wechat_loop 用 get_messages() 建立游标，这里不灌历史。
            return []
        limit = max(50, min(int(limit), 500))
        with self._lock:
            rows = self.client.get_messages(talker=chat, limit=limit)
        out = [
            self._row(row, chat, index)
            for index, row in enumerate(rows)
        ]
        out = [item for item in out if item["sort_seq"] > int(since_seq)]
        out.sort(key=lambda item: item["sort_seq"])
        return out

    def get_nickname(self, wxid: str) -> str:
        wxid = str(wxid or "")
        if not wxid:
            return ""
        if wxid in self._names:
            return self._names[wxid]
        name = ""
        if self._prefetch_names:
            with self._lock:
                names = self._prefetch_names([wxid]) or {}
            name = str(names.get(wxid) or "")
        self._names[wxid] = name
        return name

    def prefetch_nicknames(self, wxids) -> None:
        pending = sorted({
            str(wxid) for wxid in wxids
            if wxid and str(wxid) not in self._names
        })
        if not pending or not self._prefetch_names:
            return
        with self._lock:
            names = self._prefetch_names(pending) or {}
        for wxid in pending:
            self._names[wxid] = str(names.get(wxid) or "")

    def close(self) -> None:
        try:
            self.client.close()
        except Exception:
            pass

    @staticmethod
    def _row(row: dict, chat: str, index: int) -> dict:
        local_id = (
            row.get("localId") or row.get("local_id")
            or row.get("serverId") or row.get("server_id") or index
        )
        create_time = (
            row.get("create_time") or row.get("createTime")
            or row.get("timestamp") or 0
        )
        content = row.get("message_content", row.get("content", ""))
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        sender = str(
            row.get("sender_username") or row.get("senderUsername")
            or row.get("sender") or ""
        )
        message_type = (
            row.get("localType") or row.get("local_type")
            or row.get("msg_type") or row.get("type") or 1
        )
        return {
            "local_id": int(local_id or 0),
            "server_id": int(
                row.get("serverId") or row.get("server_id") or local_id or 0
            ),
            "sort_seq": sort_seq_for(create_time, local_id),
            "create_time": int(create_time or 0),
            "sender_username": sender,
            "content": str(content or ""),
            "type": message_type_name(message_type),
            "type_code": message_type,
            "chat": chat,
            "shard": "",
        }
