package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func submitShare(t *testing.T, s *Server, route, token string, fields map[string]string, files map[string]string) (int, Object) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for key, value := range fields {
		writer.WriteField(key, value)
	}
	for field, name := range files {
		part, err := writer.CreateFormFile(field, name)
		if err != nil {
			t.Fatal(err)
		}
		part.Write([]byte("collector fixture " + name))
	}
	writer.Close()
	r := httptest.NewRequest("POST", route, &buffer)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var out Object
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func shareTokenFromURL(url string) string {
	parts := strings.Split(url, "/s/")
	if len(parts) != 2 {
		return ""
	}
	return parts[1]
}

func TestShareLifecyclePermissionsAndPassword(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "share-owner")
	other, _ := login(t, s, "share-other")
	stranger, _ := login(t, s, "share-stranger")
	_, task := call(t, s, "POST", "/api/tasks", owner, Object{"title": "分享待办", "description": "材料说明"})
	taskID := str(task, "id")

	code, share := call(t, s, "POST", "/api/shares", owner, Object{"task_id": taskID})
	if code != 200 && code != 201 {
		t.Fatalf("create share %d: %v", code, share)
	}
	if str(share, "audience") != "public" || str(share, "access") != "view" || boolean(share, "has_password") {
		t.Fatalf("defaults not public/view/passwordless: %v", share)
	}
	token := shareTokenFromURL(str(share, "url"))
	if token == "" {
		t.Fatalf("bad share url %q", str(share, "url"))
	}

	code, public := call(t, s, "GET", "/api/shared/"+token, "", nil)
	if code != 200 {
		t.Fatalf("public read %d: %v", code, public)
	}
	if str(object(public["task"]), "title") != "分享待办" {
		t.Fatalf("task payload missing: %v", public)
	}
	if _, leaked := object(public["task"])["client_id"]; leaked {
		t.Fatal("client_id leaked through share")
	}

	// 仅可查看 means writing is rejected.
	if code, _ := call(t, s, "PUT", "/api/shared/"+token+"/task", "", Object{"title": "越权", "version": 1}); code != 403 {
		t.Fatalf("view share allowed edit: %d", code)
	}

	// 仅自己可看 hides the share from anyone else.
	_, restricted := call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{"audience": "self"})
	if str(restricted, "audience") != "self" {
		t.Fatalf("audience not updated: %v", restricted)
	}
	if code, _ := call(t, s, "GET", "/api/shared/"+token, other, nil); code != 403 {
		t.Fatalf("self audience leaked to other: %d", code)
	}
	if code, _ := call(t, s, "GET", "/api/shared/"+token, "", nil); code != 401 {
		t.Fatalf("self audience allowed anonymous: %d", code)
	}

	// 指定用户名 must be enforced by username.
	_, targeted := call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{
		"audience": "users",
		"viewers":  []any{"share-other"},
		"access":   "download",
	})
	if code, _ := call(t, s, "GET", "/api/shared/"+token, other, nil); code != 200 {
		t.Fatalf("targeted viewer rejected: %d %v", code, targeted)
	}
	if code, _ := call(t, s, "GET", "/api/shared/"+token, stranger, nil); code != 403 {
		t.Fatalf("unlisted viewer allowed: %d", code)
	}
	// 可下载文件 must allow downloads but not editing.
	_, upload := uploaded(t, s, "/api/tasks/"+taskID+"/files?version=1", owner, "材料.pdf", []byte("fixture-material"))
	files := objects(upload["attachments"])
	if len(files) == 0 {
		t.Fatalf("upload did not attach a file: %v", upload)
	}
	if code, _ := call(t, s, "GET", "/api/shared/"+token+"/files/"+str(files[0], "id"), other, nil); code != 200 {
		t.Fatalf("download permission blocked: %d", code)
	}
	if code, _ := call(t, s, "PUT", "/api/shared/"+token+"/task", other, Object{"title": "下载级改标题", "version": 2}); code != 403 {
		t.Fatalf("download permission allowed edit: %d", code)
	}

	// 可修改 allows editing the shared task.
	call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{"access": "edit"})
	if code, _ := call(t, s, "PUT", "/api/shared/"+token+"/task", other, Object{"title": "编辑级改标题", "version": 2}); code != 200 {
		t.Fatalf("edit permission blocked: %d", code)
	}
	_, reloaded := call(t, s, "GET", "/api/tasks/"+taskID, owner, nil)
	if str(reloaded, "title") != "编辑级改标题" {
		t.Fatalf("edit did not persist: %v", reloaded)
	}

	// Password protection requires at least six characters and blocks plain reads.
	if code, _ := call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{"password": "12345"}); code != 422 {
		t.Fatalf("short password accepted: %d", code)
	}
	call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{"password": "secret-123", "audience": "public"})
	if code, out := call(t, s, "GET", "/api/shared/"+token, owner, nil); code != 401 || str(object(out["detail"]), "message") == "" {
		t.Fatalf("password gate not enforced: %d %v", code, out)
	}
	unlock := httptest.NewRequest("POST", "/api/shared/"+token+"/unlock", strings.NewReader(store.JSON(Object{"password": "wrong-pass"})))
	unlockW := httptest.NewRecorder()
	s.ServeHTTP(unlockW, unlock)
	if unlockW.Code != 403 {
		t.Fatalf("wrong password accepted: %d", unlockW.Code)
	}
	unlock = httptest.NewRequest("POST", "/api/shared/"+token+"/unlock", strings.NewReader(store.JSON(Object{"password": "secret-123"})))
	unlockW = httptest.NewRecorder()
	s.ServeHTTP(unlockW, unlock)
	if unlockW.Code != 200 {
		t.Fatalf("unlock failed: %d %s", unlockW.Code, unlockW.Body.String())
	}
	cookies := unlockW.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("unlock did not set a cookie")
	}
	read := httptest.NewRequest("GET", "/api/shared/"+token, nil)
	read.Header.Set("Authorization", "Bearer "+owner)
	read.AddCookie(cookies[0])
	readW := httptest.NewRecorder()
	s.ServeHTTP(readW, read)
	if readW.Code != 200 {
		t.Fatalf("unlocked read failed: %d %s", readW.Code, readW.Body.String())
	}

	// An expired share closes access entirely.
	call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{"expires_at": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), "password": ""})
	expired := httptest.NewRequest("GET", "/api/shared/"+token, nil)
	expiredW := httptest.NewRecorder()
	s.ServeHTTP(expiredW, expired)
	if expiredW.Code != 410 {
		t.Fatalf("expired share still readable: %d", expiredW.Code)
	}

	if code, _ := call(t, s, "DELETE", "/api/shares/"+str(share, "id"), owner, nil); code != 200 {
		t.Fatalf("delete share failed: %d", code)
	}
	if code, _ := call(t, s, "GET", "/api/shared/"+token, "", nil); code != 404 {
		t.Fatalf("deleted share still readable: %d", code)
	}
	if code, _ := call(t, s, "GET", "/api/shares", other, nil); code != 200 {
		t.Fatalf("share list failed: %d", code)
	}
}

func TestCollectionShareAndSubmissions(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "collect-owner")
	visitor, _ := login(t, s, "collect-visitor")
	_, task := call(t, s, "POST", "/api/tasks", owner, Object{"title": "收集作业", "description": "请提交实验报告"})
	taskID := str(task, "id")

	code, enabled := call(t, s, "POST", "/api/tasks/"+taskID+"/collection", owner, Object{"enabled": true})
	if code != 200 {
		t.Fatalf("enable collection %d: %v", code, enabled)
	}
	if !boolean(object(enabled["task"]), "collection") {
		t.Fatal("task not flagged as collection")
	}
	collect := object(enabled["share"])
	if str(collect, "purpose") != "collect" {
		t.Fatalf("collect share missing: %v", collect)
	}
	token := shareTokenFromURL(str(collect, "url"))
	if token == "" {
		t.Fatal("collect share url missing")
	}

	code, page := call(t, s, "POST", "/api/shared/"+token+"/unlock", "", Object{"password": ""})
	if code != 200 {
		t.Fatalf("collect unlock %d: %v", code, page)
	}
	code, view := call(t, s, "GET", "/api/shared/"+token, "", nil)
	if code != 200 {
		t.Fatalf("collect view %d: %v", code, view)
	}
	if !boolean(object(view["permissions"]), "submit") {
		t.Fatalf("collect permissions wrong: %v", view)
	}
	if str(object(view["task"]), "description") != "请提交实验报告" {
		t.Fatalf("description not visible: %v", view)
	}

	// Anonymous visitors may submit files and a note.
	code, submitted := submitShare(t, s, "/api/shared/"+token+"/submit", "", map[string]string{
		"name":    "同学甲",
		"note":    "这是我的作业",
		"contact": "13800000000",
	}, map[string]string{"material_files": "作业.pdf"})
	if code != 200 {
		t.Fatalf("submit %d: %v", code, submitted)
	}
	submissionID := str(submitted, "submission_id")
	if submissionID == "" {
		t.Fatal("submission id missing")
	}
	files := query(t.Context(), s.Store.DB, "SELECT a.id,a.name FROM share_submission_files m JOIN attachments a ON a.id=m.attachment_id WHERE m.submission_id=?", submissionID)
	if len(files) != 1 {
		t.Fatalf("submitted file not recorded: %v", files)
	}
	if _, err := os.Stat(s.blob(str(files[0], "id"))); err != nil {
		t.Fatalf("submitted file was deleted after commit: %v", err)
	}

	// Logged-in visitors are recorded and submissions count up.
	code, second := submitShare(t, s, "/api/shared/"+token+"/submit", visitor, map[string]string{
		"name": "同学乙",
		"note": "第二份",
	}, map[string]string{"material_files": "作业2.pdf"})
	if code != 200 {
		t.Fatalf("logged-in submit %d: %v", code, second)
	}
	code, listing := call(t, s, "GET", "/api/shares/"+str(collect, "id")+"/submissions", owner, nil)
	if code != 200 {
		t.Fatalf("submissions %d: %v", code, listing)
	}
	rows := objects(listing["submissions"])
	if len(rows) != 2 {
		t.Fatalf("expected 2 submissions, got %d: %v", len(rows), listing)
	}
	code, list := call(t, s, "GET", "/api/shares", owner, nil)
	if code != 200 {
		t.Fatalf("share list %d", code)
	}
	if num(objects(list["shares"])[0], "submission_count") != 2 {
		t.Fatalf("submission count wrong: %v", list)
	}

	// Turning collection off removes the form and clears the flag.
	code, disabled := call(t, s, "POST", "/api/tasks/"+taskID+"/collection", owner, Object{"enabled": false})
	if code != 200 {
		t.Fatalf("disable collection %d: %v", code, disabled)
	}
	if boolean(object(disabled["task"]), "collection") {
		t.Fatal("collection flag not cleared")
	}
	gone := httptest.NewRequest("GET", "/api/shared/"+token, nil)
	goneW := httptest.NewRecorder()
	s.ServeHTTP(goneW, gone)
	if goneW.Code != 404 {
		t.Fatalf("collect share still live after disable: %d", goneW.Code)
	}
}

func TestCollectionVisibilityPreservationAndQuota(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "form-owner")
	_, task := call(t, s, "POST", "/api/tasks", owner, Object{"title": "私密说明", "description": "不应公开的说明", "naming_hint": "不应公开的命名"})
	_, created := call(t, s, "POST", "/api/tasks/"+str(task, "id")+"/collection", owner, Object{"enabled": true, "form": Object{"show_description": false, "show_naming_hint": false, "allow_receipt": true}})
	share := object(created["share"])
	id := str(share, "id")
	token := shareTokenFromURL(str(share, "url"))
	_, updated := call(t, s, "PUT", "/api/shares/"+id, owner, Object{"audience": "registered"})
	if boolean(object(updated["form"]), "show_description") || !boolean(object(updated["form"]), "allow_receipt") {
		t.Fatalf("partial update reset form: %v", updated)
	}
	if code, _ := call(t, s, "GET", "/api/shared/"+token, "", nil); code != 401 {
		t.Fatal("registered audience not enforced", code)
	}
	call(t, s, "PUT", "/api/shares/"+id, owner, Object{"audience": "public"})
	_, view := call(t, s, "GET", "/api/shared/"+token, "", nil)
	for _, key := range []string{"description", "naming_hint"} {
		if _, ok := object(view["task"])[key]; ok {
			t.Fatalf("hidden field exposed: %s", key)
		}
	}
	exec(t.Context(), s.Store.DB, "INSERT INTO user_quotas VALUES(?,?,?)", one(t.Context(), s.Store.DB, "SELECT id FROM users WHERE username='form-owner'")["id"], 1, store.Now())
	code, _ := submitShare(t, s, "/api/shared/"+token+"/submit", "", map[string]string{"note": "quota"}, map[string]string{"receipt_files": "test.txt"})
	if code != 413 {
		t.Fatal("quota not enforced", code)
	}
	_, rows := call(t, s, "GET", "/api/shares/"+id+"/submissions", owner, nil)
	if len(objects(rows["submissions"])) != 0 {
		t.Fatal("failed upload left records")
	}
	code, _ = submitShare(t, s, "/api/shared/"+token+"/submit", "", map[string]string{"note": "仅备注"}, nil)
	if code != 200 {
		t.Fatal(code)
	}
	call(t, s, "POST", "/api/tasks/"+str(task, "id")+"/collection", owner, Object{"enabled": false})
	_, rows = call(t, s, "GET", "/api/shares/"+id+"/submissions", owner, nil)
	if len(objects(rows["submissions"])) != 1 {
		t.Fatal("closing form lost records")
	}
}

func TestSharePasswordRotationRevokesUnlockedCookie(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "password-owner")
	_, task := call(t, s, "POST", "/api/tasks", owner, Object{"title": "密码测试"})
	_, share := call(t, s, "POST", "/api/shares", owner, Object{"task_id": task["id"], "password": "secret-123"})
	token := shareTokenFromURL(str(share, "url"))
	r := httptest.NewRequest("POST", "/api/shared/"+token+"/unlock", strings.NewReader(store.JSON(Object{"password": "secret-123"})))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	cookies := w.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("unlock failed")
	}
	call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{"password": "new-secret"})
	r = httptest.NewRequest("GET", "/api/shared/"+token, nil)
	r.AddCookie(cookies[0])
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("old cookie survived password rotation", w.Code)
	}
}
