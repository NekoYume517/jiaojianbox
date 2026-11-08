"""Build a private Windows runtime bundle without account config, caches or chat data."""
from pathlib import Path
import os,subprocess,sys,json,hashlib,shutil
root=Path(__file__).resolve().parents[1]; bundle=root/'work'/'bundle'; bundle.mkdir(parents=True,exist_ok=True)
py=bundle/'python';py.mkdir(exist_ok=True)
# Reuse a complete portable CPython distribution already present on the build host.
python_home=Path(os.environ.get('JJB_PYTHON_HOME',r'C:\Users\zzy\AppData\Roaming\uv\python\cpython-3.13-windows-x86_64-none'))
for name in ['python.exe','python3.dll','python313.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt']:shutil.copy2(python_home/name,py/name)
for name in ['DLLs','Lib']:
    shutil.copytree(python_home/name,py/name,dirs_exist_ok=True,ignore=shutil.ignore_patterns('site-packages','__pycache__','test','tests'))
site=py/'Lib'/'site-packages';site.mkdir(parents=True,exist_ok=True)
subprocess.run([sys.executable,'-m','pip','install','--index-url','https://pypi.tuna.tsinghua.edu.cn/simple','--timeout','12','--retries','1','--disable-pip-version-check','--only-binary=:all:','--python-version','3.13','--platform','win_amd64','--implementation','cp','--abi','cp313','--target',str(site),'httpx==0.28.1','websockets==13.1','cryptography>=43,<47','psutil>=6,<8','pywin32>=305','zstandard>=0.19'],check=True)
(site/'sitecustomize.py').write_text('import os,sys\nfrom pathlib import Path\np=Path(__file__).parent\nsys.path.insert(0,str(p/"win32"))\nif (p/"pywin32_system32").exists():\n    _dll=os.add_dll_directory(str(p/"pywin32_system32"))\n',encoding='utf-8')
vendor=Path(os.environ.get('JJB_WECHAT_SOURCE') or (root/'vendor'/'wechatauto-replica')); target=site/'wechatauto';target.mkdir(exist_ok=True)
(target/'__init__.py').write_text('"""Database-only distribution of wechatauto-replica 1.2.9 (Apache-2.0)."""\n',encoding='utf-8')
shutil.copy2(vendor/'wechatauto'/'db.py',target/'db.py');
db_source=(target/'db.py').read_text(encoding='utf-8');db_source=db_source.replace('            conns = [self._open(rel) for rel in self._message_dbs()]','            for rel in self._message_dbs():\n                conns.append(self._open(rel))');(target/'db.py').write_text(db_source,encoding='utf-8')
shutil.copy2(vendor/'LICENSE',target/'LICENSE')
(target/'logger.py').write_text('import logging\nwxlog=logging.getLogger("wechatauto.database")\n',encoding='utf-8')
(target/'NOTICE').write_text('Derived from fanyuantaier/wechatauto-replica 1.2.9. Database reader retained; package initializer and logger replaced to remove UI automation dependencies; message connection acquisition made incremental so failures close already-open handles. Apache-2.0.\n',encoding='utf-8')
snow=Path(os.environ.get('JJB_SNOWLUMA_HOME') or (root/'vendor'/'snowluma'));dest=bundle/'snowluma';dest.mkdir(exist_ok=True)
for name in ['index.mjs','node.exe','package.json','release.json','EULA.md','PRIVACY.md'] :shutil.copy2(snow/name,dest/name)
for name in ['native','client']:shutil.copytree(snow/name,dest/name,dirs_exist_ok=True)
files={p.relative_to(bundle).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in [py/'python.exe',dest/'index.mjs',dest/'node.exe',target/'db.py']}
(bundle/'manifest.json').write_text(json.dumps({'python':'3.13-portable','snowluma':json.loads((dest/'package.json').read_text(encoding='utf-8'))['version'],'wechat_db':'1.2.9-db-only','sha256':files},indent=2),encoding='utf-8')
print('Runtime bundle ready:',bundle)
