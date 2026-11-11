APPROVE

Reviewed `git diff c45e53c0..HEAD` (AG-T03) against 02-TRD §5.2.1–5.2.3, §5.2.6, §5.2.7, §5.3 and PRD AC-05.3 / AC-05.5.

- Control chars, frame format (STX FN text ETB|ETX C1C2 CR LF, text ≤ 240, frame ≤ 247), checksum rule (FN ASCII + text + terminator mod 256, uppercase send / case-insensitive receive), FN mod 8, accept / retransmit / NAK rule: match TRD verbatim.
- Sending: one record per frame start, > 240 split ETB…ETX: matches §5.2.2 DECISION.
- Tokeniser: split on CR, LF tolerated, types HPORCQSML, delimiters from H positions 2–5, fail closed without H: matches §5.3. Classifier R → data, Q-without-R → host_query, else other: matches.
- §5.2.6 vectors (all 6 checksums + assembled sha256) live in `apps/bridge-agent/__tests__/astm-vectors.json`, read by `checksum_test.go`; plain JSON, so TS can use it (done_when met).
- Tests cover AC-05.3 (bad checksum, wrong FN, missing CR LF, > 247 → Reject) and AC-05.5 (Assemble + sha256).
- Ran: `go vet ./...` clean; `go test -count=1 ./...` → `ok lims/apps/bridge-agent/internal/astm`.
- N/A for this pure-library task: RLS, permissions, idempotency, rate tier, error codes. No logging, no PHI, no secrets. Paths are only `apps/bridge-agent/**` (C7) and `.orchestra/notes`.
- Non-blocking: go.mod/go.sum change comes from `go mod tidy` (the redundant `toolchain` line was dropped, test-only sums were added). The `.orchestra/cr/T0D-09` → `.resolved-*` rename in this range is orchestrator housekeeping, not part of AG-T03.
