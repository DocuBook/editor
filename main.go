package main

import (
	"embed"
	"fmt"
	"net"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"editor/internal/server"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Find a free port for the chi server
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		println("Failed to find port:", err.Error())
		return
	}
	port := ln.(*net.TCPListener).Addr().(*net.TCPAddr).Port
	ln.Close()

	// Start chi HTMX server
	srv := server.New(port)
	go func() {
		fmt.Printf("HTMX server on port %d\n", port)
		if err := srv.Start(); err != nil {
			println("HTMX server error:", err.Error())
		}
	}()

	app := NewApp(srv)

	err = wails.Run(&options.App{
		Title:  "Editor",
		Width:  1200,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 24, G: 24, B: 27, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
