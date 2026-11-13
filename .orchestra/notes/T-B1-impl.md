# T-B1 impl (writer)
Files: api `repository/bookable.repo.ts`, `service/bookable.service.ts` (S12/S13/S14 + shared `fetchSnapshot`), `handlers/bookable.handlers.ts` (+ index.ts wiring); worker `tasks/sync_bookable_items.ts` (sync + nightly), `consumers/catalog.changed.v1.ts`, `cron.ts` row `55 19 * * *`, `index.ts`.
Result: after ruling (TESTS_WRONG) + tester revision: api bookable 20/20, worker bookable 38/38 pass (2026-11-13); no impl change needed.
[CONV] price_source = 'tenant_default' whenever a price exists (no column; snapshot is always tenant default). Sync does not bump `version` and never re-activates a staff-disabled item.
[CONV] second create / lost insert race (23505) -> 409 common.version_conflict; absent If-Match = create; malformed If-Match -> 400.
[CONV] consumer: tenant from ctx; event.tenant_id mismatch throws (fail closed); unknown entity_type enqueues the sync.
Open: not run — full-repo typecheck/lint (api tsconfig NodeNext errors outside C16 were already blocking per earlier notes); real DB/RLS not covered.
