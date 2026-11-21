# T0D-UIGUARD-1 dispute (writer)

Verdict asked: TESTS_WRONG (in part) or a lead ruling on scope. Writer stopped; no source file changed.

## Fact (ran `vitest -c src/core/__tests__/vitest.uiguard1.config.ts` after build:nav, 2026-11-20 14:28)
8 red: R1 5 pages, R2 65 pages, R3 21, R4 7, R5 12, R6 9, plus the 2 notes files.
Distinct files to change to turn the six rules green, not counting the notes: about 65
(R1 5 pages, R2 ~35 components, R3 catalog.css, R4 7 pages, R5 13 components, R6 5 components).
The brief caps the task at **12 files in all**. The rules cannot go green inside the brief.

## Why the tests are wrong, not only big
1. `uiguard1.guard.test.ts:73` REAL list accepts only pinned / registration entry form / QueueBoard / print stationery / label sheet / catch-all.
   The brief says: a file listed by a not-done T0D task (T0D-PRICETOOLS-1, T0D-TESTMGMT-1, T0D-SALES-1, T0D-PARTYSET-1, T0D-FINCTRL-1,
   T0D-MISREPORTS-1, T0D-OFFLINE-*, ...) is **left alone and listed in the notes**. Offenders in that class (per the brief's list, task state not re-checked):
   partners/PartysetCommon.tsx (R2, 16 pages), catalog/PriceCompare, PriceListDetail, PriceVersionEditor (R2), catalog/TestMgmtViews (R2),
   billing/discounts/DiscountSlabsScreen (R2), /offline (R1, R4). The writer can neither fix them nor excuse them: the test forbids the only path the brief allows.
2. `/admin/*` pages in app/(staff)/admin (access-log, audit, sessions, users) fail R2. They are the pinned admin pages; the tester excused them for R1 only.
   An R2 entry with reason "pinned" would pass the REAL regex but the admin exception is tester-owned (`core/__tests__/uiguard1.exceptions.ts`).

## Asks (pick one)
A. Lead rules a dated legacy baseline: tester adds `{route, rule, reason: 'legacy baseline LD-xxx, fix in T0D-...'}` entries and extends REAL with that LD;
   writer then fixes the files within 12 (catalog.css R3, the 5 R6 chart files, the 7 R4 pages) and writes both notes.
B. Tester extends REAL with "owned by T0D-<id>" and adds /admin/* rule 2; lead splits the remaining ~50 files into follow-up tasks (by feature: catalog, billing, lab, smartreport, engagement).
C. Lead lifts the 12-file cap (about 70 files, many shared components; several touch screens of other open tasks).
