package api

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func (s *Server) aiRoutes() {
	s.route("GET /api/settings/llm", "owner", func(r request) any { c, key := s.llmConfig(r.Context(), r.User); c["has_key"] = key != ""; return c })
	s.route("PUT /api/settings/llm", "owner", func(r request) any {
		b := r.body()
		c := llmInput(r.Context(), b)
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
		req, err := outboundRequest(r.Context(), "GET", endpoint(str(c, "base_url"), "models"), nil)
		if err != nil {
			fail(502, err.Error())
		}
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		client := outboundClient(15 * time.Second)
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
	triggerContextLimit := agentContextLimitFromConfig(config)
	target := store.Payload(one(ctx, s.Store.DB, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, user))
	s.migrateConversationSessions(ctx, user)
	sessionID := ""
	s.transaction(ctx, func(db store.SQL) any {
		sessionID = s.ensureConversationSession(ctx, db, user, target, triggerContextLimit)
		return nil
	})
	ctx, p, finishRun := s.trackAgentRun(ctx, user, "notification-"+id, sessionID, id, true, boolean(body, "_automatic"), p)
	runSuccess := false
	defer func() { finishRun(runSuccess) }()
	unlock := s.lockConversationTurn(ctx, user, sessionID)
	notify(p, Object{"stage": "starting"})
	defer unlock()
	s.transaction(ctx, func(db store.SQL) any { s.saveTriggerTurn(ctx, db, user, sessionID, target, nil); return nil })
	sessionState := agentSessionState(s.agentSession(ctx, s.Store.DB, user, sessionID))
	sessionState["context_limit"] = triggerContextLimit
	config["auto_task"] = str(sessionState, "permission") == "full"
	messages := s.agentSessionMessages(ctx, user, sessionID)
	contextState := s.agentContext(ctx, user, sessionState, messages)
	if num(contextState, "percent") >= agentCompressAt*100 {
		notify(p, Object{"stage": "compressing", "context": contextState})
		if summary, ok := s.compressAgentContext(ctx, user, sessionID, config, key, sessionState, messages, p); ok {
			sessionState["summary"] = summary
			messages = s.agentSessionMessages(ctx, user, sessionID)
		}
	}
	notify(p, Object{"stage": "context", "context_count": len(messages), "target_characters": len([]rune(str(target, "text")))})

	tasks := []Object{}
	for _, row := range query(ctx, s.Store.DB, "SELECT payload FROM tasks WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 40", user) {
		tasks = append(tasks, store.Payload(row))
	}
	payload := Object{"TARGET": []Object{compactMessage(target)}, "USER_TASKS": compactTasks(tasks)}

	prompt := analysisPrompt
	if instruction := str(config, "instruction"); instruction != "" {
		prompt += "\n用户的分类偏好：\n" + instruction
	}
	conversation := []Object{{"role": "system", "content": prompt + "\n历史由同一聊天的持久会话管理。当前 TARGET 是本轮目标；此前的用户和助手消息仅为历史事实。新通知如补充了已有任务，请关联并补充原待办，避免重复创建。"}}
	if summary := str(sessionState, "summary"); summary != "" {
		conversation = append(conversation, Object{"role": "system", "content": "历史事实摘要：\n" + summary})
	}
	for _, m := range messages {
		if boolean(m, "summarized") || str(m, "id") == "trigger-user-"+id {
			continue
		}
		conversation = append(conversation, Object{"role": str(m, "role"), "content": str(m, "content")})
	}
	conversation = append(conversation, Object{"role": "user", "content": store.JSON(payload)})
	var schemas map[string]Object
	check(json.Unmarshal([]byte(toolSchemaJSON), &schemas))
	tools := []Object{}
	for name, schema := range schemas {
		if name == "append_to_task" && !boolean(config, "auto_task") {
			continue
		}
		schema["name"] = name
		tools = append(tools, Object{"type": "function", "function": schema})
	}
	metrics := Object{}
	toolEvents := []Object{}
	started := time.Now()
	success := false
	defer func() {
		safe, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		attempt(func() any { s.recordLLM(safe, user, "notification", config, started, metrics, success); return nil })
	}()
	text := ""
	appendedTaskID := ""
	for round := 0; round < 3; round++ {
		call := s.chat(ctx, config, key, conversation, tools, p, func(part Object) { metrics = mergeMetrics(metrics, part) })
		if len(call.Calls) > 0 {
			conversation = append(conversation, Object{"role": "assistant", "content": nil, "tool_calls": call.Calls})
			for _, c := range call.Calls {
				fn := object(c["function"])
				var args Object
				json.Unmarshal([]byte(str(fn, "arguments")), &args)
				toolStart := time.Now()
				toolEvent := Object{"id": store.ID(), "name": str(fn, "name"), "arguments": args, "state": "running", "at": store.Now()}
				notify(p, Object{"stage": "tool", "tool": toolEvent})
				toolResult := Object{"error": "自动修改待办已关闭"}
				if str(fn, "name") != "append_to_task" || boolean(config, "auto_task") {
					toolResult = s.tools(ctx, user, id, str(fn, "name"), args)
				}
				toolEvent["ok"] = str(toolResult, "error") == ""
				toolEvent["state"] = "done"
				if !boolean(toolEvent, "ok") {
					toolEvent["state"] = "error"
				}
				toolEvent["result_preview"] = clip(store.JSON(toolResult), 12000)
				toolEvent["duration_ms"] = time.Since(toolStart).Milliseconds()
				toolEvents = append(toolEvents, toolEvent)
				notify(p, Object{"stage": "tool", "tool": toolEvent})
				if str(fn, "name") == "append_to_task" && boolean(toolResult, "appended") && appendedTaskID == "" {
					appendedTaskID = str(toolResult, "task_id")
				}
				conversation = append(conversation, Object{"role": "tool", "tool_call_id": c["id"], "content": store.JSON(toolResult)})
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
	result["tools"] = toolEvents
	result["at"] = store.Now()
	result["model"] = config["model"]
	contextIDs := []string{}
	for _, m := range messages {
		if !boolean(m, "summarized") && str(object(m["trigger"]), "message_id") != id && str(m, "role") == "user" {
			contextIDs = append(contextIDs, str(object(m["trigger"]), "message_id"))
		}
	}
	result["context_ids"] = contextIDs
	if appendedTaskID != "" {
		result["classification"] = "actionable"
		if num(result, "confidence") < .8 {
			result["confidence"] = .8
		}
		result["duplicate"] = true
		result["duplicate_of"] = appendedTaskID
	}
	var created Object
	action := ""
	s.transaction(ctx, func(db store.SQL) any {
		check(ctx.Err())
		current := store.Payload(one(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, user))
		if boolean(config, "auto_task") && str(result, "classification") == "actionable" && num(result, "confidence") >= .8 && str(current, "triage") != "ignored" {
			clientID := "auto-" + id
			old := first(query(ctx, db, "SELECT id FROM tasks WHERE user_id=? AND client_id=? AND deleted_at IS NULL", user, clientID))
			if duplicateID := str(result, "duplicate_of"); boolean(result, "duplicate") && duplicateID != "" {
				if row := first(query(ctx, db, "SELECT id FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NULL", duplicateID, user)); row != nil {
					old = row
				}
			}
			if old != nil {
				patch := appendPatchFromAnalysis(result)
				if appendedTaskID != "" {
					action = "appended"
				} else if appendPatchHasChanges(patch) {
					appended := s.appendToTask(ctx, db, user, id, str(old, "id"), patch)
					if boolean(appended, "appended") {
						action = "appended"
					} else if action == "" {
						action = "matched"
					}
				} else if action == "" {
					action = "matched"
				}
				created = s.task(ctx, db, user, str(old, "id"))
			} else {
				title := str(valid, "title")
				recent := first(query(ctx, db, "SELECT id FROM tasks WHERE user_id=? AND deleted_at IS NULL AND json_extract(payload,'$.title')=? AND json_extract(payload,'$.created_at')>=? ORDER BY rowid DESC LIMIT 1", user, title, time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)))
				if recent != nil {
					created = s.task(ctx, db, user, str(recent, "id"))
					action = "matched"
				} else {
					t := valid
					t["title"] = title
					t["description"] = str(target, "text")
					t["source_messages"] = []any{taskSourceMessage(target)}
					t["append_log"] = []any{}
					t["id"] = store.ID()
					t["version"] = 1
					t["client_id"] = clientID
					t["source_message_id"] = id
					t["created_at"] = store.Now()
					t["updated_at"] = t["created_at"]
					exec(ctx, db, "INSERT INTO tasks(id,user_id,version,client_id,payload) VALUES(?,?,?,?,?)", t["id"], user, 1, clientID, store.JSON(t))
					event(ctx, db, user, "task.upsert", str(t, "id"))
					created = s.task(ctx, db, user, str(t, "id"))
					action = "created"
				}
			}
			if created != nil {
				current["auto_task_id"] = created["id"]
				current["auto_task_action"] = action
				result["auto_task_action"] = action
			}
		}
		current["analysis"] = result
		delete(current, "analysis_error")
		delete(current, "analysis_pending")
		delete(current, "analysis_state")
		s.saveTriggerTurn(ctx, db, user, sessionID, current, result)
		result["session_id"] = sessionID
		exec(ctx, db, "UPDATE messages SET payload=? WHERE id=? AND user_id=?", store.JSON(current), id, user)
		exec(ctx, db, "UPDATE analysis_jobs SET state='done',error='' WHERE message_id=? AND state IN ('queued','running')", id)
		event(ctx, db, user, "message.upsert", id)
		return nil
	})
	if created != nil {
		result["auto_created_task"] = created
	}
	success = true
	runSuccess = true
	return result
}
// analyzeWorker 在「消息密集」时攒批一次调用模型，单条消息仍走原
// runAnalysis（保留工具、持久会话、SSE 实时输出和 stop 能力）。
// 这样既解决 burst 场景下逐条往返叠加的延迟，又不破坏依赖单条路径的行为。
func (s *Server) analyzeWorker(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := attempt(func() any {
				// 取最老的一个用户，保证多用户公平。
				users := query(ctx, s.Store.DB, `SELECT user_id,MIN(id) AS first_job
					FROM analysis_jobs
					WHERE state='queued' AND next_at<=?
					GROUP BY user_id ORDER BY first_job LIMIT 1`, timestamp())
				if len(users) == 0 {
					return nil
				}
				user := str(users[0], "user_id")
				targets := s.gatherBatchTargets(ctx, user, batchAnalysisSize)
				if len(targets) == 0 {
					s.retireStaleJobs(ctx, user)
					return nil
				}
				// 只有 >=2 条时才考虑攒批；单条立即走原逐条路径。
				if len(targets) < 2 {
					s.runSingleJob(ctx, user, targets[0])
					return nil
				}
				// 攒批条件：凑满 batchAnalysisSize，或队列最新消息已静默
				// batchAnalysisIdleSec，或最老消息超过等待上限。
				oldest, newest := time.Now(), time.Time{}
				for _, target := range targets {
					if at, err := time.Parse(time.RFC3339Nano, str(target.Message, "created_at")); err == nil {
						if at.Before(oldest) {
							oldest = at
						}
						if at.After(newest) {
							newest = at
						}
					}
				}
				idle := time.Since(newest)
				ready := len(targets) >= batchAnalysisSize || idle >= batchAnalysisIdleSec*time.Second || time.Since(oldest) >= batchAnalysisWaitMax
				if !ready {
					return nil
				}
				// 占住整批 job；批量写回阶段会统一收尾 agent_runs。
				for _, target := range targets {
					exec(ctx, s.Store.DB, "UPDATE analysis_jobs SET state='running',attempts=attempts+1 WHERE id=?", target.JobID)
					event(ctx, s.Store.DB, user, "message.upsert", str(target.Message, "id"))
				}
				callCtx, stop := context.WithTimeout(ctx, 300*time.Second)
				written := s.runBatchAnalysis(callCtx, user, targets, nil)
				stop()
				if ctx.Err() != nil {
					return nil
				}
				if written > 0 {
					s.retryMissingBatch(ctx, user, targets)
					return nil
				}
				s.failBatchJobs(ctx, user, targets)
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

// runSingleJob 是原 analyzeWorker 的单条路径，保持 SSE 实时输出、工具调用、
// 持久会话与 stop/cancel 语义不变。
func (s *Server) runSingleJob(ctx context.Context, user string, target batchTarget) {
	job := Object{
		"id": target.JobID, "user_id": user, "message_id": str(target.Message, "id"),
		"attempts": target.Attempts,
	}
	exec(ctx, s.Store.DB, "UPDATE analysis_jobs SET state='running',attempts=attempts+1 WHERE id=?", target.JobID)
	event(ctx, s.Store.DB, user, "message.upsert", str(target.Message, "id"))
	callCtx, stop := context.WithTimeout(ctx, 180*time.Second)
	_, callErr := attempt(func() any {
		return s.runAnalysis(callCtx, user, Object{"message_id": str(target.Message, "id"), "_automatic": true}, nil)
	})
	stop()
	if ctx.Err() != nil {
		return
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
		row := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", str(job, "message_id"), user))
		cancelled := first(query(ctx, db, "SELECT state FROM analysis_jobs WHERE id=?", target.JobID))
		if str(cancelled, "state") == "cancelled" {
			event(ctx, db, user, "message.upsert", str(job, "message_id"))
			return nil
		}
		if row == nil {
			state = "ignored"
		} else {
			m := store.Payload(row)
			if len(object(m["analysis"])) > 0 {
				state, errorText = "done", ""
			}
			if str(m, "triage") == "ignored" {
				state = "ignored"
			}
			if errorText != "" {
				m["analysis_error"] = errorText
				exec(ctx, db, "UPDATE messages SET payload=? WHERE id=?", store.JSON(m), str(job, "message_id"))
			}
		}
		if callErr != nil && choice(state, "queued", "failed") {
			runID := "notification-" + str(job, "message_id")
			if run := first(query(ctx, db, "SELECT payload FROM agent_runs WHERE id=? AND user_id=?", runID, user)); run != nil {
				payload := store.Payload(run)
				payload["state"] = state
				payload["stage"] = "retrying"
				payload["error"] = errorText
				exec(ctx, db, "UPDATE agent_runs SET state=?,payload=?,updated_at=? WHERE id=? AND user_id=? AND state<>'cancelled'", state, store.JSON(payload), store.Now(), runID, user)
			}
		}
		exec(ctx, db, "UPDATE analysis_jobs SET state=?,error=?,next_at=? WHERE id=?", state, errorText, next, target.JobID)
		event(ctx, db, user, "message.upsert", str(job, "message_id"))
		return nil
	})
}

// retryMissingBatch 把批量结果缺失的单条转回单条 runAnalysis 路径。
func (s *Server) retryMissingBatch(ctx context.Context, user string, targets []batchTarget) {
	for _, target := range targets {
		id := str(target.Message, "id")
		row := first(query(ctx, s.Store.DB, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, user))
		if row == nil {
			continue
		}
		m := store.Payload(row)
		if len(object(m["analysis"])) > 0 {
			continue // 批量已写入
		}
		if str(m, "triage") == "ignored" {
			s.transaction(ctx, func(db store.SQL) any {
				exec(ctx, db, "UPDATE analysis_jobs SET state='ignored' WHERE message_id=? AND user_id=?", id, user)
				return nil
			})
			continue
		}
		// 模型漏判：回到逐条 runAnalysis，由 analyzeWorker 下一轮的
		// 单条 fallback 兜底。这里直接调用一次，失败保留 queued。
		callCtx, stop := context.WithTimeout(ctx, 180*time.Second)
		_, callErr := attempt(func() any {
			return s.runAnalysis(callCtx, user, Object{"message_id": id, "_automatic": true}, nil)
		})
		stop()
		if ctx.Err() != nil {
			return
		}
		state, errorText, next := "done", "", float64(0)
		if callErr != nil {
			state = "queued"
			errorText = "批量结果缺失，单条重试未完成"
			next = timestamp() + 20
			if target.Attempts >= batchAnalysisMaxRetry {
				state = "failed"
				errorText = "自动分析失败，请检查模型设置后重试"
			}
		}
		s.transaction(ctx, func(db store.SQL) any {
			row := first(query(ctx, s.Store.DB, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, user))
			if row != nil {
				m := store.Payload(row)
				if len(object(m["analysis"])) > 0 {
					state, errorText = "done", ""
				}
				if errorText != "" {
					m["analysis_error"] = errorText
					exec(ctx, db, "UPDATE messages SET payload=? WHERE id=?", store.JSON(m), id)
				}
			}
			exec(ctx, db, "UPDATE analysis_jobs SET state=?,error=?,next_at=? WHERE message_id=? AND user_id=? AND state='running'", state, errorText, next, id, user)
			event(ctx, db, user, "message.upsert", id)
			return nil
		})
	}
}

// failBatchJobs 批量整体失败时统一推进重试状态。
func (s *Server) failBatchJobs(ctx context.Context, user string, targets []batchTarget) {
	s.transaction(ctx, func(db store.SQL) any {
		for _, target := range targets {
			state, errorText, next := "queued", "本次批量分析未完成，稍后自动重试", timestamp()+30
			if target.Attempts >= batchAnalysisMaxRetry {
				state = "failed"
				errorText = "自动分析失败，请检查模型设置后重试"
				next = 0
			}
			exec(ctx, db, "UPDATE analysis_jobs SET state=?,error=?,next_at=? WHERE id=?", state, errorText, next, target.JobID)
			event(ctx, db, user, "message.upsert", str(target.Message, "id"))
		}
		return nil
	})
}

// retireStaleJobs 把消息已删除或已忽略的孤儿 job 收尾。
func (s *Server) retireStaleJobs(ctx context.Context, user string) {
	s.transaction(ctx, func(db store.SQL) any {
		rows := query(ctx, db, `SELECT a.id,a.message_id,m.payload FROM analysis_jobs a
			LEFT JOIN messages m ON m.id=a.message_id AND m.user_id=a.user_id
			WHERE a.user_id=? AND a.state='queued' LIMIT 100`, user)
		for _, row := range rows {
			m := store.Payload(row)
			if row["payload"] == nil || str(m, "triage") == "ignored" {
				exec(ctx, db, "UPDATE analysis_jobs SET state='ignored' WHERE id=?", row["id"])
			}
		}
		return nil
	})
}


var _ = strings.TrimSpace
