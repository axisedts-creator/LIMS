// lab.specimens + lab.specimen_transitions (05-SCHEMA §1; indexes 05 §5). Tenant filter explicit (REQ-SEC-024).
import { first, getRow, insertRow, isUuid, limitOf, query, table, updateRow, type RepoCtx, type Row } from './base.repo.js';

export const SPECIMENS = table('lab.specimens', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'processing_branch_id', 'order_id', 'patient_id', 'barcode', 'creation_key',
  'specimen_type_code', 'container_code', 'priority', 'patient_sex', 'patient_age_days', 'status', 'parent_specimen_id', 'replaces_specimen_id', 'ordered_at', 'collected_at',
  'collected_at_device', 'collected_by_membership_id', 'collected_via_visit_id', 'collection_barcode_unverified', 'in_transit_at', 'received_at', 'received_by_membership_id',
  'in_process_at', 'first_resulted_at', 'first_verified_at', 'all_approved_at', 'reported_at', 'rejected_at', 'rejection_reason_code', 'rejection_comment',
  'rejected_by_membership_id', 'recollection_ordered_at', 'stored_at', 'storage_location', 'discarded_at', 'discard_reason', 'label_print_count', 'last_label_printed_at',
  'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
  // = specimens__mutable_columns trigger list
  mutable: ['processing_centre_id', 'processing_branch_id', 'status', 'collected_at', 'collected_at_device', 'collected_by_membership_id', 'collected_via_visit_id',
    'collection_barcode_unverified', 'in_transit_at', 'received_at', 'received_by_membership_id', 'in_process_at', 'first_resulted_at', 'first_verified_at',
    'all_approved_at', 'reported_at', 'rejected_at', 'rejection_reason_code', 'rejection_comment', 'rejected_by_membership_id', 'recollection_ordered_at', 'stored_at',
    'storage_location', 'discarded_at', 'discard_reason', 'label_print_count', 'last_label_printed_at', 'is_active'],
});
export const SPECIMEN_TRANSITIONS = table('lab.specimen_transitions', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'specimen_id', 'transition_code',
  'from_status', 'to_status', 'specimen_version', 'occurred_at', 'actor_type', 'actor_id', 'membership_id', 'reason_code', 'created_at', 'created_by']);

export const insertSpecimen = (rc: RepoCtx, row: Row) => insertRow(rc, SPECIMENS, row);
export const getSpecimen = (rc: RepoCtx, id: string) => getRow(rc, SPECIMENS, id);
export const updateSpecimen = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPECIMENS, id, expectedVersion, patch);

/** specimens__tenant_id_barcode__uq */
export const findSpecimenByBarcode = (rc: RepoCtx, barcode: string) =>
  first(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND barcode = $2', [String(barcode)]);

/** specimens__tenant_id_order__idx */
export const listSpecimensByOrder = async (rc: RepoCtx, orderId: string) =>
  (isUuid(orderId) ? query(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id', [orderId]) : []);

/** specimens__tenant_id_created__idx (list sort=-created_at) */
export const listSpecimensRecent = (rc: RepoCtx, o: { limit: number }) =>
  query(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [limitOf(o?.limit)]);

/** specimens__tenant_id_status__p_idx (lab hot set); the IN list repeats the partial-index predicate verbatim. */
export const listReceiveQueue = (rc: RepoCtx, o: { limit: number }) =>
  query(rc, `SELECT * FROM lab.specimens WHERE tenant_id = $1 AND status IN ('received','aliquoted','in_process','resulted','verified')
             ORDER BY received_at, id LIMIT $2`, [limitOf(o?.limit)]);

/** Append-only (class A): no update. */
export const insertSpecimenTransition = (rc: RepoCtx, row: Row) => insertRow(rc, SPECIMEN_TRANSITIONS, row);

/** specimen_transitions__tenant_id_specimen__idx */
export const listSpecimenTransitions = async (rc: RepoCtx, specimenId: string) =>
  (isUuid(specimenId) ? query(rc, 'SELECT * FROM lab.specimen_transitions WHERE tenant_id = $1 AND specimen_id = $2 ORDER BY occurred_at, specimen_version', [specimenId]) : []);
