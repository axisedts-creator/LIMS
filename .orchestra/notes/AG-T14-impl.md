# AG-T14 impl
Files: apps/bridge-agent/internal/filedrop/watcher.go (new; TRD's watcher/stability/seen.go split collapsed into one file).
[CONV] Extensions fixed to .pdf/.png/.jpg (AC-12.1, case-insensitive); FilenamePattern matched case-insensitively; empty files skipped; barcode_regex must have a named group "barcode".
[CONV] Move never overwrites: reserves the name with O_EXCL (-1, -2 suffix on clash), refuses a symlink/junction captured dir; CapturedSubdirectory = one plain segment (no / \ : or trailing dot/space).
[CONV] Seen key mtime truncated to ms (matches the TEXT column); CapturedAtAgent = Now, ClockOffsetMs = 0 (no clock source in a file drop).
Own newUUIDv7 copy (uploader/hostquery helpers are unexported, not my paths).
Tests: `go test -count=1 ./internal/filedrop/...` all 24 PASS (incl. Windows integration), go vet clean, go fmt run. NOT run: `-race` (cgo/gcc unavailable here, "-race requires cgo").
Open: no queue adapter yet for Store (Capture = item insert + file_drop_seen in ONE tx; not in AG-T14's files) — needs a CR/task in internal/queue. Lstat→Open TOCTOU narrowed with SameFile, not closed (ponytail note in code).
