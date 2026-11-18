//go:build !windows

package gui

func guardChildren() error                               { return nil }
func listenInstallerExit(string, func()) (func(), error) { return func() {}, nil }
func claimInstance(root string, activate chan<- struct{}) (func(), bool, error) {
	return func() {}, true, nil
}
