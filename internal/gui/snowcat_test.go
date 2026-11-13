package gui

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSnowCatDeployBacksUpAndRestoresQQFiles(t *testing.T) {
	root := t.TempDir()
	resources := filepath.Join(root, "resources")
	runtime := filepath.Join(resources, "runtime", "snowcat")
	qqHome := filepath.Join(root, "QQ")
	app := filepath.Join(qqHome, "versions", "9.9.99", "resources", "app")
	qqConfig := filepath.Join(qqHome, "config")
	for _, dir := range []string{runtime, app, qqConfig} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(runtime, "napcat.mjs"):      "snowcat-runtime",
		filepath.Join(runtime, "snowcat-boot.js"): "snowcat-boot",
		filepath.Join(runtime, "winmm-v8.dll"):    "snowcat-winmm",
		filepath.Join(runtime, "LICENSE"):         "test license",
		filepath.Join(runtime, "version.txt"):     "4.18.28",
		filepath.Join(qqHome, "QQ.exe"):           "qq",
		filepath.Join(app, "package.json"):        `{"version":"9.9.99"}`,
		filepath.Join(qqHome, "winmm.dll"):        "original-winmm",
		filepath.Join(app, "dbghelp.dll"):         "original-dbghelp",
		filepath.Join(app, "dbgeng.dll"):          "original-dbgeng",
		filepath.Join(qqConfig, "onebot11.json"):  "original-onebot",
	}
	for name, content := range files {
		if err := os.WriteFile(name, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	d := &Desktop{
		root:      root,
		resources: resources,
		vault:     &vault{root: filepath.Join(root, "vault")},
	}
	manager := newSnowCatManager(d)
	if _, err := manager.acceptConsent(runtime); err != nil {
		t.Fatal(err)
	}
	manager.saveLastConfig(Object{"snowcat_qq_home": qqHome})
	record, err := manager.deploy(runtime)
	if err != nil {
		t.Fatal(err)
	}
	if len(record.Files) != 8 {
		t.Fatalf("unexpected backup records: %#v", record.Files)
	}
	for name, want := range map[string]string{
		filepath.Join(qqHome, "winmm.dll"):       "snowcat-winmm",
		filepath.Join(qqHome, "napcat.mjs"):      "snowcat-runtime",
		filepath.Join(qqHome, "snowcat-boot.js"): "snowcat-boot",
	} {
		data, err := os.ReadFile(name)
		if err != nil || string(data) != want {
			t.Fatalf("%s was not deployed: %q %v", name, data, err)
		}
	}
	for _, name := range []string{"dbghelp.dll", "dbgeng.dll"} {
		if _, err := os.Stat(filepath.Join(app, name+".disabled")); err != nil {
			t.Fatal(name+" was not disabled", err)
		}
	}
	for name, state := range record.Files {
		if state.Backup == "" {
			continue
		}
		if _, err := os.Stat(state.Backup); err != nil {
			t.Fatalf("invalid backup path for %s: %v", name, err)
		}
	}
	if err = manager.shutdown(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		filepath.Join(qqHome, "winmm.dll"):       "original-winmm",
		filepath.Join(app, "dbghelp.dll"):        "original-dbghelp",
		filepath.Join(app, "dbgeng.dll"):         "original-dbgeng",
		filepath.Join(qqConfig, "onebot11.json"): "original-onebot",
	} {
		data, err := os.ReadFile(name)
		if err != nil || string(data) != want {
			t.Fatalf("%s was not restored: %q %v", name, data, err)
		}
	}
	for _, name := range []string{
		filepath.Join(qqHome, "napcat.mjs"),
		filepath.Join(qqHome, "snowcat-boot.js"),
		filepath.Join(qqHome, "nc-boot.log"),
		filepath.Join(qqConfig, "webui.json"),
		filepath.Join(app, "dbghelp.dll.disabled"),
		filepath.Join(app, "dbgeng.dll.disabled"),
		manager.recordPath(),
	} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatalf("%s was not removed", name)
		}
	}
}

func TestQQConnectorSelectionIsPersisted(t *testing.T) {
	root := t.TempDir()
	d := &Desktop{
		root:        root,
		vault:       &vault{root: filepath.Join(root, "vault")},
		qqConnector: "snowluma",
	}
	if _, err := d.setQQConnector(Object{"name": "snowcat"}); err != nil {
		t.Fatal(err)
	}
	if d.qqConnector != "snowcat" {
		t.Fatalf("active connector = %q", d.qqConnector)
	}
	value, err := d.vault.get("qq-connector")
	if err != nil || getString(getObject(value), "name") != "snowcat" {
		t.Fatalf("persisted connector = %#v, err = %v", value, err)
	}
}
