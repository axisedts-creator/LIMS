# AG-T14 impl
Files: apps/bridge-agent/internal/filedrop/watcher.go (TRD's watcher/stability/seen.go split collapsed into one file). Review round 1: items 1-3 applied.
[CONV] FilenamePattern = Go RE2 (TRD 5.8, <=200 chars, case-sensitive as written); AllowedTypes subset of {pdf,png,jpg}, nil = all three, ext compared case-insensitively; empty files skipped; barcode_regex needs named group "barcode".
[CONV] CapturedSubdirectory "" = "captured", validated against ^[A-Za-z0-9_-]{1,60}$ (AB14). Move never overwrites (O_EXCL reserve, -1/-2 suffix), refuses a symlink/junction captured dir.
[CONV] Seen key mtime truncated to ms (matches the TEXT column); CapturedAtAgent = Now, ClockOffsetMs = 0 (no clock source in a file drop).
Own newUUIDv7 copy (uploader/hostquery helpers are unexported, not my paths).
Tests: `go test -count=1 ./internal/filedrop/...` PASS (incl. Windows integration + new review tests), go vet clean. NOT run: `-race` (cgo unavailable), gofmt -l (not approved in this session).
Open: no queue adapter yet for Store (Capture = item insert + file_drop_seen in ONE tx) — needs a CR/task in internal/queue. Lstat→Open TOCTOU narrowed with SameFile, not closed.
