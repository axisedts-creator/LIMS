APPROVE

Round 2. Prior finding 1 (link.go `endsWithL` ignored "L record ending with ETX", 03-APP-FLOW §3.1 rule 4) fixed exactly as requested in fb40b64c: link.go:305 now also requires `len(last) >= 2` and trailing CR. Only caller is Recover (link.go:279); live receive path unaffected. Regression test `TestRecoverLRecordLookalikeEtbChunkIsIncompleteProcessRestart` added in ff6615d9 (link_recover_test.go:87) and asserts kind `incomplete` + `incomplete_reason = process_restart`.

Round-1 checks still hold (no other code changed since 386a38e7): names verbatim from 02-TRD §E04; persist-before-ACK; NAK on disk low/DB error (AC-05.1); defect/oversize NAK without append (AC-05.3); retransmit ACK no append (AC-05.4); fake clock, 30 s configurable timeout (AC-05.6); subprocess kill-test (AC-05.7). No PHI in logs, no secrets, only owned paths. RLS/permissions/rate tier/error codes: N/A (agent-side SQLite).

Ran: `go test -count=1 ./internal/astm/...` ok (11.5 s); `go vet ./internal/astm/...` clean. Not run: `gofmt -l` (tool approval denied); diff hunks look gofmt-conformant.
