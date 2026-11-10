//go:build windows

package setup

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\JiaojianBox`

func HasWebView() bool {
	for _, entry := range []struct {
		root registry.Key
		path string
	}{{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`}, {registry.CURRENT_USER, `Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`}} {
		key, err := registry.OpenKey(entry.root, entry.path, registry.QUERY_VALUE)
		if err == nil {
			value, _, e := key.GetStringValue("pv")
			key.Close()
			if e == nil && value != "" && value != "0.0.0.0" {
				return true
			}
		}
	}
	return false
}
func runtimeDependency(ctx context.Context, p *Payload, name string) error {
	entry, err := p.Open("dependencies/" + name + ".exe")
	if err != nil {
		return errors.New("安装包缺少运行依赖，请下载完整安装包")
	}
	defer entry.Close()
	dir, err := os.MkdirTemp("", "jjb-dependency-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, name+".exe")
	out, err := os.Create(path)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, entry)
	out.Close()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, path, "/silent", "/install")
	if name == "vcredist" {
		cmd = exec.CommandContext(ctx, path, "/install", "/quiet", "/norestart")
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err = cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && (exit.ExitCode() == 3010 || exit.ExitCode() == 1638) {
			return nil
		}
		return errors.New("运行依赖安装失败，请重试")
	}
	return nil
}

// downloadWebView installs the evergreen WebView2 runtime when the machine
// lacks it and the installer payload carries no offline copy. The bootstrapper
// is about 2 MB and fetches the runtime from Microsoft directly.
func downloadWebView(ctx context.Context) error {
	bootstrapper, err := os.CreateTemp("", "jjb-webview2-*.exe")
	if err != nil {
		return err
	}
	path := bootstrapper.Name()
	defer os.Remove(path)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://go.microsoft.com/fwlink/?linkid=2124701", nil)
	if err != nil {
		bootstrapper.Close()
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		bootstrapper.Close()
		return errors.New("无法下载 WebView2 运行时，请检查网络后重试，或到 https://developer.microsoft.com/microsoft-edge/webview2 手动安装")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		bootstrapper.Close()
		return errors.New("无法下载 WebView2 运行时，请检查网络后重试，或到 https://developer.microsoft.com/microsoft-edge/webview2 手动安装")
	}
	if _, err = io.Copy(bootstrapper, io.LimitReader(response.Body, 64<<20)); err != nil {
		bootstrapper.Close()
		return err
	}
	if err = bootstrapper.Close(); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, path, "/silent", "/install")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err = cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && (exit.ExitCode() == 3010 || exit.ExitCode() == 1638) {
			return nil
		}
		return errors.New("WebView2 运行时安装失败，请重试")
	}
	return nil
}

func EnsureWebView(ctx context.Context, p *Payload) error {
	if HasWebView() {
		return nil
	}
	if err := runtimeDependency(ctx, p, "webview2"); err == nil {
		return nil
	}
	return downloadWebView(ctx)
}
func EnsureVC(ctx context.Context, p *Payload) error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err == nil {
		value, _, e := key.GetIntegerValue("Installed")
		key.Close()
		if e == nil && value == 1 {
			return nil
		}
	}
	return runtimeDependency(ctx, p, "vcredist")
}
func DefaultDirectory() string {
	if key, err := registry.OpenKey(registry.CURRENT_USER, uninstallKey, registry.QUERY_VALUE); err == nil {
		location, _, e := key.GetStringValue("InstallLocation")
		key.Close()
		if e == nil && filepath.IsAbs(location) {
			if isJiaojianboxInstallation(location) {
				return location
			}
		}
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "交件箱")
}

func underDirectory(processPath, target string) bool {
	processPath = filepath.Clean(processPath)
	target = filepath.Clean(target)
	prefix := target + string(os.PathSeparator)
	return len(processPath) > len(prefix) && strings.EqualFold(processPath[:len(prefix)], prefix)
}

func processImageName(handle windows.Handle) (string, bool) {
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return "", false
	}
	return windows.UTF16ToString(buffer[:size]), true
}

func terminateProcessHandle(handle windows.Handle) bool {
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return false
	}
	code, err := windows.WaitForSingleObject(handle, 3000)
	return err == nil && code == uint32(windows.WAIT_OBJECT_0)
}

// stopInstalledProcesses closes only old processes whose executable lives in
// the selected installation. Other installations and unrelated same-name
// processes are left alone.
func stopInstalledProcesses(target string) {
	target = filepath.Clean(target)
	self, err := os.Executable()
	if err == nil {
		self = filepath.Clean(self)
	} else {
		self = ""
	}
	for round := 0; round < 2; round++ {
		found := false
		snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
		if err != nil {
			return
		}
		entrySize := uint32(unsafe.Sizeof(windows.ProcessEntry32{}))
		entry := windows.ProcessEntry32{Size: entrySize}
		if err := windows.Process32First(snapshot, &entry); err == nil {
			for {
				processPath := ""
				if entry.ProcessID != uint32(os.Getpid()) {
					if handle, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, entry.ProcessID); e == nil {
						if name, ok := processImageName(handle); ok {
							processPath = filepath.Clean(name)
							if underDirectory(processPath, target) && !strings.EqualFold(processPath, self) {
								found = terminateProcessHandle(handle) || found
							}
						}
						windows.CloseHandle(handle)
					}
				}
				if err := windows.Process32Next(snapshot, &entry); err != nil {
					break
				}
			}
		}
		windows.CloseHandle(snapshot)
		if !found {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func powershellEnv(extra ...string) []string {
	values := []string{}
	for _, value := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(value), "PSMODULEPATH=") {
			values = append(values, value)
		}
	}
	values = append(values, "PSModulePath="+filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "Modules"))
	return append(values, extra...)
}

// Preserve an existing opt-in when upgrading from the older installation path.
// Registry entries belonging to other applications are never changed.
func migrateAutostart(key registry.Key, target string, remove bool) error {
	names, err := key.ReadValueNames(-1)
	if err != nil {
		return err
	}
	for _, name := range names {
		if !strings.EqualFold(name, "交件箱") && !strings.EqualFold(name, "jiaojianbox") && !strings.EqualFold(name, "com.electron.jiaojianbox") {
			continue
		}
		command, _, err := key.GetStringValue(name)
		if err != nil {
			continue
		}
		parts, err := windows.DecomposeCommandLine(command)
		if err != nil || len(parts) == 0 {
			continue
		}
		base := filepath.Base(parts[0])
		if !strings.EqualFold(base, "交件箱.exe") && !strings.EqualFold(base, "JiaojianBox.exe") {
			continue
		}
		executable := filepath.Join(target, "交件箱.exe")
		if remove {
			if strings.EqualFold(filepath.Clean(parts[0]), filepath.Clean(executable)) {
				if err = key.DeleteValue(name); err != nil {
					return err
				}
			}
		} else {
			if err = key.SetStringValue(name, `"`+executable+`" --silent`); err != nil {
				return err
			}
		}
	}
	return nil
}
func Register(target, version string, desktop, startMenu bool) error {
	script := `$s=New-Object -ComObject WScript.Shell
$exe=Join-Path $env:JJB_INSTALL_DIR '交件箱.exe'
function Link($folder){New-Item -ItemType Directory -Force -Path $folder | Out-Null; $l=$s.CreateShortcut((Join-Path $folder '交件箱.lnk'));$l.TargetPath=$exe;$l.WorkingDirectory=$env:JJB_INSTALL_DIR;$l.IconLocation=$exe+',0';$l.Save()}
if($env:JJB_DESKTOP_LINK -eq '1'){Link ([Environment]::GetFolderPath('Desktop'))}
if($env:JJB_START_LINK -eq '1'){Link (Join-Path ([Environment]::GetFolderPath('Programs')) '交件箱')}`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = powershellEnv("JJB_INSTALL_DIR="+target, "JJB_DESKTOP_LINK="+bit(desktop), "JJB_START_LINK="+bit(startMenu))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Run(); err != nil {
		return errors.New("快捷方式创建失败，可直接打开安装目录中的交件箱")
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	for name, value := range map[string]string{"DisplayName": "交件箱", "DisplayVersion": version, "Publisher": "交件箱", "InstallLocation": target, "DisplayIcon": filepath.Join(target, "交件箱.exe"), "UninstallString": `"` + filepath.Join(target, "Uninstall.exe") + `"`, "QuietUninstallString": `"` + filepath.Join(target, "Uninstall.exe") + `" --quiet`, "URLInfoAbout": "https://github.com/NekoYume517/jiaojianbox"} {
		if err = key.SetStringValue(name, value); err != nil {
			return err
		}
	}
	key.SetDWordValue("NoModify", 1)
	key.SetDWordValue("NoRepair", 1)
	if startup, e := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.QUERY_VALUE|registry.SET_VALUE); e == nil {
		defer startup.Close()
		if err = migrateAutostart(startup, target, false); err != nil {
			return err
		}
	}
	return nil
}
func bit(value bool) string {
	if value {
		return "1"
	}
	return "0"
}
func Unregister(target string) {
	key, err := registry.OpenKey(registry.CURRENT_USER, uninstallKey, registry.QUERY_VALUE)
	if err != nil {
		return
	}
	location, _, _ := key.GetStringValue("InstallLocation")
	key.Close()
	if !strings.EqualFold(filepath.Clean(location), filepath.Clean(target)) {
		return
	}
	script := `$s=New-Object -ComObject WScript.Shell
foreach($folder in @([Environment]::GetFolderPath('Desktop'),(Join-Path ([Environment]::GetFolderPath('Programs')) '交件箱'))){$p=Join-Path $folder '交件箱.lnk';if(Test-Path -LiteralPath $p){$l=$s.CreateShortcut($p);if($l.TargetPath -eq (Join-Path $env:JJB_INSTALL_DIR '交件箱.exe')){Remove-Item -LiteralPath $p}}}`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = powershellEnv("JJB_INSTALL_DIR=" + target)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Run()
	registry.DeleteKey(registry.CURRENT_USER, uninstallKey)
	if startup, e := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.QUERY_VALUE|registry.SET_VALUE); e == nil {
		defer startup.Close()
		migrateAutostart(startup, target, true)
	}
}
func Message(text string, confirm bool) bool {
	caption, _ := windows.UTF16PtrFromString("交件箱")
	body, _ := windows.UTF16PtrFromString(text)
	flags := uintptr(0x40)
	if confirm {
		flags = 0x24
	}
	result, _, _ := windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(caption)), flags)
	return result == 6
}
