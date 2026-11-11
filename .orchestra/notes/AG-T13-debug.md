AG-T13 debug: verify failure is environmental, not a code defect. Log: "go: -race requires cgo; enable cgo by setting CGO_ENABLED=1". Host has CGO_ENABLED=0 and no gcc/cc.
No implementation change made. Without -race: `go test -count=1 ./internal/hostquery/...` ok (7.7s), go vet clean.
Needs: a C compiler (e.g. mingw-w64 gcc) on the verify host + CGO_ENABLED=1, or the verifier drops -race. Tests not touched.

Round 2: same log, same cause. Re-checked: still no gcc, CGO_ENABLED=0. `go test -count=1 ./internal/hostquery/...` ok (7.4s). No code change; nothing to fix in implementation.
