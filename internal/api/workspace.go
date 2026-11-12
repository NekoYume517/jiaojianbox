package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func objects(value any) []Object {
	if v, ok := value.([]Object); ok {
		return v
	}
	out := []Object{}
	if values, ok := value.([]any); ok {
		for _, v := range values {
			if o, ok := v.(map[string]any); ok {
				out = append(out, o)
			}
		}
	}
	return out
}
func (s *Server) task(ctx context.Context, db store.SQL, user, id string) Object {
	row := one(ctx, db, "SELECT * FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NULL", id, user)
	o := store.Payload(row)
	o["attachments"] = query(ctx, db, "SELECT id,name,size,sha256,kind FROM attachments WHERE task_id=? AND user_id=? AND deleted_at IS NULL ORDER BY rowid", id, user)
	return o
}
func (s *Server) updateTask(ctx context.Context, db store.SQL, user string, t Object) {
	t["updated_at"] = store.Now()
	exec(ctx, db, "UPDATE tasks SET version=?,payload=? WHERE id=? AND user_id=?", int(num(t, "version")), store.JSON(t), t["id"], user)
	event(ctx, db, user, "task.upsert", str(t, "id"))
}
func version(t Object, expected int) {
	if int(num(t, "version")) != expected {
		fail(409, Object{"message": "其他设备已修改，请刷新后重新编辑", "current": t})
	}
}
func taskInput(input Object) Object {
	out := Object{"title": "", "description": "", "due_at": nil, "status": "collecting", "urgency": nil, "reminders": []any{}, "requirements": []any{}, "max_total_bytes": nil, "naming_hint": "", "filename_pattern": "", "submit_url": "", "source_message_id": nil, "client_id": nil, "collection": nil, "repeat_rule": nil, "version": 0}
	for k := range out {
		if v, ok := input[k]; ok {
			out[k] = v
		}
	}
	for _, key := range []string{"title", "description", "status", "naming_hint", "filename_pattern", "submit_url"} {
		if _, ok := out[key].(string); !ok {
			fail(422, "字段类型无效："+key)
		}
	}
	for _, key := range []string{"due_at", "urgency", "client_id", "source_message_id"} {
		if out[key] != nil {
			if _, ok := out[key].(string); !ok {
				fail(422, "字段类型无效："+key)
			}
		}
	}
	if out["collection"] != nil {
		if _, ok := out["collection"].(bool); !ok {
			fail(422, "字段类型无效：collection")
		}
	}
	if out["repeat_rule"] != nil {
		repeat := object(out["repeat_rule"])
		if len(repeat) == 0 {
			fail(422, "重复规则无效")
		}
		frequency := fallback(str(repeat, "frequency"), "weekly")
		interval := int(num(repeat, "interval"))
		if interval == 0 {
			interval = 1
		}
		if !choice(frequency, "daily", "weekly", "monthly") || interval < 1 || interval > 52 {
			fail(422, "重复周期无效")
		}
		out["repeat_rule"] = Object{"enabled": boolean(repeat, "enabled"), "frequency": frequency, "interval": interval}
	}
	for _, key := range []string{"reminders", "requirements"} {
		if _, ok := out[key].([]any); !ok {
			fail(422, "字段须为列表："+key)
		}
	}
	limits := map[string]int{"title": 200, "description": 30000, "naming_hint": 300, "filename_pattern": 200, "submit_url": 2000, "client_id": 100}
	for k, n := range limits {
		if len([]rune(str(out, k))) > n {
			fail(422, "字段过长："+k)
		}
	}
	if strings.TrimSpace(str(out, "title")) == "" {
		fail(422, "请填写待办标题")
	}
	if !choice(str(out, "status"), "collecting", "ready", "submitted", "archived") {
		fail(422, "待办进度无效")
	}
	if out["urgency"] != nil && !choice(str(out, "urgency"), "high", "normal", "low") {
		fail(422, "优先级无效")
	}
	if due := str(out, "due_at"); due != "" {
		if _, err := time.Parse(time.RFC3339Nano, due); err != nil {
			fail(422, "截止时间须包含时区")
		}
	}
	for _, v := range list(out, "reminders") {
		if text, ok := v.(string); !ok {
			fail(422, "提醒时间无效")
		} else if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
			fail(422, "提醒时间须包含时区")
		}
	}
	if len(list(out, "reminders")) > 5 || len(list(out, "requirements")) > 50 {
		fail(422, "待办内容超出限制")
	}
	reqs := []any{}
	for _, req := range objects(out["requirements"]) {
		label := str(req, "label")
		if label == "" || len([]rune(label)) > 100 {
			fail(422, "材料名称须为 1 至 100 字")
		}
		count := num(req, "min_count")
		if count == 0 {
			count = 1
		}
		if count < 1 || count > 50 || count != float64(int(count)) {
			fail(422, "材料数量须为 1 至 50")
		}
		exts := []any{}
		for _, v := range list(req, "extensions") {
			ext, ok := v.(string)
			if !ok {
				fail(422, "扩展名无效")
			}
			ext = strings.ToLower(strings.TrimPrefix(ext, "."))
			if !extensionPattern.MatchString(ext) {
				fail(422, "扩展名无效")
			}
			exts = append(exts, ext)
		}
		if len(exts) > 12 {
			fail(422, "支持格式过多")
		}
		reqs = append(reqs, Object{"label": label, "min_count": int(count), "extensions": exts})
	}
	if len(reqs) != len(list(out, "requirements")) {
		fail(422, "材料内容无效")
	}
	out["requirements"] = reqs
	if out["max_total_bytes"] != nil && (num(out, "max_total_bytes") <= 0 || num(out, "max_total_bytes") > 1e12) {
		fail(422, "文件大小限制无效")
	}
	if value := str(out, "submit_url"); value != "" && !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		fail(422, "提交入口须为 HTTP/HTTPS 链接")
	}
	if strings.ContainsAny(str(out, "filename_pattern"), "/\\\x00") {
		fail(422, "命名规则仅支持文件名通配符")
	}
	return out
}
func (s *Server) taskRoutes() {
	s.route("POST /api/tasks", "owner", func(r request) any {
		b := taskInput(r.body())
		return s.transaction(r.Context(), func(db store.SQL) any {
			if id := str(b, "client_id"); id != "" {
				if row := first(query(r.Context(), db, "SELECT id FROM tasks WHERE user_id=? AND client_id=?", r.User, id)); row != nil {
					return s.task(r.Context(), db, r.User, str(row, "id"))
				}
			}
			if id := str(b, "source_message_id"); id != "" {
				message := store.Payload(one(r.Context(), db, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, r.User))
				b["source_messages"] = []any{taskSourceMessage(message)}
				b["append_log"] = []any{}
			}
			if b["collection"] == nil {
				b["collection"] = false
			}
			b["id"] = store.ID()
			b["version"] = 1
			b["created_at"] = store.Now()
			b["updated_at"] = b["created_at"]
			exec(r.Context(), db, "INSERT INTO tasks(id,user_id,version,client_id,payload) VALUES(?,?,?,?,?)", b["id"], r.User, 1, b["client_id"], store.JSON(b))
			event(r.Context(), db, r.User, "task.upsert", str(b, "id"))
			b["attachments"] = []Object{}
			return b
		})
	})
	s.route("GET /api/tasks/{task_id}", "owner", func(r request) any { return s.task(r.Context(), s.Store.DB, r.User, r.PathValue("task_id")) })
	s.route("PUT /api/tasks/{task_id}", "owner", func(r request) any {
		b := taskInput(r.body())
		return s.transaction(r.Context(), func(db store.SQL) any {
			t := s.task(r.Context(), db, r.User, r.PathValue("task_id"))
			version(t, int(num(b, "version")))
			if b["collection"] == nil {
				b["collection"] = t["collection"]
			}
			if b["urgency"] == nil {
				b["urgency"] = t["urgency"]
			}
			if b["repeat_rule"] == nil {
				b["repeat_rule"] = t["repeat_rule"]
			}
			b["client_id"] = t["client_id"]
			b["source_message_id"] = t["source_message_id"]
			b["source_messages"] = t["source_messages"]
			b["append_log"] = t["append_log"]
			for k, v := range b {
				t[k] = v
			}
			t["version"] = int(num(b, "version")) + 1
			delete(t, "attachments")
			s.updateTask(r.Context(), db, r.User, t)
			s.maybeCreateNextTask(r.Context(), db, r.User, t)
			return s.task(r.Context(), db, r.User, str(t, "id"))
		})
	})
	s.route("DELETE /api/tasks/{task_id}", "owner", func(r request) any {
		return s.trashTask(r)
	})
}
func (s *Server) messages(ctx context.Context, db store.SQL, rows []Object) []Object {
	out := []Object{}
	if len(rows) == 0 {
		return out
	}
	args := []any{}
	marks := []string{}
	for _, row := range rows {
		o := store.Payload(row)
		out = append(out, o)
		args = append(args, o["id"])
		marks = append(marks, "?")
	}
	jobs := map[string]Object{}
	for _, j := range query(ctx, db, "SELECT message_id,state,attempts,error FROM analysis_jobs WHERE message_id IN ("+strings.Join(marks, ",")+")", args...) {
		jobs[str(j, "message_id")] = j
	}
	for _, m := range out {
		delete(m, "analysis_pending")
		delete(m, "analysis_state")
		if len(object(m["analysis"])) > 0 {
			m["analysis_state"] = "done"
			delete(m, "analysis_error")
			continue
		}
		job := jobs[str(m, "id")]
		if job != nil && str(m, "triage") != "ignored" {
			state := str(job, "state")
			if state == "queued" && num(job, "attempts") > 0 {
				m["analysis_state"] = "retrying"
			} else {
				m["analysis_state"] = state
			}
			m["analysis_pending"] = choice(state, "queued", "running")
			if str(job, "error") != "" {
				m["analysis_error"] = job["error"]
			}
		}
	}
	return out
}
func (s *Server) snapshot(ctx context.Context, user string) any {
	return s.transaction(ctx, func(db store.SQL) any {
		cursor := one(ctx, db, "SELECT COALESCE(MAX(seq),0) AS cursor FROM events WHERE user_id=?", user)
		tasks := []Object{}
		for _, t := range query(ctx, db, "SELECT id FROM tasks WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC", user) {
			tasks = append(tasks, s.task(ctx, db, user, str(t, "id")))
		}
		messages := s.messages(ctx, db, query(ctx, db, "SELECT payload FROM messages WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 200", user))
		shelf := s.shelfItems(ctx, db, user)
		return Object{"cursor": cursor["cursor"], "tasks": tasks, "messages": messages, "shelf": shelf}
	})
}
func (s *Server) messageRoutes() {
	s.route("GET /api/snapshot", "owner", func(r request) any { return s.snapshot(r.Context(), r.User) })
	s.route("GET /api/changes", "owner", func(r request) any {
		after := r.integer("after", 0, 0, 1<<53)
		events := query(r.Context(), s.Store.DB, "SELECT seq,kind,entity_id,at FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT 500", r.User, after)
		cursor := any(after)
		if len(events) > 0 {
			cursor = events[len(events)-1]["seq"]
		}
		return Object{"events": events, "cursor": cursor}
	})
	s.Mux.HandleFunc("GET /api/sync", s.syncSocket)
	s.route("GET /api/messages", "owner", func(r request) any {
		q := "SELECT payload FROM messages WHERE user_id=? AND deleted_at IS NULL"
		args := []any{r.User}
		if before := r.URL.Query().Get("before"); before != "" {
			q += " AND rowid<(SELECT rowid FROM messages WHERE id=? AND user_id=?)"
			args = append(args, before, r.User)
		}
		q += " ORDER BY rowid DESC LIMIT ?"
		args = append(args, r.integer("limit", 100, 1, 200))
		return s.messages(r.Context(), s.Store.DB, query(r.Context(), s.Store.DB, q, args...))
	})
	s.route("POST /api/messages", "owner", func(r request) any {
		b := r.body()
		for _, key := range []string{"source", "account_id", "conversation_id", "external_id", "sent_at"} {
			if str(b, key) == "" {
				fail(422, "消息缺少字段："+key)
			}
		}
		if !choice(str(b, "source"), "qq", "wechat", "manual") {
			fail(422, "消息来源无效")
		}
		for key, limit := range map[string]int{"account_id": 150, "conversation_id": 200, "external_id": 200, "conversation_name": 200, "sender_name": 200, "sender_id": 200, "text": 30000, "message_type": 50} {
			if len([]rune(str(b, key))) > limit {
				fail(422, "消息字段过长："+key)
			}
		}
		sent, err := time.Parse(time.RFC3339Nano, str(b, "sent_at"))
		if err != nil {
			fail(422, "消息时间无效")
		}
		b["sent_at"] = sent.Format(time.RFC3339Nano)
		if len(store.JSON(b["metadata"])) > 20000 {
			fail(422, "附加信息过大")
		}
		return s.transaction(r.Context(), func(db store.SQL) any {
			parts := []string{}
			for _, k := range []string{"source", "account_id", "conversation_id", "external_id"} {
				parts = append(parts, store.JSON(b[k]))
			}
			dedup := "[" + strings.Join(parts, ", ") + "]"
			if old := query(r.Context(), db, "SELECT payload FROM messages WHERE user_id=? AND dedup=? AND deleted_at IS NULL", r.User, dedup); len(old) > 0 {
				return s.messages(r.Context(), db, old)[0]
			}
			key := clip(strings.Join(strings.Fields(str(b, "text")), ""), 500)
			if key != "" {
				recent := query(r.Context(), db, "SELECT payload FROM messages WHERE user_id=? AND deleted_at IS NULL AND json_extract(payload,'$.conversation_id')=? AND json_extract(payload,'$.sender_id')=? AND json_extract(payload,'$.account_id')=? AND created_at>=? ORDER BY rowid DESC LIMIT 20", r.User, b["conversation_id"], str(b, "sender_id"), b["account_id"], time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano))
				for _, old := range recent {
					p := store.Payload(old)
					t, _ := time.Parse(time.RFC3339Nano, str(p, "sent_at"))
					delta := sent.Sub(t)
					if clip(strings.Join(strings.Fields(str(p, "text")), ""), 500) == key && delta > -5*time.Second && delta < 5*time.Second {
						return s.messages(r.Context(), db, []Object{old})[0]
					}
				}
			}
			m := Object{}
			for _, k := range []string{"source", "account_id", "conversation_id", "external_id", "conversation_name", "sender_name", "sender_id", "text", "sent_at", "message_type"} {
				m[k] = str(b, k)
			}
			m["message_type"] = fallback(str(m, "message_type"), "text")
			m["metadata"] = object(b["metadata"])
			m["id"] = store.ID()
			m["created_at"] = store.Now()
			m["draft"] = extract(str(m, "text"), sent)
			exec(r.Context(), db, "INSERT INTO messages(id,user_id,dedup,payload,created_at) VALUES(?,?,?,?,?)", m["id"], r.User, dedup, store.JSON(m), m["created_at"])
			settings := first(query(r.Context(), db, "SELECT payload FROM llm_settings WHERE user_id=?", r.User))
			if settings != nil && eligible(store.Payload(settings), str(m, "text")) {
				exec(r.Context(), db, "INSERT OR IGNORE INTO analysis_jobs(user_id,message_id) VALUES(?,?)", r.User, m["id"])
				m["analysis_pending"] = true
				m["analysis_state"] = "queued"
			}
			event(r.Context(), db, r.User, "message.upsert", str(m, "id"))
			return m
		})
	})
	s.route("PUT /api/messages/{message_id}/triage", "owner", func(r request) any {
		state := str(r.body(), "state")
		if !choice(state, "ignored", "unread", "saved") {
			fail(422, "消息状态无效")
		}
		return s.transaction(r.Context(), func(db store.SQL) any {
			m := store.Payload(one(r.Context(), db, "SELECT payload FROM messages WHERE id=? AND user_id=? AND deleted_at IS NULL", r.PathValue("message_id"), r.User))
			m["triage"] = state
			delete(m, "analysis_pending")
			delete(m, "analysis_state")
			exec(r.Context(), db, "UPDATE messages SET payload=? WHERE id=? AND user_id=?", store.JSON(m), m["id"], r.User)
			if state == "ignored" {
				exec(r.Context(), db, "UPDATE analysis_jobs SET state='ignored' WHERE message_id=? AND state='queued'", m["id"])
			}
			event(r.Context(), db, r.User, "message.upsert", str(m, "id"))
			return m
		})
	})
	s.route("DELETE /api/messages/{message_id}", "owner", func(r request) any {
		return s.transaction(r.Context(), func(db store.SQL) any {
			m := store.Payload(one(r.Context(), db, "SELECT payload FROM messages WHERE id=? AND user_id=? AND deleted_at IS NULL", r.PathValue("message_id"), r.User))
			exec(r.Context(), db, "UPDATE messages SET deleted_at=? WHERE id=? AND user_id=?", store.Now(), m["id"], r.User)
			exec(r.Context(), db, "UPDATE analysis_jobs SET state='deleted' WHERE message_id=?", m["id"])
			event(r.Context(), db, r.User, "message.delete", str(m, "id"))
			return Object{"ok": true, "recoverable": true, "retention_days": 30}
		})
	})
}
func eligible(c Object, text string) bool {
	if !boolean(c, "auto_analyze") {
		return false
	}
	hasInclude := false
	included := false
	for _, k := range strings.Split(str(c, "include_keywords"), ",") {
		k = strings.TrimSpace(k)
		if k != "" {
			hasInclude = true
			if strings.Contains(text, k) {
				included = true
			}
		}
	}
	if hasInclude && !included {
		return false
	}
	for _, k := range strings.Split(str(c, "exclude_keywords"), ",") {
		if k = strings.TrimSpace(k); k != "" && strings.Contains(text, k) {
			return false
		}
	}
	return true
}
func (s *Server) syncSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(8192)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	authCtx, end := context.WithTimeout(ctx, 8*time.Second)
	var firstMessage Object
	err = wsjson.Read(authCtx, conn, &firstMessage)
	end()
	if err != nil {
		return
	}
	value, err := attempt(func() any { return s.owner(ctx, "Bearer "+str(firstMessage, "token")) })
	if err != nil {
		conn.Close(4401, "登录已过期")
		return
	}
	user := value.(string)
	after := int64(num(firstMessage, "after"))
	if after < 0 {
		after = 0
	}
	go func() {
		defer cancel()
		for {
			var ignored any
			if wsjson.Read(ctx, conn, &ignored) != nil {
				return
			}
		}
	}()
	ticker := time.NewTicker(350 * time.Millisecond)
	defer ticker.Stop()
	heartbeat := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := attempt(func() any {
				s.owner(ctx, "Bearer "+str(firstMessage, "token"))
				events := query(ctx, s.Store.DB, "SELECT seq,kind,entity_id,at FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT 500", user, after)
				if len(events) > 0 {
					after = int64(num(events[len(events)-1], "seq"))
					check(wsjson.Write(ctx, conn, Object{"type": "changes", "events": events, "cursor": after}))
				} else if time.Since(heartbeat) > 15*time.Second {
					check(wsjson.Write(ctx, conn, Object{"type": "heartbeat", "cursor": after}))
					heartbeat = time.Now()
				}
				return nil
			})
			if err != nil {
				conn.Close(4401, "同步已断开")
				return
			}
		}
	}
}
