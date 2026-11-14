// C6-T04 — SQL for the report shell / items / narrative drafts / consumer state (02-TRD §3.2). Parameters only; every statement binds tenant_id (REQ-SEC-024).
// Executed by service/reports.service.ts on the consumer transaction.
export const Q = {
  selectReportVersions: `SELECT id, report_id, version_no, status, report_kind, completeness, version FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2`,
  updateReportVersions: `UPDATE reporting.report_versions SET status = 'rendering', render_attempts = 0, last_render_error_code = NULL, rendering_started_at = now(),
        version = version + 1, updated_by = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'render_failed' AND version = $3 RETURNING version`,
} as const;
