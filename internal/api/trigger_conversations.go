package api

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

// One turn at a time across automatic notifications and manual continuations.
// Waiting cancels only the waiter, never the turn currently holding the slot.
func (s *Server) lockConversationTurn(ctx context.Context, user, id string) func() {
	slot, _ := s.sessionTurns.LoadOrStore(user+":"+id, make(chan struct{}, 1))
	turn := slot.(chan struct{})
	select {
	case turn <- struct{}{}:
		return func() { <-turn }
	case <-ctx.Done():
		check(ctx.Err())
		return func() {}
	}
}

func conversationSessionID(user string, message Object) string {
	chat := str(message, "conversation_id")
	if chat == "" {
		chat = fallback(str(message, "conversation_name"), str(message, "id"))
	}
	identity := store.JSON([]string{user, str(message, "source"), str(message, "account_id"), chat})
	return fmt.Sprintf("chat-%x", sha256.Sum256([]byte(identity)))
}

func (s *Server) ensureConversationSession(ctx context.Context, db store.SQL, user string, message Object, limit int) string {
	id := conversationSessionID(user, message)
	title := fallback(str(message, "conversation_name"), fallback(str(message, "conversation_id"), "手动通知"))
	now := store.Now()
	exec(ctx, db, `INSERT INTO agent_sessions(id,user_id,title,kind,trigger_source,trigger_account,trigger_conversation,trigger_sender,trigger_chat_id,permission,context_limit,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,'full',?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,trigger_conversation=excluded.trigger_conversation`,
		id, user, clip(title, 120), agentSessionNotification, str(message, "source"), str(message, "account_id"), str(message, "conversation_name"), "", fallback(str(message, "conversation_id"), str(message, "conversation_name")), limit, now, now)
	return id
}

func (s *Server) saveTriggerTurn(ctx context.Context, db store.SQL, user, id string, message, analysis Object) {
	mid := str(message, "id")
	now := store.Now()
	created := fallback(str(message, "created_at"), now)
	content := fmt.Sprintf("%s · %s\n%s", fallback(str(message, "sender_name"), "通知"), str(message, "sent_at"), str(message, "text"))
	input := Object{"id": "trigger-user-" + mid, "role": "user", "content": content, "trigger": Object{"source": str(message, "source"), "message_id": mid}, "created_at": created}
	exec(ctx, db, `INSERT INTO agent_messages(id,user_id,session_id,payload,summarized,created_at) VALUES(?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING`, input["id"], user, id, store.JSON(input), created)
	if len(analysis) == 0 {
		event(ctx, db, user, "agent.session.upsert", id)
		return
	}
	answer := fallback(str(analysis, "summary"), "已处理这条消息。")
	if due := str(analysis, "due_at"); due != "" {
		answer += "\n截止时间：" + due
	}
	if link := str(analysis, "submit_url"); link != "" {
		answer += "\n提交入口：" + link
	}
	if task := str(message, "auto_task_id"); task != "" {
		answer += "\n关联待办：" + task
	}
	review := Object{"role": "assistant", "content": answer, "trigger": Object{"source": str(message, "source"), "message_id": mid}, "model": analysis["model"], "created_at": now, "tools": analysis["tools"]}

	exec(ctx, db, `INSERT INTO agent_messages(id,user_id,session_id,payload,summarized,created_at) VALUES(?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`, "trigger-review-"+mid, user, id, store.JSON(review), now)
	exec(ctx, db, `UPDATE agent_sessions SET preview=?,last_prompt_tokens=?,last_total_tokens=?,updated_at=? WHERE id=? AND user_id=?`, clip(str(analysis, "summary"), 360), int(num(object(analysis["performance"]), "prompt_tokens")), int(num(object(analysis["performance"]), "total_tokens")), now, id, user)
	event(ctx, db, user, "agent.session.upsert", id)
}

// Rehome old per-notification threads transactionally. Keep message IDs,
// continuations and old compressed summaries; no user content is discarded.
func (s *Server) migrateConversationSessions(ctx context.Context, user string) {
	s.transaction(ctx, func(db store.SQL) any {
		rows := query(ctx, db, "SELECT * FROM agent_sessions WHERE user_id=? AND kind=? AND id NOT LIKE 'chat-%'", user, agentSessionNotification)
		for _, row := range rows {
			original := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", str(row, "source_message_id"), user))
			message := store.Payload(original)
			if original == nil {
				message = Object{"id": str(row, "id"), "source": str(row, "trigger_source"), "account_id": str(row, "trigger_account"), "conversation_name": str(row, "trigger_conversation"), "conversation_id": fallback(str(row, "trigger_chat_id"), str(row, "trigger_conversation"))}
			}
			id := s.ensureConversationSession(ctx, db, user, message, int(num(row, "context_limit")))
			if summary := strings.TrimSpace(str(row, "summary")); summary != "" {
				payload := Object{"role": "assistant", "content": "此前会话的已压缩摘要（事实材料）：\n" + summary}
				exec(ctx, db, "INSERT OR IGNORE INTO agent_messages(id,user_id,session_id,payload,summarized,created_at) VALUES(?,?,?,?,0,?)", "migrated-summary-"+str(row, "id"), user, id, store.JSON(payload), row["created_at"])
			}
			exec(ctx, db, "UPDATE agent_messages SET session_id=?,summarized=0 WHERE session_id=? AND user_id=?", id, row["id"], user)
			exec(ctx, db, "DELETE FROM agent_sessions WHERE id=? AND user_id=?", row["id"], user)
		}
		return nil
	})
}
