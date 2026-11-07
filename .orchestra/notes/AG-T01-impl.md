# AG-T01 impl
- Files: apps/bridge-agent/{go.mod, go.sum, cmd/agent/main.go, build/ci.sh, build/ci-windows.ps1, .gitignore, .gitattributes}.
- [CONV] go/toolchain pinned to go1.26.10 (latest 1.26 patch on go.dev/dl, 2026-11-07). Module path `lims/apps/bridge-agent` is a placeholder until C0 sets the repo-host path (02-CV §1 Go module row).
- [CONV] go.sum built from sum.golang.org lookups for modernc.org/sqlite v1.61.1 + its go.mod requirement set (no local Go); run `go mod tidy` once with the pinned toolchain and commit any diff.
- [CONV] apps/bridge-agent/.gitignore re-includes `build/` (root .gitignore ignores it); `out/` is the ci.sh build output dir. .gitattributes forces LF for *.sh/*.go.
- Only cmd/agent stubbed (blank-imports modernc.org/sqlite); cmd/launcher, cmd/simulator come with their tasks.
- Tests: 20/22 pass. OPEN: 2 build tests fail "go not found on PATH" - Go not installed here (zip extraction needed approval). done_when (windows/amd64 CGO-free build) NOT yet proven.
- release-tag-check uses `go version -m` (needs Go on PATH, which CI has).
