package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 摘要接口依赖外部模型；这里用一个本地假上游验证完整链路。
func stubDigestUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	var captured []Object
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		captured = append(captured, body)
		mu.Unlock()
		messages := object(body["messages"])
		_ = messages
		user := ""
		if items := objects(body["messages"]); len(items) > 0 {
			user = str(items[len(items)-1], "content")
		}
		ids := []any{}
		for _, piece := range strings.Split(user, "\"id\": \"")[1:] {
			if end := strings.IndexByte(piece, '"'); end > 0 {
				ids = append(ids, piece[:end])
			}
			if len(ids) >= 2 {
				break
			}
		}
		payload := Object{
			"headline":   "群里在讨论周末活动",
			"topics":     []any{Object{"title": "活动安排", "summary": "约了周六下午", "messages": ids}},
			"decisions":  []any{"周六下午集合"},
			"todo_hints": []any{},
		}
		text, _ := json.Marshal(payload)
		response := Object{
			"choices": []any{Object{"message": Object{"role": "assistant", "content": string(text)}}},
			"usage":   Object{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestDigestGroupsMessagesAndKeepsOriginals(t *testing.T) {
	s := testServer(t)
	upstream := stubDigestUpstream(t)
	token, _ := login(t, s, "digest@example.com")
	if status, out := call(t, s, "PUT", "/api/settings/llm", token, Object{
		"service_mode": "custom",
		"base_url":     upstream.URL,
		"model":        "fixture-model",
		"auto_analyze": false,
	}); status != 200 {
		t.Fatalf("llm settings %d %v", status, out)
	}
	makeMessage := func(external, text string) Object {
		status, out := call(t, s, "POST", "/api/messages", token, Object{
			"source": "wechat", "account_id": "wxid_a", "conversation_id": "123@chatroom",
			"conversation_name": "测试群", "external_id": external,
			"sender_name": "小明", "sender_id": "wxid_x", "text": text,
			"sent_at": "2026-11-01T10:00:00Z", "message_type": "text",
		})
		if status != 201 {
			t.Fatalf("message %d %v", status, out)
		}
		return out
	}
	first := makeMessage("m1", "周六下午有人去爬山吗")
	second := makeMessage("m2", "我报名")

	status, digest := call(t, s, "POST", "/api/digests", token, Object{
		"source": "wechat", "account_id": "wxid_a", "conversation_id": "123@chatroom",
		"force": true, "min_age_seconds": 0,
	})
	if status != 200 {
		t.Fatalf("digest create %d %v", status, digest)
	}
	if str(digest, "headline") == "" {
		t.Fatalf("digest missing headline: %v", digest)
	}
	ids := list(digest, "message_ids")
	if len(ids) != 2 {
		t.Fatalf("expected both messages summarized, got %v", ids)
	}

	status, detail := call(t, s, "GET", "/api/digests/"+str(digest, "id"), token, nil)
	if status != 200 || len(objs(detail["messages"])) != 2 {
		t.Fatalf("digest detail %d %v", status, detail)
	}

	// 已汇总的消息再次调用应返回空（没有新的候选）。
	status, again := call(t, s, "POST", "/api/digests", token, Object{
		"source": "wechat", "account_id": "wxid_a", "conversation_id": "123@chatroom", "force": true,
	})
	if status != 200 || again != nil {
		t.Fatalf("second digest should be empty, got %d %v", status, again)
	}

	// 删除摘要后原始消息重新进入候选。
	if status, out := call(t, s, "DELETE", "/api/digests/"+str(digest, "id"), token, nil); status != 200 {
		t.Fatalf("digest delete %d %v", status, out)
	}
	status, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	if status != 200 {
		t.Fatalf("snapshot %d", status)
	}
	if digests := objs(snapshot["digests"]); len(digests) != 0 {
		t.Fatalf("snapshot should not carry the deleted digest: %v", digests)
	}
	for _, message := range objs(snapshot["messages"]) {
		if str(message, "digest_id") != "" {
			t.Fatalf("message still bound to digest: %v", message)
		}
	}
	_ = first
	_ = second
}

func objs(value any) []Object {
	out := []Object{}
	items, _ := value.([]any)
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			out = append(out, object)
		}
	}
	return out
}
