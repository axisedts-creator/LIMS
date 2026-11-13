# AG-T09 impl (writer)
- Files: `apps/bridge-agent/internal/drivers/profile.go` (SessionProfile, ASTMTimers, Resolution, ProfileUnknownCode, clone), `registry.go` (5 profiles, Resolve, Codes).
- Tests (after ruling fix to registry_test.go:140): `go test -count=1 ./internal/drivers/...` ok; `go vet` clean. `-race` not run (no cgo/C compiler here).
- [CONV] Resolve returns deep copies; registry never mutated.
- [CONV] Registered code with mismatching protocol -> treated unknown, generic fallback of the instrument's protocol, reported.
- Open: Mindray sketches ExpectAckOnReply=false, ReplyTimeout=0 (UNVERIFIED per model in TRD); ASTM timers have no protocol_options override logic yet.
