// homecollection.routes (05-SCHEMA §4). Unique (tenant_id, centre_id, phlebotomist_membership_id, route_date).
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.routes';
const INSERT_COLS = ['id', 'centre_id', 'phlebotomist_membership_id', 'route_date', 'last_snapshot_at', 'last_ack_at', 'is_active'] as const;
const UPDATE_COLS = ['last_snapshot_at', 'last_ack_at', 'is_active', 'updated_by'] as const;

export const insertRoute = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
export const getRouteById = (tx: Tx, tenantId: string, routeId: string) => getRowById(tx, T, tenantId, routeId);
export const updateRoute = (tx: Tx, tenantId: string, routeId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, routeId, expectedVersion, patch);

export async function getRouteByKey(tx: Tx, tenantId: string, centreId: string, membershipId: string, routeDate: string): Promise<any | null> {
  const { rows } = await tx.query(
    'SELECT * FROM homecollection.routes WHERE tenant_id = $1 AND centre_id = $2 AND phlebotomist_membership_id = $3 AND route_date = $4',
    [tenantId, centreId, membershipId, routeDate]);
  return rows[0] ?? null;
}

export async function listRoutesByMembershipDate(tx: Tx, tenantId: string, membershipId: string, routeDate: string): Promise<any[]> {
  const { rows } = await tx.query(
    'SELECT * FROM homecollection.routes WHERE tenant_id = $1 AND phlebotomist_membership_id = $2 AND route_date = $3 ORDER BY centre_id, id',
    [tenantId, membershipId, routeDate]);
  return rows;
}
