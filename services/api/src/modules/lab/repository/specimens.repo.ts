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

// ---- T-07 reads (specimen + registration_no of its lab.orders row; the DTO needs both) ----
const WITH_ORDER = 'SELECT s.*, o.registration_no FROM lab.specimens s JOIN lab.orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id';

export const getSpecimenWithOrder = async (rc: RepoCtx, id: string) =>
  (isUuid(id) ? first(rc, `${WITH_ORDER} WHERE s.tenant_id = $1 AND s.id = $2`, [id]) : null);
/** specimens__tenant_id_barcode__uq */
export const findSpecimenWithOrderByBarcode = (rc: RepoCtx, barcode: string) =>
  first(rc, `${WITH_ORDER} WHERE s.tenant_id = $1 AND s.barcode = $2`, [String(barcode)]);
/** specimens__tenant_id_order__idx via lab.orders.registration_no. */
export const listSpecimensWithOrderByRegistrationNo = (rc: RepoCtx, registrationNo: string, limit: number) =>
  query(rc, `${WITH_ORDER} WHERE s.tenant_id = $1 AND o.registration_no = $2 ORDER BY s.created_at, s.id LIMIT $3`, [String(registrationNo), limitOf(limit)]);

/** { specimen_id, test_id, test_code } of the order tests bound to the specimens (existing-material tests have no specimen). */
export const listTestsOfSpecimens = async (rc: RepoCtx, specimenIds: readonly string[]) =>
  (specimenIds.length === 0 ? [] : query(rc, `SELECT specimen_id, test_id, test_code FROM lab.order_tests WHERE tenant_id = $1 AND specimen_id = ANY($2::uuid[])
                                              ORDER BY ordered_at, test_code, id`, [specimenIds]));

// ---- T-10 label data (#14) ----
/** Specimens (+ registration_no) by id; ids of other tenants / unknown ids simply do not come back (RLS + tenant filter). */
export const listSpecimensWithOrderByIds = async (rc: RepoCtx, ids: readonly string[]) =>
  (ids.length === 0 ? [] : query(rc, `${WITH_ORDER} WHERE s.tenant_id = $1 AND s.id = ANY($2::uuid[])`, [ids]));

/** Test codes + priority of the order tests bound to the specimens, in label order (test_code). */
export const listTestLabelsOfSpecimens = async (rc: RepoCtx, specimenIds: readonly string[]) =>
  (specimenIds.length === 0 ? [] : query(rc, `SELECT specimen_id, test_code, priority FROM lab.order_tests WHERE tenant_id = $1 AND specimen_id = ANY($2::uuid[])
                                              ORDER BY test_code, id`, [specimenIds]));

/** The ONLY label counter write (#14, AC-02.3): atomic increment (no read-modify-write, no lost update); ids sorted by the caller (lock order). Returns the ids written. */
export const bumpLabelPrint = async (rc: RepoCtx, ids: readonly string[], at: string): Promise<string[]> =>
  (ids.length === 0 ? [] : (await query(rc, `UPDATE lab.specimens SET label_print_count = label_print_count + 1, last_label_printed_at = $3::timestamptz, version = version + 1,
      updated_at = now(), updated_by = $2 WHERE tenant_id = $1 AND id = ANY($4::uuid[]) RETURNING id`, [rc.actorId, at, ids])).map((r) => r['id'] as string));

/** [CONV] cumulative: resulted >= verified >= approved (a verified result also counts as resulted). */
export const resultsSummaryOfSpecimen = async (rc: RepoCtx, specimenId: string) => {
  const r = await first(rc, `SELECT count(*)::int AS total,
      (count(*) FILTER (WHERE status IN ('resulted','verified','approved')))::int AS resulted,
      (count(*) FILTER (WHERE status IN ('verified','approved')))::int AS verified,
      (count(*) FILTER (WHERE status = 'approved'))::int AS approved
    FROM lab.results WHERE tenant_id = $1 AND specimen_id = $2`, [specimenId]);
  return { total: Number(r?.['total'] ?? 0), resulted: Number(r?.['resulted'] ?? 0), verified: Number(r?.['verified'] ?? 0), approved: Number(r?.['approved'] ?? 0) };
};

export interface SpecimenFilter {
  orderId?: string; statuses?: readonly string[]; centreId?: string; processingCentreId?: string; priority?: string;
  receivedFrom?: string; receivedTo?: string; isActive: boolean;
  /** absent = all centres; else the specimen is visible when its centre OR processing centre is listed (REQ-SEC-017). */
  scopeCentreIds?: readonly string[];
}
export type SpecimenSort = '-created_at' | 'received_at' | '-received_at';

/** Keyset page (02-CV §4.3/§4.4: id always appended); fetches limit + 1. received_at sorts: NULL = +infinity (last ascending). */
export function pageSpecimens(rc: RepoCtx, f: SpecimenFilter, o: { sort: SpecimenSort; limit: number; after?: { key: string; id: string } }) {
  const vals: unknown[] = [];
  const v = (x: unknown) => { vals.push(x); return `$${vals.length + 1}`; };          // $1 = tenant (base.repo query)
  const where = ['s.tenant_id = $1', `s.is_active = ${v(f.isActive)}`];
  if (f.orderId) where.push(`s.order_id = ${v(f.orderId)}`);
  if (f.statuses?.length) where.push(`s.status = ANY(${v(f.statuses)}::text[])`);
  if (f.centreId) where.push(`s.centre_id = ${v(f.centreId)}`);
  if (f.processingCentreId) where.push(`s.processing_centre_id = ${v(f.processingCentreId)}`);
  if (f.priority) where.push(`s.priority = ${v(f.priority)}`);
  if (f.receivedFrom) where.push(`s.received_at >= ${v(f.receivedFrom)}::timestamptz`);
  if (f.receivedTo) where.push(`s.received_at <= ${v(f.receivedTo)}::timestamptz`);
  if (f.scopeCentreIds) { const p = v(f.scopeCentreIds); where.push(`(s.centre_id = ANY(${p}::uuid[]) OR s.processing_centre_id = ANY(${p}::uuid[]))`); }
  const desc = o.sort.startsWith('-');
  const key = o.sort.endsWith('created_at') ? 's.created_at' : "COALESCE(s.received_at, 'infinity'::timestamptz)";
  if (o.after) where.push(`(${key}, s.id) ${desc ? '<' : '>'} (${v(o.after.key)}::timestamptz, ${v(o.after.id)}::uuid)`);
  const dir = desc ? 'DESC' : 'ASC';
  const limit = limitOf(o.limit + 1);
  return query(rc, `SELECT s.*, o.registration_no, (${key})::text AS sort_key FROM lab.specimens s
                    JOIN lab.orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
                    WHERE ${where.join(' AND ')} ORDER BY ${key} ${dir}, s.id ${dir} LIMIT ${v(limit)}`, vals);
}

/** Append-only (class A): no update. */
export const insertSpecimenTransition = (rc: RepoCtx, row: Row) => insertRow(rc, SPECIMEN_TRANSITIONS, row);

/** specimen_transitions__tenant_id_specimen__idx */
export const listSpecimenTransitions = async (rc: RepoCtx, specimenId: string) =>
  (isUuid(specimenId) ? query(rc, 'SELECT * FROM lab.specimen_transitions WHERE tenant_id = $1 AND specimen_id = $2 ORDER BY occurred_at, specimen_version', [specimenId]) : []);
