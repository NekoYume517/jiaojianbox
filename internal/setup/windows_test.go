//go:build windows

package setup

import (
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestUpgradeKeepsAutostartOptInAndUninstallLeavesOtherApps(t *testing.T) {
	path := `Software\JiaojianBox-Tests\` + strconv.FormatInt(time.Now().UnixNano(), 10)
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { key.Close(); registry.DeleteKey(registry.CURRENT_USER, path) }()
	target := filepath.Join(t.TempDir(), "new-app")
	key.SetStringValue("交件箱", `"C:\Old App\交件箱.exe" --hidden`)
	key.SetStringValue("OtherApp", `"C:\Other\Other.exe"`)
	if err = migrateAutostart(key, target, false); err != nil {
		t.Fatal(err)
	}
	value, _, err := key.GetStringValue("交件箱")
	if err != nil || value != `"`+filepath.Join(target, "交件箱.exe")+`" --silent` {
		t.Fatal(value, err)
	}
	if err = migrateAutostart(key, target, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err = key.GetStringValue("交件箱"); err != registry.ErrNotExist {
		t.Fatal("left autostart after uninstall", err)
	}
	if value, _, err = key.GetStringValue("OtherApp"); err != nil || value != `"C:\Other\Other.exe"` {
		t.Fatal("changed another application", value, err)
	}
	if err = migrateAutostart(key, target, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err = key.GetStringValue("jiaojianbox"); err != registry.ErrNotExist {
		t.Fatal("enabled autostart without opt-in")
	}
}

func TestHelperProcess(t *testing.T) {
	if os.Getenv("JJB_SETUP_TEST_HELPER") != "1" {
		return
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	user32 := windows.NewLazySystemDLL("user32.dll")
	className, _ := windows.UTF16PtrFromString("STATIC")
	windowName, _ := windows.UTF16PtrFromString("JiaojianBox setup test")
	hwnd, _, err := user32.NewProc("CreateWindowExW").Call(
		0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(windowName)), 0,
		0, 0, 0, 0, 0, 0, 0, 0,
	)
	if hwnd == 0 {
		t.Fatalf("create test window: %v", err)
	}
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	var message struct {
		HWND    uintptr
		Message uint32
		WParam  uintptr
		LParam  uintptr
		Time    uint32
		PointX  int32
		PointY  int32
		Private uint32
	}
	for {
		result, _, _ := user32.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 || message.Message == 0x0010 { // WM_CLOSE
			return
		}
	}
}

func TestInstalledMainProcessExcludesInstallerItself(t *testing.T) {
	target := filepath.Join(t.TempDir(), "app")
	app := filepath.Join(target, "交件箱.exe")
	if installedMainProcess(app, target, app) {
		t.Fatal("installer would close its own executable")
	}
	if !installedMainProcess(app, target, filepath.Join(t.TempDir(), "setup.exe")) {
		t.Fatal("installed app was not recognized")
	}
	if installedMainProcess(filepath.Join(target, "runtime", "collector-agent.exe"), target, "") {
		t.Fatal("collector helper was treated as the app process")
	}
}

func TestStopInstalledProcessesGracefullyClosesOnlyTarget(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "app")
	other := filepath.Join(root, "other")
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(other, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	start := func(name, directory string) *exec.Cmd {
		path := filepath.Join(directory, name)
		if err = copyFile(executable, path); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(path, "-test.run", "^TestHelperProcess$")
		cmd.Env = append(os.Environ(), "JJB_SETUP_TEST_HELPER=1", "TESTING=1")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err = cmd.Start(); err != nil {
			t.Fatal(err)
		}
		return cmd
	}
	owned := start("交件箱.exe", target)
	otherProcess := start("other.exe", other)
	if err = stopInstalledProcesses(target); err != nil {
		t.Fatal(err)
	}
	if err = owned.Wait(); err != nil {
		t.Fatal("target helper did not close cleanly", err)
	}
	time.Sleep(200 * time.Millisecond)
	if handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(otherProcess.Process.Pid)); err == nil {
		defer windows.CloseHandle(handle)
		if code, err := windows.WaitForSingleObject(handle, 0); err != nil || code == uint32(windows.WAIT_OBJECT_0) {
			t.Fatal("stopped a process outside the target", err, code)
		}
	} else {
		t.Fatal("lost other helper before checking it", err)
	}
	otherProcess.Process.Kill()
	otherProcess.Wait()
}

func copyFile(source, destination string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, data, 0700)
}
