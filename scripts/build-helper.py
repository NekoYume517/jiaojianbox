"""Build self-contained PyInstaller helpers for the desktop collector and offline server."""
from pathlib import Path
import os
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
dist = root / 'work' / 'helper'
build = root / 'work' / 'helper-build'
venv = root / 'work' / 'venv-build'
py = venv / 'Scripts' / 'python.exe'
if not py.exists():
    subprocess.run([sys.executable, '-m', 'venv', str(venv)], check=True)

subprocess.run([str(py), '-m', 'pip', 'install', '--disable-pip-version-check',
                '--index-url', os.environ.get('PIP_INDEX_URL', 'https://pypi.org/simple'),
                '-r', str(root / 'requirements.txt'), 'pyinstaller>=6,<7'], check=True)

common = [
    str(py), '-m', 'PyInstaller', '--noconfirm', '--clean',
    '--distpath', str(dist), '--workpath', str(build), '--specpath', str(build),
]
jobs = [
    ['--name', 'collector-agent', '--paths', str(root), '--paths', str(root / 'vendor' / 'wechatauto-replica'),
     str(root / 'build' / 'collector_entry.py')],
    ['--name', 'local-server', '--paths', str(root),
     '--add-data', f"{root / 'web'};web",
     '--hidden-import', 'uvicorn.loops.auto', '--hidden-import', 'uvicorn.loops.asyncio',
     '--hidden-import', 'uvicorn.protocols.http.auto', '--hidden-import', 'uvicorn.protocols.http.h11_impl',
     '--hidden-import', 'uvicorn.protocols.websockets.auto', '--hidden-import', 'uvicorn.protocols.websockets.wsproto_impl',
     '--hidden-import', 'uvicorn.lifespan.on',
     str(root / 'build' / 'local_entry.py')],
]
for extra in jobs:
    subprocess.run(common + extra, check=True)
print('Helpers ready:', dist)
