package gui

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// appendStartupLog keeps a small rolling record of launch attempts. A GUI
// build has no console, so without this file an early startup failure leaves
// no trace at all — the app simply never appears.
func appendStartupLog(root, format string, args ...any) {
	if root == "" {
		return
	}
	dir := filepath.Join(root, "logs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return
	}
	path := filepath.Join(dir, "startup.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 256<<10 {
		if data, readErr := os.ReadFile(path); readErr == nil && len(data) > 128<<10 {
			_ = os.WriteFile(path, data[len(data)-(128<<10):], 0600)
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = fmt.Fprintf(file, "%s %s\n", time.Now().Format("2006-01-02 15:04:05.000"), fmt.Sprintf(format, args...))
}

func startupLogRoot() string {
	if root := os.Getenv("JJB_USER_DATA"); root != "" {
		return root
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return defaultDataRoot(config)
}

// ReportFatal makes a failed launch visible. The window subsystem build has
// no stderr, so the error is written to the startup log and shown natively.
func ReportFatal(err error) {
	root := startupLogRoot()
	appendStartupLog(root, "fatal: %v", err)
	showFatalDialog("交件箱无法启动\n\n" + err.Error() + "\n\n启动日志：" + filepath.Join(root, "logs", "startup.log"))
}
