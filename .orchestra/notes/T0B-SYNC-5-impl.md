# T0B-SYNC-5 impl (writer) — LD-407 applied (retention dropped)
- Files: core/sync/metrics.ts, core/observability/metrics.ts (3 gauges), worker core/sync.ts + cron.ts + tasklist.ts (core.sync_metrics */5 per tenant), consumer.ts (export tenantOf), core/sync/engine.ts (rethrow 40001/40P01 before codeOf, 02-TRD §6.4), docs/ops/OFFLINE-SYNC.md.
- LD-407 (2026-11-19): deleted core/sync/retention.ts; removed core.sync_retention task, cron entry and wiring; runbook retention section replaced by "retained indefinitely, no automatic deletion (LD-407)"; dropped the retention alert row. No DELETE, policy or grant touched; registry static pins and pgTAP pins untouched.
- Kept lims_core_retention_purged_total / _capped_total in the metrics registry: they belong to the existing core.retention_purge job (worker core/retention.ts), not to sync.
- Checks: api tsc --noEmit clean. Worker tsc and worker src/core vitest: only failures are the pre-existing unbuilt @lims/shared-ts/spreadsheet dist (catalog xlsx import), unrelated to this task.
- PG17 suite (hardening + metrics): 53/54 pass; load.live:40 fails with common.dependency_unavailable (deadlock survives 3 whole-request retries) -> dispute-202611190835. Not run by writer: boot test and three runs in a row (reviewer verify).
- 10:30 rerun after LD-412/415 kit fix: 53/54; only load.live:82 p95 41996 > 30000 ms (counter-serialised kit) -> dispute-202611191030. No impl change.
- Open: worker gauge of a revoked device keeps its last value until restart.
