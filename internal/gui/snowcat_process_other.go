//go:build !windows

package gui

func qqProcessIDs(string) ([]int, error) {
	return nil, nil
}

func requestGracefulQQClose([]int) int {
	return 0
}
