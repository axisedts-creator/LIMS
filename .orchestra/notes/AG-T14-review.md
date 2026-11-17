APPROVE
Round 2 (range 2df504cf..HEAD = 17ddf4f6, e3e9639a, db73c43e). Round-1 items 1-3 fixed: FilenamePattern compiled as RE2 (<=200, case-sensitive) and tested with anchors; AllowedTypes modelled, validated against {pdf,png,jpg}, tested (pdf-only ignores png/jpg); CapturedSubdirectory "" defaults to `captured`, validated with ^[A-Za-z0-9_-]{1,60}$, default-move tested, unsafe cases (traversal, abs, UNC, space, unicode, dot, 61 chars) rejected.
Checks run: `go test -count=1 ./internal/filedrop/...` ok; `go vet` clean. Not run: -race (cgo unavailable), gofmt -l (not approved in this session).
Only owned paths touched (apps/bridge-agent/internal/filedrop/*, own notes). No PHI/secrets in logs. RLS/permissions/rate tier N/A (agent-local).
Carry-over (not this task): no internal/queue adapter implements Store.Capture (item + file_drop_seen in ONE tx) — needs CR/task before AC-12.1 "stored encrypted in the queue" holds end to end.
