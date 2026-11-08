//go:build windows

package setup

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
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
func EnsureWebView(ctx context.Context, p *Payload) error {
	if HasWebView() {
		return nil
	}
	return runtimeDependency(ctx, p, "webview2")
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
			if _, e = os.Stat(filepath.Join(location, Marker)); e == nil {
				return location
			}
		}
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "交件箱")
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
