APPROVE

# AN-T03 review (reviewer)
- Scope: `git diff 80bb855..HEAD` — only `services/api/src/modules/analytics/service/context.service.ts` (+ its `__tests__`) and own `.orchestra/notes/AN-T03-*`. Owned paths only.
- Matches 02-TRD §4 resolveScope steps 1–3: getActor memoised per request (WeakMap per ctx); centre_id must be in `centreScope.centreIds` unless all → `404 common.not_found`; branch_id must exist in `ctx.core.branches(ctx)`, converted via `ctx.core.centres(ctx,{branchId})` ∩ caller scope (07 P5); `all` only when actor all and no filter. `resolvePeriod` re-exported from domain (AN-T02), signature per TRD.
- 07 P1 / REQ-SEC-013: all-centre actor's centre ids checked against tenant-filtered `ctx.core.centres` list; foreign/unknown/other-tenant give identical error, id not echoed.
- Codes verbatim from 03-IC §8: `common.not_found`, `common.validation_failed` (400) with `common.field_invalid` sub-code; ≤20 ids per ScopeQuery maxItems 20. No PHI, no logging, no secrets. No SQL/RLS in this task (N/A).
- Tests: done_when + ACs US-15.2, US-02.3/.4/.5 covered; fake actors all-centre, A1-only, locked, aal1 (+ partner, no membership, multi). Ran `vitest run src/modules/analytics`: 9 files / 354 tests pass. tsc: 0 errors in analytics (2 pre-existing errors elsewhere, not this diff).
- Non-blocking: `loadFlags()` (TRD file tree) not implemented — no contract; leave to its task. `ScopeContext` is a local structural type until HandlerContext gains ports/core.
