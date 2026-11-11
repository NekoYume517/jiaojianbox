package gui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

const updaterRepo = "NekoYume517/jiaojianbox"

const updateThreadCount = 4

var updateTransport = http.DefaultTransport.(*http.Transport).Clone()

func init() {
	// Honor the Windows system proxy (and env vars) for update traffic.
	updateTransport.Proxy = systemProxyFor
}

var updateClient = &http.Client{Transport: updateTransport}

var updateDefaults = Object{"autoCheck": true, "intervalMinutes": 360.0, "autoDownload": false, "channel": "stable", "skipVersion": ""}

var updateAssetPattern = regexp.MustCompile(`(?i)^JiaojianBox-Setup-\d[\w.-]*-x64\.exe$`)

func compareVersions(a, b string) int {
	parts := func(value string) []int {
		out := []int{}
		for _, item := range strings.FieldsFunc(value, func(r rune) bool { return r == '.' || r == '-' }) {
			number, _ := strconv.Atoi(item)
			out = append(out, number)
		}
		return out
	}
	left, right := parts(a), parts(b)
	for index := 0; index < len(left) || index < len(right); index++ {
		l, r := 0, 0
		if index < len(left) {
			l = left[index]
		}
		if index < len(right) {
			r = right[index]
		}
		if l != r {
			return l - r
		}
	}
	return 0
}

func (d *Desktop) updatePrefs() Object {
	prefs := cloneObject(updateDefaults)
	if value, err := d.vault.get("update-preferences"); err == nil {
		for key, item := range getObject(value) {
			if _, known := prefs[key]; known {
				prefs[key] = item
			}
		}
	}
	return prefs
}

func (d *Desktop) updateState() Object {
	if value, err := d.vault.get("update-state"); err == nil {
		return getObject(value)
	}
	return Object{"status": "idle"}
}

func (d *Desktop) setUpdateState(patch Object) Object {
	d.updateMu.Lock()
	state := d.updateState()
	for key, value := range patch {
		state[key] = value
	}
	state["at"] = store.Now()
	d.updateMu.Unlock()
	if err := d.vault.set("update-state", state); err != nil {
		fmt.Fprintln(os.Stderr, "update state:", err)
	}
	d.emit("update-state", d.UpdateGet())
	return state
}

func (d *Desktop) UpdateGet() Object {
	out := d.updatePrefs()
	for key, value := range d.updateState() {
		out[key] = value
	}
	if getString(out, "status") == "downloading" {
		d.updateMu.Lock()
		for key, value := range d.updateProgress {
			out[key] = value
		}
		d.updateMu.Unlock()
	}
	out["current"] = d.version
	return out
}

func (d *Desktop) UpdateSet(patch Object) Object {
	prefs := d.updatePrefs()
	for _, key := range []string{"autoCheck", "autoDownload"} {
		if value, ok := patch[key].(bool); ok {
			prefs[key] = value
		}
	}
	if value, ok := patch["intervalMinutes"].(float64); ok {
		if value < 30 {
			value = 30
		}
		if value > 1440 {
			value = 1440
		}
		prefs["intervalMinutes"] = value
	}
	if value, ok := patch["channel"].(string); ok && (value == "stable" || value == "all") {
		prefs["channel"] = value
	}
	if value, ok := patch["skipVersion"].(string); ok {
		prefs["skipVersion"] = value
	}
	if err := d.vault.set("update-preferences", prefs); err != nil {
		fmt.Fprintln(os.Stderr, "update prefs:", err)
	}
	return d.UpdateGet()
}

func (d *Desktop) fetchLatestRelease() (Object, error) {
	ctx, cancel := context.WithTimeout(d.ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+updaterRepo+"/releases/latest", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := updateClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, errors.New("尚无发布版本")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("检查更新失败（HTTP %d）", response.StatusCode)
	}
	var release struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&release); err != nil {
		return nil, err
	}
	latest := strings.TrimPrefix(release.TagName, "v")
	out := Object{"latest": latest, "url": release.HTMLURL, "notes": release.Body}
	for _, asset := range release.Assets {
		if updateAssetPattern.MatchString(asset.Name) {
			out["asset"] = asset.Name
			out["assetUrl"] = asset.BrowserDownloadURL
			break
		}
	}
	return out, nil
}

func (d *Desktop) UpdateCheck() (Object, error) {
	release, err := d.fetchLatestRelease()
	if err != nil {
		return nil, err
	}
	latest := getString(release, "latest")
	updatable := compareVersions(latest, d.version) > 0
	state := d.setUpdateState(Object{
		"status":   map[bool]string{true: "available", false: "current"}[updatable],
		"latest":   latest,
		"url":      release["url"],
		"notes":    release["notes"],
		"asset":    release["asset"],
		"assetUrl": release["assetUrl"],
		"progress": 0, "received": 0, "total": 0, "bytesPerSecond": 0, "etaSeconds": 0,
	})
	state["updatable"] = updatable
	state["current"] = d.version
	state["skipped"] = updatable && latest == getString(d.updatePrefs(), "skipVersion")
	return state, nil
}

func (d *Desktop) downloadsDir() string {
	dir := filepath.Join(d.root, "downloads")
	os.MkdirAll(dir, 0700)
	return dir
}

func (d *Desktop) downloadedInstaller(latest string) string {
	if path := getString(d.updateState(), "path"); path != "" {
		if _, err := os.Stat(path); err == nil && strings.Contains(filepath.Base(path), latest) {
			return path
		}
	}
	return ""
}

func (d *Desktop) UpdateDownload() (Object, error) {
	state := d.updateState()
	if getString(state, "status") == "downloading" {
		return state, nil
	}
	latest := getString(state, "latest")
	assetURL := getString(state, "assetUrl")
	if latest == "" || assetURL == "" {
		checked, err := d.UpdateCheck()
		if err != nil {
			return nil, err
		}
		if !store.Bool(checked, "updatable") {
			return nil, errors.New("已是最新版本")
		}
		state = checked
		latest = getString(state, "latest")
		assetURL = getString(state, "assetUrl")
	}
	if existing := d.downloadedInstaller(latest); existing != "" {
		return d.setUpdateState(Object{"status": "downloaded", "path": existing, "progress": 1}), nil
	}
	ctx, cancel := context.WithCancel(d.ctx)
	d.updateMu.Lock()
	if d.updateCancel != nil {
		d.updateCancel()
	}
	d.updateCancel = cancel
	d.updateMu.Unlock()
	d.updateMu.Lock()
	d.updateProgress = nil
	d.updateMu.Unlock()
	d.setUpdateState(Object{"status": "downloading", "multiThread": false, "progress": 0, "received": 0, "total": 0, "bytesPerSecond": 0, "etaSeconds": 0})
	destination := filepath.Join(d.downloadsDir(), fmt.Sprintf("JiaojianBox-Setup-%s-x64.exe", latest))
	partial := destination + ".partial"
	go func() {
		defer cancel()
		total, ranged, probeErr := probeUpdateDownload(ctx, assetURL)
		var err error
		if probeErr == nil && ranged && total > 0 {
			d.setUpdateState(Object{"multiThread": true})
			err = downloadUpdateRanged(d, ctx, assetURL, partial, total)
		} else {
			err = downloadUpdateStream(ctx, assetURL, partial, d)
		}
		if err != nil {
			os.Remove(partial)
			if ctx.Err() != nil {
				d.setUpdateState(Object{"status": "cancelled"})
				return
			}
			d.setUpdateState(Object{"status": "error", "error": err.Error()})
			return
		}
		if renameErr := os.Rename(partial, destination); renameErr != nil {
			d.setUpdateState(Object{"status": "error", "error": renameErr.Error()})
			return
		}
		d.setUpdateState(Object{"status": "downloaded", "path": destination, "progress": 1})
	}()
	return d.UpdateGet(), nil
}

func (d *Desktop) setDownloadProgress(received, total int64) {
	speed := float64(0)
	eta := float64(0)
	progress := float64(0)
	if total > 0 {
		progress = float64(received) / float64(total)
	}
	d.updateMu.Lock()
	speed = store.Number(d.updateProgress, "bytesPerSecond")
	eta = store.Number(d.updateProgress, "etaSeconds")
	d.updateProgress = Object{"received": received, "total": total, "progress": progress, "bytesPerSecond": speed, "etaSeconds": eta}
	d.updateMu.Unlock()
	d.emit("update-download", d.updateProgress)
}

func probeUpdateDownload(ctx context.Context, url string) (int64, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return 0, false, err
	}
	response, err := updateClient.Do(request)
	if err != nil {
		return 0, false, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, false, fmt.Errorf("下载更新失败（HTTP %d）", response.StatusCode)
	}
	return response.ContentLength, strings.EqualFold(response.Header.Get("Accept-Ranges"), "bytes") && response.ContentLength > 64<<10, nil
}

func monitorUpdateProgress(desktop *Desktop, ctx context.Context, received *atomic.Int64, total int64) func() {
	started := time.Now()
	lastAt := started
	lastReceived := int64(0)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				value := received.Load()
				now := time.Now()
				seconds := now.Sub(lastAt).Seconds()
				speed := float64(value-lastReceived) / seconds
				eta := float64(0)
				if total > 0 && speed > 0 {
					eta = float64(total-value) / speed
				}
				desktop.updateMu.Lock()
				desktop.updateProgress = Object{"received": value, "total": total, "progress": float64(value) / float64(total), "bytesPerSecond": speed, "etaSeconds": eta}
				snapshot := cloneObject(desktop.updateProgress)
				desktop.updateMu.Unlock()
				desktop.emit("update-download", snapshot)
				lastAt, lastReceived = now, value
			}
		}
	}()
	return func() {
		close(stop)
		<-done
		if ctx.Err() == nil {
			value := received.Load()
			speed := float64(value) / time.Since(started).Seconds()
			eta := float64(0)
			if speed > 0 {
				eta = float64(total-value) / speed
			}
			desktop.updateMu.Lock()
			desktop.updateProgress = Object{"received": value, "total": total, "progress": float64(value) / float64(total), "bytesPerSecond": speed, "etaSeconds": eta}
			desktop.updateMu.Unlock()
			desktop.emit("update-download", desktop.updateProgress)
		}
	}
}

func downloadUpdateRanged(desktop *Desktop, ctx context.Context, url string, destination string, total int64) error {
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err = file.Truncate(total); err != nil {
		return err
	}
	chunk := (total + int64(updateThreadCount) - 1) / int64(updateThreadCount)
	received := &atomic.Int64{}
	monitor := monitorUpdateProgress(desktop, ctx, received, total)
	errs := make(chan error, updateThreadCount)
	workers := &sync.WaitGroup{}
	for index := 0; index < updateThreadCount; index++ {
		start := int64(index) * chunk
		end := start + chunk - 1
		if end >= total {
			end = total - 1
		}
		workers.Add(1)
		go func(start, end int64) {
			defer workers.Done()
			request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if requestErr != nil {
				errs <- requestErr
				return
			}
			request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
			response, doErr := updateClient.Do(request)
			if doErr != nil {
				errs <- doErr
				return
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusPartialContent {
				errs <- fmt.Errorf("下载更新失败（HTTP %d，分段请求不受支持）", response.StatusCode)
				return
			}
			buffer := make([]byte, 256<<10)
			offset := start
			for {
				read, readErr := response.Body.Read(buffer)
				if read > 0 {
					if _, writeErr := file.WriteAt(buffer[:read], offset); writeErr != nil {
						errs <- writeErr
						return
					}
					offset += int64(read)
					received.Add(int64(read))
				}
				if readErr != nil {
					if readErr == io.EOF || offset > end {
						if offset != end+1 {
							errs <- fmt.Errorf("下载分段不完整（%d / %d）", offset-start, end-start+1)
						}
						return
					}
					errs <- readErr
					return
				}
				if ctx.Err() != nil {
					errs <- ctx.Err()
					return
				}
			}
		}(start, end)
	}
	workers.Wait()
	monitor()
	close(errs)
	for err = range errs {
		if err != nil {
			return err
		}
	}
	if received.Load() != total {
		return fmt.Errorf("下载不完整（%d / %d）", received.Load(), total)
	}
	return file.Close()
}

func downloadUpdateStream(ctx context.Context, url string, destination string, desktop *Desktop) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := updateClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("下载更新失败（HTTP %d）", response.StatusCode)
	}
	file, err := os.Create(destination)
	if err != nil {
		return err
	}
	defer file.Close()
	total := response.ContentLength
	received := &atomic.Int64{}
	monitor := monitorUpdateProgress(desktop, ctx, received, total)
	buffer := make([]byte, 512<<10)
	var readErr error
	for {
		var read int
		read, readErr = response.Body.Read(buffer)
		if read > 0 {
			if _, writeErr := file.Write(buffer[:read]); writeErr != nil {
				monitor()
				return writeErr
			}
			received.Add(int64(read))
		}
		if readErr != nil {
			break
		}
		if ctx.Err() != nil {
			monitor()
			return ctx.Err()
		}
	}
	monitor()
	if readErr != nil && readErr != io.EOF {
		return readErr
	}
	if total > 0 && received.Load() != total {
		return fmt.Errorf("下载不完整（%d / %d）", received.Load(), total)
	}
	return file.Close()
}

func (d *Desktop) UpdateCancel() Object {
	d.updateMu.Lock()
	if d.updateCancel != nil {
		d.updateCancel()
	}
	d.updateMu.Unlock()
	return Object{"ok": true}
}

func (d *Desktop) UpdateInstall() (Object, error) {
	state := d.updateState()
	path := getString(state, "path")
	if path == "" {
		return nil, errors.New("尚未下载更新")
	}
	if _, err := os.Stat(path); err != nil {
		return nil, errors.New("安装包已被移动或删除，请重新下载")
	}
	if err := launchInstaller(path); err != nil {
		return nil, err
	}
	return Object{"ok": true}, nil
}

// updateLoop runs the background auto-check after a quiet startup window and
// then on the configured interval. Auto-download only fetches the installer;
// installing always goes through the user.
func (d *Desktop) updateLoop() {
	time.Sleep(45 * time.Second)
	for {
		if d.ctx.Err() != nil {
			return
		}
		prefs := d.updatePrefs()
		if store.Bool(prefs, "autoCheck") {
			if state, err := d.UpdateCheck(); err == nil && store.Bool(state, "updatable") && !store.Bool(state, "skipped") && store.Bool(prefs, "autoDownload") {
				d.UpdateDownload()
			}
		}
		interval := store.Number(d.updatePrefs(), "intervalMinutes")
		if interval < 30 {
			interval = 360
		}
		timer := time.NewTimer(time.Duration(interval) * time.Minute)
		select {
		case <-d.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
