package api

import (
	"context"
	"net/mail"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func timestamp() float64 { return float64(time.Now().UnixMilli()) / 1000 }
func (s *Server) owner(ctx context.Context, authorization string) string {
	if !strings.HasPrefix(authorization, "Bearer ") {
		fail(401, "请先登录")
	}
	rows := query(ctx, s.Store.DB, "SELECT user_id FROM sessions WHERE token_hash=? AND expires>?", store.Hash(strings.TrimPrefix(authorization, "Bearer ")), timestamp())
	if len(rows) == 0 {
		fail(401, "登录已过期，请重新登录")
	}
	return str(rows[0], "user_id")
}
func (s *Server) isAdmin(ctx context.Context, db store.SQL, user string) bool {
	return len(query(ctx, db, "SELECT 1 FROM user_roles WHERE user_id=? AND role='superadmin'", user)) > 0
}
func (s *Server) bootstrap() {
	ctx := context.Background()
	username := strings.TrimSpace(env("JJB_BOOTSTRAP_ADMIN_USERNAME", ""))
	if username == "" {
		return
	}
	s.transaction(ctx, func(db store.SQL) any {
		row := first(query(ctx, db, "SELECT id FROM users WHERE username=?", username))
		if row == nil && env("JJB_BOOTSTRAP_ADMIN_PASSWORD", "") != "" {
			password := env("JJB_BOOTSTRAP_ADMIN_PASSWORD", "")
			validatePassword(password)
			salt, digest, err := store.NewPassword(password)
			check(err)
			uid := store.ID()
			exec(ctx, db, "INSERT INTO users VALUES(?,?,?,?)", uid, username, salt, digest)
			row = Object{"id": uid}
		}
		if row != nil {
			exec(ctx, db, "INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')", row["id"])
		}
		return nil
	})
}
func validatePassword(password string) {
	if len([]rune(password)) < 10 || len([]rune(password)) > 256 {
		fail(422, "密码需要 10 至 256 位")
	}
}
func email(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(value)
	if err != nil || parsed.Address != value || len(value) > 254 || !strings.Contains(strings.Split(value, "@")[len(strings.Split(value, "@"))-1], ".") {
		fail(422, "请填写有效的邮箱地址")
	}
	return value
}
func (s *Server) registrationMode(ctx context.Context, db store.SQL) string {
	row := first(query(ctx, db, "SELECT value FROM site_settings WHERE key='registration_mode'"))
	if row != nil {
		return str(row, "value")
	}
	if env("JJB_ALLOW_REGISTRATION", "true") == "false" {
		return "closed"
	}
	return "public"
}
func (s *Server) policy(ctx context.Context, db store.SQL) Object {
	m := s.mailConfig(ctx, db)
	return Object{"mode": s.registrationMode(ctx, db), "email_registration": env("JJB_REQUIRE_EMAIL", "true") != "false", "verification_required": boolean(m, "verification_required"), "password_recovery": str(m, "host") != "" && str(m, "sender") != "" && str(m, "public_url") != ""}
}
func (s *Server) invite(ctx context.Context, db store.SQL, digest string, consume bool) {
	mode := s.registrationMode(ctx, db)
	if mode == "closed" {
		fail(403, "注册已关闭")
	}
	if mode != "invite" {
		return
	}
	row := first(query(ctx, db, "SELECT id FROM invitations WHERE code_hash=? AND revoked=0 AND expires>? AND uses<max_uses", digest, timestamp()))
	if row == nil {
		fail(403, "邀请码无效、已用完或已过期")
	}
	if consume {
		exec(ctx, db, "UPDATE invitations SET uses=uses+1 WHERE id=?", row["id"])
	}
}
func (s *Server) createUser(ctx context.Context, db store.SQL, p Object, verified bool) {
	if len(query(ctx, db, "SELECT 1 FROM users WHERE username=?", p["username"])) > 0 {
		fail(409, "此账号已注册，请登录或找回密码")
	}
	uid := store.ID()
	exec(ctx, db, "INSERT INTO users VALUES(?,?,?,?)", uid, p["username"], p["salt"], p["password"])
	var address any
	if strings.Contains(str(p, "username"), "@") {
		address = p["username"]
	}
	exec(ctx, db, "INSERT INTO profiles(user_id,email,verified) VALUES(?,?,?)", uid, address, verified)
}
func (s *Server) profile(ctx context.Context, db store.SQL, user string) Object {
	row := one(ctx, db, "SELECT u.id AS user_id,u.username,p.nickname,p.email,p.verified FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=?", user)
	row["nickname"] = fallback(str(row, "nickname"), str(row, "username"))
	row["is_admin"] = s.isAdmin(ctx, db, user)
	return row
}
func (s *Server) newSession(ctx context.Context, db store.SQL, user string) string {
	token := store.Token()
	exec(ctx, db, "DELETE FROM sessions WHERE expires<?", timestamp())
	exec(ctx, db, "INSERT INTO sessions VALUES(?,?,?)", store.Hash(token), user, timestamp()+30*86400)
	return token
}

func (s *Server) authRoutes() {
	s.route("GET /api/auth/registration", "", func(r request) any { return s.policy(r.Context(), s.Store.DB) })
	s.route("POST /api/auth/register", "", func(r request) any {
		b := r.body()
		username := strings.ToLower(strings.TrimSpace(fallback(str(b, "email"), str(b, "username"))))
		if env("JJB_REQUIRE_EMAIL", "true") != "false" || strings.Contains(username, "@") {
			username = email(username)
		}
		if len([]rune(username)) < 3 || len(username) > 254 {
			fail(422, "用户名长度无效")
		}
		password := str(b, "password")
		validatePassword(password)
		salt, digest, err := store.NewPassword(password)
		check(err)
		pending := Object{"username": username, "salt": salt, "password": digest, "invite_hash": store.Hash(strings.ToUpper(strings.TrimSpace(str(b, "invitation_code"))))}
		authorizationCode := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(str(b, "authorization_code")), "-", ""))
		if len(authorizationCode) == 8 && strings.Trim(authorizationCode, "0123456789ABCDEF") == "" {
			pending["authorization_code"] = authorizationCode
		}
		verify := boolean(s.mailConfig(r.Context(), s.Store.DB), "verification_required")
		s.transaction(r.Context(), func(db store.SQL) any {
			s.invite(r.Context(), db, str(pending, "invite_hash"), !verify)
			if len(query(r.Context(), db, "SELECT 1 FROM users WHERE username=?", username)) > 0 {
				fail(409, "此账号已注册，请登录或找回密码")
			}
			if !verify {
				s.createUser(r.Context(), db, pending, false)
			}
			return nil
		})
		if verify {
			s.sendToken(r.Context(), "register", username, pending)
			return Object{"verification_required": true, "message": "验证邮件已发送，请检查收件箱"}
		}
		return Object{"registered": true}
	})
	s.route("POST /api/auth/login", "", func(r request) any {
		b := r.body()
		password := str(b, "password")
		validatePassword(password)
		identity := strings.TrimSpace(fallback(str(b, "email"), str(b, "username")))
		row := first(query(r.Context(), s.Store.DB, "SELECT u.* FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.username=? OR p.email=?", identity, identity))
		salt := strings.Repeat("0", 32)
		if row != nil {
			salt = str(row, "salt")
		}
		candidate, err := store.Password(password, salt)
		check(err)
		if row == nil || !store.Equal(candidate, str(row, "password")) {
			fail(401, "用户名或密码错误")
		}
		return s.transaction(r.Context(), func(db store.SQL) any {
			return Object{"token": s.newSession(r.Context(), db, str(row, "id")), "user_id": row["id"], "username": row["username"]}
		})
	})
	s.route("POST /api/auth/logout", "owner", func(r request) any {
		exec(r.Context(), s.Store.DB, "DELETE FROM sessions WHERE token_hash=?", store.Hash(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
		return Object{"ok": true}
	})
	s.route("GET /api/auth/me", "owner", func(r request) any { return s.profile(r.Context(), s.Store.DB, r.User) })
	s.route("POST /api/auth/device/start", "", func(r request) any {
		secret := store.Token()
		code := strings.ToUpper(strings.ReplaceAll(store.ID(), "-", "")[:8])
		expires := timestamp() + 600
		exec(r.Context(), s.Store.DB, "INSERT INTO device_auth(device_hash,user_code,expires) VALUES(?,?,?)", store.Hash(secret), code, expires)
		return Object{"device_code": secret, "user_code": code[:4] + "-" + code[4:], "expires_in": 600, "interval": 2, "verification_path": "/authorize?code=" + code}
	})
	s.route("POST /api/auth/device/poll", "", func(r request) any {
		b := r.body()
		return s.transaction(r.Context(), func(db store.SQL) any {
			row := first(query(r.Context(), db, "SELECT * FROM device_auth WHERE device_hash=?", store.Hash(str(b, "device_code"))))
			if row == nil || num(row, "expires") < timestamp() {
				fail(410, "授权已过期，请重新打开浏览器")
			}
			switch str(row, "state") {
			case "denied":
				fail(403, "授权已取消")
			case "consumed":
				fail(410, "此授权已使用")
			case "approved":
				account := one(r.Context(), db, "SELECT username FROM users WHERE id=?", row["user_id"])
				token, err := s.Store.Decrypt(str(row, "token"))
				check(err)
				exec(r.Context(), db, "UPDATE device_auth SET state='consumed',token=NULL WHERE device_hash=?", row["device_hash"])
				return Object{"status": "approved", "token": token, "user_id": row["user_id"], "username": account["username"]}
			}
			return Object{"status": "pending"}
		})
	})
	s.route("GET /api/auth/device/request", "owner", func(r request) any {
		code := deviceCode(r.URL.Query().Get("code"))
		row := first(query(r.Context(), s.Store.DB, "SELECT state,expires FROM device_auth WHERE user_code=?", code))
		if row == nil || num(row, "expires") < timestamp() {
			fail(410, "授权已过期")
		}
		return Object{"state": row["state"], "user_code": code[:4] + "-" + code[4:], "application": "交件箱桌面客户端", "expires_in": int(num(row, "expires") - timestamp())}
	})
	s.route("POST /api/auth/device/approve", "owner", func(r request) any {
		b := r.body()
		code := deviceCode(str(b, "user_code"))
		return s.transaction(r.Context(), func(db store.SQL) any {
			row := first(query(r.Context(), db, "SELECT * FROM device_auth WHERE user_code=?", code))
			if row == nil || num(row, "expires") < timestamp() {
				fail(410, "授权已过期")
			}
			if str(row, "state") != "pending" {
				fail(409, "此请求已处理")
			}
			state := "denied"
			token := ""
			if boolean(b, "approve") {
				state = "approved"
				plain := s.newSession(r.Context(), db, r.User)
				var err error
				token, err = s.Store.Encrypt(plain)
				check(err)
			}
			exec(r.Context(), db, "UPDATE device_auth SET state=?,user_id=?,token=? WHERE user_code=?", state, r.User, token, code)
			return Object{"status": state}
		})
	})
}
func deviceCode(value string) string {
	value = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(value))
	if len(value) != 8 {
		fail(422, "授权码格式无效")
	}
	return value
}
