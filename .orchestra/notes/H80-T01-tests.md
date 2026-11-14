# H80-T01 tests (tester)
Files: `apps/bridge-agent/internal/drivers/truth_h80e_test.go` (profile), `internal/mllp/replyack_h80e_test.go` (QCK/DSR/ACK^Q03, API down, over net.Pipe), `internal/simulator/h80e_sessions_test.go` (6 sessions: oru-patient, qry-found, qry-not-found, qry-no-order-nf, q03-id-mismatch, api-down).
Edited existing: `drivers/registry_test.go` five -> six profiles (truth_h80e added; the old assertion was the stale part, not weakened).
Run: `.orchestra/notes/H80-T01-verify.cmd` (go test, drivers+mllp+simulator, -run H80E + the two registry tests).
Contract (tester-defined, in the header of replyack_h80e_test.go): SessionProfile.ReplyAckPolicy/ReplyAckMatchControlId; mllp.Config HostQueryTypes/HostQuery(HostQueryFunc)/ExpectAckOnReply/ReplyAckPolicy/ReplyAckMatchControlId/ReplyTimeout; Stats.ReplyAckTimeouts()/ReplyAckMismatches(). Reader.err is sticky, so time the ACK wait with a timer, not a conn deadline.
Writer must create testdata/sessions/h80e-*.session.json + hl7v2 host-query support in the simulator; session text needs digit runs < 10 (synthetic-data test), e.g. MSH-7 `20261105`, patient id `P0000123`.
Not tested here: real API relay wiring (H80-T05 e2e), server driver (T02/T03).
