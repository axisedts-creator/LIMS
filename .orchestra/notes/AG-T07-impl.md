# AG-T07 impl (writer)
- Files: apps/bridge-agent/internal/hl7/{msh,ack}.go; internal/mllp/{codec,session}.go. No test files touched.
- Run: `go test -count=3 ./internal/mllp/... ./internal/hl7/...` ok; `go vet` clean; 10 s FuzzReader + FuzzParseMSH clean. gofmt -l not run (blocked here) — run it.
- [CONV] Enhanced mode = MSH-15 present only; MSH-16-only → original (AA/AR). Unknown ack_mode = auto.
- [CONV] 0x1C 0x1C: first literal, second may still terminate; 0x1C 0x0B: literal 0x1C + new_start_block (diagram ambiguous).
- [CONV] BuildACK strips bytes <0x20, 0x7f and `|` from every instrument-supplied value (framing/segment injection). MSH segment also ends at LF.
- [CONV] Serve returns nil on EOF *and* peer reset/abort (partial already stored as incomplete, Reason "" per review: E04 incomplete_reason has no value for mid-block close; ReasonConnectionClosed removed); only ErrOversize / write / CommitIncomplete errors are returned. Empty partials are not queued. msh_unparseable also bumps Stats.Incomplete.
- Open: -race not runnable (needs CGO); sender/ACK-wait, allowlist, classification left to AG-T08/T09.
