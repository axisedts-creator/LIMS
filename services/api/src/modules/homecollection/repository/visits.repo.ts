// homecollection.visits (05-SCHEMA §4). Update columns = the visits__mutable_columns trigger list; C0's transition guard enforces the state machine.
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visits';
const INSERT_COLS = ['id', 'centre_id', 'branch_id', 'kind', 'status', 'outcome', 'booking_id', 'parent_visit_id', 'recollection_of_specimen_id', 'patient_id',
  'order_id', 'order_registered_at', 'orderable_ids', 'referrer_id', 'home_address_id', 'address_text', 'landmark', 'latitude', 'longitude', 'note_for_phlebotomist',
  'window_start', 'window_end', 'route_id', 'route_date', 'route_sequence', 'assigned_membership_id', 'assigned_at', 'arrived_at', 'completed_at', 'failed_at',
  'cancelled_at', 'status_reason_code', 'status_reason_text', 'is_active'] as const;
const UPDATE_COLS = ['status', 'outcome', 'order_id', 'order_registered_at', 'address_text', 'landmark', 'latitude', 'longitude', 'note_for_phlebotomist',
  'window_start', 'window_end', 'route_id', 'route_date', 'route_sequence', 'assigned_membership_id', 'assigned_at', 'arrived_at', 'completed_at', 'failed_at',
  'cancelled_at', 'status_reason_code', 'status_reason_text', 'updated_by'] as const;

export const insertVisit = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
export const getVisitById = (tx: Tx, tenantId: string, visitId: string) => getRowById(tx, T, tenantId, visitId);
export const updateVisit = (tx: Tx, tenantId: string, visitId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, visitId, expectedVersion, patch);

/** HC-T12 push: row locks (SELECT ... FOR UPDATE) on the touched visits, taken in ascending id order (TRD §6.3 concurrency; deadlock avoidance). Invisible / unknown ids are simply absent. */
export async function lockVisitsForUpdate(tx: Tx, tenantId: string, visitIds: readonly string[]): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visits WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [tenantId, [...visitIds].sort()]);
  return rows;
}

export async function getVisitByBookingId(tx: Tx, tenantId: string, bookingId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visits WHERE tenant_id = $1 AND booking_id = $2', [tenantId, bookingId]);
  return rows[0] ?? null;
}

/** The oldest visit of the order (front_desk visit is unique per order; revisit/recollection visits are later). */
export async function getVisitByOrderId(tx: Tx, tenantId: string, orderId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visits WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id LIMIT 1', [tenantId, orderId]);
  return rows[0] ?? null;
}

export async function listVisitsByCentreStatus(tx: Tx, tenantId: string, centreId: string, status: string): Promise<any[]> {
  const { rows } = await tx.query(
    'SELECT * FROM homecollection.visits WHERE tenant_id = $1 AND centre_id = $2 AND status = $3 ORDER BY window_start NULLS LAST, id', [tenantId, centreId, status]);
  return rows;
}

export async function listVisitsByRoute(tx: Tx, tenantId: string, routeId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visits WHERE tenant_id = $1 AND route_id = $2 ORDER BY route_sequence, id', [tenantId, routeId]);
  return rows;
}
