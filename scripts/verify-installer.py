"""Run the distributed EXE through fresh install, upgrade, dependency and uninstall checks."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import tempfile
import sys
import time

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--out-dir',default='artifacts');args=parser.parse_args()
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
installer=root/args.out_dir/f'JiaojianBox-Setup-{version}-x64.exe'
scratch=Path(tempfile.mkdtemp(prefix='installer-smoke-',dir=root/'work'));target=scratch/'交件箱'
command=[str(installer),'--silent','--dir',str(target),'--no-shortcuts','--no-register']
subprocess.run(command,check=True,timeout=180)
assert (target/'交件箱.exe').exists() and (target/'Uninstall.exe').exists()
with (target/'.jiaojianbox-install.json').open(encoding='utf-8') as f:manifest=json.load(f)
assert any(p.startswith('runtime/collector-agent/') for p in manifest['files'])
assert 'runtime/snowluma/node.exe' in manifest['files']
for required in ['runtime/snowcat/napcat.mjs','runtime/snowcat/snowcat-boot.js','runtime/snowcat/winmm-v8.dll','runtime/snowcat/LICENSE','runtime/snowcat/version.txt','runtime/snowcat/package.json','runtime/snowcat/package-lock.json','runtime/snowcat/node_modules/express/package.json','runtime/snowcat/node_modules/ws/package.json']:
 assert required in manifest['files'],required
for name,expected in manifest['files'].items():
 with (target/name).open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==expected,name
subprocess.run([str(target/'runtime/collector-agent/collector-agent.exe'),'self-test'],check=True,timeout=20)
subprocess.run([sys.executable,str(root/'scripts/verify-collector-runtime.py'),str(target/'runtime/collector-agent/collector-agent.exe')],check=True,timeout=60)
# Unknown files must survive both upgrade and uninstall.
sentinel=target/'user-kept.txt';sentinel.write_text('preserve-me',encoding='utf-8')
subprocess.run(command,check=True,timeout=180);assert sentinel.read_text()=='preserve-me'
subprocess.run([str(target/'Uninstall.exe'),'--quiet'],check=True,timeout=15)
for _ in range(200):
 if not (target/'交件箱.exe').exists() and not (target/'.jiaojianbox-install.json').exists():break
 time.sleep(.1)
else:raise AssertionError('uninstall did not finish')
assert sentinel.read_text()=='preserve-me'
print(json.dumps({'customInstaller':True,'allFilesVerified':len(manifest['files']),'bundledCollector':True,'upgrade':True,'uninstall':True,'unlistedDataPreserved':True,'evidence':str(scratch)},ensure_ascii=False))
