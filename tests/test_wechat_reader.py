import json
import os
import sys
import types
from pathlib import Path
import pytest
from collector import wechat_reader


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows msvcrt cache lock')
def test_cache_isolation_from_original_exporter(tmp_path,monkeypatch):
    class Reader:
        def _pick_account(self):return 'fixture-account'
        def __init__(self,**kw):self.options=kw
    package=types.ModuleType('wechatauto');package.__path__=[]
    db=types.ModuleType('wechatauto.db');db.WeChatDB=Reader;db.auto_detect_db_dir=lambda:str(tmp_path/'source')
    monkeypatch.setitem(sys.modules,'wechatauto',package);monkeypatch.setitem(sys.modules,'wechatauto.db',db)
    monkeypatch.setattr(wechat_reader.tempfile,'gettempdir',lambda:str(tmp_path))
    shared=tmp_path/'wechatauto_db'/'fixture-account';shared.mkdir(parents=True)
    (shared/'keys.json').write_bytes(b'dpapi1:fixture');(shared/'message.db').write_bytes(b'original-export-cache')
    config={'_wechat_cache_root':str(tmp_path/'private')}
    live=wechat_reader.open_database(config);listing=wechat_reader.open_database({**config,'_wechat_purpose':'list'})
    assert live.options['workdir']!=listing.options['workdir']
    assert Path(live.options['workdir']).parent==tmp_path/'private'
    assert Path(live.options['keys_file']).read_bytes()==b'dpapi1:fixture'
    assert (shared/'message.db').read_bytes()==b'original-export-cache'
    live.account='other-account';live.workdir=str(shared);live.keys_file=str(shared/'keys.json')
    assert Path(live.workdir).is_relative_to(tmp_path/'private')
    assert Path(live.keys_file).is_relative_to(tmp_path/'private')
    live.close();listing.close()
    again=wechat_reader.open_database(config)
    assert again.options["workdir"]==live.options["workdir"]
    again.close()


def test_local_wechat_permission_diagnostic_has_no_payload(tmp_path):
    error=PermissionError(13,'sensitive exception text must not be logged',str(tmp_path/'message.db'));error.winerror=32
    entry=wechat_reader.record_error({'_wechat_cache_root':str(tmp_path/'wechat-cache')},error,'poll-messages')
    text=(tmp_path/'wechat-diagnostics.jsonl').read_text(encoding='utf-8')
    assert entry['winerror']==32 and entry['stage']=='poll-messages'
    assert 'sensitive exception text' not in text
    assert json.loads(text)['type']=='PermissionError'
