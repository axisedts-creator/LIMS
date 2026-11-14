# HC-T20 dispute (writer)

**Test:** `hc-t20.devices.test.tsx` — "409 (already wiped / stale) -> a plain sentence, no raw code, no success toast" (line ~200).

**Claim:** `expect(document.body.textContent).not.toMatch(/wipe (is )?(requested|scheduled)|will be wiped/i)` can never pass together with the table test.

**Why:** the same file's "status shows tone, icon and word" test requires the status word `Wipe requested` (device D3, `wipe_requested`) to be rendered in the table, and `DEVICES` (which includes D3) is what every `view()` renders. `document.body.textContent` therefore always contains "Wipe requested", which the 409 regex matches (case-insensitive), whether or not any toast was shown.

**Suggested fix (tester):** render only `[D1]` in that test, or scope the assertion to the toast region / dialog instead of `document.body`.

**Writer state:** all other HC-T20 tests are addressed; this one is not changed by me.
