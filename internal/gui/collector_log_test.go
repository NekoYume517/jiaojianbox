package gui

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestCollectorFailureLog(t *testing.T) {
	d := &Desktop{root: t.TempDir(), version: "test"}
	config := Object{"server_token": "private-token", "qq_token": "qq-secret"}
	stderr := &collectorErrorBuffer{}
	stderr.Write([]byte(strings.Repeat("x", 32<<10)))
	stderr.Write([]byte("ImportError Bearer private-token https://user:password@proxy.local qq-secret"))
	if len(stderr.tail) > 16<<10 {
		t.Fatal("stderr tail is not bounded")
	}
	cmd := exec.Command("missing-helper")
	cmd.Stderr = stderr
	failure := Object{"message": "采集进程出错（ImportError）：private-token", "error_type": "ImportError"}
	record := d.recordCollector("run", cmd, config, failure, errors.New("launch failed"))
	raw, err := os.ReadFile(d.collectorLogPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-token", "qq-secret", "user:password"} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("credential in diagnostics")
		}
	}
	var logged Object
	if json.Unmarshal(raw, &logged) != nil || getString(logged, "error_type") != "ImportError" {
		t.Fatal("missing persistent error type")
	}
	if getString(record, "stderr") == "" {
		t.Fatal("stderr discarded")
	}
	if !strings.Contains(collectorExitMessage(1, failure), "ImportError") {
		t.Fatal("exit code replaced specific failure")
	}
	if err = os.WriteFile(d.collectorLogPath(), []byte(strings.Repeat("x", 257<<10)), 0600); err != nil {
		t.Fatal(err)
	}
	d.recordCollector("run", cmd, config, failure, nil)
	if _, err = os.Stat(d.collectorLogPath() + ".previous"); err != nil {
		t.Fatal("log did not rotate", err)
	}
}
