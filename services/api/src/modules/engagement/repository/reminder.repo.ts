// engagement.reminders (05-SCHEMA §2.x; 02-TRD §4.11). Static SQL only; values are always parameters; no DELETE (reminders are never deleted).
// REQ-SEC-024: all statements bind tenant_id.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
const COLS = 'id, patient_id, kind, reason_code, source, due_at, status, sent_at, failure_code, version';

export async function insertReminder(tx: Q, a: { tenantId: string; userId: string; patientId: string; kind: 'custom' | 'follow_up'; reasonCode: string; sourceRefId: string | null; dueAt: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.reminders (id, tenant_id, patient_id, kind, reason_code, source, source_ref_id, source_ref_seq, due_at, status, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'staff', $6, 0, $7, 'scheduled', 1, $8, $8) RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, a.patientId, a.kind, a.reasonCode, a.sourceRefId, a.dueAt, a.userId]);
  return rows[0];
}

export async function getReminder(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.reminders WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}

/** undefined = version or status changed under us. */
export async function cancelReminder(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.reminders SET status = 'cancelled', version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'scheduled' RETURNING ${COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.userId]);
  return rows[0];
}

/** T-B5: H of the booking reminder; undefined = no settings row. */
export async function bookingReminderHours(tx: Q, a: { tenantId: string }): Promise<number | undefined> {
  const { rows } = await tx.query('SELECT booking_reminder_hours_before FROM engagement.settings WHERE tenant_id = $1', [a.tenantId]);
  return rows[0]?.['booking_reminder_hours_before'];
}

/** T-B5: kind 'booking' row; idempotent on the partial unique (tenant, kind, source_ref_id, source_ref_seq): undefined = already there. */
export async function insertBookingReminder(tx: Q, a: { tenantId: string; userId: string; patientId: string; bookingId: string; dueAt: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.reminders (id, tenant_id, patient_id, kind, reason_code, source, source_ref_id, source_ref_seq, due_at, status, version, created_by, updated_by)
     VALUES ($1, $2, $3, 'booking', NULL, 'booking', $4, 0, $5, 'scheduled', 1, $6, $6) ON CONFLICT DO NOTHING RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, a.patientId, a.bookingId, a.dueAt, a.userId]);
  return rows[0];
}

/** T-B5: scheduled booking reminders of one booking -> cancelled; returns how many. Sent / suppressed / failed rows are never touched. */
export async function cancelBookingReminders(tx: Q, a: { tenantId: string; userId: string; bookingId: string }): Promise<number> {
  const { rows } = await tx.query(
    `UPDATE engagement.reminders SET status = 'cancelled', version = version + 1, updated_at = now(), updated_by = $3
     WHERE tenant_id = $1 AND kind = 'booking' AND source_ref_id = $2 AND status = 'scheduled' RETURNING id`,
    [a.tenantId, a.bookingId, a.userId]);
  return rows.length;
}

/** Keyset page (due_at, id). Optional filters add fixed SQL fragments; their values are parameters. Fetches `limit` rows as given (caller asks for limit + 1). */
export async function listReminders(tx: Q, a: { tenantId: string; from: string; to: string; patientId?: string | undefined; status?: string | undefined; after?: { dueAt: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [a.tenantId, a.from, a.to];
  let where = 'tenant_id = $1 AND due_at BETWEEN $2 AND $3';
  if (a.patientId) { v.push(a.patientId); where += ` AND patient_id = $${v.length}`; }
  if (a.status) { v.push(a.status); where += ` AND status = $${v.length}`; }
  if (a.after) { v.push(a.after.dueAt, a.after.id); where += ` AND (due_at, id) > ($${v.length - 1}::timestamptz, $${v.length}::uuid)`; }
  v.push(a.limit);
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.reminders WHERE ${where} ORDER BY due_at, id LIMIT $${v.length}`, v);
  return rows;
}
