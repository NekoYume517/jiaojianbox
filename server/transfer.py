"""Portable workspace copies. Accounts, sessions and site administration never migrate."""
import hashlib
import io
import json
import os
import tempfile
import uuid
import zipfile
from pathlib import Path

from fastapi import Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


class CachedWorkspace(BaseModel):
    origin: str = Field(max_length=1000)
    tasks: list[dict] = Field(default_factory=list,max_length=10000)
    messages: list[dict] = Field(default_factory=list,max_length=100000)


def install_transfer(app, db, owner, blobs, event, now, cipher):
    with db() as conn:
        conn.executescript('CREATE TABLE IF NOT EXISTS imported_entities(user_id TEXT,origin TEXT,local_id TEXT,PRIMARY KEY(user_id,origin));')
    identity_path = blobs.parent / 'workspace.id'
    try:
        with identity_path.open('x') as f: f.write(str(uuid.uuid4()))
    except FileExistsError: pass
    workspace = identity_path.read_text().strip()
    limit = int(os.environ.get('JJB_TRANSFER_MAX_MB', '512')) * 1024**2

    @app.get('/api/workspace/export')
    def export_workspace(user=Depends(owner)):
        stream = tempfile.SpooledTemporaryFile(max_size=8*1024**2)
        try:
            with db() as conn:
                conn.execute('BEGIN')
                manifest = {'format': 'jiaojianbox-workspace', 'version': 1, 'workspace_id': workspace + ':' + user,
                    'tasks': [json.loads(r[0]) for r in conn.execute('SELECT payload FROM tasks WHERE user_id=?',(user,))],
                    'messages': [json.loads(r[0]) for r in conn.execute('SELECT payload FROM messages WHERE user_id=?',(user,))],
                    'files': [dict(r) for r in conn.execute('SELECT id,task_id,name,size,sha256,kind FROM attachments WHERE user_id=?',(user,))],
                    'shelf': [dict(r) for r in conn.execute('SELECT file_id,category,suggestion,created_at FROM shelf_meta WHERE user_id=?',(user,))]}
                # API keys stay at the source. Model configuration is portable.
                row = conn.execute('SELECT payload FROM llm_settings WHERE user_id=?',(user,)).fetchone()
                if row: manifest['llm_settings'] = json.loads(row[0])
                with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as z:
                    z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False))
                    for item in manifest['files']:
                        path = blobs/item['id']
                        if not path.is_file(): raise HTTPException(409,'有附件暂时不可用，请重试或先检查附件')
                        z.write(path,'files/'+item['id'])
            stream.seek(0)
            def chunks():
                try:
                    while data := stream.read(256*1024): yield data
                finally: stream.close()
            return StreamingResponse(chunks(),media_type='application/zip',headers={'Content-Disposition':'attachment; filename="jiaojianbox-workspace.zip"'})
        except BaseException:
            stream.close()
            raise

    @app.post('/api/workspace/import')
    async def import_workspace(file: UploadFile=File(), user=Depends(owner)):
        incoming = tempfile.SpooledTemporaryFile(max_size=8*1024**2)
        created = []
        try:
            total=0
            while data := await file.read(256*1024):
                total+=len(data)
                if total>limit: raise HTTPException(413,'迁移包超过大小上限')
                incoming.write(data)
            incoming.seek(0)
            with zipfile.ZipFile(incoming) as z:
                infos=z.infolist()
                if len(infos)>20000 or sum(i.file_size for i in infos)>limit*2 or z.getinfo('manifest.json').file_size>20*1024**2:
                    raise HTTPException(413,'迁移包解压后过大')
                if len({i.filename for i in infos})!=len(infos): raise ValueError('duplicate entries')
                manifest=json.loads(z.read('manifest.json'))
                if manifest.get('format')!='jiaojianbox-workspace' or manifest.get('version')!=1: raise ValueError('format')
                source=str(manifest['workspace_id'])
                if len(source)>200: raise ValueError('identity')
                tasks=manifest.get('tasks',[]); messages=manifest.get('messages',[]); files=manifest.get('files',[])
                if len(tasks)>10000 or len(messages)>100000 or len(files)>10000: raise ValueError('count')
                for entries in [tasks,messages,files]:
                    ids=[str(uuid.UUID(item['id'])) for item in entries]
                    if len(set(ids))!=len(ids): raise ValueError('duplicate ids')
                shelf={r['file_id']:r for r in manifest.get('shelf',[])}
                counts={'tasks':0,'messages':0,'files':0,'skipped':0}
                with db(True) as conn:
                    mappings={}
                    def mapped(kind, original):
                        origin=source+':'+kind+':'+original
                        row=conn.execute('SELECT local_id FROM imported_entities WHERE user_id=? AND origin=?',(user,origin)).fetchone()
                        if row:
                            table={'tasks':'tasks','messages':'messages','files':'attachments'}[kind]
                            if conn.execute(f'SELECT 1 FROM {table} WHERE id=? AND user_id=?',(row[0],user)).fetchone(): return row[0],False
                            conn.execute('DELETE FROM imported_entities WHERE user_id=? AND origin=?',(user,origin))
                        local=str(uuid.uuid4())
                        conn.execute('INSERT INTO imported_entities VALUES(?,?,?)',(user,origin,local))
                        return local,True
                    # Allocate both maps first to preserve task -> source-message links.
                    for kind, entries in [('tasks',tasks),('messages',messages)]:
                        for item in entries: mappings[(kind,item['id'])]=mapped(kind,item['id'])
                    for original in tasks:
                        uid,fresh=mappings[('tasks',original['id'])]
                        if not fresh: counts['skipped']+=1; continue
                        from .app import TaskInput
                        value=TaskInput(**original).model_dump();value.update(id=uid,version=1,client_id=None)
                        value.pop('attachments',None);value.pop('pending',None);value.pop('conflict',None)
                        source_message=value.get('source_message_id')
                        value['source_message_id']=mappings.get(('messages',source_message),(None,False))[0]
                        value['updated_at']=now()
                        if not isinstance(value.get('title'),str) or len(value['title'])>200: raise ValueError('task')
                        conn.execute('INSERT INTO tasks VALUES(?,?,?,?,?)',(uid,user,1,None,json.dumps(value,ensure_ascii=False)))
                        event(conn,user,'task.upsert',uid);counts['tasks']+=1
                    for original in messages:
                        uid,fresh=mappings[('messages',original['id'])]
                        if not fresh: counts['skipped']+=1; continue
                        value=dict(original);value['id']=uid
                        conn.execute('INSERT INTO messages VALUES(?,?,?,?,?)',(uid,user,'import:'+source+':'+original['id'],json.dumps(value,ensure_ascii=False),now()))
                        event(conn,user,'message.upsert',uid);counts['messages']+=1
                    for item in files:
                        uid,fresh=mapped('files',item['id'])
                        if not fresh: counts['skipped']+=1; continue
                        info=z.getinfo('files/'+item['id'])
                        if info.file_size!=item['size'] or info.file_size>50*1024**2: raise ValueError('file size')
                        path=blobs/uid;created.append(path);digest=hashlib.sha256()
                        with z.open(info) as src,path.open('xb') as dst:
                            while data:=src.read(256*1024): digest.update(data);dst.write(data)
                        if digest.hexdigest()!=item['sha256']: raise ValueError('file checksum')
                        task=mappings.get(('tasks',item.get('task_id')),(None,False))[0]
                        name=Path(str(item['name']).replace('\\','/')).name[:180] or '导入文件'
                        kind='receipt' if item.get('kind')=='receipt' else 'material'
                        conn.execute('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)',(uid,user,task,name,item['size'],digest.hexdigest(),kind))
                        meta=shelf.get(item['id'],{})
                        category=meta.get('category','inbox') if not task else ('receipt' if kind=='receipt' else 'material')
                        if category not in ['inbox','reference','receipt','other','material']: category='inbox'
                        conn.execute('INSERT INTO shelf_meta(file_id,user_id,category,suggestion,created_at) VALUES(?,?,?,?,?)',(uid,user,category,None,now()))
                        event(conn,user,'shelf.upsert',uid);counts['files']+=1
                    if manifest.get('llm_settings') and not conn.execute('SELECT 1 FROM llm_settings WHERE user_id=?',(user,)).fetchone():
                        from .llm import LlmConfig
                        settings=LlmConfig(**manifest['llm_settings']).model_dump(exclude={'api_key'})
                        conn.execute('INSERT INTO llm_settings VALUES(?,?,?)',(user,json.dumps(settings),''))
                created.clear()
                return {'imported':counts,'message':'复制导入完成，来源数据保持不变；重复导入的内容已跳过。'}
        except HTTPException: raise
        except (ValueError,KeyError,TypeError,zipfile.BadZipFile,RuntimeError):
            raise HTTPException(400,'迁移包无效、损坏或版本不兼容') from None
        finally:
            for path in created: path.unlink(missing_ok=True)
            incoming.close();await file.close()

    @app.post('/api/workspace/import-cache')
    async def import_cache(body: CachedWorkspace,user=Depends(owner)):
        def identity(value): return str(uuid.uuid5(uuid.NAMESPACE_URL,body.origin+'|'+str(value)))
        tasks=[];messages=[]
        for original in body.tasks:
            item=dict(original);item['id']=identity(item['id'])
            if item.get('source_message_id'): item['source_message_id']=identity(item['source_message_id'])
            tasks.append(item)
        for original in body.messages:
            item=dict(original);item['id']=identity(item['id']);messages.append(item)
        value={'format':'jiaojianbox-workspace','version':1,'workspace_id':'cache:'+hashlib.sha256(body.origin.encode()).hexdigest(),'tasks':tasks,'messages':messages,'files':[]}
        content=json.dumps(value,ensure_ascii=False).encode()
        if len(content)>20*1024**2: raise HTTPException(413,'本机缓存过大，请分批迁移')
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as z:z.writestr('manifest.json',content)
        stream.seek(0)
        return await import_workspace(UploadFile(file=stream,filename='cache.zip'),user)
