"""Keep decrypted SQLite snapshots private to each reader process.

The original wxexport uses the library's shared temporary cache. Another process can
keep a SQLite handle open there; replacing that file then fails on Windows.
Only encrypted DPAPI key-cache bytes are copied, never exported or logged.
"""
import json
import hashlib
import os
import re
import sys
import shutil
import tempfile
import time
from pathlib import Path


def _vendor_path() -> str:
    """源码运行时装包时把 wechatauto 的 vendor 副本加入 sys.path。"""
    root = Path(__file__).resolve().parents[1]
    for candidate in (root / "runtime-vendor" / "wechatauto-replica", root / "runtime-vendor"):
        if (candidate / "wechatauto").exists() and str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))
            return str(candidate)
    return ""


def open_database(config):
    _vendor_path()
    from wechatauto.db import WeChatDB, auto_detect_db_dir
    import psutil
    directory = config.get('wechat_db_dir') or auto_detect_db_dir()
    account = config.get('wechat_account')
    if not account:
        probe = WeChatDB.__new__(WeChatDB)
        probe.db_dir = directory
        account = probe._pick_account()
    cache_root = Path(config['_wechat_cache_root']).resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    purpose = config.get('_wechat_purpose', 'live')
    private_name = (('live-account-'+hashlib.sha256(account.encode()).hexdigest()[:16])
                    if purpose == 'live' else 'list-'+str(os.getpid()))
    private = cache_root / private_name
    # 旧实现只匹配 live-<pid>/list-<pid>，而实际目录是 live-account-<hash>，
    # 因此账号级解密副本从未被回收。这里按前缀和最后使用时间清理。
    now = time.time()
    for entry in cache_root.iterdir():
        try:
            if not entry.is_dir() or entry.resolve().parent != cache_root:
                continue
            if entry.name == private_name:
                continue
            match = re.fullmatch(r'(?:live|list)-(\d+)', entry.name)
            if match:
                if not psutil.pid_exists(int(match[1])):
                    shutil.rmtree(entry, ignore_errors=True)
                continue
            if entry.name.startswith('live-account-'):
                if now - entry.stat().st_mtime > 7 * 86400:
                    shutil.rmtree(entry, ignore_errors=True)
                continue
            if entry.name.startswith('list-'):
                if now - entry.stat().st_mtime > 86400:
                    shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue
    for stale in cache_root.glob('**/*.tmp*'):
        try:
            if now - stale.stat().st_mtime > 3600:
                stale.unlink()
        except OSError:
            continue
    private.mkdir(exist_ok=True)
    lock_handle=None
    if purpose=='live':
        import msvcrt
        try:
            lock_handle=(private/'reader.lock').open('a+b')
            if lock_handle.seek(0,2)==0:lock_handle.write(b'0');lock_handle.flush()
            lock_handle.seek(0);msvcrt.locking(lock_handle.fileno(),msvcrt.LK_NBLCK,1)
        except OSError:
            if lock_handle:lock_handle.close()
            lock_handle=None;private=cache_root/('live-'+str(os.getpid()));private.mkdir(exist_ok=True)

    keys = private / 'keys.json'
    original = Path(tempfile.gettempdir()) / 'wechatauto_db' / account / 'keys.json'
    if not keys.exists() and original.is_file():
        try:
            raw=original.read_bytes()
            if raw.startswith(b'dpapi1:'):keys.write_bytes(raw)
        except OSError:
            pass
    class IsolatedReader(WeChatDB):
        # The upstream reader may switch accounts while diagnosing keys. Keep
        # those fallback paths private too, including older installed versions.
        def close(self):
            handle=getattr(self,"_cache_lock",None)
            if handle:handle.close();self._cache_lock=None
        def __setattr__(self,name,value):
            if name in ('workdir','keys_file') and value and hasattr(self,'_private_root'):
                candidate=Path(value).resolve()
                if not candidate.is_relative_to(self._private_root):
                    if name=='workdir':
                        suffix=hashlib.sha256(str(getattr(self,'account','unknown')).encode()).hexdigest()[:16]
                        value=str(self._private_root/('account-'+suffix));Path(value).mkdir(exist_ok=True)
                    else:value=str(Path(self.workdir)/'keys.json')
            object.__setattr__(self,name,value)
    reader=IsolatedReader.__new__(IsolatedReader)
    reader._private_root=private.resolve()
    reader._cache_lock=lock_handle
    try:reader.__init__(account=account, db_dir=directory, workdir=str(private), keys_file=str(keys))
    except BaseException:
        reader.close();raise
    return reader


def record_error(config, exc, stage):
    record = {'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'stage': stage,
              'type': type(exc).__name__, 'winerror': getattr(exc, 'winerror', None),
              'errno': getattr(exc, 'errno', None), 'file': str(exc.filename) if getattr(exc,'filename',None) else None,
              'target': str(exc.filename2) if getattr(exc,'filename2',None) else None}
    path = Path(config['_wechat_cache_root']).parent / 'wechat-diagnostics.jsonl'
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 256000:
            path.replace(path.with_suffix('.previous.jsonl'))
        with path.open('a', encoding='utf-8') as output:
            output.write(json.dumps(record, ensure_ascii=False) + '\n')
    except OSError:
        pass
    return record


def _file_version(path):
    """读取 PE 文件版本字符串（如 4.2.0.13），读不到返回空串。

    先取文件版本资源大小，再用 VerQueryValueW 查根块
    VS_FIXEDFILEINFO，其偏移 8/12 为 dwFileVersionMS/LS。
    """
    try:
        import ctypes
        import struct
        from ctypes import wintypes

        size = ctypes.windll.version.GetFileVersionInfoSizeW(path, None)
        if size <= 0:
            return ""
        buf = ctypes.create_string_buffer(size)
        if not ctypes.windll.version.GetFileVersionInfoW(path, 0, size, buf):
            return ""
        info = ctypes.c_void_p()
        info_len = wintypes.UINT()
        if not ctypes.windll.version.VerQueryValueW(
            buf, "\\", ctypes.byref(info), ctypes.byref(info_len)
        ):
            return ""
        fixed = ctypes.string_at(info, info_len.value)
        ms, ls = struct.unpack_from("<II", fixed, 8)
        return "%d.%d.%d.%d" % (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)
    except Exception:
        return ""


def detect_wechat_version():
    """返回正在使用的微信 4.x 文件版本（如 4.2.0.13），找不到返回空串。

    微信 4.x 把数据目录放到 D 盘后，主程序仍在安装目录；注册表
    HKCU\\Software\\Tencent\\Weixin 记录 InstallPath。
    """
    candidates = []
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Tencent\Weixin")
        try:
            install, _ = winreg.QueryValueEx(key, "InstallPath")
            if install:
                candidates.append(os.path.join(install, "Weixin.exe"))
        finally:
            winreg.CloseKey(key)
    except OSError:
        pass
    candidates += [
        os.path.expandvars(r"%ProgramFiles%\Tencent\Weixin\Weixin.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Tencent\Weixin\Weixin.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tencent\Weixin\Weixin.exe"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            version = _file_version(path)
            if version:
                return version
    return ""


def _version_at_least(version, major, minor):
    """判断版本号是否 >= major.minor；解析失败返回 False。"""
    try:
        parts = [int(p) for p in str(version).split(".")]
    except (TypeError, ValueError):
        return False
    if len(parts) < 2:
        return False
    return (parts[0], parts[1]) >= (major, minor)
