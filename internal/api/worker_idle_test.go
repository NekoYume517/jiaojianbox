package api

import (
	"context"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestAnalysisWorkerBacksOffForPendingTriage(t *testing.T) {
	database, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx := context.Background()
	exec(ctx, database.DB, "INSERT INTO users(id,username) VALUES('test-user','test-user')")
	user := "test-user"
	exec(ctx, database.DB, "INSERT INTO messages(id,user_id,payload,created_at) VALUES(?,?,?,?)", "pending", user, store.JSON(Object{
		"triage_state": "pending", "triage_next_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}), store.Now())
	s := &Server{Store: database}
	delay := s.analysisWorkerDelay(ctx, 0)
	if delay < 20*time.Second || delay > 30*time.Second {
		t.Fatalf("pending triage must not cause a hot loop, delay=%v", delay)
	}
}
