//go:build windows

package gui

import (
	"errors"
	"github.com/NekoYume517/jiaojianbox/internal/store"
	"golang.org/x/sys/windows"
	"os"
	"os/user"
	"unsafe"
)

// Keep this non-inheritable handle open for the entire host lifetime. Windows
// closes it even on TerminateProcess, killing all descendants including helpers.
var lifetimeJob windows.Handle

func guardChildren() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return err
	}
	if err = windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		windows.CloseHandle(job)
		return err
	}
	lifetimeJob = job
	return nil
}
func claimInstance(root string, activate chan<- struct{}) (func(), bool, error) {
	u, err := user.Current()
	if err != nil {
		return nil, false, err
	}
	// User identity stays stable across installation paths and version upgrades.
	identity := u.Uid
	if os.Getenv("JJB_USER_DATA") != "" {
		identity += "|" + root
	} // isolated dev/test profile
	name := "Local\\JiaojianBox." + store.Hash(identity)[:20]
	mutex, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, false, err
	}
	event, e := windows.CreateEvent(nil, 0, 0, windows.StringToUTF16Ptr(name+".activate"))
	if e != nil && !errors.Is(e, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(mutex)
		return nil, false, e
	}
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		windows.SetEvent(event)
		windows.CloseHandle(event)
		windows.CloseHandle(mutex)
		return func() {}, false, nil
	}
	done := make(chan struct{})
	go func() {
		for {
			code, _ := windows.WaitForSingleObject(event, 250)
			select {
			case <-done:
				return
			default:
			}
			if code == windows.WAIT_OBJECT_0 {
				select {
				case activate <- struct{}{}:
				default:
				}
			}
		}
	}()
	return func() { close(done); windows.CloseHandle(event); windows.CloseHandle(mutex) }, true, nil
}
