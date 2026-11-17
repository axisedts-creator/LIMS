// homecollection.booking_refs (05-SCHEMA §4). Natural key (tenant_id, booking_id).
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.booking_refs';
const INSERT_COLS = ['id', 'booking_id', 'state', 'last_seq', 'visit_id', 'is_active'] as const;
const UPDATE_COLS = ['state', 'last_seq', 'visit_id', 'is_active', 'updated_by'] as const;

export const insertBookingRef = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
export const getBookingRefById = (tx: Tx, tenantId: string, bookingRefId: string) => getRowById(tx, T, tenantId, bookingRefId);
export const updateBookingRef = (tx: Tx, tenantId: string, bookingRefId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, bookingRefId, expectedVersion, patch);

export async function getBookingRefByBookingId(tx: Tx, tenantId: string, bookingId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.booking_refs WHERE tenant_id = $1 AND booking_id = $2', [tenantId, bookingId]);
  return rows[0] ?? null;
}
