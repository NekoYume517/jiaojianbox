import io
import json
import sqlite3
import zipfile

from fastapi.testclient import TestClient
from server.app import create_app
from server.mail import Mailer


def bootstrap(tmp_path, monkeypatch):
    monkeypatch.setenv('JJB_BOOTSTRAP_ADMIN_USERNAME','zzy')
    monkeypatch.setenv('JJB_BOOTSTRAP_ADMIN_PASSWORD','admin-test-password')
    monkeypatch.setenv('JJB_REQUIRE_EMAIL','true')
    app=create_app(tmp_path)
    client=TestClient(app)
    result=client.post('/api/auth/login',json={'username':'zzy','password':'admin-test-password'}).json()
    return app,client,{'Authorization':'Bearer '+result['token']}


def test_email_verification_reset_and_smtp_secret(tmp_path,monkeypatch):
    app,c,admin=bootstrap(tmp_path,monkeypatch)
    sent=[]
    monkeypatch.setattr(Mailer,'send',lambda self,email,purpose,token=None:sent.append((email,purpose,token)))
    config={'host':'smtp.example.com','sender':'noreply@example.com','username':'sender','password':'smtp-private-authorization','public_url':'https://self.example.com','verification_required':True}
    result=c.put('/api/admin/mail',headers=admin,json=config)
    assert result.status_code==200 and result.json()['has_password']
    assert 'smtp-private-authorization' not in result.text
    with sqlite3.connect(app.state.database) as conn:
        assert 'smtp-private-authorization' not in conn.execute("SELECT value FROM site_settings WHERE key='smtp'").fetchone()[0]
    body={'username':'Student@example.com','password':'student-password-123'}
    assert c.post('/api/auth/register',json={**body,'username':'not-an-email'}).status_code==422
    assert c.post('/api/auth/register',json=body).json()['verification_required']
    assert c.post('/api/auth/login',json=body).status_code==401
    token=sent[-1][2]
    assert c.post('/api/auth/mail/confirm',json={'token':token}).status_code==200
    assert c.post('/api/auth/mail/confirm',json={'token':token}).status_code==400
    login=c.post('/api/auth/login',json=body).json()
    user={'Authorization':'Bearer '+login['token']}
    assert c.put('/api/account/profile',headers=user,json={'nickname':'晚风'}).json()['nickname']=='晚风'
    assert c.get('/api/admin/mail',headers=user).status_code==403
    known=c.post('/api/auth/forgot-password',json={'email':body['username']})
    reset=sent[-1][2]
    unknown=c.post('/api/auth/forgot-password',json={'email':'absent@example.com'})
    assert known.json()==unknown.json()
    assert c.post('/api/auth/mail/confirm',json={'token':reset,'password':'replacement-password-123'}).status_code==200
    assert c.get('/api/auth/me',headers=user).status_code==401
    assert c.post('/api/auth/login',json={**body,'password':'replacement-password-123'}).status_code==200
    assert c.post('/api/auth/mail/confirm',json={'token':reset,'password':'another-password-123'}).status_code==400


def test_binding_password_change_and_invite_verification(tmp_path,monkeypatch):
    app,c,admin=bootstrap(tmp_path,monkeypatch)
    sent=[];monkeypatch.setattr(Mailer,'send',lambda self,email,purpose,token=None:sent.append((email,purpose,token)))
    c.put('/api/admin/mail',headers=admin,json={'host':'smtp.example.com','sender':'noreply@example.com','verification_required':True,'public_url':'https://self.example.com'})
    c.put('/api/admin/registration',headers=admin,json={'mode':'invite'})
    invite=c.post('/api/admin/invitations',headers=admin,json={}).json()['code']
    assert c.post('/api/auth/register',json={'username':'new@example.com','password':'example-password-123','invitation_code':invite}).status_code==201
    assert c.get('/api/admin/invitations',headers=admin).json()[0]['uses']==0
    c.post('/api/auth/mail/confirm',json={'token':sent[-1][2]})
    assert c.get('/api/admin/invitations',headers=admin).json()[0]['uses']==1
    assert c.post('/api/account/email',headers=admin,json={'email':'admin@example.com'}).status_code==200
    assert c.post('/api/auth/mail/confirm',json={'token':sent[-1][2]}).status_code==200
    assert c.post('/api/auth/login',json={'username':'admin@example.com','password':'admin-test-password'}).status_code==200
    assert c.post('/api/account/password',headers=admin,json={'current_password':'wrong','new_password':'replacement-password'}).status_code==403
    assert c.post('/api/account/password',headers=admin,json={'current_password':'admin-test-password','new_password':'replacement-password'}).status_code==200
    assert c.get('/api/auth/me',headers=admin).status_code==401


def test_workspace_roundtrip_files_isolation_and_atomic_failure(tmp_path,monkeypatch):
    app,c,source=bootstrap(tmp_path,monkeypatch)
    task=c.post('/api/tasks',headers=source,json={'title':'需要保留的待办','description':'包含附件'}).json()
    c.post('/api/tasks/'+task['id']+'/files?version=1&kind=receipt',headers=source,files={'file':('receipt.txt',b'proof')})
    c.post('/api/shelf',headers=source,files={'file':('note.txt',b'notes')})
    payload=c.get('/api/workspace/export',headers=source).content
    assert c.get('/api/workspace/export').status_code==401
    assert c.post('/api/auth/register',json={'username':'other@example.com','password':'example-password-123'}).status_code==201
    login=c.post('/api/auth/login',json={'username':'other@example.com','password':'example-password-123'}).json()
    target={'Authorization':'Bearer '+login['token']}
    assert c.get('/api/snapshot',headers=target).json()['tasks']==[]
    first=c.post('/api/workspace/import',headers=target,files={'file':('workspace.zip',payload)})
    assert first.status_code==200,first.text
    assert first.json()['imported']['tasks']==1 and first.json()['imported']['files']==2
    second=c.post('/api/workspace/import',headers=target,files={'file':('workspace.zip',payload)}).json()
    assert second['imported']['tasks']==0 and second['imported']['files']==0
    snapshot=c.get('/api/snapshot',headers=target).json()
    assert len(snapshot['tasks'])==1 and snapshot['tasks'][0]['id']!=task['id']
    receipt=snapshot['tasks'][0]['attachments'][0]
    assert receipt['kind']=='receipt' and c.get('/api/files/'+receipt['id'],headers=target).content==b'proof'
    assert c.get('/api/files/'+receipt['id'],headers=source).status_code==404
    # Broken archives neither add partial rows nor leave attachment files behind.
    output=io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(payload)) as original,zipfile.ZipFile(output,'w') as altered:
        manifest=json.loads(original.read('manifest.json'));manifest['workspace_id']='corrupted-copy'
        altered.writestr('manifest.json',json.dumps(manifest))
        for item in manifest['files']:altered.writestr('files/'+item['id'],b'bad')
    before=set((tmp_path/'files').iterdir())
    assert c.post('/api/workspace/import',headers=target,files={'file':('bad.zip',output.getvalue())}).status_code==400
    assert set((tmp_path/'files').iterdir())==before
    assert len(c.get('/api/snapshot',headers=target).json()['tasks'])==1


def test_cache_import_preserves_unsynced_local_task(tmp_path,monkeypatch):
    app,c,admin=bootstrap(tmp_path,monkeypatch)
    body={'origin':'offline-test-origin','tasks':[{'id':'local:pending-task','title':'未同步本机草稿','description':'保留说明'}],'messages':[]}
    first=c.post('/api/workspace/import-cache',headers=admin,json=body)
    assert first.status_code==200,first.text
    assert c.post('/api/workspace/import-cache',headers=admin,json=body).json()['imported']['tasks']==0
    assert c.get('/api/snapshot',headers=admin).json()['tasks'][0]['title']=='未同步本机草稿'


def test_styled_mail_tls_and_expired_token(tmp_path,monkeypatch):
    app,c,admin=bootstrap(tmp_path,monkeypatch)
    sent=[]
    class SMTP:
        def __init__(self,*args,**kwargs): pass
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def login(self,*args): pass
        def send_message(self,message): sent.append(message)
    monkeypatch.setattr('server.mail.smtplib.SMTP_SSL',SMTP)
    c.put('/api/admin/mail',headers=admin,json={'host':'smtp.example.com','sender':'noreply@example.com','public_url':'https://own.example.com','verification_required':True})
    assert c.post('/api/admin/mail/test',headers=admin,json={'email':'test@example.com'}).status_code==200
    html=sent[0].get_body(preferencelist=('html',)).get_content()
    assert 'JIAOJIANBOX' in html and 'border-radius' in html
    assert sent[0].get_body(preferencelist=('plain',)) is not None
    assert c.post('/api/auth/register',json={'username':'expired@example.com','password':'fixture-long-password'}).status_code==201
    import re
    token=re.search(r'token=([A-Za-z0-9_-]+)',sent[-1].get_body(preferencelist=('plain',)).get_content()).group(1)
    with sqlite3.connect(app.state.database) as conn: conn.execute('UPDATE mail_tokens SET expires=0')
    assert c.post('/api/auth/mail/confirm',json={'token':token}).status_code==400
    assert c.post('/api/auth/login',json={'username':'expired@example.com','password':'fixture-long-password'}).status_code==401
