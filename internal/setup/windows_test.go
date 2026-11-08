//go:build windows

package setup

import (
	"golang.org/x/sys/windows/registry"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestUpgradeKeepsAutostartOptInAndUninstallLeavesOtherApps(t *testing.T) {
	path := `Software\JiaojianBox-Tests\` + strconv.FormatInt(time.Now().UnixNano(), 10)
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { key.Close(); registry.DeleteKey(registry.CURRENT_USER, path) }()
	target := filepath.Join(t.TempDir(), "new-app")
	key.SetStringValue("交件箱", `"C:\Old App\交件箱.exe" --hidden`)
	key.SetStringValue("OtherApp", `"C:\Other\Other.exe"`)
	if err = migrateAutostart(key, target, false); err != nil {
		t.Fatal(err)
	}
	value, _, err := key.GetStringValue("交件箱")
	if err != nil || value != `"`+filepath.Join(target, "交件箱.exe")+`" --silent` {
		t.Fatal(value, err)
	}
	if err = migrateAutostart(key, target, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err = key.GetStringValue("交件箱"); err != registry.ErrNotExist {
		t.Fatal("left autostart after uninstall", err)
	}
	if value, _, err = key.GetStringValue("OtherApp"); err != nil || value != `"C:\Other\Other.exe"` {
		t.Fatal("changed another application", value, err)
	}
	if err = migrateAutostart(key, target, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err = key.GetStringValue("jiaojianbox"); err != registry.ErrNotExist {
		t.Fatal("enabled autostart without opt-in")
	}
}
