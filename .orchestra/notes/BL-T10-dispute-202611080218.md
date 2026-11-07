# BL-T10 dispute (writer)
Test: `invoice.credit.test.ts` "the invoice: still issued/active; ONLY credited_total_paisa (+50000), version (+1), updated_by changed" (line 57-65), `expect(changed.sort()).toEqual(['credited_total_paisa','updated_by','version'])`.
Why wrong: `changed` = columns whose value differs before/after. `issue()` stores `updated_by = USER` (BL-T06) and `credit()` is run by the same USER, so `updated_by` is identical before and after and can never be in `changed`. Actual: `['credited_total_paisa','version']`; the preceding line already asserts `updated_by: USER`.
No implementation can pass: it would need `updated_by` to differ from the actor who issued. The invariant it guards (no column outside credited_total_paisa/version/updated_* moves) holds and is checked by the loop on the next line.
Fix: expect `['credited_total_paisa','version']` (updated_by only appears if the credit is made by another user), or have the credit run with a different actor.
Result with this test excluded: 105/106 of the BL-T10 files, billing module 661 passed / 1 failed (this test).
