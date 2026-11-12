//go:build !windows

package gui

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zalando/go-keyring"
)

func systemCipher() (cipher.AEAD, error) {
	key, err := keyring.Get("com.jiaojianbox.desktop", "vault-key")
	if err == keyring.ErrNotFound {
		raw := make([]byte, 32)
		if _, err = rand.Read(raw); err != nil {
			return nil, err
		}
		key = base64.StdEncoding.EncodeToString(raw)
		err = keyring.Set("com.jiaojianbox.desktop", "vault-key", key)
	}
	if err != nil {
		return nil, errors.New("系统密钥环不可用，请启用后再保存登录凭证")
	}
	raw, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func protect(plain []byte) ([]byte, error) {
	aead, err := systemCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, plain, nil), nil
}
func unprotect(raw []byte) ([]byte, error) {
	aead, err := systemCipher()
	if err != nil {
		return nil, err
	}
	size := aead.NonceSize()
	if len(raw) < size {
		return nil, errors.New("凭证损坏")
	}
	return aead.Open(nil, raw[:size], raw[size:], nil)
}
func unprotectLegacy(raw []byte, root string) ([]byte, error) { return unprotect(raw) }
func hideProcess(cmd *exec.Cmd)                               {}
func launchInstaller(path string) error                       { return exec.Command(path).Start() }
func cursorWithin(window *application.WebviewWindow) bool     { return window != nil && window.IsFocused() }
func activateNativeWindow(*application.WebviewWindow)         {}
func showQuickNoActivate(window *application.WebviewWindow) {
	if window != nil {
		window.Show()
	}
}

func systemProxyFor(request *http.Request) (*url.URL, error) {
	return http.ProxyFromEnvironment(request)
}

func showFatalDialog(message string) {
	fmt.Fprintln(os.Stderr, message)
}
