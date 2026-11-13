package gui

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSnowCatDeployBacksUpAndRestoresQQFiles(t *testing.T) {
	root := t.TempDir()
	resources := filepath.Join(root, "resources")
	runtime := filepath.Join(resources, "runtime", "snowcat")
	qqHome := filepath.Join(root, "QQ")
	app := filepath.Join(qqHome, "versions", supportedSnowcatQQVersion, "resources", "app")
	qqConfig := filepath.Join(qqHome, "config")
	express := filepath.Join(runtime, "node_modules", "express")
	ws := filepath.Join(runtime, "node_modules", "ws")
	for _, dir := range []string{runtime, express, ws, app, qqConfig} {
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
		filepath.Join(runtime, "package.json"):    `{"name":"jiaojianbox-snowcat-runtime"}`,
		filepath.Join(express, "package.json"):    `{"name":"express","version":"5.1.0"}`,
		filepath.Join(ws, "package.json"):         `{"name":"ws","version":"8.18.3"}`,
		filepath.Join(qqHome, "QQ.exe"):           "qq",
		filepath.Join(app, "package.json"):        `{"version":"` + supportedSnowcatQQVersion + `"}`,
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
	if len(record.Files) != 7 {
		t.Fatalf("unexpected backup records: %#v", record.Files)
	}
	for name, want := range map[string]string{
		filepath.Join(qqHome, "winmm.dll"): "snowcat-winmm",
	} {
		data, err := os.ReadFile(name)
		if err != nil || string(data) != want {
			t.Fatalf("%s was not deployed: %q %v", name, data, err)
		}
	}
	if _, err := os.Stat(filepath.Join(qqHome, "napcat.mjs")); !os.IsNotExist(err) {
		t.Fatalf("SnowCat runtime must stay in the installation directory: %v", err)
	}
	boot, err := os.ReadFile(filepath.Join(qqHome, "snowcat-boot.js"))
	if err != nil {
		t.Fatal(err)
	}
	runtimePath := strings.ReplaceAll(filepath.Join(runtime, "napcat.mjs"), `\`, `\\`)
	if !bytes.Contains(boot, []byte("JJB_SNOWCAT_BOOT_V2")) || !strings.Contains(string(boot), runtimePath) {
		t.Fatalf("boot file does not load the packaged runtime: %s", boot)
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
	if _, err = manager.deploy(runtime); err != nil {
		t.Fatal(err)
	}
	result, err := manager.repair(runtime, qqHome)
	if err != nil {
		t.Fatal(err)
	}
	if result["ok"] != true || result["restored"] != true {
		t.Fatalf("unexpected repair result: %#v", result)
	}
	if _, err := os.Stat(manager.recordPath()); !os.IsNotExist(err) {
		t.Fatalf("repair did not clear the deployment record: %v", err)
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

func TestSnowCatRejectsUnsupportedQQVersion(t *testing.T) {
	if snowcatQQVersionSupported("9.9.26-44725") {
		t.Fatal("QQ 9.9.26-44725 must not be treated as supported")
	}
	if !snowcatQQVersionSupported(supportedSnowcatQQVersion) {
		t.Fatalf("supported QQ version %s was rejected", supportedSnowcatQQVersion)
	}

	root := t.TempDir()
	resources := filepath.Join(root, "resources")
	runtime := filepath.Join(resources, "runtime", "snowcat")
	qqHome := filepath.Join(root, "QQ")
	unsupported := "9.9.26-44725"
	app := filepath.Join(qqHome, "versions", unsupported, "resources", "app")
	for _, dir := range []string{
		runtime,
		filepath.Join(runtime, "node_modules", "express"),
		filepath.Join(runtime, "node_modules", "ws"),
		app,
	} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(runtime, "napcat.mjs"):                              "snowcat-runtime",
		filepath.Join(runtime, "winmm-v8.dll"):                            "snowcat-winmm",
		filepath.Join(runtime, "LICENSE"):                                 "test license",
		filepath.Join(runtime, "version.txt"):                             "4.18.28",
		filepath.Join(runtime, "package.json"):                            `{"name":"jiaojianbox-snowcat-runtime"}`,
		filepath.Join(runtime, "node_modules", "express", "package.json"): `{"name":"express"}`,
		filepath.Join(runtime, "node_modules", "ws", "package.json"):      `{"name":"ws"}`,
		filepath.Join(qqHome, "QQ.exe"):                                   "qq",
		filepath.Join(qqHome, "winmm.dll"):                                "original-winmm",
		filepath.Join(app, "package.json"):                                `{"version":"` + unsupported + `"}`,
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
	manager.saveLastConfig(Object{"snowcat_qq_home": qqHome})
	if _, err := manager.deploy(runtime); err == nil || !strings.Contains(err.Error(), supportedSnowcatQQVersion) {
		t.Fatalf("unsupported deploy error = %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(qqHome, "winmm.dll")); err != nil || string(data) != "original-winmm" {
		t.Fatalf("unsupported QQ files were modified: %q %v", data, err)
	}
	result, err := manager.discover(runtime)
	if err != nil {
		t.Fatal(err)
	}
	out := getObject(result)
	if out["state"] != "unsupported_qq_version" || out["qq_version_supported"] != false {
		t.Fatalf("unexpected discover state: %#v", out)
	}
}

func TestSnowCatUnchangedDeploymentDoesNotRewriteLockedFiles(t *testing.T) {
	root := t.TempDir()
	resources := filepath.Join(root, "resources")
	runtime := filepath.Join(resources, "runtime", "snowcat")
	qqHome := filepath.Join(root, "QQ")
	app := filepath.Join(qqHome, "versions", supportedSnowcatQQVersion, "resources", "app")
	for _, dir := range []string{
		runtime,
		filepath.Join(runtime, "node_modules", "express"),
		filepath.Join(runtime, "node_modules", "ws"),
		app,
		filepath.Join(qqHome, "config"),
	} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(runtime, "napcat.mjs"):                              "snowcat-runtime",
		filepath.Join(runtime, "winmm-v8.dll"):                            "snowcat-winmm",
		filepath.Join(runtime, "LICENSE"):                                 "test license",
		filepath.Join(runtime, "version.txt"):                             "4.18.28",
		filepath.Join(runtime, "package.json"):                            `{"name":"jiaojianbox-snowcat-runtime"}`,
		filepath.Join(runtime, "node_modules", "express", "package.json"): `{"name":"express"}`,
		filepath.Join(runtime, "node_modules", "ws", "package.json"):      `{"name":"ws"}`,
		filepath.Join(qqHome, "QQ.exe"):                                   "qq",
		filepath.Join(qqHome, "winmm.dll"):                                "original-winmm",
		filepath.Join(app, "package.json"):                                `{"version":"` + supportedSnowcatQQVersion + `"}`,
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

	winmm := filepath.Join(qqHome, "winmm.dll")
	fixed := time.Date(2001, 2, 3, 4, 5, 6, 0, time.Local)
	if err = os.Chtimes(winmm, fixed, fixed); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.deploy(runtime); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(winmm)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(fixed) {
		t.Fatalf("unchanged SnowCat file was rewritten: got %s, want %s", info.ModTime(), fixed)
	}

	boot, err := snowcatBootScript(runtime)
	if err != nil {
		t.Fatal(err)
	}
	if manager.deploymentCurrent(record, runtime, qqHome, "10.0.0", boot) {
		t.Fatal("deployment from a different QQ version must not be treated as current")
	}
	configPath := filepath.Join(qqHome, "config", "onebot11.json")
	if err = os.WriteFile(configPath, []byte(`{"broken":true}`), 0644); err != nil {
		t.Fatal(err)
	}
	if manager.deploymentCurrent(record, runtime, qqHome, record.QQVersion, boot) {
		t.Fatal("modified SnowCat config must not be treated as current")
	}
}
