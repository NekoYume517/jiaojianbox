package api

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

type liveAgentRun struct {
	s                 *Server
	user, id, session string
	jsonOutput        bool
	raw               string
	payload           Object
	last              time.Time
	mu                sync.Mutex
}

func (s *Server) queueAgentRun(ctx context.Context, db store.SQL, user, id, session, messageID string) {
	now := store.Now()
	exec(ctx, db, `INSERT INTO agent_runs(id,user_id,session_id,source_message_id,state,payload,created_at,updated_at) VALUES(?,?,?,?,'queued','{}',?,?) ON CONFLICT(id) DO NOTHING`, id, user, session, messageID, now, now)
	exec(ctx, db, "UPDATE agent_sessions SET updated_at=? WHERE id=? AND user_id=?", now, session, user)
	event(ctx, db, user, "agent.run.upsert", session)
}

func (s *Server) trackAgentRun(ctx context.Context, user, id, session, messageID string, jsonOutput, automatic bool, p progress) (context.Context, progress, func(bool)) {
	s.transaction(ctx, func(db store.SQL) any {
		s.queueAgentRun(ctx, db, user, id, session, messageID)
		state := str(one(ctx, db, "SELECT state FROM agent_runs WHERE id=? AND user_id=?", id, user), "state")
		if state == "cancelled" && automatic {
			fail(409, "本轮已停止")
		}
		exec(ctx, db, "UPDATE agent_runs SET state='queued',payload='{}',updated_at=? WHERE id=? AND user_id=?", store.Now(), id, user)
		return nil
	})
	child, cancel := context.WithCancel(ctx)
	s.runCancels.Store(user+":"+id, cancel)
	if str(one(child, s.Store.DB, "SELECT state FROM agent_runs WHERE id=? AND user_id=?", id, user), "state") == "cancelled" {
		cancel()
	}
	live := &liveAgentRun{s: s, user: user, id: id, session: session, jsonOutput: jsonOutput, payload: Object{"id": id, "state": "queued", "stage": "queued", "tools": []Object{}, "text": "", "kind": map[bool]string{true: "notification", false: "agent"}[jsonOutput]}}
	callback := func(value Object) {
		notify(p, value)
		live.mu.Lock()
		defer live.mu.Unlock()
		stage := str(value, "stage")
		firstChunk := live.raw == ""
		live.payload["stage"] = stage
		if stage != "queued" {
			live.payload["state"] = "running"
		}
		if stage == "request" {
			live.raw = ""
		}
		if stage == "receiving" {
			live.raw += str(value, "delta")
			live.payload["received_chars"] = len([]rune(live.raw))
			live.payload["text"] = live.raw
			if jsonOutput {
				live.payload["text"] = analysisLiveSummary(live.raw)
			}
		}
		if tool := object(value["tool"]); len(tool) > 0 {
			list := objects(live.payload["tools"])
			found := false
			for i, old := range list {
				if str(old, "id") == str(tool, "id") {
					copy := Object{}
					for k, v := range tool {
						copy[k] = v
					}
					list[i] = copy
					found = true
				}
			}
			if !found {
				copy := Object{}
				for k, v := range tool {
					copy[k] = v
				}
				list = append(list, copy)
			}
			live.payload["tools"] = list
		}
		if stage == "receiving" && !firstChunk && time.Since(live.last) < 120*time.Millisecond {
			return
		}
		live.last = time.Now()
		safe, stop := context.WithTimeout(context.WithoutCancel(child), 3*time.Second)
		defer stop()
		attempt(func() any {
			s.transaction(safe, func(db store.SQL) any {
				exec(safe, db, "UPDATE agent_runs SET state=?,payload=?,updated_at=? WHERE id=? AND user_id=? AND state IN ('queued','running')", live.payload["state"], store.JSON(live.payload), store.Now(), id, user)
				if stage != "receiving" {
					event(safe, db, user, "agent.run.upsert", session)
				}
				return nil
			})
			return nil
		})
	}
	finish := func(success bool) {
		defer cancel()
		s.runCancels.Delete(user + ":" + id)
		safe, stop := context.WithTimeout(context.WithoutCancel(child), 5*time.Second)
		defer stop()
		state := "failed"
		if success {
			state = "done"
		} else if child.Err() == context.Canceled {
			state = "cancelled"
		}
		live.mu.Lock()
		defer live.mu.Unlock()
		live.payload["state"] = state
		attempt(func() any {
			s.transaction(safe, func(db store.SQL) any {
				exec(safe, db, "UPDATE agent_runs SET state=?,payload=?,updated_at=? WHERE id=? AND user_id=? AND state IN ('queued','running')", state, store.JSON(live.payload), store.Now(), id, user)
				event(safe, db, user, "agent.run.upsert", session)
				return nil
			})
			return nil
		})
	}
	notify(p, Object{"stage": "queued", "run_id": id})
	return child, callback, finish
}

// A notification classifier streams JSON. Expose the summary progressively,
// while keeping structural JSON and incomplete escapes out of the conversation.
func analysisLiveSummary(raw string) string {
	start := strings.Index(raw, `"summary"`)
	if start < 0 {
		return ""
	}
	raw = raw[start+9:]
	colon := strings.Index(raw, ":")
	if colon < 0 {
		return ""
	}
	raw = strings.TrimSpace(raw[colon+1:])
	if !strings.HasPrefix(raw, `"`) {
		return ""
	}
	end := 1
	escaped := false
	for end < len(raw) {
		if !escaped && raw[end] == '"' {
			break
		}
		if !escaped && raw[end] == '\\' {
			escaped = true
		} else {
			escaped = false
		}
		end++
	}
	fragment := raw[:end]
	for attempts := 0; attempts < 12 && len(fragment) > 0; attempts++ {
		var text string
		if json.Unmarshal([]byte(fragment+`"`), &text) == nil {
			return text
		}
		fragment = fragment[:len(fragment)-1]
	}
	return ""
}

func (s *Server) liveSessionRuns(ctx context.Context, user, session string, history bool) []Object {
	condition := " AND state IN ('queued','running')"
	if history {
		condition = " AND state<>'done'"
	}
	rows := query(ctx, s.Store.DB, "SELECT * FROM agent_runs WHERE user_id=? AND session_id=?"+condition+" ORDER BY created_at DESC LIMIT 30", user, session)
	out := []Object{}
	for _, row := range rows {
		item := store.Payload(row)
		for _, key := range []string{"id", "state", "source_message_id", "created_at", "updated_at"} {
			item[key] = row[key]
		}
		out = append(out, item)
	}
	return out
}

func (s *Server) stopAgentRun(ctx context.Context, user, session, runID string) Object {
	s.agentSession(ctx, s.Store.DB, user, session)
	var selected Object
	s.transaction(ctx, func(db store.SQL) any {
		if runID != "" {
			selected = first(query(ctx, db, "SELECT * FROM agent_runs WHERE id=? AND user_id=? AND session_id=? AND state IN ('queued','running')", runID, user, session))
		} else {
			selected = first(query(ctx, db, "SELECT * FROM agent_runs WHERE user_id=? AND session_id=? AND state IN ('queued','running') ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,created_at LIMIT 1", user, session))
		}
		if selected == nil {
			return nil
		}
		payload := store.Payload(selected)
		payload["state"] = "cancelled"
		for _, tool := range objects(payload["tools"]) {
			if str(tool, "state") == "running" {
				tool["state"] = "cancelled"
				tool["ok"] = false
			}
		}
		exec(ctx, db, "UPDATE agent_runs SET state='cancelled',payload=?,updated_at=? WHERE id=? AND user_id=?", store.JSON(payload), store.Now(), selected["id"], user)
		if mid := str(selected, "source_message_id"); mid != "" {
			exec(ctx, db, "UPDATE analysis_jobs SET state='cancelled',error='',next_at=0 WHERE user_id=? AND message_id=?", user, mid)
		}
		event(ctx, db, user, "agent.run.upsert", session)
		return nil
	})
	if selected != nil {
		if cancel, ok := s.runCancels.Load(user + ":" + str(selected, "id")); ok {
			cancel.(context.CancelFunc)()
		}
	}
	return Object{"ok": true, "stopped": selected != nil}
}
