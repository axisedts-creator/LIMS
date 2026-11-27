//go:build !e2e && windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/windows/svc"
	lsvc "lims/apps/bridge-agent/internal/svc"
)

type winHandler struct {
	run     func(context.Context) error
	control func(uint32) bool
}

func (h winHandler) Execute(_ []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	st <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				st <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				st <- svc.Status{State: svc.StopPending, WaitHint: 15000}
				cancel()
				<-done
				return false, 0
			default:
				if c.Cmd >= 128 && h.control != nil {
					_ = h.control(uint32(c.Cmd))
				}
			}
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		}
	}
}

func runDaemon(run func(context.Context) error, control func(uint32) bool) int {
	isSvc, err := svc.IsWindowsService()
	if err != nil {
		fmt.Fprintln(os.Stderr, "bridge-agent: IsWindowsService:", err)
		return 1
	}
	if isSvc {
		if err := svc.Run(lsvc.ServiceName, winHandler{run: run, control: control}); err != nil {
			fmt.Fprintln(os.Stderr, "bridge-agent:", err)
			return 1
		}
		return 0
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		return 1
	}
	return 0
}
