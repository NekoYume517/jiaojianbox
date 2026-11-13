package api

import (
	"context"
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
	if str(tools[0], "id") == "" || str(tools[0], "state") != "error" || !strings.Contains(str(tools[0], "result_preview"), "error") {
		t.Fatal("tool trace lost execution details", tools)
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

func TestAgentEditsTaskInPlaceAndBlocksDeleteRecreate(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "agent-task-edit")
	code, original := call(t, s, "POST", "/api/tasks", token, Object{
		"title":       "原待办",
		"description": "旧说明",
		"reminders":   []any{"2026-11-13T09:00:00+08:00"},
	})
	if code != 201 {
		t.Fatal(original)
	}
	taskID := str(original, "id")
	upstream := agentUpstream(t, func(call int, _ Object) Object {
		switch call {
		case 1:
			return toolCompletion("update_task", Object{
				"task_id":     taskID,
				"description": "新说明",
				"reminders":   []any{"2026-11-13T08:00:00+08:00"},
			})
		case 2:
			return toolCompletion("create_task", Object{"title": "删除后重建的替代待办"})
		case 3:
			return toolCompletion("trash_task", Object{"task_id": taskID})
		default:
			return textCompletion("已原地更新原待办，并阻止删除重建。")
		}
	})
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture"}); code != 200 {
		t.Fatal(settings)
	}

	code, result := call(t, s, "POST", "/api/agent/chat", token, Object{
		"message":    "修改这个待办的说明和提醒",
		"permission": "full",
	})
	if code != 200 {
		t.Fatal(result)
	}
	tools := objects(object(result["message"])["tools"])
	if len(tools) != 3 || !boolean(tools[0], "ok") || boolean(tools[1], "ok") || boolean(tools[2], "ok") {
		t.Fatalf("edit, replacement and deletion must be distinguished: %v", tools)
	}
	if !strings.Contains(str(tools[1], "result_preview"), "禁止通过删除后新建") {
		t.Fatalf("replacement attempt should explain the safe update rule: %v", tools[1])
	}
	if !strings.Contains(str(tools[2], "result_preview"), "只有用户明确要求删除") {
		t.Fatalf("implicit deletion should be rejected: %v", tools[2])
	}

	code, updated := call(t, s, "GET", "/api/tasks/"+taskID, token, nil)
	if code != 200 || str(updated, "id") != taskID || str(updated, "description") != "新说明" {
		t.Fatalf("task was not updated in place: %v", updated)
	}
	if int(num(updated, "version")) != 2 || len(list(updated, "reminders")) != 1 || fmtValue(list(updated, "reminders")[0]) != "2026-11-13T08:00:00+08:00" {
		t.Fatalf("unexpected updated task: %v", updated)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	if tasks := objects(snapshot["tasks"]); len(tasks) != 1 || str(tasks[0], "id") != taskID {
		t.Fatalf("edit must not replace the original task: %v", tasks)
	}
}

func TestAgentToolRoundLimitReturnsResumableFinal(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "agent-round-limit")
	upstream := agentUpstream(t, func(_ int, _ Object) Object {
		return toolCompletion("list_tasks", Object{"status": "active", "limit": 1})
	})
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture"}); code != 200 {
		t.Fatal(settings)
	}

	code, result := call(t, s, "POST", "/api/agent/chat", token, Object{
		"message":    "检查所有待办",
		"permission": "full",
	})
	if code != 200 {
		t.Fatal(result)
	}
	message := object(result["message"])
	if !strings.Contains(str(message, "content"), "工具调用轮次上限") || !strings.Contains(str(message, "content"), "继续") {
		t.Fatalf("round limit should produce a resumable final response: %v", message["content"])
	}
	tools := objects(message["tools"])
	if len(tools) != 32 || !boolean(tools[31], "ok") {
		t.Fatalf("unexpected round-limit tool trace: %d", len(tools))
	}
}

func TestAgentRunContinuesAfterStreamClientDisconnects(t *testing.T) {
	s := testServer(t)
	token, userID := login(t, s, "agent-disconnect")
	code, created := call(t, s, "POST", "/api/agent/sessions", token, Object{"title": "后台任务", "permission": "full"})
	if code != 200 {
		t.Fatal(created)
	}
	sessionID := str(object(created["session"]), "id")
	upstream := agentUpstream(t, func(_ int, _ Object) Object {
		time.Sleep(250 * time.Millisecond)
		return textCompletion("离开页面后仍在后台完成")
	})
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture"}); code != 200 {
		t.Fatal(settings)
	}

	live := httptest.NewServer(s)
	defer live.Close()
	requestContext, cancel := context.WithCancel(context.Background())
	body := strings.NewReader(store.JSON(Object{"message": "继续在后台处理", "permission": "full"}))
	request, err := http.NewRequestWithContext(requestContext, "POST", live.URL+"/api/agent/sessions/"+sessionID+"/chat?stream=true", body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1)
	if _, err = response.Body.Read(buffer); err != nil {
		t.Fatal(err)
	}
	cancel()
	response.Body.Close()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, row := range query(context.Background(), s.Store.DB, "SELECT payload FROM agent_messages WHERE user_id=? AND session_id=? ORDER BY created_at", userID, sessionID) {
			message := store.Payload(row)
			if str(message, "role") == "assistant" && str(message, "content") == "离开页面后仍在后台完成" {
				return
			}
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatal("agent run was cancelled when the streaming client disconnected")
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
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "fixture", "context_window_tokens": 8192}); code != 200 {
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

func TestNotificationTriggerCreatesResumableSessions(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "trigger-session-user")
	upstream := agentUpstream(t, func(call int, _ Object) Object {
		if call == 1 {
			return textCompletion(store.JSON(Object{
				"classification": "actionable",
				"confidence":     0.95,
				"summary":        "周五中午前需要提交 3D 建模电子版作业。",
				"title":          "3D 建模电子版作业",
				"due_at":         "2026-11-13T12:00:00+08:00",
				"urgency":        "high",
				"requirements": []any{Object{
					"label": "3D 建模文件", "extensions": []any{"zip"}, "min_count": 1,
				}},
				"reason": "通知包含明确截止时间与提交材料",
			}))
		}
		if call == 2 {
			return textCompletion("已检查这个触发会话，材料还没有上传。")
		}
		return textCompletion("已接收另一个触发会话的上下文，并完成目标会话处理。")
	})
	if code, settings := call(t, s, "PUT", "/api/settings/llm", token, Object{
		"base_url": upstream.URL, "model": "fixture", "context_window_tokens": 65536,
	}); code != 200 {
		t.Fatal(settings)
	}
	code, message := call(t, s, "POST", "/api/messages", token, Object{
		"source": "wechat", "account_id": "wx-1", "conversation_id": "group-1",
		"conversation_name": "25 虚拟 1 班", "sender_name": "王恒", "external_id": "trigger-1",
		"sent_at": "2026-11-12T10:39:00+08:00",
		"text":    "请大家于本周五中午 12 点前提交 3D 建模电子版作业",
	})
	if code != 201 {
		t.Fatal(code, message)
	}
	code, analysis := call(t, s, "POST", "/api/analyze", token, Object{"message_id": str(message, "id")})
	if code != 200 || str(analysis, "classification") != "actionable" {
		t.Fatal(code, analysis)
	}
	code, listed := call(t, s, "GET", "/api/agent/sessions", token, nil)
	if code != 200 || len(objects(listed["sessions"])) != 1 {
		t.Fatal(code, listed)
	}
	triggered := first(objects(listed["sessions"]))
	if str(triggered, "kind") != agentSessionNotification ||
		str(triggered, "origin_label") != "微信触发器" ||
		num(triggered, "message_count") != 2 {
		t.Fatal(triggered)
	}
	triggeredID := str(triggered, "id")
	code, session := call(t, s, "GET", "/api/agent/sessions/"+triggeredID, token, nil)
	if code != 200 || str(object(session["state"]), "permission") != "full" {
		t.Fatal(code, session)
	}
	code, continued := call(t, s, "POST", "/api/agent/sessions/"+triggeredID+"/chat", token, Object{
		"message": "检查材料进度", "permission": "restricted",
	})
	if code != 200 || !strings.Contains(str(object(continued["message"]), "content"), "材料还没有上传") {
		t.Fatal(code, continued)
	}
	code, manual := call(t, s, "POST", "/api/agent/sessions", token, Object{
		"title": "跨会话检查", "permission": "restricted",
	})
	if code != 200 {
		t.Fatal(code, manual)
	}
	manualID := str(object(manual["session"]), "id")
	code, crossed := call(t, s, "POST", "/api/agent/sessions/"+manualID+"/cross-chat", token, Object{
		"source_session_id": triggeredID, "message": "接着检查材料和待办", "permission": "restricted",
	})
	if code != 200 || !strings.Contains(str(object(crossed["message"]), "content"), "完成目标会话处理") {
		t.Fatal(code, crossed)
	}
	code, target := call(t, s, "GET", "/api/agent/sessions/"+manualID, token, nil)
	if code != 200 || len(objects(target["messages"])) != 2 ||
		!strings.Contains(store.JSON(target["messages"]), "来自触发会话") {
		t.Fatal(code, target)
	}
}
