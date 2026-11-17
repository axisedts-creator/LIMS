# AG-T01 tests
- File: `apps/bridge-agent/__tests__/ag-t01.test.mjs` (node:test, no deps). Run: `.orchestra\notes\AG-T01-verify.cmd`.
- Covers: go.mod (go >= 1.26, toolchain line >= go line, sqlite v1.61.1 + go.sum), cmd/*/main.go stubs importing modernc.org/sqlite, ci.sh subcommands (build/sessions/tls-gate/release-tag-check), LF-only, ci-windows.ps1, tls-gate behaviour, windows/amd64 CGO-free PE build with sqlite v1.61.1 in build info.
- Contract for impl: `ci.sh` resolves module root from its OWN location (`$(dirname "$0")/..`), not git/cwd; tls-gate scans all non-`_test.go` .go files; release-tag-check exits non-zero with no arg / missing file.
- Needs `go` >= 1.26 on PATH for the build tests. Go is NOT installed on this machine now, so those fail with "go not found".
- Not tested: release-tag-check on a real nonprod binary, staticcheck run (needs Go + staticcheck), c7-go-windows job (Windows runner).
