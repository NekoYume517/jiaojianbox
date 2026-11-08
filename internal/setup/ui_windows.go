//go:build windows

package setup

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed ui/*
var ui embed.FS

type Installer struct {
	app    *application.App
	p      *Payload
	mu     sync.Mutex
	busy   bool
	target string
	ctx    context.Context
}
type InstallOptions struct {
	Directory string `json:"directory"`
	Desktop   bool   `json:"desktop"`
	StartMenu bool   `json:"startMenu"`
}

func (i *Installer) Info() map[string]any {
	return map[string]any{"version": i.p.Manifest.Version, "directory": DefaultDirectory()}
}
func (i *Installer) ChooseDirectory() (string, error) {
	return i.app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).SetTitle("选择安装位置").PromptForSingleSelection()
}
func (i *Installer) Install(options InstallOptions) (map[string]any, error) {
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
	target, err := Install(i.ctx, i.p, options.Directory, options.Desktop, options.StartMenu, func(percent int, message string) {
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
	if launch && i.target != "" {
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
	assets, _ := fs.Sub(ui, "ui")
	icon, _ := fs.ReadFile(assets, "icon.png")
	installer := &Installer{p: p, ctx: ctx}
	args := []string{}
	if port, e := strconv.Atoi(os.Getenv("JJB_DEBUG_PORT")); e == nil && port > 0 && port < 65536 {
		args = append(args, "--remote-debugging-port="+strconv.Itoa(port))
	}
	installer.app = application.New(application.Options{Name: "交件箱安装", Icon: icon, Assets: application.AssetOptions{Handler: application.BundledAssetFileServer(assets)}, Services: []application.Service{application.NewService(installer)}, Windows: application.WindowsOptions{AdditionalBrowserArgs: args}, OnShutdown: cancel})
	window := installer.app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "安装交件箱", Width: 700, Height: 520, DisableResize: true, Frameless: true, BackgroundColour: application.NewRGB(26, 27, 38), URL: "/"})
	window.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
		installer.mu.Lock()
		defer installer.mu.Unlock()
		if installer.busy {
			e.Cancel()
		}
	})
	return installer.app.Run()
}
