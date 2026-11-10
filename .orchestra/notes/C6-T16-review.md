APPROVE

Scope: `git diff 66562197..HEAD` (C6-T16) against 02-TRD R10–R13, T5, §9 tasks (render_print, build_bulk_print, purge_ephemeral cron `17 20 * * *` per_tenant), §audit table, 05-SCHEMA §2.14 (+ centre rule #36), print delivery (§162), 01-PRD AC-12.1–12.4, AC-13.1.

Checked, no defect found:
- Names verbatim: operationIds, `reporting.report.print` / `.release` / `.bulk_download`, `reporting.report_not_released`, `reporting.print_not_ready`, buckets `reports` / `reporting-prints`, path `{tenant}/prints/…`, access-log actions/entities (`report.print`/report_version, `report.download`/print_job, `report.bulk_download`/print_job + count), print_jobs columns/enums.
- Tenancy: every statement names tenant_id; `::uuid[]` casts; centre scope via existing `__tenant_centre` RLS (no new tables, policies already in db/policies/reporting.sql); storage paths checked against the tenant prefix before read/delete.
- Centre rule #36: single = version centre, bulk/preview = working centre (fail closed if missing).
- D-37 draft gate: only `auth.forbidden` maps to report_not_released; other errors propagate; draft always renders with "NOT RELEASED" watermark + not_released marker.
- AC-12.1 letterhead released = ready, no file, R12 streams canonical PDF; delivery row matches 05-SCHEMA §162. AC-12.2 plain from frozen snapshot + version's own template version, branding assets skipped. AC-12.4 aal2 via assertRole, cap 200, dedupe. AC-13.1 renderer ignores any document for `template-preview` (synthetic sample only).
- No PHI in logs/filenames/errors; no secrets; edits within C6 paths.

Tests run (this session): api print.handlers 89/89; worker render_print + build_bulk_print + purge_prints + manifest 61/61; renderer print-render 13/13.

Non-blocking notes (no change required here):
- Bulk `variant: plain` has no spec'd behaviour and bulk re-stamps page labels — already listed by the writer as a CR candidate.
- API test files need `--hookTimeout=120000` when run in parallel (cold import), C0-owned config.
- purge_ephemeral covers print_jobs only; other E tables belong to their tasks.
