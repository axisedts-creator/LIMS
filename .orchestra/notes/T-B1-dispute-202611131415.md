# T-B1 dispute (writer) — 1 test is wrong
Test: `service/__tests__/bookable.handlers.test.ts:142`, "is_active filter; query matches code or display name ..." (S12).
`const evil = "x'; DROP TABLE engagement.bookable_items;--"` is 43 chars, but `query` is `maxLength: 40` (contracts/openapi/engagement.yaml listBookableItems) and the SAME file (line 155) requires a 41-char query -> 400 common.validation_failed.
So the handler correctly answers 400 for `evil` and the test expects 200 `data: []`. Both tests cannot pass; the spec supports the 41-char one.
Fix (tester): shorten the injection string to <= 40 chars, e.g. `"x'; DROP TABLE bookable_items;--"` (33), keep the `not.toContain('DROP TABLE')` SQL-text check.
Status: 19/20 api tests pass, 64/64 worker tests (84 in engagement jobs) pass; only this test fails, for this reason.
