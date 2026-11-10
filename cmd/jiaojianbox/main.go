package main

import (
	"github.com/NekoYume517/jiaojianbox/internal/gui"
	"log"
)

var version = "0.6.7"

func main() {
	if err := gui.Run(version); err != nil {
		log.Fatal(err)
	}
}
