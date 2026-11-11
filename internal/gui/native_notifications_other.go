//go:build !windows

package gui

func nativeNotificationsSupported() (bool, string) {
	return false, "Windows 原生提醒仅在 Windows 10 及以上版本可用"
}
