APPROVE

Re-review of `git diff d5575c4e..HEAD`, focused on fix commits 6f9397f5 + d5ef8d9f against prior CHANGES item 1.
- Item 1 fixed: `ReasonConnectionClosed` / `connection_closed` removed from codec.go, session.go and tests (grep: no remaining hits except the test function name). Mid-block close now emits `incomplete` with `Reason == ""`; tests codec_test.go:162 and session_test.go:408 assert it. Only E04-enum reasons remain (`new_start_block`, `msh_unparseable`).
- Ran: `go test -count=1 ./internal/mllp/... ./internal/hl7/...` → both ok; `go vet` on same → clean.
- Not run: `gofmt -l` (blocked in this session) — run before merge.
- All other points from the first review (framing, oversize, ACK text/codes, D-02 ordering, MSH-unparseable, no PHI/secrets, owned paths, done_when coverage) unchanged by the fix diff.
