"""Read local WeChat image containers without UI automation or remote fetch."""
import base64
import hashlib
import json
import re
import struct
import time
from pathlib import Path

V1_MAGIC = b"\x07\x08\x05\x56\x02\x05"
V2_MAGIC = b"\x07\x08\x56\x32\x08\x07"
MAX_BYTES = 20 << 20


def image_type(data):
    if data[:3] == b"\xff\xd8\xff": return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n": return "png"
    if data[:6] in (b"GIF87a", b"GIF89a"): return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "webp"
    return ""


def complete(data, kind):
    if kind == "jpg": return data.endswith(b"\xff\xd9")
    if kind == "png": return data.endswith(b"\x49\x45\x4e\x44\xae\x42\x60\x82")
    if kind == "gif": return data.endswith(b"\x3b")
    return kind == "webp"


class LocalImageReader:
    def __init__(self, db, cache_root):
        self.db = db
        self.root = Path(cache_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.account_dir = Path(db.account_dir)
        self._aes_key = None
        self._xor_key = None
        self._files = None

    def _decrypt_v2(self, data):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        aes_size, xor_size = struct.unpack_from("<LL", data, 6)
        if not 0 <= aes_size <= len(data) or not 0 <= xor_size <= len(data):
            raise ValueError("invalid-image-container")
        aes_key, xor_key = self._keys(data[15:31])
        padded = aes_size + (16 - aes_size % 16 if aes_size % 16 else 16)
        end = 15 + padded
        decryptor = Cipher(algorithms.AES(aes_key.encode("ascii")), modes.ECB()).decryptor()
        plain = decryptor.update(data[15:end]) + decryptor.finalize()
        padding = plain[-1] if plain else 0
        if 1 <= padding <= 16 and plain.endswith(bytes([padding]) * padding):
            plain = plain[:-padding]
        return plain + data[end:len(data)-xor_size] + bytes(value ^ xor_key for value in data[len(data)-xor_size:])

    def _keys(self, probe):
        if self._aes_key:
            return self._aes_key, self._xor_key
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        cfg = getattr(self.db, "cfg_dword", None)
        candidates = []
        if cfg:
            candidates.append((hashlib.md5((str(cfg) + self.db.wxid).encode()).hexdigest()[:16], cfg & 0xff))
        key_file = self.root / "image-key.json"
        if key_file.exists():
            try:
                from wechatauto.db import _unprotect_key_cache
                saved = json.loads(_unprotect_key_cache(key_file.read_bytes()).decode())
                candidates.append((saved["aes"], int(saved["xor"])))
            except (OSError, ValueError, KeyError, TypeError):
                pass
        for aes, xor in candidates:
            decryptor = Cipher(algorithms.AES(aes.encode("ascii")), modes.ECB()).decryptor()
            if image_type(decryptor.update(probe) + decryptor.finalize()):
                self._aes_key, self._xor_key = aes, xor
                if not key_file.exists():
                    try:
                        from wechatauto.db import _protect_key_cache
                        key_file.write_bytes(_protect_key_cache(json.dumps({"aes": aes, "xor": xor}).encode()))
                    except OSError:
                        pass
                return aes, xor
        from wechatauto.media import MediaDownloader
        class InMemoryDownloader(MediaDownloader):
            def _load_persisted_key(self, probe=None):
                return None
            def _persist_key(self, aes_key):
                return None
        found = InMemoryDownloader(self.db).detect_image_key()
        if not found:
            raise ValueError("image-key-unavailable")
        self._aes_key, self._xor_key = found
        return found

    def _decrypt(self, path):
        data = path.read_bytes()
        if len(data) > MAX_BYTES * 3:
            raise ValueError("image-too-large")
        if data[:6] == V2_MAGIC:
            out = self._decrypt_v2(data)
        elif data[:6] == V1_MAGIC:
            cfg = getattr(self.db, "cfg_dword", None)
            out = bytes(value ^ ((cfg & 0xff) if cfg else 0x88) for value in data[22:])
        else:
            out = next((decoded for key in (0x88, 0x30, 0xff, 0xe9)
                        if image_type(decoded := bytes(value ^ key for value in data))), b"")
        if out.startswith(b"wxgf"):
            from wechatauto.media import MediaDownloader
            converted = MediaDownloader(self.db)._wxgf_to_jpg(out)
            if converted:
                out = converted
        kind = image_type(out)
        if kind in ("jpg", "png"):
            marker = b"\xff\xd9" if kind == "jpg" else b"\x49\x45\x4e\x44\xae\x42\x60\x82"
            end = out.rfind(marker)
            if end >= 0 and len(out) - end - len(marker) <= 32:
                out = out[:end + len(marker)]
        if not kind or not complete(out, kind) or len(out) > MAX_BYTES:
            raise ValueError("incomplete-or-unsupported-image")
        return out, kind

    def read(self, row, chat):
        if str(row.get("type")) != "图片":
            return None
        blob = row.get("packed_info") or row.get("packed_info_data") or row.get("content") or b""
        if isinstance(blob, str):
            blob = blob.encode("utf-8", errors="ignore")
        match = re.search(rb"[0-9a-fA-F]{32}", bytes(blob))
        if not match:
            return {"kind": "image", "status": "not_downloaded", "reason": "no-local-image-reference"}
        md5 = match.group().decode().lower()
        folder = self.account_dir / "msg" / "attach" / hashlib.md5(chat.encode()).hexdigest()
        month = time.strftime("%Y-%m", time.localtime(row.get("create_time") or 0))
        if self._files is None or time.monotonic() - self._files[0] > 60:
            self._files = (time.monotonic(), list(folder.glob("*/Img/*.dat")))
        paths = []
        for suffix in ("_h.dat", ".dat", "_t.dat"):
            paths.append(folder / month / "Img" / (md5 + suffix))
            paths.extend(path for path in self._files[1] if path.name == md5 + suffix)
        seen = set()
        found_copy = False
        for path in paths:
            if path in seen or not path.is_file():
                continue
            found_copy = True
            seen.add(path)
            try:
                data, kind = self._decrypt(path)
                return {"kind": "image", "status": "ready", "mime": "image/" + ("jpeg" if kind == "jpg" else kind),
                        "extension": kind, "data": base64.b64encode(data).decode("ascii"),
                        "size": len(data), "tier": path.stem[len(md5):].lstrip("_") or "mid"}
            except (OSError, ValueError, RuntimeError):
                continue
        return {"kind": "image", "status": "decrypt_failed" if found_copy else "not_downloaded",
                "reason": "no-readable-local-copy"}
