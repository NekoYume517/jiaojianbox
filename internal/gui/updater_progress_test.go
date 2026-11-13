package gui

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func TestUpdateDownloadProgressSurvivesViewReload(t *testing.T) {
	for _, known := range []bool{true, false} {
		t.Run(strconv.FormatBool(known), func(t *testing.T) {
			allowFinish := make(chan struct{})
			var finishOnce sync.Once
			finish := func() {
				finishOnce.Do(func() {
					close(allowFinish)
				})
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if known {
					w.Header().Set("Content-Length", strconv.Itoa(10*4096))
				}
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				for i := 0; i < 9; i++ {
					if _, err := w.Write(make([]byte, 4096)); err != nil {
						return
					}
					w.(http.Flusher).Flush()
				}
				select {
				case <-allowFinish:
				case <-r.Context().Done():
					return
				}
				_, _ = w.Write(make([]byte, 4096))
				w.(http.Flusher).Flush()
			}))
			defer server.Close()
			defer finish()
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
					finish()
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

func TestUpdateDownloadUsesFourRanges(t *testing.T) {
	payload := make([]byte, 100<<10)
	for index := range payload {
		payload[index] = byte(index % 251)
	}
	var mutex sync.Mutex
	starts := map[int64]bool{}
	active, peak := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Logf("request method=%q range=%q", r.Method, r.Header.Get("Range"))
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
			w.Header().Set("Accept-Ranges", "bytes")
			return
		}
		var start, end int64
		if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &start, &end); err != nil {
			t.Errorf("invalid range %q", r.Header.Get("Range"))
			http.Error(w, "bad range", http.StatusBadRequest)
			return
		}
		mutex.Lock()
		starts[start] = true
		active++
		peak = max(peak, active)
		mutex.Unlock()
		defer func() {
			mutex.Lock()
			active--
			mutex.Unlock()
		}()
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		if _, err := w.Write(payload[start : end+1]); err != nil {
			t.Errorf("write range: %v", err)
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
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		state := d.UpdateGet()
		if getString(state, "status") == "error" {
			t.Fatal(state)
		}
		if getString(state, "status") == "downloaded" {
			if !store.Bool(state, "multiThread") {
				t.Fatal("multi-thread state was not exposed")
			}
			data, err := os.ReadFile(getString(state, "path"))
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != string(payload) {
				t.Fatal("assembled download differs")
			}
			if len(starts) != 4 || peak < 2 {
				t.Fatalf("expected 4 ranges and concurrency, got %d ranges peak=%d", len(starts), peak)
			}
			if _, second := starts[0]; !second {
				t.Fatalf("missing first range: %v", starts)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("download did not complete")
}
