package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func (s *Server) aiRoutes() {
	s.route("GET /api/settings/llm", "owner", func(r request) any { c, key := s.llmConfig(r.Context(), r.User); c["has_key"] = key != ""; return c })
	s.route("PUT /api/settings/llm", "owner", func(r request) any {
		b := r.body()
		c := llmInput(b)
		_, key := s.llmConfig(r.Context(), r.User)
		if value, present := b["api_key"]; present && value != nil {
			key = str(b, "api_key")
		}
		if len(key) > 2000 {
			fail(422, "API Key 过长")
		}
		encrypted := ""
		if key != "" {
			var err error
			encrypted, err = s.Store.Encrypt(key)
			check(err)
		}
		s.transaction(r.Context(), func(db store.SQL) any {
			exec(r.Context(), db, "INSERT OR REPLACE INTO llm_settings VALUES(?,?,?)", r.User, store.JSON(c), encrypted)
			event(r.Context(), db, r.User, "settings.upsert", "llm")
			return nil
		})
		c["has_key"] = key != ""
		return c
	})
	s.route("POST /api/settings/llm/test", "owner", func(r request) any {
		c, key := s.llmConfig(r.Context(), r.User)
		if str(c, "base_url") == "" {
			fail(400, "请先保存 API 地址")
		}
		req, err := http.NewRequestWithContext(r.Context(), "GET", endpoint(str(c, "base_url"), "models"), nil)
		check(err)
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Do(req)
		if err != nil {
			fail(502, "无法读取模型列表，请检查连接")
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			fail(502, "模型列表接口返回错误")
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		check(err)
		packet := decodeObject(string(raw))
		models := []string{}
		for _, m := range objects(packet["data"]) {
			if id := str(m, "id"); id != "" && len(models) < 200 {
				models = append(models, id)
			}
		}
		return Object{"models": models}
	})
	s.route("POST /api/analyze", "owner", func(r request) any {
		b := r.body()
		if r.URL.Query().Get("stream") == "true" {
			return s.stream(r, func(ctx context.Context, p progress) any { return s.runAnalysis(ctx, r.User, b, p) })
		}
		ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
		defer cancel()
		return s.runAnalysis(ctx, r.User, b, nil)
	})
	s.route("POST /api/shelf/{file_id}/suggest", "owner", func(r request) any {
		b := r.body()
		if _, ok := b["auto_assign"]; !ok {
			b["auto_assign"] = true
		}
		if r.URL.Query().Get("stream") == "true" {
			return s.stream(r, func(ctx context.Context, p progress) any {
				return s.suggestFile(ctx, r.User, r.PathValue("file_id"), boolean(b, "auto_assign"), p)
			})
		}
		ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
		defer cancel()
		return s.suggestFile(ctx, r.User, r.PathValue("file_id"), boolean(b, "auto_assign"), nil)
	})
}
func (s *Server) runAnalysis(ctx context.Context, user string, body Object, p progress) any {
	id := str(body, "message_id")
	keyID := user + ":" + id
	if _, loaded := s.analysis.LoadOrStore(keyID, true); loaded {
		fail(409, "此通知正在分析，请等待结果")
	}
	defer s.analysis.Delete(keyID)
	config, key := s.resolveLLM(ctx, user)
	if str(config, "base_url") == "" || str(config, "model") == "" {
		fail(400, "请先在 AI 设置中填写接口地址和模型")
	}
	target := store.Payload(one(ctx, s.Store.DB, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, user))
	contexts := []Object{}
	count := int(num(config, "context_count"))
	if body["context_count"] != nil {
		count = int(num(body, "context_count"))
	}
	if count < 0 || count > 50 {
		fail(422, "上下文条数无效")
	}
	if ids, ok := body["context_ids"]; ok && ids != nil {
		seen := map[string]bool{}
		items := asList(ids, 51)
		if len(items) > 50 {
			fail(422, "上下文最多 50 条")
		}
		for _, item := range items {
			identity := fmtValue(item)
			if identity == id || seen[identity] {
				continue
			}
			seen[identity] = true
			contexts = append(contexts, store.Payload(one(ctx, s.Store.DB, "SELECT payload FROM messages WHERE id=? AND user_id=?", identity, user)))
		}
	} else {
		rows := query(ctx, s.Store.DB, "SELECT payload FROM messages WHERE user_id=? AND id<>? AND json_extract(payload,'$.source')=? AND json_extract(payload,'$.account_id')=? AND json_extract(payload,'$.conversation_id')=? AND julianday(json_extract(payload,'$.sent_at'))<=julianday(?) ORDER BY julianday(json_extract(payload,'$.sent_at')) DESC,rowid DESC LIMIT ?", user, id, target["source"], target["account_id"], target["conversation_id"], target["sent_at"], count)
		for i := len(rows) - 1; i >= 0; i-- {
			contexts = append(contexts, store.Payload(rows[i]))
		}
	}
	notify(p, Object{"stage": "context", "context_count": len(contexts), "target_characters": len([]rune(str(target, "text")))})
	tasks := []Object{}
	for _, row := range query(ctx, s.Store.DB, "SELECT payload FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 40", user) {
		tasks = append(tasks, store.Payload(row))
	}
	compact := []Object{}
	for _, m := range contexts {
		compact = append(compact, compactMessage(m))
	}
	payload := Object{"TARGET": []Object{compactMessage(target)}, "CONTEXT": compact, "USER_TASKS": compactTasks(tasks)}
	if len(store.JSON(payload)) > 100000 {
		fail(422, "上下文过长，请减少条数")
	}
	prompt := analysisPrompt
	if instruction := str(config, "instruction"); instruction != "" {
		prompt += "\n用户的分类偏好：\n" + instruction
	}
	conversation := []Object{{"role": "system", "content": prompt}, {"role": "user", "content": store.JSON(payload)}}
	var schemas map[string]Object
	check(json.Unmarshal([]byte(toolSchemaJSON), &schemas))
	tools := []Object{}
	for name, schema := range schemas {
		schema["name"] = name
		tools = append(tools, Object{"type": "function", "function": schema})
	}
	metrics := Object{}
	started := time.Now()
	success := false
	defer func() {
		safe, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		attempt(func() any { s.recordLLM(safe, user, "notification", config, started, metrics, success); return nil })
	}()
	text := ""
	for round := 0; round < 3; round++ {
		call := s.chat(ctx, config, key, conversation, tools, p, func(part Object) { metrics = mergeMetrics(metrics, part) })
		if len(call.Calls) > 0 {
			conversation = append(conversation, Object{"role": "assistant", "content": nil, "tool_calls": call.Calls})
			for _, c := range call.Calls {
				fn := object(c["function"])
				var args Object
				json.Unmarshal([]byte(str(fn, "arguments")), &args)
				conversation = append(conversation, Object{"role": "tool", "tool_call_id": c["id"], "content": store.JSON(s.tools(ctx, user, str(fn, "name"), args))})
			}
			continue
		}
		text = call.Text
		break
	}
	notify(p, Object{"stage": "validating"})
	result := normalizeAnalysis(robustJSON(text))
	draft := object(target["draft"])
	valid := taskInput(Object{"title": fallback(str(result, "title"), fallback(str(draft, "title"), draftTitle(str(target, "text")))), "due_at": result["due_at"], "urgency": result["urgency"], "reminders": result["reminder_suggestions"], "requirements": result["requirements"], "max_total_bytes": result["max_total_bytes"], "naming_hint": result["naming_hint"], "submit_url": result["submit_url"]})
	for _, k := range []string{"due_at", "urgency", "requirements", "max_total_bytes", "naming_hint", "submit_url", "reminders"} {
		result[k] = valid[k]
	}
	result["performance"] = metrics
	result["at"] = store.Now()
	result["model"] = config["model"]
	contextIDs := []string{}
	for _, m := range contexts {
		contextIDs = append(contextIDs, str(m, "id"))
	}
	result["context_ids"] = contextIDs
	var created Object
	s.transaction(ctx, func(db store.SQL) any {
		current := store.Payload(one(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, user))
		if boolean(config, "auto_task") && str(result, "classification") == "actionable" && num(result, "confidence") >= .8 && str(current, "triage") != "ignored" {
			clientID := "auto-" + id
			old := first(query(ctx, db, "SELECT id FROM tasks WHERE user_id=? AND client_id=?", user, clientID))
			if duplicateID := str(result, "duplicate_of"); boolean(result, "duplicate") && duplicateID != "" {
				if row := first(query(ctx, db, "SELECT id FROM tasks WHERE id=? AND user_id=?", duplicateID, user)); row != nil {
					old = row
				}
			}
			if old != nil {
				created = s.task(ctx, db, user, str(old, "id"))
			} else {
				title := str(valid, "title")
				recent := first(query(ctx, db, "SELECT id FROM tasks WHERE user_id=? AND json_extract(payload,'$.title')=? AND json_extract(payload,'$.created_at')>=? ORDER BY rowid DESC LIMIT 1", user, title, time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)))
				if recent != nil {
					created = s.task(ctx, db, user, str(recent, "id"))
				} else {
					t := valid
					t["title"] = title
					t["description"] = str(target, "text")
					t["id"] = store.ID()
					t["version"] = 1
					t["client_id"] = clientID
					t["source_message_id"] = id
					t["created_at"] = store.Now()
					t["updated_at"] = t["created_at"]
					exec(ctx, db, "INSERT INTO tasks VALUES(?,?,?,?,?)", t["id"], user, 1, clientID, store.JSON(t))
					event(ctx, db, user, "task.upsert", str(t, "id"))
					created = s.task(ctx, db, user, str(t, "id"))
				}
			}
			if created != nil {
				current["auto_task_id"] = created["id"]
			}
		}
		current["analysis"] = result
		delete(current, "analysis_error")
		delete(current, "analysis_pending")
		delete(current, "analysis_state")
		exec(ctx, db, "UPDATE messages SET payload=? WHERE id=? AND user_id=?", store.JSON(current), id, user)
		exec(ctx, db, "UPDATE analysis_jobs SET state='done',error='' WHERE message_id=? AND state IN ('queued','running')", id)
		event(ctx, db, user, "message.upsert", id)
		return nil
	})
	if created != nil {
		result["auto_created_task"] = created
	}
	success = true
	return result
}
func (s *Server) analyzeWorker(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := attempt(func() any {
				var job Object
				s.transaction(ctx, func(db store.SQL) any {
					job = first(query(ctx, db, "SELECT * FROM analysis_jobs WHERE state='queued' AND next_at<=? ORDER BY id LIMIT 1", timestamp()))
					if job != nil {
						exec(ctx, db, "UPDATE analysis_jobs SET state='running',attempts=attempts+1 WHERE id=?", job["id"])
						event(ctx, db, str(job, "user_id"), "message.upsert", str(job, "message_id"))
					}
					return nil
				})
				if job == nil {
					return nil
				}
				callCtx, stop := context.WithTimeout(ctx, 180*time.Second)
				_, callErr := attempt(func() any {
					return s.runAnalysis(callCtx, str(job, "user_id"), Object{"message_id": job["message_id"]}, nil)
				})
				stop()
				if ctx.Err() != nil {
					return nil
				}
				state, errorText, next := "done", "", float64(0)
				if callErr != nil {
					state = "queued"
					errorText = "本次分析未完成，稍后自动重试"
					next = timestamp() + 20
					if num(job, "attempts") >= 2 {
						state = "failed"
						errorText = "自动分析失败，请检查模型设置后重试"
					}
				}
				s.transaction(ctx, func(db store.SQL) any {
					row := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", job["message_id"], job["user_id"]))
					if row == nil {
						state = "ignored"
					} else {
						m := store.Payload(row)
						if len(object(m["analysis"])) > 0 {
							state = "done"
							errorText = ""
						}
						if str(m, "triage") == "ignored" {
							state = "ignored"
						}
						if errorText != "" {
							m["analysis_error"] = errorText
							exec(ctx, db, "UPDATE messages SET payload=? WHERE id=?", store.JSON(m), job["message_id"])
						}
					}
					exec(ctx, db, "UPDATE analysis_jobs SET state=?,error=?,next_at=? WHERE id=?", state, errorText, next, job["id"])
					event(ctx, db, str(job, "user_id"), "message.upsert", str(job, "message_id"))
					return nil
				})
				return nil
			})
			if err != nil && ctx.Err() == nil {
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Second):
				}
			}
		}
	}
}

var _ = strings.TrimSpace
