//go:build !e2e && !windows

package main

import (
	"context"
	"os/signal"
	"syscall"
)

func runDaemon(run func(context.Context) error, _ func(uint32) bool) int {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		return 1
	}
	return 0
}
