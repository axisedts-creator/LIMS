// C6-T04 — SQL for the report shell / items / narrative drafts / consumer state (02-TRD §3.2). Parameters only; every statement binds tenant_id (REQ-SEC-024).
// Executed by service/reports.service.ts on the consumer transaction.
export const Q = {
  selectSettings: 'SELECT narrative_report_mode FROM reporting.settings WHERE tenant_id = $1',
  insertReports: `INSERT INTO reporting.reports (id, tenant_id, centre_id, branch_id, order_id, patient_id, referrer_id, partner_id,
      family, order_source, registered_at, registration_no, centre_code, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
    ON CONFLICT (tenant_id, order_id, family) DO NOTHING RETURNING id`,
  selectReports: 'SELECT id FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2 AND family = $3',
  selectNarrativeTemplates: `SELECT id, kind, sections FROM reporting.narrative_templates
    WHERE tenant_id = $1 AND test_id = $2 AND is_active = true ORDER BY code LIMIT 1`,
  insertNarrativeReports: `INSERT INTO reporting.narrative_reports (id, tenant_id, centre_id, report_id, order_id, order_item_id, test_id, template_kind,
      created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
    ON CONFLICT (tenant_id, order_item_id, test_id) DO NOTHING RETURNING id`,
  insertNarrativeVersions: `INSERT INTO reporting.narrative_versions (id, tenant_id, centre_id, narrative_report_id, version_no, template_id, sections,
      created_by, updated_by) VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7, $7)
    ON CONFLICT (tenant_id, narrative_report_id, version_no) DO NOTHING`,
  insertReportOrderItems: `INSERT INTO reporting.report_order_items (id, tenant_id, centre_id, report_id, order_id, order_item_id, orderable_id,
        orderable_kind, test_ids, narrative_test_ids, priority, item_status, requires_lab, requires_narrative, requires_outsourced, items_version,
        created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10::uuid[], $11, $12, $13, $14, $15, $16, $17, $17)
      ON CONFLICT (tenant_id, order_item_id, report_id) DO NOTHING RETURNING report_id`,
  selectReports2: `SELECT id, centre_id, branch_id, order_id, patient_id, referrer_id, partner_id, order_source, registered_at, registration_no, centre_code
  FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2`,
  selectReportOrderItems: 'SELECT items_version FROM reporting.report_order_items WHERE tenant_id = $1 AND order_id = $2',
  updateReportOrderItems: `UPDATE reporting.report_order_items SET item_status = 'removed', version = version + 1, updated_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND order_id = $2 AND order_item_id = ANY($4::uuid[]) AND item_status = 'active' RETURNING report_id`,
  updateNarrativeReports: `UPDATE reporting.narrative_reports SET status = 'cancelled', version = version + 1, updated_by = $2, updated_at = now()
      WHERE tenant_id = $1 AND order_item_id = ANY($3::uuid[]) AND status = 'draft' RETURNING id`,
  updateNarrativeVersions: `UPDATE reporting.narrative_versions SET status = 'cancelled', version = version + 1, updated_by = $2, updated_at = now()
        WHERE tenant_id = $1 AND narrative_report_id = ANY($3::uuid[]) AND status = 'draft'`,
  updateReportOrderItems2: `UPDATE reporting.report_order_items SET items_version = $3, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND order_id = $2 AND (items_version IS NULL OR items_version < $3)`,
  updateReports: `UPDATE reporting.reports SET needs_assembly = true, needs_assembly_since = COALESCE(needs_assembly_since, now()),
        version = version + 1, updated_by = $2, updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($3::uuid[])`,
  selectReports3: 'SELECT id FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2',
  updateReports2: `UPDATE reporting.reports SET state = 'cancelled', cancelled_at = now(), version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_id = $2 AND state = 'open'`,
  updateReportVersions: `UPDATE reporting.report_versions SET status = 'discarded', discard_reason = 'order_cancelled', discarded_at = now(),
      version = version + 1, updated_by = $2, updated_at = now()
    WHERE tenant_id = $1 AND report_id = ANY($3::uuid[]) AND status IN ('rendering', 'rendered', 'render_failed')`,
  updateReports3: `UPDATE reporting.reports SET review_flag = 'released_order_cancelled', version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_id = $2 AND released_version_no IS NOT NULL AND review_flag IS NULL`,
  updateReportOrderItems3: `UPDATE reporting.report_order_items SET specimen_hint = $3, specimen_hint_seq = $4, version = version + 1, updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = ANY($2::uuid[]) AND (specimen_hint_seq IS NULL OR specimen_hint_seq < $4)`,
  updateReportOrderItems4: `UPDATE reporting.report_order_items SET approved_results = approved_results + 1, version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = $2`,
  updateReportOrderItems5: `UPDATE reporting.report_order_items SET amendment_pending = true, version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = $2 AND amendment_pending = false`,
  selectReports4: `SELECT id, lab_ready_seq FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2 AND family = 'laboratory'`,
  updateReports4: `UPDATE reporting.reports SET lab_ready_seq = $3, lab_approved_set_hash = $4, lab_completeness = $5, lab_contains_amendment = $6,
      needs_assembly = true, needs_assembly_since = COALESCE(needs_assembly_since, now()), version = version + 1, updated_by = $7, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND (lab_ready_seq IS NULL OR lab_ready_seq < $3) RETURNING id`,
  selectReportOrderItems2: 'SELECT order_item_id, lab_ready FROM reporting.report_order_items WHERE tenant_id = $1 AND report_id = $2',
  updateReportOrderItems6: `UPDATE reporting.report_order_items SET lab_ready = true, amendment_pending = false, version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND report_id = $2 AND order_item_id = ANY($4::uuid[])`,
  updateReportOrderItems7: `UPDATE reporting.report_order_items SET lab_ready = false, version = version + 1, updated_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND report_id = $2 AND order_item_id = ANY($4::uuid[])`,
} as const;
