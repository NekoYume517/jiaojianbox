//go:build !windows

package setup

import (
	"os"
	"path/filepath"
)

func DefaultDirectory() string {
	root, _ := os.UserConfigDir()
	return filepath.Join(root, "jiaojianbox")
}

func stopInstalledProcesses(string) error { return nil }
