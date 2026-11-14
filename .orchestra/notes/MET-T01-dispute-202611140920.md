# MET-T01 dispute (writer) — one H80E test contradicts the binding spec

Test: `apps/bridge-agent/internal/drivers/truth_h80e_test.go` `TestH80E_OtherProfilesKeepTodaysBehaviour` (lines 77-95), a test I may not edit.
Fails with: `getein_metis: ReplyAckPolicy = "last", want "" or each` and `getein_metis: ExpectAckOnReply changed from today's false`.
Why it is wrong for this task: it asserts every profile except `truth_h80e` has `ExpectAckOnReply=false` and `ReplyAckPolicy` ""/each. 09-ADDENDUM-GETEIN-METIS §7 (binding, LD-163) registers `getein_metis` with `ExpectAckOnReply: true, ReplyAckPolicy: "last"`, and `drivers/getein_metis_test.go` pins exactly that. Both cannot pass. It is the same assertion the tester predicted in `MET-T01-tests.md` (BLOCKER).
Smallest fix (lead to allow, a test-file change outside my role): in the loop at line 78, `if code == "truth_h80e" || code == "getein_metis" { continue }`.
Everything else is green; the profile in registry.go is as §7 says. No other test fails.
