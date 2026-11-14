TESTS_WRONG — `tests/uuidv7/T0A-04.uuidv7.test.mjs:47` asserts `ts[0] === 1_700_000_000_000`, which the spec does not require once earlier tests in the same process have advanced the generator's state past that ms.

Reasons:
- spec/chunks/C0-foundation-contracts/02-TRD.md:121 — `rand_a` is a monotonic counter within the ms; "on overflow the timestamp is advanced by 1 ms". So the generator carries `lastMs` state, and after the 10k-id test (01-PRD.md:97, AC-0A-2.1) that state sits several ms past the frozen `now`.
- 01-PRD.md:97 (AC-0A-2.1) — sort order must equal generation order within one process. If the overflow test re-emitted `ts = now`, those ids would sort before ids already issued at `now+k`. That breaks the monotonicity the TRD requires (02-TRD.md:1049 "ordering/monotonicity").
- Nothing in the spec says the first id after a clock that stands still or goes backward must carry the wall-clock ms. The test's assertion depends on the order tests run in, not on the spec.

Required test change (tester):
- Line 43: freeze at a fresh ms that no earlier test uses and that is above any state they can leave behind, e.g. `now: 1_800_000_000_000`. Keep line 47 asserting `ts[0] === now`, using that new value.
- Or replace line 47 with `assert.ok(ts[0] >= 1_700_000_000_000)`. Keep lines 48–49 unchanged either way.
Implementation is not at fault for this assertion. Dart `lib/src/uuidv7.dart` is still required (AC-0A-2.3, 01-PRD.md:99).
