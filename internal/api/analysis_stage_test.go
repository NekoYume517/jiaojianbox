package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

// 阶段分析把一个会话窗口打包成一次模型调用：两条消息只调用一次，
// 模型返回「几个任务」，跨消息的同一件事只落一个任务。
func TestStageAnalysisPacksConversationWindow(t *testing.T) {
	var calls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		messages := objects(body["messages"])
		input := decodeObject(str(messages[len(messages)-1], "content"))
		stage := object(input["STAGE"])
		ids := []any{}
		for _, m := range objects(stage["messages"]) {
			ids = append(ids, str(m, "id"))
		}
		payload, _ := json.Marshal(Object{
			"summary": "群里发布了实验报告提交要求，并补充了提交链接",
			"tasks": []any{Object{
				"title": "提交实验报告", "summary": "11月20日前提交报告，链接已给出",
				"message_ids": ids, "confidence": 0.95, "due_at": "2026-11-20T10:00:00+08:00",
				"urgency": "normal", "requirements": []any{}, "reason": "明确截止与提交入口",
				"submit_url": "https://upload.example.test/report", "evidence": []any{"11月20日前提交"},
			}},
			"no_task_messages": []any{},
		})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Object{
			"choices": []any{Object{"message": Object{"content": string(payload)}}},
			"usage":   Object{"total_tokens": 500},
		})
	}))
	defer upstream.Close()

	s := testServer(t)
	token, _ := login(t, s, "stage@example.com")
	call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom", "base_url": upstream.URL, "model": "fixture",
		"auto_analyze": true, "auto_task": true, "local_triage": false, "batch_triage": false,
	})
	for _, text := range []string{"11月20日前提交实验报告", "提交链接：https://upload.example.test/report"} {
		status, out := call(t, s, "POST", "/api/messages", token, Object{
			"source": "wechat", "account_id": "wx-1", "conversation_id": "room@chatroom",
			"conversation_name": "实验群", "external_id": text[:6],
			"text": text, "sent_at": "2026-11-15T09:00:00+08:00",
			"sender_id": "x",
		})
		if status != 201 {
			t.Fatalf("ingest: %v", out)
		}
	}
	user := ownerOf(t, s)
	_, listing := call(t, s, "GET", "/api/agent/sessions", token, nil)
	sessionID := str(objects(listing["sessions"])[0], "id")
	if code, value := call(t, s, "PATCH", "/api/agent/sessions/"+sessionID, token, Object{"permission": "full"}); code != 200 {
		t.Fatal(value)
	}
	groups := s.pendingStageGroups(testContext(), user)
	if len(groups) != 1 {
		t.Fatalf("expected 1 ready stage group, got %d", len(groups))
	}
	if len(groups[0].Messages) != 2 {
		t.Fatalf("expected window of 2 messages, got %d", len(groups[0].Messages))
	}
	s.claimStageGroup(testContext(), user, groups[0])
	outcome, err := s.runStageAnalysis(testContext(), user, groups[0], nil)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Written != 2 {
		t.Fatalf("expected 2 written, got %d", outcome.Written)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected exactly 1 model call, got %d", calls)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	for _, m := range objects(snapshot["messages"]) {
		result := object(m["analysis"])
		if str(result, "classification") != "actionable" || !boolean(result, "stage") {
			t.Fatalf("stage analysis missing on message: %v", m["text"])
		}
		if boolean(m, "analysis_pending") {
			t.Fatalf("message still pending: %v", m["text"])
		}
	}
	tasks := objects(snapshot["tasks"])
	if len(tasks) != 1 {
		t.Fatalf("expected 1 stage task, got %d", len(tasks))
	}
	if len(objects(tasks[0]["source_messages"])) != 2 {
		t.Fatalf("stage task should reference both messages: %v", tasks[0])
	}
	row := first(query(testContext(), s.Store.DB,
		"SELECT COUNT(*) AS n FROM analysis_jobs WHERE state<>'done'", user))
	if num(row, "n") != 0 {
		t.Fatalf("jobs not settled: %v", row)
	}
}

// 静默不足 1 分钟的会话不应触发；最老消息等待超过上限后强制触发。
func TestStageAnalysisWaitsForIdle(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "stage-idle@example.com")
	call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom", "base_url": "http://127.0.0.1:1", "model": "dead",
		"auto_analyze": true, "local_triage": false, "batch_triage": false,
	})
	now := time.Now().UTC().Format(time.RFC3339Nano)
	status, out := call(t, s, "POST", "/api/messages", token, Object{
		"source": "qq", "account_id": "1", "conversation_id": "g1", "external_id": "now",
		"text": "刚发的消息", "sent_at": now, "sender_id": "x",
	})
	if status != 201 {
		t.Fatal(out)
	}
	user := ownerOf(t, s)
	if groups := s.pendingStageGroups(testContext(), user); len(groups) != 0 {
		t.Fatalf("fresh message must wait for idle, got %d groups", len(groups))
	}
	// 把 sent_at 改到 2 分钟前，立即满足静默条件。
	exec(testContext(), s.Store.DB,
		"UPDATE messages SET payload=json_set(payload,'$.sent_at',?) WHERE user_id=?",
		time.Now().Add(-2*time.Minute).UTC().Format(time.RFC3339Nano), user)
	groups := s.pendingStageGroups(testContext(), user)
	if len(groups) != 1 {
		t.Fatalf("expected 1 ready group after idle, got %d", len(groups))
	}
}

// 模型不可用时阶段整窗退回 queued，超过次数转 failed 并写回错误。
func TestStageAnalysisFailureRetries(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "stage-fail@example.com")
	call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom", "base_url": "http://127.0.0.1:1", "model": "dead",
		"auto_analyze": true, "local_triage": false, "batch_triage": false,
	})
	status, _ := call(t, s, "POST", "/api/messages", token, Object{
		"source": "wechat", "account_id": "wx-1", "conversation_id": "room@chatroom",
		"external_id": "f1", "text": "周五前提交实验报告",
		"sent_at": "2026-11-12T10:00:00+08:00", "sender_id": "x",
	})
	if status != 201 {
		t.Fatal("ingest failed")
	}
	user := ownerOf(t, s)
	groups := s.pendingStageGroups(testContext(), user)
	if len(groups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(groups))
	}
	if _, err := s.runStageAnalysis(testContext(), user, groups[0], nil); err == nil {
		t.Fatal("expected error on dead model")
	}
	s.failStageGroup(testContext(), user, groups[0], "阶段分析暂不可用，稍后自动重试")
	row := first(query(testContext(), s.Store.DB, "SELECT state FROM analysis_jobs WHERE user_id=?", user))
	if str(row, "state") != "queued" {
		t.Fatalf("expected queued after first failure, got %v", row)
	}
	// 继续失败：达到重试上限后 job 转 failed，并把错误写回消息。
	groups[0].Attempts = stageMaxRetry
	s.failStageGroup(testContext(), user, groups[0], "阶段分析暂不可用，稍后自动重试")
	row = first(query(testContext(), s.Store.DB, "SELECT state FROM analysis_jobs WHERE user_id=?", user))
	if str(row, "state") != "failed" {
		t.Fatalf("expected failed after retries, got %v", row)
	}
	row = first(query(testContext(), s.Store.DB,
		"SELECT json_extract(payload,'$.analysis_error') AS err FROM messages WHERE user_id=?", user))
	if !strings.Contains(str(row, "err"), "自动分析失败") {
		t.Fatalf("failed stage did not write error to message: %v", row)
	}
}

// 旧批量/单条格式（items[] 每条一个 verdict）自动映射成阶段任务或闲聊。
func TestLegacyItemsFallback(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		messages := objects(body["messages"])
		input := decodeObject(str(messages[len(messages)-1], "content"))
		stageIDs := []string{}
		for _, m := range objects(object(input["STAGE"])["messages"]) {
			stageIDs = append(stageIDs, str(m, "id"))
		}
		payload, _ := json.Marshal(Object{
			"items": []any{
				Object{"id": stageIDs[0], "classification": "actionable", "confidence": 0.9,
					"reason": "fixture", "summary": "fixture 摘要", "title": "旧格式任务",
					"due_at": nil, "urgency": "normal", "reminder_suggestions": []any{},
					"requirements": []any{}, "max_total_bytes": nil, "naming_hint": "",
					"submit_url": "", "evidence": []any{}, "duplicate": false, "duplicate_of": nil, "notes": []any{}},
				Object{"id": stageIDs[1], "classification": "chatting", "confidence": 0.8,
					"reason": "fixture", "summary": "fixture 摘要", "title": "",
					"due_at": nil, "urgency": "normal", "reminder_suggestions": []any{},
					"requirements": []any{}, "max_total_bytes": nil, "naming_hint": "",
					"submit_url": "", "evidence": []any{}, "duplicate": false, "duplicate_of": nil, "notes": []any{}},
			},
		})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Object{
			"choices": []any{Object{"message": Object{"content": string(payload)}}},
			"usage":   Object{"total_tokens": 300},
		})
	}))
	defer upstream.Close()
	s := testServer(t)
	token, _ := login(t, s, "legacy@example.com")
	call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom", "base_url": upstream.URL, "model": "fixture",
		"auto_analyze": true, "local_triage": false, "batch_triage": false,
	})
	for _, item := range []Object{
		{"external_id": "x1", "text": "周五前提交报告", "sent_at": "2026-11-12T10:00:00+08:00"},
		{"external_id": "x2", "text": "哈哈好的", "sent_at": "2026-11-12T10:01:00+08:00"},
	} {
		status, out := call(t, s, "POST", "/api/messages", token, Object{
			"source": "wechat", "account_id": "wx-1", "conversation_id": "room@chatroom",
			"external_id": item["external_id"], "text": item["text"], "sent_at": item["sent_at"],
			"sender_id": "x",
		})
		if status != 201 {
			t.Fatal(out)
		}
	}
	user := ownerOf(t, s)
	groups := s.pendingStageGroups(testContext(), user)
	outcome, err := s.runStageAnalysis(testContext(), user, groups[0], nil)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Written != 2 {
		t.Fatalf("legacy items fallback should write both, got %d", outcome.Written)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	byText := map[string]string{}
	for _, m := range objects(snapshot["messages"]) {
		byText[str(m, "text")] = str(object(m["analysis"]), "classification")
	}
	if byText["周五前提交报告"] != "actionable" || byText["哈哈好的"] != "chatting" {
		t.Fatalf("legacy fallback mapping wrong: %v", byText)
	}
}

func ownerOf(t *testing.T, s *Server) string {
	t.Helper()
	row := first(query(testContext(), s.Store.DB, "SELECT user_id FROM messages LIMIT 1"))
	if row == nil {
		t.Fatal("no messages")
	}
	return str(row, "user_id")
}

var _ = store.JSON
