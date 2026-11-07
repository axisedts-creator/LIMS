// Instrument ingest + QC + module idempotency: lab.ingest_log, lab.ingest_exceptions, lab.qc_results, lab.qc_holds, lab.module_submissions (05-SCHEMA §1).
// Generic row operations via base.repo (insertRow/getRow/updateRow); named queries are added by the tasks that use them.
import { table } from './base.repo.js';

export const INGEST_LOG = table('lab.ingest_log', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_key', 'first_source', 'first_event_id',
  'last_outcome', 'result_id', 'specimen_id', 'exception_id', 'attempts', 'last_attempt_at', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
  mutable: ['last_outcome', 'result_id', 'specimen_id', 'processing_centre_id', 'exception_id', 'attempts', 'last_attempt_at'],   // = ingest_log__mutable_columns
});
export const INGEST_EXCEPTIONS = table('lab.ingest_exceptions', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_key', 'reason', 'status',
  'instrument_id', 'instrument_message_id', 'agent_id', 'protocol', 'sample_barcode', 'record_kind', 'instrument_analyte_code', 'analyte_id', 'test_id', 'value_raw',
  'value_numeric', 'unit_raw', 'unit_code', 'instrument_flags', 'instrument_result_time', 'received_at', 'is_rerun', 'attachment', 'specimen_id', 'result_id',
  'attempts', 'last_attempt_at', 'resolution', 'resolved_at', 'resolved_by_membership_id', 'discard_reason_code', 'comment',
  'version', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/** Append-only (class A). */
export const QC_RESULTS = table('lab.qc_results', 'id', ['id', 'tenant_id', 'centre_id', 'instrument_id', 'instrument_message_id', 'analyte_id', 'instrument_analyte_code',
  'mapping_status', 'control_id_raw', 'control_lot_raw', 'control_level', 'value_raw', 'value_numeric', 'unit_raw', 'unit_code', 'instrument_flags',
  'instrument_result_time', 'received_at', 'source', 'idempotency_key', 'entered_by_membership_id', 'created_at', 'created_by']);
export const QC_HOLDS = table('lab.qc_holds', 'id', ['id', 'tenant_id', 'qc_run_id', 'instrument_id', 'analyte_ids', 'since', 'reason_code', 'status', 'held_result_ids',
  'review_flagged_result_ids', 'released_at', 'released_by_membership_id', 'release_comment', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  { frozen: ['qc_run_id', 'instrument_id'] });
/** Append-only (class A, A1 idempotency). */
export const MODULE_SUBMISSIONS = table('lab.module_submissions', 'id', ['id', 'tenant_id', 'idempotency_key', 'result_id', 'payload_module', 'payload_entity_id',
  'payload_version_no', 'output_version_no', 'output_status', 'created_at', 'created_by']);
