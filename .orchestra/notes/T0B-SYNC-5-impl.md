# T0B-SYNC-5 impl (writer) — BLOCKED on dispute + CR, see below
- Files: services/api/src/core/sync/retention.ts (purgeSyncLedger, own tx per batch, FOR UPDATE SKIP LOCKED, LIMIT, strict <), core/sync/metrics.ts (refreshSyncGauges), core/observability/metrics.ts (3 gauges), services/worker/src/core/sync.ts + cron.ts + tasklist.ts (core.sync_retention daily 21:45 UTC, core.sync_metrics */5, both per_tenant core tasks), consumer.ts (export tenantOf), docs/ops/OFFLINE-SYNC.md.
- [CONV] batches counted only when they delete rows; capped = budget spent with more possibly left. Marker that turns recall_required mid batch: FK fails, batch rolls back alone, next run skips it.
- [CONV] retention days = DEFAULT 180 for all tenants (no tenant setting source yet, open point in runbook).
- BLOCKER 1 (.orchestra/cr/T0B-SYNC-5.md): DELETE policy TO lims_worker needed; existing pgTAP T0C-SYNC-2 lines 87/91 forbid it. Migration verified on throwaway PG17 then removed from db/migrations; needs lead/arbiter ruling.
- BLOCKER 2 (T0B-SYNC-5-dispute.md): static runbook test regex can never pass (sync.device.manage -> sync.device).
- Run 1 on throwaway PG17 (migration present): 70/72 pass; retention, metrics, chaos all green. Fails: static runbook regex (dispute 1) and load.live.test.ts:50 (351 of 20 000 ops rejected; guard of the SYNC-2..4 engine, codes not yet diagnosed, a probe run was not permitted in this session). Not run: whole suite, boot test, pgTAP, three runs.
- Worker src/core: 18 failures in async-manifests / registry-sync (missing @lims/shared-ts/spreadsheet, pre-existing env, not this change); worker tsc same 2 errors only.
- Open: worker gauge of a revoked device keeps its last value until restart (CoreMetrics has no remove).
