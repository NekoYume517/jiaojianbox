package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func testContext() context.Context { return context.Background() }

func TestLocalTriageDropsNoiseWithoutModel(t *testing.T) {
	cases := []struct {
		text    string
		verdict string
	}{
		{"[微笑]", "noise"},
		{"[图片][图片]", "noise"},
		{"好的", "noise"},
		{"666", "noise"},
		{`"张三"加入了群聊`, "noise"},
		{"11月20日18:00前提交实验报告 PDF", "strong"},
		{"周五截止，记得报名", "strong"},
		{"今晚一起吃饭吗", "unknown"},
		{"明天有空吗", "unknown"},
	}
	for _, item := range cases {
		m := Object{"text": item.text, "sender_id": "wxid_x", "account_id": "wxid_me"}
		if got := localTriage(m).Verdict; got != item.verdict {
			t.Fatalf("text=%q expected %s got %s", item.text, item.verdict, got)
		}
	}
}

func TestLocalTriageSkipsOwnMessages(t *testing.T) {
	m := Object{"text": "周五前提交报告", "sender_id": "wxid_me", "account_id": "wxid_me"}
	if got := localTriage(m).Verdict; got != "unknown" {
		t.Fatalf("own message should not be strong, got %s", got)
	}
}

// 批量分诊只应对一批消息调一次模型，并把闲聊标掉、可操作消息升级。
func TestBatchTriageGroupsAndUpgrades(t *testing.T) {
	var calls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		user := ""
		if items := objects(body["messages"]); len(items) > 0 {
			user = str(items[len(items)-1], "content")
		}
		// 按消息逐条判断：只有含「报告」的那条是 actionable。
		items := []any{}
		for _, piece := range strings.Split(user, `"id":"`)[1:] {
			end := strings.IndexByte(piece, '"')
			if end < 0 {
				continue
			}
			id := piece[:end]
			next := strings.IndexByte(piece, '{')
			segment := piece
			if next >= 0 {
				segment = piece[:next]
			}
			verdict := "chatting"
			if strings.Contains(segment, "报告") {
				verdict = "actionable"
			}
			items = append(items, Object{"id": id, "verdict": verdict, "confidence": 0.8, "reason": "fixture"})
		}
		text, _ := json.Marshal(Object{"items": items})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Object{
			"choices": []any{Object{"message": Object{"content": string(text)}}},
			"usage":   Object{"total_tokens": 42},
		})
	}))
	defer upstream.Close()

	s := testServer(t)
	token, _ := login(t, s, "triage@example.com")
	if status, out := call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom", "base_url": upstream.URL, "model": "fixture",
		"auto_analyze": true, "local_triage": false, "batch_triage": true,
	}); status != 200 {
		t.Fatalf("llm settings %d %v", status, out)
	}
	for i, text := range []string{"今晚吃什么", "周五前提交报告", "哈哈哈"} {
		status, out := call(t, s, "POST", "/api/messages", token, Object{
			"source": "wechat", "account_id": "wxid_a", "conversation_id": "room@chatroom",
			"conversation_name": "群", "external_id": "m" + string(rune('a'+i)),
			"sender_name": "小明", "sender_id": "wxid_x", "text": text,
			"sent_at": "2026-11-01T10:00:00Z", "message_type": "text",
		})
		if status != 201 {
			t.Fatalf("message %d %v", status, out)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("batch triage should not be synchronous, got %d calls", got)
	}
	// 时间推进不现实，这里直接调用 worker 的一次迭代逻辑。
	groups := s.pendingTriageGroups(testContext(), true)
	if len(groups) != 1 || len(groups[0].Messages) != 3 {
		t.Fatalf("expected one group with 3 messages, got %+v", groups)
	}
	verdicts := s.triageBatch(testContext(), groups[0].User, groups[0].Messages, nil)
	if verdicts == nil || len(verdicts) != 3 {
		t.Fatalf("unexpected verdicts %v", verdicts)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected exactly one model call for the batch, got %d", got)
	}
	s.applyTriage(testContext(), groups[0], verdicts)

	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	upgraded := 0
	chatting := 0
	for _, m := range objects(snapshot["messages"]) {
		if str(m, "triage_state") != "done" {
			t.Fatalf("triage not applied: %v", m)
		}
		if boolean(m, "analysis_pending") {
			upgraded++
		}
		if result := object(m["triage_result"]); str(result, "verdict") == "chatting" {
			chatting++
		}
	}
	if upgraded != 1 || chatting != 2 {
		t.Fatalf("expected 1 upgraded and 2 chatting, got %d/%d: %v", upgraded, chatting, snapshot["messages"])
	}
}
