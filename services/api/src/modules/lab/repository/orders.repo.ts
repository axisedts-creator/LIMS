// lab.orders (read model), lab.order_readiness, lab.report_releases (05-SCHEMA §1). Tenant filter explicit (REQ-SEC-024).
import { first, getRow, insertRow, query, table, updateRow, type RepoCtx, type Row } from './base.repo.js';

export const ORDERS = table('lab.orders', 'id', ['id', 'tenant_id', 'centre_id', 'branch_id', 'patient_id', 'registration_no', 'visit_type', 'priority', 'referrer_id',
  'collection_mode', 'source', 'registered_at', 'patient_sex', 'patient_age_days', 'lab_status', 'last_order_seq', 'items_version', 'cancelled_at',
  'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/** PK (tenant_id, order_id): keyed by order_id. */
export const ORDER_READINESS = table('lab.order_readiness', 'order_id', ['tenant_id', 'order_id', 'readiness_seq', 'last_emitted_hash', 'last_completeness',
  'department_hashes', 'last_emitted_at', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/** Insert-only (class A). */
export const REPORT_RELEASES = table('lab.report_releases', 'id', ['id', 'tenant_id', 'order_id', 'report_id', 'version_no', 'report_kind', 'released_at',
  'release_basis', 'order_item_ids', 'event_id', 'created_at', 'created_by']);

export const insertOrder = (rc: RepoCtx, row: Row) => insertRow(rc, ORDERS, row);
export const getOrder = (rc: RepoCtx, id: string) => getRow(rc, ORDERS, id);
export const updateOrder = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, ORDERS, id, expectedVersion, patch);

/** Row lock for the order consumers (T-06): serialises concurrent deliveries of the same order's events. */
export const lockOrder = (rc: RepoCtx, id: string) =>
  first(rc, 'SELECT * FROM lab.orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [id]);

/** INSERT ... ON CONFLICT DO NOTHING (T-06): null = the row already exists (a concurrent or earlier delivery built it). */
export async function insertOrderIfAbsent(rc: RepoCtx, o: Row): Promise<Row | null> {
  return first(rc, `INSERT INTO lab.orders (tenant_id, created_by, updated_by, id, centre_id, branch_id, patient_id, registration_no, visit_type, priority, referrer_id,
      collection_mode, source, registered_at, patient_sex, patient_age_days, lab_status, last_order_seq, items_version, cancelled_at)
    VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    ON CONFLICT (id) DO NOTHING RETURNING *`,
  [rc.actorId, o['id'], o['centre_id'], o['branch_id'], o['patient_id'], o['registration_no'], o['visit_type'], o['priority'], o['referrer_id'] ?? null,
    o['collection_mode'] ?? null, o['source'], o['registered_at'], o['patient_sex'], o['patient_age_days'] ?? null, o['lab_status'] ?? 'active', o['last_order_seq'],
    o['items_version'] ?? 1, o['cancelled_at'] ?? null]);
}

/** orders__tenant_id_registration_no__idx */
export const findOrdersByRegistrationNo = (rc: RepoCtx, registrationNo: string) =>
  query(rc, 'SELECT * FROM lab.orders WHERE tenant_id = $1 AND registration_no = $2 ORDER BY registered_at DESC, id', [String(registrationNo)]);
