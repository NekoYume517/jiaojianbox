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

// Exercise the real ingestion queue with the first LLM request deliberately held
// open while a follow-up link arrives, both with and without automatic writes.
func TestFollowupTriggerQueueAndSettings(t *testing.T) {
	// 自动分析是阶段化的：同一会话窗口的两条消息合并成一次模型调用，
	// 模型直接给出本阶段的任务。auto_task 决定是否把任务落成待办。
	for _, autoTask := range []bool{false, true} {
		name := "analysis_only"
		if autoTask {
			name = "automatic_append"
		}
		t.Run(name, func(t *testing.T) {
			s := testServer(t)
			token, _ := login(t, s, "followup-queue")
			var requests atomic.Int32
			var sawFirstMessage atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body Object
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					w.WriteHeader(400)
					return
				}
				requests.Add(1)
				messages := objects(body["messages"])
				input := decodeObject(str(messages[len(messages)-1], "content"))
				stage := object(input["STAGE"])
				stageMessages := objects(stage["messages"])
				ids := []any{}
				for _, m := range stageMessages {
					if strings.Contains(str(m, "text"), "纸质版下周二图像处理课前收") {
						sawFirstMessage.Store(true)
					}
					ids = append(ids, str(m, "id"))
				}
				// 阶段响应：两条消息共同指向同一个任务，补充了提交链接。
				result := Object{
					"summary": "3D建模电子版作业的提交要求与链接",
					"tasks": []any{Object{
						"title":         "3D建模电子版作业",
						"summary":       "周五中午12点前提交电子版，纸质版下周二课前收",
						"message_ids":   ids,
						"confidence":    .96,
						"due_at":        "2026-11-13T12:00:00+08:00",
						"urgency":       "high",
						"requirements":  []any{},
						"reason":        "通知含明确任务",
						"submit_url":    "https://upload.bansonic.top/ITrGTlKl",
						"evidence":      []any{"周五中午12点前提交3D建模电子版作业"},
					}},
					"no_task_messages": []any{},
				}
				writeJSON(w, 200, textCompletion(store.JSON(result)))
			}))
			defer upstream.Close()
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
			ingest("requirements", "请大家于本周五中午12点前提交3D建模电子版作业，纸质版下周二图像处理课前收", "2026-11-12T10:39:00+08:00")
			ingest("link", "三维建模期中过程性考核1收集\nhttps://upload.bansonic.top/ITrGTlKl", "2026-11-12T10:42:00+08:00")
			permission := "restricted"
			if autoTask {
				permission = "full"
			}
			_, listing := call(t, s, "GET", "/api/agent/sessions", token, nil)
			sessionID := str(objects(listing["sessions"])[0], "id")
			if code, value := call(t, s, "PATCH", "/api/agent/sessions/"+sessionID, token, Object{"permission": permission}); code != 200 {
				t.Fatal(value)
			}
			deadline := time.Now().Add(8 * time.Second)
			done := false
			var snap Object
			for time.Now().Before(deadline) {
				_, snap = call(t, s, "GET", "/api/snapshot", token, nil)
				finished := 0
				for _, m := range objects(snap["messages"]) {
					if len(object(m["analysis"])) > 0 {
						finished++
					}
				}
				if finished >= 2 {
					done = true
					break
				}
				time.Sleep(30 * time.Millisecond)
			}
			if !done || requests.Load() != 1 || !sawFirstMessage.Load() {
				t.Fatal("stage window did not pack both messages into one call", requests.Load(), sawFirstMessage.Load(), snap)
			}
			tasks := objects(snap["tasks"])
			if autoTask {
				if len(tasks) != 1 || str(tasks[0], "submit_url") != "https://upload.bansonic.top/ITrGTlKl" || len(objects(tasks[0]["source_messages"])) != 2 {
					t.Fatal("stage task missing merged link or sources", tasks)
				}
			} else if len(tasks) != 0 {
				t.Fatal("analysis-only mode wrote tasks", tasks)
			}
			_, out := call(t, s, "GET", "/api/agent/sessions", token, nil)
			sessions := objects(out["sessions"])
			if len(sessions) != 1 || num(sessions[0], "message_count") != 4 || str(sessions[0], "origin_label") != "微信触发器" {
				t.Fatal("expected one ongoing chat session", sessions)
			}
			t.Logf("auto_task=%v: one stage call; tasks=%d; one session, four messages", autoTask, len(tasks))
		})
	}
}
