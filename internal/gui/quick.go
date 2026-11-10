package gui

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

func (d *Desktop) quickWindow() *application.WebviewWindow {
	d.quickMu.Lock()
	defer d.quickMu.Unlock()
	return d.quick
}
func (d *Desktop) ensureQuick() *application.WebviewWindow {
	d.quickMu.Lock()
	defer d.quickMu.Unlock()
	if d.quick != nil {
		return d.quick
	}
	options := application.WebviewWindowOptions{Name: "quick", Title: "快捷收集", Width: 360, Height: 460, MinWidth: 360, MaxWidth: 360, MinHeight: 460, MaxHeight: 460, DisableResize: true, AlwaysOnTop: true, Frameless: true, Hidden: true, EnableFileDrop: true, URL: "/quick.html?desktop=1", BackgroundColour: application.NewRGB(26, 27, 38)}
	if saved, err := d.vault.get("quick-position"); err == nil && saved != nil {
		position := getObject(saved)
		options.InitialPosition = application.WindowXY
		options.X = int(store.Number(position, "x"))
		options.Y = int(store.Number(position, "y"))
		// Keep a remembered window reachable after monitors or DPI settings change.
		screen := d.app.Screen.ScreenNearestDipRect(application.Rect{X: options.X, Y: options.Y, Width: 360, Height: 460})
		if screen != nil {
			a := screen.WorkArea
			options.X = max(a.X, min(options.X, a.X+max(0, a.Width-360)))
			options.Y = max(a.Y, min(options.Y, a.Y+max(0, a.Height-460)))
		}
	}
	d.quick = d.app.Window.NewWithOptions(options)
	quick := d.quick
	quick.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) { e.Cancel(); quick.Hide() })
	quick.OnWindowEvent(events.Common.WindowDidMove, func(*application.WindowEvent) {
		x, y := quick.Position()
		d.positionMu.Lock()
		if d.positionTimer != nil {
			d.positionTimer.Stop()
		}
		d.positionTimer = time.AfterFunc(250*time.Millisecond, func() {
			d.positionMu.Lock()
			defer d.positionMu.Unlock()
			if d.ctx.Err() == nil {
				d.vault.set("quick-position", Object{"x": x, "y": y})
			}
		})
		d.positionMu.Unlock()
	})
	d.quick.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		d.mu.Lock()
		d.pinned = true
		d.mu.Unlock()
		files := append([]string(nil), e.Context().DroppedFiles()...)
		go d.acceptFiles(files, "", "material", true)
	})
	return quick
}
func (d *Desktop) showQuick() { d.showQuickMode(true) }
func (d *Desktop) showQuickMode(manual bool) {
	d.mu.Lock()
	enabled := store.Bool(d.prefs, "enabled")
	if manual {
		d.pinned = true
	}
	d.mu.Unlock()
	if !enabled {
		return
	}
	quick := d.ensureQuick()
	quick.Show()
	if manual {
		quick.Focus()
	}
	d.emit("quick-refresh", nil)
}
func (d *Desktop) startDragWatch() {
	if _, err := os.Stat(d.bridge("drag-watch.exe")); err != nil {
		return
	}
	cmd := exec.CommandContext(d.ctx, d.bridge("drag-watch.exe"), "--parent-pid", strconv.Itoa(os.Getpid()))
	hideProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	cmd.Stderr = io.Discard
	if cmd.Start() != nil {
		return
	}
	d.drag = cmd
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			switch scanner.Text() {
			case "drag":
				if !cursorWithin(d.main) {
					d.showQuickMode(false)
				}
			case "release":
				go func() {
					time.Sleep(700 * time.Millisecond)
					d.mu.Lock()
					pinned := d.pinned
					d.mu.Unlock()
					if quick := d.quickWindow(); !pinned && quick != nil && !quick.IsFocused() {
						quick.Hide()
					}
				}()
			}
		}
		cmd.Wait()
	}()
}
func (d *Desktop) quickState() (any, error) {
	snapshot, err := d.jsonRequest("GET", "/api/snapshot", nil)
	if err != nil {
		return nil, err
	}
	titles := map[string]string{}
	tasks, _ := snapshot["tasks"].([]any)
	for _, value := range tasks {
		t := getObject(value)
		titles[getString(t, "id")] = getString(t, "title")
	}
	files := []Object{}
	items, _ := snapshot["shelf"].([]any)
	for _, value := range items {
		f := getObject(value)
		files = append(files, Object{"id": f["id"], "name": f["name"], "task": titles[getString(f, "task_id")], "reason": getString(getObject(f["suggestion"]), "reason")})
		if len(files) >= 12 {
			break
		}
	}
	d.mu.Lock()
	prefs := getObjectCopy(d.prefs)
	d.mu.Unlock()
	return Object{"files": files, "preferences": prefs}, nil
}
func (d *Desktop) quickNote(value Object) (any, error) {
	text := strings.TrimSpace(getString(value, "text"))
	if text == "" || len([]rune(text)) > 2000 {
		return nil, errors.New("请输入内容，最多 2000 字")
	}
	if getString(value, "kind") == "task" {
		return d.jsonRequest("POST", "/api/tasks", Object{"title": string([]rune(text)[:min(len([]rune(text)), 200)]), "description": text})
	}
	session, err := d.session()
	if err != nil {
		return nil, err
	}
	return d.jsonRequest("POST", "/api/messages", Object{"source": "manual", "account_id": session["user_id"], "conversation_id": "quick", "conversation_name": "随手记", "external_id": store.ID(), "sender_name": session["username"], "text": text, "sent_at": time.Now().Format(time.RFC3339Nano)})
}
func (d *Desktop) acceptFiles(paths []string, target, kind string, quick bool) {
	if kind == "plugin" {
		d.acceptPluginPackages(paths)
		return
	}
	if quick {
		d.mu.Lock()
		d.pinned = true
		d.mu.Unlock()
	}
	if len(paths) > 50 {
		d.emit("native-status", "一次最多收集 50 个文件")
		paths = paths[:50]
	}
	if kind != "receipt" {
		kind = "material"
	}
	session, err := d.session()
	if err != nil {
		d.emit("native-status", err.Error())
		return
	}
	identity := getString(session, "user_id") + getString(session, "server")
	for _, path := range paths {
		current, e := d.session()
		if e != nil || getString(current, "user_id")+getString(current, "server") != identity {
			d.emit("native-status", "登录状态已变化，已停止收集剩余文件")
			return
		}
		file, err := os.Open(path)
		if err != nil {
			d.emit("native-status", "文件无法读取")
			continue
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			file.Close()
			continue
		}
		if info.Size() > 50<<20 {
			file.Close()
			d.emit("native-status", "单个文件不能超过 50 MB")
			continue
		}
		route := "/api/shelf"
		if target != "" {
			task, e := d.jsonRequest("GET", "/api/tasks/"+target, nil)
			if e != nil {
				file.Close()
				d.emit("native-status", e.Error())
				return
			}
			route = "/api/tasks/" + target + "/files?kind=" + kind + "&version=" + fmt.Sprint(int(store.Number(task, "version")))
		}
		reader, pipe := io.Pipe()
		writer := multipart.NewWriter(pipe)
		go func() {
			defer file.Close()
			part, e := writer.CreateFormFile("file", filepath.Base(path))
			if e == nil {
				_, e = io.Copy(part, file)
			}
			if e == nil {
				e = writer.Close()
			}
			pipe.CloseWithError(e)
		}()
		d.emit("native-status", "正在保存 "+filepath.Base(path))
		response, e := d.request(d.ctx, "POST", route, reader, writer.FormDataContentType())
		reader.Close()
		if e != nil {
			d.emit("native-status", e.Error())
			continue
		}
		var result Object
		e = json.NewDecoder(io.LimitReader(response.Body, 20<<20)).Decode(&result)
		response.Body.Close()
		if e != nil || response.StatusCode >= 400 {
			d.emit("native-status", "文件保存失败，请重试")
			continue
		}
		d.emit("native-drop-complete", nil)
		d.emit("quick-refresh", nil)
		if target == "" {
			d.emit("native-status", "文件已保存，正在分析归类")
			_, e = d.jsonRequest("POST", "/api/shelf/"+getString(result, "id")+"/suggest", Object{"auto_assign": true})
			if e != nil {
				d.emit("native-status", "文件已保存，可在文件收纳中手动整理或重试")
			} else {
				d.emit("native-status", "文件已整理")
			}
			d.emit("native-drop-complete", nil)
			d.emit("quick-refresh", nil)
		} else {
			d.emit("native-status", "已添加到指定待办")
		}
	}
}

func (d *Desktop) acceptPluginPackages(paths []string) {
	accepted := 0
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			d.emit("native-status", "插件包无法读取："+filepath.Base(path))
			continue
		}
		if info.Size() > pluginPackageLimit {
			d.emit("native-status", "插件包过大（上限 16 MB）："+filepath.Base(path))
			continue
		}
		var result Object
		var importErr error
		switch {
		case strings.EqualFold(filepath.Ext(path), ".zip"):
			raw, readErr := os.ReadFile(path)
			if readErr != nil {
				d.emit("native-status", "插件 ZIP 无法读取："+readErr.Error())
				continue
			}
			result, importErr = d.PluginImportArchive(base64.StdEncoding.EncodeToString(raw))
		case strings.EqualFold(filepath.Ext(path), ".json"):
			raw, readErr := os.ReadFile(path)
			if readErr != nil {
				d.emit("native-status", "插件 JSON 无法读取："+readErr.Error())
				continue
			}
			var pkg Object
			if json.Unmarshal(raw, &pkg) != nil {
				d.emit("native-status", "插件 JSON 无效："+filepath.Base(path))
				continue
			}
			result, importErr = d.PluginImport(pkg)
		default:
			d.emit("native-status", "插件只支持 JSON 或 ZIP："+filepath.Base(path))
			continue
		}
		if importErr != nil {
			d.emit("native-status", importErr.Error())
			continue
		}
		accepted++
		d.emit("native-status", fmt.Sprintf("插件已导入（修订 %d），启用后在本机运行", int(store.Number(result, "revision"))))
	}
	d.emit("native-drop-complete", nil)
	if accepted > 0 {
		d.emit("quick-refresh", nil)
	}
}

var downloadPattern = regexp.MustCompile(`^/api/(files/[0-9a-f-]{36}|tasks/[0-9a-f-]{36}/package)$`)

func (d *Desktop) download(route, name string) (any, error) {
	if !downloadPattern.MatchString(route) {
		return nil, errors.New("下载路径无效")
	}
	destination, err := d.app.Dialog.SaveFile().SetFilename(filepath.Base(name)).PromptForSingleSelection()
	if err != nil || destination == "" {
		return false, err
	}
	response, err := d.request(context.Background(), "GET", route, nil, "")
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return false, errors.New("文件下载失败，请刷新后重试")
	}
	temporary := destination + "." + store.ID() + ".partial"
	defer os.Remove(temporary)
	out, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return false, err
	}
	_, err = io.Copy(out, response.Body)
	closeErr := out.Close()
	if err != nil {
		return false, err
	}
	if closeErr != nil {
		return false, closeErr
	}
	if err = os.Rename(temporary, destination); err != nil {
		return false, err
	}
	return true, nil
}
