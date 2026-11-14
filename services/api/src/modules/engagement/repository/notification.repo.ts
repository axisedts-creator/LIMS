// engagement.notifications (05-SCHEMA notifications; 02-TRD §4.9). Static SQL only; values are always parameters. No text column exists and none is selected.
// Account scoping is RLS (PAT_ACC, 05-SCHEMA §8): every statement runs in the patient's tx, so a foreign account's row is simply not visible.
// The only write is `read_at` (enforce_mutable_columns trigger allows nothing else). REQ-SEC-024: all statements bind tenant_id.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
const COLS = 'id, patient_id, kind, entity_type, entity_id, route_id, read_at, created_at';

/** Newest first; `after` = keyset (created_at, id) of the last row of the previous page. */
export async function listNotifications(tx: Q, a: { tenantId: string; unreadOnly: boolean; after?: { createdAt: string; id: string }; limit: number }): Promise<Row[]> {
  const values: unknown[] = [a.tenantId];
  let where = 'tenant_id = $1';
  if (a.unreadOnly) where += ' AND read_at IS NULL';
  if (a.after) { values.push(a.after.createdAt, a.after.id); where += ` AND (created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`; }
  values.push(a.limit);
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
  return rows;
}

/** link id per patient of this account (profile_id on the wire is the link id, never the patient id). */
export async function listLinkIds(tx: Q, a: { tenantId: string }): Promise<Row[]> {
  const { rows } = await tx.query('SELECT id, patient_id FROM engagement.account_patient_links WHERE tenant_id = $1', [a.tenantId]);
  return rows;
}

/** Which of these ids are visible to the caller (own account). */
export async function visibleIds(tx: Q, a: { tenantId: string; ids: string[] }): Promise<string[]> {
  const { rows } = await tx.query('SELECT id FROM engagement.notifications WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [a.tenantId, a.ids]);
  return rows.map((r: Row) => r['id'] as string);
}

/** First read wins: an already-read row is left as it is. */
export async function markRead(tx: Q, a: { tenantId: string; id: string; readAt: string }): Promise<void> {
  await tx.query('UPDATE engagement.notifications SET read_at = $3 WHERE tenant_id = $1 AND id = $2 AND read_at IS NULL', [a.tenantId, a.id, a.readAt]);
}
