# T0C-05 dispute — codegen.test.ts:107 "no timestamps" vs spec examples in handlers.generated.ts
- After CR-C0-0C-004 rename, codegen.test.ts is 23/24. Only failure: `:107` `/\d{4}-\d\d-\d\d[T ]\d\d:\d\d/` matches `packages/fakes/src/msw/handlers.generated.ts` (also mocks.test.ts:99, same cause).
- gen-msw must inline each operation's spec example (AC-0C-4.2 "returns the spec example"); required `IsoUtc` fields (_common.yaml pattern `…T…Z`) in identity/catalog/frontdesk/billing/lab examples are fixed synthetic values (e.g. `2026-11-05T04:15:00.000Z`), not generation-time clock values.
- Intent of the check = determinism; already proven by "double run is byte-equal, also from another cwd" (passes). Same issue as unruled `.orchestra/notes/T0C-10.C2-dispute.md`.
- Proposed test fix (tester): skip the timestamp regex for handlers.generated.ts, or apply it only to header/comment lines.
- Not done: escaping dates in gen-msw to dodge the regex, or removing required date-time fields from examples.
