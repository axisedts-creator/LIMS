APPROVE

Scope: `git diff 575dc016..HEAD`. Only owned paths changed: `services/api/src/modules/catalog/ports/CatalogPort.impl.ts` plus catalog `__tests__` and T-28b notes.
- Names: `PriceQuery` / `PriceQuote` fields copied exactly from 03-IC (lines 1214-1225) and contracts/ports/CatalogPort.ts:48-60. The `source` enum matches. Optional fields are left out when there is no value. Error codes `common.not_found`, `catalog.no_price`, `catalog.tax_config_missing` and `common.validation_failed` all come from the spec.
- Tenancy/security: `priceFor` hands off to `quotePrices`. That path only reads, runs on ctx.tx, takes the tenant from ctx.tenantId, filters every tenant-table query by `tenant_id = $1`, and binds every value. It makes no writes, takes no locks and publishes no events. This change adds no DDL, so the RLS/`::uuid[]` check does not apply. Nothing is logged, so no PHI leaves through logs, and no secrets are present.
- Input is closed: ids must be uuids, priority must be routine or urgent, `at` must be an ISO time with an offset, and only the 4 contract keys are read from context. Client-supplied price, tax or tenant values are ignored (REQ-SEC-046).
- Tests: 03-IC §4.2 cases 6, 7, 8 (plus 17, 18, 23), AC-13.1–13.3, AC-14.1–14.4 and the read side of AC-15.1/15.3/15.5 are covered. AC-14.5, the AC-15.2 creation path and AC-15.5 overlap are write-side (T-18), and AC-15.4 is UI (T-34). The tests note says so and this matches the plan.
- Ran `.orchestra/notes/T-28b-verify.cmd`: 2 files, 85/85 pass.
- Not run by reviewer: lint, full tsc, full catalog suite. The writer reports 7 test failures from a stale `pending.json`; they are outside T-28b's scope.
