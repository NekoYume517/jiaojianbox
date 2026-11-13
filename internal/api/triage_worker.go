package api

// 分诊 worker：把同一会话里「本地规则拿不准」的消息攒成一批，
// 一次轻量模型调用决定哪些升级为深度分析，其余只留摘要用。

import (
	"context"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

const (
	triageIdleMinutes = 3
	triageMaxWait     = 20 * time.Minute
)

type triageGroup struct {
	User       string
	Source     string
	Account    string
	Conversation string
	Name       string
	Messages   []Object
}

func (s *Server) pendingTriageGroups(ctx context.Context, force bool) []triageGroup {
	rows := query(ctx, s.Store.DB, `SELECT user_id,rowid AS message_rowid,payload FROM messages
		WHERE json_extract(payload,'$.triage_state')='pending'
		ORDER BY rowid LIMIT 400`)
	groups := map[string]*triageGroup{}
	order := []string{}
	for _, row := range rows {
		m := store.Payload(row)
		owner := str(row, "user_id")
		if owner == "" {
			owner = str(m, "user_id")
		}
		key := strings.Join([]string{owner, str(m, "source"), str(m, "account_id"), str(m, "conversation_id")}, "\x00")
		group := groups[key]
		if group == nil {
			group = &triageGroup{
				User: owner, Source: str(m, "source"),
				Account: str(m, "account_id"), Conversation: str(m, "conversation_id"),
				Name: str(m, "conversation_name"),
			}
			groups[key] = group
			order = append(order, key)
		}
		group.Messages = append(group.Messages, m)
	}
	// 同一会话里等待最久的消息超过阈值，或已静默足够久，才触发一次批量判断。
	now := time.Now()
	ready := []triageGroup{}
	for _, key := range order {
		group := groups[key]
		messages := group.Messages
		if len(messages) == 0 {
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
				User: group.User, Source: group.Source, Account: group.Account,
				Conversation: group.Conversation, Name: group.Name, Messages: messages,
			})
		}
	}
	return ready
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
				// 模型漏判：保守当作闲聊，不再占用后续额度。
				verdict = Object{"verdict": "chatting", "confidence": 0.0, "reason": "分诊未返回", "layer": "batch"}
			}
			current["triage_state"] = "done"
			current["triage_batch"] = verdict
			label := str(verdict, "verdict")
			if label == "actionable" && num(verdict, "confidence") >= 0.5 {
				// 第三层：只把批判断为 actionable 的消息送进深度分析。
				exec(ctx, db, "INSERT OR IGNORE INTO analysis_jobs(user_id,message_id) VALUES(?,?)", group.User, id)
				current["analysis_pending"] = true
				current["analysis_state"] = "queued"
			} else {
				// 入库时已先入队；批量分诊判定为非待办就要撤回队列，
				// 否则深度分析仍会为每条闲聊各调用一次模型。
				exec(ctx, db, "UPDATE analysis_jobs SET state='skipped' WHERE message_id=? AND user_id=? AND state='queued'", id, group.User)
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
					if verdicts == nil {
						// 模型不可用：消息保持 pending，下一轮再试。
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
