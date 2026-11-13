package api

// 分诊 worker：把同一会话里「本地规则拿不准」的消息攒成一批，
// 一次轻量模型调用决定哪些升级为深度分析，其余只留摘要用。

import (
	"context"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

const (
	triageIdleMinutes = 3
	triageMaxWait     = 20 * time.Minute
	triageGroupsPass  = 24
	triageRetryDelay  = 2 * time.Minute
)

type triageGroup struct {
	User         string
	Source       string
	Account      string
	Conversation string
	Name         string
	Messages     []Object
}

func (s *Server) pendingTriageGroups(ctx context.Context, force bool) []triageGroup {
	// Select one conversation for each user before loading its messages. A
	// single busy account can therefore never consume the global batch limit.
	users := query(ctx, s.Store.DB, `
		SELECT user_id,MIN(rowid) AS first_row
		FROM messages
		WHERE deleted_at IS NULL
			AND json_extract(payload,'$.triage_state')='pending'
		GROUP BY user_id
		ORDER BY first_row
		LIMIT ?`, triageGroupsPass)
	groupRows := []Object{}
	for _, userRow := range users {
		row := first(query(ctx, s.Store.DB, `
			SELECT user_id,
				json_extract(payload,'$.source') AS source,
				json_extract(payload,'$.account_id') AS account_id,
				json_extract(payload,'$.conversation_id') AS conversation_id,
				MIN(rowid) AS first_row
			FROM messages
			WHERE user_id=? AND deleted_at IS NULL
				AND json_extract(payload,'$.triage_state')='pending'
			GROUP BY source,account_id,conversation_id
			ORDER BY first_row LIMIT 1`, str(userRow, "user_id")))
		if row != nil {
			groupRows = append(groupRows, row)
		}
	}
	// 同一会话里等待最久的消息超过阈值，或已静默足够久，才触发一次批量判断。
	now := time.Now()
	ready := []triageGroup{}
	for _, groupRow := range groupRows {
		rows := query(ctx, s.Store.DB, `SELECT user_id,rowid AS message_rowid,payload
			FROM messages
			WHERE user_id=? AND deleted_at IS NULL
				AND json_extract(payload,'$.source')=?
				AND json_extract(payload,'$.account_id')=?
				AND json_extract(payload,'$.conversation_id')=?
				AND json_extract(payload,'$.triage_state')='pending'
			ORDER BY rowid LIMIT ?`,
			str(groupRow, "user_id"), str(groupRow, "source"), str(groupRow, "account_id"),
			str(groupRow, "conversation_id"), triageBatchSize)
		if len(rows) == 0 {
			continue
		}
		messages := []Object{}
		for _, row := range rows {
			messages = append(messages, store.Payload(row))
		}
		if retryAt, err := time.Parse(time.RFC3339Nano, str(messages[0], "triage_next_at")); err == nil && retryAt.After(now) {
			continue
		}
		oldest, _ := time.Parse(time.RFC3339Nano, str(messages[0], "created_at"))
		newest := oldest
		for _, m := range messages {
			if at, err := time.Parse(time.RFC3339Nano, str(m, "created_at")); err == nil && at.After(newest) {
				newest = at
			}
		}
		idle := now.Sub(newest)
		if force || len(messages) >= triageBatchSize || idle >= triageIdleMinutes*time.Minute || now.Sub(oldest) >= triageMaxWait {
			if len(messages) > triageBatchSize {
				messages = messages[:triageBatchSize]
			}
			ready = append(ready, triageGroup{
				User: str(groupRow, "user_id"), Source: str(groupRow, "source"), Account: str(groupRow, "account_id"),
				Conversation: str(groupRow, "conversation_id"), Name: str(messages[0], "conversation_name"), Messages: messages,
			})
		}
		if len(ready) >= triageGroupsPass {
			break
		}
	}
	return ready
}

func (s *Server) deferTriageGroup(ctx context.Context, group triageGroup, retryAt time.Time, reason string) {
	s.transaction(ctx, func(db store.SQL) any {
		rows := query(ctx, db, `SELECT id,payload FROM messages
			WHERE user_id=? AND json_extract(payload,'$.triage_state')='pending'`, group.User)
		for _, row := range rows {
			current := store.Payload(row)
			current["triage_next_at"] = retryAt.UTC().Format(time.RFC3339Nano)
			current["triage_error"] = reason
			id := str(current, "id")
			exec(ctx, db, "UPDATE messages SET payload=? WHERE id=? AND user_id=?", store.JSON(current), id, group.User)
			event(ctx, db, group.User, "message.upsert", id)
		}
		return nil
	})
}

func (s *Server) applyTriage(ctx context.Context, group triageGroup, verdicts map[string]Object) {
	s.transaction(ctx, func(db store.SQL) any {
		for _, m := range group.Messages {
			id := str(m, "id")
			row := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", id, group.User))
			if row == nil {
				continue
			}
			current := store.Payload(row)
			verdict := verdicts[id]
			if verdict == nil {
				// Keep a missing model verdict pending. Guessing "chatting" here
				// permanently discards potentially actionable notifications.
				current["triage_next_at"] = time.Now().Add(triageRetryDelay).UTC().Format(time.RFC3339Nano)
				current["triage_error"] = "分诊结果缺失，稍后重试"
				exec(ctx, db, "UPDATE messages SET payload=? WHERE id=? AND user_id=?", store.JSON(current), id, group.User)
				event(ctx, db, group.User, "message.upsert", id)
				continue
			}
			current["triage_state"] = "done"
			delete(current, "triage_next_at")
			delete(current, "triage_error")
			current["triage_batch"] = verdict
			label := str(verdict, "verdict")
			if label == "actionable" && num(verdict, "confidence") >= 0.5 {
				// 第三层：只把批判断为 actionable 的消息送进深度分析。
				exec(ctx, db, "INSERT OR IGNORE INTO analysis_jobs(user_id,message_id) VALUES(?,?)", group.User, id)
				current["analysis_pending"] = true
				current["analysis_state"] = "queued"
			} else {
				// Older pending messages may already have both queues. Retire
				// them together so trigger history cannot show a ghost task.
				exec(ctx, db, "UPDATE analysis_jobs SET state='skipped' WHERE message_id=? AND user_id=? AND state='queued'", id, group.User)
				runID := "notification-" + id
				if run := first(query(ctx, db, "SELECT payload,session_id FROM agent_runs WHERE id=? AND user_id=? AND state IN ('queued','running')", runID, group.User)); run != nil {
					payload := store.Payload(run)
					payload["state"] = "skipped"
					payload["stage"] = "skipped"
					payload["text"] = "消息已被批量分诊跳过，未调用深度分析。"
					payload["error"] = ""
					exec(ctx, db, "UPDATE agent_runs SET state='skipped',payload=?,updated_at=? WHERE id=? AND user_id=?", store.JSON(payload), store.Now(), runID, group.User)
					event(ctx, db, group.User, "agent.run.upsert", str(run, "session_id"))
				}
				delete(current, "analysis_pending")
				delete(current, "analysis_state")
			}
			// 非 actionable 只保留分诊结论，不写 analysis，避免前端把它当成深度结果。
			current["triage_result"] = verdict
			exec(ctx, db, "UPDATE messages SET payload=? WHERE id=? AND user_id=?", store.JSON(current), id, group.User)
			event(ctx, db, group.User, "message.upsert", id)
		}
		return nil
	})
}

func (s *Server) triageWorker(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := attempt(func() any {
				groups := s.pendingTriageGroups(ctx, false)
				for _, group := range groups {
					if ctx.Err() != nil {
						return nil
					}
					callCtx, stop := context.WithTimeout(ctx, 90*time.Second)
					verdicts := s.triageBatch(callCtx, group.User, group.Messages, nil)
					stop()
					if len(verdicts) == 0 {
						// Model unavailable or malformed: move this user's
						// pending work behind other users before retrying.
						s.deferTriageGroup(ctx, group, time.Now().Add(triageRetryDelay), "批量分诊暂不可用，稍后重试")
						continue
					}
					s.applyTriage(ctx, group, verdicts)
				}
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
