import io
import json

import pytest

from collector.agent import ConfigInputError, read_config


@pytest.mark.parametrize('encoding', ['gbk', 'cp1252', 'utf-8'])
def test_utf8_parent_config_ignores_child_locale(encoding):
    config = {'conversation_names': {'private:1': '中文群聊：交件箱 😀'},
              'wechat_db_dir': 'D:/微信备份/消息', 'server_token': 'private-fixture'}
    raw = (json.dumps(config, ensure_ascii=False) + '\n').encode('utf-8')
    stream = io.TextIOWrapper(io.BytesIO(raw), encoding=encoding)
    assert read_config(stream) == config


def test_utf8_bom_is_accepted():
    assert read_config(io.BytesIO(b'\xef\xbb\xbf{"user_id":"fixture"}\n')) == {'user_id': 'fixture'}


@pytest.mark.parametrize(('raw', 'reason'), [
    (b'', 'empty-input'), (b'{"server_token":"secret-fixture",}', 'invalid-json'),
    (b'[]', 'not-an-object'), (b'\xff', 'invalid-utf8'),
])
def test_invalid_input_reports_metadata_without_config_content(raw, reason):
    with pytest.raises(ConfigInputError) as error:
        read_config(io.BytesIO(raw))
    assert error.value.metadata['reason'] == reason
    assert error.value.metadata['input_length'] == len(raw)
    assert 'secret-fixture' not in json.dumps(error.value.metadata)
