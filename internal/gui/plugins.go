package gui

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

const (
	pluginContract     = "jjb-plugin-1"
	pluginAPIHost      = "1.0"
	pluginFileLimit    = 4 << 20
	pluginPackageLimit = 16 << 20
	pluginHistoryLimit = 200
)

var (
	pluginIDPattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	pluginKeyPattern      = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
	pluginSettingPattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	pluginAPIPattern      = regexp.MustCompile(`^\^1(?:\.\d+)?$`)
	pluginPermissionLimit = 32
)

func getArray(value any) []any {
	array, _ := value.([]any)
	return array
}

func (d *Desktop) pluginRegistry() Object {
	d.pluginsMu.Lock()
	defer d.pluginsMu.Unlock()
	if d.plugins == nil {
		value, err := d.vault.get("desktop-plugins")
		if err == nil {
			registry := getObject(value)
			if getString(registry, "version") == "1" && registry["plugins"] != nil {
				d.plugins = Object{"version": "1", "plugins": registry["plugins"]}
			}
		}
		if d.plugins == nil {
			d.plugins = Object{"version": "1", "plugins": Object{}}
		}
	}
	return cloneObject(d.plugins)
}

func (d *Desktop) savePluginRegistry(registry Object) error {
	d.pluginsMu.Lock()
	d.plugins = registry
	d.pluginsMu.Unlock()
	return d.vault.set("desktop-plugins", registry)
}

func cloneObject(value Object) Object {
	out := Object{}
	for key, item := range value {
		out[key] = item
	}
	return out
}

func pluginRecordList(registry Object) []Object {
	source := getObject(registry["plugins"])
	out := make([]Object, 0, len(source))
	for id, value := range source {
		record := getObject(value)
		record["id"] = id
		out = append(out, record)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && getString(out[j], "installed_at") < getString(out[j-1], "installed_at"); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func publicPlugin(record Object) Object {
	out := cloneObject(record)
	delete(out, "files")
	return out
}

func validPluginPath(name string) bool {
	return name != "" && path.Clean(name) == name && !strings.HasPrefix(name, "/") &&
		!strings.HasPrefix(name, "../") && !strings.ContainsAny(name, "\\:\x00") && name != ".."
}

func normalizePluginFiles(value any) (Object, error) {
	source := getObject(value)
	files := Object{}
	total := 0
	for name, item := range source {
		if !validPluginPath(name) {
			return nil, errors.New("插件文件路径无效")
		}
		text, ok := item.(string)
		if !ok {
			return nil, errors.New("插件文件必须为 UTF-8 文本")
		}
		total += len(text)
		if len(text) > pluginFileLimit || total > pluginPackageLimit {
			return nil, errors.New("插件包过大")
		}
		files[name] = text
	}
	return files, nil
}

func validatePlugin(manifest Object, files Object) error {
	if !pluginAPIPattern.MatchString(getString(manifest, "api")) {
		return errors.New("插件需要 api: \"^1\"（jjb-plugin-1 契约），且只能在桌面端运行")
	}
	if !pluginIDPattern.MatchString(getString(manifest, "id")) {
		return errors.New("插件 id 只能使用小写字母、数字和短横线")
	}
	if getString(manifest, "name") == "" || getString(manifest, "version") == "" || getString(manifest, "entry") == "" {
		return errors.New("插件需要 name、version 和 entry")
	}
	if files[getString(manifest, "entry")] == nil {
		return errors.New("插件缺少入口文件")
	}
	if err := validatePluginSettings(manifest["settings"]); err != nil {
		return err
	}
	if err := validatePluginPermissions(manifest["permissions"]); err != nil {
		return err
	}
	if events, ok := manifest["events"].([]any); ok {
		for _, event := range events {
			if _, ok := event.(string); !ok {
				return errors.New("插件触发器必须为字符串")
			}
		}
	} else if manifest["events"] != nil {
		return errors.New("插件触发器必须为数组")
	}
	return nil
}

func validatePluginSettings(value any) error {
	if value == nil {
		return nil
	}
	settings, ok := value.([]any)
	if !ok {
		return errors.New("插件设置必须为数组")
	}
	seen := map[string]bool{}
	for _, item := range settings {
		setting, ok := item.(map[string]any)
		if !ok {
			return errors.New("插件设置项必须为对象")
		}
		key := getString(setting, "key")
		if !pluginSettingPattern.MatchString(key) {
			return errors.New("插件设置 key 只能使用小写字母、数字和短横线")
		}
		if seen[key] {
			return errors.New("插件设置 key 重复：" + key)
		}
		seen[key] = true
		switch getString(setting, "type") {
		case "bool", "number", "string":
		default:
			return errors.New("插件设置 type 只支持 bool、number、string")
		}
		if getString(setting, "title") == "" {
			return errors.New("插件设置缺少 title")
		}
		if enum, ok := setting["enum"].([]any); ok {
			if getString(setting, "type") != "string" {
				return errors.New("插件设置 enum 只支持 string 类型")
			}
			for _, option := range enum {
				if _, ok := option.(string); !ok {
					return errors.New("插件设置 enum 选项必须为字符串")
				}
			}
		} else if setting["enum"] != nil {
			return errors.New("插件设置 enum 必须为数组")
		}
		if value, ok := setting["default"]; ok && !pluginSettingValueMatches(setting, value) {
			return errors.New("插件设置默认值类型不符：" + key)
		}
	}
	return nil
}

func pluginSettingValueMatches(setting Object, value any) bool {
	switch getString(setting, "type") {
	case "bool":
		_, ok := value.(bool)
		return ok
	case "number":
		_, ok := value.(float64)
		return ok
	default:
		text, ok := value.(string)
		if !ok {
			return false
		}
		if enum, ok := setting["enum"].([]any); ok {
			for _, option := range enum {
				if option == text {
					return true
				}
			}
			return false
		}
		return true
	}
}

func validatePluginPermissions(value any) error {
	if value == nil {
		return nil
	}
	permissions, ok := value.([]any)
	if !ok {
		return errors.New("插件权限必须为字符串数组")
	}
	if len(permissions) > pluginPermissionLimit {
		return errors.New("插件权限声明过多")
	}
	for _, permission := range permissions {
		if text, ok := permission.(string); !ok || text == "" {
			return errors.New("插件权限必须为非空字符串")
		}
	}
	return nil
}

// composePluginConfig follows Magpie's Compose: defaults first, then the
// user's values the schema allows; anything edited in by hand that does not
// match the schema is left out, so the default stands.
func composePluginConfig(manifest Object, userConfig Object) Object {
	composed := Object{}
	for _, item := range getArray(manifest["settings"]) {
		setting := getObject(item)
		key := getString(setting, "key")
		if key == "" {
			continue
		}
		if value, ok := setting["default"]; ok {
			composed[key] = value
		}
	}
	for key, value := range userConfig {
		for _, item := range getArray(manifest["settings"]) {
			setting := getObject(item)
			if getString(setting, "key") == key && pluginSettingValueMatches(setting, value) {
				composed[key] = cloneObjectValue(value)
				break
			}
		}
	}
	return composed
}

func cloneObjectValue(value any) any {
	if object, ok := value.(map[string]any); ok {
		return cloneObject(object)
	}
	if array, ok := value.([]any); ok {
		out := make([]any, len(array))
		copy(out, array)
		return out
	}
	return value
}

func (d *Desktop) PluginList() ([]Object, error) {
	records := pluginRecordList(d.pluginRegistry())
	for index := range records {
		records[index] = publicPlugin(records[index])
	}
	return records, nil
}

func (d *Desktop) PluginGet(id string) (Object, error) {
	if !pluginIDPattern.MatchString(id) {
		return nil, errors.New("插件 ID 无效")
	}
	plugins := getObject(d.pluginRegistry()["plugins"])
	record := getObject(plugins[id])
	if plugins[id] == nil {
		return nil, errors.New("插件不存在")
	}
	record["id"] = id
	return cloneObject(record), nil
}

func (d *Desktop) PluginImport(pkg Object) (Object, error) {
	files, err := normalizePluginFiles(pkg["files"])
	if err != nil {
		return nil, err
	}
	return d.storePlugin(getObject(pkg["manifest"]), files)
}

func (d *Desktop) PluginImportArchive(encoded string) (Object, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, errors.New("插件 ZIP 编码无效")
	}
	if len(raw) > pluginPackageLimit {
		return nil, errors.New("插件包过大")
	}
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, errors.New("插件 ZIP 无效")
	}
	files := Object{}
	total := 0
	for _, item := range reader.File {
		if item.FileInfo().IsDir() {
			continue
		}
		if !validPluginPath(item.Name) || item.UncompressedSize64 > uint64(pluginFileLimit) {
			return nil, errors.New("插件文件路径或大小无效")
		}
		file, err := item.Open()
		if err != nil {
			return nil, errors.New("插件 ZIP 无法读取")
		}
		content, err := io.ReadAll(io.LimitReader(file, pluginFileLimit+1))
		file.Close()
		if err != nil || len(content) > pluginFileLimit {
			return nil, errors.New("插件文件过大")
		}
		total += len(content)
		if total > pluginPackageLimit {
			return nil, errors.New("插件解压后过大")
		}
		if _, duplicate := files[item.Name]; duplicate {
			return nil, errors.New("插件包含重复文件")
		}
		files[item.Name] = string(content)
	}
	manifest := decodeJSONObject(getString(files, "manifest.json"))
	delete(files, "manifest.json")
	return d.storePlugin(manifest, files)
}

func decodeJSONObject(text string) Object {
	var value Object
	if json.Unmarshal([]byte(text), &value) != nil {
		return Object{}
	}
	return value
}

func (d *Desktop) storePlugin(manifest Object, files Object) (Object, error) {
	if err := validatePlugin(manifest, files); err != nil {
		return nil, err
	}
	id := getString(manifest, "id")
	registry := d.pluginRegistry()
	plugins := getObject(registry["plugins"])
	old := getObject(plugins[id])
	hasOld := plugins[id] != nil
	record := Object{
		"installed_at": store.Now(),
		"config":       Object{},
		"data":         Object{},
		"runs":         []any{},
	}
	if hasOld {
		// Upgrades replace code but deliberately retain local config, data and history.
		record = Object{
			"installed_at": getString(old, "installed_at"),
			"config":       old["config"],
			"data":         old["data"],
			"runs":         old["runs"],
		}
		record["revision"] = int(store.Number(old, "revision")) + 1
	} else {
		record["revision"] = 1
	}
	record["config"] = composePluginConfig(manifest, getObject(record["config"]))
	record["manifest"] = cloneObject(manifest)
	record["files"] = files
	record["enabled"] = false
	record["updated_at"] = store.Now()
	plugins[id] = record
	registry["plugins"] = plugins
	if err := d.savePluginRegistry(registry); err != nil {
		return nil, err
	}
	return Object{"id": id, "enabled": false, "revision": record["revision"], "created": !hasOld}, nil
}

func (d *Desktop) PluginSet(id string, patch Object) (Object, error) {
	registry := d.pluginRegistry()
	plugins := getObject(registry["plugins"])
	record := getObject(plugins[id])
	if plugins[id] == nil {
		return nil, errors.New("插件不存在")
	}
	if value, ok := patch["enabled"].(bool); ok {
		record["enabled"] = value
	}
	if value, ok := patch["config"].(map[string]any); ok {
		record["config"] = composePluginConfig(getObject(record["manifest"]), value)
	}
	record["updated_at"] = store.Now()
	plugins[id] = record
	registry["plugins"] = plugins
	if err := d.savePluginRegistry(registry); err != nil {
		return nil, err
	}
	out := publicPlugin(record)
	out["id"] = id
	return out, nil
}

func (d *Desktop) PluginDelete(id string) (Object, error) {
	registry := d.pluginRegistry()
	plugins := getObject(registry["plugins"])
	if plugins[id] == nil {
		return nil, errors.New("插件不存在")
	}
	delete(plugins, id)
	registry["plugins"] = plugins
	return Object{"ok": true}, d.savePluginRegistry(registry)
}

func (d *Desktop) PluginDataGet(id string, key string) (Object, error) {
	if !pluginKeyPattern.MatchString(key) {
		return nil, errors.New("插件数据键无效")
	}
	record, err := d.PluginGet(id)
	if err != nil {
		return nil, err
	}
	data := getObject(record["data"])
	return Object{"value": data[key]}, nil
}

func (d *Desktop) PluginDataSet(id string, key string, value any) (Object, error) {
	if !pluginKeyPattern.MatchString(key) {
		return nil, errors.New("插件数据键无效")
	}
	registry := d.pluginRegistry()
	plugins := getObject(registry["plugins"])
	record := getObject(plugins[id])
	if plugins[id] == nil {
		return nil, errors.New("插件不存在")
	}
	data := getObject(record["data"])
	data[key] = value
	record["data"] = data
	plugins[id] = record
	registry["plugins"] = plugins
	return Object{"ok": true}, d.savePluginRegistry(registry)
}

func (d *Desktop) PluginRecord(id string, entry Object) (Object, error) {
	registry := d.pluginRegistry()
	plugins := getObject(registry["plugins"])
	record := getObject(plugins[id])
	if plugins[id] == nil {
		return nil, errors.New("插件不存在")
	}
	runs, _ := record["runs"].([]any)
	entry["id"] = fmt.Sprintf("%d-%06d", time.Now().UnixNano(), len(runs)+1)
	entry["at"] = store.Now()
	runs = append(runs, entry)
	if len(runs) > pluginHistoryLimit {
		copy(runs, runs[len(runs)-pluginHistoryLimit:])
		runs = runs[:pluginHistoryLimit]
	}
	record["runs"] = runs
	plugins[id] = record
	registry["plugins"] = plugins
	return entry, d.savePluginRegistry(registry)
}

func (d *Desktop) PluginRuns(id string) ([]any, error) {
	record, err := d.PluginGet(id)
	if err != nil {
		return nil, err
	}
	runs, _ := record["runs"].([]any)
	return runs, nil
}

func (d *Desktop) pluginEnabled(id string) error {
	record, err := d.PluginGet(id)
	if err != nil {
		return err
	}
	if !store.Bool(record, "enabled") {
		return errors.New("插件已停用")
	}
	return nil
}

func (d *Desktop) pluginExec(id string, options Object) (any, error) {
	if err := d.pluginEnabled(id); err != nil {
		return nil, err
	}
	executable := getString(options, "command")
	if executable == "" {
		return nil, errors.New("请指定工具命令")
	}
	args := []string{}
	for _, value := range getArray(options["args"]) {
		if text, ok := value.(string); ok {
			args = append(args, text)
		}
	}
	timeout := 5 * time.Minute
	if value, ok := options["timeoutMs"].(float64); ok && value > 0 {
		timeout = time.Duration(value) * time.Millisecond
	} else if value, ok := options["timeoutSeconds"].(float64); ok && value > 0 {
		timeout = time.Duration(value) * time.Second
	} else if value, ok := options["timeout-seconds"].(float64); ok && value > 0 {
		timeout = time.Duration(value) * time.Second
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	if timeout > time.Hour {
		timeout = time.Hour
	}
	ctx, cancel := context.WithTimeout(d.ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	hideProcess(cmd)
	cmd.Dir = getString(options, "cwd")
	cmd.Stdin = strings.NewReader(getString(options, "stdin"))
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr pluginOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		if cmd.ProcessState == nil {
			return nil, err
		}
		code = cmd.ProcessState.ExitCode()
	}
	return Object{"stdout": stdout.String(), "stderr": stderr.String(), "exitCode": code}, nil
}

type pluginOutput struct{ bytes.Buffer }

func (b *pluginOutput) Write(p []byte) (int, error) {
	n := len(p)
	space := (2 << 20) - b.Len()
	if space > 0 {
		if len(p) > space {
			p = p[:space]
		}
		b.Buffer.Write(p)
	}
	return n, nil
}
