package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/NekoYume517/jiaojianbox/internal/setup"
	"os"
)

func main() {
	silent := flag.Bool("silent", false, "install without a window")
	directory := flag.String("dir", setup.DefaultDirectory(), "installation directory")
	noShortcuts := flag.Bool("no-shortcuts", false, "disable shortcuts")
	noRegister := flag.Bool("no-register", false, "do not register with Windows")
	flag.Parse()
	exe, err := os.Executable()
	if err != nil {
		fatal(err, *silent)
	}
	payload, err := setup.OpenPayload(exe)
	if err != nil {
		fatal(err, *silent)
	}
	defer payload.File.Close()
	if *silent {
		ctx := context.Background()
		if err = setup.EnsureWebView(ctx, payload); err != nil {
			fatal(err, true)
		}
		if err = setup.EnsureVC(ctx, payload); err != nil {
			fatal(err, true)
		}
		resolved, e := setup.ResolveDirectory(*directory)
		if e != nil {
			fatal(e, true)
		}
		target, e := setup.Install(ctx, payload, resolved, !*noShortcuts, !*noShortcuts, func(int, string) {})
		if e != nil {
			fatal(e, true)
		}
		if !*noRegister {
			if e = setup.Register(target, payload.Manifest.Version, !*noShortcuts, !*noShortcuts); e != nil {
				fatal(e, true)
			}
		}
		return
	}
	if err = setup.Run(payload); err != nil {
		fatal(err, false)
	}
}
func fatal(err error, silent bool) {
	if silent {
		fmt.Fprintln(os.Stderr, err)
	} else {
		setup.Message(err.Error(), false)
	}
	os.Exit(1)
}
