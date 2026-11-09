//go:build !windows

package gui

func guardChildren() error { return nil }
func claimInstance(root string, activate chan<- struct{}) (func(), bool, error) {
	return func() {}, true, nil
}
