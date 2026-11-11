TESTS_WRONG — admin/duplicates.test.ts:93 `mkPair('2026-11-09T18:29:00Z')` is commented "2026-11-09 23:59" but that instant is 2026-11-10 00:14 Asia/Kathmandu (+05:45); change the stamp to `'2026-11-09T18:14:00Z'` (= 2026-11-09 23:59 local). Assertions at :96 and :99 stay unchanged.
Reasons:
- spec/chunks/C4-frontdesk-billing/02-TRD.md:220 (F26) — `created_on` is an "A.D. date, tenant tz; default today"; the day is cut at tenant-local midnight.
- Kathmandu midnight of 2026-11-10 = 2026-11-09T18:15Z, so 18:29Z falls on local 2026-11-10 and correctly appears in the default (today = 2026-11-10, test :82) list; :96 `not.toContain(previous)` then fails by the spec.
- The test's own edge stamps confirm the offset: :91 18:14Z = 23:59, :92 18:15Z = 00:00, :90 18:30Z = 00:15. With :93 at 18:29Z it is one minute before `justAfterMidnight`, which contradicts its "previous day" role.
- After the fix, :99 (`d9` contains previous, excludes justAfterMidnight) holds by the same predicate.
What the TESTER changes: duplicates.test.ts:93 stamp only.
Implementation unchanged: patients.repo.ts tenant-tz day window matches 02-TRD.md:220.
