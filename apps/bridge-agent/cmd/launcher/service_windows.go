//go:build windows

package main

import (
	"context"
	"fmt"
	"os"

	"golang.org/x/sys/windows/svc"
)

type handler struct{ run func(context.Context) error }

func (h handler) Execute(_ []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
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
				st <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		case err := <-done:
			if err != nil {
				fmt.Fprintln(os.Stderr, "bridge-launcher:", err)
				return true, 1 // service-specific exit code: SCM recovery restarts us
			}
			return false, 0
		}
	}
}

func runService(run func(context.Context) error) int {
	if isSvc, err := svc.IsWindowsService(); err != nil || !isSvc {
		return runConsole(run)
	}
	if err := svc.Run(serviceName, handler{run}); err != nil {
		fmt.Fprintln(os.Stderr, "bridge-launcher:", err)
		return 1
	}
	return 0
}
