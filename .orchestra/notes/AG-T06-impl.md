# AG-T06 impl (writer)
- Changed: apps/bridge-agent/internal/astm/link.go only (Sender, SenderConfig, SendState, SendResult appended; names per tests header).
- Result (after ruling + revised tests, no link.go change): `go vet` clean; AG-T06-verify run 25/25 PASS; full `go test ./internal/astm/` ok.
- [CONV] defaults 15/10/20/15/15/60 s, 6 sends, 6 ENQ attempts, 3 cycles; every one configurable (0 = default).
- [CONV] ENQ attempts exhausted ends the cycle at the next Tick (no bytes); timeout/6th NAK sends EOT and ends the cycle; cycles >= max -> ResultFailed.
- [CONV] receiver-interrupt EOT does not count as a cycle; defer_until = now(yield) + 20 s per 03-APP-FLOW §3.2.
- Open: stray bytes in Establishing/NakWait ignored; gofmt -l still not run (approval denied in this session).
