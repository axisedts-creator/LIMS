// frontdesk.booking_links (05-SCHEMA §3), PK (tenant_id, source, source_ref_id).
import { insertRow, type Tx } from './shared.repo.js';

const COLS = ['source', 'source_ref_id', 'order_id', 'idempotency_key', 'state', 'last_seq'] as const;

export const insertBookingLink = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.booking_links', COLS, tenantId, row);

/** FD-T12: record the newest applied aggregate.seq (never lowers it) and optionally the state. */
export async function touchBookingLink(tx: Tx, tenantId: string, source: string, sourceRefId: string, seq: number, state?: 'converted' | 'cancelled'): Promise<void> {
  await tx.query(`UPDATE frontdesk.booking_links SET last_seq = GREATEST(last_seq, $4), state = COALESCE($5, state), version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND source = $2 AND source_ref_id = $3`, [tenantId, source, sourceRefId, seq, state ?? null]);
}

export async function getBookingLink(tx: Tx, tenantId: string, source: string, sourceRefId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.booking_links WHERE tenant_id = $1 AND source = $2 AND source_ref_id = $3',
    [tenantId, source, sourceRefId]);
  return rows[0] ?? null;
}
