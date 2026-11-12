"""WCDB 直读客户端。

来源：webot 1.2.2 `src/wechat/wcdb_client.py`（MIT），裁剪为交件箱采集器使用：
* 不读取 ``.env``、不持久化密钥、不依赖 webot 的 config 模块；
* 账号目录、session.db 与 64 位 hex 密钥全部由调用方注入；
* 保留 DLL 加载、DRM 单字节补丁、JSON 指针读取与查询接口。

DLL 位于 ``runtime-vendor/wcdb``（源码运行）或 ``runtime/wcdb``（打包运行）。
"""
from __future__ import annotations

import ctypes as ct
import json
import logging
import os
import sys
from ctypes import wintypes
from pathlib import Path

logger = logging.getLogger(__name__)

PAGE_EXECUTE_READWRITE = 0x40

# WeChat 4.x 的 DRM 检查点。微信更新导致偏移变化时用环境变量覆盖：
#   WCDB_PATCH_RVA=0x6f2a0
#   WCDB_PATCH_BYTE=0x02
_DEFAULT_PATCH_RVA = 0x6E1F6
_DEFAULT_PATCH_BYTE = 0x02


def _env_hex(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    try:
        return int(value, 16)
    except ValueError:
        logger.warning("环境变量 %s 不是有效的十六进制值，使用默认 0x%x", name, default)
        return default


PATCH_RVA = _env_hex("WCDB_PATCH_RVA", _DEFAULT_PATCH_RVA)
EXPECTED_PATCH_BYTE = _env_hex("WCDB_PATCH_BYTE", _DEFAULT_PATCH_BYTE)

_kernel32 = ct.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None


def _apply_drm_patch(dll_handle, dll_path):
    """把 DRM 检查的 ``mov eax,2`` 改成 ``mov eax,0``。

    补丁点由 ``PATCH_RVA`` / ``EXPECTED_PATCH_BYTE`` 控制。微信更新后
    偏移变化时用环境变量覆盖，不需要改源码。
    """
    if _kernel32 is None:
        return
    patch_addr = ct.c_void_p(dll_handle + PATCH_RVA)
    old_protect = wintypes.DWORD()
    _kernel32.VirtualProtect(
        patch_addr, 5, PAGE_EXECUTE_READWRITE, ct.byref(old_protect)
    )
    try:
        buf = (ct.c_ubyte * 5).from_address(patch_addr.value)
        if buf[1] == EXPECTED_PATCH_BYTE:
            buf[1] = 0x00
            logger.info("WCDB DRM 补丁已应用: RVA 0x%x 02->00", PATCH_RVA)
        elif buf[1] == 0x00:
            logger.info("WCDB DRM 补丁已存在")
        else:
            logger.warning(
                "WCDB 补丁点字节为 0x%02x（期望 0x%02x），DLL 版本可能不匹配",
                buf[1], EXPECTED_PATCH_BYTE,
            )
    finally:
        _kernel32.VirtualProtect(
            patch_addr, 5, old_protect, ct.byref(wintypes.DWORD())
        )


def _read_gbk_string(ptr):
    """读取 DLL 返回的 NUL 结尾字符串，先 UTF-8 再 GBK。"""
    if not ptr or ptr.value == 0:
        return ""
    raw = bytearray()
    addr = ptr.value
    for _ in range(500000):
        b = (ct.c_ubyte * 1).from_address(addr)[0]
        if b == 0:
            break
        raw.append(b)
        addr += 1
    for encoding in ("utf-8", "gbk"):
        try:
            text = raw.decode(encoding)
            json.loads(text)
            return text
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def _dll_candidates() -> list[Path]:
    """按优先级返回 wcdb_api.dll 候选路径。"""
    here = Path(__file__).resolve()
    roots = []
    env = os.environ.get("JJB_WCDB_DIR", "").strip()
    if env:
        roots.append(Path(env))
    roots += [
        here.parent.parent / "runtime-vendor" / "wcdb",
        here.parent.parent / "runtime" / "wcdb",
        Path.cwd() / "runtime-vendor" / "wcdb",
        Path.cwd() / "runtime" / "wcdb",
        Path.cwd() / "wcdb",
    ]
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        roots.insert(0, base / "runtime" / "wcdb")
        roots.insert(0, base / "wcdb")
        roots.insert(0, Path(sys.executable).parent / "runtime" / "wcdb")
    return [root / "wcdb_api.dll" for root in roots]


def find_dll() -> tuple[str, str]:
    """返回 ``(dll_dir, dll_path)``。"""
    for candidate in _dll_candidates():
        if candidate.is_file():
            logger.info("找到 wcdb_api.dll: %s", candidate)
            return str(candidate.parent), str(candidate)
    raise FileNotFoundError(
        "未找到 wcdb_api.dll。请把 runtime-vendor/wcdb 放进应用目录，"
        "或用 JJB_WCDB_DIR 指定目录。"
    )


def _find_wxid_and_dbpath(custom_base_dir: str = "") -> tuple[str, str]:
    """自动探测微信账号 wxid 与数据根目录。"""
    candidates: list[Path] = []
    if custom_base_dir:
        custom = Path(custom_base_dir).expanduser()
        if custom.is_dir():
            candidates.append(custom)
    documents = Path.home() / "Documents"
    for base in (documents / "xwechat_files", documents / "WeChat Files"):
        if base.is_dir() and base not in candidates:
            candidates.append(base)
    for base in candidates:
        try:
            dirs = sorted(
                [d for d in base.iterdir() if d.is_dir()],
                key=lambda d: d.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            continue
        for directory in dirs:
            if (directory / "db_storage" / "session" / "session.db").is_file():
                return directory.name, str(base)
    raise FileNotFoundError(
        "未找到微信数据库目录。请确认微信已登录，或在设置中指定微信数据库目录。"
    )


class WcdbNativeClient:
    """通过 patched wcdb_api.dll 原地查询微信加密数据库。"""

    def __init__(self, dll_dir: str | None = None, wxid: str = "",
                 db_path: str = "", key: str = "", session_db: str = ""):
        if dll_dir:
            self._dll_dir = str(dll_dir)
            self._dll_path = os.path.join(self._dll_dir, "wcdb_api.dll")
        else:
            self._dll_dir, self._dll_path = find_dll()
        self._dll = None
        self._handle = 0
        self._nicknames: dict[str, str] = {}
        self._key = (key or "").strip()
        self._session_db = str(session_db or "")
        if wxid and db_path:
            self._wxid, self._db_path = wxid, db_path
        else:
            self._wxid, self._db_path = _find_wxid_and_dbpath()

    # ── 初始化 ──────────────────────────────────────────────────────

    def init(self):
        if _kernel32 is None:
            raise RuntimeError("WCDB 直读仅支持 Windows")
        os.add_dll_directory(self._dll_dir)
        self._dll = ct.CDLL(self._dll_path)
        _apply_drm_patch(self._dll._handle, self._dll_path)

        self._dll.InitProtection.argtypes = [ct.c_char_p]
        self._dll.InitProtection.restype = ct.c_int32
        self._dll.wcdb_init.argtypes = []
        self._dll.wcdb_init.restype = ct.c_int32
        self._dll.wcdb_open_account.argtypes = [
            ct.c_char_p, ct.c_char_p, ct.POINTER(ct.c_int64),
        ]
        self._dll.wcdb_open_account.restype = ct.c_int32
        self._dll.wcdb_get_sessions.argtypes = [
            ct.c_int64, ct.POINTER(ct.c_void_p),
        ]
        self._dll.wcdb_get_sessions.restype = ct.c_int32
        self._dll.wcdb_get_messages.argtypes = [
            ct.c_int64, ct.c_char_p, ct.c_int32, ct.c_int32,
            ct.POINTER(ct.c_void_p),
        ]
        self._dll.wcdb_get_messages.restype = ct.c_int32
        self._dll.wcdb_get_display_names.argtypes = [
            ct.c_int64, ct.c_char_p, ct.POINTER(ct.c_void_p),
        ]
        self._dll.wcdb_get_display_names.restype = ct.c_int32
        for name in ("wcdb_get_contacts_compact", "wcdb_get_group_members"):
            try:
                fn = getattr(self._dll, name)
                fn.argtypes = [ct.c_int64, ct.c_char_p, ct.POINTER(ct.c_void_p)]
                fn.restype = ct.c_int32
            except Exception:
                setattr(self._dll, name, None)
        self._dll.wcdb_free_string.argtypes = [ct.c_void_p]
        self._dll.wcdb_free_string.restype = None
        try:
            self._dll.wcdb_close_account.argtypes = [ct.c_int64]
            self._dll.wcdb_close_account.restype = ct.c_int32
        except Exception:
            pass

        resource_path = os.path.dirname(self._dll_dir)
        self._dll.InitProtection(resource_path.encode("utf-8"))
        ret = self._dll.wcdb_init()
        if ret != 0:
            raise RuntimeError(f"wcdb_init failed: {ret}")
        logger.info("WCDB 引擎已初始化")

    def open(self) -> bool:
        """打开 session.db。成功返回 True。"""
        session_db = self._session_db or self._locate_session_db()
        if not session_db:
            raise RuntimeError("未找到 session.db")
        key = self._key
        attempts: list[tuple[bytes, str]] = []
        if key:
            if len(key) == 64 and all(c in "0123456789abcdefABCDEF" for c in key):
                attempts.append((key.encode("utf-8"), "hex"))
            elif len(key) == 96 and all(c in "0123456789abcdefABCDEF" for c in key):
                attempts.append((key[:64].encode("utf-8"), "hex32"))
            else:
                attempts.append((key.encode("utf-8"), "str"))
        attempts.append((b"", "builtin"))
        for key_bytes, label in attempts:
            handle = ct.c_int64(0)
            ret = self._dll.wcdb_open_account(
                session_db.encode("utf-8"), key_bytes, ct.byref(handle),
            )
            if ret != 0:
                logger.info("wcdb_open_account 失败 ret=%d format=%s", ret, label)
                continue
            self._handle = handle.value
            if self.get_sessions():
                logger.info("WCDB 已打开 session.db（key=%s）", label)
                self._load_nickname_cache()
                return True
            self._close_handle()
        return False

    def _locate_session_db(self) -> str:
        base = Path(self._db_path)
        if (base / "db_storage" / "session" / "session.db").is_file():
            return str(base / "db_storage" / "session" / "session.db")
        prefix = "_".join(self._wxid.split("_")[:3]) if self._wxid else ""
        try:
            entries = sorted(base.iterdir(), key=lambda d: d.stat().st_mtime, reverse=True)
        except OSError:
            return ""
        for entry in entries:
            if not entry.is_dir():
                continue
            if prefix and not entry.name.startswith(prefix):
                continue
            candidate = entry / "db_storage" / "session" / "session.db"
            if candidate.is_file():
                return str(candidate)
        return ""

    # ── 查询 ────────────────────────────────────────────────────────

    def _call_json(self, func, *args):
        out = ct.c_void_p()
        ret = func(*args, ct.byref(out))
        if ret != 0:
            logger.warning("WCDB 调用 %s 失败 ret=%d", getattr(func, "__name__", "?"), ret)
            return None
        if not out.value:
            return {}
        try:
            return json.loads(_read_gbk_string(out))
        except (json.JSONDecodeError, ValueError):
            return {}
        finally:
            try:
                self._dll.wcdb_free_string(out)
            except Exception:
                pass

    def get_sessions(self, limit: int = 500):
        result = self._call_json(self._dll.wcdb_get_sessions, self._handle)
        if isinstance(result, list):
            return result[:limit]
        if isinstance(result, dict):
            rows = result.get("sessions", result.get("data", []))
            return rows[:limit] if isinstance(rows, list) else []
        return []

    def get_messages(self, talker: str, limit: int = 200, offset: int = 0):
        result = self._call_json(
            self._dll.wcdb_get_messages, self._handle,
            talker.encode("utf-8"), int(limit), int(offset),
        )
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            rows = result.get("messages", result.get("data", []))
            return rows if isinstance(rows, list) else []
        return []

    def get_display_names(self, usernames):
        if not self._handle or not usernames:
            return {}
        payload = json.dumps(list(usernames), ensure_ascii=False).encode("utf-8")
        result = self._call_json(
            self._dll.wcdb_get_display_names, self._handle, payload,
        )
        if isinstance(result, dict):
            names = result.get("names", result)
            return names if isinstance(names, dict) else {}
        return {}

    def get_contacts(self, keyword: str = "", limit: int = 1000):
        if not getattr(self._dll, "wcdb_get_contacts_compact", None):
            return []
        result = self._call_json(
            self._dll.wcdb_get_contacts_compact, self._handle,
            json.dumps([keyword], ensure_ascii=False).encode("utf-8"),
        )
        if isinstance(result, list):
            return result[:limit]
        if isinstance(result, dict):
            rows = result.get("contacts", result.get("data", []))
            return rows[:limit] if isinstance(rows, list) else []
        return []

    def get_group_members(self, chat_id: str):
        if not getattr(self._dll, "wcdb_get_group_members", None):
            return []
        result = self._call_json(
            self._dll.wcdb_get_group_members, self._handle,
            chat_id.encode("utf-8"),
        )
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            rows = result.get("members", result.get("data", []))
            return rows if isinstance(rows, list) else []
        return []

    def get_my_wxid(self) -> str:
        return str(self._wxid or "")

    def _load_nickname_cache(self):
        for session in self.get_sessions():
            username = str(session.get("username", "") or "")
            display = str(
                session.get("displayName") or session.get("nickname") or ""
            ).strip()
            if username and display:
                self._nicknames[username] = display
        for contact in self.get_contacts():
            username = str(contact.get("userName") or contact.get("username") or "")
            nick = str(
                contact.get("nickName") or contact.get("remark")
                or contact.get("displayName") or ""
            ).strip()
            if username and nick:
                self._nicknames[username] = nick

    def resolve_nickname(self, wxid: str) -> str:
        if wxid in self._nicknames:
            return self._nicknames[wxid]
        names = self.get_display_names([wxid])
        name = str(names.get(wxid) or "")
        self._nicknames[wxid] = name or wxid
        return self._nicknames[wxid]

    # ── 清理 ────────────────────────────────────────────────────────

    def _close_handle(self):
        if not self._handle:
            return
        try:
            self._dll.wcdb_close_account(self._handle)
        except Exception:
            pass
        self._handle = 0

    def close(self):
        self._close_handle()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
