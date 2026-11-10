// frontdesk.orders (05-SCHEMA §3). Explicit tenant_id filter on every statement; RLS (tenant + centre) is the backstop.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'branch_id', 'centre_id', 'patient_id', 'registration_no', 'status', 'visit_type', 'billing_mode', 'credit_party_id', 'referrer_id',
  'priority', 'collection_mode', 'source', 'source_ref_id', 'partner_id', 'age_years', 'age_months', 'age_days', 'is_first_order_of_patient',
  'catalog_revision', 'items_version', 'scheduled_at', 'registered_at', 'requires_credit_note'] as const;

export const insertOrder = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.orders', COLS, tenantId, row);
export const getOrderById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.orders', tenantId, id);

export async function listOrdersByPatient(tx: Tx, tenantId: string, patientId: string, limit = 100): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2
    ORDER BY registered_at DESC NULLS FIRST, id LIMIT $3`, [tenantId, patientId, limit]);
  return rows;
}
