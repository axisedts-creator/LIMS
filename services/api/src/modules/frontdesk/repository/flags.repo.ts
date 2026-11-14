// frontdesk.order_flags (05-SCHEMA §3).
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'centre_id', 'order_id', 'kind', 'specimen_id', 'source_event_id', 'note'] as const;

export const insertOrderFlag = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.order_flags', COLS, tenantId, row);
/** FD-T12: insert-if-absent. ON CONFLICT (no target) covers both partial unique indexes (specimen / order scoped, D-6); a resolved row also blocks a re-insert. Returns the new row or null. */
export async function upsertOrderFlag(tx: Tx, tenantId: string, row: { id: string; centre_id: string; order_id: string; kind: string; specimen_id?: string; source_event_id?: string }): Promise<any | null> {
  const { rows } = await tx.query(`INSERT INTO frontdesk.order_flags (tenant_id, id, centre_id, order_id, kind, specimen_id, source_event_id, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT app.current_actor_id()), (SELECT app.current_actor_id())) ON CONFLICT DO NOTHING RETURNING *`,
  [tenantId, row.id, row.centre_id, row.order_id, row.kind, row.specimen_id ?? null, row.source_event_id ?? null]);
  return rows[0] ?? null;
}
export const getOrderFlagById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.order_flags', tenantId, id);

/** FD-T12 F23: the flag row locked FOR UPDATE (a racing resolve waits, then sees it resolved). */
export async function lockOrderFlagById(tx: Tx, tenantId: string, id: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.order_flags WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
  return rows[0] ?? null;
}

/** FD-T12 F23: open -> resolved, once (null when the version moved or it is already resolved). */
export async function resolveOrderFlagRow(tx: Tx, tenantId: string, id: string, expectedVersion: number,
  r: { resolutionCode: string; note?: string; at: Date; by: string }): Promise<any | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.order_flags SET status = 'resolved', resolution_code = $4, note = $5, resolved_at = $6, resolved_by = $7,
      version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'open' RETURNING *`, [tenantId, id, expectedVersion, r.resolutionCode, r.note ?? null, r.at, r.by]);
  return rows[0] ?? null;
}

/** FD-T12 F22 keyset page, newest first: (created_at, id) DESC; `sort_key` = µs-exact UTC text for the cursor. Values are always bound parameters. */
export async function pageOrderFlags(tx: Tx, tenantId: string, f: { status: string; kind?: string; centreId?: string; scopeCentreIds?: readonly string[] },
  o: { limit: number; after?: readonly [string, string] }): Promise<any[]> {
  const v: unknown[] = [tenantId, o.limit + 1, f.status];
  const p = (x: unknown): string => `$${v.push(x)}`;
  const w = ['tenant_id = $1', 'status = $3'];
  if (f.scopeCentreIds) w.push(`centre_id = ANY(${p(f.scopeCentreIds)}::uuid[])`);
  if (f.kind) w.push(`kind = ${p(f.kind)}`);
  if (f.centreId) w.push(`centre_id = ${p(f.centreId)}::uuid`);
  if (o.after) w.push(`(created_at, id) < (${p(o.after[0])}::timestamptz, ${p(o.after[1])}::uuid)`);
  const { rows } = await tx.query(`SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key FROM frontdesk.order_flags
    WHERE ${w.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $2`, v);
  return rows;
}

export async function listOrderFlagsByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.order_flags WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
