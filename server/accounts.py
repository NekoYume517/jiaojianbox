"""Server-wide registration policy and repository-independent administrator roles."""
import hashlib
import os
import secrets
import sqlite3
import time
import uuid
from typing import Literal

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field


class RegistrationPolicy(BaseModel):
    mode: Literal['closed', 'public', 'invite']


class InvitationInput(BaseModel):
    label: str = Field(default='', max_length=100)
    max_uses: int = Field(default=1, ge=1, le=1000)
    expires_days: int = Field(default=7, ge=1, le=365)


class Accounts:
    def __init__(self, db):
        self.db = db
        with db() as conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS user_roles(user_id TEXT PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS site_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL,
                    prefix TEXT, label TEXT, max_uses INTEGER, uses INTEGER DEFAULT 0,
                    expires REAL, revoked INTEGER DEFAULT 0, created_by TEXT REFERENCES users(id));
            ''')
        username = os.environ.get('JJB_BOOTSTRAP_ADMIN_USERNAME', '').strip()
        password = os.environ.get('JJB_BOOTSTRAP_ADMIN_PASSWORD', '')
        if username:
            with db(True) as conn:
                row = conn.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone()
                if not row and password:
                    if len(password) < 10:
                        raise ValueError('Bootstrap administrator password must have at least 10 characters')
                    salt = secrets.token_hex(16)
                    uid = str(uuid.uuid4())
                    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 310000).hex()
                    conn.execute('INSERT INTO users VALUES(?,?,?,?)', (uid, username, salt, digest))
                    row = (uid,)
                if row:
                    conn.execute("INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')", (row[0],))

    def mode(self, conn):
        row = conn.execute("SELECT value FROM site_settings WHERE key='registration_mode'").fetchone()
        return row[0] if row else ('public' if os.environ.get('JJB_ALLOW_REGISTRATION', 'true').lower() == 'true' else 'closed')

    def is_admin(self, conn, user):
        return conn.execute("SELECT 1 FROM user_roles WHERE user_id=? AND role='superadmin'", (user,)).fetchone() is not None

    def register(self, conn, body):
        mode = self.mode(conn)
        if mode == 'closed':
            raise HTTPException(403, '注册已关闭')
        if mode == 'invite':
            digest = hashlib.sha256(body.invitation_code.strip().upper().encode()).hexdigest()
            result = conn.execute('UPDATE invitations SET uses=uses+1 WHERE code_hash=? AND revoked=0 AND expires>? AND uses<max_uses', (digest, time.time()))
            if result.rowcount != 1:
                raise HTTPException(403, '邀请码无效、已用完或已过期')
        salt = secrets.token_hex(16)
        digest = hashlib.pbkdf2_hmac('sha256', body.password.encode(), bytes.fromhex(salt), 310000).hex()
        try:
            conn.execute('INSERT INTO users VALUES(?,?,?,?)', (str(uuid.uuid4()), body.username, salt, digest))
        except sqlite3.IntegrityError:
            raise HTTPException(409, '用户名已存在')

    def install(self, app, owner):
        def administrator(user=Depends(owner)):
            with self.db() as conn:
                if not self.is_admin(conn, user):
                    raise HTTPException(403, '仅超级管理员可操作')
            return user

        @app.get('/api/auth/registration')
        def registration():
            with self.db() as conn:
                return {'mode': self.mode(conn)}

        @app.get('/api/auth/me')
        def me(user=Depends(owner)):
            with self.db() as conn:
                row = conn.execute('SELECT username FROM users WHERE id=?', (user,)).fetchone()
                return {'user_id': user, 'username': row[0], 'is_admin': self.is_admin(conn, user)}

        @app.get('/api/admin/registration')
        def get_policy(user=Depends(administrator)):
            return registration()

        @app.put('/api/admin/registration')
        def set_policy(body: RegistrationPolicy, user=Depends(administrator)):
            with self.db(True) as conn:
                conn.execute("INSERT OR REPLACE INTO site_settings VALUES('registration_mode',?)", (body.mode,))
            return body.model_dump()

        @app.get('/api/admin/users')
        def users(user=Depends(administrator)):
            with self.db() as conn:
                return [dict(row) for row in conn.execute("SELECT u.id,u.username,COALESCE(r.role,'user') AS role FROM users u LEFT JOIN user_roles r ON r.user_id=u.id ORDER BY u.rowid")]

        @app.get('/api/admin/invitations')
        def invitations(user=Depends(administrator)):
            with self.db() as conn:
                return [dict(row) for row in conn.execute('SELECT id,prefix,label,max_uses,uses,expires,revoked FROM invitations ORDER BY rowid DESC LIMIT 200')]

        @app.post('/api/admin/invitations', status_code=201)
        def create_invitation(body: InvitationInput, user=Depends(administrator)):
            code = secrets.token_hex(16).upper()
            uid = str(uuid.uuid4())
            expires = time.time() + body.expires_days * 86400
            with self.db(True) as conn:
                conn.execute('INSERT INTO invitations(id,code_hash,prefix,label,max_uses,expires,created_by) VALUES(?,?,?,?,?,?,?)', (uid, hashlib.sha256(code.encode()).hexdigest(), code[:6], body.label, body.max_uses, expires, user))
            return {'id': uid, 'code': code, 'expires': expires, 'max_uses': body.max_uses}

        @app.delete('/api/admin/invitations/{invitation_id}')
        def revoke_invitation(invitation_id: str, user=Depends(administrator)):
            with self.db(True) as conn:
                result = conn.execute('UPDATE invitations SET revoked=1 WHERE id=?', (invitation_id,))
                if result.rowcount != 1:
                    raise HTTPException(404, '邀请码不存在')
            return {'revoked': True}
