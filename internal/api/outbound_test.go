package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOutboundURLRejectsNonHTTPAndCredentials(t *testing.T) {
	t.Setenv("JJB_ALLOW_PRIVATE_UPSTREAMS", "false")
	for _, value := range []string{
		"file:///etc/passwd",
		"http://user:password@example.com/v1",
		"gopher://example.com",
		"http://example.com\\@127.0.0.1/v1",
		"http://example.com/\r\nX-Injected: true",
	} {
		if _, err := outboundURL(value); err == nil {
			t.Fatalf("unsafe endpoint accepted: %s", value)
		}
	}
}

func TestOutboundURLBlocksPrivateAndMetadataAddresses(t *testing.T) {
	t.Setenv("JJB_ALLOW_PRIVATE_UPSTREAMS", "false")
	for _, value := range []string{
		"http://127.0.0.1:8765/v1",
		"http://10.0.0.2/v1",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]/v1",
		"http://[fd00::1]/v1",
	} {
		if err := validateOutboundURL(context.Background(), value); err == nil {
			t.Fatalf("private endpoint accepted: %s", value)
		}
	}
}

func TestStoredOutboundURLDoesNotRequireDNS(t *testing.T) {
	t.Setenv("JJB_ALLOW_PRIVATE_UPSTREAMS", "false")
	if err := validateStoredOutboundURL("https://model.example.test/v1/chat/completions"); err != nil {
		t.Fatalf("offline-valid endpoint was rejected before use: %v", err)
	}
	if err := validateStoredOutboundURL("http://169.254.169.254/latest/meta-data"); err == nil {
		t.Fatal("literal metadata address was accepted")
	}
}

func TestOutboundClientAllowsExplicitLocalDevelopment(t *testing.T) {
	t.Setenv("JJB_ALLOW_PRIVATE_UPSTREAMS", "true")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	request, err := outboundRequest(context.Background(), http.MethodGet, upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := outboundClient(5 * 1e9).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal(response.StatusCode)
	}
}

func TestPublicOutboundURLRequiresHTTPS(t *testing.T) {
	t.Setenv("JJB_ALLOW_PRIVATE_UPSTREAMS", "false")
	if _, err := outboundURL("http://model.example.test/v1"); err == nil {
		t.Fatal("public HTTP model endpoint was accepted")
	}
	if _, err := outboundURL("https://model.example.test/v1"); err != nil {
		t.Fatalf("public HTTPS model endpoint was rejected: %v", err)
	}
}
