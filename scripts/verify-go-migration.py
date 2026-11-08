"""Exercise a real Python-created workspace across Go upgrade and Python rollback."""
from pathlib import Path
import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
scratch=Path(tempfile.mkdtemp(prefix='go-migration-',dir=ROOT/'work'))
os.environ.update(JJB_DATA_DIR=str(scratch/'workspace'),JJB_REQUIRE_EMAIL='false',JJB_ALLOW_REGISTRATION='true',JJB_BOOTSTRAP_ADMIN_USERNAME='')
from fastapi.testclient import TestClient
from server.app import create_app
import httpx as requests

credentials={'username':'migration-fixture','password':'fixture-password-2026'}
def ok(response):
 if response.status_code>=400:raise AssertionError((response.status_code,response.text))
 return response.json()
with TestClient(create_app(scratch/'workspace')) as client:
 ok(client.post('/api/auth/register',json=credentials));session=ok(client.post('/api/auth/login',json=credentials));headers={'Authorization':'Bearer '+session['token']}
 message={'source':'qq','account_id':'101','conversation_id':'group:1','external_id':'same-message','sender_name':'老师','text':'11月20日提交 PDF 实验报告','sent_at':'2026-11-07T12:00:00+08:00'}
 original_message=ok(client.post('/api/messages',headers=headers,json=message))
 original_task=ok(client.post('/api/tasks',headers=headers,json={'title':'旧版实验报告','source_message_id':original_message['id'],'requirements':[{'label':'报告','extensions':['pdf'],'min_count':1}],'reminders':['2026-11-19T18:00:00+08:00']}))
 original_task=ok(client.post('/api/tasks/'+original_task['id']+'/files?version=1',headers=headers,files={'file':('报告.pdf',b'legacy-original-pdf-content','application/pdf')}))
 original_file=ok(client.post('/api/shelf',headers=headers,files={'file':('参考.txt',b'legacy-original-reference','text/plain')}))
 ok(client.put('/api/settings/llm',headers=headers,json={'base_url':'https://fixture.invalid/v1','model':'fixture','api_key':'fixture-encrypted-api-key','auto_analyze':False}))
 snapshot=ok(client.get('/api/snapshot',headers=headers))
database=scratch/'workspace/jiaojianbox.sqlite3'
with sqlite3.connect(database) as db:
 db.execute("INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')",(session['user_id'],));db.commit()
 before={t:db.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['users','messages','tasks','attachments','profiles','llm_settings']}
files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (scratch/'workspace/files').iterdir()}
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
binary=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'work/jiaojianbox-server.exe'
log=(scratch/'server.log').open('wb')
process=subprocess.Popen([str(binary),'--data',str(scratch/'workspace'),'--listen',f'127.0.0.1:{port}'],stdout=log,stderr=log,env=os.environ)
base=f'http://127.0.0.1:{port}'
try:
 for _ in range(100):
  try:
   if requests.get(base+'/health',timeout=.3).status_code==200:break
  except requests.HTTPError:pass
  if process.poll() is not None:raise AssertionError('Go server exited')
  time.sleep(.1)
 else:raise AssertionError('Go server did not start')
 migrated=ok(requests.get(base+'/api/snapshot',headers=headers,timeout=5))
 assert migrated['tasks']==snapshot['tasks'],(migrated['tasks'],snapshot['tasks'])
 assert [m['id'] for m in migrated['messages']]==[original_message['id']]
 assert migrated['shelf']==snapshot['shelf']
 assert ok(requests.get(base+'/api/settings/llm',headers=headers,timeout=5))['has_key']
 assert ok(requests.get(base+'/api/auth/me',headers=headers,timeout=5))['is_admin']
 assert ok(requests.post(base+'/api/auth/login',json=credentials,timeout=5))['user_id']==session['user_id']
 assert ok(requests.post(base+'/api/messages',headers=headers,json=message,timeout=5))['id']==original_message['id']
 for file in original_task['attachments']:
  body=requests.get(base+'/api/files/'+file['id'],headers=headers,timeout=5);assert body.content==b'legacy-original-pdf-content'
 original_task['title']='Go 更新后的实验报告'
 edited=ok(requests.put(base+'/api/tasks/'+original_task['id'],headers=headers,json=original_task,timeout=5));assert edited['version']==original_task['version']+1
 with sqlite3.connect(database) as db:
  assert before=={t:db.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in before}
 assert files=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (scratch/'workspace/files').iterdir()}
 assert (scratch/'workspace/backups/before-go/complete.json').exists()
finally:
 process.terminate();process.wait(timeout=10);log.close()
with TestClient(create_app(scratch/'workspace')) as client:
 rollback=ok(client.get('/api/snapshot',headers=headers))
 assert rollback['tasks'][0]['title']=='Go 更新后的实验报告'
 assert rollback['tasks'][0]['attachments']==snapshot['tasks'][0]['attachments']
 assert ok(client.get('/api/settings/llm',headers=headers))['has_key']
print(json.dumps({'pythonToGo':True,'pythonRollback':True,'counts':before,'allAttachmentHashesPreserved':True,'credentialsAndRolesPreserved':True,'evidence':str(scratch)},ensure_ascii=False))
