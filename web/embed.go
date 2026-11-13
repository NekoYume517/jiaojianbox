// Package assets embeds the same frontend for the desktop and the standalone server.
package assets

import (
	"embed"
	"io/fs"
)

//go:embed *.html *.js *.css *.svg vendor/*.js vendor/*.LICENSE vendor/*.NOTICE vendor/*.css vendor/fonts/*
var Files embed.FS

func FS() fs.FS { return Files }
