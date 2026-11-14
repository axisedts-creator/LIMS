# AG-T08 impl
- Files: apps/bridge-agent/internal/transport/tcp/tcp.go, .../serial/serial.go; go.mod/go.sum (+go.bug.st/serial v1.8.0).
- Tests: `go test -count=1 ./internal/transport/...` green (tcp, serial); `go vet`, `go build ./...` clean. -race not run (no cgo here).
- [CONV] tcp.Listen refuses ""/non-IP/wildcard but skips ValidateListenConfig; empty allowlist rejects all; Accept serialised by mutex, ctx cancel via SetDeadline (listener stays usable).
- [CONV] Newest accepted conn closes the previous one — but only when Accept is called again; agent loop must keep calling Accept while serving a conn.
- [CONV] serial DTR/RTS nil = true; Open validates first, wraps go.bug.st Port directly.
- Open: serial pair tests SKIP as [manual] (LIMS_SERIAL_PAIR unset); Close-unblocks-Read unverified on real COM pair.
