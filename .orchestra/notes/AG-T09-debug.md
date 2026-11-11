# AG-T09 debug
- Cause: `.orchestra/notes/AG-T09-verify.cmd` runs `go test -race`; no cgo/C compiler on this host, so Go aborts ("-race requires cgo") before any test runs. Not an implementation bug.
- Fix: no implementation change needed. `go test -count=1 ./internal/drivers/...` ok and `go vet` clean (run just now). The tester's note (AG-T09-tests.md:6) already says to drop `-race` when no C compiler is present.
- Needed from orchestrator: re-run verify without `-race` (or with CGO_ENABLED=1 and gcc). I did not edit the verify script (not implementation code).
- Not verified: race-detector run.
- Round 2 recheck: verify.log still only "go: -race requires cgo"; `go test -count=1 ./internal/drivers/...` ok. No impl change. Orchestrator: drop `-race` in AG-T09-verify.cmd or install gcc + CGO_ENABLED=1.
- Round 3 recheck: verify.log unchanged ("go: -race requires cgo"); `go test -count=1 ./internal/drivers/...` ok, `go vet` clean. No impl change. Blocker is environment, not code.
