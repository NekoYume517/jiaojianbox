"""模型格式容错与自动分析状态的端到端回归。"""
import asyncio
import json
import sqlite3
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from server.app import TaskInput, create_app
from server.llm import LlmFailure, _lenient, analyze, robust_json, suggest_file
from test_server import auth, message


CONFIG = {'base_url': 'https://fixture.test/v1', 'model': 'fixture'}


def response(value, **extra):
    return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(value, ensure_ascii=False)}}], **extra})


def wait_for(operation, predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = operation()
        if predicate(result): return result
        time.sleep(.03)
    raise AssertionError(f'状态未到达预期: {result}')


def test_lenient_analysis_remains_valid_for_task_creation():
    raw = {'result': {'classification': ' Task ', 'confidence': '95%', 'title': '报告',
        'reason': None, 'urgency': 'URGENT', 'due_at': '2026-11-20T18:00:00',
        'reminder_suggestions': ['invalid', '2026-11-20T09:00:00'] * 4,
        'requirements': [{'label': '报告' * 100, 'extensions': '*.PDF，.zip,invalid_extension', 'min_count': '99'}, '源码', None],
        'max_total_bytes': '-1', 'submit_url': '待定', 'evidence': ['原文'] * 9, 'notes': '请确认', 'duplicate': 'false'}}
    result = asyncio.run(analyze(CONFIG, [], [], '', httpx.MockTransport(lambda _: response(raw))))
    assert result['classification'] == 'actionable' and result['confidence'] == .95
    assert result['due_at'].endswith('+08:00')
    assert result['requirements'][0]['extensions'] == ['pdf', 'zip']
    assert result['requirements'][0]['min_count'] == 50
    assert len(result['evidence']) == 6 and result['notes'] == ['请确认']
    assert not result['duplicate'] and result['max_total_bytes'] is None
    task = TaskInput.model_validate({**result, 'reminders': result['reminder_suggestions']})
    assert len(task.reminders) == 1 and task.submit_url == ''


@pytest.mark.parametrize('raw', [{}, {'error': 'upstream failed'}, {'classification': 'unknown', 'title': '不能猜测为待办'}])
def test_malformed_semantics_are_not_silently_classified(raw):
    with pytest.raises(LlmFailure):
        asyncio.run(analyze(CONFIG, [], [], '', httpx.MockTransport(lambda _: response(raw))))


@pytest.mark.parametrize(('value', 'expected'), [('1%', .01), ('90％', .9), ('NaN', .5), ('Infinity', .5), (85, .85)])
def test_confidence_is_finite_and_percentages_are_correct(value, expected):
    assert _lenient({'classification': 'CHAT', 'confidence': value})['confidence'] == expected


def test_trailing_comma_repair_preserves_text_and_rejects_truncation():
    assert robust_json('结果：```json\n{"classification":"chatting","reason":"正文 ,} 不得改变","notes":["a",],}\n```')['reason'] == '正文 ,} 不得改变'
    with pytest.raises(ValueError): robust_json('{"classification":"actionable"')


@pytest.mark.parametrize('streamed', [False, True])
def test_tool_roundtrip_and_provider_fallback_preserve_executor_and_usage(streamed):
    calls = []; executed = []
    def upstream(request):
        body = json.loads(request.content); calls.append(body)
        if 'stream_options' in body:
            return httpx.Response(400, json={'error': 'stream_options unsupported'})
        if 'response_format' in body:
            return httpx.Response(400, json={'error': 'response_format unsupported'})
        if not any(m['role'] == 'tool' for m in body['messages']):
            if streamed:
                packet = {'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'call1', 'function': {'name': 'get_now', 'arguments': '{}'}}]}, 'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 4, 'completion_tokens': 1}}
                return httpx.Response(200, headers={'content-type': 'text/event-stream'}, text='data: ' + json.dumps(packet) + '\n\ndata: [DONE]\n\n')
            return httpx.Response(200, json={'choices': [{'message': {'content': None, 'tool_calls': [{'id': 'call1', 'function': {'name': 'get_now', 'arguments': '{}'}}]}}], 'usage': {'prompt_tokens': 4, 'completion_tokens': 1}})
        assert json.loads(body['messages'][-1]['content']) == {'now': 'fixture'}
        return response({'classification': 'CHAT', 'confidence': .9}, usage={'prompt_tokens': 8, 'completion_tokens': 2})
    def execute(name, args):
        executed.append(name); return {'now': 'fixture'}
    result = asyncio.run(analyze(CONFIG, [], [], '', httpx.MockTransport(upstream), tool_executor=execute))
    assert executed == ['get_now'] and result['classification'] == 'chatting'
    assert result['performance']['total_tokens'] == 15
    assert all('tools' in body for body in calls)


def test_provider_without_tool_support_can_still_analyze():
    def upstream(request):
        if 'tools' in json.loads(request.content):
            return httpx.Response(400, json={'error': 'tools are not supported'})
        return response({'classification': '普通聊天', 'confidence': .8})
    assert asyncio.run(analyze(CONFIG, [], [], '', httpx.MockTransport(upstream)))['classification'] == 'chatting'


def test_file_suggestion_does_not_assign_unknown_task(monkeypatch):
    async def fake(*args, **kwargs):
        return json.dumps({'result': {'task_id': 'missing', 'category': '材料', 'confidence': '99%', 'reason': None}}), {}
    monkeypatch.setattr('server.llm._chat', fake)
    result = asyncio.run(suggest_file(CONFIG, '', {}, '', [{'id': 'real'}]))
    assert result['task_id'] is None and result['category'] == 'other' and result['confidence'] <= .5


def test_auto_analysis_status_is_immediate_and_clears_on_completion(tmp_path, monkeypatch):
    started = threading.Event(); release = threading.Event()
    async def fake(*args, **kwargs):
        started.set()
        while not release.is_set(): await asyncio.sleep(.01)
        return _lenient({'classification': 'chatting', 'confidence': .9})
    monkeypatch.setattr('server.app.analyze', fake)
    with TestClient(create_app(tmp_path)) as client:
        owner, _ = auth(client)
        client.put('/api/settings/llm', headers=owner, json={**CONFIG, 'auto_analyze': True, 'include_keywords': '提交', 'exclude_keywords': '忽略'})
        try:
            eligible = client.post('/api/messages', headers=owner, json=message()).json()
            assert eligible['analysis_pending'] and eligible['analysis_state'] == 'queued'
            assert started.wait(3)
            rows = client.get('/api/snapshot', headers=owner).json()['messages']
            assert rows[0]['analysis_pending'] and rows[0]['analysis_state'] == 'running'
            assert client.post('/api/messages', headers=owner, json=message()).json()['analysis_state'] == 'running'
            filtered = client.post('/api/messages', headers=owner, json=message(external_id='excluded', text='忽略提交')).json()
            assert not filtered.get('analysis_pending')
            ignored = client.post('/api/messages', headers=owner, json=message(external_id='ignore', text='请提交另一份报告')).json()
            client.put(f"/api/messages/{ignored['id']}/triage", headers=owner, json={'state': 'ignored'})
            rows = client.get('/api/messages', headers=owner).json()
            assert not next(m for m in rows if m['id'] == ignored['id']).get('analysis_pending')
        finally:
            release.set()
        rows = wait_for(lambda: client.get('/api/messages', headers=owner).json(), lambda rows: any(m.get('analysis') for m in rows))
        result = next(m for m in rows if m['id'] == eligible['id'])
        assert not result.get('analysis_pending') and result['analysis_state'] == 'done'


def test_auto_retry_failure_and_restart_use_queue_as_status_source(tmp_path, monkeypatch):
    async def fake(*args, **kwargs): raise ValueError('fixture failure')
    monkeypatch.setattr('server.app.analyze', fake)
    app = create_app(tmp_path)
    def attempt_count():
        with sqlite3.connect(app.state.database) as conn:
            return conn.execute('SELECT attempts FROM analysis_jobs').fetchone()[0]
    with TestClient(app) as client:
        owner, _ = auth(client)
        client.put('/api/settings/llm', headers=owner, json={**CONFIG, 'auto_analyze': True})
        target = client.post('/api/messages', headers=owner, json=message()).json()
        for attempt in range(3):
            expected = 'failed' if attempt == 2 else 'retrying'
            result = wait_for(lambda: client.get('/api/messages', headers=owner).json()[0], lambda m: m.get('analysis_state') == expected)
            assert bool(result.get('analysis_pending')) == (attempt < 2)
            if attempt < 2:
                with sqlite3.connect(app.state.database) as conn:
                    conn.execute('UPDATE analysis_jobs SET next_at=0')
                wait_for(attempt_count, lambda n: n >= attempt + 2)
        # 模拟旧版没有 payload 标志的消息与中途退出的工作进程。
        with sqlite3.connect(app.state.database) as conn:
            conn.execute("UPDATE analysis_jobs SET state='running',next_at=?,attempts=0,error=''", (time.time() + 1000,))
            conn.execute("UPDATE messages SET payload=json_remove(payload,'$.analysis_pending','$.analysis_state','$.analysis_error') WHERE id=?", (target['id'],))
    with TestClient(create_app(tmp_path)) as client:
        result = client.get('/api/snapshot', headers=owner).json()['messages'][0]
        assert result['analysis_pending'] and result['analysis_state'] == 'queued'
