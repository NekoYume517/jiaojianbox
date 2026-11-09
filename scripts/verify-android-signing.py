"""Verify the permanent JiaojianBox Android signing identity.

Every published APK must be signed by the same certificate:

    256994e591fe61061ed76b88aabe518f140deefb4dab7f947d64e461dbb158ab

Run against the keystore (default) or a built APK:

    python scripts/verify-android-signing.py
    python scripts/verify-android-signing.py --keystore path/to/keystore
    python scripts/verify-android-signing.py --apk android/app/build/outputs/apk/debug/app-debug.apk

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
KEY_ALIAS = "androiddebugkey"
STORE_PASSWORD = "android"
KEYSTORE_NAME = "jiaojianbox-signing.keystore"

ROOT = pathlib.Path(__file__).resolve().parents[1]


def default_keystore() -> pathlib.Path:
    override = os.environ.get("JJB_ANDROID_KEYSTORE_PATH")
    if override:
        return pathlib.Path(override)
    return ROOT / "android" / "keystore" / KEYSTORE_NAME


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"{command[0]} failed ({result.returncode}): {message}")
    return result.stdout.decode("latin-1")


def keystore_certificate(keystore: pathlib.Path) -> str:
    if not keystore.is_file():
        raise RuntimeError(f"keystore not found: {keystore}")
    der = run(
        [
            "keytool",
            "-exportcert",
            "-storetype",
            "PKCS12",
            "-keystore",
            str(keystore),
            "-storepass",
            STORE_PASSWORD,
            "-alias",
            KEY_ALIAS,
        ]
    )
    return hashlib.sha256(der.encode("latin-1")).hexdigest()


def find_apksigner() -> str | None:
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        return None
    build_tools = pathlib.Path(sdk) / "build-tools"
    if not build_tools.is_dir():
        return None
    candidates = sorted(build_tools.glob("*/apksigner*"), reverse=True)
    for candidate in candidates:
        if candidate.is_file() and (candidate.suffix in {"", ".bat", ".exe", ".cmd"}):
            return str(candidate)
    return None


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
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(f"error: {error}")
        sys.exit(2)
