# T0B-PROVFIX-1 tests (tester)
- services/api/src/modules/identity/service/__tests__/tenant.helpers.ts: fake seedIrdAnnexes now requires the withTenantScope(new tenant) window (like the audit_log RLS); it threw the opposite before.
- services/api/src/modules/identity/service/__tests__/tenant.service.test.ts: old "outside the scope" test replaced by (a) seedIrdAnnexes is the FIRST statement inside the scope, (b) every repo call's recorded scope: only findByCode + core.tenants insert outside, (c) annex failure propagates.
- Run: .orchestra/notes/T0B-PROVFIX-1-verify.cmd (tenant.service + tenant.handlers tests, via the services/api package).
- Now: 18 fail with "fake RLS: seedIrdAnnexes ... outside withTenantScope (scope=null)" (tenant.service.ts:451); handlers test passes. All go green once the call moves into the scoped block.
- Not covered (no database in the lane): the real RLS/trigger path; static review + CRs (items 3, 4) belong to the writer.
