package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestManagedAICreditsAndCheckin(t *testing.T) {
	s := testServer(t)
	adminToken, adminID := login(t, s, "credit-admin")
	userToken, user := login(t, s, "credit-user")
	exec(context.Background(), s.Store.DB, "INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')", adminID)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, 200, Object{"choices": []any{Object{"message": Object{"content": `{"result":{"category":"reference","confidence":"90%"}}`}}}, "usage": Object{"total_tokens": 100}})
	}))
	defer upstream.Close()
	code, saved := call(t, s, "PUT", "/api/admin/ai-service", adminToken, Object{"enabled": true, "default_credits": 2, "tokens_per_credit": 100, "checkin_enabled": true, "checkin_credits": 1, "upstream_url": upstream.URL, "upstream_model": "managed-fixture", "upstream_key": "sk-managed-fixture"})
	if code != 200 || !boolean(saved, "enabled") || !boolean(saved, "has_key") || num(saved, "default_credits") != 2 {
		t.Fatal(code, saved)
	}
	code, credit := call(t, s, "GET", "/api/ai/credit", "", nil)
	if code != 401 {
		t.Fatal("credit requires login", code)
	}
	code, credit = call(t, s, "GET", "/api/ai/credit", adminToken, nil)
	if code != 200 || !boolean(credit, "enabled") || num(credit, "balance") != 2 || boolean(credit, "checked_today") || num(credit, "tokens_per_credit") != 100 {
		t.Fatal(code, credit)
	}
	code, credit = call(t, s, "GET", "/api/ai/credit", userToken, nil)
	if code != 200 || num(credit, "balance") != 2 {
		t.Fatal(code, credit)
	}
	// Managed calls spend credits: 100 tokens at 100 tokens per credit.
	_, file := uploaded(t, s, "/api/shelf", userToken, "notes.txt", []byte("hello managed"))
	code, _ = call(t, s, "POST", "/api/shelf/"+str(file, "id")+"/suggest", userToken, Object{})
	if code != 200 || calls.Load() != 1 {
		t.Fatal(code, calls.Load())
	}
	code, credit = call(t, s, "GET", "/api/ai/credit", userToken, nil)
	if code != 200 || num(credit, "balance") != 1 {
		t.Fatal(code, credit)
	}
	row := one(context.Background(), s.Store.DB, "SELECT managed,total_tokens FROM llm_calls WHERE model='managed-fixture'")
	if !boolean(row, "managed") || num(row, "total_tokens") != 100 {
		t.Fatal(row)
	}
	// Daily check-in adds credits once per day.
	code, checkin := call(t, s, "POST", "/api/ai/credit/checkin", userToken, nil)
	if code != 200 || num(checkin, "balance") != 2 {
		t.Fatal(code, checkin)
	}
	if code, _ := call(t, s, "POST", "/api/ai/credit/checkin", userToken, nil); code != 409 {
		t.Fatal("double check-in accepted", code)
	}
	// Empty balance refuses managed calls without touching the upstream.
	exec(context.Background(), s.Store.DB, "UPDATE ai_credits SET balance=0 WHERE user_id=?", user)
	code, _ = call(t, s, "POST", "/api/shelf/"+str(file, "id")+"/suggest", userToken, Object{})
	if code != 402 || calls.Load() != 1 {
		t.Fatal(code, calls.Load())
	}
	// Statistics expose managed tokens for the credits chart.
	_, stats := call(t, s, "GET", "/api/statistics", userToken, nil)
	total := object(stats["total"])
	if num(total, "managed_tokens") != 100 || num(total, "custom_tokens") != 0 {
		t.Fatal(total)
	}
}
