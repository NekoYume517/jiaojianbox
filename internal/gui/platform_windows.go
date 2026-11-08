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
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

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
	return ok != 0 && point.X >= rect.Left && point.X < rect.Right && point.Y >= rect.Top && point.Y < rect.Bottom
}
