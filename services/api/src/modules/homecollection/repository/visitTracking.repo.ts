// homecollection.visit_tracking (PHLEBO-UI-FULL-1): one row per visit, overwritten in place; only the latest position is kept.
import { insertRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visit_tracking';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'membership_id', 'booking_id', 'collector_display_name', 'state', 'started_at'] as const;
const STAMP = 'version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())';
const NO_POSITION = 'latitude = NULL, longitude = NULL, accuracy_m = NULL, position_at = NULL';

export type StopReason = 'arrived' | 'completed' | 'failed' | 'cancelled' | 'stopped';

export async function getTrackingByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_tracking WHERE tenant_id = $1 AND visit_id = $2', [tenantId, visitId]);
  return rows[0] ?? null;
}

/** The patient's read (RLS: only through a booking of the calling patient account). */
export async function getTrackingByBooking(tx: Tx, tenantId: string, bookingId: string): Promise<any | null> {
  const { rows } = await tx.query(
    'SELECT * FROM homecollection.visit_tracking WHERE tenant_id = $1 AND booking_id = $2 ORDER BY started_at DESC LIMIT 1', [tenantId, bookingId]);
  return rows[0] ?? null;
}

/** null when a row for the visit already exists: the caller then restarts it. */
export const insertTracking = (tx: Tx, tenantId: string, row: Record<string, unknown>) =>
  insertRow(tx, T, INSERT_COLS, tenantId, row, { doNothingOnConflict: 'tenant_id, visit_id' });

/** "On my way" again after a stop: same row, new start, no position yet. */
export async function restartTracking(tx: Tx, tenantId: string, visitId: string, a: { membershipId: string; displayName: string; startedAt: Date }): Promise<any | null> {
  const { rows } = await tx.query(
    `UPDATE homecollection.visit_tracking
        SET state = 'en_route', stop_reason = NULL, stopped_at = NULL, started_at = $3, membership_id = $4, collector_display_name = $5, ${NO_POSITION}, ${STAMP}
      WHERE tenant_id = $1 AND visit_id = $2 RETURNING *`,
    [tenantId, visitId, a.startedAt, a.membershipId, a.displayName]);
  return rows[0] ?? null;
}

/** Latest position; only while en route and only by the member who started it. */
export async function setTrackingPosition(tx: Tx, tenantId: string, visitId: string, membershipId: string,
  p: { latitude: string; longitude: string; accuracyM: number | null; at: Date }): Promise<any | null> {
  const { rows } = await tx.query(
    `UPDATE homecollection.visit_tracking
        SET latitude = $4, longitude = $5, accuracy_m = $6, position_at = $7, ${STAMP}
      WHERE tenant_id = $1 AND visit_id = $2 AND membership_id = $3 AND state = 'en_route' RETURNING *`,
    [tenantId, visitId, membershipId, p.latitude, p.longitude, p.accuracyM, p.at]);
  return rows[0] ?? null;
}

/** Stops sharing and clears the coordinates. No-op when not en route. Returns the number of rows stopped. */
export async function stopTracking(tx: Tx, tenantId: string, visitId: string, reason: StopReason, at: Date): Promise<number> {
  const r = await tx.query(
    `UPDATE homecollection.visit_tracking
        SET state = 'stopped', stop_reason = $3, stopped_at = $4, ${NO_POSITION}, ${STAMP}
      WHERE tenant_id = $1 AND visit_id = $2 AND state = 'en_route'`,
    [tenantId, visitId, reason, at]);
  return r.rowCount ?? 0;
}
