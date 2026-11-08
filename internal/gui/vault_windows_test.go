//go:build windows

package gui

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVaultRemovalCannotResurrectLegacyCredentials(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "vault"), 0700)
	data, err := protect([]byte(`{"token":"fixture"}`))
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "vault", "session.bin"), data, 0600)
	v := &vault{root: filepath.Join(root, "vault-go")}
	value, err := v.get("session")
	if err != nil || getString(getObject(value), "token") != "fixture" {
		t.Fatal(value, err)
	}
	if err = v.remove("session"); err != nil {
		t.Fatal(err)
	}
	value, err = v.get("session")
	if err != nil || value != nil {
		t.Fatal("legacy login resurrected", value, err)
	}
}
func TestActualElectronV10Credential(t *testing.T) {
	root := os.Getenv("JJB_TEST_LEGACY_PROFILE")
	if root == "" {
		t.Skip("local Electron migration acceptance fixture")
	}
	v := &vault{root: filepath.Join(root, "vault-go")}
	value, err := v.get("appearance")
	if err != nil || getString(getObject(value), "palette") != "nord" {
		t.Fatal("Electron credential did not migrate", value, err)
	}
}
func TestDataRootUsesPackagedElectronProductName(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "交件箱")
	os.MkdirAll(filepath.Join(legacy, "vault"), 0700)
	if got := defaultDataRoot(root); got != legacy {
		t.Fatal("would abandon legacy profile", got)
	}
}
