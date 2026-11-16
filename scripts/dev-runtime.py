"""把本地开发构建变成可运行的桌面采集运行时。

本地 `go build` 出来的 exe 只包含自身，采集器与 QQ/微信运行时是独立组件
（`runtime/` 目录）。本脚本把仓库内的组件组装到 exe 同级（默认 `work/`），
`resourceRoot()` 会优先检查 exe 同级的 `runtime/`，无需额外配置。

产物：
  work/runtime/collector-agent/collector-agent.exe   微信数据库读取 + 上传队列
  work/runtime/wcdb/*.dll                           微信 4.x WCDB 直读（回退用）
  work/runtime/snowluma/...                          QQ SnowLuma 连接器
  work/runtime/snowcat/...                           QQ 协议端（含 node_modules）
  work/bridge/*.mjs, drag-watch.exe                  QQ 启动桥

用法：
  python scripts/dev-runtime.py            组装（helper 缺失时自动构建）
  python scripts/dev-runtime.py --rebuild  强制重建 collector-agent
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "work" / "helper" / "collector-agent"
RUNTIME = ROOT / "work" / "runtime"
BRIDGE = ROOT / "work" / "bridge"
WCDB = ROOT / "runtime-vendor" / "wcdb"
SNOWLUMA = ROOT / "runtime-vendor" / "snowluma"
SNOWCAT = ROOT / "runtime-vendor" / "snowcat"
WECHATAUTO = ROOT / "runtime-vendor" / "wechatauto-replica"
VENV = ROOT / "work" / "venv-build"
ENTRY = ROOT / "build" / "collector_entry.py"


def run(argv: list, **kw) -> None:
    subprocess.run([str(x) for x in argv], cwd=ROOT, check=True, **kw)


def ensure_pyinstaller() -> Path:
    py = VENV / "Scripts" / "python.exe"
    if not py.exists():
        run([sys.executable, "-m", "venv", str(VENV)])
    run([py, "-m", "pip", "install", "--disable-pip-version-check",
         "--index-url", os.environ.get("PIP_INDEX_URL", "https://pypi.tuna.tsinghua.edu.cn/simple"),
         "--timeout", "20", "--retries", "4",
         "httpx==0.28.1", "websockets==13.1", "cryptography>=43,<47",
         "psutil>=6,<8", "zstandard>=0.23,<1", "pyinstaller>=6,<7"])
    return py


def build_helper(rebuild: bool) -> None:
    exe = HELPER / "collector-agent.exe"
    if exe.exists() and not rebuild:
        return
    py = ensure_pyinstaller()
    if not WECHATAUTO.is_dir():
        raise SystemExit("缺少 runtime-vendor/wechatauto-replica")
    data = f"{WCDB}{os.pathsep}runtime/wcdb"
    run([py, "-m", "PyInstaller", "--noconfirm", "--clean",
         "--distpath", ROOT / "work" / "helper",
         "--workpath", ROOT / "work" / "helper-build",
         "--specpath", ROOT / "work" / "helper-build",
         "--name", "collector-agent",
         "--paths", ROOT, "--paths", WECHATAUTO,
         "--hidden-import", "wechatauto.db",
         "--hidden-import", "collector.wcdb_reader",
         "--hidden-import", "collector.wcdb_client",
         "--hidden-import", "psutil", "--hidden-import", "zstandard",
         f"--add-data={data}", ENTRY])


def assemble() -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    BRIDGE.mkdir(parents=True, exist_ok=True)

    def copy_tree(src: Path, dest: Path) -> None:
        # 运行中的 QQ/采集进程可能占用 native 文件；逐个覆盖，被占用的跳过。
        dest.mkdir(parents=True, exist_ok=True)
        for entry in src.rglob("*"):
            if entry.is_dir() or "__pycache__" in entry.parts or ".git" in entry.parts:
                continue
            target = dest / entry.relative_to(src)
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(entry, target)
            except PermissionError:
                print("skip locked:", entry.relative_to(src))

    copy_tree(HELPER, RUNTIME / "collector-agent")
    copy_tree(WCDB, RUNTIME / "wcdb")
    copy_tree(SNOWLUMA, RUNTIME / "snowluma")
    copy_tree(SNOWCAT, RUNTIME / "snowcat")
    for name in ("snow-loader.mjs", "snow-bridge.mjs", "drag-watch.exe"):
        src = ROOT / "desktop" / name
        if not src.exists():
            continue
        try:
            shutil.copy2(src, BRIDGE / name)
        except PermissionError:
            print("skip locked:", name)
    # QQ 协议端依赖
    if not (RUNTIME / "snowcat" / "node_modules" / "express" / "package.json").is_file():
        npm = os.environ.get("NPM") or shutil.which("npm")
        if not npm:
            raise SystemExit("缺少 npm，无法安装 SnowCat 运行时依赖")
        run([npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=RUNTIME / "snowcat")
    # 自检
    run([RUNTIME / "collector-agent" / "collector-agent.exe", "self-test"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rebuild", action="store_true", help="强制重建 collector-agent")
    args = parser.parse_args()
    build_helper(args.rebuild)
    assemble()
    print("Runtime ready under", RUNTIME)
    print("启动本地 exe 后即可在「触发器」页连接 QQ/微信。")


if __name__ == "__main__":
    main()
