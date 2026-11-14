// HC-T16 cron reads/calls (02-TRD §10). Read-only selects for the sweep and the overdue-handover flagging, plus the retention DEFINER call. Writes reuse visits / visitFlags / visitAssignments / visitTransitions repos.
import type { Tx } from './shared.repo.js';

/**
 * sweep_missed_visits: `assigned` visits whose route_date is before today (the Kathmandu business date of `nowIso`, 08 A13 P-15), row-locked (FOR UPDATE OF v, id order).
 * pulled = the route's last_snapshot_at falls on the visit's route_date in Asia/Kathmandu (D-126); applied = an applied collection or mutation exists (V7 guard).
 * route_date_text is the date as text (no JS Date timezone shift).
 * ponytail: Asia/Kathmandu is the only business timezone of the programme (P-15); read tenant settings.timezone here if a second one ever ships.
 */
export async function listAssignedVisitsPastRouteDate(tx: Tx, tenantId: string, nowIso: string): Promise<any[]> {
  const { rows } = await tx.query(
    `SELECT v.*, v.route_date::text AS route_date_text,
            COALESCE((r.last_snapshot_at AT TIME ZONE 'Asia/Kathmandu')::date = v.route_date, false) AS pulled,
            (EXISTS (SELECT 1 FROM homecollection.collections c WHERE c.tenant_id = v.tenant_id AND c.visit_id = v.id AND c.status = 'applied')
             OR EXISTS (SELECT 1 FROM homecollection.mutations m WHERE m.tenant_id = v.tenant_id AND m.visit_id = v.id AND m.outcome = 'applied')) AS has_applied
       FROM homecollection.visits v
       LEFT JOIN homecollection.routes r ON r.tenant_id = v.tenant_id AND r.id = v.route_id
      WHERE v.tenant_id = $1 AND v.status = 'assigned' AND v.route_date < ($2::timestamptz AT TIME ZONE 'Asia/Kathmandu')::date
      ORDER BY v.id
        FOR UPDATE OF v`, [tenantId, nowIso]);
  return rows;
}

/** flag_overdue_handovers: visits with an applied collection older than `hours` and no handover_items row (any handover status). One row per visit. */
export async function listVisitsWithOverdueCollections(tx: Tx, tenantId: string, nowIso: string, hours: number): Promise<any[]> {
  const { rows } = await tx.query(
    `SELECT DISTINCT v.id AS visit_id, v.centre_id
       FROM homecollection.collections c
       JOIN homecollection.visits v ON v.tenant_id = c.tenant_id AND v.id = c.visit_id
      WHERE c.tenant_id = $1 AND c.status = 'applied'
        AND c.collected_at < $2::timestamptz - make_interval(hours => $3::int)
        AND NOT EXISTS (SELECT 1 FROM homecollection.handover_items hi WHERE hi.tenant_id = c.tenant_id AND hi.collection_id = c.id)
      ORDER BY v.id`, [tenantId, nowIso, hours]);
  return rows;
}

/** purge_retention: app.homecollection_anonymise_retired_visits(p_before) (05-SCHEMA §4.2; DEFINER, system claims, one tenant per call). Returns the two counts. */
export async function anonymiseRetiredVisits(tx: Tx, before: string): Promise<{ visits: number; handoverItems: number }> {
  const { rows } = await tx.query('SELECT visits_anonymised, handover_items_anonymised FROM app.homecollection_anonymise_retired_visits($1::timestamptz)', [before]);
  return { visits: Number(rows[0]?.visits_anonymised ?? 0), handoverItems: Number(rows[0]?.handover_items_anonymised ?? 0) };
}
