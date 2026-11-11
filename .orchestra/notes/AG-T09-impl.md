# AG-T09 impl (writer)
- Files: `apps/bridge-agent/internal/drivers/profile.go` (SessionProfile, ASTMTimers, Resolution, ProfileUnknownCode, clone), `registry.go` (5 profiles, Resolve, Codes).
- Tests: `go test -count=1 -vet=off ./internal/drivers/...` ok. Default `go test` fails on go vet in the test file line 140 -> see AG-T09-dispute.md. `-race` not run.
- [CONV] Resolve returns deep copies; registry never mutated.
- [CONV] Registered code with mismatching protocol -> treated unknown, generic fallback of the instrument's protocol, reported.
- Open: Mindray sketches ExpectAckOnReply=false, ReplyTimeout=0 (UNVERIFIED per model in TRD); ASTM timers have no protocol_options override logic yet.
