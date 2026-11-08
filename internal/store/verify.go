package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// VerifyBackup is read-only. It checks every previous record and attachment,
// while allowing newly received records and reporting later edits separately.
func VerifyBackup(ctx context.Context, root, version string) (Object, error) {
	if version == "" || version != filepath.Base(version) || strings.ContainsAny(version, "/\\") {
		return nil, errors.New("备份版本无效")
	}
	directory := filepath.Join(root, "backups", version)
	if _, err := os.Stat(filepath.Join(directory, "complete.json")); err != nil {
		return nil, err
	}
	old, err := sql.Open("sqlite", filepath.ToSlash(filepath.Join(directory, "jiaojianbox.sqlite3"))+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer old.Close()
	current, err := sql.Open("sqlite", filepath.ToSlash(filepath.Join(root, "jiaojianbox.sqlite3"))+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer current.Close()
	var integrity string
	if err = current.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return nil, errors.New("数据库完整性检查失败")
	}
	report := Object{}
	total, modified := 0, 0
	for table, key := range map[string]string{"users": "id", "messages": "id", "tasks": "id", "attachments": "id", "llm_settings": "user_id", "llm_calls": "id", "profiles": "user_id", "user_roles": "user_id", "site_settings": "key", "invitations": "id"} {
		before, err := Query(ctx, old, "SELECT * FROM "+table)
		if err != nil {
			return nil, err
		}
		edits := 0
		for _, row := range before {
			after, err := One(ctx, current, "SELECT * FROM "+table+" WHERE "+key+"=?", row[key])
			if err != nil {
				return nil, fmt.Errorf("升级后缺少原有记录：%s", table)
			}
			values := Object{}
			for k := range row {
				values[k] = after[k]
			}
			if JSON(row) != JSON(values) {
				edits++
			}
			if table == "attachments" {
				id := Str(row, "id")
				if id != filepath.Base(id) || strings.ContainsAny(id, "/\\") {
					return nil, errors.New("附件路径无效")
				}
				file, err := os.Open(filepath.Join(root, "files", id))
				if err != nil {
					return nil, err
				}
				h := sha256.New()
				size, e := io.Copy(h, file)
				file.Close()
				if e != nil {
					return nil, e
				}
				if size != int64(Number(row, "size")) || hex.EncodeToString(h.Sum(nil)) != Str(row, "sha256") {
					return nil, errors.New("升级后附件校验失败")
				}
			}
		}
		report[table] = Object{"preserved": len(before), "modified": edits}
		total += len(before)
		modified += edits
	}
	active := strings.TrimSpace(os.Getenv("JJB_MASTER_KEY"))
	if active == "" {
		key, e := os.ReadFile(filepath.Join(root, "master.key"))
		if e != nil {
			return nil, e
		}
		active = strings.TrimSpace(string(key))
	}
	original, err := os.ReadFile(filepath.Join(directory, "master.key"))
	if err != nil {
		return nil, err
	}
	if active != strings.TrimSpace(string(original)) {
		return nil, errors.New("加密密钥发生变化")
	}
	return Object{"integrity": "ok", "preserved_records": total, "modified_records": modified, "key_preserved": true, "attachments_verified": true, "tables": report}, nil
}
