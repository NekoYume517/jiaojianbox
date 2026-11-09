package gui

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func newPluginDesktop(t *testing.T) *Desktop {
	t.Helper()
	return &Desktop{vault: &vault{root: t.TempDir()}}
}

func pluginBundle(id string) Object {
	return Object{
		"manifest": Object{
			"api": "^1", "id": id, "name": "Test Plugin", "version": "1.0",
			"entry": "main.js", "description": "local desktop extension", "events": []any{"task.created"},
			"settings": []any{
				map[string]any{"key": "mode", "type": "string", "title": "运行模式", "default": "agent", "enum": []any{"agent", "manual"}},
			},
			"permissions": []any{"tasks:read"},
		},
		"files": Object{"main.js": "export function activate(){}"},
	}
}

func TestDesktopPluginLocalLifecycle(t *testing.T) {
	d := newPluginDesktop(t)
	imported, err := d.PluginImport(pluginBundle("lifecycle"))
	if err != nil {
		t.Fatal(err)
	}
	if imported["enabled"] != false || imported["created"] != true {
		t.Fatal(imported)
	}
	records, err := d.PluginList()
	if err != nil || len(records) != 1 {
		t.Fatal(records, err)
	}
	if _, found := records[0]["files"]; found {
		t.Fatal("public plugin list exposed executable payload")
	}
	if _, err = d.PluginDataSet("lifecycle", "state", Object{"counter": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err = d.PluginRecord("lifecycle", Object{"event": "manual", "status": "done"}); err != nil {
		t.Fatal(err)
	}
	if _, err = d.PluginSet("lifecycle", Object{"enabled": true, "config": Object{"mode": "manual"}}); err != nil {
		t.Fatal(err)
	}
	second, err := d.PluginImport(pluginBundle("lifecycle"))
	if err != nil {
		t.Fatal(err)
	}
	if second["enabled"] != false || second["created"] != false {
		t.Fatal(second)
	}
	record, err := d.PluginGet("lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	if store.Number(record, "revision") != 2 || getString(record, "entry") == "main.js" {
		t.Fatal(record)
	}
	config := getObject(record["config"])
	if getString(config, "mode") != "manual" {
		t.Fatal(record)
	}
	// Upgrades re-compose the config: schema keys keep their values, unknown
	// keys are dropped and defaults stand in.
	if _, err = d.PluginImport(pluginBundle("lifecycle")); err != nil {
		t.Fatal(err)
	}
	record, err = d.PluginGet("lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	if getString(getObject(record["config"]), "mode") != "manual" {
		t.Fatal(record)
	}
	if _, err = d.PluginSet("lifecycle", Object{"config": Object{"mode": "invalid", "unknown": true}}); err != nil {
		t.Fatal(err)
	}
	record, err = d.PluginGet("lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	config = getObject(record["config"])
	if getString(config, "mode") != "agent" || config["unknown"] != nil {
		t.Fatal(record)
	}
	data := getObject(record["data"])
	if getObject(data["state"])["counter"] == nil {
		t.Fatal(record)
	}
	runs, ok := record["runs"].([]any)
	if !ok || len(runs) != 1 {
		t.Fatal(record)
	}
	if _, err = d.PluginDelete("lifecycle"); err != nil {
		t.Fatal(err)
	}
	if _, err = d.PluginGet("lifecycle"); err == nil {
		t.Fatal("deleted plugin remained")
	}
}

func TestDesktopPluginArchiveImport(t *testing.T) {
	d := newPluginDesktop(t)
	var body bytes.Buffer
	writer := zip.NewWriter(&body)
	files := map[string]string{
		"manifest.json": `{"api":"^1","id":"archived","name":"Archived","version":"1.0","entry":"main.js"}`,
		"main.js":       "export function activate(){}",
	}
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := d.PluginImportArchive(base64.StdEncoding.EncodeToString(body.Bytes())); err != nil {
		t.Fatal(err)
	}
	records, err := d.PluginList()
	if err != nil || len(records) != 1 || records[0]["id"] != "archived" {
		t.Fatal(records, err)
	}
}

func TestDesktopPluginValidation(t *testing.T) {
	d := newPluginDesktop(t)
	bundle := pluginBundle("bad-contract")
	getObject(bundle["manifest"])["api"] = "desktop-1"
	if _, err := d.PluginImport(bundle); err == nil {
		t.Fatal("accepted legacy cloud contract")
	}
	bundle = pluginBundle("bad-setting")
	getObject(bundle["manifest"])["settings"] = []any{map[string]any{"key": "mode", "type": "float", "title": "运行模式"}}
	if _, err := d.PluginImport(bundle); err == nil {
		t.Fatal("accepted invalid setting type")
	}
	bundle = pluginBundle("bad path")
	bundle["manifest"] = getObject(bundle["manifest"])
	getObject(bundle["manifest"])["id"] = "bad path"
	if _, err := d.PluginImport(bundle); err == nil {
		t.Fatal("accepted invalid plugin id")
	}
}
