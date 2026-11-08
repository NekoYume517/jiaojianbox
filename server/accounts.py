"""Server-wide registration policy and repository-independent administrator roles."""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import uuid
from typing import Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field
from .mail import Mailer, MailSettings, email_address


class ProfileInput(BaseModel):
    nickname: str = Field(max_length=64)


class PasswordInput(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(min_length=10, max_length=256)


class EmailInput(BaseModel):
    email: str = Field(max_length=254)


class MailToken(BaseModel):
    token: str = Field(min_length=30, max_length=100)
    password: str = Field(default='', max_length=256)


class RegistrationPolicy(BaseModel):
    mode: Literal['closed', 'public', 'invite']


class InvitationInput(BaseModel):
    label: str = Field(default='', max_length=100)
    max_uses: int = Field(default=1, ge=1, le=1000)
    expires_days: int = Field(default=7, ge=1, le=365)


class Accounts:
    def __init__(self, db, cipher):
        self.db = db
        self.mailer = Mailer(db, cipher)
        with db() as conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS user_roles(user_id TEXT PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS site_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id), nickname TEXT DEFAULT '', email TEXT UNIQUE COLLATE NOCASE, verified INTEGER DEFAULT 0);
                CREATE TABLE IF NOT EXISTS mail_tokens(hash TEXT PRIMARY KEY, purpose TEXT, email TEXT, payload TEXT, expires REAL, created REAL);
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

    def check_invite(self, conn, digest, consume=True):
        mode = self.mode(conn)
        if mode == 'closed':
            raise HTTPException(403, '注册已关闭')
        if mode == 'invite':
            row = conn.execute('SELECT id FROM invitations WHERE code_hash=? AND revoked=0 AND expires>? AND uses<max_uses', (digest, time.time())).fetchone()
            if not row:
                raise HTTPException(403, '邀请码无效、已用完或已过期')
            if consume:
                conn.execute('UPDATE invitations SET uses=uses+1 WHERE id=?', (row[0],))

    def profile(self, conn, user):
        row = conn.execute('SELECT u.id AS user_id,u.username,p.nickname,p.email,p.verified FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=?', (user,)).fetchone()
        value = dict(row)
        value['nickname'] = value['nickname'] or value['username']
        value['is_admin'] = self.is_admin(conn, user)
        return value

    def register(self, body):
        username = (body.email or body.username).strip().lower()
        require_email = os.environ.get('JJB_REQUIRE_EMAIL', 'true') != 'false'
        if require_email or '@' in username:
            username = email_address(username)
        invite_hash = hashlib.sha256(body.invitation_code.strip().upper().encode()).hexdigest()
        salt = secrets.token_hex(16)
        digest = hashlib.pbkdf2_hmac('sha256', body.password.encode(), bytes.fromhex(salt), 310000).hex()
        pending = {'username': username, 'salt': salt, 'password': digest, 'invite_hash': invite_hash}
        verify = self.mailer.config()['verification_required']
        with self.db(True) as conn:
            self.check_invite(conn, invite_hash, consume=not verify)
            if conn.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
                raise HTTPException(409, '此账号已存在，请登录或找回密码')
            if not verify:
                self.create_user(conn, pending, verified=False)
        if verify:
            self.send_token('register', username, pending)
            return {'verification_required': True, 'message': '验证邮件已发送，请检查收件箱'}
        return {'registered': True}

    def create_user(self, conn, payload, verified):
        uid = str(uuid.uuid4())
        try:
            conn.execute('INSERT INTO users VALUES(?,?,?,?)', (uid, payload['username'], payload['salt'], payload['password']))
            conn.execute('INSERT INTO profiles(user_id,email,verified) VALUES(?,?,?)', (uid, payload['username'] if '@' in payload['username'] else None, int(verified)))
        except sqlite3.IntegrityError:
            raise HTTPException(409, '此邮箱已注册或绑定其他账号')

    def send_token(self, purpose, email, payload):
        token = secrets.token_urlsafe(40)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.db(True) as conn:
            recent = conn.execute('SELECT 1 FROM mail_tokens WHERE email=? AND purpose=? AND created>?', (email, purpose, time.time()-60)).fetchone()
            if recent:
                raise HTTPException(429, '邮件刚刚发送，请稍后再试')
            conn.execute('DELETE FROM mail_tokens WHERE expires<?', (time.time(),))
            conn.execute('INSERT INTO mail_tokens VALUES(?,?,?,?,?,?)', (digest, purpose, email, json.dumps(payload), time.time()+1800, time.time()))
        try:
            self.mailer.send(email, purpose, token)
        except BaseException:
            with self.db(True) as conn: conn.execute('DELETE FROM mail_tokens WHERE hash=?', (digest,))
            raise

    def install(self, app, owner, limit_auth):
        def administrator(user=Depends(owner)):
            with self.db() as conn:
                if not self.is_admin(conn, user):
                    raise HTTPException(403, '仅超级管理员可操作')
            return user

        @app.get('/api/auth/registration')
        def registration():
            with self.db() as conn:
                c = self.mailer.public()
                return {'mode': self.mode(conn), 'email_registration': os.environ.get('JJB_REQUIRE_EMAIL', 'true') != 'false', 'verification_required': c['verification_required'], 'password_recovery': c['configured']}

        @app.get('/api/auth/me')
        def me(user=Depends(owner)):
            with self.db() as conn:
                return self.profile(conn, user)

        @app.put('/api/account/profile')
        def profile(body: ProfileInput, user=Depends(owner)):
            with self.db(True) as conn:
                conn.execute('INSERT INTO profiles(user_id,nickname) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname', (user, body.nickname.strip()))
                return self.profile(conn, user)

        @app.post('/api/account/password')
        def password(body: PasswordInput, user=Depends(owner)):
            with self.db(True) as conn:
                row = conn.execute('SELECT salt,password FROM users WHERE id=?', (user,)).fetchone()
                current = hashlib.pbkdf2_hmac('sha256', body.current_password.encode(), bytes.fromhex(row['salt']), 310000).hex()
                if not hmac.compare_digest(current, row['password']): raise HTTPException(403, '当前密码不正确')
                salt = secrets.token_hex(16)
                digest = hashlib.pbkdf2_hmac('sha256', body.new_password.encode(), bytes.fromhex(salt), 310000).hex()
                conn.execute('UPDATE users SET salt=?,password=? WHERE id=?', (salt, digest, user))
                conn.execute('DELETE FROM sessions WHERE user_id=?', (user,))
                conn.execute('DELETE FROM device_auth WHERE user_id=?', (user,))
            return {'changed': True, 'login_required': True}

        @app.post('/api/account/email')
        def bind_email(body: EmailInput, request: Request, user=Depends(owner)):
            limit_auth(request)
            email = email_address(body.email)
            with self.db() as conn:
                if conn.execute('SELECT 1 FROM profiles WHERE email=? AND user_id<>?', (email,user)).fetchone(): raise HTTPException(409,'此邮箱已绑定其他账号')
            self.send_token('email', email, {'user_id': user})
            return {'message': '绑定验证邮件已发送'}

        @app.post('/api/auth/forgot-password')
        def forgot(body: EmailInput, request: Request):
            limit_auth(request)
            email = email_address(body.email)
            with self.db() as conn:
                row = conn.execute('SELECT user_id FROM profiles WHERE email=?', (email,)).fetchone()
            if row and self.mailer.public()['configured']:
                try: self.send_token('reset', email, {'user_id': row[0]})
                except HTTPException: pass  # Same public response prevents account enumeration.
            return {'message': '如果该邮箱已绑定账号且邮件服务可用，重置邮件将会发送。请检查收件箱。'}

        @app.post('/api/auth/mail/confirm')
        def confirm_mail(body: MailToken, request: Request):
            limit_auth(request)
            digest = hashlib.sha256(body.token.encode()).hexdigest()
            with self.db(True) as conn:
                row = conn.execute('SELECT * FROM mail_tokens WHERE hash=? AND expires>?', (digest,time.time())).fetchone()
                if not row: raise HTTPException(400, '链接已使用或已过期，请重新申请')
                payload = json.loads(row['payload'])
                if row['purpose'] == 'register':
                    self.check_invite(conn, payload['invite_hash'])
                    self.create_user(conn, payload, verified=True)
                elif row['purpose'] == 'email':
                    try:
                        conn.execute('INSERT INTO profiles(user_id,email,verified) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified=1', (payload['user_id'],row['email']))
                    except sqlite3.IntegrityError: raise HTTPException(409,'此邮箱已绑定其他账号')
                    conn.execute("DELETE FROM mail_tokens WHERE purpose='reset' AND json_extract(payload,'$.user_id')=?",(payload['user_id'],))
                elif row['purpose'] == 'reset':
                    if not conn.execute('SELECT 1 FROM profiles WHERE user_id=? AND email=?',(payload['user_id'],row['email'])).fetchone():
                        raise HTTPException(400,'邮箱已变更，请重新申请重置密码')
                    if len(body.password)<10: raise HTTPException(422,'新密码至少 10 位')
                    salt = secrets.token_hex(16)
                    password = hashlib.pbkdf2_hmac('sha256',body.password.encode(),bytes.fromhex(salt),310000).hex()
                    conn.execute('UPDATE users SET salt=?,password=? WHERE id=?', (salt,password,payload['user_id']))
                    conn.execute('DELETE FROM sessions WHERE user_id=?', (payload['user_id'],))
                    conn.execute('DELETE FROM device_auth WHERE user_id=?', (payload['user_id'],))
                    conn.execute("DELETE FROM mail_tokens WHERE email=? AND purpose='reset'", (row['email'],))
                conn.execute('DELETE FROM mail_tokens WHERE hash=?', (digest,))
            return {'confirmed': True, 'message': '操作完成，请返回登录页面'}

        @app.get('/api/admin/mail')
        def get_mail(user=Depends(administrator)):
            return self.mailer.public()

        @app.put('/api/admin/mail')
        def set_mail(body: MailSettings, user=Depends(administrator)):
            return self.mailer.save(body)

        @app.post('/api/admin/mail/test')
        def test_mail(body: EmailInput, user=Depends(administrator)):
            self.mailer.send(email_address(body.email), 'test')
            return {'sent': True}

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
