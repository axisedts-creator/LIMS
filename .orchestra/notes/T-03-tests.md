## C3-catalog-pricing (lane/C3b)
# T-03 tests (tester, chunk C3-catalog-pricing)
- Files: `services/api/src/modules/catalog/__tests__/integration/revision.test.ts` + fixture `__tests__/helpers/catalogDb.ts` (in-memory Postgres fake: row lock on catalog_state, READ COMMITTED, tx-private writes, per-tenant scope). Real core `createEvents({producer:'catalog'})` validates every event.
- Run: `.orchestra\notes\T-03-verify.cmd` (= `pnpm --filter @lims/api exec vitest run src/modules/catalog/__tests__/integration`). Not run by tester: no node_modules in this worktree.
- Covers AC-19.2, AC-19.3 (20 writers gapless), AC-01.1 event half, 03-IC §3.19 payload, bind-only SQL.
- Review round: added test "catalog_state UPDATE is scoped by tenant_id explicitly" (needs `WHERE tenant_id = $1`, values[0] = tx tenant). Fails against current impl (no WHERE, no bind) until repo fix lands. Review's claim "no test change needed" held for the fake, but the assertion was requested.
- Interface seam names unchanged: `createRevisionService({events}).bumpRevision(ctx,{entityType,entityId,changeKind,effectiveFrom})`, `createCatalogEvents(events).catalogChanged`.
- NOT covered: HTTP half of AC-01.1 (T-04), stamping for analyte/range/TAT owners (T-06+), real Postgres lock (db/tests), import-mode suppression (T-20).
