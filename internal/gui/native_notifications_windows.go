//go:build windows

package gui

import (
	"fmt"

	"golang.org/x/sys/windows"
)

func nativeNotificationsSupported() (bool, string) {
	version := windows.RtlGetVersion()
	if version.MajorVersion < 10 {
		return false, fmt.Sprintf("Windows 原生提醒需要 Windows 10 或更高版本，当前为 %d.%d", version.MajorVersion, version.MinorVersion)
	}
	return true, ""
}
