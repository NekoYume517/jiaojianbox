package gui

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Keep only a bounded stderr tail. Read it after Wait has joined exec's copy goroutine.
type collectorErrorBuffer struct{ tail []byte }

func (b *collectorErrorBuffer) Write(p []byte) (int, error) {
	n := len(p)
	const limit = 16 << 10
	if len(p) >= limit {
		b.tail = append(b.tail[:0], p[len(p)-limit:]...)
		return n, nil
	}
	b.tail = append(b.tail, p...)
	if len(b.tail) > limit {
		b.tail = append([]byte(nil), b.tail[len(b.tail)-limit:]...)
	}
	return n, nil
}

var collectorURLCredentials = regexp.MustCompile(`(?i)(https?|socks5h?)://[^\s/@]+:[^\s/@]+@`)
var collectorBearer = regexp.MustCompile(`(?i)Bearer\s+[^\s"',]+`)

func redactCollector(value string, config Object) string {
	for key, v := range config {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.HasSuffix(lower, "key") {
			if secret, ok := v.(string); ok && secret != "" {
				value = strings.ReplaceAll(value, secret, "[redacted]")
			}
		}
	}
	value = collectorURLCredentials.ReplaceAllString(value, "$1://[redacted]@")
	return collectorBearer.ReplaceAllString(value, "Bearer [redacted]")
}

func (d *Desktop) collectorLogPath() string {
	return filepath.Join(d.root, "collector", "collector-process.jsonl")
}

func (d *Desktop) recordCollector(command string, cmd *exec.Cmd, config Object, failure Object, processErr error) Object {
	record := Object{"at": time.Now().Format(time.RFC3339Nano), "command": command, "version": d.version, "executable": cmd.Path, "code": 0}
	if processErr != nil {
		record["code"] = -1
		record["error"] = redactCollector(processErr.Error(), config)
		if cmd.ProcessState != nil {
			record["code"] = cmd.ProcessState.ExitCode()
		}
	}
	if failure != nil {
		record["message"] = redactCollector(getString(failure, "message"), config)
		record["error_type"] = redactCollector(getString(failure, "error_type"), config)
	}
	if stderr, ok := cmd.Stderr.(*collectorErrorBuffer); ok && len(stderr.tail) > 0 {
		record["stderr"] = redactCollector(string(stderr.tail), config)
	}
	d.appendCollectorRecord(record)
	return record
}

func (d *Desktop) appendCollectorRecord(record Object) {
	d.collectorLogMu.Lock()
	defer d.collectorLogMu.Unlock()
	path := d.collectorLogPath()
	if os.MkdirAll(filepath.Dir(path), 0700) == nil {
		if info, err := os.Stat(path); err == nil && info.Size() > 256<<10 {
			_ = os.Remove(path + ".previous")
			_ = os.Rename(path, path+".previous")
		}
		if file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600); err == nil {
			_ = json.NewEncoder(file).Encode(record)
			_ = file.Close()
		}
	}
}

func collectorExitMessage(code int, failure Object) string {
	if message := getString(failure, "message"); message != "" {
		return fmt.Sprintf("%s；采集组件已退出（%d），可在高级与调试中查看日志", message, code)
	}
	return fmt.Sprintf("采集组件已退出（%d），请在消息来源 → 高级与调试中查看日志", code)
}
