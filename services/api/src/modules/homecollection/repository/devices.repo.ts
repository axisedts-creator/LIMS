// homecollection.devices (05-SCHEMA §4). id / membership_id / platform / registered_at are immutable through this repo.
import { insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.devices';
const INSERT_COLS = ['id', 'membership_id', 'platform', 'os_version', 'app_version', 'model', 'status', 'registered_at', 'last_seen_at', 'last_snapshot_at', 'last_push_at',
  'last_ack_at', 'last_ack_cursor', 'max_device_seq_received', 'wipe_requested_at', 'wipe_requested_by', 'wipe_reason_code', 'wipe_reason_text', 'wiped_at',
  'signed_off_at', 'is_active'] as const;
const UPDATE_COLS = ['os_version', 'app_version', 'model', 'status', 'last_seen_at', 'last_snapshot_at', 'last_push_at', 'last_ack_at', 'last_ack_cursor',
  'max_device_seq_received', 'wipe_requested_at', 'wipe_requested_by', 'wipe_reason_code', 'wipe_reason_text', 'wiped_at', 'signed_off_at', 'is_active', 'updated_by'] as const;

export const insertDevice = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
/** Register race (HC-T10): null when the id already exists (any tenant) — the caller re-reads inside its own tenant. No unique-violation leaves the tx aborted. */
export const insertDeviceIfAbsent = (tx: Tx, tenantId: string, row: Record<string, unknown>) =>
  insertRow(tx, T, INSERT_COLS, tenantId, row, { doNothingOnConflict: 'id' });
export async function getDeviceById(tx: Tx, tenantId: string, deviceId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.devices WHERE tenant_id = $1 AND id = $2', [tenantId, deviceId]);
  return rows[0] ?? null;
}
/** H16 page (HC-T15): newest registered first, keyset on (registered_at, id); `sort_key` is registered_at::text (microseconds kept) for the opaque cursor. Fetches `limit` rows (caller asks limit + 1). */
export async function listDevicesPage(tx: Tx, tenantId: string, f: { status?: string; membershipId?: string; limit: number; after?: { key: string; id: string } }): Promise<any[]> {
  const v: unknown[] = [tenantId]; const w = ['tenant_id = $1'];
  if (f.status !== undefined) { v.push(f.status); w.push(`status = $${v.length}`); }
  if (f.membershipId !== undefined) { v.push(f.membershipId); w.push(`membership_id = $${v.length}`); }
  if (f.after) { v.push(f.after.key, f.after.id); w.push(`(registered_at, id) < ($${v.length - 1}::timestamptz, $${v.length}::uuid)`); }
  v.push(f.limit);
  const { rows } = await tx.query(`SELECT *, registered_at::text AS sort_key FROM homecollection.devices WHERE ${w.join(' AND ')} ORDER BY registered_at DESC, id DESC LIMIT $${v.length}`, v);
  return rows;
}
export const updateDevice =(tx: Tx, tenantId: string, deviceId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, deviceId, expectedVersion, patch);
