//go:build !windows

package main

import "context"

func runService(run func(context.Context) error) int { return runConsole(run) }
