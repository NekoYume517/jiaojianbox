"""Build a custom, fully offline Go/Wails Windows installer EXE."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--out-dir',default='artifacts')
parser.add_argument('--skip-helper',action='store_true',help='reuse a verified local helper build')
args=parser.parse_args()
out=(ROOT/args.out_dir).resolve();out.mkdir(parents=True,exist_ok=True)
version=json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
go=os.environ.get('GO') or shutil.which('go') or str(ROOT.parents[1]/'work/toolchains/go/bin/go.exe')
env=dict(os.environ,CGO_ENABLED='0',GOPROXY=os.environ.get('GOPROXY','https://proxy.golang.org,direct'))
def run(argv,**kw):subprocess.run([str(x) for x in argv],cwd=ROOT,env=env,check=True,**kw)
if not args.skip_helper:run([sys.executable,ROOT/'scripts/build-helper.py'])
helper=ROOT/'work/helper/collector-agent'
run([helper/'collector-agent.exe','self-test'])
csc=Path(os.environ.get('WINDIR',r'C:\Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if not csc.is_file():raise SystemExit('Missing C# compiler for drag-watch')
run([csc,'/nologo','/target:exe','/reference:System.Windows.Forms.dll','/out:',ROOT/'desktop/drag-watch.exe',ROOT/'desktop/drag-watch.cs'])
snow=ROOT/'runtime-vendor/snowluma'
for component in [snow/'node.exe',snow/'native/snowluma-win32-x64.node',ROOT/'desktop/drag-watch.exe']:
 if not component.is_file():raise SystemExit(f'Missing required runtime: {component.name}')
deps=ROOT/'work/installer-deps';deps.mkdir(parents=True,exist_ok=True)
urls={'webview2':'https://go.microsoft.com/fwlink/?linkid=2124701','vcredist':'https://aka.ms/vs/17/release/vc_redist.x64.exe'}
for name,url in urls.items():
 destination=deps/(name+'.exe')
 if not destination.exists():
  print('Downloading Microsoft runtime:',name,flush=True)
  temporary=destination.with_suffix('.partial')
  urllib.request.urlretrieve(url,temporary)
  temporary.replace(destination)
 check_env=dict(env,JJB_DEPENDENCY_FILE=str(destination))
 script="$s=Get-AuthenticodeSignature -LiteralPath $env:JJB_DEPENDENCY_FILE; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){exit 1}"
 subprocess.run([shutil.which('pwsh') or 'powershell.exe','-NoProfile','-NonInteractive','-Command',script],env=check_env,check=True)
stage=out/'app';stage.mkdir(exist_ok=True)
resources=[]
try:
 for name in ['jiaojianbox','jiaojianbox-setup','jiaojianbox-uninstall']:
  syso=ROOT/'cmd'/name/'rsrc_windows_amd64.syso';resources.append(syso)
  run([go,'run','./scripts/winres',ROOT/'build/installer.ico',syso])
 for name,filename in [('jiaojianbox',stage/'交件箱.exe'),('jiaojianbox-uninstall',stage/'Uninstall.exe'),('jiaojianbox-setup',out/'setup-bootstrap.exe')]:
  run([go,'build','-trimpath','-ldflags',f'-s -w -H windowsgui -X main.version={version}','-o',filename,'./cmd/'+name])
finally:
 for file in resources:file.unlink(missing_ok=True)
shutil.copytree(helper,stage/'runtime/collector-agent',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
shutil.copytree(snow,stage/'runtime/snowluma',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
(stage/'bridge').mkdir(exist_ok=True)
for name in ['snow-loader.mjs','snow-bridge.mjs','drag-watch.exe']:
 shutil.copy2(ROOT/'desktop'/name,stage/'bridge'/name)
for name in ['LICENSE','THIRD_PARTY_NOTICES.md']:
 if (ROOT/name).exists():shutil.copy2(ROOT/name,stage/name)
manifest={'version':version,'files':{}}
for file in sorted(stage.rglob('*')):
 if file.is_file():
  with file.open('rb') as f:manifest['files'][file.relative_to(stage).as_posix()]=hashlib.file_digest(f,'sha256').hexdigest()
archive=out/'payload.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for name in manifest['files']:z.write(stage/name,name)
 for name in urls:z.write(deps/(name+'.exe'),'dependencies/'+name+'.exe',compress_type=zipfile.ZIP_STORED)
 z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False))
installer=out/f'JiaojianBox-Setup-{version}-x64.exe'
with installer.open('wb') as dst:
 with (out/'setup-bootstrap.exe').open('rb') as src:shutil.copyfileobj(src,dst)
 digest=hashlib.sha256();size=0
 with archive.open('rb') as src:
  while block:=src.read(1024*1024):digest.update(block);size+=len(block);dst.write(block)
 dst.write(struct.pack('<Q',size)+digest.digest()+b'JJBSET01')
with installer.open('rb') as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
(out/'SHA256SUMS.txt').write_text(f'{sha}  {installer.name}\n',encoding='utf-8')
print(json.dumps({'installer':str(installer),'size':installer.stat().st_size,'sha256':sha,'files':len(manifest['files'])},ensure_ascii=False),flush=True)
