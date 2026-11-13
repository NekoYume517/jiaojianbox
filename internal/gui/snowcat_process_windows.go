//go:build windows

package gui

import (
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func qqProcessIDs(home string) ([]int, error) {
	home = filepath.Clean(home)
	if home == "." || home == "" {
		return nil, nil
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err = windows.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}
	pids := []int{}
	for {
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), "QQ.exe") {
			handle, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
			if openErr == nil {
				buffer := make([]uint16, 32768)
				size := uint32(len(buffer))
				if imageErr := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); imageErr == nil {
					image := filepath.Clean(windows.UTF16ToString(buffer[:size]))
					prefix := home + string(filepath.Separator)
					if len(image) > len(prefix) && strings.EqualFold(image[:len(prefix)], prefix) {
						pids = append(pids, int(entry.ProcessID))
					}
				}
				windows.CloseHandle(handle)
			}
		}
		if err = windows.Process32Next(snapshot, &entry); err != nil {
			break
		}
	}
	return pids, nil
}

func requestGracefulQQClose(pids []int) int {
	if len(pids) == 0 {
		return 0
	}
	wanted := make(map[uint32]bool, len(pids))
	for _, pid := range pids {
		wanted[uint32(pid)] = true
	}
	posted := 0
	postMessage := windows.NewLazySystemDLL("user32.dll").NewProc("PostMessageW")
	callback := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var pid uint32
		if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &pid); err != nil || !wanted[pid] {
			return 1
		}
		ok, _, _ := postMessage.Call(hwnd, 0x0010, 0, 0) // WM_CLOSE
		if ok != 0 {
			posted++
		}
		return 1
	})
	windows.EnumWindows(callback, nil)
	runtime.KeepAlive(callback)
	return posted
}
