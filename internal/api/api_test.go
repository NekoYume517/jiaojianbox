package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("JJB_REQUIRE_EMAIL", "false")
	t.Setenv("JJB_ALLOW_REGISTRATION", "true")
	t.Setenv("JJB_BOOTSTRAP_ADMIN_USERNAME", "")
	t.Setenv("JJB_MASTER_KEY", "")
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(db, fstest.MapFS{"index.html": {Data: []byte("<html>交件箱</html>")}}, "test")
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close(); db.Close() })
	return s
}
func call(t *testing.T, s *Server, method, path, token string, body any) (int, Object) {
	t.Helper()
	var data io.Reader
	if body != nil {
		data = strings.NewReader(store.JSON(body))
	}
	r := httptest.NewRequest(method, path, data)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var result Object
	json.Unmarshal(w.Body.Bytes(), &result)
	return w.Code, result
}
func login(t *testing.T, s *Server, name string) (string, string) {
	t.Helper()
	credentials := Object{"username": name, "password": "fixture-password-123"}
	status, out := call(t, s, "POST", "/api/auth/register", "", credentials)
	if status != 201 {
		t.Fatalf("register %d: %v", status, out)
	}
	status, out = call(t, s, "POST", "/api/auth/login", "", credentials)
	if status != 200 {
		t.Fatalf("login %d: %v", status, out)
	}
	return str(out, "token"), str(out, "user_id")
}
func uploaded(t *testing.T, s *Server, route, token, name string, data []byte) (int, Object) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	part.Write(data)
	writer.Close()
	r := httptest.NewRequest("POST", route, &buffer)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var out Object
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestWorkspaceIsolationVersionsAndDeviceAuthorization(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "student")
	other, _ := login(t, s, "another")
	if code, _ := call(t, s, "GET", "/api/snapshot", "", nil); code != 401 {
		t.Fatal(code)
	}
	code, task := call(t, s, "POST", "/api/tasks", owner, Object{"title": "实验报告", "client_id": "same-id"})
	if code != 201 {
		t.Fatal(task)
	}
	_, replay := call(t, s, "POST", "/api/tasks", owner, Object{"title": "重复请求", "client_id": "same-id"})
	if task["id"] != replay["id"] {
		t.Fatal("idempotency lost")
	}
	route := "/api/tasks/" + str(task, "id")
	if code, _ := call(t, s, "GET", route, other, nil); code != 404 {
		t.Fatal("owner isolation", code)
	}
	_, updated := call(t, s, "PUT", route, owner, Object{"title": "更新标题", "version": 1})
	if num(updated, "version") != 2 {
		t.Fatal(updated)
	}
	if code, _ := call(t, s, "PUT", route, owner, Object{"title": "旧版本", "version": 1}); code != 409 {
		t.Fatal(code)
	}
	_, device := call(t, s, "POST", "/api/auth/device/start", "", Object{})
	_, pending := call(t, s, "POST", "/api/auth/device/poll", "", Object{"device_code": device["device_code"]})
	if pending["status"] != "pending" {
		t.Fatal(pending)
	}
	code, approved := call(t, s, "POST", "/api/auth/device/approve", owner, Object{"user_code": device["user_code"], "approve": true})
	if code != 200 {
		t.Fatal(approved)
	}
	_, result := call(t, s, "POST", "/api/auth/device/poll", "", Object{"device_code": device["device_code"]})
	if result["status"] != "approved" || str(result, "token") == "" {
		t.Fatal(result)
	}
	if code, _ := call(t, s, "POST", "/api/auth/device/poll", "", Object{"device_code": device["device_code"]}); code != 410 {
		t.Fatal("device token replay")
	}
}
func TestFilesMaterialMatchingAndPortableMigration(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "student")
	_, task := call(t, s, "POST", "/api/tasks", owner, Object{"title": "报告", "requirements": []any{Object{"label": "报告一", "extensions": []any{"pdf"}, "min_count": 1}, Object{"label": "报告二", "extensions": []any{"pdf"}, "min_count": 1}}})
	route := "/api/tasks/" + str(task, "id")
	code, current := uploaded(t, s, route+"/files?version=1", owner, "../报告.pdf", []byte("fixture"))
	if code != 201 {
		t.Fatal(current)
	}
	_, check := call(t, s, "GET", route+"/check", owner, nil)
	if boolean(check, "ready") {
		t.Fatal("one file satisfies two requirements")
	}
	code, file := uploaded(t, s, "/api/shelf", owner, "receipt.txt", []byte("fixture file text"))
	if code != 201 {
		t.Fatal(file)
	}
	_, assigned := call(t, s, "PUT", "/api/shelf/"+str(file, "id"), owner, Object{"task_id": task["id"], "category": "material", "version": 1})
	if num(assigned, "version") != 2 {
		t.Fatal(assigned)
	}
	r := httptest.NewRequest("GET", "/api/workspace/export", nil)
	r.Header.Set("Authorization", "Bearer "+owner)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	other, _ := login(t, s, "another")
	code, result := uploaded(t, s, "/api/workspace/import", other, "workspace.zip", w.Body.Bytes())
	if code != 200 || num(object(result["imported"]), "files") != 2 {
		t.Fatal(code, result)
	}
	_, replayed := uploaded(t, s, "/api/workspace/import", other, "workspace.zip", w.Body.Bytes())
	if num(object(replayed["imported"]), "tasks") != 0 {
		t.Fatal(replayed)
	}
}
func TestImmediateAutomaticAnalysisAndLenientModelOutput(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "student")
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		writeJSON(w, 200, Object{"choices": []any{Object{"message": Object{"content": store.JSON(Object{"result": Object{"classification": "Task", "confidence": "95%", "title": "测试待办", "due_at": "2026-11-20T18:00:00", "requirements": []any{"PDF 报告"}, "reminder_suggestions": []any{"invalid", "2026-11-20T09:00:00"}}})}}}})
	}))
	defer upstream.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	code, out := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture", "auto_analyze": true})
	if code != 200 {
		t.Fatal(out)
	}
	_, message := call(t, s, "POST", "/api/messages", token, Object{"source": "qq", "account_id": "1", "conversation_id": "g1", "external_id": "1", "text": "11月20日提交报告", "sent_at": "2026-11-07T12:00:00+08:00"})
	if !boolean(message, "analysis_pending") {
		t.Fatal("not pending on ingestion", message)
	}
	select {
	case <-started:
	case <-time.After(4 * time.Second):
		t.Fatal("worker did not start")
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	if str(first(objects(snapshot["messages"])), "analysis_state") != "running" {
		t.Fatal(snapshot)
	}
	close(release)
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		_, snapshot = call(t, s, "GET", "/api/snapshot", token, nil)
		m := first(objects(snapshot["messages"]))
		if result := object(m["analysis"]); len(result) > 0 {
			if num(result, "confidence") != .95 || str(result, "classification") != "actionable" || boolean(m, "analysis_pending") {
				t.Fatal(m)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(snapshot)
}
func TestDraftExtractionAndMalformedClassification(t *testing.T) {
	sent, _ := time.Parse(time.RFC3339, "2026-11-07T12:00:00+08:00")
	draft := extract("11月20日18:00前提交 PDF，不超过20MB", sent)
	if draft["due_at"] != "2026-11-20T18:00:00+08:00" || num(draft, "max_total_bytes") != 20<<20 {
		t.Fatal(draft)
	}
	for _, text := range []string{`{}`, `{"classification":"unknown","title":"不能猜测"}`} {
		if _, err := attempt(func() any { return normalizeAnalysis(robustJSON(text)) }); err == nil {
			t.Fatal("silently classified malformed result")
		}
	}
	raw := robustJSON("```json\n{\"classification\":\"CHAT\",\"reason\":\"正文 ,} 保留\",\"notes\":[\"a\",],}\n```")
	if raw["reason"] != "正文 ,} 保留" {
		t.Fatal(raw)
	}
	for _, value := range []any{"NaN", "Infinity", nil} {
		if confidence(value) != .5 {
			t.Fatal(value)
		}
	}
}
func TestPasswordChangeRevokesSessions(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "student")
	_, result := call(t, s, "POST", "/api/account/password", token, Object{"current_password": "fixture-password-123", "new_password": "new-fixture-password"})
	if !boolean(result, "changed") {
		t.Fatal(result)
	}
	if code, _ := call(t, s, "GET", "/api/snapshot", token, nil); code != 401 {
		t.Fatal("old session retained")
	}
	row := one(context.Background(), s.Store.DB, "SELECT id FROM users WHERE id=?", user)
	if row == nil {
		t.Fatal("account removed")
	}
}
