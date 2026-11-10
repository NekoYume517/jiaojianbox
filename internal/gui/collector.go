package gui

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func (d *Desktop) component(name string) string {
	for _, path := range []string{filepath.Join(d.resources, "runtime", name, name+".exe"), filepath.Join(d.resources, "work", "helper", name, name+".exe"), filepath.Join(d.resources, "runtime", name, name)} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return filepath.Join(d.resources, "runtime", name, name+".exe")
}
func (d *Desktop) bridge(name string) string {
	for _, base := range []string{filepath.Join(d.resources, "bridge"), filepath.Join(d.resources, "desktop")} {
		path := filepath.Join(base, name)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return filepath.Join(d.resources, "bridge", name)
}
func (d *Desktop) publish(value Object) {
	d.mu.Lock()
	next := getObjectCopy(d.state)
	for k, v := range value {
		next[k] = v
	}
	next["at"] = time.Now().Format(time.RFC3339Nano)
	if source := getString(value, "source"); source != "" {
		sources := getObjectCopy(getObject(d.state["sources"]))
		sources[source] = getObjectCopy(value)
		next["sources"] = sources
	}
	d.state = next
	d.mu.Unlock()
	d.emit("collector-state", next)
}
func (d *Desktop) collectorCommand(ctx context.Context, command string, config Object) (*exec.Cmd, io.ReadCloser, error) {
	executable := d.component("collector-agent")
	args := []string{command, "--state-dir", filepath.Join(d.root, "collector")}
	if custom := getString(config, "python_path"); custom != "" {
		executable = custom
		args = append([]string{"-u", "-m", "collector.agent"}, args...)
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	hideProcess(cmd)
	cmd.Dir = d.resources
	cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8")
	payload, encodeErr := json.Marshal(config)
	if encodeErr != nil {
		return nil, nil, errors.New("采集配置无法编码，请重新选择会话后连接")
	}
	cmd.Stdin = strings.NewReader(string(payload) + "\n")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	cmd.Stderr = &collectorErrorBuffer{}
	return cmd, stdout, nil
}
func scanEvents(reader io.Reader, onEvent func(Object)) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 8<<20)
	for scanner.Scan() {
		var value Object
		if json.Unmarshal(scanner.Bytes(), &value) == nil && value != nil {
			onEvent(value)
		}
	}
	return scanner.Err()
}
func (d *Desktop) listConversations(source string, config Object) (any, error) {
	if source == "qq" {
		return d.qq.contacts(getString(config, "qq_account"))
	}
	if source != "wechat" {
		return nil, errors.New("消息来源无效")
	}
	if runtime.GOOS != "windows" {
		return nil, errors.New("微信数据库读取当前仅支持 Windows")
	}
	ctx, cancel := context.WithTimeout(d.ctx, 90*time.Second)
	defer cancel()
	cmd, stdout, err := d.collectorCommand(ctx, "list-wechat", config)
	if err != nil {
		return nil, err
	}
	d.appendCollectorRecord(Object{"at": time.Now().Format(time.RFC3339Nano), "command": "list-wechat", "state": "starting", "version": d.version, "executable": cmd.Path})
	if err = cmd.Start(); err != nil {
		d.recordCollector("list-wechat", cmd, config, nil, err)
		return nil, errors.New("内置微信采集组件无法启动，请在高级与调试中查看日志")
	}
	var result Object
	scanEvents(stdout, func(value Object) { result = value })
	err = cmd.Wait()
	d.recordCollector("list-wechat", cmd, config, result, err)
	if err != nil || result["conversations"] == nil {
		if message := getString(result, "message"); message != "" {
			return nil, errors.New(message)
		}
		return nil, errors.New("微信会话读取失败，请确认微信已登录")
	}
	return result, nil
}
func (d *Desktop) startCollector(config Object) (any, error) {
	if getString(config, "server_token") == "" || getString(config, "user_id") == "" {
		return nil, errors.New("请先登录")
	}
	prepared := getObjectCopy(config)
	qqChats, _ := config["qq_chats"].([]any)
	wechatChats, _ := config["wechat_chats"].([]any)
	if len(qqChats) > 0 {
		var err error
		prepared, err = d.qq.prepare(config)
		if err != nil {
			if len(wechatChats) == 0 {
				return nil, err
			}
			d.publish(Object{"state": "error", "source": "qq", "message": "QQ 连接失败，微信采集继续：" + err.Error()})
			prepared = getObjectCopy(config)
			prepared["qq_chats"] = []any{}
		}
	}
	d.stopCollector()
	cmd, stdout, err := d.collectorCommand(d.ctx, "run", prepared)
	if err != nil {
		return nil, err
	}
	d.appendCollectorRecord(Object{"at": time.Now().Format(time.RFC3339Nano), "command": "run", "state": "starting", "version": d.version, "executable": cmd.Path})
	if err = cmd.Start(); err != nil {
		d.recordCollector("run", cmd, prepared, nil, err)
		return nil, errors.New("内置采集组件无法启动，请在高级与调试中查看日志")
	}
	d.mu.Lock()
	d.collector = cmd
	d.mu.Unlock()
	d.publish(Object{"state": "starting", "message": "正在连接所选会话"})
	go func() {
		var failure Object
		scanErr := scanEvents(stdout, func(value Object) {
			if getString(value, "state") == "error" && getString(value, "source") == "" {
				failure = getObjectCopy(value)
				value["message"] = redactCollector(getString(value, "message"), prepared)
			}
			d.publish(value)
		})
		err := cmd.Wait()
		if scanErr != nil && err == nil {
			err = scanErr
		}
		record := d.recordCollector("run", cmd, prepared, failure, err)
		d.mu.Lock()
		active := d.collector == cmd
		if active {
			d.collector = nil
		}
		d.mu.Unlock()
		if active {
			code := 0
			if err != nil && cmd.ProcessState != nil {
				code = cmd.ProcessState.ExitCode()
			}
			if failure != nil {
				failure["message"] = redactCollector(getString(failure, "message"), prepared)
			}
			d.publish(Object{"state": "stopped", "message": collectorExitMessage(code, failure), "diagnostic": record, "log_path": d.collectorLogPath()})
		}
	}()
	return Object{"ok": true}, nil
}
func (d *Desktop) stopCollector() {
	d.mu.Lock()
	cmd := d.collector
	d.collector = nil
	d.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
	d.publish(Object{"state": "stopped", "message": "采集已停止"})
}
func (d *Desktop) diagnostics() Object {
	d.mu.Lock()
	state := getObjectCopy(d.state)
	d.mu.Unlock()
	out := d.qq.diagnostics()
	out["collector"] = state
	out["collector_log_path"] = d.collectorLogPath()
	d.collectorLogMu.Lock()
	if data, err := os.ReadFile(d.collectorLogPath()); err == nil {
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) > 10 {
			lines = lines[len(lines)-10:]
		}
		entries := []Object{}
		for _, line := range lines {
			var item Object
			if json.Unmarshal([]byte(line), &item) == nil {
				entries = append(entries, item)
			}
		}
		out["collector_logs"] = entries
	}
	d.collectorLogMu.Unlock()
	file := filepath.Join(d.root, "collector", "wechat-diagnostics.jsonl")
	if data, err := os.ReadFile(file); err == nil {
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) > 10 {
			lines = lines[len(lines)-10:]
		}
		items := []Object{}
		for _, line := range lines {
			var value Object
			if json.Unmarshal([]byte(line), &value) == nil {
				items = append(items, value)
			}
		}
		out["wechat_errors"] = items
	}
	return out
}
