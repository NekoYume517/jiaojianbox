package api

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestCollectionAIDesignStreamsToolsAndRecordsUsage(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "form-designer")
	var rounds int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rounds++
		if rounds == 1 {
			toolCall := Object{"id": "call-1", "type": "function", "function": Object{"name": "add_field", "arguments": store.JSON(Object{"id": "name", "label": "姓名", "type": "text", "required": true})}}
			choice := Object{"message": Object{"tool_calls": []any{toolCall}}}
			writeJSON(w, 200, Object{"choices": []any{choice}, "usage": Object{"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42}})
			return
		}
		choice := Object{"message": Object{"content": `{"summary":"表单已添加姓名字段"}`}}
		writeJSON(w, 200, Object{"choices": []any{choice}, "usage": Object{"prompt_tokens": 40, "completion_tokens": 18, "total_tokens": 58}})
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "form-design-fixture"})
	_, task := call(t, s, "POST", "/api/tasks", token, Object{"title": "提交课程截图"})
	_, share := call(t, s, "POST", "/api/shares", token, Object{"task_id": task["id"], "purpose": "collect"})
	live := httptest.NewServer(s)
	defer live.Close()
	request, _ := http.NewRequest("POST", live.URL+"/api/collection/ai?stream=true", strings.NewReader(store.JSON(Object{"share_id": share["id"], "instruction": "收集姓名", "builder": Object{"fields": []any{}}})))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	builderEvents, sawResult := 0, false
	var result Object
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, `"operation":"add_field"`) {
			builderEvents++
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		if value := decodeObject(strings.TrimPrefix(line, "data: ")); value["builder"] != nil {
			result = value
			sawResult = true
		}
	}
	if err := scanner.Err(); err != nil || builderEvents != 1 || !sawResult {
		t.Fatal("stream result incomplete", builderEvents, sawResult, err)
	}
	builder := object(result["builder"])
	fields := objects(builder["fields"])
	if len(fields) != 1 || str(fields[0], "id") != "name" || !boolean(fields[0], "required") {
		t.Fatal(fields)
	}
	row := one(context.Background(), s.Store.DB, "SELECT kind,total_tokens,streamed FROM llm_calls WHERE user_id=? AND kind='collection_form'", user)
	if str(row, "kind") != "collection_form" || num(row, "total_tokens") != 100 {
		t.Fatal(row)
	}
}

func TestCollectionAIFailureIsRecorded(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "form-failure")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "broken-form-fixture"})
	_, task := call(t, s, "POST", "/api/tasks", token, Object{"title": "失败表单"})
	_, share := call(t, s, "POST", "/api/shares", token, Object{"task_id": task["id"], "purpose": "collect"})
	if code, _ := call(t, s, "POST", "/api/collection/ai", token, Object{"share_id": share["id"], "instruction": "收集姓名", "builder": Object{"fields": []any{}}}); code != 502 {
		t.Fatal(code)
	}
	row := one(context.Background(), s.Store.DB, "SELECT kind,status,total_tokens FROM llm_calls WHERE user_id=? AND kind='collection_form'", user)
	if str(row, "status") != "failed" || row["total_tokens"] != nil {
		t.Fatal(row)
	}
}
