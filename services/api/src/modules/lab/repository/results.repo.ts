// lab.results and its records: result_observations, result_versions, result_attachments, verifications, approvals,
// critical_value_log, critical_notifications (05-SCHEMA §1; indexes 05 §5). Tenant filter explicit (REQ-SEC-024).
import { getRow, insertRow, isUuid, limitOf, query, table, updateRow, type RepoCtx, type Row } from './base.repo.js';
import { LimsError } from '../../../core/errors.js';

export const RESULTS = table('lab.results', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'processing_branch_id', 'order_id', 'order_item_id',
  'order_test_id', 'specimen_id', 'patient_id', 'test_id', 'analyte_id', 'analyte_code', 'department_id', 'is_reportable', 'result_type', 'status', 'origin',
  'value_numeric', 'value_text', 'ordinal_code', 'unit_code', 'manual_abnormal', 'flag', 'ref_range_id', 'ref_range_version', 'ref_low', 'ref_high', 'ref_text',
  'ref_unit_code', 'range_unavailable_age_unknown', 'delta_status', 'delta_rule_id', 'delta_rule_version', 'delta_prev_result_id', 'delta_prev_value', 'delta_prev_at',
  'delta_abs', 'delta_pct', 'is_critical', 'critical_event_id', 'calc_status', 'calc_reason', 'formula_provenance', 'comment_codes', 'comment_lib_versions',
  'comment_text', 'unit_mismatch', 'instrument_id', 'instrument_flags', 'instrument_result_time', 'on_hold', 'hold_id', 'qc_review_required', 'module_payload_module',
  'module_payload_entity_id', 'module_payload_version_no', 'module_report_phase', 'module_summary_text', 'module_flag', 'current_version_no', 'resulted_at',
  'first_resulted_at', 'verified_at', 'verified_by_membership_id', 'approved_at', 'approved_by_membership_id', 'cancelled_at', 'cancel_reason',
  'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
  frozen: ['order_id', 'order_item_id', 'order_test_id', 'patient_id', 'test_id', 'analyte_id'],   // = lab.enforce_result_lock identity tuple
});
export const RESULT_OBSERVATIONS = table('lab.result_observations', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_id', 'source', 'value_numeric',
  'value_text', 'ordinal_code', 'unit_code', 'value_raw', 'unit_raw', 'instrument_id', 'instrument_message_id', 'instrument_flags', 'instrument_result_time',
  'received_at', 'result_key', 'is_rerun', 'entered_by_membership_id', 'created_at', 'created_by']);
export const RESULT_VERSIONS = table('lab.result_versions', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_id', 'version_no', 'origin',
  'value_numeric', 'value_text', 'ordinal_code', 'unit_code', 'flag', 'ref_range_id', 'ref_range_version', 'ref_low', 'ref_high', 'ref_text',
  'range_unavailable_age_unknown', 'is_critical', 'delta_status', 'delta_rule_id', 'delta_rule_version', 'delta_prev_result_id', 'delta_prev_value', 'delta_prev_at',
  'delta_abs', 'delta_pct', 'critical_event_id', 'comment_codes', 'comment_lib_versions', 'comment_text', 'formula_provenance', 'module_payload_module',
  'module_payload_entity_id', 'module_payload_version_no', 'module_report_phase', 'module_summary_text', 'approved_at', 'approved_by_membership_id',
  'previous_version_no', 'amendment_reason_code', 'amendment_reason_text', 'superseded_at', 'superseded_by_version_no',
  'version', 'created_at', 'created_by', 'updated_at', 'updated_by'], { mutable: ['superseded_at', 'superseded_by_version_no'] });   // = result_versions__mutable_columns
export const RESULT_ATTACHMENTS = table('lab.result_attachments', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_id', 'bucket', 'object_path',
  'sha256', 'mime_type', 'instrument_message_id', 'created_at', 'created_by']);
export const VERIFICATIONS = table('lab.verifications', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_id', 'kind', 'mode', 'result_row_version',
  'acknowledged_flags', 'reason_code', 'comment', 'membership_id', 'autoverify_rule_set_version', 'occurred_at', 'created_at', 'created_by']);
export const APPROVALS = table('lab.approvals', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_id', 'version_no', 'kind', 'membership_id', 'aal',
  'occurred_at', 'created_at', 'created_by']);
export const CRITICAL_VALUE_LOG = table('lab.critical_value_log', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_id', 'result_version_no', 'order_id',
  'patient_id', 'analyte_id', 'referrer_id', 'direction', 'value_sha256_prefix16', 'value_numeric', 'value_text', 'ordinal_code', 'unit_code', 'critical_limit_id',
  'critical_limit_version', 'limit_low', 'limit_high', 'detected_at', 'status', 'first_confirmed_notification_at', 'value_changed_after_detection', 'closed_at',
  'version', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
  mutable: ['status', 'first_confirmed_notification_at', 'value_changed_after_detection', 'closed_at'],   // = critical_value_log__mutable_columns
});
export const CRITICAL_NOTIFICATIONS = table('lab.critical_notifications', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'critical_event_id',
  'notified_party_kind', 'notified_party_name', 'contact_method', 'contact_detail', 'notified_at', 'outcome', 'read_back_confirmed', 'read_back_text', 'comment',
  'notified_by_membership_id', 'created_at', 'created_by']);

export const insertResult = (rc: RepoCtx, row: Row) => insertRow(rc, RESULTS, row);
export const getResult = (rc: RepoCtx, id: string) => getRow(rc, RESULTS, id);
export const updateResult = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, RESULTS, id, expectedVersion, patch);

// ---- T-07 S4: processing centre/branch copy (every statement: tenant filter, version bump) ----
export const copyProcessingToResultsOfSpecimen = (rc: RepoCtx, specimenId: string, p: { centreId: string; branchId: string }) =>
  query(rc, `UPDATE lab.results SET processing_centre_id = $3, processing_branch_id = $4, version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $5 RETURNING id`, [rc.actorId, p.centreId, p.branchId, specimenId]);
/** 08 A13 D-13: results of the order's existing-material tests that have no processing centre yet. */
export const copyProcessingToExistingMaterialResults = (rc: RepoCtx, orderId: string, p: { centreId: string; branchId: string }) =>
  query(rc, `UPDATE lab.results SET processing_centre_id = $3, processing_branch_id = $4, version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND order_id = $5 AND specimen_id IS NULL AND processing_centre_id IS NULL
               AND order_test_id IN (SELECT id FROM lab.order_tests WHERE tenant_id = $1 AND order_id = $5 AND uses_existing_material = true AND specimen_id IS NULL)
             RETURNING id`, [rc.actorId, p.centreId, p.branchId, orderId]);

// ---- T-08 reject / recollection / aliquots ----
/** S11 (R8): every non-approved result of the specimen is cancelled; approved rows stay. Returns the cancelled rows. */
export const cancelResultsOfSpecimen = (rc: RepoCtx, specimenId: string, at: string) =>
  query(rc, `UPDATE lab.results SET status = 'cancelled', cancelled_at = $3::timestamptz, cancel_reason = 'specimen_rejected', version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $4 AND status IN ('pending','resulted','verified') RETURNING id`, [rc.actorId, at, specimenId]);
/** 08 A13 D-12: the rows a recollection replaces (cancelled by the rejection) of the re-opened order tests. */
export const listRejectedResultsOfTests = (rc: RepoCtx, specimenId: string, orderTestIds: readonly string[]) =>
  query(rc, `SELECT * FROM lab.results WHERE tenant_id = $1 AND specimen_id = $2 AND status = 'cancelled' AND cancel_reason = 'specimen_rejected' AND order_test_id = ANY($3::uuid[])
             ORDER BY order_test_id, analyte_code, id`, [specimenId, orderTestIds]);
/** S5 guard: the tests (of the specimen) that still have a not-approved, not-cancelled result. */
export const listAliquotableTestIds = async (rc: RepoCtx, specimenId: string, testIds: readonly string[]) =>
  (await query(rc, `SELECT DISTINCT test_id FROM lab.results WHERE tenant_id = $1 AND specimen_id = $2 AND status IN ('pending','resulted','verified') AND test_id = ANY($3::uuid[])`,
    [specimenId, testIds])).map((r) => r['test_id'] as string);
/** S5: the not-approved results of the assigned tests move to the aliquot (same rows, new specimen_id). */
export const moveResultsToSpecimen = (rc: RepoCtx, fromId: string, toId: string, testIds: readonly string[]) =>
  query(rc, `UPDATE lab.results SET specimen_id = $3, version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $4 AND test_id = ANY($5::uuid[]) AND status IN ('pending','resulted','verified') RETURNING id`, [rc.actorId, toId, fromId, testIds]);

/** results__tenant_id_order__idx */
export const listResultsByOrder = async (rc: RepoCtx, orderId: string) =>
  (isUuid(orderId) ? query(rc, 'SELECT * FROM lab.results WHERE tenant_id = $1 AND order_id = $2 ORDER BY order_test_id, analyte_code, id', [orderId]) : []);

/** results__tenant_id_history__p_idx: previous approved results / trend, newest approval first. */
export const listResultHistory = async (rc: RepoCtx, o: { patientId: string; analyteId: string; limit: number }) => {
  const limit = limitOf(o?.limit);
  if (!isUuid(o.patientId) || !isUuid(o.analyteId)) return [];
  return query(rc, `SELECT * FROM lab.results WHERE tenant_id = $1 AND patient_id = $2 AND analyte_id = $3 AND status = 'approved'
                    ORDER BY approved_at DESC, id LIMIT $4`, [o.patientId, o.analyteId, limit]);
};

/** results__tenant_id_queue__p_idx: verification/approval queue of one department. */
export const listVerificationQueue = async (rc: RepoCtx, o: { status: 'resulted' | 'verified'; departmentId: string; limit: number }) => {
  const limit = limitOf(o?.limit);
  if (o.status !== 'resulted' && o.status !== 'verified') throw new LimsError('common.internal');
  if (!isUuid(o.departmentId)) return [];
  return query(rc, `SELECT * FROM lab.results WHERE tenant_id = $1 AND status IN ('resulted','verified') AND status = $2 AND department_id = $3
                    ORDER BY resulted_at, id LIMIT $4`, [o.status, o.departmentId, limit]);
};
