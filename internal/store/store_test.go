package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPythonCredentialsAndImmutableUpgradeBackup(t *testing.T) {
	data, err := os.ReadFile("testdata/python-compatibility.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]string
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JJB_MASTER_KEY", fixture["key"])
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := s.Decrypt(fixture["encrypted"])
	if err != nil || plain != fixture["plaintext"] {
		t.Fatal("Python Fernet credential compatibility", err)
	}
	digest, err := Password(fixture["password"], fixture["salt"])
	if err != nil || digest != fixture["digest"] {
		t.Fatal("Python password compatibility", err)
	}
	blob := filepath.Join(root, "files", "fixture-attachment")
	if err = os.WriteFile(blob, []byte("original attachment"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec("INSERT INTO users VALUES(?,?,?,?)", "old-user", "old-student", fixture["salt"], fixture["digest"])
	if err != nil {
		t.Fatal(err)
	}
	if err = s.BackupVersion(context.Background(), "v0.6.0"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var count int
	s.DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count != 1 {
		t.Fatal("existing users lost")
	}
	original, err := os.ReadFile(blob)
	if err != nil || string(original) != "original attachment" {
		t.Fatal("attachment changed")
	}
	backup, err := sql.Open("sqlite", filepath.ToSlash(filepath.Join(root, "backups", "v0.6.0", "jiaojianbox.sqlite3")))
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	if err = backup.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil || count != 1 {
		t.Fatal("backup is not a consistent database", err)
	}
	_, err = os.Stat(filepath.Join(root, "backups", "v0.6.0", "master.key"))
	if err != nil {
		t.Fatal(err)
	}
}
func TestMissingLegacyEncryptionKeyStopsWithoutChangingDatabase(t *testing.T) {
	t.Setenv("JJB_MASTER_KEY", "")
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	path := filepath.Join(root, "jiaojianbox.sqlite3")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(root, "master.key")); err != nil {
		t.Fatal(err)
	}
	if reopened, err := Open(root); err == nil {
		reopened.Close()
		t.Fatal("silently replaced lost encryption key")
	}
	after, err := os.ReadFile(path)
	if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("database changed after rejected migration")
	}
	if _, err = os.Stat(filepath.Join(root, "master.key")); !os.IsNotExist(err) {
		t.Fatal("created replacement key")
	}
}
