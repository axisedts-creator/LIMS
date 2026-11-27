//go:build !e2e

// Command agent is the bridge agent service and operator CLI binary (02-TRD §3, §5.12, §5.13).
// The `e2e` build tag swaps this file for e2e_main.go (INT-T01 test build).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"lims/apps/bridge-agent/internal/cli"
	"lims/apps/bridge-agent/internal/queue"
	aruntime "lims/apps/bridge-agent/internal/runtime"
	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/svc"
)

var (
	agentVersion    = "1.0.0"
	launcherVersion = "1.0.0"
	buildCommit     = "dev"
)

func defaultLayout(dataDirOverride string) svc.Layout {
	progData := strings.TrimSpace(os.Getenv("ProgramData"))
	if progData == "" {
		progData = `C:\ProgramData`
	}
	progFiles := strings.TrimSpace(os.Getenv("ProgramFiles"))
	if progFiles == "" {
		progFiles = `C:\Program Files`
	}
	l := svc.NewLayout(progData, progFiles)
	if env := strings.TrimSpace(os.Getenv("LIMS_BRIDGE_DATA_ROOT")); env != "" {
		l.DataRoot = env
	}
	if ov := strings.TrimSpace(dataDirOverride); ov != "" {
		l.DataRoot = ov
	}
	return l
}

func hostFingerprint() (string, error) {
	host, err := os.Hostname()
	if err != nil {
		host = "unknown-host"
	}
	sum := sha256.Sum256([]byte(host + "|" + runtime.GOOS + "|" + runtime.GOARCH))
	return hex.EncodeToString(sum[:]), nil
}

func realDeps(layout svc.Layout) cli.Deps {
	plat := svc.NewWindowsPlatform(layout, svc.ServiceName)
	return cli.Deps{
		Out: os.Stdout,
		Err: os.Stderr,
		Env: svc.Env{
			Platform: plat,
			Enroller: svc.HTTPEnroller{Timeout: 30 * time.Second},
			Layout:   layout,
			NewProtector: func(entropy []byte) secrets.Protector {
				return secrets.NewDPAPI(secrets.ScopeMachine, entropy)
			},
			AgentVersion:    agentVersion,
			LauncherVersion: launcherVersion,
			HostFingerprint: hostFingerprint,
		},
		Pending: func() (int, error) {
			dbPath := filepath.Join(layout.DataRoot, "queue", "agent.db")
			if _, err := os.Stat(dbPath); errors.Is(err, os.ErrNotExist) {
				return 0, nil
			} else if err != nil {
				return 0, err
			}
			lc, err := svc.ReadLocalConfig(layout)
			if err != nil {
				return 0, err
			}
			if lc.AgentID == "" {
				return 0, errors.New("config.local.json has no agent_id")
			}
			p := secrets.NewDPAPI(secrets.ScopeMachine, []byte(lc.AgentID))
			db, err := queue.Open(dbPath, p, queue.Options{})
			if err != nil {
				return 0, err
			}
			defer db.Close()
			return db.PendingAndRejectedCount()
		},
		Version: cli.VersionInfo{
			Agent:    agentVersion,
			Launcher: launcherVersion,
			Build:    buildCommit,
		},
		Now: time.Now,
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] != "run" {
		os.Exit(cli.Run(os.Args[1:], realDeps(defaultLayout(""))))
	}

	var dataDir string
	if len(os.Args) > 1 && os.Args[1] == "run" {
		fs := flag.NewFlagSet("run", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		fs.StringVar(&dataDir, "data-dir", "", "override bridge data root directory")
		if err := fs.Parse(os.Args[2:]); err != nil {
			os.Exit(cli.ExitUsage)
		}
	}

	layout := defaultLayout(dataDir)
	plat := svc.NewWindowsPlatform(layout, svc.ServiceName)
	osVer := runtime.GOOS + " " + runtime.GOARCH
	if v, err := plat.OSVersion(); err == nil && v.Name != "" {
		osVer = fmt.Sprintf("%s %d.%d.%d", v.Name, v.Major, v.Minor, v.Build)
		if len(osVer) > 64 {
			osVer = osVer[:64]
		}
	}

	var (
		ctlMu sync.RWMutex
		ctlFn func(uint32) bool
	)
	opts := aruntime.Options{
		Layout:          layout,
		AgentVersion:    agentVersion,
		LauncherVersion: launcherVersion,
		OSVersion:       osVer,
		Out:             os.Stderr,
		OnReady: func(fn func(uint32) bool) {
			ctlMu.Lock()
			ctlFn = fn
			ctlMu.Unlock()
		},
	}

	code := runDaemon(func(ctx context.Context) error {
		return aruntime.Run(ctx, opts)
	}, func(code uint32) bool {
		ctlMu.RLock()
		fn := ctlFn
		ctlMu.RUnlock()
		if fn != nil {
			return fn(code)
		}
		return false
	})
	os.Exit(code)
}
