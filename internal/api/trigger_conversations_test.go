package api

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestConversationIdentityAndLegacyMigration(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "migration-user")
	ctx := context.Background()
	makeMessage := func(external, sender, account, chat string) Object {
		code, m := call(t, s, "POST", "/api/messages", token, Object{"source": "wechat", "account_id": account, "conversation_id": chat, "conversation_name": "同名群", "sender_name": sender, "external_id": external, "text": "原始通知 " + external, "sent_at": "2026-11-12T10:00:00+08:00"})
		if code != 201 {
			t.Fatal(m)
		}
		return m
	}
	first := makeMessage("1", "甲", "wx-a", "chat-a")
	second := makeMessage("2", "乙", "wx-a", "chat-a")
	otherAccount := makeMessage("3", "甲", "wx-b", "chat-a")
	otherChat := makeMessage("4", "甲", "wx-a", "chat-b")
	if conversationSessionID(user, first) != conversationSessionID(user, second) {
		t.Fatal("sender must not split chat")
	}
	if conversationSessionID(user, first) == conversationSessionID(user, otherAccount) || conversationSessionID(user, first) == conversationSessionID(user, otherChat) {
		t.Fatal("accounts/chats must remain isolated")
	}
	for i, m := range []Object{first, second} {
		old := "old-" + str(m, "id")
		now := store.Now()
		summary := ""
		if i == 0 {
			summary = "旧摘要：保留学号命名要求"
		}
		exec(ctx, s.Store.DB, `INSERT INTO agent_sessions(id,user_id,title,kind,trigger_source,trigger_account,trigger_conversation,trigger_sender,source_message_id,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, old, user, "旧任务", agentSessionNotification, "wechat", "wx-a", "同名群", str(m, "sender_name"), m["id"], summary, now, now)
		payload := Object{"role": "user", "content": "旧的续聊 " + str(m, "sender_name")}
		exec(ctx, s.Store.DB, `INSERT INTO agent_messages(id,user_id,session_id,payload,summarized,created_at) VALUES(?,?,?,?,0,?)`, "continued-"+str(m, "id"), user, old, store.JSON(payload), now)
	}
	s.migrateConversationSessions(ctx, user)
	s.migrateConversationSessions(ctx, user) // Must be idempotent.
	rows := query(ctx, s.Store.DB, "SELECT * FROM agent_sessions WHERE user_id=?", user)
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	id := str(rows[0], "id")
	messages := s.agentSessionMessages(ctx, user, id)
	raw := store.JSON(messages)
	if len(messages) != 3 || !strings.Contains(raw, "学号命名要求") || !strings.Contains(raw, "旧的续聊 甲") || !strings.Contains(raw, "旧的续聊 乙") {
		t.Fatal("migration lost history", messages)
	}
	if str(agentSessionObject(rows[0]), "origin_label") != "微信触发器" || str(rows[0], "title") != "同名群" {
		t.Fatal(rows)
	}
}

func TestConversationWaitCancellationDoesNotStopActiveTurn(t *testing.T) {
	s := testServer(t)
	release := s.lockConversationTurn(context.Background(), "user", "chat")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := attempt(func() any { unlock := s.lockConversationTurn(ctx, "user", "chat"); defer unlock(); return nil })
	if err == nil {
		t.Fatal("waiter should cancel")
	}
	other, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stop()
	_, err = attempt(func() any { unlock := s.lockConversationTurn(other, "user", "chat"); defer unlock(); return nil })
	if err == nil {
		t.Fatal("cancellation released active turn")
	}
	release()
	unlock := s.lockConversationTurn(context.Background(), "user", "chat")
	unlock()
}
