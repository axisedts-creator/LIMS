APPROVE

Round 2. Re-reviewed `git diff 7bb6a6f..HEAD`, focusing on 82eb1e1..HEAD (consumer.ts, tenant-scope.ts, consumer/tenant-scope tests, CR, notes).
Tests re-run: `pnpm exec vitest run --root services/worker src/core/__tests__` → 7 files, 84/84 pass.

Round-1 items:
1. Fixed. consumer.ts `dropExtensibleEnums` removes `enum` only on nodes where `x-extensible: true`, before `ajv.addSchema` (CV §7.2, TRD §7.3 step 3). consumer.test.ts:144-175 covers `catalog.changed.v1` with `entity_type: 'some_future_kind'`: handler runs once, plus a control case.
2. Fixed. tenant-scope.ts is the 4-arg core-internal `withTenantScope`. It checks tenant and actor are UUIDs, rejects nested use, sets `{sub, tenant_id, actor_type:'system'}` with `set_config(..., true)`, and restores the old claims in `finally`. Tests cover: restore after throw, sequential tenants, nesting, and reuse after a failure.
3. Fixed. CR-C0-0D-006 is filed at `.orchestra/cr/T0D-09.md`. The impl note marks bootstrap/main/replay as BLOCKED and says the task is NOT done.

Not a defect, but worth hardening later: SWITCH_SQL reads `current_setting` and calls `set_config` in a single SELECT. This depends on Postgres evaluating the target list left to right. That is what happens in practice, but it is not guaranteed. Splitting it into two statements would remove the dependency.
Still open (outside this diff): bootstrap.ts/main.ts/replay.ts wait on CR-C0-0D-006. Wiring tenant-scope.ts into WorkerDeps happens in bootstrap.
