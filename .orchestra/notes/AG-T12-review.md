APPROVE

Re-review after 19a43417 + 4a3597c6. Both prior defects fixed:
1. client.go `post` takes `idemKey`; SubmitLogBundle sends `Idempotency-Key: <command_id>` (E07 required, 02-TRD §7.2 / 02-CONVENTIONS §4.5) and refuses empty command_id; Heartbeat (E03 optional) sends none. command_id non-empty also enforced in service.go:79.
2. client_test.go:280 asserts `Idempotency-Key == cmdA` on the E07 contract test.

Earlier checks stand (names verbatim, no PHI/secrets, limits, once-per-command_id, TLS, owned paths only, RLS/permissions N/A agent side). `go test -count=1 ./internal/heartbeat/...` ok; `go vet` clean. gofmt not run this round (permission prompt).
