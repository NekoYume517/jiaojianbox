package api

import (
	"context"
	"crypto/tls"
	"fmt"
	"html"
	"mime"
	"net"
	"net/smtp"
	"net/url"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func (s *Server) mailConfig(ctx context.Context, db store.SQL) Object {
	value := Object{"host": "", "port": 465, "security": "ssl", "username": "", "password": "", "sender": "", "sender_name": "交件箱", "public_url": env("JJB_PUBLIC_URL", ""), "verification_required": false}
	row := first(query(ctx, db, "SELECT value AS payload FROM site_settings WHERE key='smtp'"))
	if row != nil {
		for k, v := range store.Payload(row) {
			value[k] = v
		}
	}
	if str(value, "public_url") == "" {
		value["public_url"] = env("JJB_PUBLIC_URL", "")
	}
	password, err := s.Store.Decrypt(str(value, "encrypted_password"))
	check(err)
	delete(value, "encrypted_password")
	value["password"] = password
	return value
}
func (s *Server) publicMail(ctx context.Context, db store.SQL) Object {
	c := s.mailConfig(ctx, db)
	c["has_password"] = str(c, "password") != ""
	delete(c, "password")
	c["configured"] = str(c, "host") != "" && str(c, "sender") != "" && str(c, "public_url") != ""
	return c
}
func serverURL(value string) string {
	u, e := url.Parse(strings.TrimSpace(value))
	if e != nil || !choice(u.Scheme, "http", "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		fail(422, "请填写有效的 HTTP/HTTPS 服务端地址")
	}
	return strings.TrimRight(u.String(), "/")
}
func (s *Server) sendMail(ctx context.Context, recipient, purpose, token string) {
	recipient = email(recipient)
	c := s.mailConfig(ctx, s.Store.DB)
	if str(c, "host") == "" || str(c, "sender") == "" {
		fail(503, "管理员尚未配置邮件服务")
	}
	title := map[string]string{"register": "验证交件箱邮箱", "reset": "重置交件箱密码", "email": "确认绑定邮箱", "test": "交件箱邮件服务测试"}[purpose]
	link := strings.TrimRight(str(c, "public_url"), "/") + "/?" + url.Values{"mail_action": {purpose}, "token": {token}}.Encode()
	text := title + "\n邮件服务已成功连接。"
	button := "<p>邮件服务已成功连接。</p>"
	if token != "" {
		text = title + "\n请在 30 分钟内打开链接：\n" + link
		button = `<a href="` + html.EscapeString(link) + `" style="display:inline-block;padding:12px 20px;background:#7aa2f7;color:#1a1b26;text-decoration:none">继续操作</a>`
	}
	content := `<!doctype html><html lang="zh-CN"><body style="margin:0;padding:32px;background:#1a1b26;color:#c0caf5;font-family:Arial,sans-serif"><table role="presentation" style="margin:auto;max-width:560px;width:100%;border:1px solid #414868;padding:32px"><tr><td><p style="color:#7aa2f7">交件箱</p><h1 style="font-size:24px">` + html.EscapeString(title) + `</h1><p style="line-height:1.7">此链接仅可使用一次，30 分钟内有效。</p>` + button + `<p style="font-size:12px;color:#a9b1d6;margin-top:28px">如果不是你本人的操作，请忽略此邮件。请勿向他人转发验证链接。</p></td></tr></table></body></html>`
	sender := email(str(c, "sender"))
	name := str(c, "sender_name")
	if strings.ContainsAny(name+recipient+sender, "\r\n") {
		fail(422, "邮件地址或发件人名称无效")
	}
	boundary := "jjb-" + store.ID()
	message := "From: " + mime.QEncoding.Encode("utf-8", name) + " <" + sender + ">\r\nTo: " + recipient + "\r\nSubject: " + mime.QEncoding.Encode("utf-8", title) + "\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=" + boundary + "\r\n\r\n--" + boundary + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + text + "\r\n--" + boundary + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + content + "\r\n--" + boundary + "--\r\n"
	tlsConfig := &tls.Config{ServerName: str(c, "host"), MinVersion: tls.VersionTLS12}
	address := net.JoinHostPort(str(c, "host"), fmt.Sprint(int(num(c, "port"))))
	dialer := net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	var err error
	if str(c, "security") == "ssl" {
		conn, err = (&tls.Dialer{NetDialer: &dialer, Config: tlsConfig}).DialContext(ctx, "tcp", address)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		fail(503, "邮件连接失败，请检查 SMTP 配置")
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(20 * time.Second))
	client, err := smtp.NewClient(conn, str(c, "host"))
	if err != nil {
		fail(503, "邮件连接失败")
	}
	defer client.Close()
	if str(c, "security") == "starttls" {
		if err = client.StartTLS(tlsConfig); err != nil {
			fail(503, "SMTP 加密协商失败")
		}
	}
	if str(c, "username") != "" {
		if err = client.Auth(smtp.PlainAuth("", str(c, "username"), str(c, "password"), str(c, "host"))); err != nil {
			fail(503, "SMTP 认证失败，请检查账号和授权码")
		}
	}
	if err = client.Mail(sender); err == nil {
		err = client.Rcpt(recipient)
	}
	if err != nil {
		fail(503, "邮件发送失败，请检查发件地址")
	}
	writer, err := client.Data()
	if err != nil {
		fail(503, "邮件发送失败")
	}
	_, err = writer.Write([]byte(message))
	closeErr := writer.Close()
	if err != nil || closeErr != nil {
		fail(503, "邮件发送失败")
	}
	client.Quit()
}
func (s *Server) sendToken(ctx context.Context, purpose, address string, payload Object) {
	token := store.Token()
	digest := store.Hash(token)
	exec(ctx, s.Store.DB, "INSERT INTO mail_tokens VALUES(?,?,?,?,?,?)", digest, purpose, address, store.JSON(payload), timestamp()+1800, timestamp())
	_, err := attempt(func() any { s.sendMail(ctx, address, purpose, token); return nil })
	if err != nil {
		exec(context.WithoutCancel(ctx), s.Store.DB, "DELETE FROM mail_tokens WHERE hash=?", digest)
		panic(err)
	}
}
func (s *Server) accountRoutes() {
	s.route("PUT /api/account/profile", "owner", func(r request) any {
		b := r.body()
		name := strings.TrimSpace(str(b, "nickname"))
		if len([]rune(name)) > 64 {
			fail(422, "昵称最多 64 个字符")
		}
		exec(r.Context(), s.Store.DB, "INSERT INTO profiles(user_id,nickname) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname", r.User, name)
		return s.profile(r.Context(), s.Store.DB, r.User)
	})
	s.route("POST /api/account/password", "owner", func(r request) any {
		b := r.body()
		validatePassword(str(b, "new_password"))
		return s.transaction(r.Context(), func(db store.SQL) any {
			row := one(r.Context(), db, "SELECT salt,password FROM users WHERE id=?", r.User)
			candidate, err := store.Password(str(b, "current_password"), str(row, "salt"))
			check(err)
			if !store.Equal(candidate, str(row, "password")) {
				fail(403, "当前密码不正确")
			}
			salt, digest, err := store.NewPassword(str(b, "new_password"))
			check(err)
			exec(r.Context(), db, "UPDATE users SET salt=?,password=? WHERE id=?", salt, digest, r.User)
			s.revokeSessions(r.Context(), db, r.User)
			return Object{"changed": true, "login_required": true}
		})
	})
	s.route("POST /api/account/email", "owner", func(r request) any {
		address := email(str(r.body(), "email"))
		if len(query(r.Context(), s.Store.DB, "SELECT 1 FROM profiles WHERE email=? AND user_id<>?", address, r.User)) > 0 {
			fail(409, "此邮箱已绑定其他账号")
		}
		s.sendToken(r.Context(), "email", address, Object{"user_id": r.User})
		return Object{"message": "绑定验证邮件已发送"}
	})
	s.route("POST /api/auth/forgot-password", "", func(r request) any {
		address := email(str(r.body(), "email"))
		row := first(query(r.Context(), s.Store.DB, "SELECT user_id FROM profiles WHERE email=?", address))
		if row != nil {
			attempt(func() any { s.sendToken(r.Context(), "reset", address, Object{"user_id": row["user_id"]}); return nil })
		}
		return Object{"message": "如果该邮箱已绑定账号且邮件服务可用，重置邮件将会发送。请检查收件箱。"}
	})
	s.route("POST /api/auth/mail/confirm", "", func(r request) any {
		b := r.body()
		return s.transaction(r.Context(), func(db store.SQL) any {
			row := first(query(r.Context(), db, "SELECT * FROM mail_tokens WHERE hash=? AND expires>?", store.Hash(str(b, "token")), timestamp()))
			if row == nil {
				fail(400, "链接已使用或已过期，请重新申请")
			}
			p := store.Payload(row)
			switch str(row, "purpose") {
			case "register":
				s.invite(r.Context(), db, str(p, "invite_hash"), true)
				s.createUser(r.Context(), db, p, true)
			case "email":
				if len(query(r.Context(), db, "SELECT 1 FROM profiles WHERE email=? AND user_id<>?", row["email"], p["user_id"])) > 0 {
					fail(409, "此邮箱已绑定其他账号")
				}
				exec(r.Context(), db, "INSERT INTO profiles(user_id,email,verified) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified=1", p["user_id"], row["email"])
				exec(r.Context(), db, "DELETE FROM mail_tokens WHERE purpose='reset' AND json_extract(payload,'$.user_id')=?", p["user_id"])
			case "reset":
				if len(query(r.Context(), db, "SELECT 1 FROM profiles WHERE user_id=? AND email=?", p["user_id"], row["email"])) == 0 {
					fail(400, "邮箱已变更，请重新申请")
				}
				validatePassword(str(b, "password"))
				salt, digest, err := store.NewPassword(str(b, "password"))
				check(err)
				exec(r.Context(), db, "UPDATE users SET salt=?,password=? WHERE id=?", salt, digest, p["user_id"])
				s.revokeSessions(r.Context(), db, str(p, "user_id"))
				exec(r.Context(), db, "DELETE FROM mail_tokens WHERE email=? AND purpose='reset'", row["email"])
			default:
				fail(400, "验证用途无效")
			}
			exec(r.Context(), db, "DELETE FROM mail_tokens WHERE hash=?", row["hash"])
			return Object{"confirmed": true, "message": "操作完成，请返回登录页面"}
		})
	})
	s.route("GET /api/admin/mail", "admin", func(r request) any { return s.publicMail(r.Context(), s.Store.DB) })
	s.route("PUT /api/admin/mail", "admin", func(r request) any {
		b := r.body()
		previous := s.mailConfig(r.Context(), s.Store.DB)
		c := Object{}
		for _, k := range []string{"host", "port", "security", "username", "sender", "sender_name", "public_url", "verification_required"} {
			c[k] = previous[k]
			if v, ok := b[k]; ok {
				c[k] = v
			}
		}
		c["public_url"] = serverURL(fallback(str(c, "public_url"), env("JJB_PUBLIC_URL", "")))
		if str(c, "sender") != "" {
			c["sender"] = email(str(c, "sender"))
		}
		if num(c, "port") < 1 || num(c, "port") > 65535 || !choice(str(c, "security"), "ssl", "starttls") || strings.ContainsAny(str(c, "host"), "/\r\n ") || strings.ContainsAny(str(c, "sender_name"), "\r\n") {
			fail(422, "SMTP 配置无效")
		}
		if boolean(c, "verification_required") && (str(c, "host") == "" || str(c, "sender") == "") {
			fail(422, "请先配置 SMTP 和发件邮箱")
		}
		password := fallback(str(b, "password"), str(previous, "password"))
		encrypted, err := s.Store.Encrypt(password)
		check(err)
		if password == "" {
			encrypted = ""
		}
		c["encrypted_password"] = encrypted
		exec(r.Context(), s.Store.DB, "INSERT OR REPLACE INTO site_settings VALUES('smtp',?)", store.JSON(c))
		return s.publicMail(r.Context(), s.Store.DB)
	})
	s.route("POST /api/admin/mail/test", "admin", func(r request) any {
		s.sendMail(r.Context(), str(r.body(), "email"), "test", "")
		return Object{"sent": true}
	})
	s.route("GET /api/admin/registration", "admin", func(r request) any { return s.policy(r.Context(), s.Store.DB) })
	s.route("PUT /api/admin/registration", "admin", func(r request) any {
		b := r.body()
		mode := str(b, "mode")
		if !choice(mode, "public", "closed", "invite") {
			fail(422, "注册方式无效")
		}
		exec(r.Context(), s.Store.DB, "INSERT OR REPLACE INTO site_settings VALUES('registration_mode',?)", mode)
		return Object{"mode": mode}
	})
	s.route("GET /api/admin/users", "admin", func(r request) any {
		return query(r.Context(), s.Store.DB, "SELECT u.id,u.username,COALESCE(r.role,'user') AS role,COALESCE(q.bytes,0) AS quota_bytes,COALESCE((SELECT SUM(size) FROM attachments a WHERE a.user_id=u.id),0) AS used_bytes FROM users u LEFT JOIN user_roles r ON r.user_id=u.id LEFT JOIN user_quotas q ON q.user_id=u.id ORDER BY u.rowid")
	})
	s.route("PUT /api/admin/users/{user_id}/quota", "admin", func(r request) any {
		target := r.PathValue("user_id")
		if one(r.Context(), s.Store.DB, "SELECT id FROM users WHERE id=?", target) == nil {
			fail(404, "账号不存在")
		}
		quota := int64(num(r.body(), "quota_bytes"))
		if quota != -1 && quota != 0 && quota < 1<<20 {
			fail(422, "配额无效：0 表示默认 10GB，-1 表示不限制，最小 1MB")
		}
		exec(r.Context(), s.Store.DB, "INSERT INTO user_quotas(user_id,bytes,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET bytes=excluded.bytes,updated_at=excluded.updated_at", target, quota, store.Now())
		return Object{"user_id": target, "quota_bytes": quota}
	})
	s.route("GET /api/admin/invitations", "admin", func(r request) any {
		return query(r.Context(), s.Store.DB, "SELECT id,prefix,label,max_uses,uses,expires,revoked FROM invitations ORDER BY rowid DESC LIMIT 200")
	})
	s.route("POST /api/admin/invitations", "admin", func(r request) any {
		b := r.body()
		days := num(b, "expires_days")
		if days == 0 {
			days = 7
		}
		uses := num(b, "max_uses")
		if uses == 0 {
			uses = 1
		}
		if days < 1 || days > 365 || uses < 1 || uses > 1000 {
			fail(422, "邀请码限制无效")
		}
		code := strings.ToUpper(strings.ReplaceAll(store.ID(), "-", ""))
		id := store.ID()
		expires := timestamp() + days*86400
		exec(r.Context(), s.Store.DB, "INSERT INTO invitations(id,code_hash,prefix,label,max_uses,expires,created_by) VALUES(?,?,?,?,?,?,?)", id, store.Hash(code), code[:6], clip(str(b, "label"), 100), int(uses), expires, r.User)
		return Object{"id": id, "code": code, "expires": expires, "max_uses": int(uses)}
	})
	s.route("DELETE /api/admin/invitations/{invitation_id}", "admin", func(r request) any {
		if changed(exec(r.Context(), s.Store.DB, "UPDATE invitations SET revoked=1 WHERE id=?", r.PathValue("invitation_id"))) == 0 {
			fail(404, "邀请码不存在")
		}
		return Object{"revoked": true}
	})
}
func (s *Server) revokeSessions(ctx context.Context, db store.SQL, user string) {
	exec(ctx, db, "DELETE FROM sessions WHERE user_id=?", user)
	exec(ctx, db, "DELETE FROM device_auth WHERE user_id=?", user)
}
