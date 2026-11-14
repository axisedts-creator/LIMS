# T0D-DEP-02 tests (tester)
- apps/web/src/core/session/__tests__/bff-key.test.ts: readBffKey matrix (file / env in dev|ci|staging / production, unset, empty, Staging, prod refused / both set / empty env / empty file / NODE_ENV / no key in errors) + static single-reader scan of apps/web/src.
- apps/web/src/core/session/__tests__/vitest.dep02.config.ts: test-only config.
- Run: `.orchestra\notes\T0D-DEP-02-verify.cmd` (cds to repo root).
- Expected now: FAIL, `../bff-key` missing; static tests also fail (c2.ts and actions.ts still read the file).
- Existing c2 / t12 admin-auth tests untouched; run via C2.T12-verify.cmd.
- Assumption: LIMS_WEB_BFF_KEY="" treated as unset or empty (either message accepted); whitespace-only must give "LIMS_WEB_BFF_KEY is empty".
