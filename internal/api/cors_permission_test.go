package api

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDesktopPermissionCORSPreflight(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/api/agent/sessions/example", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	req.Header.Set("Access-Control-Request-Method", http.MethodPatch)
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	out := httptest.NewRecorder()
	s.ServeHTTP(out, req)
	if out.Code != http.StatusNoContent || !strings.Contains(out.Header().Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatalf("desktop permission preflight rejected: %d %v", out.Code, out.Header())
	}
	token, _ := login(t, s, "cors-permission")
	code, session := call(t, s, "POST", "/api/agent/sessions", token, Object{"title": "桌面跨域权限"})
	if code != 200 {
		t.Fatal(code, session)
	}
	id := str(object(session["session"]), "id")
	for _, permission := range []string{"full", "restricted"} {
		req = httptest.NewRequest(http.MethodPatch, "/api/agent/sessions/"+id, strings.NewReader(`{"permission":"`+permission+`"}`))
		req.Header.Set("Origin", "http://wails.localhost")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		out = httptest.NewRecorder()
		s.ServeHTTP(out, req)
		if out.Code != 200 || out.Header().Get("Access-Control-Allow-Origin") == "" {
			t.Fatalf("permission patch rejected: %d %s", out.Code, out.Body.String())
		}
		_, snapshot := call(t, s, "GET", "/api/agent/sessions/"+id, token, nil)
		if str(object(snapshot["state"]), "permission") != permission {
			t.Fatal(snapshot)
		}
	}
}

func TestAPIRejectsUntrustedBrowserOrigin(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/api/tasks", nil)
	req.Header.Set("Origin", "https://attacker.example")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	out := httptest.NewRecorder()
	s.ServeHTTP(out, req)
	if out.Code != http.StatusForbidden {
		t.Fatalf("untrusted origin got %d", out.Code)
	}
	if allow := out.Header().Get("Access-Control-Allow-Origin"); allow != "" {
		t.Fatalf("untrusted origin was allowed: %q", allow)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Origin", "https://attacker.example")
	out = httptest.NewRecorder()
	s.ServeHTTP(out, req)
	if out.Code != http.StatusForbidden {
		t.Fatalf("untrusted origin request got %d", out.Code)
	}
}

func TestAPIAcceptsLoopbackDevelopmentOrigin(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest(http.MethodPatch, "http://127.0.0.1:8765/api/agent/sessions/example", strings.NewReader(`{}`))
	req.Header.Set("Origin", "http://127.0.0.1:41000")
	req.Header.Set("Content-Type", "application/json")
	out := httptest.NewRecorder()
	s.ServeHTTP(out, req)
	if out.Code == http.StatusForbidden {
		t.Fatal("same-host loopback development origin was rejected")
	}
	if allow := out.Header().Get("Access-Control-Allow-Origin"); allow != "http://127.0.0.1:41000" {
		t.Fatalf("loopback origin was not allowed: %q", allow)
	}
}

func TestStaticHTMLUsesRevalidationAndGzip(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	out := httptest.NewRecorder()
	s.ServeHTTP(out, req)
	if out.Code != http.StatusOK {
		t.Fatalf("static request failed: %d", out.Code)
	}
	if got := out.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("unexpected HTML cache policy: %q", got)
	}
	if got := out.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("expected gzip response, got %q", got)
	}
	reader, err := gzip.NewReader(out.Body)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(body), "交件箱") {
		t.Fatalf("invalid gzip body: %q %v", body, err)
	}
}

func TestRegistrationDefaultsClosed(t *testing.T) {
	s := testServer(t)
	t.Setenv("JJB_ALLOW_REGISTRATION", "")
	status, policy := call(t, s, "GET", "/api/auth/registration", "", nil)
	if status != http.StatusOK || str(policy, "mode") != "closed" {
		t.Fatalf("unexpected registration default: %d %v", status, policy)
	}
	status, _ = call(t, s, "POST", "/api/auth/register", "", Object{
		"username": "blocked-user",
		"password": "fixture-password-123",
	})
	if status != http.StatusForbidden {
		t.Fatalf("registration was not closed by default: %d", status)
	}
}
