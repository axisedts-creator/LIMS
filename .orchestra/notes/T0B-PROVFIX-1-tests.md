# T0B-PROVFIX-1 tests (tester, revised per ruling LD-295)
- services/api/src/modules/identity/service/__tests__/tenant.service.test.ts: removed "seedIrdAnnexes FIRST in scope" and "annex failure propagates" tests; dropped seedIrdAnnexes from the inside-scope list and the annex_2/3/7 expectations; added "provisionTenant does not call seedIrdAnnexes (LD-295)" (0 calls, annexes []).
- Kept: scope-order test (only findByCode + core.tenants insert outside the scope); tenant.helpers.ts fake scope check (sc) unchanged.
- Run: .orchestra/notes/T0B-PROVFIX-1-verify.cmd (tenant.service + tenant.handlers tests, via the services/api package).
- Now: 1 fails (the new LD-295 test: seedIrdAnnexes called once); 175 pass. Goes green once provisionTenant stops calling it.
- Not covered (no database in the lane): the real RLS/trigger path; static review + CRs belong to the writer.
