package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestNotificationWindowGroupsConversationAndDefersUntilQuiet(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "window")
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		parts := objects(body["messages"])
		content := objects(object(parts[len(parts)-1])["content"])
		packet := decodeObject(str(object(content[0]), "text"))
		messages := objects(packet["MESSAGES"])
		if len(messages) != 2 && len(messages) != 1 {
			t.Errorf("expected both window messages in one request: %v", packet)
		}
		items := []Object{}
		for _, message := range messages {
			items = append(items, Object{"id": str(message, "id"), "classification": "chatting", "confidence": .9, "requirements": []any{}, "summary": "合并完成"})
		}
		writeJSON(w, 200, textCompletion(store.JSON(Object{"items": items})))
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture", "auto_analyze": true})
	ingest := func(chat, external string) Object {
		code, message := call(t, s, "POST", "/api/messages", token, Object{"source": "wechat", "account_id": "wx", "conversation_id": chat, "external_id": external, "text": "提交作业 " + external, "sent_at": "2026-11-17T12:00:00+08:00"})
		if code != 201 {
			t.Fatal(message)
		}
		return message
	}
	first := ingest("one", "first")
	second := ingest("one", "second")
	other := ingest("other", "other")
	if str(first, "analysis_batch_id") != str(second, "analysis_batch_id") || str(first, "analysis_batch_id") == str(other, "analysis_batch_id") {
		t.Fatal("window is not isolated by conversation")
	}
	before := num(firstRow(t, s, "SELECT ready_at FROM analysis_batches WHERE id=?", str(first, "analysis_batch_id")), "ready_at")
	time.Sleep(50 * time.Millisecond)
	ingest("one", "third")
	after := num(firstRow(t, s, "SELECT ready_at FROM analysis_batches WHERE id=?", str(first, "analysis_batch_id")), "ready_at")
	if after <= before || calls != 0 {
		t.Fatal("new message did not extend quiet window", before, after, calls)
	}
	exec(context.Background(), s.Store.DB, "DELETE FROM analysis_batch_items WHERE message_id=(SELECT id FROM messages WHERE user_id=? AND json_extract(payload,'$.external_id')='third')", user)
	exec(context.Background(), s.Store.DB, "UPDATE analysis_batches SET ready_at=0")
	s.wakeNotificationWorker()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && calls < 2 {
		time.Sleep(20 * time.Millisecond)
	}
	if calls != 2 {
		t.Log(firstRow(t, s, "SELECT * FROM agent_runs"))
		t.Fatal("expected one request for each conversation", calls, firstRow(t, s, "SELECT * FROM analysis_batches"))
	}
	for time.Now().Before(deadline) {
		_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
		complete := 0
		for _, m := range objects(snapshot["messages"]) {
			if str(m, "external_id") != "third" && len(object(m["analysis"])) > 0 {
				complete++
			}
		}
		if complete == 3 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("window results did not settle")
}

func TestNotificationWindowAppendsSameTaskOnce(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "window-append")
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		messages := objects(body["messages"])
		parts := objects(object(messages[len(messages)-1])["content"])
		packet := decodeObject(str(object(parts[0]), "text"))
		tasks := objects(packet["USER_TASKS"])
		if len(tasks) == 0 {
			t.Fatal("existing task missing")
		}
		items := []Object{}
		for _, message := range objects(packet["MESSAGES"]) {
			items = append(items, Object{"id": str(message, "id"), "classification": "actionable", "confidence": .96, "title": str(tasks[0], "title"), "duplicate": true, "duplicate_of": str(tasks[0], "id"), "submit_url": "https://upload.example/submit", "requirements": []any{}, "summary": "已合并任务与链接"})
		}
		writeJSON(w, 200, textCompletion(store.JSON(Object{"items": items})))
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture", "auto_analyze": true})
	var batchID string
	for index, text := range []string{"请提交 3D 建模作业", "收集入口 https://upload.example/submit"} {
		code, m := call(t, s, "POST", "/api/messages", token, Object{"source": "wechat", "account_id": "wx", "conversation_id": "class", "conversation_name": "班级群", "external_id": string(rune('a' + index)), "text": text, "sent_at": "2026-11-17T12:00:00+08:00"})
		if code != 201 {
			t.Fatal(m)
		}
		batchID = str(m, "analysis_batch_id")
		if index == 0 {
			code, created := call(t, s, "POST", "/api/tasks", token, Object{"title": "3D 建模作业", "source_message_id": str(m, "id")})
			if code != 201 {
				t.Fatal("create fixture task", code, created, m, firstRow(t, s, "SELECT id,user_id FROM messages"))
			}
		}
	}
	exec(context.Background(), s.Store.DB, "UPDATE analysis_batches SET ready_at=0 WHERE id=?", batchID)
	s.wakeNotificationWorker()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, snap := call(t, s, "GET", "/api/snapshot", token, nil)
		tasks := objects(snap["tasks"])
		if len(tasks) == 1 && str(tasks[0], "submit_url") == "https://upload.example/submit" {
			if len(objects(tasks[0]["source_messages"])) != 2 || calls != 1 {
				t.Fatal("window duplicated task or request", tasks, calls)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("window did not append same task", firstRow(t, s, "SELECT * FROM analysis_batches"), firstRow(t, s, "SELECT * FROM agent_runs"), firstRow(t, s, "SELECT id,user_id FROM messages"))
}

func TestNotificationWindowDoesNotCreateTasksForSupplements(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "window-supplements")
	parentID := store.ID()
	imageID := store.ID()
	linkID := store.ID()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items := []Object{
			{"id": parentID, "classification": "actionable", "confidence": .96, "title": "提交课程报告", "summary": "建立课程报告待办", "requirements": []any{}},
			{"id": imageID, "parent_id": parentID, "classification": "actionable", "confidence": .96, "title": "核对报告封面", "summary": "补充报告封面", "requirements": []any{}},
			{"id": linkID, "parent_id": parentID, "classification": "actionable", "confidence": .96, "title": "报告提交链接", "summary": "补充提交入口", "submit_url": "https://upload.example/report", "requirements": []any{}},
		}
		writeJSON(w, 200, textCompletion(store.JSON(Object{"items": items})))
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture", "auto_analyze": true})
	batch := Object{"id": store.ID(), "user_id": user, "source": "wechat", "account_id": "wx", "conversation_id": "class"}
	batch["session_id"] = s.ensureConversationSession(context.Background(), s.Store.DB, user, batch, 262144)
	for _, id := range []string{parentID, imageID, linkID} {
		message := Object{"id": id, "source": "wechat", "account_id": "wx", "conversation_id": "class", "text": "课程报告消息", "sent_at": store.Now(), "created_at": store.Now()}
		exec(context.Background(), s.Store.DB, "INSERT INTO messages(id,user_id,payload,created_at) VALUES(?,?,?,?)", id, user, store.JSON(message), message["created_at"])
	}
	exec(context.Background(), s.Store.DB, "INSERT INTO analysis_batches(id,user_id,source,account_id,conversation_id,session_id,latest_at,ready_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", batch["id"], user, "wechat", "wx", "class", batch["session_id"], store.Now(), float64(0), store.Now(), store.Now())
	for _, id := range []string{parentID, imageID, linkID} {
		exec(context.Background(), s.Store.DB, "INSERT INTO analysis_batch_items(batch_id,message_id) VALUES(?,?)", batch["id"], id)
	}
	results := map[string]Object{}
	for _, item := range objects(decodeObject(`{"items":[{"id":"`+parentID+`","classification":"actionable","confidence":0.96,"title":"提交课程报告","summary":"建立课程报告待办"},{"id":"`+imageID+`","parent_id":"`+parentID+`","classification":"actionable","confidence":0.96,"title":"核对报告封面","summary":"补充报告封面"},{"id":"`+linkID+`","parent_id":"`+parentID+`","classification":"actionable","confidence":0.96,"title":"报告提交链接","summary":"补充提交入口","submit_url":"https://upload.example/report"}]}`)["items"]) {
		item["requirements"] = []any{}
		item["reminders"] = []any{}
		item["reminder_suggestions"] = []any{}
		results[str(item, "id")] = item
	}
	s.finishNotificationBatch(context.Background(), batch, results, map[string]bool{})
	tasks := objects(s.snapshot(context.Background(), user).(Object)["tasks"])
	if len(tasks) != 1 {
		t.Fatalf("supplements created extra tasks: %v", tasks)
	}
	if str(tasks[0], "title") != "提交课程报告" || str(tasks[0], "submit_url") != "https://upload.example/report" {
		t.Fatalf("parent task did not receive link: %v", tasks[0])
	}
	if len(objects(tasks[0]["source_messages"])) != 3 {
		t.Fatalf("supplements not linked to parent: %v", tasks[0])
	}
}
