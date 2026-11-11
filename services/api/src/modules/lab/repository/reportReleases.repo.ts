// lab.report_releases reads/writes of the report-released consumer (T-27) + the status board read (T-27, #17). Tenant filter explicit (REQ-SEC-024).
// Release rows are insert-only (class A, 05-SCHEMA §1): the unique key (tenant_id, report_id, version_no) is the redelivery guard.
import { first, limitOf, query, type RepoCtx, type Row } from './base.repo.js';

export interface NewRelease {
  id: string; orderId: string; reportId: string; versionNo: number; reportKind: string; releasedAt: string; releaseBasis: string;
  orderItemIds: readonly string[] | null; eventId: string;
}

/** The order of the event, only if it exists for the ctx tenant (RLS + explicit filter): a foreign or unknown order is simply absent. */
export const orderExists = async (rc: RepoCtx, orderId: string): Promise<boolean> =>
  (await first(rc, 'SELECT 1 AS x FROM lab.orders WHERE tenant_id = $1 AND id = $2', [orderId])) !== null;

/** Highest version_no already recorded for the report (null = none). */
export const maxReleasedVersion = async (rc: RepoCtx, reportId: string): Promise<number | null> => {
  const r = await first(rc, 'SELECT max(version_no) AS v FROM lab.report_releases WHERE tenant_id = $1 AND report_id = $2', [reportId]);
  return r?.['v'] == null ? null : Number(r['v']);
};

/** Insert once: a redelivery (same report_id + version_no) conflicts and returns null; a concurrent twin waits for the first commit, then also returns null. */
export const insertReleaseOnce = async (rc: RepoCtx, r: NewRelease): Promise<Row | null> =>
  first(rc, `INSERT INTO lab.report_releases (id, tenant_id, order_id, report_id, version_no, report_kind, released_at, release_basis, order_item_ids, event_id, created_by)
             VALUES ($2, $1, $3, $4, $5, $6, $7::timestamptz, $8, $9::uuid[], $10, $11)
             ON CONFLICT ON CONSTRAINT report_releases__report_version__uq DO NOTHING RETURNING *`,
  [r.id, r.orderId, r.reportId, r.versionNo, r.reportKind, r.releasedAt, r.releaseBasis, r.orderItemIds === null ? null : [...r.orderItemIds], r.eventId, rc.actorId]);

/**
 * Active `approved` specimens of the order, row-locked in id order (S10 candidates). itemIds = null: every item of the order; else only specimens that carry an order test of a listed item
 * (ids of other orders / tenants match nothing because the order_tests are filtered by this order and tenant).
 */
export const lockApprovedSpecimensOfItems = (rc: RepoCtx, orderId: string, itemIds: readonly string[] | null) =>
  query(rc, `SELECT s.* FROM lab.specimens s WHERE s.tenant_id = $1 AND s.order_id = $2 AND s.status = 'approved' AND s.is_active
               AND ($3::uuid[] IS NULL OR EXISTS (SELECT 1 FROM lab.order_tests t WHERE t.tenant_id = s.tenant_id AND t.order_id = s.order_id AND t.specimen_id = s.id
                                                    AND t.order_item_id = ANY($3::uuid[])))
             ORDER BY s.id FOR UPDATE OF s`, [orderId, itemIds === null ? null : [...itemIds]]);

/** order_tests.reported_at for the `approved` tests of those items (the order_tests CHECK has no 'reported' status: status stays 'approved'). Returns the ids touched. */
export const markOrderTestsReported = async (rc: RepoCtx, orderId: string, itemIds: readonly string[] | null, at: string): Promise<string[]> =>
  (await query(rc, `UPDATE lab.order_tests SET reported_at = $4::timestamptz, version = version + 1, updated_at = now(), updated_by = $3
                     WHERE tenant_id = $1 AND order_id = $2 AND status = 'approved' AND reported_at IS NULL AND ($5::uuid[] IS NULL OR order_item_id = ANY($5::uuid[]))
                     RETURNING id`, [orderId, rc.actorId, at, itemIds === null ? null : [...itemIds]])).map((x) => x['id'] as string);

// ====================================================================== status board (#17, 03-APP-FLOW §1.5) ======================================================================
export interface BoardFilter { centreId?: string; scopeCentreIds?: readonly string[]; from: string; to: string }

/**
 * One row per order (registered_at in [from, to], centre in scope), derived on read. Keyset on (registered_at DESC, id DESC); fetches limit + 1.
 * live specimen = active and not rejected / recollection_ordered / discarded; received = status from `received` on; collected = collected | in_transit.
 * [CONV] latest approval = max(order_tests.approved_at); items = order tests not excluded/cancelled; printed = a release at/after the latest approval (any report_kind) once something was received;
 * rejected_specimens = `rejected` / `recollection_ordered` specimens that no received replacement (replaces_specimen_id) follows.
 */
export function pageStatusBoard(rc: RepoCtx, f: BoardFilter, o: { limit: number; statuses?: readonly string[]; after?: { key: string; id: string } }) {
  const vals: unknown[] = [];
  const v = (x: unknown) => { vals.push(x); return `$${vals.length + 1}`; };       // $1 = tenant
  const where = ['o.tenant_id = $1', `o.registered_at >= ${v(f.from)}::timestamptz`, `o.registered_at <= ${v(f.to)}::timestamptz`];
  if (f.centreId) where.push(`o.centre_id = ${v(f.centreId)}`);
  if (f.scopeCentreIds) where.push(`o.centre_id = ANY(${v([...f.scopeCentreIds])}::uuid[])`);
  if (o.after) where.push(`(o.registered_at, o.id) < (${v(o.after.key)}::timestamptz, ${v(o.after.id)}::uuid)`);
  const outer = o.statuses?.length ? `WHERE b.board_status = ANY(${v([...o.statuses])}::text[])` : '';
  const limit = limitOf(o.limit + 1);
  return query(rc, `
    SELECT b.* FROM (
      SELECT o.id AS order_id, o.registration_no, o.patient_id, o.centre_id, o.priority, o.registered_at, o.registered_at::text AS sort_key, rel.last_released_at,
             CASE
               WHEN sp.received_n > 0 AND rel.last_released_at IS NOT NULL AND (ot.latest_approval IS NULL OR rel.last_released_at >= ot.latest_approval) THEN 'printed'
               WHEN ot.items_n > 0 AND ot.unapproved_n = 0 THEN 'ready'
               WHEN sp.received_n > 0 THEN 'in_lab'
               WHEN sp.collected_n > 0 THEN 'collected'
               ELSE 'waiting' END AS board_status,
             LEAST(sp.rejected_n, 200)::int AS rejected_specimens
        FROM lab.orders o
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE s.is_active AND s.status IN ('received','aliquoted','in_process','resulted','verified','approved','reported','stored'))::int AS received_n,
                 count(*) FILTER (WHERE s.is_active AND s.status IN ('collected','in_transit'))::int AS collected_n,
                 count(*) FILTER (WHERE s.status IN ('rejected','recollection_ordered') AND NOT EXISTS (SELECT 1 FROM lab.specimens r WHERE r.tenant_id = s.tenant_id AND r.replaces_specimen_id = s.id
                                                                                AND r.status IN ('received','aliquoted','in_process','resulted','verified','approved','reported','stored')))::int AS rejected_n
            FROM lab.specimens s WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id) sp
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE t.status NOT IN ('excluded','cancelled'))::int AS items_n,
                 count(*) FILTER (WHERE t.status NOT IN ('excluded','cancelled','approved'))::int AS unapproved_n,
                 max(t.approved_at) AS latest_approval
            FROM lab.order_tests t WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id) ot
        LEFT JOIN LATERAL (SELECT max(r.released_at) AS last_released_at FROM lab.report_releases r WHERE r.tenant_id = o.tenant_id AND r.order_id = o.id) rel ON true
       WHERE ${where.join(' AND ')}) b
     ${outer}
     ORDER BY b.registered_at DESC, b.order_id DESC LIMIT ${v(limit)}`, vals);
}
