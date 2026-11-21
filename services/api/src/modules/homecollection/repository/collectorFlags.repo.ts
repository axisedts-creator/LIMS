// T0B-SALES-1 (LD-321): homecollection.collector_flags, one row per membership (Allow Collection / Allow Pickup). No row = both true (migration 20261117210000).
import type { Tx } from './shared.repo.js';

export interface CollectorFlags { allow_collection: boolean; allow_pickup: boolean }

const SELECT_FLAGS = 'SELECT membership_id, allow_collection, allow_pickup FROM homecollection.collector_flags WHERE tenant_id = $1 AND membership_id = ANY($2::uuid[])';
// create-or-change in one statement; a flag sent as null keeps its stored value (or the default true on create)
const UPSERT_FLAGS = `INSERT INTO homecollection.collector_flags (id, tenant_id, membership_id, allow_collection, allow_pickup, created_by, updated_by)
  VALUES ($1, $2, $3, COALESCE($4::boolean, true), COALESCE($5::boolean, true), $6, $6)
  ON CONFLICT (tenant_id, membership_id) DO UPDATE SET allow_collection = COALESCE($4::boolean, homecollection.collector_flags.allow_collection),
    allow_pickup = COALESCE($5::boolean, homecollection.collector_flags.allow_pickup), version = homecollection.collector_flags.version + 1, updated_at = now(), updated_by = $6
  RETURNING membership_id, allow_collection, allow_pickup`;

/** flags of the given memberships of the tenant; absent ids have no row (= both true). One statement for any number of ids. */
export async function getCollectorFlags(tx: Tx, tenantId: string, membershipIds: readonly string[]): Promise<Map<string, CollectorFlags>> {
  if (membershipIds.length === 0) return new Map();
  const { rows } = await tx.query(SELECT_FLAGS, [tenantId, [...membershipIds]]);
  return new Map(rows.map((r: any) => [String(r.membership_id), { allow_collection: r.allow_collection === true, allow_pickup: r.allow_pickup === true }]));
}

/** The FK to core.memberships(tenant_id, id) refuses unknown / foreign ids (23503). */
export async function upsertCollectorFlags(tx: Tx, tenantId: string, row: { id: string; membershipId: string; allowCollection: boolean | null; allowPickup: boolean | null; actorId: string }): Promise<any> {
  const { rows } = await tx.query(UPSERT_FLAGS, [row.id, tenantId, row.membershipId, row.allowCollection, row.allowPickup, row.actorId]);
  return rows[0];
}
