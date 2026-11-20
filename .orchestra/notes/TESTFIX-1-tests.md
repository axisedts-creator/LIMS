# TESTFIX-1 tests (LD-268)
- Run: `.orchestra\notes\TESTFIX-1-verify.cmd` (api: route-guard, static.security, platform-ddl-1.static; web: rs-c2.static).
- Edited test files only: `services/api/src/modules/identity/__tests__/role-packs/route-guard.test.ts`, `.../platform-ddl-1.static.test.ts` (title), `apps/web/src/features/admin/__tests__/rs-c2.baseline.json`.
- All three were STALE (no real defect, no CR); evidence and the list of other red tests: `.orchestra/notes/TESTFIX-1.md`.
- Before: 2 api + 2 web tests red. After: api 221 pass, web 14 pass.
