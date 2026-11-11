# AG-T14 tests (file-drop watcher)
Files: apps/bridge-agent/internal/filedrop/{helpers_test.go, watcher_test.go, windows_integration_test.go (//go:build windows)}.
Run: `go -C apps\bridge-agent test -race -count=1 ./internal/filedrop/...` (or `.orchestra\notes\AG-T14-verify.cmd`).
API contract the writer must implement is documented at the top of helpers_test.go (Config, Store, Options, New, Scan, Run, DefaultPollInterval, MaxFileBytes).
Covers AC-12.1 (5 s stability, size/mtime reset, ext/pattern/15 MB filter), AC-12.2 (barcode group; unmatched still stored, no barcode), AC-12.5 (no delete, dedupe incl. restart, mtime re-drop, move without overwrite), AB14 (bad CapturedSubdirectory, no recursion, symlink/junction/.lnk not followed), Windows lock + case-insensitive ext.
Now: fails with "no non-test Go files" (package filedrop does not exist). Not run green; gofmt/vet not run (no package yet).
Gap: internal/queue has no method for "item insert + file_drop_seen row in ONE tx"; tests use a fake `filedrop.Store`, so the writer/CR must add a queue adapter (not in AG-T14's file list).
