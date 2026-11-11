TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/chunks/C7-instrument-integration/03-APP-FLOW.md:154: on rx ENQ (contention) "set defer_until = now + 20 s" — clock starts at the instrument's ENQ (the yield), not at the agent's own ENQ.
- spec/chunks/C7-instrument-integration/01-PRD.md:150 (AC-06.3): agent "does not re-send ENQ for 20 s or until the instrument's message completes".
- spec/chunks/C7-instrument-integration/02-TRD.md:236: `host_contention_defer_s` = 20, "until this time passes or the instrument's message completes".
- Test link_send_test.go:401-415 yields at t=2 s (defer_until = t=22 s), then expects ENQ at t=21 s (19 s after the yield) — inside the defer window, which the spec forbids.
- Comment at line 409 is also wrong: after adv(17s) it is 17 s after the yield, not 19 s.

Change in test `TestSend_ContentionYieldsAckAndDefers20s`:
- line 409: comment -> `// 17 s after the yield (t=19); also past the 15 s establish timer`
- line 411: `r.adv(2 * time.Second) // 21 s` -> `r.adv(4 * time.Second) // 21 s after the yield (t=23)`
Implementation (defer measured from contention ENQ) is correct; no link.go change.
