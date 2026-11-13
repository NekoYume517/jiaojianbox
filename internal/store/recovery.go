package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type backupCandidate struct {
	directory string
	version   string
	createdAt time.Time
}

// prepareDatabase repairs the live SQLite workspace before the normal store
// connection is opened. A healthy WAL database is checkpointed first because
// VACUUM INTO can report a malformed image while committed pages still live in
// the WAL.
func prepareDatabase(root string) (Object, error) {
	live := filepath.Join(root, "jiaojianbox.sqlite3")
	info, err := os.Stat(live)
	if errors.Is(err, os.ErrNotExist) {
		if candidate, candidateErr := newestValidBackup(root); candidateErr == nil {
			if restoreErr := restoreBackup(root, candidate); restoreErr == nil {
				return saveRecoveryReport(root, Object{
					"status": "recovered", "mode": "backup", "reason": "数据库文件缺失",
					"backup_version": candidate.version,
					"recovered_at":   time.Now().Format(time.RFC3339Nano),
				}), nil
			}
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	reason := "数据库文件为空"
	if info.Size() > 0 {
		if err = prepareSQLite(live); err == nil {
			return nil, nil
		}
		reason = "数据库完整性检查失败"
	}

	if _, repairErr := repairWithVacuum(root); repairErr == nil {
		return saveRecoveryReport(root, Object{
			"status": "recovered", "mode": "vacuum", "reason": reason,
			"recovered_at": time.Now().Format(time.RFC3339Nano),
		}), nil
	}
	if candidate, candidateErr := newestValidBackup(root); candidateErr == nil {
		if restoreErr := restoreBackup(root, candidate); restoreErr == nil {
			return saveRecoveryReport(root, Object{
				"status": "recovered", "mode": "backup", "reason": reason,
				"backup_version": candidate.version,
				"recovered_at":   time.Now().Format(time.RFC3339Nano),
			}), nil
		}
	}

	quarantine, quarantineErr := quarantineLiveDatabase(root, "unrecoverable")
	if quarantineErr != nil {
		return nil, fmt.Errorf("%s，且无法隔离损坏数据库：%w", reason, quarantineErr)
	}
	return saveRecoveryReport(root, Object{
		"status": "created-empty", "mode": "quarantine", "reason": reason,
		"quarantine": quarantine, "recovered_at": time.Now().Format(time.RFC3339Nano),
	}), nil
}

func prepareSQLite(path string) error {
	db, err := sql.Open("sqlite", filepath.ToSlash(path)+"?_pragma=busy_timeout(30000)")
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(context.Background(), "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return err
	}
	var integrity string
	if err = db.QueryRowContext(context.Background(), "PRAGMA integrity_check").Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return fmt.Errorf("SQLite integrity_check: %s", integrity)
	}
	return nil
}

func repairWithVacuum(root string) (string, error) {
	live := filepath.Join(root, "jiaojianbox.sqlite3")
	repaired := live + ".repairing"
	if _, err := os.Stat(repaired); err == nil {
		if err = os.Remove(repaired); err != nil {
			return "", err
		}
	}
	db, err := sql.Open("sqlite", filepath.ToSlash(live)+"?_pragma=busy_timeout(30000)")
	if err != nil {
		return "", err
	}
	db.SetMaxOpenConns(1)
	_, execErr := db.ExecContext(context.Background(), "VACUUM INTO ?", repaired)
	closeErr := db.Close()
	if execErr != nil {
		os.Remove(repaired)
		return "", execErr
	}
	if closeErr != nil {
		os.Remove(repaired)
		return "", closeErr
	}
	if err = prepareSQLite(repaired); err != nil {
		os.Remove(repaired)
		return "", err
	}
	if _, err = quarantineLiveDatabase(root, "vacuum"); err != nil {
		os.Remove(repaired)
		return "", err
	}
	if err = os.Rename(repaired, live); err != nil {
		return "", err
	}
	return live, nil
}

func newestValidBackup(root string) (backupCandidate, error) {
	base := filepath.Join(root, "backups")
	entries, err := os.ReadDir(base)
	if err != nil {
		return backupCandidate{}, err
	}
	candidates := make([]backupCandidate, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		directory := filepath.Join(base, entry.Name())
		marker := filepath.Join(directory, "complete.json")
		info, markerErr := os.Stat(marker)
		if markerErr != nil || info.IsDir() {
			continue
		}
		if err = validateBackup(directory); err != nil {
			continue
		}
		candidates = append(candidates, backupCandidate{directory: directory, version: entry.Name(), createdAt: info.ModTime()})
	}
	if len(candidates) == 0 {
		return backupCandidate{}, errors.New("没有可用升级备份")
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].createdAt.After(candidates[j].createdAt) })
	return candidates[0], nil
}

func validateBackup(directory string) error {
	database := filepath.Join(directory, "jiaojianbox.sqlite3")
	info, err := os.Stat(database)
	if err != nil || info.Size() == 0 {
		return errors.New("备份数据库为空或不存在")
	}
	if err = prepareSQLite(database); err != nil {
		return err
	}
	keyData, keyErr := os.ReadFile(filepath.Join(directory, "master.key"))
	managedKey := environmentKey()
	if keyErr != nil && !(errors.Is(keyErr, os.ErrNotExist) && managedKey != "") {
		return keyErr
	}
	keyValue := strings.TrimSpace(string(keyData))
	if managedKey != "" {
		if keyValue != "" && keyValue != managedKey {
			return errors.New("备份加密密钥与环境变量不一致")
		}
		keyValue = managedKey
	}
	key, err := base64.URLEncoding.DecodeString(keyValue)
	if err != nil || len(key) != 32 {
		return errors.New("备份加密密钥无效")
	}
	db, err := sql.Open("sqlite", filepath.ToSlash(database)+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	files, err := Query(context.Background(), db, "SELECT id,size,sha256 FROM attachments")
	if err != nil {
		return err
	}
	for _, item := range files {
		id := Str(item, "id")
		if id == "" || id != filepath.Base(id) || strings.ContainsAny(id, "/\\") {
			return errors.New("备份中的附件标识无效")
		}
		if err = verifyFile(filepath.Join(directory, "files", id), int64(Number(item, "size")), Str(item, "sha256")); err != nil {
			return err
		}
	}
	return nil
}

func restoreBackup(root string, candidate backupCandidate) error {
	temporary := filepath.Join(root, "jiaojianbox.sqlite3.restoring")
	if _, err := os.Stat(temporary); err == nil {
		if err = os.Remove(temporary); err != nil {
			return err
		}
	}
	if err := copyFile(filepath.Join(candidate.directory, "jiaojianbox.sqlite3"), temporary); err != nil {
		return err
	}
	if err := prepareSQLite(temporary); err != nil {
		os.Remove(temporary)
		return err
	}
	quarantine := filepath.Join(root, "recovery", time.Now().Format("20060102-150405.000000000")+"-backup-restore")
	if err := os.MkdirAll(quarantine, 0700); err != nil {
		os.Remove(temporary)
		return err
	}
	// Restore referenced files before switching databases. A failed attachment
	// copy leaves the original database and key untouched for a later retry.
	if err := restoreBackupFiles(root, candidate.directory, quarantine); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := quarantineLiveInto(root, quarantine); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, filepath.Join(root, "jiaojianbox.sqlite3")); err != nil {
		return err
	}
	if err := restoreBackupKey(root, candidate.directory, quarantine); err != nil {
		return err
	}
	if data, readErr := os.ReadFile(filepath.Join(candidate.directory, "workspace.id")); readErr == nil {
		if _, statErr := os.Stat(filepath.Join(root, "workspace.id")); errors.Is(statErr, os.ErrNotExist) {
			_ = os.WriteFile(filepath.Join(root, "workspace.id"), data, 0600)
		}
	}
	return nil
}

func restoreBackupFiles(root, backupDirectory, quarantine string) error {
	filesRoot := filepath.Join(backupDirectory, "files")
	entries, err := os.ReadDir(filesRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	liveRoot := filepath.Join(root, "files")
	if err = os.MkdirAll(liveRoot, 0700); err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		source := filepath.Join(filesRoot, entry.Name())
		destination := filepath.Join(liveRoot, entry.Name())
		if _, statErr := os.Stat(destination); statErr == nil {
			if sameFile(source, destination) {
				continue
			}
			if err = moveToQuarantine(destination, filepath.Join(quarantine, "files")); err != nil {
				return err
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return statErr
		}
		if err = copyFile(source, destination); err != nil {
			return err
		}
	}
	return nil
}

func restoreBackupKey(root, backupDirectory, quarantine string) error {
	if environmentKey() != "" {
		// Store.Open reads a managed deployment key directly from the
		// orchestrator secret. Never materialize it on the persistent volume.
		return nil
	}
	backupKey := filepath.Join(backupDirectory, "master.key")
	expected, err := os.ReadFile(backupKey)
	if err != nil {
		return err
	}
	liveKey := filepath.Join(root, "master.key")
	current, readErr := os.ReadFile(liveKey)
	if readErr == nil {
		if strings.TrimSpace(string(current)) == strings.TrimSpace(string(expected)) {
			return nil
		}
		if err = moveToQuarantine(liveKey, quarantine); err != nil {
			return err
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	return os.WriteFile(liveKey, expected, 0600)
}

func quarantineLiveDatabase(root, reason string) (string, error) {
	directory := filepath.Join(root, "recovery", time.Now().Format("20060102-150405.000000000")+"-"+reason)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	if err := quarantineLiveInto(root, directory); err != nil {
		return "", err
	}
	return directory, nil
}

func quarantineLiveInto(root, directory string) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	for _, name := range []string{"jiaojianbox.sqlite3", "jiaojianbox.sqlite3-wal", "jiaojianbox.sqlite3-shm"} {
		source := filepath.Join(root, name)
		if _, err := os.Stat(source); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		if err := os.Rename(source, filepath.Join(directory, name)); err != nil {
			return err
		}
	}
	return nil
}

func moveToQuarantine(path, quarantine string) error {
	if err := os.MkdirAll(quarantine, 0700); err != nil {
		return err
	}
	name := filepath.Base(path)
	destination := filepath.Join(quarantine, name)
	for i := 1; ; i++ {
		if _, err := os.Stat(destination); errors.Is(err, os.ErrNotExist) {
			break
		}
		destination = filepath.Join(quarantine, fmt.Sprintf("%s.%d", name, i))
	}
	return os.Rename(path, destination)
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		os.Remove(destination)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(destination)
		return closeErr
	}
	return nil
}

func sameFile(left, right string) bool {
	hashFile := func(path string) (int64, string, error) {
		file, err := os.Open(path)
		if err != nil {
			return 0, "", err
		}
		defer file.Close()
		hash := sha256.New()
		size, err := io.Copy(hash, file)
		return size, hex.EncodeToString(hash.Sum(nil)), err
	}
	leftSize, leftHash, leftErr := hashFile(left)
	rightSize, rightHash, rightErr := hashFile(right)
	return leftErr == nil && rightErr == nil && leftSize == rightSize && leftHash == rightHash
}

func verifyFile(path string, expectedSize int64, expectedHash string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return err
	}
	if size != expectedSize || hex.EncodeToString(hash.Sum(nil)) != expectedHash {
		return fmt.Errorf("备份附件校验失败：%s", filepath.Base(path))
	}
	return nil
}

func saveRecoveryReport(root string, report Object) Object {
	if err := os.MkdirAll(filepath.Join(root, "recovery"), 0700); err != nil {
		log.Printf("write database recovery directory: %v", err)
		return report
	}
	directory := filepath.Join(root, "recovery")
	name := "recovery-" + time.Now().Format("20060102-150405.000000000") + ".json"
	if err := os.WriteFile(filepath.Join(directory, name), []byte(JSON(report)), 0600); err != nil {
		log.Printf("write database recovery report: %v", err)
		return report
	}
	if err := os.WriteFile(filepath.Join(directory, "latest.json"), []byte(JSON(report)), 0600); err != nil {
		log.Printf("write latest database recovery report: %v", err)
	}
	return report
}
