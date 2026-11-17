# AG-T01 impl
- Files: apps/bridge-agent/{go.mod, go.sum, cmd/agent/main.go, build/ci.sh, build/ci-windows.ps1, .gitignore, .gitattributes}.
- Per ruling: go.mod = `go 1.26.0` + `toolchain go1.26.10` (survives `go mod tidy`); CI picks go1.26.10 via the toolchain line (GOTOOLCHAIN auto).
- [CONV] Module path `lims/apps/bridge-agent` is a placeholder until C0 sets the repo-host path (02-CV §1 Go module row).
- [CONV] apps/bridge-agent/.gitignore re-includes `build/`; `out/` is the ci.sh build output dir. .gitattributes forces LF for *.sh/*.go.
- Only cmd/agent stubbed (blank-imports modernc.org/sqlite); cmd/launcher, cmd/simulator come with their tasks.
- Tests: 22/22 pass (Go 1.26.10 local). windows/amd64 CGO-free build + sqlite v1.61.1 in build info proven.
- Open: staticcheck and c7-go-windows job not run locally.
