package api

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestStreamingProgressUsageAndDisconnect(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "stream-user")
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		f := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"classification\\\":\"}}]}\n\n")
		f.Flush()
		if requests.Load() == 2 {
			<-r.Context().Done()
			return
		}
		time.Sleep(60 * time.Millisecond)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"\\\"CHAT\\\",\\\"confidence\\\":0.9}\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":20,\"total_tokens\":100}}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "stream-fixture"})
	_, m := call(t, s, "POST", "/api/messages", token, Object{"source": "manual", "account_id": "fixture", "conversation_id": "notes", "external_id": "stream", "text": "测试通知", "sent_at": store.Now()})
	live := httptest.NewServer(s)
	defer live.Close()
	send := func(ctx context.Context) *http.Response {
		r, _ := http.NewRequestWithContext(ctx, "POST", live.URL+"/api/analyze?stream=true", strings.NewReader(store.JSON(Object{"message_id": m["id"]})))
		r.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	resp := send(ctx)
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	events := []string{}
	pieces := 0
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event:") {
			events = append(events, line)
		}
		if strings.Contains(line, "received_chars") {
			pieces++
		}
	}
	if scanner.Err() != nil || pieces < 2 || !strings.Contains(strings.Join(events, ","), "event: result") {
		t.Fatal(events, scanner.Err(), pieces)
	}
	_, stats := call(t, s, "GET", "/api/statistics", token, nil)
	if num(object(stats["total"]), "total_tokens") != 100 {
		t.Fatal(stats)
	}
	ctx2, stop := context.WithCancel(context.Background())
	resp2 := send(ctx2)
	scanner = bufio.NewScanner(resp2.Body)
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), "received_chars") {
			break
		}
	}
	stop()
	resp2.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := s.analysis.Load(user + ":" + str(m, "id")); !ok {
			if requests.Load() >= 2 {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("cancelled stream did not stop")
}

func TestProviderFallbackVisionAndFailureMetrics(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "vision-user")
	var tries atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b Object
		json.NewDecoder(r.Body).Decode(&b)
		tries.Add(1)
		if b["stream_options"] != nil {
			writeJSON(w, 400, Object{"error": "unsupported stream_options"})
			return
		}
		messages := objects(b["messages"])
		contents := list(messages[len(messages)-1], "content")
		if len(contents) != 2 || str(object(contents[1]), "type") != "image_url" {
			t.Error("missing image content", b)
		}
		writeJSON(w, 200, Object{"choices": []any{Object{"message": Object{"content": `{"result":{"task_id":null,"category":"reference","confidence":"90%","reason":"图片内容"}}`}}}, "usage": Object{"total_tokens": 25}})
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "vision-fixture", "vision_enabled": true})
	var pngBytes bytes.Buffer
	png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 16, 12)))
	_, file := uploaded(t, s, "/api/shelf", token, "image.png", pngBytes.Bytes())
	code, result := call(t, s, "POST", "/api/shelf/"+str(file, "id")+"/suggest", token, Object{})
	if code != 200 || !boolean(object(result["suggestion"]), "image_analyzed") || tries.Load() != 2 {
		t.Fatal(code, result, tries.Load())
	}
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer broken.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": broken.URL, "model": "broken-fixture"})
	code, _ = call(t, s, "POST", "/api/shelf/"+str(file, "id")+"/suggest", token, Object{})
	if code != 502 {
		t.Fatal(code)
	}
	row := one(context.Background(), s.Store.DB, "SELECT status,http_status FROM llm_calls WHERE model='broken-fixture'")
	if str(row, "status") != "failed" || num(row, "http_status") != 503 {
		t.Fatal(row)
	}
}

func TestImportFailureRollsBackRowsAndFiles(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "import-user")
	var data bytes.Buffer
	z := zip.NewWriter(&data)
	taskID, fileID := store.ID(), store.ID()
	manifest := Object{"format": "jiaojianbox-workspace", "version": 1, "workspace_id": "fixture", "tasks": []any{Object{"id": taskID, "title": "不能残留"}}, "messages": []any{}, "files": []any{Object{"id": fileID, "task_id": taskID, "name": "bad.txt", "size": 7, "sha256": strings.Repeat("0", 64), "kind": "material"}}}
	entry, _ := z.Create("manifest.json")
	entry.Write([]byte(store.JSON(manifest)))
	entry, _ = z.Create("files/" + fileID)
	entry.Write([]byte("invalid"))
	z.Close()
	code, result := uploaded(t, s, "/api/workspace/import", token, "fixture.zip", data.Bytes())
	if code < 400 {
		t.Fatal(result)
	}
	_, snapshot := call(t, s, "GET", "/api/snapshot", token, nil)
	if len(objects(snapshot["tasks"])) != 0 || len(objects(snapshot["shelf"])) != 0 {
		t.Fatal(snapshot)
	}
	entries, err := os.ReadDir(filepath.Join(s.Store.Root, "files"))
	if err != nil || len(entries) != 0 {
		t.Fatal(entries, err)
	}
}

func TestTaskValidationAndClearingReminders(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "edit-user")
	for _, requirements := range []any{"invalid", []any{"invalid"}} {
		if code, _ := call(t, s, "POST", "/api/tasks", token, Object{"title": "格式测试", "requirements": requirements}); code != 422 {
			t.Fatal(code)
		}
	}
	_, task := call(t, s, "POST", "/api/tasks", token, Object{"title": "清空提醒", "reminders": []any{store.Now()}})
	task["reminders"] = []any{}
	code, updated := call(t, s, "PUT", "/api/tasks/"+str(task, "id"), token, task)
	if code != 200 || len(list(updated, "reminders")) != 0 {
		t.Fatal(code, updated)
	}
}
