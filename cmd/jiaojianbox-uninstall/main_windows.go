package main

import (
	"flag"
	"github.com/NekoYume517/jiaojianbox/internal/setup"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	remove := flag.String("remove", "", "installation to remove")
	quiet := flag.Bool("quiet", false, "without confirmation")
	flag.Parse()
	exe, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	if *remove != "" {
		var last error
		for n := 0; n < 30; n++ {
			last = setup.RemoveInstalled(*remove)
			if last == nil {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		if last != nil {
			if !*quiet {
				setup.Message("卸载未完成，请先在托盘中退出交件箱，再重试。", false)
			}
			os.Exit(1)
		}
		setup.Unregister(*remove)
		if !*quiet {
			setup.Message("交件箱已卸载。本机工作空间和账号数据已保留。", false)
		}
		return
	}
	target := filepath.Dir(exe)
	if _, err = os.Stat(filepath.Join(target, setup.Marker)); err != nil {
		setup.Message("未找到安装清单，未删除任何文件。", false)
		os.Exit(1)
	}
	if !*quiet && !setup.Message("卸载交件箱？本机工作空间和账号数据会保留。", true) {
		return
	}
	dir, err := os.MkdirTemp("", "jjb-uninstall-")
	if err != nil {
		os.Exit(1)
	}
	copyPath := filepath.Join(dir, "Uninstall.exe")
	data, err := os.ReadFile(exe)
	if err != nil {
		os.Exit(1)
	}
	if os.WriteFile(copyPath, data, 0700) != nil {
		os.Exit(1)
	}
	args := []string{"--remove", target}
	if *quiet {
		args = append(args, "--quiet")
	}
	cmd := exec.Command(copyPath, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if cmd.Start() != nil {
		os.Exit(1)
	}
}
