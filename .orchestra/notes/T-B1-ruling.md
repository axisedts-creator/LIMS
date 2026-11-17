TESTS_WRONG — bookable.handlers.test.ts:142 sends a 43-char `query`, which the contract rejects; shorten it to <= 40 chars.
Reasons:
- contracts/openapi/engagement.yaml:4575-4580 (listBookableItems, TRD §5 S12): `query` schema is `type: string, maxLength: 40`. Any 41+ char value must give 400 `common.validation_failed` (engagement.yaml:4564).
- The same test file, line 155, asserts exactly that (`'a'.repeat(41)` -> `common.validation_failed`). That assertion is correct.
- Line 142's `evil = "x'; DROP TABLE engagement.bookable_items;--"` is 43 chars. So it is rejected at validation and never reaches the bound-parameter search path the test is meant to check. Expecting 200 `data: []` contradicts the contract and line 155.
- spec/chunks/C16-patient-engagement/02-TRD.md:490 (S12) gives no length for `query`. The sibling E30 at 02-TRD.md:454 uses `query?` (≤40), which agrees with the contract. Nothing in the spec requires a longer query to be accepted.
Change to test (tester): at line 142, replace `evil` with an injection string of <= 40 chars, e.g. `"x'; DROP TABLE bookable_items;--"` (32 chars). Keep the `toEqual([])` expectation and the line-143 `not.toContain('DROP TABLE')` SQL-text check unchanged.
Implementation: no change. Returning 400 for a query longer than 40 chars is correct.
