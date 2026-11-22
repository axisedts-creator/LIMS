# T0D-FIX-6 tests (tester)
Run: `.orchestra\notes\T0D-FIX-6-verify.cmd` (no DB). Every runtime scenario runs twice: Date clock = control (passes now), ISO string clock = fails now with `... is not a function`.
- core/__tests__/clock.test.ts: PINS `core/clock.ts` export `toDate(v: Date|string): Date` (string, Date, invalid string/Date/null/undefined -> LimsError, no echo of the value, pipeline clock stays a string).
- core/__tests__/ctx-clock-limit.static.test.ts: +3 tests: lab/frontdesk/micro offenders = 0; baseline only shrinks vs the 80-site copy and has no lab/frontdesk/micro key; baseline == real count (writer lowers fixtures/ctx-clock-baseline.json).
- lab/service/__tests__/clock.iso.test.ts: collect, bulk dispatch, home-collection in-transit step (specimen.service.ts:578), result entry (critical), approve, sign-off chain, amend, garbage clock.
- frontdesk/__tests__/unit/quote.isoclock.test.ts: F8 quote (priceDraft = F9 pricing) forbidden / other centre / bad input / other tenant / garbage clock. No DB.
- micro/handlers/__tests__/culture.writes.isoclock.test.ts: setupCulture, addCulturePlate, recordCultureObservation, forbidden, tenant B, bad input, garbage clock.
- frontdesk/__tests__/registration/registration.isoclock.test.ts (+ `isoClock` option in registration/helpers.ts): F9 createRegistration, string clock. NEEDS PG17 (tests/frontdesk/FD-T06.pg.sh); NOT in verify.cmd, NOT run by me.
LD-450 result (2026-11-22): fixtures/ctx-clock-baseline.json set to `{}` (only change). verify.cmd: 5 files, 67 tests, all passed.
Not covered: frontdesk changeItems/cancelOrder (DB only), identity, homecollection snapshot, catalog port, anatomic (static scan only), lab critical/qc/ingest/label/exception services (scan only). The scan misses shapes like `(x ?? ctx.now()).toISOString()` (evaluation.service.ts:67) and `evaluatedAt: ctx.now()` (result.service.ts:85 -> formulaInputs.ts:71): found only by the runtime tests; writer: fix them too.
