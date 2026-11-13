"""Verify the permanent JiaojianBox Android signing identity.

Every published APK must be signed by the same certificate:

    256994e591fe61061ed76b88aabe518f140deefb4dab7f947d64e461dbb158ab

Run against the keystore (default) or a built APK:

    python scripts/verify-android-signing.py
    python scripts/verify-android-signing.py --keystore path/to/keystore
    python scripts/verify-android-signing.py --apk android/app/build/outputs/apk/release/app-release.apk --require-release

Exits non-zero when the identity does not match, so CI fails instead of publishing a
build that would force users to uninstall the app. See docs/android-signing.md.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys

EXPECTED_CERT_SHA256 = "256994e591fe61061ed76b88aabe518f140deefb4dab7f947d64e461dbb158ab"
KEYSTORE_NAME = "jiaojianbox-signing.keystore"

ROOT = pathlib.Path(__file__).resolve().parents[1]
SIGNING_PROPERTIES = ROOT / "android" / "keystore" / "signing.properties"


def local_signing_value(name: str) -> str:
    if not SIGNING_PROPERTIES.is_file():
        return ""
    for raw_line in SIGNING_PROPERTIES.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", "!")):
            continue
        key, separator, value = line.partition("=")
        if separator and key.strip() == name:
            return value.strip()
    return ""


def signing_value(environment: str, property_name: str, default: str = "") -> str:
    return os.environ.get(environment, "").strip() or local_signing_value(property_name) or default


def default_keystore() -> pathlib.Path:
    override = os.environ.get("JJB_ANDROID_KEYSTORE_PATH")
    if override:
        return pathlib.Path(override)
    configured = local_signing_value("storeFile")
    if configured:
        path = pathlib.Path(configured)
        return path if path.is_absolute() else ROOT / "android" / "keystore" / path
    return ROOT / "android" / "keystore" / KEYSTORE_NAME


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        raw_message = result.stderr or result.stdout
        try:
            message = raw_message.decode("utf-8").strip()
        except UnicodeDecodeError:
            message = raw_message.decode("gb18030", "replace").strip()
        raise RuntimeError(f"{command[0]} failed ({result.returncode}): {message}")
    return result.stdout.decode("latin-1")


def keystore_certificate(keystore: pathlib.Path) -> str:
    if not keystore.is_file():
        raise RuntimeError(f"keystore not found: {keystore}")
    store_password = signing_value("JJB_ANDROID_KEYSTORE_PASSWORD", "storePassword")
    if not store_password:
        raise RuntimeError(
            "JJB_ANDROID_KEYSTORE_PASSWORD or android/keystore/signing.properties is required"
        )
    key_alias = signing_value("JJB_ANDROID_KEY_ALIAS", "keyAlias", "androiddebugkey")
    store_type = signing_value("JJB_ANDROID_STORE_TYPE", "storeType", "PKCS12")
    der = run(
        [
            "keytool",
            "-exportcert",
            "-storetype",
            store_type,
            "-keystore",
            str(keystore),
            "-storepass",
            store_password,
            "-alias",
            key_alias,
        ]
    )
    return hashlib.sha256(der.encode("latin-1")).hexdigest()


def find_build_tool(name: str) -> str | None:
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        return None
    build_tools = pathlib.Path(sdk) / "build-tools"
    if not build_tools.is_dir():
        return None
    for version in sorted(build_tools.iterdir(), reverse=True):
        if not version.is_dir():
            continue
        for suffix in ("", ".exe", ".bat", ".cmd"):
            candidate = version / f"{name}{suffix}"
            if candidate.is_file():
                return str(candidate)
    return None


def find_apksigner() -> str | None:
    return find_build_tool("apksigner")


def apk_certificate(apk: pathlib.Path) -> str:
    if not apk.is_file():
        raise RuntimeError(f"apk not found: {apk}")
    signer = find_apksigner()
    if signer:
        report = run([signer, "verify", "--print-certs", str(apk)])
        for line in report.splitlines():
            if "certificate SHA-256 digest:" in line:
                return line.split(":")[-1].strip().replace(":", "").lower()
        raise RuntimeError("apksigner did not report a SHA-256 certificate digest")
    report = run(["keytool", "-printcert", "-jarfile", str(apk)])
    for line in report.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("SHA256:"):
            return stripped.split(":", 1)[1].strip().replace(":", "").lower()
    raise RuntimeError(
        "no APK certificate found; install Android build-tools for apksigner or sign with v1 enabled"
    )


def apk_is_debuggable(apk: pathlib.Path) -> bool:
    aapt = find_build_tool("aapt")
    if not aapt:
        raise RuntimeError("aapt is required to verify android:debuggable")
    report = run([aapt, "dump", "badging", str(apk)])
    return "application-debuggable" in report


def compare(label: str, actual: str) -> bool:
    ok = actual == EXPECTED_CERT_SHA256
    print(f"{label}: {actual}")
    print(f"expected: {EXPECTED_CERT_SHA256}")
    print(f"{'MATCH' if ok else 'MISMATCH'} - {label}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the permanent Android signing identity")
    parser.add_argument("--keystore", type=pathlib.Path, default=None)
    parser.add_argument("--apk", type=pathlib.Path, default=None)
    parser.add_argument("--require-release", action="store_true", help="also reject the application-debuggable manifest flag")
    args = parser.parse_args()

    if not args.keystore and not args.apk:
        args.keystore = default_keystore()

    ok = True
    if args.keystore:
        keystore = args.keystore
        if not keystore.is_file() and keystore == default_keystore():
            print(f"keystore missing at {keystore}")
            print("android signing identity unverified - provide --keystore or JJB_ANDROID_KEYSTORE_PATH")
            return 1
        ok &= compare(f"keystore {keystore.name}", keystore_certificate(keystore))
    if args.apk:
        ok &= compare(f"apk {args.apk.name}", apk_certificate(args.apk))
        if args.require_release:
            debuggable = apk_is_debuggable(args.apk)
            print(f"debuggable: {str(debuggable).lower()}")
            if debuggable:
                print("FAIL - release APK is debuggable")
                ok = False
            else:
                print("MATCH - release APK is not debuggable")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(f"error: {error}")
        sys.exit(2)
