package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func shareFailure(code, message string) Object {
	return Object{"code": code, "message": message}
}

func shareRank(access string) int {
	switch access {
	case "view":
		return 1
	case "download":
		return 2
	case "edit":
		return 3
	}
	return 0
}

func shareForm(payload Object) Object {
	out := Object{
		"show_description":  true,
		"show_due_at":       true,
		"show_requirements": true,
		"show_files":        false,
		"show_naming_hint":  true,
		"allow_material":    true,
		"allow_receipt":     false,
		"allow_note":        true,
		"submit_message":    "",
		"builder":           Object{},
	}
	for key, value := range object(payload["form"]) {
		out[key] = value
	}
	return out
}

func sharePayloadFor(row Object) Object {
	payload := store.Payload(row)
	if str(payload, "purpose") == "" {
		payload["purpose"] = "view"
	}
	if str(payload, "audience") == "" {
		payload["audience"] = "public"
	}
	if str(payload, "access") == "" {
		payload["access"] = "view"
	}
	return payload
}

func (s *Server) shareToken(row Object) string {
	token, err := s.Store.Decrypt(str(row, "token_cipher"))
	check(err)
	return token
}

func (s *Server) shareURL(ctx context.Context, db store.SQL, r request, token string) string {
	base := strings.TrimRight(str(s.mailConfig(ctx, db), "public_url"), "/")
	if base == "" {
		scheme := "http"
		if r.TLS != nil || strings.EqualFold(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]), "https") {
			scheme = "https"
		}
		host := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
		if host == "" {
			host = r.Host
		}
		if host == "" {
			host = "127.0.0.1"
		}
		base = scheme + "://" + host
	}
	return base + "/s/" + token
}

func (s *Server) shareProfile(ctx context.Context, db store.SQL, user string) Object {
	if user == "" {
		return nil
	}
	row := one(ctx, db, "SELECT u.id AS user_id,u.username,COALESCE(p.nickname,'') AS nickname FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=?", user)
	return Object{"username": str(row, "username"), "nickname": fallback(str(row, "nickname"), str(row, "username"))}
}

func (s *Server) shareObject(ctx context.Context, db store.SQL, row Object) Object {
	payload := sharePayloadFor(row)
	purpose := str(payload, "purpose")
	out := Object{
		"id":           row["id"],
		"task_id":      row["task_id"],
		"purpose":      purpose,
		"audience":     str(payload, "audience"),
		"viewers":      list(payload, "viewers"),
		"access":       str(payload, "access"),
		"has_password": str(payload, "password_hash") != "",
		"expires_at":   payload["expires_at"],
		"created_at":   row["created_at"],
		"updated_at":   row["updated_at"],
		"version":      num(payload, "version"),
		"revoked":      boolean(payload, "revoked"),
	}
	if purpose == "collect" {
		out["form"] = shareForm(payload)
		out["submission_count"] = num(one(ctx, db, "SELECT COUNT(*) AS count FROM share_submissions WHERE share_id=?", row["id"]), "count")
	}
	task := s.task(ctx, db, str(row, "user_id"), str(row, "task_id"))
	out["task_title"] = str(task, "title")
	out["collection"] = boolean(task, "collection")
	return out
}

func shareViewers(raw any) []any {
	out := []any{}
	values, ok := raw.([]any)
	if !ok {
		return out
	}
	seen := map[string]bool{}
	for _, item := range values {
		value, ok := item.(string)
		if !ok {
			fail(422, "指定用户名格式无效")
		}
		value = strings.ToLower(strings.TrimSpace(value))
		if len([]rune(value)) < 3 || len([]rune(value)) > 64 {
			fail(422, "用户名须为 3 至 64 位")
		}
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}

func shareFormInput(input Object, existing Object) Object {
	form := shareForm(sharePayloadFor(existing))
	raw := object(input["form"])
	for key := range form {
		value, ok := raw[key]
		if !ok {
			continue
		}
		if key == "builder" {
			form[key] = validateBuilder(object(value))
			continue
		}
		if key == "submit_message" {
			text, ok := value.(string)
			if !ok || len([]rune(text)) > 500 {
				fail(422, "表单提示语无效")
			}
			form[key] = text
			continue
		}
		if _, ok := value.(bool); !ok {
			fail(422, "表单选项无效："+key)
		}
		form[key] = value
	}
	if !boolean(form, "allow_material") && !boolean(form, "allow_receipt") && !boolean(form, "allow_note") {
		fail(422, "收集表单至少要允许一种提交内容")
	}
	return form
}

func shareInput(input Object, existing Object, purpose string) Object {
	// A new share starts public, view-only, without a password or deadline.
	current := Object{"audience": "public", "access": "view", "viewers": []any{}}
	if existing != nil {
		current = sharePayloadFor(existing)
	}
	audience := fallback(str(input, "audience"), str(current, "audience"))
	if !choice(audience, "public", "self", "registered", "users") {
		fail(422, "访问范围无效")
	}
	viewers := list(current, "viewers")
	if value, ok := input["viewers"]; ok {
		viewers = shareViewers(value)
	}
	if audience == "users" && len(viewers) == 0 {
		fail(422, "请指定允许访问的用户名")
	}
	access := fallback(str(input, "access"), str(current, "access"))
	if purpose == "collect" {
		access = "submit"
	} else if !choice(access, "view", "download", "edit") {
		fail(422, "分享权限无效")
	}
	salt, digest := str(current, "password_salt"), str(current, "password_hash")
	if value, ok := input["password"]; ok {
		password, ok := value.(string)
		if !ok {
			fail(422, "访问密码格式无效")
		}
		if password == "" {
			salt, digest = "", ""
		} else {
			if len([]rune(password)) < 6 || len([]rune(password)) > 128 {
				fail(422, "访问密码需要 6 至 128 位")
			}
			var err error
			salt, digest, err = store.NewPassword(password)
			check(err)
		}
	}
	expires := current["expires_at"]
	if value, ok := input["expires_at"]; ok {
		if value == nil {
			expires = nil
		} else {
			text, ok := value.(string)
			if !ok {
				fail(422, "截止时间格式无效")
			}
			text = strings.TrimSpace(text)
			if text == "" {
				expires = nil
			} else {
				if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
					fail(422, "截止时间须包含时区")
				}
				expires = text
			}
		}
	}
	version := 1
	if existing != nil {
		version = int(num(current, "version")) + 1
	}
	return Object{
		"purpose":       purpose,
		"audience":      audience,
		"viewers":       viewers,
		"access":        access,
		"password_salt": salt,
		"password_hash": digest,
		"expires_at":    expires,
		"form":          shareFormInput(input, existing),
		"revoked":       boolean(current, "revoked"),
		"version":       version,
	}
}

func (s *Server) shareExpired(payload Object) bool {
	text := str(payload, "expires_at")
	if text == "" {
		return false
	}
	expires, err := time.Parse(time.RFC3339Nano, text)
	return err == nil && time.Now().After(expires)
}

func (s *Server) shareViewer(ctx context.Context, db store.SQL, authorization string) string {
	if !strings.HasPrefix(authorization, "Bearer ") {
		return ""
	}
	rows := query(ctx, db, "SELECT user_id FROM sessions WHERE token_hash=? AND expires>?", store.Hash(strings.TrimPrefix(authorization, "Bearer ")), timestamp())
	if len(rows) == 0 {
		return ""
	}
	return str(rows[0], "user_id")
}

func (s *Server) shareAudience(ctx context.Context, db store.SQL, row, payload Object, viewer string) {
	audience := str(payload, "audience")
	if viewer == str(row, "user_id") || audience == "public" {
		return
	}
	if viewer == "" {
		fail(401, shareFailure("login_required", "请先登录后查看"))
	}
	if audience == "self" {
		if viewer != str(row, "user_id") {
			fail(403, shareFailure("forbidden", "此分享仅创建者可查看"))
		}
		return
	}
	if audience == "registered" {
		return
	}
	profile := one(ctx, db, "SELECT username FROM users WHERE id=?", viewer)
	username := strings.ToLower(str(profile, "username"))
	for _, item := range list(payload, "viewers") {
		if text, ok := item.(string); ok && strings.EqualFold(username, text) {
			return
		}
	}
	fail(403, shareFailure("forbidden", "此分享未向你开放"))
}

func shareCookieName(tokenHash string) string {
	if len(tokenHash) > 16 {
		tokenHash = tokenHash[:16]
	}
	return "jjb_s_" + tokenHash
}

func (s *Server) shareUnlocked(r request, row, payload Object) bool {
	if str(payload, "password_hash") == "" {
		return true
	}
	cookie, err := r.Cookie(shareCookieName(str(row, "token_hash")))
	if err != nil {
		return false
	}
	value, err := url.QueryUnescape(cookie.Value)
	if err != nil {
		return false
	}
	plain, err := s.Store.Decrypt(value)
	if err != nil {
		return false
	}
	parts := strings.Split(plain, "|")
	if len(parts) != 3 || !store.Equal(parts[0], str(row, "token_hash")) || !store.Equal(parts[2], store.Hash(str(payload, "password_hash"))) {
		return false
	}
	expires, err := strconv.ParseInt(parts[1], 10, 64)
	return err == nil && expires > time.Now().Unix()
}

// sharedResolve loads a share by its token and enforces expiry, audience and
// permission checks. needUnlock controls the password gate so the unlock
// endpoint itself is reachable while the share is still locked.
func (s *Server) sharedResolve(r request, required string, needUnlock bool) (Object, Object, string) {
	token := strings.TrimSpace(r.PathValue("token"))
	if token == "" || len(token) > 256 {
		fail(404, shareFailure("not_found", "分享不存在或已取消"))
	}
	row := first(query(r.Context(), s.Store.DB, "SELECT * FROM shares WHERE token_hash=?", store.Hash(token)))
	if row == nil || boolean(sharePayloadFor(row), "revoked") {
		fail(404, shareFailure("not_found", "分享不存在或已取消"))
	}
	payload := sharePayloadFor(row)
	if s.shareExpired(payload) {
		fail(410, shareFailure("expired", "分享已过期"))
	}
	viewer := s.shareViewer(r.Context(), s.Store.DB, r.Header.Get("Authorization"))
	s.shareAudience(r.Context(), s.Store.DB, row, payload, viewer)
	if needUnlock && !s.shareUnlocked(r, row, payload) {
		fail(401, shareFailure("password_required", "此分享需要访问密码"))
	}
	if required != "" && shareRank(str(payload, "access")) < shareRank(required) {
		fail(403, shareFailure("forbidden", "当前分享权限不足"))
	}
	return row, payload, viewer
}

func (s *Server) shared(r request, required string) (Object, Object, string) {
	return s.sharedResolve(r, required, true)
}

func sharePermissions(payload Object) Object {
	rank := shareRank(str(payload, "access"))
	return Object{
		"view":     true,
		"download": rank >= shareRank("download") || str(payload, "purpose") == "collect" && boolean(shareForm(payload), "show_files"),
		"edit":     rank >= shareRank("edit"),
		"submit":   str(payload, "purpose") == "collect",
	}
}

func shareTaskView(task, payload Object) Object {
	out := Object{
		"id":         task["id"],
		"title":      task["title"],
		"status":     task["status"],
		"version":    task["version"],
		"created_at": task["created_at"],
		"updated_at": task["updated_at"],
	}
	if str(payload, "purpose") == "collect" {
		form := shareForm(payload)
		if boolean(form, "show_description") {
			out["description"] = task["description"]
		}
		if boolean(form, "show_due_at") {
			out["due_at"] = task["due_at"]
		}
		if boolean(form, "show_requirements") {
			out["requirements"] = task["requirements"]
		}
		if boolean(form, "show_naming_hint") {
			out["naming_hint"] = task["naming_hint"]
		}
		if boolean(form, "show_files") {
			out["attachments"] = task["attachments"]
		} else {
			out["attachments"] = []any{}
		}
		return out
	}
	for key, value := range task {
		out[key] = value
	}
	delete(out, "client_id")
	delete(out, "source_message_id")
	return out
}

func (s *Server) sharedData(ctx context.Context, db store.SQL, row, payload Object, viewer string) Object {
	task := s.task(ctx, db, str(row, "user_id"), str(row, "task_id"))
	share := Object{
		"id":           row["id"],
		"purpose":      str(payload, "purpose"),
		"audience":     str(payload, "audience"),
		"access":       str(payload, "access"),
		"has_password": str(payload, "password_hash") != "",
		"expires_at":   payload["expires_at"],
	}
	if str(payload, "purpose") == "collect" {
		share["form"] = shareForm(payload)
		publicBuilder := object(share["form"].(map[string]any)["builder"])
		delete(publicBuilder, "roster")
		share["form"].(map[string]any)["builder"] = publicBuilder
		share["submission_count"] = num(one(ctx, db, "SELECT COUNT(*) AS count FROM share_submissions WHERE share_id=?", row["id"]), "count")
	}
	out := Object{
		"share":       share,
		"task":        shareTaskView(task, payload),
		"owner":       s.shareProfile(ctx, db, str(row, "user_id")),
		"permissions": sharePermissions(payload),
	}
	if viewer != "" {
		out["viewer"] = s.shareProfile(ctx, db, viewer)
	}
	return out
}

func (s *Server) collectShare(ctx context.Context, db store.SQL, owner, taskID string) Object {
	rows := query(ctx, db, "SELECT * FROM shares WHERE user_id=? AND task_id=?", owner, taskID)
	for _, row := range rows {
		payload := sharePayloadFor(row)
		if str(payload, "purpose") == "collect" && !boolean(payload, "revoked") {
			return row
		}
	}
	return nil
}

func (s *Server) createShare(ctx context.Context, db store.SQL, r request, owner string, input Object, purpose string) Object {
	taskID := str(input, "task_id")
	task := s.task(ctx, db, owner, taskID)
	payload := shareInput(input, nil, purpose)
	token := store.Token()
	now := store.Now()
	id := store.ID()
	encrypted, err := s.Store.Encrypt(token)
	check(err)
	exec(ctx, db, "INSERT INTO shares VALUES(?,?,?,?,?,?,?,?)", id, owner, taskID, store.Hash(token), encrypted, store.JSON(payload), now, now)
	event(ctx, db, owner, "share.upsert", id)
	if purpose == "collect" && !boolean(task, "collection") {
		task["collection"] = true
		task["version"] = num(task, "version") + 1
		delete(task, "attachments")
		s.updateTask(ctx, db, owner, task)
	}
	row := one(ctx, db, "SELECT * FROM shares WHERE id=?", id)
	out := s.shareObject(ctx, db, row)
	out["url"] = s.shareURL(ctx, db, r, token)
	return out
}

func (s *Server) updateShare(ctx context.Context, db store.SQL, r request, owner string, row Object, input Object) Object {
	payload := sharePayloadFor(row)
	next := shareInput(input, row, str(payload, "purpose"))
	exec(ctx, db, "UPDATE shares SET payload=?,updated_at=? WHERE id=? AND user_id=?", store.JSON(next), store.Now(), row["id"], owner)
	event(ctx, db, owner, "share.upsert", str(row, "id"))
	updated := one(ctx, db, "SELECT * FROM shares WHERE id=?", row["id"])
	out := s.shareObject(ctx, db, updated)
	out["url"] = s.shareURL(ctx, db, r, s.shareToken(updated))
	return out
}

func (s *Server) shareRoutes() {
	s.route("GET /api/shares", "owner", func(r request) any {
		rows := query(r.Context(), s.Store.DB, "SELECT * FROM shares WHERE user_id=? ORDER BY created_at DESC", r.User)
		out := []Object{}
		for _, row := range rows {
			item := s.shareObject(r.Context(), s.Store.DB, row)
			item["url"] = s.shareURL(r.Context(), s.Store.DB, r, s.shareToken(row))
			out = append(out, item)
		}
		return Object{"shares": out}
	})
	s.route("POST /api/shares", "owner", func(r request) any {
		input := r.body()
		if str(input, "purpose") == "" {
			input["purpose"] = "view"
		}
		if !choice(str(input, "purpose"), "view", "collect") {
			fail(422, "分享类型无效")
		}
		return s.transaction(r.Context(), func(db store.SQL) any {
			if str(input, "purpose") == "collect" {
				if row := s.collectShare(r.Context(), db, r.User, str(input, "task_id")); row != nil {
					return s.updateShare(r.Context(), db, r, r.User, row, input)
				}
			}
			return s.createShare(r.Context(), db, r, r.User, input, str(input, "purpose"))
		})
	})
	s.route("PUT /api/shares/{share_id}", "owner", func(r request) any {
		row := one(r.Context(), s.Store.DB, "SELECT * FROM shares WHERE id=? AND user_id=?", r.PathValue("share_id"), r.User)
		return s.updateShare(r.Context(), s.Store.DB, r, r.User, row, r.body())
	})
	s.route("DELETE /api/shares/{share_id}", "owner", func(r request) any {
		row := one(r.Context(), s.Store.DB, "SELECT * FROM shares WHERE id=? AND user_id=?", r.PathValue("share_id"), r.User)
		payload := sharePayloadFor(row)
		exec(r.Context(), s.Store.DB, "DELETE FROM shares WHERE id=? AND user_id=?", row["id"], r.User)
		if str(payload, "purpose") == "collect" {
			task := s.task(r.Context(), s.Store.DB, r.User, str(row, "task_id"))
			task["collection"] = s.collectShare(r.Context(), s.Store.DB, r.User, str(row, "task_id")) != nil
			task["version"] = num(task, "version") + 1
			delete(task, "attachments")
			s.updateTask(r.Context(), s.Store.DB, r.User, task)
		}
		event(r.Context(), s.Store.DB, r.User, "share.delete", str(row, "id"))
		return Object{"ok": true}
	})
	s.route("GET /api/shares/{share_id}/submissions", "owner", func(r request) any {
		row := one(r.Context(), s.Store.DB, "SELECT * FROM shares WHERE id=? AND user_id=?", r.PathValue("share_id"), r.User)
		if str(sharePayloadFor(row), "purpose") != "collect" {
			fail(400, "只有收集表单包含提交记录")
		}
		rows := query(r.Context(), s.Store.DB, "SELECT * FROM share_submissions WHERE share_id=? ORDER BY created_at DESC LIMIT 500", row["id"])
		for _, item := range rows {
			extra := first(query(r.Context(), s.Store.DB, "SELECT payload,updated_at FROM collection_entries WHERE id=?", item["id"]))
			if extra != nil {
				item["values"] = store.Payload(extra)
				item["updated_at"] = extra["updated_at"]
			}
			item["files"] = query(r.Context(), s.Store.DB, "SELECT a.id,a.name,a.size,a.kind FROM share_submission_files m JOIN attachments a ON a.id=m.attachment_id WHERE m.submission_id=? ORDER BY a.rowid", item["id"])
		}
		return Object{"submissions": rows}
	})
	s.route("POST /api/tasks/{task_id}/collection", "owner", func(r request) any {
		input := r.body()
		taskID := r.PathValue("task_id")
		return s.transaction(r.Context(), func(db store.SQL) any {
			task := s.task(r.Context(), db, r.User, taskID)
			enabled := boolean(input, "enabled")
			if !enabled {
				rows := query(r.Context(), db, "SELECT * FROM shares WHERE user_id=? AND task_id=?", r.User, taskID)
				for _, row := range rows {
					if str(sharePayloadFor(row), "purpose") == "collect" {
						payload := sharePayloadFor(row)
						payload["revoked"] = true
						exec(r.Context(), db, "UPDATE shares SET payload=?,updated_at=? WHERE id=? AND user_id=?", store.JSON(payload), store.Now(), row["id"], r.User)
						event(r.Context(), db, r.User, "share.upsert", str(row, "id"))
					}
				}
				task["collection"] = false
				task["version"] = num(task, "version") + 1
				delete(task, "attachments")
				s.updateTask(r.Context(), db, r.User, task)
				return Object{"task": s.task(r.Context(), db, r.User, taskID), "share": nil}
			}
			row := s.collectShare(r.Context(), db, r.User, taskID)
			input["task_id"] = taskID
			input["purpose"] = "collect"
			var share Object
			if row == nil {
				share = s.createShare(r.Context(), db, r, r.User, input, "collect")
			} else {
				share = s.updateShare(r.Context(), db, r, r.User, row, input)
			}
			task = s.task(r.Context(), db, r.User, taskID)
			if !boolean(task, "collection") {
				task["collection"] = true
				task["version"] = num(task, "version") + 1
				delete(task, "attachments")
				s.updateTask(r.Context(), db, r.User, task)
			}
			return Object{"task": s.task(r.Context(), db, r.User, taskID), "share": share}
		})
	})
	s.route("POST /api/shared/{token}/unlock", "", func(r request) any {
		row, payload, _ := s.sharedResolve(r, "", false)
		if str(payload, "password_hash") == "" {
			return Object{"ok": true}
		}
		password, _ := r.body()["password"].(string)
		candidate, err := store.Password(password, str(payload, "password_salt"))
		check(err)
		if !store.Equal(candidate, str(payload, "password_hash")) {
			fail(403, shareFailure("invalid_password", "访问密码错误"))
		}
		expires := time.Now().Add(12 * time.Hour).Unix()
		plain := str(row, "token_hash") + "|" + strconv.FormatInt(expires, 10) + "|" + store.Hash(str(payload, "password_hash"))
		encrypted, err := s.Store.Encrypt(plain)
		check(err)
		secure := r.TLS != nil || strings.EqualFold(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]), "https")
		http.SetCookie(r.W, &http.Cookie{Name: shareCookieName(str(row, "token_hash")), Value: url.QueryEscape(encrypted), Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secure, MaxAge: 12 * 3600})
		return Object{"ok": true}
	})
	s.route("GET /api/shared/{token}", "", func(r request) any {
		row, payload, viewer := s.shared(r, "")
		if str(payload, "purpose") != "collect" {
			required := "view"
			if shareRank(str(payload, "access")) < shareRank(required) {
				fail(403, shareFailure("forbidden", "当前分享权限不足"))
			}
		}
		return s.sharedData(r.Context(), s.Store.DB, row, payload, viewer)
	})
	s.route("PUT /api/shared/{token}/task", "", func(r request) any {
		row, payload, _ := s.shared(r, "")
		if str(payload, "purpose") != "view" {
			fail(400, "收集表单不能直接修改待办")
		}
		if shareRank(str(payload, "access")) < shareRank("edit") {
			fail(403, shareFailure("forbidden", "当前分享仅允许查看或下载"))
		}
		owner := str(row, "user_id")
		taskID := str(row, "task_id")
		input := r.body()
		if input["collection"] == nil {
			input["collection"] = s.task(r.Context(), s.Store.DB, owner, taskID)["collection"]
		}
		body := taskInput(input)
		return s.transaction(r.Context(), func(db store.SQL) any {
			task := s.task(r.Context(), db, owner, taskID)
			version(task, int(num(body, "version")))
			body["collection"] = task["collection"]
			body["client_id"] = task["client_id"]
			body["source_message_id"] = task["source_message_id"]
			for key, value := range body {
				task[key] = value
			}
			task["version"] = int(num(body, "version")) + 1
			delete(task, "attachments")
			s.updateTask(r.Context(), db, owner, task)
			return s.sharedData(r.Context(), db, row, payload, "")
		})
	})
	s.route("GET /api/shared/{token}/files/{file_id}", "", func(r request) any {
		row, payload, _ := s.shared(r, "")
		if str(payload, "purpose") == "collect" {
			if !boolean(shareForm(payload), "show_files") {
				fail(403, shareFailure("forbidden", "收集表单未开放文件查看"))
			}
		} else if shareRank(str(payload, "access")) < shareRank("download") {
			fail(403, shareFailure("forbidden", "当前分享不允许下载文件"))
		}
		file := one(r.Context(), s.Store.DB, "SELECT * FROM attachments WHERE id=? AND user_id=? AND task_id=?", r.PathValue("file_id"), str(row, "user_id"), str(row, "task_id"))
		path := s.blob(str(file, "id"))
		if _, err := os.Stat(path); err != nil {
			fail(404, "文件不存在")
		}
		r.W.Header().Set("Content-Type", "application/octet-stream")
		r.W.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": str(file, "name")}))
		http.ServeFile(r.W, r.Request, path)
		return nil
	})
	s.route("POST /api/shared/{token}/files", "", func(r request) any {
		row, payload, _ := s.shared(r, "")
		if str(payload, "purpose") != "view" || shareRank(str(payload, "access")) < shareRank("edit") {
			fail(403, shareFailure("forbidden", "当前分享不允许修改文件"))
		}
		owner, taskID := str(row, "user_id"), str(row, "task_id")
		kind := fallback(r.URL.Query().Get("kind"), "material")
		if !choice(kind, "material", "receipt") {
			fail(422, "文件用途无效")
		}
		rr := r
		rr.User = owner
		return s.uploadFile(rr, func(db store.SQL, file Object) any {
			task := s.task(r.Context(), db, owner, taskID)
			version(task, r.integer("version", 0, 1, 1e9))
			s.taskQuota(r.Context(), db, taskID, "", int64(num(file, "size")))
			exec(r.Context(), db, "INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", file["id"], owner, taskID, file["name"], file["size"], file["sha256"], kind)
			task["version"] = num(task, "version") + 1
			delete(task, "attachments")
			s.updateTask(r.Context(), db, owner, task)
			return s.sharedData(r.Context(), db, row, payload, "")
		})
	})
	s.route("DELETE /api/shared/{token}/files/{file_id}", "", func(r request) any {
		row, payload, _ := s.shared(r, "")
		if str(payload, "purpose") != "view" || shareRank(str(payload, "access")) < shareRank("edit") {
			fail(403, shareFailure("forbidden", "当前分享不允许修改文件"))
		}
		owner, taskID := str(row, "user_id"), str(row, "task_id")
		s.transaction(r.Context(), func(db store.SQL) any {
			task := s.task(r.Context(), db, owner, taskID)
			version(task, r.integer("version", 0, 1, 1e9))
			one(r.Context(), db, "SELECT id FROM attachments WHERE id=? AND user_id=? AND task_id=?", r.PathValue("file_id"), owner, taskID)
			exec(r.Context(), db, "DELETE FROM attachments WHERE id=?", r.PathValue("file_id"))
			task["version"] = num(task, "version") + 1
			delete(task, "attachments")
			s.updateTask(r.Context(), db, owner, task)
			return nil
		})
		os.Remove(s.blob(r.PathValue("file_id")))
		return Object{"ok": true}
	})
	s.collectionRoutes()
	s.route("POST /api/shared/{token}/submit", "", func(r request) any {
		row, payload, viewer := s.shared(r, "")
		if str(payload, "purpose") != "collect" {
			fail(400, "此分享不是收集表单")
		}
		r.Body = http.MaxBytesReader(r.W, r.Body, s.MaxUpload*20+(1<<20))
		parseErr := r.ParseMultipartForm(8 << 20)
		if r.MultipartForm != nil {
			defer r.MultipartForm.RemoveAll()
		}
		if parseErr != nil || r.MultipartForm == nil {
			fail(413, "提交内容无效或文件过大")
		}
		form := shareForm(payload)
		name := clip(strings.TrimSpace(r.FormValue("name")), 80)
		contact := clip(strings.TrimSpace(r.FormValue("contact")), 160)
		note := clip(strings.TrimSpace(r.FormValue("note")), 2000)
		if !boolean(form, "allow_note") {
			note = ""
		}
		uploads := []Object{}
		committed := false
		cleanup := func() {
			for _, file := range uploads {
				os.Remove(str(file, "path"))
			}
		}
		defer func() {
			if !committed {
				cleanup()
			}
		}()
		for _, group := range []struct {
			field   string
			kind    string
			allowed bool
		}{{"material_files", "material", boolean(form, "allow_material")}, {"receipt_files", "receipt", boolean(form, "allow_receipt")}} {
			files := r.MultipartForm.File[group.field]
			if len(files) > 0 && !group.allowed {
				fail(403, shareFailure("forbidden", "此收集表单未开放该类文件"))
			}
			for _, header := range files {
				if len(uploads) >= 20 {
					fail(413, "单次最多提交 20 个文件")
				}
				source, err := header.Open()
				check(err)
				id := store.ID()
				path := s.blob(id)
				dst, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				check(err)
				hash := sha256.New()
				size, copyErr := io.Copy(io.MultiWriter(dst, hash), io.LimitReader(source, s.MaxUpload+1))
				source.Close()
				closeErr := dst.Close()
				if copyErr != nil || closeErr != nil {
					os.Remove(path)
					check(copyErr)
					check(closeErr)
				}
				if size > s.MaxUpload {
					os.Remove(path)
					fail(413, "单个文件超过上传上限")
				}
				uploads = append(uploads, Object{"id": id, "path": path, "name": safeName(header.Filename), "size": size, "sha256": hex.EncodeToString(hash.Sum(nil)), "kind": group.kind, "field": r.FormValue("file_field_" + header.Filename)})
			}
		}
		if len(uploads) == 0 && r.FormValue("values") == "" && !(note != "" && boolean(form, "allow_note")) {
			fail(422, "请添加要提交的文件或填写说明")
		}
		owner, taskID := str(row, "user_id"), str(row, "task_id")
		values := decodeValues(r.FormValue("values"))
		browser := r.FormValue("browser_key")
		var ownerID any
		if viewer != "" {
			ownerID = viewer
		}
		submissionID := store.ID()
		message := fallback(str(form, "submit_message"), "提交成功，收集者已收到")
		s.transaction(r.Context(), func(db store.SQL) any {
			task := s.task(r.Context(), db, owner, taskID)
			replaceID := s.validateEntry(r, db, row, form, values, browser, uploads)
			if replaceID != "" {
				submissionID = replaceID
				if len(uploads) > 0 {
					exec(r.Context(), db, "DELETE FROM share_submission_files WHERE submission_id=?", submissionID)
				}
			}
			total := int64(0)
			for _, file := range uploads {
				total += int64(num(file, "size"))
			}
			s.checkUserQuota(r.Context(), db, owner, total)
			exec(r.Context(), db, "INSERT INTO share_submissions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,contact=excluded.contact,note=excluded.note", submissionID, row["id"], taskID, ownerID, name, contact, note, store.Hash(r.RemoteAddr), store.Now())
			exec(r.Context(), db, "INSERT INTO collection_entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at", submissionID, row["id"], store.Hash(browser), store.JSON(values), store.Now())
			for _, file := range uploads {
				exec(r.Context(), db, "INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", file["id"], owner, taskID, file["name"], file["size"], file["sha256"], file["kind"])
				exec(r.Context(), db, "INSERT INTO share_submission_files VALUES(?,?)", submissionID, file["id"])
			}
			if len(uploads) > 0 {
				task["version"] = num(task, "version") + 1
				delete(task, "attachments")
				s.updateTask(r.Context(), db, owner, task)
			}
			event(r.Context(), db, owner, "share.submit", submissionID)
			return nil
		})
		committed = true
		return Object{"ok": true, "submission_id": submissionID, "message": message}
	})
}
