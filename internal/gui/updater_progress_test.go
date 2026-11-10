package gui

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestUpdateDownloadProgressSurvivesViewReload(t *testing.T) {
	for _, known := range []bool{true, false} {
		t.Run(strconv.FormatBool(known), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if known {
					w.Header().Set("Content-Length", strconv.Itoa(10*4096))
				}
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				for i := 0; i < 10; i++ {
					if _, err := w.Write(make([]byte, 4096)); err != nil {
						return
					}
					w.(http.Flusher).Flush()
					time.Sleep(80 * time.Millisecond)
				}
			}))
			defer server.Close()
			root := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			d := &Desktop{root: root, ctx: ctx, version: "test", vault: &vault{root: filepath.Join(root, "vault")}}
			if err := d.vault.set("update-state", Object{"status": "available", "latest": "99.0.0", "assetUrl": server.URL}); err != nil {
				t.Fatal(err)
			}
			if _, err := d.UpdateDownload(); err != nil {
				t.Fatal(err)
			}
			observed := false
			deadline := time.Now().Add(10 * time.Second)
			for time.Now().Before(deadline) {
				state := d.UpdateGet()
				if getString(state, "status") == "error" {
					t.Fatal(state)
				}
				if getString(state, "status") == "downloading" && store.Number(state, "received") > 0 {
					observed = true
					if store.Number(state, "bytesPerSecond") <= 0 {
						t.Fatal("missing speed")
					}
					if known && store.Number(state, "total") != 40960 {
						t.Fatal("wrong total")
					}
					if !known && store.Number(state, "total") >= 0 {
						t.Fatal("invented total for chunked response")
					}
				}
				if getString(state, "status") == "downloaded" {
					if !observed {
						t.Fatal("download never exposed its actual progress")
					}
					info, err := os.Stat(getString(state, "path"))
					if err != nil || info.Size() != 40960 {
						t.Fatal("incomplete file", err)
					}
					return
				}
				time.Sleep(15 * time.Millisecond)
			}
			t.Fatal("download did not complete")
		})
	}
}
