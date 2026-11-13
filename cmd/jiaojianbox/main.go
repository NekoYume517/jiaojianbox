package main

import (
	"github.com/NekoYume517/jiaojianbox/internal/gui"
	"os"
)

var version = "0.6.20-preview"

func main() {
	if err := gui.Run(version); err != nil {
		gui.ReportFatal(err)
		os.Exit(1)
	}
}
