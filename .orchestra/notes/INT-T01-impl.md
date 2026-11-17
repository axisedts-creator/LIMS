# INT-T01 impl (writer) — DONE. Tester fixed test line 81 per ruling (1ee6677e); e2e now 4/4 pass (20 s run), no impl change needed.
Files: `apps/bridge-agent/testdata/e2e/scenario.json` (new fixture: rounds 20, budget 5000, flush 250, ASTM/HL7 templates from the driver goldens); `cmd/agent/e2e_main.go`, `e2e_pipe_windows.go`, `e2e_pipe_other.go` (`-tags e2e` agent: `-config`, `AGENT_E2E_DEVICE_TOKEN`, prints READY); `cmd/agent/main.go` (+`//go:build !e2e`, stub unchanged); `internal/queue/uploadstore.go` (queue-backed `uploader.Store`: Claim/Release/Resolve/RequeueRejected).
- [CONV] e2e build wires real astm.Receiver, mllp.Serve (ACK after durable InsertItem), queue, uploader, verified-TLS client; queue key protector is a no-op (test build only, never shipped).
- [CONV] ASTM pipe: Windows `os.OpenFile(\\.\pipe\x)`, else unix socket; one goroutine reads->Feed->writes (no concurrent I/O on the handle).
Checked: `go vet -tags e2e` + both builds OK; `go test ./internal/queue ./internal/uploader` pass; e2e `beforeAll` passes (READY).
Verified: committed test passes 4 of 4 (p95, raw bytes exact, dedupe, TLS refusal). UploadStore has no unit test of its own (test files are tester-owned) — only the e2e covers it.
Open: `Claim` is not transactional (single uploader owns the queue, `ponytail:` comment in code).
