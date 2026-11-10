// frontdesk.booking_links (05-SCHEMA §3), PK (tenant_id, source, source_ref_id).
import { insertRow, type Tx } from './shared.repo.js';

const COLS = ['source', 'source_ref_id', 'order_id', 'idempotency_key', 'state', 'last_seq'] as const;

export const insertBookingLink = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.booking_links', COLS, tenantId, row);

export async function getBookingLink(tx: Tx, tenantId: string, source: string, sourceRefId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.booking_links WHERE tenant_id = $1 AND source = $2 AND source_ref_id = $3',
    [tenantId, source, sourceRefId]);
  return rows[0] ?? null;
}
