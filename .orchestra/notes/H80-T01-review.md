APPROVE

H80-T01 review (diff 699f2bff..HEAD), against 08-ADDENDUM-TRUTH-H80E §5-§7, §10 CR-C7-016, LD-139.

- Names verbatim: profile `truth_h80e` matches §7 exactly (hl7v2, HL7AckMode original, HostQueryMessageTypes [QRY^Q02], ExpectAckOnReply true, ReplyAckPolicy last, ReplyAckMatchControlId false, ReplyTimeout 10s). Policy values each|last|none as in §7/§10.
- Defaults keep today's behaviour: new SessionProfile/mllp.Config fields zero-valued; host-query path only active when Config.HostQuery != nil; "" = each.
- `last`: QCK written, DSR written immediately, one ACK wait after the final reply (mllp/session.go waitsAfter/answerHostQuery). ACK^Q03 MSA-2 not required to match by default (§6).
- AC-10.6 / D-H80-1: nil/empty HostQuery reply writes nothing; covered by h80e-api-down session and mllp tests. Query committed before answering (D-02); commit failure gives silence.
- U values (timeout, QCK-ACK, MSA-2 form) are profile defaults + Config fields, not hard-coded in the session logic.
- Tenant/RLS, permissions, rate tier, error codes: not applicable (agent-only Go change). No logging added, no PHI, no secrets. Synthetic data only.
- Paths: drivers/, mllp/, simulator/, testdata/sessions/ — all under apps/bridge-agent (C7-owned, 01-CHUNK-MAP §3).
- Tests: the 6 required simulator sessions exist and run; reran `go test -count=1 ./internal/drivers/ ./internal/mllp/ ./internal/simulator/` = ok ×3; `go vet` on those packages clean.

Notes (not blocking):
- gofmt -l not run (needs approval in this session); writer also could not run it. Run before merge.
- With policy `last` an NF answer (QCK only) waits up to ReplyTimeout for an ACK of the QCK; messages that arrive meanwhile are held and processed, so nothing is lost. Whether the analyser ACKs the QCK is U (§9 item 5).
- The registry.go comment says "overridable per instrument", but nothing wires per-instrument overrides or profile->mllp.Config in production yet (writer's open item, H80-T05).
