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

// Exercise the real ingestion queue with the first LLM request deliberately held
// open while a follow-up link arrives, both with and without automatic writes.
func TestFollowupTriggerQueueAndSettings(t *testing.T) {
	for _, autoTask := range []bool{false, true} {
		name := "analysis_only"
		if autoTask {
			name = "automatic_append"
		}
		t.Run(name, func(t *testing.T) {
			s := testServer(t)
			token, _ := login(t, s, "followup-queue")
			started := make(chan struct{}, 1)
			release := make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			var requests atomic.Int32
			var sawFirstTask, sawFirstMessage atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body Object
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					w.WriteHeader(400)
					return
				}
				n := requests.Add(1)
				if n == 1 {
					started <- struct{}{}
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				result := Object{"classification": "actionable", "confidence": .96, "title": "3D建模电子版作业", "summary": "周五中午12点前提交电子版，纸质版下周二课前收", "due_at": "2026-11-13T12:00:00+08:00", "urgency": "high", "requirements": []any{}, "reason": "通知含明确任务"}
				if n > 1 {
					messages := objects(body["messages"])
					input := decodeObject(str(messages[len(messages)-1], "content"))
					tasks := objects(input["USER_TASKS"])
					if len(tasks) > 0 {
						sawFirstTask.Store(true)
						result["duplicate"] = true
						result["duplicate_of"] = str(tasks[0], "id")
					}
					for _, m := range messages[1:] {
						if strings.Contains(str(m, "content"), "纸质版下周二图像处理课前收") {
							sawFirstMessage.Store(true)
						}
					}
					result["submit_url"] = "https://upload.bansonic.top/ITrGTlKl"
					result["summary"] = "补充已有3D建模作业的提交链接"
				}
				writeJSON(w, 200, textCompletion(store.JSON(result)))
			}))
			defer upstream.Close()
			defer unblock()
			if code, out := call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "queue-fixture", "auto_analyze": true, "auto_task": autoTask}); code != 200 {
				t.Fatal(out)
			}
			ingest := func(external, text, sent string) Object {
				code, m := call(t, s, "POST", "/api/messages", token, Object{"source": "wechat", "account_id": "wx-1", "conversation_id": "class-1", "conversation_name": "25虚拟1班", "sender_name": "王恒", "external_id": external, "text": text, "sent_at": sent})
				if code != 201 || !boolean(m, "analysis_pending") {
					t.Fatal(code, m)
				}
				return m
			}
			first := ingest("requirements", "请大家于本周五中午12点前提交3D建模电子版作业，纸质版下周二图像处理课前收", "2026-11-12T10:39:00+08:00")
			permission := "restricted"
			if autoTask {
				permission = "full"
			}
			_, listing := call(t, s, "GET", "/api/agent/sessions", token, nil)
			sessionID := str(objects(listing["sessions"])[0], "id")
			if code, value := call(t, s, "PATCH", "/api/agent/sessions/"+sessionID, token, Object{"permission": permission}); code != 200 {
				t.Fatal(value)
			}
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("first analysis did not start")
			}
			second := ingest("link", "三维建模期中过程性考核1收集\nhttps://upload.bansonic.top/ITrGTlKl", "2026-11-12T10:42:00+08:00")
			time.Sleep(600 * time.Millisecond)
			if requests.Load() != 1 {
				t.Fatal("followup ran before first completed", requests.Load())
			}
			_, snap := call(t, s, "GET", "/api/snapshot", token, nil)
			states := map[string]string{}
			for _, m := range objects(snap["messages"]) {
				states[str(m, "id")] = str(m, "analysis_state")
			}
			if states[str(first, "id")] != "running" || states[str(second, "id")] != "queued" {
				t.Fatal(states)
			}
			unblock()
			deadline := time.Now().Add(6 * time.Second)
			done := false
			for time.Now().Before(deadline) {
				_, snap = call(t, s, "GET", "/api/snapshot", token, nil)
				for _, m := range objects(snap["messages"]) {
					if str(m, "id") == str(second, "id") && len(object(m["analysis"])) > 0 {
						done = true
					}
				}
				if done {
					break
				}
				time.Sleep(30 * time.Millisecond)
			}
			if !done || requests.Load() != 2 || !sawFirstMessage.Load() {
				t.Fatal("followup did not finish with previous message context", requests.Load(), snap)
			}
			tasks := objects(snap["tasks"])
			if autoTask {
				if len(tasks) != 1 || !sawFirstTask.Load() || str(tasks[0], "submit_url") != "https://upload.bansonic.top/ITrGTlKl" || len(objects(tasks[0]["source_messages"])) != 2 {
					t.Fatal("followup failed to update first task", tasks)
				}
			} else if len(tasks) != 0 || sawFirstTask.Load() {
				t.Fatal("analysis-only mode wrote tasks", tasks)
			}
			_, out := call(t, s, "GET", "/api/agent/sessions", token, nil)
			sessions := objects(out["sessions"])
			if len(sessions) != 1 || num(sessions[0], "message_count") != 4 || str(sessions[0], "origin_label") != "微信触发器" {
				t.Fatal("expected one ongoing chat session", sessions)
			}
			t.Logf("auto_task=%v: running + queued; two requests completed in order; tasks=%d; one session, four messages", autoTask, len(tasks))
		})
	}
}
