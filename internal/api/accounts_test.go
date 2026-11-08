package api

import (
	"context"
	"github.com/NekoYume517/jiaojianbox/internal/store"
	"testing"
)

func TestAdminInvitationAndMailConfigurationIsolation(t *testing.T) {
	s := testServer(t)
	admin, user := login(t, s, "admin-fixture")
	ordinary, _ := login(t, s, "ordinary-fixture")
	ctx := context.Background()
	exec(ctx, s.Store.DB, "INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')", user)
	if code, _ := call(t, s, "GET", "/api/admin/mail", ordinary, nil); code != 403 {
		t.Fatal("SMTP credentials exposed", code)
	}
	code, mail := call(t, s, "PUT", "/api/admin/mail", admin, Object{"host": "smtp.fixture.invalid", "port": 465, "security": "ssl", "sender": "robot@fixture.invalid", "username": "robot", "password": "fixture-smtp-authorization", "public_url": "https://fixture.invalid"})
	if code != 200 || !boolean(mail, "has_password") || mail["password"] != nil || mail["encrypted_password"] != nil {
		t.Fatal(code, mail)
	}
	_, mail = call(t, s, "PUT", "/api/admin/mail", admin, Object{"sender_name": "验收邮件", "password": nil})
	if !boolean(mail, "has_password") {
		t.Fatal("blank password erased SMTP authorization")
	}
	call(t, s, "PUT", "/api/admin/registration", admin, Object{"mode": "invite"})
	_, invitation := call(t, s, "POST", "/api/admin/invitations", admin, Object{"label": "验收", "max_uses": 1, "expires_days": 7})
	credentials := Object{"username": "invite-fixture", "password": "fixture-long-password", "invitation_code": invitation["code"]}
	if code, out := call(t, s, "POST", "/api/auth/register", "", credentials); code != 201 {
		t.Fatal(code, out, invitation)
	}
	credentials["username"] = "invite-other"
	if code, _ := call(t, s, "POST", "/api/auth/register", "", credentials); code != 403 {
		t.Fatal("reused single-use invitation", code)
	}
}
func TestResetTokenIsOneUseAndPreservesAccount(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "reset-fixture")
	ctx := context.Background()
	exec(ctx, s.Store.DB, "UPDATE profiles SET email='fixture@fixture.invalid',verified=1 WHERE user_id=?", user)
	secret := store.Token()
	exec(ctx, s.Store.DB, "INSERT INTO mail_tokens VALUES(?,?,?,?,?,?)", store.Hash(secret), "reset", "fixture@fixture.invalid", store.JSON(Object{"user_id": user}), timestamp()+1800, timestamp())
	code, result := call(t, s, "POST", "/api/auth/mail/confirm", "", Object{"token": secret, "password": "reset-fixture-password"})
	if code != 200 || !boolean(result, "confirmed") {
		t.Fatal(code, result)
	}
	if code, _ := call(t, s, "GET", "/api/snapshot", token, nil); code != 401 {
		t.Fatal("previous session retained", code)
	}
	if code, _ := call(t, s, "POST", "/api/auth/mail/confirm", "", Object{"token": secret, "password": "other-fixture-password"}); code != 400 {
		t.Fatal("reset token replayed", code)
	}
	code, session := call(t, s, "POST", "/api/auth/login", "", Object{"username": "reset-fixture", "password": "reset-fixture-password"})
	if code != 200 || session["user_id"] != user {
		t.Fatal(code, session)
	}
}
