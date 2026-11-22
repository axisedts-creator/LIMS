# T0D-FIX-4 tests (tester)
- New: apps/web/src/features/catalog/__tests__/fix4.tests-default.test.tsx (active-only default, Show retired kit Switch + retired count, Price format/alignment)
- New: apps/web/src/features/lab/__tests__/fix4.board-dates.test.tsx (status board From/To date = kit DatePicker, DD/MM/YYYY, 7-day rule kept)
- Config: apps/web/src/features/lab/__tests__/vitest.fix4.config.ts (also runs cattests1)
- Changed (reason: default is now active only, LD-446): cattests1.tests-page.test.tsx, 6 expectations that assumed the default listed retired HBA1C (lines ~219, 225, 368, 377, 386, 398).
- Run: .orchestra/notes/T0D-FIX-4-verify.cmd  (pnpm --dir apps/web exec vitest run -c src/features/lab/__tests__/vitest.fix4.config.ts)
- Now: 18 fail for the right reasons (no switch, retired listed by default, "NPR 1800.00", native date input), 40 pass.
- Contract left to writer: switch toggles via router.push to any address the page honours (param name free); keeps q/department; count text "N retired"; Price uses billing formatNpr (lakh grouping: 123456789 -> NPR 12,34,567.89).
- Not covered: uix1/uix3/uix6 suites (existing, must stay green); snapshots untouched.
