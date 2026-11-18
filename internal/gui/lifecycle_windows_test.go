//go:build windows

package gui

import (
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestSingleInstanceNotifiesExistingOwner(t *testing.T) {
	t.Setenv("JJB_USER_DATA", t.TempDir())
	root := os.Getenv("JJB_USER_DATA")
	activation := make(chan struct{}, 1)
	release, primary, err := claimInstance(root, activation)
	if err != nil || !primary {
		t.Fatal(primary, err)
	}
	defer release()
	closeSecond, primary, err := claimInstance(root, activation)
	if err != nil || primary {
		t.Fatal(primary, err)
	}
	closeSecond()
	select {
	case <-activation:
	case <-time.After(time.Second):
		t.Fatal("existing instance was not activated")
	}
}

func TestCrashKillsOwnedDescendants(t *testing.T) {
	if file := os.Getenv("JJB_LIFECYCLE_HELPER"); file != "" {
		if err := guardChildren(); err != nil {
			panic(err)
		}
		cmd := exec.Command("cmd.exe", "/c", "ping -t 127.0.0.1 > nul")
		hideProcess(cmd)
		if err := cmd.Start(); err != nil {
			panic(err)
		}
		os.WriteFile(file, []byte(strconv.Itoa(cmd.Process.Pid)), 0600)
		for {
			time.Sleep(time.Second)
		}
	}
	file := filepath.Join(t.TempDir(), "child.pid")
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "-test.run=^TestCrashKillsOwnedDescendants$")
	cmd.Env = append(os.Environ(), "JJB_LIFECYCLE_HELPER="+file)
	hideProcess(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	var pid int
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(file)
		if err == nil {
			pid, _ = strconv.Atoi(string(raw))
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("helper did not start")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	if result, _ := windows.WaitForSingleObject(handle, 5000); result != windows.WAIT_OBJECT_0 {
		t.Fatal("managed child survived parent termination")
	}
}

func TestInstallerSurvivesParentJobClose(t *testing.T) {
	if err := guardChildren(); err != nil {
		t.Fatal(err)
	}
	processHandle, err := launchInstallerProcess(filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30")
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(processHandle)
	pid, err := windows.GetProcessId(processHandle)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		process, err := os.FindProcess(int(pid))
		if err == nil {
			process.Kill()
			process.Wait()
		}
	}()
	windows.CloseHandle(lifetimeJob)
	lifetimeJob = 0
	if result, _ := windows.WaitForSingleObject(processHandle, 500); result != uint32(windows.WAIT_TIMEOUT) {
		t.Fatal("detached installer was terminated with the parent job")
	}
}

func TestInstallerExitEventRequestsShutdown(t *testing.T) {
	stop, err := listenInstallerExit(t.TempDir(), func() {})
	if err != nil {
		t.Fatal(err)
	}
	stop()
	root := t.TempDir()
	quit := make(chan struct{}, 1)
	stop, err = listenInstallerExit(root, func() { quit <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	event, err := windows.CreateEvent(nil, 0, 0, windows.StringToUTF16Ptr(installerExitEventName(root)))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(event)
	if err := windows.SetEvent(event); err != nil {
		t.Fatal(err)
	}
	select {
	case <-quit:
	case <-time.After(2 * time.Second):
		t.Fatal("installer exit event did not request application shutdown")
	}
}
