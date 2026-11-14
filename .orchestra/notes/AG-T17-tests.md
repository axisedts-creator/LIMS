# AG-T17 tests (simulator + session suite, AC-21.1)
Files: `apps/bridge-agent/internal/simulator/simulator_test.go` (runner: mnemonics, exact-bytes, queue asserts, fake clock, hostile input),
`.../internal/simulator/sessions_test.go` (`TestSessions` runs every `testdata/sessions/*.session.json`; 19 required names; content/synthetic checks),
`apps/bridge-agent/cmd/simulator/main_test.go` (binary `-sessions <dir>`: exit codes, empty/missing dir fails, no net/InsecureSkipVerify).
Run: `.orchestra\notes\AG-T17-verify.cmd` (= `go -C apps\bridge-agent test -count=1 ./internal/simulator/... ./cmd/simulator/...`); CI: `build/ci.sh sessions`.
Writer contract (API in header of simulator_test.go): pkg `internal/simulator` {Session, ParseBytes, LoadSession, LoadDir, Run(s, scratchDir)}; session files + names in `requiredSessions`.
Fail now because: `internal/simulator` and `cmd/simulator` do not exist, `testdata/sessions` is empty.
NOT covered: host-query/file-drop/outbound step shapes (spec leaves open, writer defines; only name+content+green checked); `ast`/`skipped_invalid` parsing is API-side (TS driver), not Go.
