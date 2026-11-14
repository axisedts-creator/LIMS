APPROVE

Reviewed `git diff 05ca00c8..HEAD` (HC-T14) against 02-TRD §5.1 H13–H15, §5.4 rules 1/3/4, §10 task row; 01-PRD US-12-1/2/3/5; 05-SCHEMA D-125 note.
- Names: operationIds, permission `homecollection.handover.receive`, task `homecollection.flag_handover_discrepancy`, job_key `flag_handover_discrepancy:<handover_id>`, payload `{tenant_id, handover_id}`, flag kind `handover_discrepancy`, error codes (`common.version_conflict`, `common.not_found`, `common.validation_failed`, `auth.forbidden`) verbatim. DTOs match generated `HandoverSummaryDto` / `HandoverDetailDto`.
- D-125: H14/H15 touch only handovers/handover_items (SQL probe tests); H15 enqueues in same tx, never inserts visit_flags; worker writes flags as system actor, ON CONFLICT on open-flag index, route version++.
- Tenant isolation: repo filters tenant_id + RLS; assertRole on `to_centre_id`; foreign id in items -> 404 (rule 4); worker drops payload.tenant_id != ctx.tenantId. No new DDL in this task.
- Idempotency/rate tier via pipeline from OpenAPI (`x-idempotency`, `general`). Logs carry ids/codes/counts only; no secrets. Paths within C17 ownership.
- Ran `tests/homecollection/HC-T14.pg.sh` myself: API 59/59, worker 12/12 pass.

Non-blocking notes (no change required for this task):
- No worker manifest entry registers `flagHandoverDiscrepancy` yet (same for `refresh_visit_specimens`, HC-T09); the `core.g_task_registry` row is fixture-only. Owning task must wire both before release.
- Lint not run by writer.
