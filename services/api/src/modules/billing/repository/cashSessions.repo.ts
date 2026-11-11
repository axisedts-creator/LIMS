// billing.cash_sessions. One open session per (membership, centre): cash_sessions__tenant_id_open__p_uq. open -> closed only (DB guard).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getCashSession(tx: Q, a: { tenantId: string; sessionId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.cash_sessions WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.sessionId]);
  return rows[0];
}

/** `centreId` omitted = any centre (B17 "my current session" has no centre parameter): the newest. */
export async function findOpenCashSession(tx: Q, a: { tenantId: string; membershipId: string; centreId?: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = a.centreId === undefined
    ? await tx.query(`SELECT * FROM billing.cash_sessions WHERE tenant_id = $1 AND membership_id = $2 AND status = 'open' ORDER BY opened_at DESC, id DESC LIMIT 1`, [a.tenantId, a.membershipId])
    : await tx.query(`SELECT * FROM billing.cash_sessions WHERE tenant_id = $1 AND membership_id = $2 AND centre_id = $3 AND status = 'open'`, [a.tenantId, a.membershipId, a.centreId]);
  return rows[0];
}

/** undefined = a concurrent transaction opened the session first (the caller re-reads it). No error, so the caller's transaction is not aborted. */
export async function insertCashSession(tx: Q, a: { id: string; tenantId: string; branchId: string; centreId: string; membershipId: string; openedAt: string; userId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO billing.cash_sessions (id, tenant_id, branch_id, centre_id, membership_id, status, opened_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $7)
     ON CONFLICT (tenant_id, membership_id, centre_id) WHERE status = 'open' DO NOTHING RETURNING *`,
    [a.id, a.tenantId, a.branchId, a.centreId, a.membershipId, a.openedAt, a.userId]);
  return rows[0];
}

export interface CloseCashSession {
  readonly tenantId: string; readonly sessionId: string; readonly expectedVersion: number;
  readonly expected: ReadonlyArray<{ method_code: string; amount_paisa: number }>; readonly counted: ReadonlyArray<{ method_code: string; amount_paisa: number }>;
  readonly variancePaisa: number; readonly note?: string; readonly closedAt: string; readonly userId: string;
}

/** undefined = the version moved or the session is not open any more (caller: common.version_conflict). */
export async function closeCashSession(tx: Q, a: CloseCashSession): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    `UPDATE billing.cash_sessions SET status = 'closed', closed_at = $4::timestamptz, expected = $5::jsonb, counted = $6::jsonb, variance_paisa = $7, close_note = $8,
       updated_at = now(), updated_by = $9, version = version + 1
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'open' RETURNING *`,
    [a.tenantId, a.sessionId, a.expectedVersion, a.closedAt, JSON.stringify(a.expected), JSON.stringify(a.counted), a.variancePaisa, a.note ?? null, a.userId]);
  return rows[0];
}

/** B18 sessions[]: sessions opened on `businessDate` in the tenant time zone (a bound value). */
export async function listCashSessionsForDay(tx: Q, a: { tenantId: string; businessDate: string; timezone: string; centreId?: string; membershipId?: string }): Promise<Record<string, unknown>[]> {
  const p: unknown[] = [a.tenantId, a.timezone, a.businessDate];
  const conds = ['s.tenant_id = $1', '(s.opened_at AT TIME ZONE $2)::date = $3::date'];
  if (a.centreId !== undefined) { p.push(a.centreId); conds.push('s.centre_id = $' + p.length); }
  if (a.membershipId !== undefined) { p.push(a.membershipId); conds.push('s.membership_id = $' + p.length); }
  return (await tx.query('SELECT s.* FROM billing.cash_sessions s WHERE ' + conds.join(' AND ') + ' ORDER BY s.opened_at, s.id LIMIT 200', p)).rows;
}
