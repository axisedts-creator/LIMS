APPROVE

Scope: `git diff 023df200..HEAD` = review-fix round (relay.go, relay_test.go, impl note). Prior round's contract/TLS/budget/log/paths/secrets checks stand (no change to those areas).

1. Previous defect 1 fixed: relay.go:136 re-arms `r.unreachable` on every unreachable result; `reachable()` still clears it on any server answer (03-APP-FLOW §3.4 step 2).
2. Previous defect 2 fixed: relay_test.go:261 retry of itemA now succeeds before itemB; 3-call/key assertions unchanged. relay_test.go:206-226 asserts a failed probe at t0+31 s re-arms the window (t0+45 s → unavailable, no call; t0+62 s → replied).
3. Done_when covered: round trip with server stub (replied path) and offline → no reply (unavailable, nothing enqueued, item pending). AC-10.3 / AC-10.6 OK.

Verified: `go test -count=1 ./internal/hostquery/...` ok (25.6 s); `go vet ./internal/hostquery/...` clean. NOT run: `-race` (no CGO/C compiler on host).
Open (not a defect of this task): Outbound.Enqueue has no real queue.outbound writer yet; Items wiring to *queue.DB.MarkUploaded unverified — track in integration.
