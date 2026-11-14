APPROVE

Scope: `git diff 5b8056f..HEAD` (go.mod, go.sum, ag-t01.test.mjs, notes).
- Test change at ag-t01.test.mjs:41-55 matches AG-T01-ruling.md exactly: both regexes and asserts kept, minor >= 26 on go and toolchain, toolchain >= go (minor, then patch). Renamed as the ruling says.
- go.mod: `go 1.26.0` + `toolchain go1.26.10` (02-TRD:28, 04 S16, 02-CV:44/259). `modernc.org/sqlite v1.61.1` pinned. Dropping indirect `modernc.org/fileutil` is the `go mod tidy` result; the build passes.
- CI: pr.yml setup-go uses `go-version-file: apps/bridge-agent/go.mod` (single pin), and GOTOOLCHAIN auto picks go1.26.10.
- ci.sh: build is `GOOS=windows GOARCH=amd64 CGO_ENABLED=0`. tls-gate excludes `_test.go`.
- No secrets, no PHI, no invented names. Only owned paths plus notes. RLS, permissions and error codes are not in scope (build skeleton).
- Verified: `node --test apps/bridge-agent/__tests__/ag-t01.test.mjs` gives 22/22 pass (includes the windows/amd64 CGO-free build).
- Not verified: staticcheck, the c7-go-windows job (needs a Windows runner with internal/* packages, which later tasks add).
