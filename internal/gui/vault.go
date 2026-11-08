package gui

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

type Object = map[string]any
type vault struct {
	root string
	mu   sync.Mutex
}

var keyPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

func (v *vault) get(key string) (any, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !keyPattern.MatchString(key) {
		return nil, errors.New("存储键无效")
	}
	data, err := os.ReadFile(filepath.Join(v.root, key+".bin"))
	if os.IsNotExist(err) {
		legacy, legacyErr := os.ReadFile(filepath.Join(filepath.Dir(v.root), "vault", key+".bin"))
		if legacyErr != nil {
			return nil, nil
		}
		plain, legacyErr := unprotectLegacy(legacy, filepath.Dir(v.root))
		if legacyErr != nil {
			return nil, nil
		}
		var value any
		if json.Unmarshal(plain, &value) != nil {
			return nil, nil
		}
		return value, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := unprotect(data)
	if err != nil {
		return nil, errors.New("本机凭证无法读取，请重新授权登录；工作空间数据仍然保留")
	}
	var value any
	err = json.Unmarshal(plain, &value)
	return value, err
}
func (v *vault) set(key string, value any) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !keyPattern.MatchString(key) {
		return errors.New("存储键无效")
	}
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data, err := protect(plain)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(v.root, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(v.root, ".vault-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	_, err = file.Write(data)
	if err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(v.root, key+".bin"))
}
func (v *vault) remove(key string) error {
	// A tombstone also prevents an old Electron credential from reappearing.
	return v.set(key, nil)
}
