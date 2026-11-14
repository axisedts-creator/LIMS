# MET-T07 tests (tester)
File: `services/api/src/modules/instruments/__tests__/regression/met-t07.getein_metis.regression.test.ts` (11 tests; drivers seeded from the REAL db/migrations g_drivers rows via `readRows`): truth_h80e + getein_metis both `generic`, none `verified`; E22/E23/E25 show `driver_status: generic` for both; E27 commissioning allowed, E28 go-live refused `instruments.driver_not_available`; static guard: no skip/only/fails/xit, no new todo placeholders beyond hostQuery.getein_metis.test.ts.
Run: `.orchestra\notes\MET-T07-verify.cmd` = the WHOLE C7 suite (`pnpm --dir services/api exec vitest run src/modules/instruments/__tests__`, ~350 s; e2e files need go + openssl).
Now: 62 files, 2082 pass, 4 todo (known, MET-T03), 0 fail. These are regression guards, so they pass now (T01-T06 are done); no existing test was edited.
Not verified: web host-query toggle (apps/web, H80-T06/MET-T05 own it, not in this verify); pgTAP (no Postgres here).
