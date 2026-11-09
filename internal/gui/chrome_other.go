//go:build !windows

package gui

import "github.com/wailsapp/wails/v3/pkg/application"

func desktopWindowChrome(string) (application.WindowsWindow, application.RGBA) {
	return application.WindowsWindow{}, application.NewRGB(0xf4, 0xf4, 0xf6)
}

func (*Desktop) tintTitlebar(uint8, uint8, uint8, bool) bool { return false }

const frameOnlyResizeJS = ""
