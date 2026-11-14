// engagement.membership_plans / patient_memberships / number_counters (card_no) (+ account_patient_links read for E47) for M1-M5, E47
// (02-TRD §4.12, §5; 05-SCHEMA §2 memberships; table matrix: S I U, no DELETE). REQ-SEC-024: every statement binds tenant_id in addition to RLS.
// Static SQL, values are parameters. Statements stay single-table (no JOIN / sub-select) so the in-house FakeDb interprets them.
// No `catalog.*` / `v_pub_*` read anywhere (08 R25 / A17 P-21): the price list is validated through CatalogPort in the service.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;

const PLAN_COLS = 'id, code, display_name, description, price_list_id, validity_days, is_active, version';
const MEM_COLS = 'id, patient_id, plan_id, card_no, card_token, status, valid_from, valid_to, cancelled_at, cancel_reason_code, version';

// ---- plans
export async function listPlans(tx: Q, a: { tenantId: string; isActive?: boolean }): Promise<Row[]> {
  const { rows } = a.isActive === undefined
    ? await tx.query(`SELECT ${PLAN_COLS} FROM engagement.membership_plans WHERE tenant_id = $1 ORDER BY code`, [a.tenantId])
    : await tx.query(`SELECT ${PLAN_COLS} FROM engagement.membership_plans WHERE tenant_id = $1 AND is_active = $2 ORDER BY code`, [a.tenantId, a.isActive]);
  return rows;
}
export async function getPlan(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${PLAN_COLS} FROM engagement.membership_plans WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}
export async function plansByIds(tx: Q, a: { tenantId: string; ids: readonly string[] }): Promise<Row[]> {
  if (a.ids.length === 0) return [];
  const { rows } = await tx.query('SELECT id, display_name FROM engagement.membership_plans WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [a.tenantId, [...a.ids]]);
  return rows;
}
export interface PlanValues { code: string; display_name: string; description: string | null; price_list_id: string; validity_days: number; is_active: boolean }
export async function insertPlan(tx: Q, a: { tenantId: string; userId: string; v: PlanValues }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.membership_plans (id, tenant_id, code, display_name, description, price_list_id, validity_days, is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${PLAN_COLS}`,
    [uuidv7(), a.tenantId, a.v.code, a.v.display_name, a.v.description, a.v.price_list_id, a.v.validity_days, a.v.is_active, a.userId]);
  return rows[0]!;
}
/** undefined = version mismatch (or no row). */
export async function updatePlan(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number; v: PlanValues }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.membership_plans SET code = $4, display_name = $5, description = $6, price_list_id = $7, validity_days = $8, is_active = $9,
       version = version + 1, updated_at = now(), updated_by = $10
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${PLAN_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.v.code, a.v.display_name, a.v.description, a.v.price_list_id, a.v.validity_days, a.v.is_active, a.userId]);
  return rows[0];
}

// ---- cards
/** 'MB{yy}{seq:6}' source: row created if absent, then the increment takes the row lock, so concurrent writers get distinct numbers. */
export async function nextCardSeq(tx: Q, a: { tenantId: string; userId: string; yy: string }): Promise<number> {
  const key = `card_no:${a.yy}`;
  await tx.query('INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, created_by) VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING', [a.tenantId, key, a.userId]);
  const { rows } = await tx.query('UPDATE engagement.number_counters SET last_value = last_value + 1, updated_at = now() WHERE tenant_id = $1 AND counter_key = $2 RETURNING last_value', [a.tenantId, key]);
  return Number(rows[0]!['last_value']);
}
export async function cardNoTaken(tx: Q, a: { tenantId: string; cardNo: string }): Promise<boolean> {
  const { rows } = await tx.query('SELECT id FROM engagement.patient_memberships WHERE tenant_id = $1 AND card_no = $2', [a.tenantId, a.cardNo]);
  return rows.length > 0;
}
export async function activeOf(tx: Q, a: { tenantId: string; patientId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query("SELECT id FROM engagement.patient_memberships WHERE tenant_id = $1 AND patient_id = $2 AND status = 'active'", [a.tenantId, a.patientId]);
  return rows[0];
}
export async function insertMembership(tx: Q, a: { tenantId: string; userId: string; patientId: string; planId: string; cardNo: string; cardToken: string; validFrom: string; validTo: string }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.patient_memberships (id, tenant_id, patient_id, plan_id, card_no, card_token, status, valid_from, valid_to, enrolled_by, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $9, $9) RETURNING ${MEM_COLS}`,
    [uuidv7(), a.tenantId, a.patientId, a.planId, a.cardNo, a.cardToken, a.validFrom, a.validTo, a.userId]);
  return rows[0]!;
}
export async function listOfPatient(tx: Q, a: { tenantId: string; patientId: string }): Promise<Row[]> {
  const { rows } = await tx.query(`SELECT ${MEM_COLS} FROM engagement.patient_memberships WHERE tenant_id = $1 AND patient_id = $2 ORDER BY valid_from DESC`, [a.tenantId, a.patientId]);
  return rows;
}
export async function getMembership(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${MEM_COLS} FROM engagement.patient_memberships WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}
export async function findByToken(tx: Q, a: { tenantId: string; cardToken: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${MEM_COLS} FROM engagement.patient_memberships WHERE tenant_id = $1 AND card_token = $2`, [a.tenantId, a.cardToken]);
  return rows[0];
}
export async function findByCardNo(tx: Q, a: { tenantId: string; cardNo: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${MEM_COLS} FROM engagement.patient_memberships WHERE tenant_id = $1 AND card_no = $2`, [a.tenantId, a.cardNo]);
  return rows[0];
}
/** undefined = version mismatch, row no longer active, or no row. */
export async function cancel(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number; reason: string; now: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.patient_memberships SET status = 'cancelled', cancelled_at = $5, cancel_reason_code = $6, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'active' RETURNING ${MEM_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.userId, a.now, a.reason]);
  return rows[0];
}

// ---- E47 (patient actor; RLS limits these to the caller's own account / active links)
export async function accountByMembership(tx: Q, a: { tenantId: string; membershipId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT id FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2', [a.tenantId, a.membershipId]);
  return rows[0];
}
export async function activeLinks(tx: Q, a: { tenantId: string; accountId: string }): Promise<Row[]> {
  const { rows } = await tx.query("SELECT id, patient_id FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = 'active'", [a.tenantId, a.accountId]);
  return rows;
}
export async function ofPatients(tx: Q, a: { tenantId: string; patientIds: readonly string[] }): Promise<Row[]> {
  if (a.patientIds.length === 0) return [];
  const { rows } = await tx.query(`SELECT ${MEM_COLS} FROM engagement.patient_memberships WHERE tenant_id = $1 AND patient_id = ANY($2::uuid[]) ORDER BY valid_from DESC`, [a.tenantId, [...a.patientIds]]);
  return rows;
}
