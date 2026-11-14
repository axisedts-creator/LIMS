# AN-T20 dispute (writer, 2026-11-11) — an-t20.schedules.test.tsx:433-437 (REQ-SEC-088)

Run: notes/AN-T20-verify.cmd → 136/137 pass; only failure: `Unable to find role="option"` at line 437.

Why the test is wrong (not the impl):
- Line 433 gives the hostile display name to `membership_id: OWNER_M` — the only recipient in filter-options.
- Per the arbiter ruling + LD-89 the harness session now carries the creator's membershipId = OWNER_M, and line 182 requires the creator to be pre-selected as a recipient chip.
- So OWNER_M is already chosen; the picker (ScheduleEditor.tsx:87,149) offers only not-yet-chosen people (choosing someone twice is meaningless). With OWNER_M as the sole recipient, no option can exist — the explicit pick that LD-89 asked for can never succeed.
- Lines 182 and 437 cannot both pass while the hostile recipient is the creator.

Proposed fix (tester only): line 433 use a non-creator recipient, e.g.
`recipients: [{ membership_id: OWNER_M, display_name: 'Owner' }, { membership_id: MEMBER_2, display_name: H }]`
— then typing '<img' and clicking the option exercises REQ-SEC-088 without relying on the creator chip, as LD-89 intends.

LD-89 web-side code (types.ts, store.ts, c2.ts) is already in place. No impl change made.
