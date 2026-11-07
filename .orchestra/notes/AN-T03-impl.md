# AN-T03 impl (writer)
- Files: `services/api/src/modules/analytics/service/context.service.ts` (new). `resolvePeriod` re-exported from `domain/period.ts`; `resolveScope` new, uses `domain/scope.ts#intersect`.
- [CONV] getActor memo = WeakMap keyed by ctx (per request, concurrent calls share the promise); returned Scope is a fresh copy.
- [CONV] Order: ≤20 ids check (400, before any lookup) → getActor → centre check → branch check. Foreign/unknown/other-tenant ids → one `common.not_found` (no id echoed).
- All-centre actor + centre ids: existence checked via one `ctx.core.centres(ctx)` list (07 P1); restricted actors: scope membership only. Branch: `ctx.core.branches(ctx)` existence, then `centres(ctx,{branchId})` ∩ scope; no overlap → `{all:false,centreIds:[]}`.
- Error mapping: port/core errors of the contracts' `LimsError` class (fake) are re-wrapped as the API `LimsError` by `code`, so status maps (403/401/503).
- Result: `vitest run src/modules/analytics` 9 files / 354 tests pass; tsc shows no errors in analytics/service.
- Open: `ScopeContext` is a local structural type (HandlerContext has no ports/core yet); `loadFlags()` not implemented (no contract).
