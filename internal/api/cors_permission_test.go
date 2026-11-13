package api

import (
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
