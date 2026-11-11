//go:build windows

package gui

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"sync"
	"time"
	"unsafe"
)

// Windows users enable proxies in system settings (WinINet), which Go's
// default transport ignores — it only reads environment variables. The
// updater therefore asks the registry directly and refreshes the cached
// result periodically so toggling the proxy does not require a restart.
type systemProxyConfig struct {
	at       time.Time
	proxy    *url.URL
	bypass   []string
	disabled bool
}

var systemProxyCache struct {
	sync.Mutex
	config systemProxyConfig
}

func systemProxyFor(request *http.Request) (*url.URL, error) {
	if candidate, err := http.ProxyFromEnvironment(request); candidate != nil || err != nil {
		return candidate, err
	}
	now := time.Now()
	systemProxyCache.Lock()
	config := systemProxyCache.config
	systemProxyCache.Unlock()
	if now.Sub(config.at) > 10*time.Second {
		config = readSystemProxyConfig(now)
		systemProxyCache.Lock()
		systemProxyCache.config = config
		systemProxyCache.Unlock()
	}
	if config.proxy == nil || config.disabled || systemProxyBypassed(config.bypass, request.URL.Hostname()) {
		return nil, nil
	}
	return config.proxy, nil
}

func readSystemProxyConfig(now time.Time) systemProxyConfig {
	config := systemProxyConfig{at: now}
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return config
	}
	defer key.Close()
	if enabled, _, err := key.GetIntegerValue("ProxyEnable"); err != nil || enabled == 0 {
		config.disabled = true
		return config
	}
	server, _, err := key.GetStringValue("ProxyServer")
	if err != nil || strings.TrimSpace(server) == "" {
		config.disabled = true // PAC-only setups (AutoConfigURL) are not evaluated.
		return config
	}
	proxy, bypass := parseWinINetProxyServer(server), parseWinINetBypass(overrideValue(key))
	if proxy == nil {
		config.disabled = true
		return config
	}
	config.proxy = proxy
	config.bypass = bypass
	return config
}

func parseWinINetProxyServer(server string) *url.URL {
	protocols := map[string]string{}
	single := ""
	for _, item := range strings.Split(server, ";") {
		token := strings.TrimSpace(item)
		if token == "" {
			continue
		}
		if key, value, found := strings.Cut(token, "="); found {
			protocols[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
			continue
		}
		single = token
	}
	build := func(raw string) *url.URL {
		if raw == "" {
			return nil
		}
		if strings.HasPrefix(strings.ToLower(raw), "socks://") {
			raw = "socks5://" + strings.TrimPrefix(strings.TrimPrefix(raw, "socks://"), "//")
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" {
			return nil
		}
		return parsed
	}
	for _, key := range []string{"https", "http"} {
		if raw := protocols[key]; raw != "" {
			if parsed := build(raw); parsed != nil {
				return parsed
			}
		}
	}
	if raw := protocols["socks"]; raw != "" {
		if parsed := build(raw); parsed != nil {
			return parsed
		}
	}
	return build(single)
}

func overrideValue(key registry.Key) string {
	value, _, err := key.GetStringValue("ProxyOverride")
	if err != nil {
		return ""
	}
	return value
}

func parseWinINetBypass(raw string) []string {
	items := []string{}
	for _, item := range strings.Split(raw, ";") {
		token := strings.TrimSpace(strings.ToLower(item))
		token = strings.TrimPrefix(token, "https://")
		token = strings.TrimPrefix(token, "http://")
		token = strings.TrimSuffix(token, ":*")
		if token != "" {
			items = append(items, token)
		}
	}
	return items
}

func systemProxyBypassed(rules []string, hostname string) bool {
	host := strings.ToLower(hostname)
	for _, rule := range rules {
		if rule == "<local>" {
			if !strings.Contains(host, ".") {
				return true
			}
			continue
		}
		if strings.HasPrefix(rule, "*.") {
			if host == strings.TrimPrefix(rule, "*.") || strings.HasSuffix(host, "."+strings.TrimPrefix(rule, "*.")) {
				return true
			}
			continue
		}
		if host == rule {
			return true
		}
	}
	return false
}

func protect(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, errors.New("凭证不能为空")
	}
	in := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	var out windows.DataBlob
	err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte("JJB1"), unsafe.Slice(out.Data, out.Size)...), nil
}
func unprotect(data []byte) ([]byte, error) {
	if bytes.HasPrefix(data, []byte("JJB1")) {
		data = data[4:]
	} // legacy DPAPI blobs are accepted as well
	if len(data) == 0 {
		return nil, errors.New("凭证为空")
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

func unprotectLegacy(data []byte, root string) ([]byte, error) {
	if !bytes.HasPrefix(data, []byte("v10")) {
		return unprotect(data)
	}
	state, err := os.ReadFile(filepath.Join(root, "Local State"))
	if err != nil {
		return nil, err
	}
	var local Object
	if err = json.Unmarshal(state, &local); err != nil {
		return nil, err
	}
	encoded := getString(getObject(local["os_crypt"]), "encrypted_key")
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || !bytes.HasPrefix(key, []byte("DPAPI")) {
		return nil, errors.New("旧凭证密钥格式无效")
	}
	key, err = unprotect(key[5:])
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < 3+aead.NonceSize()+aead.Overhead() {
		return nil, errors.New("旧凭证内容不完整")
	}
	return aead.Open(nil, data[3:3+aead.NonceSize()], data[3+aead.NonceSize():], nil)
}
func hideProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

var user32 = windows.NewLazySystemDLL("user32.dll")
var shell32 = windows.NewLazySystemDLL("shell32.dll")

// The updater runs the downloaded installer through the shell so its own
// window shows normally and Windows can prompt for elevation when needed.
func launchInstaller(path string) error {
	open, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	instance, _, callErr := shell32.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(open)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
	if instance <= 32 {
		if callErr != syscall.Errno(0) {
			return callErr
		}
		return errors.New("安装程序无法启动，请重新下载")
	}
	return nil
}

func cursorWithin(window *application.WebviewWindow) bool {
	if window == nil || !window.IsVisible() {
		return false
	}
	handle := window.NativeWindow()
	if handle == nil {
		return false
	}
	var point struct{ X, Y int32 }
	var rect struct{ Left, Top, Right, Bottom int32 }
	ok, _, _ := user32.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&point)))
	if ok == 0 {
		return false
	}
	ok, _, _ = user32.NewProc("GetWindowRect").Call(uintptr(handle), uintptr(unsafe.Pointer(&rect)))
	if ok == 0 || point.X < rect.Left || point.X >= rect.Right || point.Y < rect.Top || point.Y >= rect.Bottom {
		return false
	}
	// Explorer may cover our rectangle. Only suppress collection when the
	// actual window under the pointer belongs to the main window.
	packed := uintptr(uint64(uint32(point.X)) | uint64(uint32(point.Y))<<32)
	hit, _, _ := user32.NewProc("WindowFromPoint").Call(packed)
	if hit == 0 {
		return false
	}
	root, _, _ := user32.NewProc("GetAncestor").Call(hit, 2) // GA_ROOT
	return root == uintptr(handle)
}
