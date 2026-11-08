import sqlite3
import time

from fastapi.testclient import TestClient
from server.app import create_app


def setup_admin(tmp_path, monkeypatch):
    monkeypatch.setenv('JJB_BOOTSTRAP_ADMIN_USERNAME', 'zzy')
    monkeypatch.setenv('JJB_BOOTSTRAP_ADMIN_PASSWORD', 'admin-test-password')
    app = create_app(tmp_path)
    client = TestClient(app)
    result = client.post('/api/auth/login', json={'username': 'zzy', 'password': 'admin-test-password'})
    assert result.status_code == 200
    return client, {'Authorization': 'Bearer ' + result.json()['token']}, app


def test_registration_modes_and_permissions(tmp_path, monkeypatch):
    client, admin, app = setup_admin(tmp_path, monkeypatch)
    assert client.get('/api/auth/me', headers=admin).json()['is_admin']
    body = {'username': 'student', 'password': 'student-test-password'}
    assert client.post('/api/auth/register', json=body).status_code == 201
    token = client.post('/api/auth/login', json=body).json()['token']
    normal = {'Authorization': 'Bearer ' + token}
    assert not client.get('/api/auth/me', headers=normal).json()['is_admin']
    for method, route, data in [('GET', 'registration', None), ('PUT', 'registration', {'mode': 'public'}), ('GET', 'users', None), ('GET', 'invitations', None), ('POST', 'invitations', {}), ('DELETE', 'invitations/missing', None)]:
        assert client.request(method, '/api/admin/' + route, headers=normal, json=data).status_code == 403
    assert client.get('/api/admin/users').status_code == 401
    assert client.put('/api/admin/registration', headers=admin, json={'mode': 'closed'}).status_code == 200
    assert client.get('/api/auth/registration').json()['mode'] == 'closed'
    assert client.post('/api/auth/register', json={**body, 'username': 'second'}).status_code == 403
    assert client.put('/api/admin/registration', headers=admin, json={'mode': 'invalid'}).status_code == 422
    # Persisted policy and role survive recreation. Bootstrap never resets a password.
    monkeypatch.setenv('JJB_BOOTSTRAP_ADMIN_PASSWORD', 'different-password')
    again = TestClient(create_app(tmp_path))
    assert again.get('/api/auth/registration').json()['mode'] == 'closed'
    assert again.post('/api/auth/login', json={'username': 'zzy', 'password': 'admin-test-password'}).status_code == 200


def test_invitation_consumption_rollback_and_revocation(tmp_path, monkeypatch):
    client, admin, app = setup_admin(tmp_path, monkeypatch)
    client.put('/api/admin/registration', headers=admin, json={'mode': 'invite'})
    invite = client.post('/api/admin/invitations', headers=admin, json={'max_uses': 1, 'expires_days': 1}).json()
    body = {'username': 'student', 'password': 'student-test-password', 'invitation_code': invite['code']}
    assert client.post('/api/auth/register', json={**body, 'invitation_code': 'wrong'}).status_code == 403
    assert client.post('/api/auth/register', json={**body, 'username': 'zzy'}).status_code == 409
    assert client.get('/api/admin/invitations', headers=admin).json()[0]['uses'] == 0
    assert client.post('/api/auth/register', json=body).status_code == 201
    assert client.post('/api/auth/register', json={**body, 'username': 'another'}).status_code == 403
    second = client.post('/api/admin/invitations', headers=admin, json={}).json()
    assert client.delete('/api/admin/invitations/' + second['id'], headers=admin).status_code == 200
    assert client.post('/api/auth/register', json={**body, 'username': 'third', 'invitation_code': second['code']}).status_code == 403
    third = client.post('/api/admin/invitations', headers=admin, json={}).json()
    with sqlite3.connect(app.state.database) as conn:
        conn.execute('UPDATE invitations SET expires=? WHERE id=?', (time.time()-1, third['id']))
        assert third['code'] not in str(conn.execute('SELECT * FROM invitations').fetchall())
    assert client.post('/api/auth/register', json={**body, 'username': 'fourth', 'invitation_code': third['code']}).status_code == 403


def test_invitation_last_use_is_atomic(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    client, admin, app = setup_admin(tmp_path, monkeypatch)
    client.put('/api/admin/registration', headers=admin, json={'mode': 'invite'})
    code = client.post('/api/admin/invitations', headers=admin, json={}).json()['code']
    def register(number):
        with TestClient(app) as other:
            return other.post('/api/auth/register', json={'username': f'student{number}', 'password': 'student-test-password', 'invitation_code': code}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(register, [1, 2])) == [201, 403]
