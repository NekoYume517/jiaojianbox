package gui

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestReleaseFromAtomProvidesUpdateMetadata(t *testing.T) {
	body := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>v0.6.17</title>
    <link rel="alternate" type="text/html" href="https://github.com/NekoYume517/jiaojianbox/releases/tag/v0.6.17"/>
    <content type="html">&lt;h1&gt;0.6.17&lt;/h1&gt;&lt;p&gt;修复 &lt;strong&gt;更新检查&lt;/strong&gt;。&lt;/p&gt;</content>
  </entry>
</feed>`)
	release, err := releaseFromAtom(body)
	if err != nil {
		t.Fatal(err)
	}
	if latest := getString(release, "latest"); latest != "0.6.17" {
		t.Fatalf("latest = %q", latest)
	}
	if asset := getString(release, "asset"); asset != "JiaojianBox-Setup-0.6.17-x64.exe" {
		t.Fatalf("asset = %q", asset)
	}
	if assetURL := getString(release, "assetUrl"); assetURL != "https://github.com/NekoYume517/jiaojianbox/releases/download/v0.6.17/JiaojianBox-Setup-0.6.17-x64.exe" {
		t.Fatalf("assetUrl = %q", assetURL)
	}
	if notes := getString(release, "notes"); !strings.Contains(notes, "修复 更新检查。") {
		t.Fatalf("notes = %q", notes)
	}
}

func TestReleaseFromAtomRejectsEmptyFeed(t *testing.T) {
	if _, err := releaseFromAtom([]byte(`<feed xmlns="http://www.w3.org/2005/Atom"></feed>`)); err == nil {
		t.Fatal("expected empty feed error")
	}
}

func TestFetchLatestReleaseFallsBackAfterRateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api":
			http.Error(w, `{"message":"API rate limit exceeded"}`, http.StatusForbidden)
		case "/atom":
			w.Header().Set("Content-Type", "application/atom+xml")
			fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>v0.6.17</title>
    <link rel="alternate" href="https://github.com/NekoYume517/jiaojianbox/releases/tag/v0.6.17"/>
    <content type="html">&lt;p&gt;限流回退验证&lt;/p&gt;</content>
  </entry>
</feed>`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	oldAPIURL, oldAtomURL, oldClient := updaterAPIURL, updaterAtomURL, updateClient
	t.Cleanup(func() {
		updaterAPIURL, updaterAtomURL, updateClient = oldAPIURL, oldAtomURL, oldClient
	})
	updaterAPIURL = server.URL + "/api"
	updaterAtomURL = server.URL + "/atom"
	updateClient = server.Client()

	desktop := &Desktop{ctx: context.Background(), version: "0.6.16"}
	release, err := desktop.fetchLatestRelease()
	if err != nil {
		t.Fatal(err)
	}
	if latest := getString(release, "latest"); latest != "0.6.17" {
		t.Fatalf("latest = %q", latest)
	}
	if notes := getString(release, "notes"); notes != "限流回退验证" {
		t.Fatalf("notes = %q", notes)
	}
}

func TestLiveLatestReleaseFallback(t *testing.T) {
	if os.Getenv("JJB_LIVE_UPDATE_TEST") != "1" {
		t.Skip("set JJB_LIVE_UPDATE_TEST=1 to exercise the live GitHub fallback")
	}
	desktop := &Desktop{ctx: context.Background(), version: "0.6.17"}
	release, err := desktop.fetchLatestRelease()
	if err != nil {
		t.Fatal(err)
	}
	if latest := getString(release, "latest"); latest == "" {
		t.Fatal("live update lookup returned an empty version")
	}
	if assetURL := getString(release, "assetUrl"); !strings.Contains(assetURL, "/releases/download/") {
		t.Fatalf("assetUrl = %q", assetURL)
	}
}
