package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestTriggerLiveOutputStopAndQueueIsolation(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "live-stop")
	var calls atomic.Int32
	started := make(chan struct{}, 1)
	cancelled := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) > 1 {
			writeJSON(w, 200, textCompletion(store.JSON(Object{"classification": "actionable", "confidence": .95, "summary": "第二条正常完成", "title": "第二项待办", "requirements": []any{}})))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", store.JSON(Object{"choices": []any{Object{"delta": Object{"content": `{"summary":"正在检查材料`}}}}))
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
		cancelled <- struct{}{}
	}))
	defer upstream.Close()
	call(t, s, "PUT", "/api/settings/llm", token, Object{"base_url": upstream.URL, "model": "live-fixture", "auto_analyze": true})
	ingest := func(ext string) Object {
		code, m := call(t, s, "POST", "/api/messages", token, Object{"source": "wechat", "account_id": "wx", "conversation_id": "group", "conversation_name": "实时测试群", "external_id": ext, "text": "提交任务 " + ext, "sent_at": "2026-11-12T12:00:00+08:00"})
		if code != 201 {
			t.Fatal(m)
		}
		return m
	}
	first := ingest("one")
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("model not started")
	}
	_, listing := call(t, s, "GET", "/api/agent/sessions", token, nil)
	session := objects(listing["sessions"])[0]
	sid := str(session, "id")
	if str(session, "run_state") != "running" {
		t.Fatal(listing)
	}
	deadline := time.Now().Add(3 * time.Second)
	var runs []Object
	for time.Now().Before(deadline) {
		_, activity := call(t, s, "GET", "/api/agent/sessions/"+sid+"/activity", token, nil)
		runs = objects(activity["runs"])
		if len(runs) > 0 && strings.Contains(str(runs[0], "text"), "正在检查材料") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(runs) == 0 || !strings.Contains(str(runs[0], "text"), "正在检查材料") {
		t.Fatal("no live model text", runs)
	}
	second := ingest("two")
	if calls.Load() != 1 {
		t.Fatal("queued turn interrupted running turn")
	}
	runID := "notification-" + str(first, "id")
	code, stopped := call(t, s, "POST", "/api/agent/sessions/"+sid+"/stop", token, Object{"run_id": runID})
	if code != 200 || !boolean(stopped, "stopped") {
		t.Fatal(code, stopped)
	}
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("stop did not cancel actual upstream request")
	}
	deadline = time.Now().Add(5 * time.Second)
	done := false
	for time.Now().Before(deadline) {
		_, snap := call(t, s, "GET", "/api/snapshot", token, nil)
		for _, m := range objects(snap["messages"]) {
			if str(m, "id") == str(second, "id") && len(object(m["analysis"])) > 0 {
				done = true
			}
		}
		if done {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !done || calls.Load() != 2 {
		t.Fatal("stopping first affected queued second", calls.Load())
	}
	time.Sleep(600 * time.Millisecond)
	job := firstRow(t, s, "SELECT state FROM analysis_jobs WHERE message_id=?", str(first, "id"))
	if str(job, "state") != "cancelled" || calls.Load() != 2 {
		t.Fatal("stopped run was retried", job, calls.Load())
	}
	run := one(context.Background(), s.Store.DB, "SELECT * FROM agent_runs WHERE id=? AND user_id=?", runID, user)
	if str(run, "state") != "cancelled" || !strings.Contains(str(store.Payload(run), "text"), "检查材料") {
		t.Fatal("stop lost partial output", run)
	}
}

func firstRow(t *testing.T, s *Server, sql string, args ...any) Object {
	t.Helper()
	return first(query(context.Background(), s.Store.DB, sql, args...))
}

func TestAnalysisLiveSummaryPartialEscapes(t *testing.T) {
	for input, want := range map[string]string{`{"summary":"你好`: "你好", `{"summary":"line\nnext`: "line\nnext", `{"summary":"\u4f60\u597d`: "你好", `{"summary":"abc\u4`: "abc", `{"title":"未输出摘要"}`: ""} {
		if got := analysisLiveSummary(input); got != want {
			t.Fatalf("%q: %q != %q", input, got, want)
		}
	}
}
func TestFullAccessDefaultUpgradeAndUserChoice(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "permission-upgrade")
	code, created := call(t, s, "POST", "/api/agent/sessions", token, Object{"title": "权限迁移"})
	if code != 200 {
		t.Fatal(created)
	}
	sid := str(object(created["session"]), "id")
	if str(object(created["state"]), "permission") != "full" {
		t.Fatal("new sessions must default full", created)
	}
	s.Close()
	exec(context.Background(), s.Store.DB, "DELETE FROM site_settings WHERE key='migration.agent-full-default-v1'")
	exec(context.Background(), s.Store.DB, "UPDATE agent_sessions SET permission='restricted' WHERE user_id=?", user)
	upgraded, err := New(s.Store, s.Assets, "test")
	if err != nil {
		t.Fatal(err)
	}
	row := upgraded.agentSession(context.Background(), s.Store.DB, user, sid)
	if str(row, "permission") != "full" {
		t.Fatal("old defaults were not upgraded", row)
	}
	call(t, upgraded, "PATCH", "/api/agent/sessions/"+sid, token, Object{"permission": "restricted"})
	upgraded.Close()
	restarted, err := New(s.Store, s.Assets, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	row = restarted.agentSession(context.Background(), s.Store.DB, user, sid)
	if str(row, "permission") != "restricted" {
		t.Fatal("restart overwrote explicit user choice", row)
	}
}
