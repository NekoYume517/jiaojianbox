"""Styled transactional mail; SMTP credentials are encrypted at rest."""
import html
import json
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, Field
from typing import Literal


class MailSettings(BaseModel):
    host: str = Field(default='', max_length=253, pattern=r'^[a-zA-Z0-9.:-]*$')
    port: int = Field(default=465, ge=1, le=65535)
    security: Literal['ssl', 'starttls'] = 'ssl'
    username: str = Field(default='', max_length=254)
    password: str | None = Field(default=None, max_length=1000)
    sender: str = Field(default='', max_length=254)
    sender_name: str = Field(default='交件箱', max_length=80)
    public_url: str = Field(default='', max_length=500)
    verification_required: bool = False


def email_address(value):
    import re
    value = value.strip().lower()
    if len(value) > 254 or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}", value):
        raise HTTPException(422, '请填写有效的邮箱地址')
    return value


class Mailer:
    def __init__(self, db, cipher):
        self.db, self.cipher = db, cipher

    def config(self):
        with self.db() as conn:
            row = conn.execute("SELECT value FROM site_settings WHERE key='smtp'").fetchone()
        value = json.loads(row[0]) if row else MailSettings().model_dump()
        if not value.get('public_url'): value['public_url'] = os.environ.get('JJB_PUBLIC_URL', '')
        secret = value.pop('encrypted_password', '')
        value['password'] = self.cipher.decrypt(secret.encode()).decode() if secret else ''
        return value

    def public(self):
        value = self.config()
        value['has_password'] = bool(value.pop('password', ''))
        value['configured'] = bool(value['host'] and value['sender'] and value['public_url'])
        return value

    def save(self, body):
        value = body.model_dump()
        value['public_url'] = value['public_url'] or os.environ.get('JJB_PUBLIC_URL', '')
        parsed = urlsplit(value['public_url'])
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise HTTPException(422, '邮件链接地址应为本服务的 HTTP/HTTPS 地址')
        if value['sender']:
            value['sender'] = email_address(value['sender'])
        if '\r' in value['sender_name'] or '\n' in value['sender_name']:
            raise HTTPException(422, '发件人名称无效')
        if value['verification_required'] and not (value['host'] and value['sender']):
            raise HTTPException(422, '请先配置 SMTP 和发件邮箱，再开启邮箱验证')
        password = value.pop('password') or self.config().get('password', '')
        value['encrypted_password'] = self.cipher.encrypt(password.encode()).decode() if password else ''
        with self.db(True) as conn:
            conn.execute("INSERT OR REPLACE INTO site_settings VALUES('smtp',?)", (json.dumps(value),))
        return self.public()

    def send(self, recipient, purpose, token=None):
        c = self.config()
        if not c['host'] or not c['sender']:
            raise HTTPException(503, '管理员尚未配置邮件服务')
        title = {'register': '验证邮箱，开始使用交件箱', 'reset': '重置你的交件箱密码', 'email': '确认绑定邮箱', 'test': '交件箱邮件服务测试'}[purpose]
        link = c['public_url'].rstrip('/') + '/?mail_action=' + purpose + '&token=' + (token or '')
        text = title + ('\n请在 30 分钟内打开链接：\n' + link if token else '\n邮件服务已成功连接。') + '\n如果这不是你本人的操作，请忽略这封邮件。'
        button = f'<a href="{html.escape(link, quote=True)}" style="display:inline-block;padding:14px 24px;border-radius:12px;background:#246447;color:#fff;text-decoration:none;font-weight:bold">继续操作</a>' if token else '<p>邮件服务已成功连接。</p>'
        content = f'<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f2f6f3;font-family:Arial,sans-serif;color:#183528"><table role="presentation" style="width:100%;padding:32px 12px"><tr><td align="center"><table role="presentation" style="max-width:560px;width:100%;background:#fff;border:1px solid #dce8df;border-radius:20px;padding:32px"><tr><td><p style="color:#397456;font-size:14px;letter-spacing:2px">交件箱 · JIAOJIANBOX</p><h1 style="font-size:25px;line-height:1.5">{html.escape(title)}</h1><p style="color:#63766b;line-height:1.8">消息很多，要交的事一件不漏。{("此链接仅可使用一次，30 分钟内有效。" if token else "")}</p>{button}<p style="font-size:12px;line-height:1.8;color:#74847a;margin-top:28px">如果这不是你本人的操作，请忽略此邮件。请勿将验证链接转发给他人。</p></td></tr></table></td></tr></table></body></html>'
        message = EmailMessage()
        message['Subject'] = title
        message['From'] = formataddr((c['sender_name'], c['sender']))
        message['To'] = email_address(recipient)
        message.set_content(text)
        message.add_alternative(content, subtype='html')
        try:
            cls = smtplib.SMTP_SSL if c['security'] == 'ssl' else smtplib.SMTP
            kwargs = {'timeout': 15}
            if c['security'] == 'ssl': kwargs['context'] = ssl.create_default_context()
            with cls(c['host'], c['port'], **kwargs) as smtp:
                if c['security'] == 'starttls': smtp.starttls(context=ssl.create_default_context())
                if c['username']: smtp.login(c['username'], c['password'])
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException):
            raise HTTPException(503, '邮件发送失败，请检查 SMTP 配置后重试') from None
