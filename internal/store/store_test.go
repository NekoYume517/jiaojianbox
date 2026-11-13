package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	if _, err = s.DB.Exec("INSERT INTO users VALUES(?,?,?,?)", "new-user", "new-student", fixture["salt"], fixture["digest"]); err != nil {
		t.Fatal(err)
	}
	if err = s.BackupVersion(context.Background(), "v0.6.0"); err != nil {
		t.Fatal(err)
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
	if report, err := VerifyBackup(context.Background(), root, "v0.6.0"); err != nil || Number(report, "preserved_records") != 1 {
		t.Fatal(report, err)
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

func TestAgentSessionColumnMigratesExistingDatabase(t *testing.T) {
	t.Setenv("JJB_MASTER_KEY", base64.URLEncoding.EncodeToString(make([]byte, 32)))
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.ToSlash(filepath.Join(root, "jiaojianbox.sqlite3")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, salt TEXT, password TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE agent_messages(
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		payload TEXT NOT NULL,
		summarized INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE TABLE attachments(id TEXT PRIMARY KEY,user_id TEXT,task_id TEXT,size INTEGER,sha256 TEXT)"); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	found := false
	columns, err := Query(context.Background(), s.DB, "PRAGMA table_info(agent_messages)")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range columns {
		if Str(row, "name") == "session_id" {
			found = true
		}
	}
	if !found {
		t.Fatal("agent_messages.session_id was not migrated")
	}
	index, err := Query(context.Background(), s.DB, "SELECT name FROM sqlite_master WHERE type='index' AND name='ix_agent_messages_session'")
	if err != nil || len(index) == 0 {
		t.Fatal("agent message session index was not created")
	}
}

func TestBackupVersionRepairsInterruptedZeroByteBackup(t *testing.T) {
	t.Setenv("JJB_MASTER_KEY", base64.URLEncoding.EncodeToString(make([]byte, 32)))
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.DB.Exec("PRAGMA wal_autocheckpoint=0"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO users VALUES(?,?,?,?)", "wal-user", "wal-user", "salt", "digest"); err != nil {
		t.Fatal(err)
	}
	backupDirectory := filepath.Join(root, "backups", "v0.6.16")
	if err = os.MkdirAll(backupDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(backupDirectory, "jiaojianbox.sqlite3")
	if err = os.WriteFile(backupPath, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err = s.BackupVersion(context.Background(), "v0.6.16"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(backupPath)
	if err != nil || info.Size() == 0 {
		t.Fatal("upgrade backup is empty", err)
	}
	if err = prepareSQLite(backupPath); err != nil {
		t.Fatal("upgrade backup is malformed", err)
	}
	if _, err = os.Stat(filepath.Join(backupDirectory, "complete.json")); err != nil {
		t.Fatal(err)
	}
}

func TestOpenRestoresNewestVerifiedBackupAndAttachment(t *testing.T) {
	key := base64.URLEncoding.EncodeToString(make([]byte, 32))
	t.Setenv("JJB_MASTER_KEY", key)
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO users VALUES(?,?,?,?)", "recover-user", "recover-user", "salt", "digest"); err != nil {
		t.Fatal(err)
	}
	attachment := []byte("recover this attachment")
	attachmentPath := filepath.Join(root, "files", "recover-file")
	if err = os.WriteFile(attachmentPath, attachment, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(attachment)
	if _, err = s.DB.Exec("INSERT INTO attachments(id,user_id,task_id,name,size,sha256,kind) VALUES(?,?,?,?,?,?,?)", "recover-file", "recover-user", nil, "proof.txt", len(attachment), strings.ToLower(hexString(sum[:])), "evidence"); err != nil {
		t.Fatal(err)
	}
	if err = s.BackupVersion(context.Background(), "v0.6.16"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "jiaojianbox.sqlite3"), []byte("malformed database"), 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(root, "jiaojianbox.sqlite3-wal"))
	_ = os.Remove(filepath.Join(root, "jiaojianbox.sqlite3-shm"))
	if err = os.WriteFile(attachmentPath, []byte("damaged"), 0600); err != nil {
		t.Fatal(err)
	}

	s, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var count int
	if err = s.DB.QueryRow("SELECT COUNT(*) FROM users WHERE id='recover-user'").Scan(&count); err != nil || count != 1 {
		t.Fatal("latest verified backup was not restored", err)
	}
	restored, err := os.ReadFile(attachmentPath)
	if err != nil || string(restored) != string(attachment) {
		t.Fatal("attachment was not restored from the verified backup", err)
	}
	report, err := os.ReadFile(filepath.Join(root, "recovery", "latest.json"))
	if err != nil || !strings.Contains(string(report), `"mode":"backup"`) {
		t.Fatal("backup recovery report missing", err, string(report))
	}
}

func TestOpenQuarantinesUnrecoverableDatabaseWithoutBackup(t *testing.T) {
	t.Setenv("JJB_MASTER_KEY", base64.URLEncoding.EncodeToString(make([]byte, 32)))
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "jiaojianbox.sqlite3"), []byte("malformed database"), 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(root, "jiaojianbox.sqlite3-wal"))
	_ = os.Remove(filepath.Join(root, "jiaojianbox.sqlite3-shm"))
	if err = os.RemoveAll(filepath.Join(root, "backups")); err != nil {
		t.Fatal(err)
	}

	s, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	report, err := os.ReadFile(filepath.Join(root, "recovery", "latest.json"))
	if err != nil || !strings.Contains(string(report), `"mode":"quarantine"`) {
		t.Fatal("quarantine recovery report missing", err, string(report))
	}
	entries, err := os.ReadDir(filepath.Join(root, "recovery"))
	if err != nil {
		t.Fatal(err)
	}
	foundCorruptDatabase := false
	for _, entry := range entries {
		if entry.IsDir() {
			if _, statErr := os.Stat(filepath.Join(root, "recovery", entry.Name(), "jiaojianbox.sqlite3")); statErr == nil {
				foundCorruptDatabase = true
			}
		}
	}
	if !foundCorruptDatabase {
		t.Fatal("unrecoverable database was not preserved in quarantine")
	}
}

func TestOpenRestoresNewestBackupWhenDatabaseIsMissing(t *testing.T) {
	t.Setenv("JJB_MASTER_KEY", base64.URLEncoding.EncodeToString(make([]byte, 32)))
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO users VALUES(?,?,?,?)", "missing-user", "missing-user", "salt", "digest"); err != nil {
		t.Fatal(err)
	}
	if err = s.BackupVersion(context.Background(), "v0.6.16"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"jiaojianbox.sqlite3", "jiaojianbox.sqlite3-wal", "jiaojianbox.sqlite3-shm"} {
		_ = os.Remove(filepath.Join(root, name))
	}
	s, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var count int
	if err = s.DB.QueryRow("SELECT COUNT(*) FROM users WHERE id='missing-user'").Scan(&count); err != nil || count != 1 {
		t.Fatal("missing database was not restored from backup", err)
	}
}

func TestHealthyDatabaseStartsWhenUpgradeBackupCannotBeCompleted(t *testing.T) {
	t.Setenv("JJB_MASTER_KEY", base64.URLEncoding.EncodeToString(make([]byte, 32)))
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO attachments(id,user_id,task_id,name,size,sha256,kind) VALUES(?,?,?,?,?,?,?)", "missing-file", nil, nil, "missing.txt", 13, strings.Repeat("0", 64), "material"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(root)
	if err != nil {
		t.Fatal("healthy database was blocked by an attachment backup error", err)
	}
	defer s.Close()
	var count int
	if err = s.DB.QueryRow("SELECT COUNT(*) FROM attachments WHERE id='missing-file'").Scan(&count); err != nil || count != 1 {
		t.Fatal("live database changed after non-fatal backup failure", err)
	}
}

func hexString(value []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(value)*2)
	for i, b := range value {
		out[i*2] = digits[b>>4]
		out[i*2+1] = digits[b&15]
	}
	return string(out)
}
