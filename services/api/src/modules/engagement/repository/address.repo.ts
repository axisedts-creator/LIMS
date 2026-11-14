// engagement.addresses for E37-E40 and the home-address check of E33 (T-BK1; 05-SCHEMA addresses: P2 PII, account_id NULL = staff-entered, table matrix S I U: no DELETE, rows are deactivated).
// PAT_ACC shows a patient only account_id = its own; every statement still binds tenant_id AND account_id (REQ-SEC-024). The address text never goes to a log, a URL or an event payload (REQ-SEC-098).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;

const COLS = 'id, patient_id, label, address_text, landmark, municipality, ward_no, district, contact_phone_e164, is_active, version';
export interface AddressValues { label: string; addressText: string; landmark: string | null; municipality: string | null; wardNo: number | null; district: string | null; phone: string | null }

/** The caller's ACTIVE addresses (staff-entered, other accounts' and deactivated ones are absent). */
export async function listMine(tx: Q, a: { tenantId: string; accountId: string }): Promise<Row[]> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.addresses WHERE tenant_id = $1 AND account_id = $2 AND is_active = true ORDER BY created_at, id LIMIT 10`, [a.tenantId, a.accountId]);
  return rows;
}
export async function countActive(tx: Q, a: { tenantId: string; accountId: string }): Promise<number> {
  const { rows } = await tx.query('SELECT count(*) FROM engagement.addresses WHERE tenant_id = $1 AND account_id = $2 AND is_active = true', [a.tenantId, a.accountId]);
  return Number(rows[0]?.['count'] ?? 0);
}
/** One of the account's OWN addresses, active or not (the caller decides what an inactive one means). */
export async function getMine(tx: Q, a: { tenantId: string; accountId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.addresses WHERE tenant_id = $1 AND account_id = $2 AND id = $3`, [a.tenantId, a.accountId, a.id]);
  return rows[0];
}
export async function insert(tx: Q, a: { tenantId: string; userId: string; accountId: string; patientId: string; v: AddressValues }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.addresses (id, tenant_id, account_id, patient_id, label, address_text, landmark, municipality, ward_no, district, contact_phone_e164, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, a.accountId, a.patientId, a.v.label, a.v.addressText, a.v.landmark, a.v.municipality, a.v.wardNo, a.v.district, a.v.phone, a.userId]);
  return rows[0]!;
}
/** PUT = full replacement of the text fields; patient_id is immutable (enforce_mutable_columns). undefined = lost a race on the version. */
export async function update(tx: Q, a: { tenantId: string; userId: string; accountId: string; id: string; expectedVersion: number; v: AddressValues }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.addresses SET label = $5, address_text = $6, landmark = $7, municipality = $8, ward_no = $9, district = $10, contact_phone_e164 = $11, version = version + 1, updated_at = now(), updated_by = $12
     WHERE tenant_id = $1 AND account_id = $2 AND id = $3 AND version = $4 AND is_active = true RETURNING ${COLS}`,
    [a.tenantId, a.accountId, a.id, a.expectedVersion, a.v.label, a.v.addressText, a.v.landmark, a.v.municipality, a.v.wardNo, a.v.district, a.v.phone, a.userId]);
  return rows[0];
}
export async function deactivate(tx: Q, a: { tenantId: string; userId: string; accountId: string; id: string; expectedVersion: number }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.addresses SET is_active = false, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND account_id = $2 AND id = $3 AND version = $4 AND is_active = true RETURNING ${COLS}`,
    [a.tenantId, a.accountId, a.id, a.expectedVersion, a.userId]);
  return rows[0];
}
