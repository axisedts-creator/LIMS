# AG-T14 debug
Cause: environmental, not code. verify.cmd runs `go test -race`; this host has no gcc, CGO_ENABLED=0 -> "go: -race requires cgo; enable cgo by setting CGO_ENABLED=1".
Fix: none in impl (no defect). Without -race: filedrop tests pass (ok 3.8s), go vet clean. Tests untouched.
Needs human/orchestrator: install gcc (e.g. mingw-w64 via choco) + CGO_ENABLED=1, or drop -race from verify.cmd. Race detector itself is unverified. Same issue hits AG-T13 verify.cmd.
