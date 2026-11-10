package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
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

func TestServiceSelectionPreservesCustomSettings(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "service-selector")
	exec(context.Background(), s.Store.DB, "INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')", user)
	call(t, s, "PUT", "/api/admin/ai-service", token, Object{"enabled": true, "upstream_url": "https://managed.example/v1", "upstream_model": "server-model", "upstream_key": "server-key"})
	config := Object{"service_mode": "custom", "base_url": "https://custom.example/v1", "model": "my-model", "api_key": "my-key"}
	code, _ := call(t, s, "PUT", "/api/settings/llm", token, config)
	if code != 200 {
		t.Fatal(code)
	}
	config["service_mode"] = "managed"
	delete(config, "api_key")
	code, _ = call(t, s, "PUT", "/api/settings/llm", token, config)
	if code != 200 {
		t.Fatal(code)
	}
	resolved, key := s.resolveLLM(context.Background(), user)
	if str(resolved, "model") != "server-model" || key != "server-key" {
		t.Fatal(resolved)
	}
	config["service_mode"] = "custom"
	call(t, s, "PUT", "/api/settings/llm", token, config)
	resolved, key = s.resolveLLM(context.Background(), user)
	if str(resolved, "model") != "my-model" || key != "my-key" {
		t.Fatal("custom configuration lost", resolved)
	}
	// An explicit custom selection must never silently spend server credits.
	config["base_url"] = ""
	config["model"] = ""
	call(t, s, "PUT", "/api/settings/llm", token, config)
	resolved, _ = s.resolveLLM(context.Background(), user)
	if boolean(resolved, "managed") {
		t.Fatal("custom mode fell back to paid server AI")
	}
	for _, source := range []string{"managed", "custom"} {
		exec(context.Background(), s.Store.DB, "INSERT INTO llm_calls(id,user_id,kind,model,status,started_at,total_tokens,managed) VALUES(?,?,?,?,?,?,?,?)", source, user, "file", source, "success", time.Now().UTC().Format(time.RFC3339Nano), 100, source == "managed")
	}
	for _, source := range []string{"managed", "custom"} {
		code, stats := call(t, s, "GET", "/api/statistics?source="+source, token, nil)
		if code != 200 || num(object(stats["total"]), "calls") != 1 || num(object(stats["total"]), source+"_tokens") != 100 {
			t.Fatal(source, code, stats)
		}
	}
}

func TestManagedVisionIsControlledByAdmin(t *testing.T) {
	s := testServer(t)
	adminToken, adminID := login(t, s, "vision-admin")
	userToken, user := login(t, s, "vision-user")
	exec(context.Background(), s.Store.DB, "INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')", adminID)
	service := Object{"enabled": true, "vision_enabled": true, "upstream_url": "https://managed.example/v1", "upstream_model": "vision-model", "upstream_key": "fixture-key"}
	if code, _ := call(t, s, "PUT", "/api/admin/ai-service", userToken, service); code != 403 {
		t.Fatal("ordinary user changed server model", code)
	}
	code, saved := call(t, s, "PUT", "/api/admin/ai-service", adminToken, service)
	if code != 200 || !boolean(saved, "vision_enabled") {
		t.Fatal(code, saved)
	}
	call(t, s, "PUT", "/api/settings/llm", userToken, Object{"service_mode": "managed", "vision_enabled": false})
	config, _ := s.resolveLLM(context.Background(), user)
	if !boolean(config, "vision_enabled") {
		t.Fatal("user setting disabled managed vision")
	}
	_, credit := call(t, s, "GET", "/api/ai/credit", userToken, nil)
	if !boolean(credit, "vision_enabled") {
		t.Fatal("public capability missing", credit)
	}
	call(t, s, "PUT", "/api/admin/ai-service", adminToken, Object{"vision_enabled": false})
	call(t, s, "PUT", "/api/settings/llm", userToken, Object{"service_mode": "managed", "vision_enabled": true})
	config, _ = s.resolveLLM(context.Background(), user)
	if boolean(config, "vision_enabled") {
		t.Fatal("user setting enabled unsupported managed vision")
	}
	_, saved = call(t, s, "GET", "/api/admin/ai-service", adminToken, nil)
	if boolean(saved, "vision_enabled") || !boolean(saved, "has_key") {
		t.Fatal("capability or existing key not preserved", saved)
	}
	call(t, s, "PUT", "/api/settings/llm", userToken, Object{"service_mode": "custom", "vision_enabled": true, "base_url": "https://custom.example/v1", "model": "custom-model"})
	config, _ = s.resolveLLM(context.Background(), user)
	if !boolean(config, "vision_enabled") || boolean(config, "managed") {
		t.Fatal("custom vision incorrectly overridden")
	}
}
