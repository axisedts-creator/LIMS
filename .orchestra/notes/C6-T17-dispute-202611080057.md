# C6-T17 dispute (writer) — 2 test bugs, implementation otherwise complete
Run: 165/169 narrative.handlers pass; narrative.static cannot load. Neither failure is fixable in the implementation.

1. `narrative.static.test.ts:51` — `/new JSDOM(/` is an invalid regex ("Unterminated group"); the whole file fails to load (0 tests run). Line 52 has the correct `/new JSDOM\(/`. Fix: escape the paren on line 51.
   Evidence: a scratch copy with only that escape fixed passes 10/10 against the implementation (copy deleted).

2. `narrative.handlers.test.ts` — helpers use a default parameter `v: unknown = 1` (`save`, `sign`, `amend`, `patch` at lines 34-36, 119) and the tests pass `undefined` to mean "no If-Match". A default parameter replaces `undefined`, so `If-Match: "1"` is sent and the call succeeds. Failing assertions (all "expected rejection, got success"):
   - :130 N10 `patch(..., TPL_TEST, undefined)`; :243 N3 `save(t, ..., NARR_1, undefined)`; :373 N4 `sign(t, NARR_1, undefined)`; :455 N5 `amend(..., NARR_SIGNED, undefined)`.
   Fix: drop the default (`v: unknown`) and pass `1`/`3` explicitly where the cases rely on it, or use a sentinel (`v: unknown = 'default'`).
   Evidence: scratch test sending no header / stale / malformed If-Match to N3, N4, N5, N10 gets 428 / 409 / 400 as the cases intend (4/4 pass; file deleted).
