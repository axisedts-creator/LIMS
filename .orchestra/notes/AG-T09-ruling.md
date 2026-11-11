TESTS_WRONG — registry_test.go:140 uses `a != X || a != Y`, which `go vet` (run by `go test`) rejects as "suspect or", so the package never builds.
Reasons:
- spec/chunks/C7-instrument-integration/02-TRD.md:316 says only that an unknown `driver_code` uses the generic profile for its protocol and reports `driver_profile_unknown` in the heartbeat. The implementation does this: `go test -vet=off` passes.
- Reproduced: `go vet ./internal/drivers/` -> "internal\drivers\registry_test.go:140:6: suspect or: r.HeartbeatError != "driver_profile_unknown" || r.HeartbeatError != ProfileUnknownCode".
- What the test means is right: HeartbeatError must equal the spec literal, and the constant (profile.go:8) must equal it too. Only the way the check is written is broken.
Change in test (line 140): split it into two checks:
  `if r.HeartbeatError != "driver_profile_unknown" { t.Errorf(...) }`
  `if ProfileUnknownCode != "driver_profile_unknown" { t.Errorf("ProfileUnknownCode = %q", ProfileUnknownCode) }`
Do not change any other assertion. No implementation change needed.
