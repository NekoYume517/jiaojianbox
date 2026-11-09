//go:build windows

package gui

// Windows chrome follows yetone/magpie (MIT): retain system caption buttons,
// tint the real title bar to the page, and leave resizing to the native frame.
import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/w32"
)

func desktopWindowChrome(theme string) (application.WindowsWindow, application.RGBA) {
	light, dark := application.NewRGBPtr(0xf4, 0xf4, 0xf6), application.NewRGBPtr(0x1a, 0x1a, 0x1e)
	options := application.WindowsWindow{
		Theme: application.Light,
		CustomTheme: application.ThemeSettings{
			LightModeActive: &application.WindowTheme{TitleBarColour: light}, LightModeInactive: &application.WindowTheme{TitleBarColour: light},
			DarkModeActive: &application.WindowTheme{TitleBarColour: dark}, DarkModeInactive: &application.WindowTheme{TitleBarColour: dark},
		},
	}
	background := application.NewRGB(0xf4, 0xf4, 0xf6)
	if theme == "dark" || theme != "light" && w32.IsCurrentlyDarkMode() {
		options.Theme, background = application.Dark, application.NewRGB(0x1a, 0x1a, 0x1e)
	}
	return options, background
}

func (d *Desktop) tintTitlebar(red, green, blue uint8, dark bool) bool {
	if !w32.SupportsCustomThemes() {
		return false
	}
	application.InvokeSync(func() {
		if d.main == nil {
			return
		}
		hwnd := uintptr(d.main.NativeWindow())
		if hwnd == 0 {
			return
		}
		w32.SetTheme(hwnd, dark)
		w32.SetTitleBarColour(hwnd, uint32(red)|uint32(green)<<8|uint32(blue)<<16)
		d.main.SetBackgroundColour(application.NewRGB(red, green, blue))
	})
	return true
}

// Wails beta.24 installs client-edge resize hit testing even on framed Windows.
// Keep its switch off; the operating system still resizes the actual frame.
const frameOnlyResizeJS = `(()=>{const w=window._wails;if(!w||typeof w.setResizable!=="function")return;if(!w.setResizable.frameOnly){const f=w.setResizable;w.setResizable=()=>f(false);w.setResizable.frameOnly=true}w.setResizable(false)})();`
