"""Build self-contained PyInstaller helpers for the desktop collector."""
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
    ['--name', 'collector-agent', '--paths', str(root), '--paths', str(root / 'runtime-vendor' / 'wechatauto-replica'),
     '--hidden-import', 'wechatauto.db', '--hidden-import', 'psutil', '--hidden-import', 'zstandard',
     str(root / 'build' / 'collector_entry.py')],
]
for extra in jobs:
    subprocess.run(common + extra, check=True)
print('Helpers ready:', dist)

subprocess.run([str(dist / 'collector-agent' / 'collector-agent.exe'), 'self-test'], check=True)
