package api

import (
	"context"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestSyncSocketWakesForCommittedMessage(t *testing.T) {
	s := testServer(t)
	token, _ := login(t, s, "sync-student")
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/sync", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err = wsjson.Write(ctx, conn, Object{"token": token, "after": 0}); err != nil {
		t.Fatal(err)
	}
	deliveries := make(chan Object, 1)
	readErrors := make(chan error, 1)
	go func() {
		var change Object
		if err := wsjson.Read(ctx, conn, &change); err != nil {
			readErrors <- err
			return
		}
		deliveries <- change
	}()
	status, message := call(t, s, "POST", "/api/messages", token, Object{
		"source": "manual", "account_id": "manual", "conversation_id": "sync-chat",
		"external_id": "sync-message", "text": "同步新消息", "sent_at": time.Now().Format(time.RFC3339Nano),
	})
	if status != 201 {
		t.Fatalf("create message: %d %v", status, message)
	}
	var changes Object
	select {
	case changes = <-deliveries:
	case err = <-readErrors:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if str(changes, "type") != "changes" {
		t.Fatalf("unexpected sync response: %v", changes)
	}
	found := false
	for _, change := range objects(changes["events"]) {
		found = found || str(change, "kind") == "message.upsert" && str(change, "entity_id") == str(message, "id")
	}
	if !found {
		t.Fatalf("committed message did not wake sync client: %v", changes)
	}
}

func TestAgentActivitySkipsUnchangedRunPayload(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "activity-student")
	session := Object{"id": "activity-session"}
	exec(context.Background(), s.Store.DB, "INSERT INTO agent_sessions(id,user_id,title,permission,created_at,updated_at) VALUES(?,?,?,?,?,?)", session["id"], user, "活动测试", "full", store.Now(), store.Now())
	s.transaction(context.Background(), func(db store.SQL) any {
		s.queueAgentRun(context.Background(), db, user, "activity-run", str(session, "id"), "")
		return nil
	})
	route := "/api/agent/sessions/" + str(session, "id") + "/activity"
	status, activity := call(t, s, "GET", route, token, nil)
	if status != 200 || str(activity, "activity_updated_at") == "" {
		t.Fatalf("initial activity: %d %v", status, activity)
	}
	status, unchanged := call(t, s, "GET", route+"?since="+url.QueryEscape(str(activity, "activity_updated_at")), token, nil)
	runs := objects(unchanged["runs"])
	if status != 200 || !boolean(unchanged, "unchanged") || len(runs) != 1 || len(objects(runs[0]["tools"])) != 0 {
		t.Fatalf("unchanged activity should be lightweight: %d %v", status, unchanged)
	}
}
