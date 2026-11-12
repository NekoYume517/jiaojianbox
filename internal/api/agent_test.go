package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func agentUpstream(t *testing.T, handler func(int, Object) Object) *httptest.Server {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, handler(int(calls.Add(1)), body))
	}))
	t.Cleanup(server.Close)
	return server
}

func textCompletion(content string) Object {
	return Object{"choices": []any{Object{"message": Object{"role": "assistant", "content": content}}}}
}

func toolCompletion(name string, args Object) Object {
	return Object{"choices": []any{Object{"message": Object{
		"role": "assistant",
		"tool_calls": []any{Object{
			"id":   "call-1",
			"type": "function",
			"function": Object{
				"name":      name,
				"arguments": store.JSON(args),
			},
		}},
	}}}}
}

func TestAgentPermissionBoundaryAndTools(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "agent-user")
	upstream := agentUpstream(t, func(call int, _ Object) Object {
		if call == 1 || call == 3 {
			return toolCompletion("create_task", Object{"title": "AI 创建的待办"})
		}
		return textCompletion("已处理")
	})
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture"}); code != 200 {
		t.Fatal(settings)
	}

	code, result := call(t, s, "POST", "/api/agent/chat", token, Object{"message": "创建一个待办", "permission": "restricted"})
	if code != 200 {
		t.Fatal(result)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	if tasks := objects(snapshot["tasks"]); len(tasks) != 0 {
		t.Fatalf("restricted mode created a task: %v", tasks)
	}
	tools := objects(result["message"].(map[string]any)["tools"])
	if len(tools) != 1 || boolean(tools[0], "ok") {
		t.Fatalf("restricted tool must be denied: %v", tools)
	}

	code, result = call(t, s, "POST", "/api/agent/chat", token, Object{"message": "现在创建一个待办", "permission": "full"})
	if code != 200 {
		t.Fatal(result)
	}
	_, snapshot = call(t, s, "GET", "/api/snapshot", token, nil)
	tasks := objects(snapshot["tasks"])
	if len(tasks) != 1 || str(tasks[0], "title") != "AI 创建的待办" {
		t.Fatalf("full mode task missing: %v", tasks)
	}
}

func TestAgentCompressesFirstHalfAndKeepsHistory(t *testing.T) {
	s := testServer(t)
	token, userID := login(t, s, "context-user")
	_, _ = s.Store.DB.Exec(`INSERT INTO agent_state(user_id,summary,permission,context_limit,last_prompt_tokens,last_total_tokens,updated_at)
		VALUES(?,?,?,?,?,?,?)`, userID, "", "restricted", 8192, 0, 0, store.Now())
	for index := 0; index < 20; index++ {
		message := Object{
			"id":         store.ID(),
			"role":       "user",
			"content":    strings.Repeat("这是一段需要压缩并保留事实的旧对话。", 60),
			"created_at": time.Now().UTC().Add(time.Duration(index) * time.Second).Format(time.RFC3339Nano),
		}
		_, err := s.Store.DB.Exec("INSERT INTO agent_messages(id,user_id,payload,summarized,created_at) VALUES(?,?,?,?,?)", message["id"], userID, store.JSON(message), 0, message["created_at"])
		if err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	var sawCompression, sawSummary bool
	upstream := agentUpstream(t, func(call int, body Object) Object {
		mu.Lock()
		defer mu.Unlock()
		messages := objects(body["messages"])
		if call == 1 {
			sawCompression = len(messages) == 1 && strings.Contains(str(messages[0], "content"), "压缩成事实摘要")
			return textCompletion("历史对话摘要：用户持续准备作业，仍需检查材料。")
		}
		sawSummary = strings.Contains(store.JSON(messages), "此前对话的动态摘要")
		return textCompletion("已完成检查。")
	})
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture"}); code != 200 {
		t.Fatal(settings)
	}
	code, result := call(t, s, "POST", "/api/agent/chat", token, Object{"message": "继续检查", "permission": "restricted"})
	if code != 200 {
		t.Fatal(result)
	}
	if !sawCompression || !sawSummary {
		t.Fatalf("compression calls not observed: compression=%v summary=%v", sawCompression, sawSummary)
	}
	_, thread := call(t, s, "GET", "/api/agent/thread", token, nil)
	context := object(thread["context"])
	if num(context, "compressed_count") != 10 || !strings.Contains(str(context, "summary"), "历史对话摘要") {
		t.Fatalf("unexpected context: %v", context)
	}
	if len(objects(thread["messages"])) != 22 {
		t.Fatalf("history should retain all original messages: %d", len(objects(thread["messages"])))
	}
	if code, cleared := call(t, s, "DELETE", "/api/agent/thread", token, nil); code != 200 || str(object(cleared["context"]), "summary") != "" {
		t.Fatalf("clear failed: %v", cleared)
	}
}

func TestAgentInvalidToolResultDoesNotAbortConversation(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "agent-tool-error")
	upstream := agentUpstream(t, func(call int, _ Object) Object {
		if call == 1 {
			return toolCompletion("set_task_status", Object{"task_id": "missing", "status": "not-a-status"})
		}
		return textCompletion("工具参数无效，但没有中断整轮对话。")
	})
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture"}); code != 200 {
		t.Fatal(settings)
	}

	code, result := call(t, s, "POST", "/api/agent/chat", token, Object{"message": "更新一个不存在的待办", "permission": "full"})
	if code != 200 {
		t.Fatal(result)
	}
	message := object(result["message"])
	if text := str(message, "content"); !strings.Contains(text, "没有中断") {
		t.Fatalf("conversation did not finish: %q", text)
	}
	tools := objects(message["tools"])
	if len(tools) != 1 || boolean(tools[0], "ok") {
		t.Fatalf("invalid tool should be reported without aborting: %v", tools)
	}
}
