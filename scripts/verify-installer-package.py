"""Exercise a built installer in an isolated folder without Windows registration."""
import argparse, hashlib, json, os, subprocess, tempfile
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('installer',type=Path)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
scratch=Path(tempfile.mkdtemp(prefix='setup-accept-',dir=root/'work'))
parent=scratch/'chosen-folder'; parent.mkdir()
keep=parent/'existing-file.txt'; keep.write_text('keep parent contents',encoding='utf-8')
installer=args.installer.resolve()
command=[str(installer),'--silent','--no-shortcuts','--no-register','--dir',str(parent)]
subprocess.run(command,check=True,timeout=180)
target=parent/'jiaojianbox'
manifest=json.loads((target/'.jiaojianbox-install.json').read_text(encoding='utf-8'))
assert manifest['version']==json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
assert keep.read_text()=='keep parent contents'
unowned=target/'user-data.txt'; unowned.write_text('preserve local data',encoding='utf-8')
# Upgrade replaces the old program but leaves anything outside its manifest alone.
(target/'交件箱.exe').write_bytes(b'old app fixture')
subprocess.run(command,check=True,timeout=180)
assert unowned.read_text()=='preserve local data'
for name,digest in manifest['files'].items():
    with (target/name).open('rb') as file:
        assert hashlib.file_digest(file,'sha256').hexdigest()==digest,name
subprocess.run([str(target/'Uninstall.exe'),'--quiet'],check=True,timeout=30)
import time
for _ in range(100):
    if not (target/'.jiaojianbox-install.json').exists():break
    time.sleep(.1)
assert not (target/'.jiaojianbox-install.json').exists()
assert not (target/'交件箱.exe').exists()
assert unowned.read_text()=='preserve local data'
assert keep.read_text()=='keep parent contents'
print(json.dumps({'installed':True,'upgradeHashVerified':len(manifest['files']),'uninstalled':True,'parentFilesPreserved':True,'unownedDataPreserved':True,'evidence':str(scratch)},ensure_ascii=False))
