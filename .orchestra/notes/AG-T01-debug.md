# AG-T01 debug
- Cause: 2 failing tests (`go toolchain is available`, `GOOS=windows ... go build`) fail with "go not found on PATH". Environment gap, not an implementation bug: 20/22 pass, and go.mod/ci.sh/main.go all satisfy their contract tests.
- Fix: none in code. Go 1.26.10 (the pin in go.mod) must be installed and put on PATH, then run `go mod tidy` once and commit any go.sum diff.
- Not proven: windows/amd64 CGO_ENABLED=0 build, and the sqlite v1.61.1 link. I couldn't verify these: running `where.exe go` and reading C:\Program Files needed approval, and none was available.
- Tests untouched.
- Round 2: re-checked. `go version` -> "go: command not found"; C:\Program Files\Go read denied. Same env gap, no code cause. Needs Go 1.26.10 on PATH, then rerun verify.
- Round 3: `go version` still "command not found". Same cause, no code change. Tests untouched. Blocked on human installing Go 1.26.10.
