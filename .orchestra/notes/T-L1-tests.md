# T-L1 tests (tester)
- API: `services/api/src/modules/engagement/service/__tests__/link.handlers.test.ts` (41 tests: L1-L4, 32-byte Buffer HMACs, no-hex, access log, metric, limits, tenant B / patient-actor probes; real FrontdeskPort fake + FakeDb).
- Web: `apps/web/src/features/engagement/__tests__/t-l1.app-access.test.tsx` (W8 + code shown once + slip without name), `t-l1.source.test.ts` (routes, kit/LD-140, security, API file rules), `vitest.t-l1.config.ts`.
- Run: `.orchestra/notes/T-L1-verify.cmd` (api via `pnpm --dir services/api exec vitest run ...`, web via the t-l1 config).
- Now: API 38 fail (`common.service_unavailable` placeholder), 3 contract pass; web 31 fail (AppAccess.tsx / route / link.service files missing), 3 pass.
- ASSUMED (arbiter may refine): `link_codes` has no version, so L2 If-Match is the constant `"1"`; metric `lims_engagement_link_events_total{method:'link_code',outcome:'issued'|'revoked'}` = volume metric; audit outcome value not asserted.
- ASSUMED UI props: `AppAccess({patient,links,codes,recordPhoneMasked,consent,labName,actions})`, `CodeSlip({code,expiresAt,boundPhoneMasked,labName})`, slip `data-testid="code-slip"`; documented in test header.
- Not covered: DEFINER redeem (bytea = bytea) and failure counters = T-L2; 50/day alert query job; real RLS.
