package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/api"
	"github.com/NekoYume517/jiaojianbox/internal/store"
	assets "github.com/NekoYume517/jiaojianbox/web"
)

var version = "0.6.3-dev"

func main() {
	health := flag.String("healthcheck", "", "probe a running server")
	verify := flag.String("verify-backup", "", "verify existing records against an upgrade backup")
	root := flag.String("data", env("JJB_DATA_DIR", "data"), "workspace directory")
	address := flag.String("listen", env("JJB_LISTEN", "127.0.0.1:8765"), "HTTP listening address")
	flag.Parse()
	if *verify != "" {
		result, err := store.VerifyBackup(context.Background(), *root, *verify)
		if err != nil {
			log.Fatal(err)
		}
		json.NewEncoder(os.Stdout).Encode(result)
		return
	}
	if *health != "" {
		response, err := (&http.Client{Timeout: 4 * time.Second}).Get(*health)
		if err != nil {
			os.Exit(1)
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			os.Exit(1)
		}
		fmt.Println("healthy")
		return
	}
	database, err := store.Open(*root)
	if err != nil {
		log.Fatal(err)
	}
	defer database.Close()
	core, err := api.New(database, assets.FS(), version)
	if err != nil {
		log.Fatal(err)
	}
	defer core.Close()
	server := &http.Server{Addr: *address, Handler: core, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		timeout, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(timeout)
	}()
	log.Printf("交件箱 %s · %s", version, *address)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
func env(name, value string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return value
}
