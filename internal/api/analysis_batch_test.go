package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// 一次批量调用应覆盖整批消息，且只调用一次模型。
func TestBatchAnalysisOneCallPerBatch(t *testing.T) {
	var calls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		user := ""
		if items := objects(body["messages"]); len(items) > 0 {
			user = str(items[len(items)-1], "content")
		}
		parsed := decodeObject(user)
		items := []any{}
		for _, m := range objects(parsed["MESSAGES"]) {
			id := str(m, "id")
			text := str(m, "text")
			verdict := "chatting"
			title := ""
			if strings.Contains(text, "报告") || strings.Contains(text, "开会") {
				verdict = "actionable"
				title = clip(text, 20)
			}
			items = append(items, Object{
				"id": id, "classification": verdict, "confidence": 0.9,
				"reason": "fixture", "summary": "fixture 摘要", "title": title,
				"due_at": nil, "urgency": "normal", "reminder_suggestions": []any{},
				"requirements": []any{}, "max_total_bytes": nil, "naming_hint": "",
				"submit_url": "", "evidence": []any{}, "duplicate": false,
				"duplicate_of": nil, "notes": []any{},
			})
		}
		payload, _ := json.Marshal(Object{"items": items})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Object{
			"choices": []any{Object{"message": Object{"content": string(payload)}}},
			"usage":   Object{"total_tokens": 500},
		})
	}))
	defer upstream.Close()

	s := testServer(t)
	token, _ := login(t, s, "batch@example.com")
	call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom", "base_url": upstream.URL, "model": "fixture",
		"auto_analyze": true, "local_triage": false, "batch_triage": false,
	})
	// 4 条消息直接入深度分析队列（batch_triage=false）。
	for i, text := range []string{"周五前提交实验报告", "哈哈好", "明天下午三点开会", "也行"} {
		status, out := call(t, s, "POST", "/api/messages", token, Object{
			"source": "wechat", "account_id": "wx-1", "conversation_id": "room@chatroom",
			"conversation_name": "群", "external_id": "b" + string(rune('a'+i)),
			"text": text, "sent_at": "2026-11-01T10:0" + string(rune('0'+i)) + ":00Z",
			"sender_id": "x",
		})
		if status != 201 {
			t.Fatalf("ingest %d: %v", status, out)
		}
	}
	// 直接走批量路径（模拟 worker 的凑批触发）。
	targets := s.gatherBatchTargets(testContext(), ownerOf(t, s), batchAnalysisSize)
	if len(targets) != 4 {
		t.Fatalf("expected 4 targets, got %d", len(targets))
	}
	written := s.runBatchAnalysis(testContext(), ownerOf(t, s), targets, nil)
	if written != 4 {
		t.Fatalf("expected 4 written, got %d", written)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected exactly 1 model call, got %d", calls)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	actionable := 0
	chatting := 0
	for _, m := range objects(snapshot["messages"]) {
		result := object(m["analysis"])
		switch str(result, "classification") {
		case "actionable":
			actionable++
		case "chatting":
			chatting++
		}
		if boolean(m, "analysis_pending") {
			t.Fatalf("message still pending: %v", m["text"])
		}
		if !boolean(result, "batch") {
			t.Fatalf("result missing batch flag: %v", m["text"])
		}
	}
	if actionable != 2 || chatting != 2 {
		t.Fatalf("expected 2 actionable + 2 chatting, got %d/%d", actionable, chatting)
	}
	// 全部 job 应已收尾。
	row := first(query(testContext(), s.Store.DB,
		"SELECT COUNT(*) AS n FROM analysis_jobs WHERE state<>'done'", ownerOf(t, s)))
	if num(row, "n") != 0 {
		t.Fatalf("jobs not settled: %v", row)
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

// 批量整体失败时 job 应回到 queued，超过次数转 failed。
func TestBatchAnalysisFailureRetries(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "batchfail@example.com")
	call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom", "base_url": "http://127.0.0.1:1", "model": "dead",
		"auto_analyze": true, "local_triage": false, "batch_triage": false,
	})
	call(t, s, "POST", "/api/messages", token, Object{
		"source": "wechat", "account_id": "wx-1", "conversation_id": "room@chatroom",
		"external_id": "f1", "text": "周五前提交实验报告",
		"sent_at": "2026-11-01T10:00:00Z", "sender_id": "x",
	})
	user := ownerOf(t, s)
	targets := s.gatherBatchTargets(testContext(), user, batchAnalysisSize)
	if len(targets) != 1 {
		t.Fatalf("expected 1 target, got %d", len(targets))
	}
	if got := s.runBatchAnalysis(testContext(), user, targets, nil); got != -1 {
		t.Fatalf("expected -1 on connection failure, got %d", got)
	}
	s.failBatchJobs(testContext(), user, targets)
	row := first(query(testContext(), s.Store.DB,
		"SELECT state FROM analysis_jobs WHERE user_id=?", user))
	if str(row, "state") != "queued" {
		t.Fatalf("expected queued after first failure, got %v", row)
	}
}
