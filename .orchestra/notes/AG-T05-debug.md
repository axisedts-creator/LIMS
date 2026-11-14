# AG-T05 debug
- Cause: verify log = Go runtime "fatal error: runtime: cannot allocate memory" at init (host memory pressure) plus "error obtaining buildID for go tool compile". Env flake, not code or test.
- Fix: none needed in link.go. Re-ran `go test -count=1 ./internal/astm/...`: ok (11.0s). Re-run verify.
