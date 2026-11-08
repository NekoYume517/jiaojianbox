"""Prepare a self-contained public Python runtime for desktop offline mode."""
from pathlib import Path
import json
import hashlib
import os
import subprocess
import sys
import urllib.request
import zipfile

root=Path(__file__).resolve().parents[1]
stamp=root/'work/core-runtime.json'
requirements_hash=hashlib.sha256((root/'requirements.txt').read_bytes()).hexdigest()
private=root/'work/bundle/python'
runtime=private if (private/'python.exe').exists() else root/'work/core-runtime/python'
runtime.mkdir(parents=True,exist_ok=True)
if stamp.exists() and os.environ.get('JJB_REFRESH_RUNTIME')!='1':
    saved=json.loads(stamp.read_text())
    if saved.get('python')==str(runtime) and saved.get('requirements_hash')==requirements_hash and (runtime/'python.exe').exists():
        print('Using verified offline runtime cache')
        raise SystemExit(0)
if not (runtime/'python.exe').exists():
    archive=root/'work/python-3.13.7-embed-amd64.zip'
    urllib.request.urlretrieve('https://www.python.org/ftp/python/3.13.7/python-3.13.7-embed-amd64.zip',archive)
    with zipfile.ZipFile(archive) as z:z.extractall(runtime)
    # Embedded CPython ignores PYTHONPATH. Include the external service sources explicitly.
    (runtime/'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n../../python\nimport site\n')
site=runtime/'Lib/site-packages';site.mkdir(parents=True,exist_ok=True)
index=os.environ.get('PIP_INDEX_URL','https://pypi.org/simple')
subprocess.run([sys.executable,'-m','pip','install','--ignore-installed','--index-url',index,'--only-binary=:all:','--python-version','3.13','--platform','win_amd64','--implementation','cp','--abi','cp313','--target',str(site),'--upgrade','-r',str(root/'requirements.txt')],check=True)
stamp.write_text(json.dumps({'python':str(runtime),'requirements_hash':requirements_hash}))
print('Offline runtime ready')
