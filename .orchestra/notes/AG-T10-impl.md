# AG-T10 impl (writer)
- Files: internal/uploader/{batcher,backoff,client,uploader}.go, internal/clock/offset.go. No test files touched.
- [CONV] Failed batch is resent byte-identical under the same Idempotency-Key (body kept, so sent_at_agent is the first attempt's); any change in item ids gets a new key.
- [CONV] Item that alone exceeds 3 MiB is resolved `rejected` with `instruments.message_too_large` (spec code, AC-09.10) so it cannot block the queue head.
- [CONV] Any non-200 other than 401 (incl. 400/413/3xx) = whole-uploader backoff, items stay pending (spec silent on batch-level 4xx). 401 = auth "rejected", no backoff, no attempt burned.
- [CONV] Empty ProxyURL = direct (env proxy ignored). Retry-After clamped to 24 h. SPKI pin = lowercase hex SHA-256, any cert in verified chain. UUIDv7 hand-rolled (google/uuid is only an indirect dep).
- Open: Store adapter over queue.DB, flush cadence (2 s / at 100), attachment-per-request, host-query budget wiring, Prism contract run are not in this change.
- Ran: `go test -count=1 ./internal/uploader/... ./internal/clock/...` pass; go vet clean; go fmt applied. -race unavailable (no cgo).
