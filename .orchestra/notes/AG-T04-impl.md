# AG-T04 impl (writer)
- Files: internal/secrets/{token.go,dpapi_windows.go}; internal/queue/{queue.go,sessions.go,items.go,truncate.go,schema.sql,diskfree_windows.go,diskfree_other.go}. No test files touched.
- Result (after ruling, tests 3254c55c): `go test ./internal/queue/... ./internal/secrets/...` = all pass (queue 70.4s, secrets 11.7s), no impl change needed. go vet clean. Review item 1 fixed: queue.go tsFormat spacing; `go fmt` over internal/queue + internal/secrets (incl. *_test.go) run, exit 0, no other file changed.
- [CONV] AAD for items: `items:<id>:0` for payload, `items_meta:<id>:0` for metadata (so the two cannot be swapped); chunks `session_chunks:<session>:<seq>`.
- [CONV] Disk guard = 500 MiB (524288000 B), low when free < min. Pragmas set per connection by DSN, auto_vacuum=INCREMENTAL first; pool = 1 connection.
- [CONV] Truncate runs incremental_vacuum only when rows were deleted; outbound has Truncate only (no API yet, none in tests).
- Open: golang.org/x/sys is still marked `// indirect` in go.mod (now imported directly); `go mod tidy` fixes it. Machine-scope fallback choice and ACLs belong to the caller/installer.
