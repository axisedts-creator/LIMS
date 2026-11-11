# AG-T06 dispute (writer)
Test `TestSend_ContentionYieldsAckAndDefers20s` (link_send_test.go:401-415) is wrong; all other AG-T05/AG-T06 tests pass.
- Spec: 03-APP-FLOW §3.2 line 154: "defer_until = now + 20 s" (now = moment of the contention ENQ). AC-06.3: "does not re-send ENQ for 20 s".
- Test: ENQ at t=0, `adv(2s)`, yield at t=2 (defer_until = t=22), `adv(17s)` -> t=19 (nil, ok), `adv(2s)` -> t=21, expects ENQ. t=21 < 22, so spec says nil. Comment "19 s after the yield" is wrong: it is 17 s, then 19 s.
- Failure: `link_send_test.go:412: defer over -> ENQ again: Tick = "", want "\x05"`.
- Fix (tests): `r.adv(4 * time.Second) // 21 s after the yield` (17+4 = 21 s > 20 s). Alternative reading (defer measured from our ENQ) contradicts "now + 20 s"; the config subtest `host_contention_defer_s` yields at t=0 so it cannot tell.
Stopped per rules; implementation in link.go is otherwise done.
