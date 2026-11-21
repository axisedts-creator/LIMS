APPROVE

T0B-SYNC-2 review (reviewer, 2026-11-18). Scope: the briefed range f821eb50f..HEAD (ruling edits: registry-equality LD322_SYNC2_ERRORS += sync.op_type_not_available, sync1/sync2 pending covered set = health + syncHandlers + syncPart2Handlers, metrics EXPECTED += 3 sync metrics, pull.live doctor_code 'S2P-' || upper(...) satisfies doctors__code__ck, sync2-openapi ten codes, regenerated events.ts) — all match LD-374 rulings 1-3 verbatim; no assertion loosened. Because that range holds only the post-ruling edits, the implementation commit 36d87a1b8 (engine, pull, conflicts, repository, index, bootstrap, core-pending, metrics, errors.yaml/core.yaml) was reviewed too.

Checked, no defect:
- Names: sync.op_type_not_available (422, C0) per LD-374 in errors.yaml + SyncErrorCode + exception list; IC not edited. Permission codes sync.use / sync.conflict.resolve from LD-322; pull permissions copied from each type's read op.
- Tenant isolation: explicit tenant_id on every query next to RLS; ledger keyed (tenant_id, op_id); op_id of another user answers sync.op_id_reused (no result leak); patient pull centre scoped, fails closed to no rows when scope is unknown; worklist_item/permission fail closed auth.forbidden (LD-374 ruling 2). No new tables, so no RLS change in this task.
- Engine: limits checked before any work; non-waiting xact advisory lock gives 429 + retry_after; device owned + active; per-op SAVEPOINT; permission asserted at sync time; claim-first makes a replay idempotent; codes restricted to the closed SyncErrorCode list, otherwise common.internal.
- Conflicts: row locked FOR UPDATE, resolved once (common.immutable_record), sync.entity_changed check, audit via row trigger.
- Logs: op_type / conflict_id / resolution only, no PHI. No secrets. Paths are within the C0 core/contracts/codegen-output scope.
- Tests cover done_when 2, 5, 6, 7 and 8 (replay, shuffled-delivery property, bad op in middle, permission removed, revoked device, tamper/op_id_reused, cross tenant, concurrent batches).

Ran: the 7 static suites (registry-equality, sync2-openapi, sync1/sync2 pending, metrics, both registry.static): 211/211 pass. The first run had 1 failure (sync2-openapi lintRepo, under parallel load); it passed alone (120/120) and again when all 7 were rerun. Not run: live PG17 suites (I relied on the writer's 3 green runs).

Not blocking. These are for the lead or the follow-up tasks:
- lims_core_sync_oldest_unsynced_age_seconds is declared but never set, and the getSyncStatus contract has no oldest-unsynced field (done_when 7). That field needs a contract CR (T0C), not a code change here.
- The pull keyset on updated_at can skip a row whose transaction commits after a later page has been read, because updated_at = now() is the transaction start time. The done_when requires this design; consider a small overlap window or xmin-based watermark later.
- The rate limiter is in-process (ponytail note present). There are no (tenant_id, updated_at, id) indexes for pull, and the 200-device load test (LD-322 decision 5) was not run.
