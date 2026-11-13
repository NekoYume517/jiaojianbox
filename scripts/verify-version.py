"""Verify every user-visible or packaged version uses package.json as its source."""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


package = json.loads(read("package.json"))
lock = json.loads(read("package-lock.json"))
version = package["version"]
failures: list[str] = []


def exactly(relative: str, pattern: str, label: str) -> None:
    match = re.search(pattern, read(relative), re.MULTILINE)
    actual = match.group(1) if match else None
    if actual != version:
        failures.append(f"{relative}: {label}={actual!r}, expected {version!r}")


if lock.get("version") != version:
    failures.append(f"package-lock.json: root version={lock.get('version')!r}, expected {version!r}")
if lock.get("packages", {}).get("", {}).get("version") != version:
    failures.append("package-lock.json: packages[''].version does not match package.json")

exactly("README.md", r"^# 交件箱 · ([0-9]+\.[0-9]+\.[0-9]+)$", "README heading")
exactly("Dockerfile", r"^ARG VERSION=([0-9]+\.[0-9]+\.[0-9]+)$", "Docker build version")
exactly("cmd/jiaojianbox/main.go", r'^var version = "([0-9]+\.[0-9]+\.[0-9]+)"$', "desktop default version")
exactly("cmd/jiaojianbox-server/main.go", r'^var version = "([0-9]+\.[0-9]+\.[0-9]+)"$', "server default version")
exactly("android/app/build.gradle.kts", r'^        versionName = "([0-9]+\.[0-9]+\.[0-9]+)"$', "Android versionName")
exactly("docs/android-web-shell.md", r"^版本：([0-9]+\.[0-9]+\.[0-9]+)。", "Android shell documentation")

release_file = ROOT / "docs" / "releases" / f"v{version}.md"
if not release_file.is_file():
    failures.append(f"missing release notes: {release_file.relative_to(ROOT)}")

go_version = re.search(r"^go ([0-9]+\.[0-9]+\.[0-9]+)$", read("go.mod"), re.MULTILINE)
if not go_version:
    failures.append("go.mod: missing full Go version directive")
else:
    expected = f"需要 Go {go_version.group(1)} 或更新版本"
    if expected not in read("README.md"):
        failures.append(f"README.md: expected Go requirement {go_version.group(1)!r}")

if failures:
    raise SystemExit("\n".join(failures))

print(json.dumps({
    "version": version,
    "go": go_version.group(1),
    "releaseNotes": str(release_file.relative_to(ROOT)),
    "versionSourcesVerified": 8,
}, ensure_ascii=False))
