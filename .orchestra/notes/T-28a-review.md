APPROVE

Reviewed `git diff 490cf383..HEAD` (T-28a) against 03-IC §4.2 (CatalogPortV1 JSDoc, cases 1–5, 9, 10, 13, 31–33), C3 02-TRD §6.1, §6.3, §7.3, §7.7, plan row T-28a.

- Names verbatim: error codes `common.not_found`, `common.validation_failed`, `catalog.test_inactive`, `catalog.panel_cycle`, `catalog.no_reference_range` (03-IC error list); tables/columns as in the catalog schema; revision query is exactly the §6.3 statement via `currentRevision`.
- Cache (§6.3): key `(tenant_id, catalog_revision, kind, id)`, LRU + TTL, revision read once per ctx (WeakMap), time filtering in memory. `TestDefinition.revision`/`PanelDefinition.revision` = `orderables.revision`; `catalogRevision` = request revision (§7.7).
- Tenant isolation: every tenant-table SELECT binds `tenant_id = $1` from `ctx.tenantId`; all values bound; no DDL/RLS changes in this task (RLS untouched). Read-only, no writes/locks.
- §7.7: input order, DFS dedupe first-seen, inactive panel/test reached → `catalog.test_inactive`, cycle → `catalog.panel_cycle`, tests without specimen requirements omitted from groups, groups sorted by specimen type code.
- No logging, no PHI, no secrets. Paths: only `services/api/src/modules/catalog/**` and `.orchestra/notes/T-28a-*`.
- Ran: 4 T-28a suites 99/99 pass. `tsc --noEmit` errors only in pre-existing `contracts/ports/*.ts` (TS2835, not in this diff).

Non-blocking notes (follow-ups already listed by writer, owned by T-29/T-37): shared `CatalogPort.contract.ts` on real impl, metric `lims_catalog_cache_lookups_total`, real-PG RLS/p95. `getPanel requireActive` → `catalog.test_inactive` follows TRD §6.1 "same with panel".
