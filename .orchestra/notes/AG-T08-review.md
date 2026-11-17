APPROVE
# AG-T08 review (transports: serial, TCP client/listener + peer allowlist)
- Ran `go test -count=1 -v ./internal/transport/...`: tcp 21/21 PASS, serial 4 PASS + 2 SKIP ([manual], LIMS_SERIAL_PAIR unset — matches plan row fallback). `go vet` clean.
- TRD §5.8 rules match verbatim (serial port/baud/data/parity/stop sets; tcp_client host RE, port, 1–60 / 1–300; tcp_server IPv4 non-wildcard non-loopback bind, port 1024–65535, 1–8 IPv4 peers, others closed immediately). Backoff 1s doubling capped (03-APP-FLOW §3.3).
- REQ-SEC-114 / 07-SECURITY LAN row: allowlist enforced before any read, flood rejected + counted, one connection per instrument (newest wins, [CONV] noted). No logging, no PHI, no secrets.
- AC-07.1 covered at transport level (bytes verbatim incl. pre-0x0B junk, 1-byte fragmentation, both modes); extract/discard/count is internal/mllp, correctly out of scope.
- Paths: transport/* + go.mod/go.sum (go.bug.st/serial v1.8.0, named in plan row). RLS/permissions/idempotency/rate tier/error codes: N/A (agent-local, no DB/API surface).
- Non-blocking notes: Listen skips loopback check by design (config layer runs ValidateListenConfig — agent wiring must call it); narrow race where Close runs between ln.Accept and `l.cur = c` leaves that conn unclosed by Close (caller still owns it); serial Close-unblocks-Read unverified on hardware.
