APPROVE

Round 2 re-review of `2487f35f..HEAD`. The round-1 defect is fixed. `sessions_test.go:75` `leaves()` now uses `strconv.FormatFloat(x, 'f', -1, 64)`, so `items=0` and `wait_ms=10000` match real step values instead of note prose. Workaround notes removed: `filedrop-unstable-file` note reworded; `astm-nak-to-enq-retry-10s` now has a real `{"wait_ms": 10000}` step that covers the repeated NAK retry.
Round-1 checks still hold: names verbatim from 02-TRD §15.3 plus CR-C10-007 micro sessions; no RLS, permission or HTTP surface in this task; no secrets; synthetic data only; paths stay inside C7 `apps/bridge-agent`.
Re-ran `go test -count=1 ./internal/simulator/... ./cmd/simulator/...`: ok (6.4 s, 18.4 s). `go vet` on both packages: clean.
Not blocking: the 3 s wall-clock cap in `TestSessionsRunNeverSleepsForReal` is sensitive to machine load (see AG-T17-debug.md). `within_ms` is still parsed but not enforced (fake clock).
