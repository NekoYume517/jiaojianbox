package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

const schemaVersion = 1

type Object = map[string]any
type SQL interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}
type Store struct {
	DB   *sql.DB
	Root string
	key  []byte
}

func environmentKey() string {
	return strings.TrimSpace(os.Getenv("JJB_MASTER_KEY"))
}

func Open(root string) (*Store, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Join(root, "files"), 0700); err != nil {
		return nil, err
	}
	if _, err = prepareDatabase(root); err != nil {
		return nil, fmt.Errorf("数据库自动修复失败: %w", err)
	}
	previousInfo, previousErr := os.Stat(filepath.Join(root, "jiaojianbox.sqlite3"))
	existingDatabase := previousErr == nil && previousInfo.Size() > 0
	encoded := environmentKey()
	if encoded == "" {
		file := filepath.Join(root, "master.key")
		existing, readErr := os.ReadFile(file)
		if errors.Is(readErr, os.ErrNotExist) {
			if existingDatabase {
				return nil, errors.New("现有数据库缺少 master.key，请恢复原密钥；已停止启动以保护数据")
			}
			generated := make([]byte, 32)
			if _, err = rand.Read(generated); err != nil {
				return nil, err
			}
			out, createErr := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if createErr == nil {
				_, err = out.WriteString(base64.URLEncoding.EncodeToString(generated))
				closeErr := out.Close()
				if err != nil {
					return nil, err
				}
				if closeErr != nil {
					return nil, closeErr
				}
			} else if !errors.Is(createErr, os.ErrExist) {
				return nil, createErr
			}
			existing, readErr = os.ReadFile(file)
		}
		if readErr != nil {
			return nil, readErr
		}
		encoded = strings.TrimSpace(string(existing))
	}
	key, err := base64.URLEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, errors.New("工作空间加密密钥无效")
	}
	db, err := sql.Open("sqlite", filepath.ToSlash(filepath.Join(root, "jiaojianbox.sqlite3"))+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// WAL allows readers and short writers to proceed concurrently. Keep a
	// bounded pool so long API streams do not serialize every account behind a
	// single SQLite connection while still avoiding unbounded file handles.
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	s := &Store{DB: db, Root: root, key: key}
	var currentSchemaVersion int
	if err = db.QueryRowContext(context.Background(), "PRAGMA user_version").Scan(&currentSchemaVersion); err != nil {
		db.Close()
		return nil, err
	}
	if currentSchemaVersion > schemaVersion {
		db.Close()
		return nil, fmt.Errorf("数据库版本 %d 高于当前程序支持的版本 %d", currentSchemaVersion, schemaVersion)
	}
	if existingDatabase {
		if err = s.BackupVersion(context.Background(), "before-go"); err != nil {
			log.Printf("迁移前备份失败，继续使用已通过完整性检查的工作区: %v", err)
		}
	}
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	// The schema is intentionally wire-compatible with the Python releases.
	for _, migration := range []struct{ table, column, ddl string }{
		{"llm_calls", "streamed", "ALTER TABLE llm_calls ADD COLUMN streamed INTEGER"},
		{"llm_calls", "managed", "ALTER TABLE llm_calls ADD COLUMN managed INTEGER"},
		{"shelf_meta", "version", "ALTER TABLE shelf_meta ADD COLUMN version INTEGER DEFAULT 1"},
		{"messages", "deleted_at", "ALTER TABLE messages ADD COLUMN deleted_at TEXT"},
		{"tasks", "deleted_at", "ALTER TABLE tasks ADD COLUMN deleted_at TEXT"},
		{"attachments", "deleted_at", "ALTER TABLE attachments ADD COLUMN deleted_at TEXT"},
		{"agent_sessions", "trigger_chat_id", "ALTER TABLE agent_sessions ADD COLUMN trigger_chat_id TEXT NOT NULL DEFAULT ''"},
		{"agent_messages", "session_id", "ALTER TABLE agent_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"},
	} {
		rows, err := Query(context.Background(), db, "PRAGMA table_info("+migration.table+")")
		if err != nil {
			db.Close()
			return nil, err
		}
		found := false
		for _, r := range rows {
			if Str(r, "name") == migration.column {
				found = true
			}
		}
		if !found {
			if _, err = db.Exec(migration.ddl); err != nil {
				db.Close()
				return nil, err
			}
		}
	}
	if _, err = db.Exec("CREATE INDEX IF NOT EXISTS ix_agent_messages_session ON agent_messages(user_id,session_id,created_at)"); err != nil {
		db.Close()
		return nil, err
	}
	if currentSchemaVersion < schemaVersion {
		if _, err = db.Exec(fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
			db.Close()
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) Tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func Query(ctx context.Context, db SQL, query string, args ...any) ([]Object, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []Object{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptr := make([]any, len(cols))
		for i := range ptr {
			ptr[i] = &values[i]
		}
		if err = rows.Scan(ptr...); err != nil {
			return nil, err
		}
		item := Object{}
		for i, k := range cols {
			if b, ok := values[i].([]byte); ok {
				item[k] = string(b)
			} else {
				item[k] = values[i]
			}
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func One(ctx context.Context, db SQL, query string, args ...any) (Object, error) {
	rows, err := Query(ctx, db, query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, sql.ErrNoRows
	}
	return rows[0], nil
}
func Payload(row Object) Object {
	var out Object
	if row != nil {
		json.Unmarshal([]byte(Str(row, "payload")), &out)
	}
	if out == nil {
		out = Object{}
	}
	return out
}
func JSON(value any) string { b, _ := json.Marshal(value); return string(b) }
func Str(obj Object, key string) string {
	if v, ok := obj[key].(string); ok {
		return v
	}
	return ""
}
func Number(obj Object, key string) float64 {
	switch v := obj[key].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	}
	return 0
}
func Bool(obj Object, key string) bool {
	if b, ok := obj[key].(bool); ok {
		return b
	}
	return Number(obj, key) != 0
}
func List(obj Object, key string) []any {
	if v, ok := obj[key].([]any); ok {
		return v
	}
	return []any{}
}
func Now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func ID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func Token() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func Hash(value string) string { b := sha256.Sum256([]byte(value)); return hex.EncodeToString(b[:]) }
func Password(password, salt string) (string, error) {
	decoded, err := hex.DecodeString(salt)
	if err != nil {
		return "", err
	}
	b, err := pbkdf2.Key(sha256.New, password, decoded, 310000, 32)
	return hex.EncodeToString(b), err
}
func NewPassword(password string) (salt, digest string, err error) {
	b := make([]byte, 16)
	if _, err = rand.Read(b); err != nil {
		return
	}
	salt = hex.EncodeToString(b)
	digest, err = Password(password, salt)
	return
}
func Equal(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }
func Event(ctx context.Context, db SQL, user, kind, id string) error {
	_, err := db.ExecContext(ctx, "INSERT INTO events(user_id,kind,entity_id,at) VALUES(?,?,?,?)", user, kind, id, Now())
	return err
}

// Fernet is retained so existing LLM keys, SMTP credentials and authorizations survive migration.
func (s *Store) Encrypt(value string) (string, error) {
	block, err := aes.NewCipher(s.key[16:])
	if err != nil {
		return "", err
	}
	plain := []byte(value)
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	for range pad {
		plain = append(plain, byte(pad))
	}
	out := make([]byte, 25+len(plain))
	out[0] = 0x80
	binary.BigEndian.PutUint64(out[1:9], uint64(time.Now().Unix()))
	if _, err = rand.Read(out[9:25]); err != nil {
		return "", err
	}
	cipher.NewCBCEncrypter(block, out[9:25]).CryptBlocks(out[25:], plain)
	mac := hmac.New(sha256.New, s.key[:16])
	mac.Write(out)
	out = append(out, mac.Sum(nil)...)
	return base64.URLEncoding.EncodeToString(out), nil
}
func (s *Store) Decrypt(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	raw, err := base64.URLEncoding.DecodeString(value)
	if err != nil || len(raw) < 73 || raw[0] != 0x80 {
		return "", errors.New("加密凭证格式无效")
	}
	data, signature := raw[:len(raw)-32], raw[len(raw)-32:]
	mac := hmac.New(sha256.New, s.key[:16])
	mac.Write(data)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return "", errors.New("凭证校验失败")
	}
	crypt := data[25:]
	if len(crypt) == 0 || len(crypt)%16 != 0 {
		return "", errors.New("加密凭证长度无效")
	}
	block, _ := aes.NewCipher(s.key[16:])
	plain := make([]byte, len(crypt))
	cipher.NewCBCDecrypter(block, data[9:25]).CryptBlocks(plain, crypt)
	pad := int(plain[len(plain)-1])
	if pad < 1 || pad > 16 || pad > len(plain) {
		return "", errors.New("凭证填充无效")
	}
	for _, b := range plain[len(plain)-pad:] {
		if int(b) != pad {
			return "", errors.New("凭证填充无效")
		}
	}
	return string(plain[:len(plain)-pad]), nil
}

func (s *Store) Backup(ctx context.Context, destination string) error {
	if _, err := os.Stat(destination); err == nil {
		return fmt.Errorf("备份已存在")
	}
	if _, err := s.DB.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return fmt.Errorf("SQLite WAL 检查点失败: %w", err)
	}
	_, err := s.DB.ExecContext(ctx, "VACUUM INTO ?", destination)
	if err != nil {
		return err
	}
	info, err := os.Stat(destination)
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return errors.New("SQLite 备份文件为空")
	}
	return prepareSQLite(destination)
}

// BackupVersion keeps a consistent SQLite snapshot, its encryption key and the
// workspace identity on the persistent data volume before each code upgrade.
// Attachments are copied from this exact snapshot and verified against their hashes.
func (s *Store) BackupVersion(ctx context.Context, version string) error {
	if version == "" {
		return errors.New("备份版本标识不能为空")
	}
	for _, r := range version {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_') {
			return errors.New("备份版本标识无效")
		}
	}
	directory := filepath.Join(s.Root, "backups", version)
	marker := filepath.Join(directory, "complete.json")
	if _, err := os.Stat(marker); err == nil {
		if validationErr := validateBackup(directory); validationErr == nil {
			return nil
		} else {
			preserved := filepath.Join(s.Root, "backups", ".invalid-"+version+"-"+time.Now().Format("20060102-150405.000000000"))
			if err = os.Rename(directory, preserved); err != nil {
				return fmt.Errorf("保留损坏的旧升级备份失败: %w", err)
			}
			log.Printf("已有升级备份 %s 校验未通过，已保留到 %s: %v", version, preserved, validationErr)
		}
	}
	// A directory without complete.json is an interrupted backup. It must never
	// be treated as a valid snapshot or block a later retry.
	if err := os.RemoveAll(directory); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	file := filepath.Join(directory, "jiaojianbox.sqlite3")
	if err := s.Backup(ctx, file); err != nil {
		return err
	}
	if err := os.Chmod(file, 0600); err != nil {
		return err
	}
	// Copy exactly the attachments referenced by this SQLite snapshot, including
	// their hashes, so restoring an older code version never depends on live files.
	snapshot, err := sql.Open("sqlite", filepath.ToSlash(file)+"?mode=ro")
	if err != nil {
		return err
	}
	var integrity string
	if err = snapshot.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		snapshot.Close()
		return errors.New("备份数据库完整性检查失败")
	}
	files, err := Query(ctx, snapshot, "SELECT id,size,sha256 FROM attachments")
	snapshot.Close()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(directory, "files"), 0700); err != nil {
		return err
	}
	for _, item := range files {
		if err = ctx.Err(); err != nil {
			return err
		}
		id := Str(item, "id")
		if id == "" || id != filepath.Base(id) || strings.ContainsAny(id, "/\\") {
			return errors.New("附件标识无效，已停止备份")
		}
		if err = verifyFile(filepath.Join(s.Root, "files", id), int64(Number(item, "size")), Str(item, "sha256")); err != nil {
			return fmt.Errorf("附件备份未完成: %w", err)
		}
		if err = copyFile(filepath.Join(s.Root, "files", id), filepath.Join(directory, "files", id)); err != nil {
			return err
		}
	}
	keySource := "file"
	if environmentKey() != "" {
		// A deployment key supplied through JJB_MASTER_KEY stays in the
		// orchestrator secret store. Copying it into every backup defeats that
		// boundary and makes a shared archive equivalent to plaintext credentials.
		keySource = "environment"
	} else if err := os.WriteFile(filepath.Join(directory, "master.key"), []byte(base64.URLEncoding.EncodeToString(s.key)), 0600); err != nil {
		return err
	}
	if data, err := os.ReadFile(filepath.Join(s.Root, "workspace.id")); err == nil {
		if err = os.WriteFile(filepath.Join(directory, "workspace.id"), data, 0600); err != nil {
			return err
		}
	}
	return os.WriteFile(marker, []byte(JSON(Object{"version": version, "created_at": Now(), "database": "jiaojianbox.sqlite3", "attachments": "files", "verified_files": len(files), "key_source": keySource, "mode": "immutable-code-upgrade"})), 0600)
}
