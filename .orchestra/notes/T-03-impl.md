# T-03 impl (writer, C3-catalog-pricing, lane/C3b) — overwrites earlier C1/C5 T-03 note (in git history)
- Files: catalog/service/revision.service.ts (createRevisionService.bumpRevision), catalog/events/publish.ts (createCatalogEvents.catalogChanged), catalog/repo/catalogState.repo.ts (ensureState, incrementRevision, stampOrderable).
- [CONV] Lock+increment is one `UPDATE catalog_state SET catalog_revision = catalog_revision + 1 … WHERE tenant_id = $1 RETURNING …` (review #1: explicit tenant bind per 03-APP-FLOW:168, not RLS alone) (row lock held to COMMIT; same guarantee as TRD's SELECT … FOR UPDATE, one round trip). No row -> INSERT … ON CONFLICT (tenant_id) DO NOTHING with fresh uuidv7 root, then UPDATE again (concurrent creators serialise on the PK).
- [CONV] Input validation relies on the catalog.changed.v1 schema in core events.publish (fails closed, rolls tx back); only the 5 IC keys are copied, extra input keys ignored.
- Stamping: only entityType test|panel (orderables.id = entityId); other owners T-06+.
- Ran: vitest src/modules/catalog/__tests__/integration -> 56/56 pass (after review fix); tsc --noEmit: no catalog errors.
- Open: unit/skeleton.test.ts 2 fails when LIMS_CORE_ENV unset (config error, unrelated to T-03 files). No eslint installed in worktree; not linted.
