# T0D-BUILD-3 tests (tester)
- NEW api: services/api/src/modules/identity/__tests__/build3.access-review.test.ts (56 cases: contract, wiring, guard first, tenant, order, caps, smuggling, bounds, audit, injection, append-only, REAL core idempotency hook around the REAL handler).
- NEW web: apps/web/src/features/admin/__tests__/t20.build3-access-review.test.tsx (28 cases; runs with the existing vitest.t20.config.ts via the t20.* name).
- EDITED (the old tests asserted the retired 501 / NotAvailable behaviour, they cannot stay): fix2.access-review-pending.test.ts (the two ops now asserted "not pending"; role pack check kept), t20.audit-sessions.test.tsx (AD-15 LD-301 case removed, a11y kept), webfix1.pages.test.tsx (access review not-available case removed, gate case kept). Snapshots untouched.
- Run: `.orchestra\notes\T0D-BUILD-3-verify.cmd` (api + web). webfix1 has its own config: `pnpm --dir apps/web exec vitest run -c <webfix1 config> webfix1.pages`.
- State now: all behaviour tests FAIL for the right reason (handlers answer 501; page is NotAvailable). Passing today: contract shape, denied page, no-key 400, loading.tsx exists.
- Fake DB models INSERT .. (cols) VALUES (..) [RETURNING] and SELECT .. WHERE tenant_id = $n [ORDER BY reviewed_at DESC] [LIMIT]; INSERT..SELECT is not modelled (throws a clear message). UPDATE/DELETE on the table throws (append-only RLS).
- GAP for writer: no `access_review.*` action exists in db/seeds/003_audit__g_cs_access_actions.sql (P-3). The audit test needs ONE ctx.audit.access({outcome:'allowed', entityId:<review id>}) with an action from that seed; if none fits, stop, write notes/T0D-BUILD-3-left.md + a CR (do not invent a code).
- File budget: tests use 5 of the 12 files (2 new, 3 edited); the writer has 7 for index.ts, the 2 handlers, service, page.tsx, AccessReview component, one more.
- Not testable here: real PG/RLS, real pipeline stage 8a classifier snapshot (writer: run authz classifier tests), browser rendering.
