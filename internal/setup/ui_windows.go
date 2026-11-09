//go:build windows

package setup

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed ui/*
var ui embed.FS

type Installer struct {
	app          *application.App
	p            *Payload
	mu           sync.Mutex
	busy         bool
	target       string
	ctx          context.Context
	removeTarget string
}
type InstallOptions struct {
	Directory string `json:"directory"`
	Desktop   bool   `json:"desktop"`
	StartMenu bool   `json:"startMenu"`
}

func (i *Installer) Info() map[string]any {
	if i.removeTarget != "" {
		var manifest Manifest
		raw, _ := os.ReadFile(filepath.Join(i.removeTarget, Marker))
		_ = json.Unmarshal(raw, &manifest)
		return map[string]any{"version": manifest.Version, "directory": i.removeTarget, "uninstall": true, "update": false}
	}

	directory := DefaultDirectory()
	installed, desktop, startMenu := installedOptions(directory)
	return map[string]any{
		"version":   i.p.Manifest.Version,
		"directory": directory,
		"update":    installed || isJiaojianboxInstallation(directory),
		"installedVersion": func() string {
			raw, err := os.ReadFile(filepath.Join(directory, Marker))
			if err != nil {
				return ""
			}
			var manifest Manifest
			if json.Unmarshal(raw, &manifest) != nil {
				return ""
			}
			return manifest.Version
		}(),
		"desktop":   desktop,
		"startMenu": startMenu,
	}
}
func (i *Installer) ChooseDirectory() (string, error) {
	directory, err := i.app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).SetTitle("选择安装位置").PromptForSingleSelection()
	if err != nil || directory == "" {
		return directory, err
	}
	return ResolveDirectory(directory)
}
func (i *Installer) ResolveDirectory(directory string) (map[string]any, error) {
	target, err := ResolveDirectory(directory)
	if err != nil {
		return nil, err
	}
	return map[string]any{"directory": target}, nil
}
func (i *Installer) Uninstall() (map[string]any, error) {
	i.mu.Lock()
	if i.busy || i.removeTarget == "" {
		i.mu.Unlock()
		return nil, errors.New("当前无法卸载")
	}
	i.busy = true
	i.mu.Unlock()
	defer func() { i.mu.Lock(); i.busy = false; i.mu.Unlock() }()
	i.app.Event.Emit("install-progress", map[string]any{"percent": 10, "message": "正在移除程序文件，本机数据会保留"})
	var err error
	for n := 0; n < 30; n++ {
		if err = RemoveInstalled(i.removeTarget); err == nil {
			break
		}
		if i.ctx.Err() != nil {
			return nil, i.ctx.Err()
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil {
		return nil, errors.New("卸载未完成，请在托盘中退出交件箱后重试。")
	}
	i.app.Event.Emit("install-progress", map[string]any{"percent": 90, "message": "正在移除快捷方式"})
	Unregister(i.removeTarget)
	return map[string]any{"directory": i.removeTarget}, nil
}
func (i *Installer) Install(options InstallOptions) (map[string]any, error) {
	if i.removeTarget != "" {
		return nil, errors.New("卸载模式不能安装")
	}

	i.mu.Lock()
	if i.busy {
		i.mu.Unlock()
		return nil, errors.New("安装正在进行")
	}
	i.busy = true
	i.mu.Unlock()
	defer func() { i.mu.Lock(); i.busy = false; i.mu.Unlock() }()
	i.app.Event.Emit("install-progress", map[string]any{"percent": 1, "message": "正在检查运行环境"})
	if err := EnsureVC(i.ctx, i.p); err != nil {
		return nil, err
	}
	directory, err := ResolveDirectory(options.Directory)
	if err != nil {
		return nil, err
	}
	target, err := Install(i.ctx, i.p, directory, options.Desktop, options.StartMenu, func(percent int, message string) {
		i.app.Event.Emit("install-progress", map[string]any{"percent": percent, "message": message})
	})
	if err != nil {
		return nil, err
	}
	warning := ""
	if err = Register(target, i.p.Manifest.Version, options.Desktop, options.StartMenu); err != nil {
		warning = err.Error()
	}
	i.mu.Lock()
	i.target = target
	i.mu.Unlock()
	return map[string]any{"directory": target, "warning": warning}, nil
}
func (i *Installer) Finish(launch bool) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.busy {
		return errors.New("请等待安装完成")
	}
	if launch && i.target != "" && i.removeTarget == "" {
		if err := exec.Command(filepath.Join(i.target, "交件箱.exe")).Start(); err != nil {
			return err
		}
	}
	i.app.Quit()
	return nil
}
func Run(p *Payload) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := EnsureWebView(ctx, p); err != nil {
		return err
	}
	return runUI(&Installer{p: p, ctx: ctx}, cancel, "安装交件箱")
}
func RunUninstall(target string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !HasWebView() {
		return errors.New("无法打开卸载界面，请使用 Uninstall.exe --quiet 静默卸载")
	}
	return runUI(&Installer{removeTarget: target, ctx: ctx}, cancel, "卸载交件箱")
}
func runUI(installer *Installer, cancel context.CancelFunc, title string) error {
	assets, _ := fs.Sub(ui, "ui")
	icon, _ := fs.ReadFile(assets, "icon.png")
	args := []string{}
	if port, e := strconv.Atoi(os.Getenv("JJB_DEBUG_PORT")); e == nil && port > 0 && port < 65536 {
		args = append(args, "--remote-debugging-port="+strconv.Itoa(port))
	}
	cache, _ := os.UserCacheDir()
	installer.app = application.New(application.Options{Name: "交件箱安装", Icon: icon, Assets: application.AssetOptions{Handler: application.BundledAssetFileServer(assets)}, Services: []application.Service{application.NewService(installer)}, Windows: application.WindowsOptions{AdditionalBrowserArgs: args, WebviewUserDataPath: filepath.Join(cache, "jiaojianbox-maintenance")}, OnShutdown: cancel})
	window := installer.app.Window.NewWithOptions(application.WebviewWindowOptions{Title: title, Width: 700, Height: 580, DisableResize: true, Frameless: true, BackgroundColour: application.NewRGB(26, 26, 30), URL: "/"})
	window.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
		installer.mu.Lock()
		defer installer.mu.Unlock()
		if installer.busy {
			e.Cancel()
		}
	})
	return installer.app.Run()
}
