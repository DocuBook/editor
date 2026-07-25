package main

import (
	"context"
	"fmt"

	"editor/internal/server"
)

type App struct {
	ctx  context.Context
	srv  *server.Server
}

func NewApp(srv *server.Server) *App {
	return &App{srv: srv}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) ServerPort() int {
	return a.srv.Port
}

func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}
