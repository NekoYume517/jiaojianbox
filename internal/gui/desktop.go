package gui

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/api"
	"github.com/NekoYume517/jiaojianbox/internal/store"
	assets "github.com/NekoYume517/jiaojianbox/web"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed tray.png
var icon []byte

type Desktop struct {
	app                                *application.App
	main, quick                        *application.WebviewWindow
	vault                              *vault
	root, resources, version, localURL string
	db                                 *store.Store
	core                               *api.Server
	http                               *http.Server
	mu                                 sync.Mutex
	appearanceMu                       sync.Mutex
	collectorLogMu                     sync.Mutex
	quickMu                            sync.Mutex
	positionMu                         sync.Mutex
	positionTimer                      *time.Timer
	ctx                                context.Context
	cancel                             context.CancelFunc
	appearance, prefs, state           Object
	plugins                            Object
	pluginsMu                          sync.Mutex
	updateMu                           sync.Mutex
	updateCancel                       context.CancelFunc
	updateProgress                     Object
	offline                            Object
	collector, drag                    *exec.Cmd
	qq                                 *snowManager
	pinned                             bool
	closed                             bool
}

func getString(o Object, key string) string { return store.Str(o, key) }
func getObject(value any) Object {
	if o, ok := value.(map[string]any); ok && o != nil {
		return o
	}
	return Object{}
}
func arg(args []any, index int) any {
	if index < len(args) {
		return args[index]
	}
	return nil
}
func stringArg(args []any, index int) string { v, _ := arg(args, index).(string); return v }
func asJSON(value any) string                { return store.JSON(value) }
func resourceRoot() string {
	if root := os.Getenv("JJB_RUNTIME_ROOT"); root != "" {
		return root
	}
	exe, _ := os.Executable()
	for _, candidate := range []string{filepath.Dir(exe), filepath.Join(filepath.Dir(exe), "resources")} {
		if _, err := os.Stat(filepath.Join(candidate, "runtime")); err == nil {
			return candidate
		}
	}
	cwd, _ := os.Getwd()
	return cwd
}

func defaultDataRoot(config string) string {
	// Packaged Electron used productName (交件箱), rather than package.json.name.
	// Prefer that existing profile so upgrades retain real users' offline data.
	for _, name := range []string{"交件箱", "jiaojianbox"} {
		candidate := filepath.Join(config, name)
		for _, entry := range []string{"vault", "offline-workspace"} {
			if _, err := os.Stat(filepath.Join(candidate, entry)); err == nil {
				return candidate
			}
		}
	}
	return filepath.Join(config, "交件箱")
}

func Run(version string) error {
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	root := os.Getenv("JJB_USER_DATA")
	if root == "" {
		root = defaultDataRoot(config)
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	activate := make(chan struct{}, 1)
	release, primary, err := claimInstance(root, activate)
	if err != nil {
		return err
	}
	if !primary {
		return nil
	}
	defer release()
	if err = guardChildren(); err != nil {
		return fmt.Errorf("无法建立采集进程生命周期保护: %w", err)
	}
	d := &Desktop{root: root, resources: resourceRoot(), version: version, vault: &vault{root: filepath.Join(root, "vault-go")}, appearance: Object{"theme": "system", "density": "compact", "textSize": "normal", "palette": "magpie"}, prefs: Object{"enabled": true, "drop": true, "note": true, "files": true}, state: Object{"state": "stopped", "message": "采集未启动"}}
	d.ctx, d.cancel = context.WithCancel(context.Background())
	go d.updateLoop()
	defer d.cancel()
	if value, e := d.vault.get("appearance"); e == nil {
		for k, v := range getObject(value) {
			d.appearance[k] = v
		}
	}
	if value, e := d.vault.get("quick-collection"); e == nil {
		for k, v := range getObject(value) {
			d.prefs[k] = v
		}
	}
	d.db, err = store.Open(filepath.Join(root, "offline-workspace"))
	if err != nil {
		return err
	}
	d.core, err = api.New(d.db, assets.FS(), version)
	if err != nil {
		d.db.Close()
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		d.core.Close()
		d.db.Close()
		return err
	}
	d.localURL = "http://" + listener.Addr().String()
	d.offline, err = d.core.LocalSession(context.Background())
	if err != nil {
		listener.Close()
		d.core.Close()
		d.db.Close()
		return err
	}
	d.offline["server"] = d.localURL
	d.http = &http.Server{Handler: d.core, ReadHeaderTimeout: 10 * time.Second}
	go d.http.Serve(listener)
	debugArgs := []string{}
	if port, e := strconv.Atoi(os.Getenv("JJB_DEBUG_PORT")); e == nil && port > 0 && port <= 65535 {
		debugArgs = append(debugArgs, "--remote-debugging-port="+strconv.Itoa(port))
	}
	d.app = application.New(application.Options{Name: "交件箱", Description: "通知、待办与文件", Icon: icon, Windows: application.WindowsOptions{WebviewUserDataPath: filepath.Join(root, "webview"), DisableQuitOnLastWindowClosed: true, AdditionalBrowserArgs: debugArgs}, Assets: application.AssetOptions{Handler: application.BundledAssetFileServer(assets.FS())}, Services: []application.Service{application.NewService(d)}, SingleInstance: &application.SingleInstanceOptions{UniqueID: "com.jiaojianbox.go." + store.Hash(root)[:12], OnSecondInstanceLaunch: func(application.SecondInstanceData) {
		if d.main != nil {
			d.main.Show()
			d.main.UnMinimise()
			d.main.Focus()
		}
	}}, OnShutdown: d.shutdown})
	silent := false
	for _, a := range os.Args[1:] {
		if a == "--silent" {
			silent = true
		}
	}
	windowTitle := "交件箱"
	if strings.HasSuffix(version, "-preview") {
		windowTitle += " · 主题预览"
	}
	chrome, background := desktopWindowChrome(getString(d.appearance, "theme"))
	d.main = d.app.Window.NewWithOptions(application.WebviewWindowOptions{Name: "main", Title: windowTitle, Width: 1280, Height: 860, MinWidth: 360, MinHeight: 520, URL: "/?desktop=1", Frameless: false, EnableFileDrop: true, Hidden: silent, Windows: chrome, BackgroundColour: background})
	if runtime.GOOS == "windows" {
		d.main.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { d.main.ExecJS(frameOnlyResizeJS) })
	}
	d.main.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) { e.Cancel(); d.main.Hide() })
	d.main.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		details := e.Context().DropTargetDetails()
		target, kind := "", "material"
		if details != nil {
			target = details.Attributes["data-native-task"]
			if v := details.Attributes["data-native-kind"]; v != "" {
				kind = v
			}
		}
		files := append([]string(nil), e.Context().DroppedFiles()...)
		go d.acceptFiles(files, target, kind, false)
	})
	go func() {
		for {
			select {
			case <-d.ctx.Done():
				return
			case <-activate:
				d.main.Show()
				d.main.UnMinimise()
				d.main.Focus()
			}
		}
	}()
	d.qq = newSnowManager(d)
	tray := d.app.SystemTray.New()
	tray.SetIcon(icon)
	tray.SetTooltip("交件箱")
	menu := application.NewMenu()
	menu.Add("打开交件箱").OnClick(func(*application.Context) {
		if d.main != nil {
			d.main.Show()
			d.main.UnMinimise()
			d.main.Focus()
		}
	})
	menu.Add("快捷收集").OnClick(func(*application.Context) { d.showQuick() })
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(*application.Context) { d.app.Quit() })
	tray.SetMenu(menu)
	tray.OnClick(func() {
		if d.main != nil {
			d.main.Show()
			d.main.UnMinimise()
			d.main.Focus()
		}
	})
	d.app.GlobalShortcut.Register("Ctrl+Shift+Space", d.showQuick)
	d.startDragWatch()
	return d.app.Run()
}
func (d *Desktop) shutdown() {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.closed = true
	d.mu.Unlock()
	d.cancel()
	d.positionMu.Lock()
	if d.positionTimer != nil {
		d.positionTimer.Stop()
	}
	if quick := d.quickWindow(); quick != nil {
		x, y := quick.Position()
		d.vault.set("quick-position", Object{"x": x, "y": y})
	}
	d.positionMu.Unlock()
	d.stopCollector()
	if d.drag != nil && d.drag.Process != nil {
		d.drag.Process.Kill()
	}
	if d.qq != nil {
		d.qq.close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	d.http.Shutdown(ctx)
	d.core.Close()
	d.db.Close()
}
func (d *Desktop) emit(name string, value any) {
	if d.app != nil {
		d.app.Event.Emit(name, value)
	}
}
func (d *Desktop) offlineStart() (any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	session, err := d.core.LocalSession(context.Background())
	if err != nil {
		return nil, err
	}
	session["server"] = d.localURL
	d.offline = session
	return session, nil
}
func (d *Desktop) session() (Object, error) {
	value, err := d.vault.get("session")
	if err != nil {
		return nil, err
	}
	s := getObject(value)
	if getString(s, "mode") == "offline" {
		d.mu.Lock()
		current := getObjectCopy(d.offline)
		d.mu.Unlock()
		return current, nil
	}
	if getString(s, "token") == "" {
		return nil, errors.New("请先登录或进入离线工作空间")
	}
	return s, nil
}
func (d *Desktop) request(ctx context.Context, method, route string, body io.Reader, contentType string) (*http.Response, error) {
	session, err := d.session()
	if err != nil {
		return nil, err
	}
	base := getString(session, "server")
	parsed, e := url.Parse(base)
	if e != nil || !isHTTP(parsed) {
		return nil, errors.New("服务端地址无效")
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+route, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+getString(session, "token"))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return (&http.Client{Timeout: 180 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
}
func (d *Desktop) jsonRequest(method, route string, body any) (Object, error) {
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(asJSON(body))
	}
	response, err := d.request(d.ctx, method, route, reader, "application/json")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var value Object
	if err = json.NewDecoder(io.LimitReader(response.Body, 20<<20)).Decode(&value); err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("%v", value["detail"])
	}
	return value, nil
}
func isHTTP(u *url.URL) bool {
	return u != nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil
}

// Invoke is the single native boundary. The existing UI keeps a small typed JS adapter.
func (d *Desktop) Invoke(method string, args []any) (any, error) {
	switch method {
	case "pluginExec":
		return d.pluginExec(stringArg(args, 0), getObject(arg(args, 1)))
	case "pluginList":
		return d.PluginList()
	case "pluginGet":
		return d.PluginGet(stringArg(args, 0))
	case "pluginImport":
		return d.PluginImport(getObject(arg(args, 0)))
	case "pluginImportArchive":
		return d.PluginImportArchive(stringArg(args, 0))
	case "pluginSet":
		return d.PluginSet(stringArg(args, 0), getObject(arg(args, 1)))
	case "pluginDelete":
		return d.PluginDelete(stringArg(args, 0))
	case "pluginDataGet":
		return d.PluginDataGet(stringArg(args, 0), stringArg(args, 1))
	case "pluginDataSet":
		return d.PluginDataSet(stringArg(args, 0), stringArg(args, 1), arg(args, 2))
	case "pluginRecord":
		return d.PluginRecord(stringArg(args, 0), getObject(arg(args, 1)))
	case "pluginRuns":
		return d.PluginRuns(stringArg(args, 0))
	case "get":
		return d.vault.get(stringArg(args, 0))
	case "set":
		return nil, d.vault.set(stringArg(args, 0), arg(args, 1))
	case "remove":
		return nil, d.vault.remove(stringArg(args, 0))
	case "offlineStart":
		return d.offlineStart()
	case "platform":
		platform := runtime.GOOS
		if platform == "windows" {
			platform = "win32"
		}
		silent := false
		for _, a := range os.Args[1:] {
			if a == "--silent" {
				silent = true
			}
		}
		return Object{"platform": platform, "version": d.version, "nativeTitlebar": true, "runtime": "wails", "silentStartup": silent}, nil
	case "tintTitlebar":
		value := getObject(arg(args, 0))
		for _, key := range []string{"r", "g", "b"} {
			n := store.Number(value, key)
			if n < 0 || n > 255 {
				return nil, errors.New("invalid title bar colour")
			}
		}
		return d.tintTitlebar(uint8(store.Number(value, "r")), uint8(store.Number(value, "g")), uint8(store.Number(value, "b")), store.Bool(value, "dark")), nil
	case "getAppearance":
		d.mu.Lock()
		out := getObjectCopy(d.appearance)
		d.mu.Unlock()
		return out, nil
	case "setAppearance":
		d.appearanceMu.Lock()
		defer d.appearanceMu.Unlock()
		value := getObject(arg(args, 0))
		d.mu.Lock()
		for _, key := range []string{"theme", "density", "textSize", "palette", "designVersion"} {
			if v, ok := value[key]; ok {
				d.appearance[key] = v
			}
		}
		out := getObjectCopy(d.appearance)
		d.mu.Unlock()
		err := d.vault.set("appearance", out)
		d.emit("appearance-updated", out)
		return out, err
	case "launcherGet":
		enabled, err := d.app.Autostart.IsEnabled()
		return Object{"openAtLogin": enabled}, err
	case "launcherSet":
		enabled := store.Bool(getObject(arg(args, 0)), "openAtLogin")
		var err error
		if enabled {
			err = d.app.Autostart.EnableWithOptions(application.AutostartOptions{Identifier: "jiaojianbox", Arguments: []string{"--silent"}})
		} else {
			err = d.app.Autostart.Disable()
		}
		return Object{"openAtLogin": enabled}, err
	case "quickGet":
		d.mu.Lock()
		out := getObjectCopy(d.prefs)
		d.mu.Unlock()
		return out, nil
	case "quickSet":
		d.mu.Lock()
		for _, key := range []string{"enabled", "drop", "note", "files"} {
			if value, ok := getObject(arg(args, 0))[key].(bool); ok {
				d.prefs[key] = value
			}
		}
		out := getObjectCopy(d.prefs)
		d.mu.Unlock()
		if quick := d.quickWindow(); !store.Bool(out, "enabled") && quick != nil {
			quick.Hide()
		}
		d.emit("quick-preferences", out)
		return out, d.vault.set("quick-collection", out)
	case "external":
		u, err := url.Parse(stringArg(args, 0))
		if err != nil || !isHTTP(u) {
			return nil, errors.New("链接无效")
		}
		return nil, d.app.Browser.OpenURL(u.String())
	case "selectRuntime":
		return d.app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).SetTitle("选择 QQ 采集组件目录").PromptForSingleSelection()
	case "discoverQQ":
		return d.qq.discover(stringArg(args, 0))
	case "connectQQ":
		return d.qq.connect(getObject(arg(args, 0)))
	case "debugQQ":
		return d.qq.debug(getObject(arg(args, 0)))
	case "sourceConsent":
		return d.qq.consentInfo(stringArg(args, 0))
	case "acceptSourceConsent":
		return d.qq.acceptConsent(stringArg(args, 0))
	case "sourceDiagnostics":
		return d.diagnostics(), nil
	case "listConversations":
		return d.listConversations(stringArg(args, 0), getObject(arg(args, 1)))
	case "startCollector":
		return d.startCollector(getObject(arg(args, 0)))
	case "stopCollector":
		d.stopCollector()
		return Object{"ok": true}, nil
	case "updateGet":
		return d.UpdateGet(), nil
	case "updateSet":
		return d.UpdateSet(getObject(arg(args, 0))), nil
	case "updateCheck":
		return d.UpdateCheck()
	case "updateDownload":
		return d.UpdateDownload()
	case "updateInstall":
		return d.UpdateInstall()
	case "updateCancel":
		return d.UpdateCancel(), nil
	case "collectorState":
		d.mu.Lock()
		out := getObjectCopy(d.state)
		d.mu.Unlock()
		return out, nil
	case "download":
		return d.download(stringArg(args, 0), stringArg(args, 1))
	case "window":
		switch stringArg(args, 0) {
		case "minimize":
			d.main.Minimise()
		case "maximize":
			d.main.ToggleMaximise()
		case "hide":
			d.main.Hide()
		case "show":
			d.main.Show()
			d.main.Focus()
		case "quit":
			d.app.Quit()
		}
		return nil, nil
	case "quickHide":
		if quick := d.quickWindow(); quick != nil {
			quick.Hide()
		}
		return nil, nil
	case "quickShow":
		d.showQuick()
		return nil, nil
	case "quickInfo":
		quick := d.quickWindow()
		if quick == nil {
			return Object{"visible": false}, nil
		}
		width, height := quick.Size()
		x, y := quick.Position()
		d.mu.Lock()
		pinned := d.pinned
		d.mu.Unlock()
		return Object{"visible": quick.IsVisible(), "width": width, "height": height, "x": x, "y": y, "pinned": pinned}, nil
	case "quickState":
		return d.quickState()
	case "quickChoose":
		paths, err := d.app.Dialog.OpenFile().SetTitle("收集文件").PromptForMultipleSelection()
		if err != nil {
			return nil, err
		}
		d.acceptFiles(paths, "", "material", true)
		return nil, nil
	case "quickNote":
		return d.quickNote(getObject(arg(args, 0)))
	}
	return nil, errors.New("不支持的桌面操作")
}
func getObjectCopy(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
