package main

import (
	"github.com/NekoYume517/jiaojianbox/internal/gui"
	"os"
)

var version = "0.6.21"

func main() {
	// The desktop process is a user-controlled local workspace. Allow models
	// hosted on loopback or a private LAN unless the operator explicitly
	// overrides the setting; the public server keeps the secure default.
	if _, configured := os.LookupEnv("JJB_ALLOW_PRIVATE_UPSTREAMS"); !configured {
		_ = os.Setenv("JJB_ALLOW_PRIVATE_UPSTREAMS", "true")
	}
	if err := gui.Run(version); err != nil {
		gui.ReportFatal(err)
		os.Exit(1)
	}
}
