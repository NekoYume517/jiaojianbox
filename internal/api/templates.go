package api

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

const templateFieldLimit = 20

func templatePayload(t Object) Object {
	out := Object{
		"title":              t["title"],
		"description":        t["description"],
		"urgency":            t["urgency"],
		"requirements":       t["requirements"],
		"max_total_bytes":    t["max_total_bytes"],
		"naming_hint":        t["naming_hint"],
		"filename_pattern":   t["filename_pattern"],
		"submit_url":         t["submit_url"],
		"collection":         t["collection"],
		"repeat_rule":        t["repeat_rule"],
		"template_source_id": t["id"],
	}
	return out
}

func (s *Server) templateRoutes() {
	s.route("GET /api/templates", "owner", func(r request) any {
		rows := query(r.Context(), s.Store.DB, "SELECT * FROM task_templates WHERE user_id=? ORDER BY updated_at DESC", r.User)
		out := make([]Object, 0, len(rows))
		for _, row := range rows {
			item := store.Payload(row)
			item["id"] = row["id"]
			item["name"] = row["name"]
			item["created_at"] = row["created_at"]
			item["updated_at"] = row["updated_at"]
			out = append(out, item)
		}
		return Object{"templates": out}
	})
	s.route("POST /api/templates", "owner", func(r request) any {
		input := r.body()
		name := clip(strings.TrimSpace(str(input, "name")), 100)
		if name == "" {
			fail(422, "请填写模板名称")
		}
		var payload Object
		if taskID := str(input, "task_id"); taskID != "" {
			t := s.task(r.Context(), s.Store.DB, r.User, taskID)
			payload = templatePayload(t)
			if input["repeat_rule"] != nil {
				payload["repeat_rule"] = input["repeat_rule"]
			}
		} else {
			payload = object(input["template"])
			if len(payload) == 0 {
				payload = input
			}
			delete(payload, "name")
			delete(payload, "task_id")
			delete(payload, "id")
			delete(payload, "created_at")
			delete(payload, "updated_at")
		}
		id := store.ID()
		now := store.Now()
		exec(r.Context(), s.Store.DB, "INSERT INTO task_templates(id,user_id,name,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, r.User, name, store.JSON(payload), now, now)
		event(r.Context(), s.Store.DB, r.User, "template.upsert", id)
		return Object{"id": id, "name": name, "task": payload, "created_at": now, "updated_at": now}
	})
	s.route("DELETE /api/templates/{template_id}", "owner", func(r request) any {
		exec(r.Context(), s.Store.DB, "DELETE FROM task_templates WHERE id=? AND user_id=?", r.PathValue("template_id"), r.User)
		event(r.Context(), s.Store.DB, r.User, "template.delete", r.PathValue("template_id"))
		return Object{"ok": true}
	})
	s.route("POST /api/templates/{template_id}/instantiate", "owner", func(r request) any {
		input := r.body()
		row := one(r.Context(), s.Store.DB, "SELECT * FROM task_templates WHERE id=? AND user_id=?", r.PathValue("template_id"), r.User)
		payload := store.Payload(row)
		delete(payload, "id")
		delete(payload, "name")
		delete(payload, "created_at")
		delete(payload, "updated_at")
		for _, key := range []string{"title", "description", "due_at", "repeat_rule"} {
			if value, ok := input[key]; ok {
				payload[key] = value
			}
		}
		payload["status"] = "collecting"
		payload["client_id"] = "template:" + str(row, "id") + ":" + strconv.FormatInt(time.Now().UnixNano(), 36)
		return s.createTaskFromPayload(r, payload)
	})
}

func (s *Server) createTaskFromPayload(r request, input Object) any {
	body := taskInput(input)
	return s.transaction(r.Context(), func(db store.SQL) any {
		if id := str(body, "client_id"); id != "" {
			if row := first(query(r.Context(), db, "SELECT id FROM tasks WHERE user_id=? AND client_id=? AND deleted_at IS NULL", r.User, id)); row != nil {
				return s.task(r.Context(), db, r.User, str(row, "id"))
			}
		}
		body["id"] = store.ID()
		body["version"] = 1
		body["created_at"] = store.Now()
		body["updated_at"] = body["created_at"]
		body["source_messages"] = []any{}
		body["append_log"] = []any{}
		exec(r.Context(), db, "INSERT INTO tasks(id,user_id,version,client_id,payload) VALUES(?,?,?,?,?)", body["id"], r.User, 1, body["client_id"], store.JSON(body))
		event(r.Context(), db, r.User, "task.upsert", str(body, "id"))
		body["attachments"] = []Object{}
		return body
	})
}

func nextRepeatTime(value string, frequency string, interval int) (string, error) {
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", err
	}
	switch frequency {
	case "daily":
		at = at.AddDate(0, 0, interval)
	case "weekly":
		at = at.AddDate(0, 0, 7*interval)
	case "monthly":
		at = at.AddDate(0, interval, 0)
	default:
		at = at.AddDate(0, 0, 7*interval)
	}
	return at.Format(time.RFC3339Nano), nil
}

func shiftReminders(values []any, delta time.Duration) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		raw, ok := value.(string)
		if !ok {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, raw)
		if err == nil {
			out = append(out, at.Add(delta).Format(time.RFC3339Nano))
		}
	}
	return out
}

// maybeCreateNextTask is called after a task changes. It only acts once when a
// repeating task enters submitted, using a deterministic client_id as the
// cross-device idempotency key.
func (s *Server) maybeCreateNextTask(ctx context.Context, db store.SQL, user string, task Object) {
	rule := object(task["repeat_rule"])
	if !boolean(rule, "enabled") || str(task, "status") != "submitted" {
		return
	}
	due := str(task, "due_at")
	if due == "" {
		return
	}
	frequency := fallback(str(rule, "frequency"), "weekly")
	interval := int(num(rule, "interval"))
	if interval < 1 {
		interval = 1
	}
	nextDue, err := nextRepeatTime(due, frequency, interval)
	if err != nil {
		return
	}
	oldDue, _ := time.Parse(time.RFC3339Nano, due)
	newDue, _ := time.Parse(time.RFC3339Nano, nextDue)
	root := str(task, "repeat_source_id")
	if root == "" {
		root = str(task, "id")
	}
	clientID := "repeat:" + root + ":" + nextDue
	if row := first(query(ctx, db, "SELECT id FROM tasks WHERE user_id=? AND client_id=?", user, clientID)); row != nil {
		return
	}
	next := Object{}
	for key, value := range task {
		switch key {
		case "attachments", "id", "created_at", "updated_at", "collection":
			continue
		default:
			next[key] = value
		}
	}
	next["id"] = store.ID()
	next["version"] = 1
	next["client_id"] = clientID
	next["status"] = "collecting"
	next["due_at"] = nextDue
	next["reminders"] = shiftReminders(list(task, "reminders"), newDue.Sub(oldDue))
	next["created_at"] = store.Now()
	next["updated_at"] = next["created_at"]
	next["repeat_source_id"] = root
	next["repeat_generated_at"] = next["created_at"]
	next["collection"] = false
	next["source_messages"] = []any{}
	next["append_log"] = []any{}
	exec(ctx, db, "INSERT INTO tasks(id,user_id,version,client_id,payload) VALUES(?,?,?,?,?)", next["id"], user, 1, clientID, store.JSON(next))
	event(ctx, db, user, "task.upsert", str(next, "id"))
}
