package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
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

func TestAnalysisAppendsFollowupToExistingTask(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "student")
	messageFields := Object{
		"source":            "wechat",
		"account_id":        "wx-account",
		"conversation_id":   "class-group",
		"conversation_name": "(正式群)25虚拟1班",
		"sender_name":       "王恒",
		"sent_at":           "2026-11-12T10:39:00+08:00",
	}
	firstFields := Object{}
	for key, value := range messageFields {
		firstFields[key] = value
	}
	firstFields["external_id"] = "followup-first"
	firstFields["text"] = "请大家于本周五中午12点前提交3D建模电子版作业，纸质版在下周二图像处理课前收"
	code, firstMessage := call(t, s, "POST", "/api/messages", token, firstFields)
	if code != 201 {
		t.Fatal(firstMessage)
	}
	code, task := call(t, s, "POST", "/api/tasks", token, Object{
		"title":             "3D建模作业提交",
		"description":       str(firstMessage, "text"),
		"due_at":            "2026-11-13T12:00:00+08:00",
		"urgency":           "normal",
		"source_message_id": str(firstMessage, "id"),
	})
	if code != 201 {
		t.Fatal(task)
	}

	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			toolCall := Object{
				"id":   "append-call",
				"type": "function",
				"function": Object{
					"name": "append_to_task",
					"arguments": store.JSON(Object{
						"task_id":    str(task, "id"),
						"submit_url": "https://upload.bansonic.top/ITrGTlKl",
						"reason":     "后续消息补充了同一份3D建模作业的提交链接",
					}),
				},
			}
			writeJSON(w, 200, Object{"choices": []any{Object{"message": Object{"tool_calls": []any{toolCall}}}}})
			return
		}
		content := store.JSON(Object{
			"classification": "actionable",
			"confidence":     0.96,
			"reason":         "后续消息补充了同一份3D建模作业的提交入口",
			"summary":        "已将提交链接追加到已有待办",
			"title":          "3D建模作业提交",
			"due_at":         "2026-11-13T12:00:00+08:00",
			"urgency":        "normal",
			"requirements":   []any{},
			"submit_url":     "https://upload.bansonic.top/ITrGTlKl",
			"evidence":       []any{"三维建模期中过程性考核1收集"},
			"duplicate":      true,
			"duplicate_of":   str(task, "id"),
		})
		writeJSON(w, 200, Object{"choices": []any{Object{"message": Object{"content": content}}}})
	}))
	defer upstream.Close()
	code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{
		"base_url":     upstream.URL,
		"model":        "fixture",
		"auto_task":    true,
		"auto_analyze": false,
	})
	if code != 200 {
		t.Fatal(settings)
	}
	followupFields := Object{}
	for key, value := range messageFields {
		followupFields[key] = value
	}
	followupFields["external_id"] = "followup-link"
	followupFields["sent_at"] = "2026-11-12T10:42:00+08:00"
	followupFields["text"] = "三维建模期中过程性考核1收集\nhttps://upload.bansonic.top/ITrGTlKl"
	code, followup := call(t, s, "POST", "/api/messages", token, followupFields)
	if code != 201 {
		t.Fatal(followup)
	}
	code, analysis := call(t, s, "POST", "/api/analyze", token, Object{
		"message_id":    str(followup, "id"),
		"context_count": 1,
	})
	if code != 200 || str(analysis, "auto_task_action") != "appended" || str(analysis, "duplicate_of") != str(task, "id") {
		t.Fatal(code, analysis)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	var updated Object
	for _, candidate := range objects(snapshot["tasks"]) {
		if str(candidate, "id") == str(task, "id") {
			updated = candidate
			break
		}
	}
	if updated == nil || str(updated, "submit_url") != "https://upload.bansonic.top/ITrGTlKl" {
		t.Fatal(updated)
	}
	if len(objects(updated["source_messages"])) != 2 || len(list(updated, "append_log")) != 1 {
		t.Fatal(updated)
	}
	var analyzed Object
	for _, candidate := range objects(snapshot["messages"]) {
		if str(candidate, "id") == str(followup, "id") {
			analyzed = candidate
			break
		}
	}
	if len(objects(analysis["tools"])) != 1 || str(objects(analysis["tools"])[0], "state") != "done" {
		t.Fatal("notification tool trace missing", analysis)
	}
	if str(analyzed, "auto_task_id") != str(task, "id") || str(object(analyzed["analysis"]), "auto_task_action") != "appended" {
		t.Fatal(analyzed)
	}
}

func TestAppendToTaskRejectsAnotherConversation(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "student")
	_, firstMessage := call(t, s, "POST", "/api/messages", token, Object{
		"source": "qq", "account_id": "qq-account", "conversation_id": "group-a",
		"external_id": "first", "sent_at": "2026-11-12T10:00:00+08:00", "text": "作业通知",
	})
	_, task := call(t, s, "POST", "/api/tasks", token, Object{
		"title": "作业", "source_message_id": str(firstMessage, "id"),
	})
	_, other := call(t, s, "POST", "/api/messages", token, Object{
		"source": "qq", "account_id": "qq-account", "conversation_id": "group-b",
		"external_id": "other", "sent_at": "2026-11-12T10:01:00+08:00", "text": "另一个会话的链接 https://example.com",
	})
	result := s.tools(context.Background(), user, str(other, "id"), "append_to_task", Object{
		"task_id": str(task, "id"), "submit_url": "https://example.com", "reason": "不应跨会话追加",
	})
	if str(result, "error") == "" {
		t.Fatal(result)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	updated := first(objects(snapshot["tasks"]))
	if str(updated, "submit_url") != "" || len(objects(updated["source_messages"])) != 1 {
		t.Fatal(updated)
	}
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

func TestSearchTemplatesRecycleAndPreview(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "productivity")

	code, task := call(t, s, "POST", "/api/tasks", token, Object{
		"title": "每周课程作业", "description": "提交三维建模运行截图",
	})
	if code != 201 {
		t.Fatal(code, task)
	}
	code, search := call(t, s, "GET", "/api/search?q="+url.QueryEscape("三维建模")+"&type=all", token, nil)
	if code != 200 || len(objects(search["items"])) == 0 {
		t.Fatal(code, search)
	}
	code, titleSearch := call(t, s, "GET", "/api/search?q="+url.QueryEscape("每周课程作业")+"&type=task", token, nil)
	if code != 200 || len(objects(titleSearch["items"])) != 1 {
		t.Fatal(code, titleSearch)
	}
	if snippet := str(objects(titleSearch["items"])[0], "snippet"); strings.Contains(snippet, "[]") || strings.Contains(snippet, "null") {
		t.Fatalf("empty structured task fields leaked into search snippet: %q", snippet)
	}

	code, template := call(t, s, "POST", "/api/templates", token, Object{
		"name": "课程作业模板", "task_id": str(task, "id"),
	})
	if code != 200 {
		t.Fatal(code, template)
	}
	code, templates := call(t, s, "GET", "/api/templates", token, nil)
	if code != 200 || len(objects(templates["templates"])) != 1 {
		t.Fatal(code, templates)
	}
	code, created := call(t, s, "POST", "/api/templates/"+str(template, "id")+"/instantiate", token, Object{})
	if code != 200 || str(created, "title") != "每周课程作业" || str(created, "id") == str(task, "id") {
		t.Fatal(code, created)
	}

	code, file := uploaded(t, s, "/api/shelf", token, "预览间距.txt", []byte("这是文件预览间距检查。"))
	if code != 201 {
		t.Fatal(code, file)
	}
	if code, _ := call(t, s, "GET", "/api/files/"+str(file, "id")+"/preview", token, nil); code != 200 {
		t.Fatal("text preview", code)
	}
	code, fileSearch := call(t, s, "GET", "/api/search?q="+url.QueryEscape("预览间距")+"&from=2020-01-01&type=file", token, nil)
	if code != 200 || len(objects(fileSearch["items"])) != 1 {
		t.Fatal(code, fileSearch)
	}

	if code, deleted := call(t, s, "DELETE", "/api/tasks/"+str(task, "id")+"?version=1", token, nil); code != 200 {
		t.Fatal(code, deleted)
	}
	code, recycle := call(t, s, "GET", "/api/recycle", token, nil)
	if code != 200 || len(objects(recycle["items"])) == 0 {
		t.Fatal(code, recycle)
	}
	if code, _ := call(t, s, "POST", "/api/recycle/task/"+str(task, "id")+"/restore", token, Object{}); code != 200 {
		t.Fatal("restore", code)
	}
	if code, restored := call(t, s, "GET", "/api/tasks/"+str(task, "id"), token, nil); code != 200 || str(restored, "title") != "每周课程作业" {
		t.Fatal(code, restored)
	}
	if code, _ := call(t, s, "DELETE", "/api/tasks/"+str(task, "id")+"?version=1", token, nil); code != 200 {
		t.Fatal("delete after restore", code)
	}
	if code, _ := call(t, s, "DELETE", "/api/recycle/task/"+str(task, "id"), token, nil); code != 200 {
		t.Fatal("permanent delete", code)
	}
	if code, _ := call(t, s, "GET", "/api/tasks/"+str(task, "id"), token, nil); code != 404 {
		t.Fatal("deleted task still visible", code)
	}
}

func TestCollectionStatusRequiresUsableRosterIdentity(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "collector")
	_, task := call(t, s, "POST", "/api/tasks", token, Object{"title": "班级材料收集"})
	code, share := call(t, s, "POST", "/api/shares", token, Object{
		"task_id": str(task, "id"), "purpose": "collect",
	})
	if code != 201 && code != 200 {
		t.Fatal(code, share)
	}
	now := store.Now()
	for _, id := range []string{"submission-a", "submission-b"} {
		exec(context.Background(), s.Store.DB, `INSERT INTO share_submissions
			(id,share_id,task_id,user_id,name,contact,note,ip_hash,created_at)
			VALUES(?,?,?,?,?,?,?,?,?)`, id, str(share, "id"), str(task, "id"), user, "匿名", "", "", "ip", now)
	}
	code, before := call(t, s, "GET", "/api/shares/"+str(share, "id")+"/collection-status", token, nil)
	if code != 200 || boolean(before, "has_roster") || num(before, "duplicate_count") != 0 || num(before, "unmatched_count") != 0 {
		t.Fatal(code, before)
	}
	if str(before, "reminder_text") == "名单内成员均已提交，无需催交。\n" {
		t.Fatal(before)
	}

	builder := Object{
		"fields": []any{
			Object{"id": "student_id", "type": "text", "label": "学号", "required": true},
			Object{"id": "name", "type": "text", "label": "姓名", "required": true},
		},
		"roster_fields": []any{"student_id", "name"},
		"roster":        []any{Object{"student_id": "20260001", "name": "张三"}},
		"duplicate":     "reject",
	}
	code, _ = call(t, s, "PUT", "/api/shares/"+str(share, "id"), token, Object{"form": Object{"builder": builder}})
	if code != 200 {
		t.Fatal("update builder", code)
	}
	for index, values := range []Object{
		Object{"student_id": "20260001", "name": "张三"},
		Object{"student_id": "20260001", "name": "张三"},
		Object{"student_id": "", "name": ""},
	} {
		entryID := str([]Object{Object{"id": "submission-a"}, Object{"id": "submission-b"}, Object{"id": "submission-c"}}[index], "id")
		if index == 2 {
			exec(context.Background(), s.Store.DB, `INSERT INTO share_submissions
				(id,share_id,task_id,user_id,name,contact,note,ip_hash,created_at)
				VALUES(?,?,?,?,?,?,?,?,?)`, entryID, str(share, "id"), str(task, "id"), user, "空字段", "", "", "ip", now)
		}
		exec(context.Background(), s.Store.DB, `INSERT INTO collection_entries
			(id,share_id,browser_hash,payload,updated_at) VALUES(?,?,?,?,?)`,
			entryID, str(share, "id"), "browser-"+entryID, store.JSON(values), now)
	}
	code, status := call(t, s, "GET", "/api/shares/"+str(share, "id")+"/collection-status", token, nil)
	if code != 200 || !boolean(status, "has_roster") || num(status, "expected") != 1 ||
		num(status, "submitted") != 1 || num(status, "duplicate_count") != 1 || num(status, "unmatched_count") != 1 {
		t.Fatal(code, status)
	}
	code, result := call(t, s, "GET", "/api/search?q="+url.QueryEscape("张三")+"&type=collection", token, nil)
	if code != 200 || len(objects(result["items"])) == 0 {
		t.Fatal(code, result)
	}
}
