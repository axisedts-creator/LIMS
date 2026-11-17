// HC-T08 read queries over homecollection.visits / routes (H1 board page, H10 routes of a day, H12 per-phlebotomist load). Read-only.
// Static SQL: structure comes from constants (SORTS, filter fragments); every value is a $n parameter; tenant_id is $1 in every statement besides RLS (REQ-SEC-024).
import type { Tx } from './shared.repo.js';

export type SortCode = 'window_start' | '-window_start' | 'route_sequence' | 'created_at' | '-created_at';
export interface SortDef { readonly expr: string; readonly dir: 'ASC' | 'DESC'; readonly kind: 'ts' | 'int' }
/** Sort keys never are NULL (COALESCE) so a keyset cursor (key, id) stays total. */
export const SORTS: Readonly<Record<SortCode, SortDef>> = Object.freeze({
  window_start: { expr: "COALESCE(v.window_start, 'infinity'::timestamptz)", dir: 'ASC', kind: 'ts' },
  '-window_start': { expr: "COALESCE(v.window_start, 'infinity'::timestamptz)", dir: 'DESC', kind: 'ts' },
  route_sequence: { expr: 'COALESCE(v.route_sequence, 2147483647)', dir: 'ASC', kind: 'int' },
  created_at: { expr: 'v.created_at', dir: 'ASC', kind: 'ts' },
  '-created_at': { expr: 'v.created_at', dir: 'DESC', kind: 'ts' },
});

export interface VisitListQuery {
  routeDate?: string; windowFrom?: string; windowTo?: string; statuses?: readonly string[]; kinds?: readonly string[];
  centreId?: string; membershipId?: string; unassignedOnly?: boolean; hasOpenFlags?: boolean;
  /** phlebotomist-only actors (02-TRD §5.4 rule 2): hard filter on top of every other filter */
  onlyAssignedTo?: string;
  sort: SortCode; after?: { key: string; id: string }; limit: number;
}

// "received" = any specimen status at or past receipt that is not a rejection / discard
const RECEIVED = ['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored'];

/** One page of visits (+ open flag kinds, specimen counters, last device ack of the route). Returns at most `limit` rows and whether more follow. */
export async function listVisitsPage(tx: Tx, tenantId: string, q: VisitListQuery): Promise<{ rows: any[]; hasMore: boolean }> {
  const p: unknown[] = [tenantId];
  const bind = (v: unknown): string => { p.push(v); return `$${p.length}`; };
  const where: string[] = ['v.tenant_id = $1'];
  if (q.routeDate !== undefined) where.push(`v.route_date = ${bind(q.routeDate)}::date`);
  if (q.windowFrom !== undefined) where.push(`v.window_start >= ${bind(q.windowFrom)}::timestamptz`);
  if (q.windowTo !== undefined) where.push(`v.window_start <= ${bind(q.windowTo)}::timestamptz`);
  if (q.statuses) where.push(`v.status = ANY(${bind([...q.statuses])}::text[])`);
  if (q.kinds) where.push(`v.kind = ANY(${bind([...q.kinds])}::text[])`);
  if (q.centreId !== undefined) where.push(`v.centre_id = ${bind(q.centreId)}::uuid`);
  if (q.membershipId !== undefined) where.push(`v.assigned_membership_id = ${bind(q.membershipId)}::uuid`);
  if (q.onlyAssignedTo !== undefined) where.push(`v.assigned_membership_id = ${bind(q.onlyAssignedTo)}::uuid`);
  if (q.unassignedOnly === true) where.push("v.status = 'unassigned'");
  if (q.hasOpenFlags === true) where.push("EXISTS (SELECT 1 FROM homecollection.visit_flags xf WHERE xf.tenant_id = $1 AND xf.visit_id = v.id AND xf.status = 'open')");
  const s = SORTS[q.sort];
  const cmp = s.dir === 'ASC' ? '>' : '<';
  if (q.after) where.push(`(${s.expr}, v.id) ${cmp} (${bind(q.after.key)}::${s.kind === 'ts' ? 'timestamptz' : 'int'}, ${bind(q.after.id)}::uuid)`);
  const limit = bind(q.limit + 1);
  const { rows } = await tx.query(
    `SELECT v.*, v.route_date::text AS route_date_text, (${s.expr})::text AS sort_key,
       COALESCE((SELECT array_agg(DISTINCT f.kind::text) FROM homecollection.visit_flags f WHERE f.tenant_id = $1 AND f.visit_id = v.id AND f.status = 'open'), '{}'::text[]) AS open_flag_kinds,
       (SELECT count(*) FROM homecollection.visit_specimens s WHERE s.tenant_id = $1 AND s.visit_id = v.id AND s.is_active)::int AS sp_expected,
       (SELECT count(*) FROM homecollection.collections c WHERE c.tenant_id = $1 AND c.visit_id = v.id AND c.status = 'applied')::int AS sp_collected,
       (SELECT count(*) FROM homecollection.collections c WHERE c.tenant_id = $1 AND c.visit_id = v.id AND c.status = 'held')::int AS sp_held,
       (SELECT count(*) FROM homecollection.visit_specimens s WHERE s.tenant_id = $1 AND s.visit_id = v.id AND s.is_active AND s.status = ANY(${bind(RECEIVED)}::text[]))::int AS sp_received,
       (SELECT count(*) FROM homecollection.visit_specimens s WHERE s.tenant_id = $1 AND s.visit_id = v.id AND s.is_active AND s.status = 'rejected')::int AS sp_rejected,
       (SELECT r.last_ack_at FROM homecollection.routes r WHERE r.tenant_id = $1 AND r.id = v.route_id) AS last_device_ack_at
     FROM homecollection.visits v
     WHERE ${where.join(' AND ')}
     ORDER BY ${s.expr} ${s.dir}, v.id ${s.dir}
     LIMIT ${limit}`, p);
  return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

/** Routes of a day (optionally one centre / one phlebotomist) with their active visit ids in route order and the completed count. ≤ 200 rows. */
export async function listRoutesOfDay(tx: Tx, tenantId: string, f: { routeDate: string; centreId?: string; membershipId?: string }): Promise<any[]> {
  const p: unknown[] = [tenantId, f.routeDate];
  const bind = (v: unknown): string => { p.push(v); return `$${p.length}`; };
  const where = ['r.tenant_id = $1', 'r.route_date = $2::date'];
  if (f.centreId !== undefined) where.push(`r.centre_id = ${bind(f.centreId)}::uuid`);
  if (f.membershipId !== undefined) where.push(`r.phlebotomist_membership_id = ${bind(f.membershipId)}::uuid`);
  const { rows } = await tx.query(
    `SELECT r.*, r.route_date::text AS route_date_text,
       COALESCE((SELECT array_agg(v.id::text ORDER BY v.route_sequence, v.id) FROM homecollection.visits v
                  WHERE v.tenant_id = $1 AND v.route_id = r.id AND v.status IN ('assigned', 'in_progress')), '{}'::text[]) AS visit_ids,
       (SELECT count(*) FROM homecollection.visits v WHERE v.tenant_id = $1 AND v.route_id = r.id AND v.status = 'completed')::int AS completed_visits
     FROM homecollection.routes r
     WHERE ${where.join(' AND ')}
     ORDER BY r.centre_id, r.phlebotomist_membership_id, r.id
     LIMIT 200`, p);
  return rows;
}

/** Every collection fact of one visit, oldest first (H2 detail). */
export async function listCollectionsByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.collections WHERE tenant_id = $1 AND visit_id = $2 ORDER BY collected_at, id', [tenantId, visitId]);
  return rows;
}

/** Active (assigned | in_progress) visits per route of the given phlebotomists on a day, across every centre of the tenant (H12 route_full). */
export async function listActiveLoadByMembers(tx: Tx, tenantId: string, routeDate: string, membershipIds: readonly string[]): Promise<any[]> {
  const { rows } = await tx.query(
    `SELECT r.id AS route_id, r.centre_id, r.phlebotomist_membership_id AS membership_id,
       (SELECT count(*) FROM homecollection.visits v WHERE v.tenant_id = $1 AND v.route_id = r.id AND v.status IN ('assigned', 'in_progress'))::int AS active_visits
     FROM homecollection.routes r
     WHERE r.tenant_id = $1 AND r.route_date = $2::date AND r.phlebotomist_membership_id = ANY($3::uuid[])`,
    [tenantId, routeDate, [...membershipIds]]);
  return rows;
}
