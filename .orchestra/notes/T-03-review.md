APPROVE
Round 2. Prior finding #1 is fixed. catalogState.repo.ts:14-21 `incrementRevision(tx, tenantId)` now runs the exact 03-APP-FLOW F-19 SQL `… WHERE tenant_id = $1 RETURNING catalog_revision, catalog_root_id` bound to `[tenantId]`. Both call sites in revision.service.ts:21 and :24 pass `ctx.tenantId`. New test "catalog_state UPDATE is scoped by tenant_id explicitly" checks the WHERE clause and that values[0] equals the tx tenant.

Round 1 checks still hold, since this diff touches nothing else: the event name, aggregate, idempotency key `<tenant>:catalog:<rev>` and the 5-key payload match 02-TRD §9.1 and 03-IC §3.19. The publish runs in the caller's tx, so a rollback drops the event. Lazy create still uses ON CONFLICT DO NOTHING with a uuidv7 root. All SQL is bind-only. No logs, no PHI, no secrets. All edits are in owned paths.

Ran by reviewer: `pnpm --filter @lims/api exec vitest run src/modules/catalog/__tests__/integration` gives 56/56 passed (1 file).
Known deferred items, not defects for T-03: stamping covers only test and panel, and analyte/range/TAT owners come in T-06+. The HTTP half of AC-01.1 is T-04. The concurrency test runs on the in-memory fake, not on real Postgres (db/tests).
