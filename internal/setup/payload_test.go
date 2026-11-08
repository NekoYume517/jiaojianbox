package setup

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T, files map[string]string) *Payload {
	t.Helper()
	var data bytes.Buffer
	z := zip.NewWriter(&data)
	m := Manifest{Version: "test", Files: map[string]string{}}
	for name, text := range files {
		f, e := z.Create(name)
		if e != nil {
			t.Fatal(e)
		}
		f.Write([]byte(text))
		hash := sha256.Sum256([]byte(text))
		m.Files[name] = hex.EncodeToString(hash[:])
	}
	f, _ := z.Create("manifest.json")
	raw, _ := json.Marshal(m)
	f.Write(raw)
	z.Close()
	hash := sha256.Sum256(data.Bytes())
	var footer bytes.Buffer
	binary.Write(&footer, binary.LittleEndian, uint64(data.Len()))
	footer.Write(hash[:])
	footer.WriteString(footerMagic)
	name := filepath.Join(t.TempDir(), "fixture.exe")
	all := append([]byte("MZ-fixture"), data.Bytes()...)
	all = append(all, footer.Bytes()...)
	if e := os.WriteFile(name, all, 0600); e != nil {
		t.Fatal(e)
	}
	p, e := OpenPayload(name)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { p.File.Close() })
	return p
}
func TestInstallUpgradeAndUninstallPreserveUnownedFiles(t *testing.T) {
	p := fixture(t, map[string]string{"app.exe": "new", "runtime/collector.exe": "runtime"})
	target := filepath.Join(t.TempDir(), "app")
	if _, e := Install(context.Background(), p, target, false, false, func(int, string) {}); e != nil {
		t.Fatal(e)
	}
	kept := filepath.Join(target, "user-data.txt")
	os.WriteFile(kept, []byte("preserve"), 0600)
	if _, e := Install(context.Background(), p, target, false, false, func(int, string) {}); e != nil {
		t.Fatal(e)
	}
	if e := RemoveInstalled(target); e != nil {
		t.Fatal(e)
	}
	if b, e := os.ReadFile(kept); e != nil || string(b) != "preserve" {
		t.Fatal("unowned data lost", e)
	}
}
func TestFailedUpgradeRestoresOldFilesAndManifest(t *testing.T) {
	target := filepath.Join(t.TempDir(), "app")
	os.MkdirAll(filepath.Join(target, "z-conflict"), 0700)
	old := []byte(`{"version":"old","files":{"a-app.exe":"old"}}`)
	os.WriteFile(filepath.Join(target, Marker), old, 0600)
	os.WriteFile(filepath.Join(target, "a-app.exe"), []byte("old"), 0600)
	p := fixture(t, map[string]string{"a-app.exe": "new", "z-conflict": "failure"})
	if _, e := Install(context.Background(), p, target, false, false, func(int, string) {}); e == nil {
		t.Fatal("accepted conflicting directory")
	}
	if b, _ := os.ReadFile(filepath.Join(target, "a-app.exe")); string(b) != "old" {
		t.Fatal("rollback lost old executable")
	}
	if b, _ := os.ReadFile(filepath.Join(target, Marker)); !bytes.Equal(b, old) {
		t.Fatal("rollback lost old manifest")
	}
}
func TestRejectTraversalCorruptionAndLinks(t *testing.T) {
	for _, name := range []string{"../escape", "C:/escape", "/escape", "x/../escape", "x\\escape"} {
		p := fixture(t, map[string]string{name: "bad"})
		if _, e := Install(context.Background(), p, filepath.Join(t.TempDir(), "app"), false, false, func(int, string) {}); e == nil {
			t.Fatal("accepted", name)
		}
	}
	p := fixture(t, map[string]string{"app.exe": "good"})
	name := p.File.Name()
	raw, _ := os.ReadFile(name)
	raw[len(raw)-41] ^= 1
	other := filepath.Join(t.TempDir(), "bad.exe")
	os.WriteFile(other, raw, 0600)
	if bad, e := OpenPayload(other); e == nil {
		bad.File.Close()
		t.Fatal("accepted corruption")
	}
	root := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(root, "app")
	os.MkdirAll(target, 0700)
	os.WriteFile(filepath.Join(target, Marker), []byte(`{}`), 0600)
	if err := os.Symlink(outside, filepath.Join(target, "runtime")); err == nil {
		p = fixture(t, map[string]string{"runtime/escape": "bad"})
		if _, e := Install(context.Background(), p, target, false, false, func(int, string) {}); e == nil {
			t.Fatal("followed link")
		}
		entries, _ := os.ReadDir(outside)
		if len(entries) > 0 {
			t.Fatal("wrote outside target")
		}
	}
	for _, name := range []string{"../escape", "./escape", "x/", "x.", "x "} {
		if safeRelative(name) {
			t.Fatal(name)
		}
	}
	if safeRelative(strings.Repeat("a", 2) + ":b") {
		t.Fatal("accepted alternate data stream")
	}
}
