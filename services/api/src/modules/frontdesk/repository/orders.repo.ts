// frontdesk.orders (05-SCHEMA §3). Explicit tenant_id filter on every statement; RLS (tenant + centre) is the backstop.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'branch_id', 'centre_id', 'patient_id', 'registration_no', 'status', 'visit_type', 'billing_mode', 'credit_party_id', 'referrer_id',
  'priority', 'collection_mode', 'source', 'source_ref_id', 'partner_id', 'age_years', 'age_months', 'age_days', 'is_first_order_of_patient',
  'catalog_revision', 'items_version', 'scheduled_at', 'registered_at', 'requires_credit_note'] as const;

export const insertOrder = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.orders', COLS, tenantId, row);
export const getOrderById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.orders', tenantId, id);

/** is_first_order_of_patient = NOT this (any status counts: a cancelled order is still a prior visit). */
export async function patientHasOrder(tx: Tx, tenantId: string, patientId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2 LIMIT 1', [tenantId, patientId]);
  return rows.length > 0;
}

/**
 * F6 keyset page, newest first unless asc. Sort key = COALESCE(registered_at, created_at) so pre-registered orders (NULL registered_at) page deterministically
 * [CONV]; it is returned as microsecond-exact text (`sort_key`) for the cursor. `after` = [sort_key text, id].
 */
export async function pageOrdersByPatient(tx: Tx, tenantId: string, patientId: string, o: { asc: boolean; limit: number; after?: readonly [string, string] }): Promise<any[]> {
  const K = 'COALESCE(o.registered_at, o.created_at)';
  const cmp = o.asc ? '>' : '<';
  const dir = o.asc ? 'ASC' : 'DESC';
  const { rows } = await tx.query(`SELECT o.*, to_char(${K} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key,
      (SELECT count(*)::int FROM frontdesk.order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id AND i.status = 'active') AS item_count,
      EXISTS (SELECT 1 FROM frontdesk.order_flags f WHERE f.tenant_id = o.tenant_id AND f.order_id = o.id AND f.status = 'open') AS has_open_flag
    FROM frontdesk.orders o WHERE o.tenant_id = $1 AND o.patient_id = $2
      ${o.after ? `AND (${K}, o.id) ${cmp} ($4::timestamptz, $5::uuid)` : ''}
    ORDER BY ${K} ${dir}, o.id ${dir} LIMIT $3`, [tenantId, patientId, o.limit + 1, ...(o.after ?? [])]);
  return rows;
}

export async function listOrdersByPatient(tx: Tx, tenantId: string, patientId: string, limit = 100): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2
    ORDER BY registered_at DESC NULLS FIRST, id LIMIT $3`, [tenantId, patientId, limit]);
  return rows;
}
