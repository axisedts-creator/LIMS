APPROVE

Reviewed `git diff ab97130..f51416d4` (AN-T16) against 02-TRD §5 #24–#29, §5.1 (ScheduleInput/ScheduleDto/ReportRunDto), §9.6 steps 1–7 + nextSlot, migration 20261105002100 (schedules / schedule_recipients / report_runs / report_run_recipients CHECKs), contracts/errors.yaml, routes `staff.analytics.report_run`.
- Names verbatim: operation ids, `analytics.schedule.manage` / `analytics.dashboard.read`, `analytics.report_ready`, `scheduled_report_ready`, `report_run`, states/outcomes match the CHECK sets, error codes exist (`analytics.recipient_ineligible` 422, `analytics.report_unknown` 404, cap -> 400 path '').
- Tenant isolation: every statement is parameterised + `tenant_id = $1`; `::uuid[]` / `::text[]` casts present; RLS (ENABLE+FORCE, policies) already in migration/policies, run visibility enforced by RLS plus service check (non-recipient non-owner 404).
- Dispatcher: idempotent via `ON CONFLICT (tenant_id, schedule_id, slot_start) DO NOTHING` + send key `${schedule_id}:${slot_start}:${membership_id}`; skipped_late > 24 h sends nothing; flag-off omission + skipped_flag_off; only active recipients (D-45); params only lab_name, schedule_name; recipient {kind:'staff', membershipId, requiredPermission}; absolute link from LIMS_ORIGIN_STAFF_WEB (D-29). Logs carry ids/counts only, no PHI, no secrets.
- Recipients deactivated/reactivated, never deleted; removal before reactivation keeps the 20-active trigger happy.
- Owned paths only (worker->api import has precedent in build_export/backfill).
- Tests run by reviewer: API 5 files 359/359 (schedule domain, name_ck, schedules handler, reportRun handler, boot); worker dispatch_schedules 30/30. Cover all done_when items.
- Not verified: real PG / pgTAP (SQL never executed against Postgres), tsc.
