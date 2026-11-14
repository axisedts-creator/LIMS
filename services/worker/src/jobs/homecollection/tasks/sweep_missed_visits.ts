// homecollection.sweep_missed_visits {tenant_id} (daily 00:20 Asia/Kathmandu, per_tenant; 02-TRD §10, 03-APP-FLOW V7 + E15, 08 A19 D-126, 08 A13 P-15): system actor.
// `assigned` visits with route_date < today (Kathmandu business date of ctx.now()):
//  - route pulled on its route_date (a phone holds the visit) or an applied collection/mutation exists (V7 guard) -> open flag `missed` only, the visit stays `assigned`;
//  - otherwise -> `unassigned` (route fields cleared, order kept) + visit_assignments `missed` + transition assigned->unassigned cause `cron` + flag `missed` + old route version++.
// Re-runs add nothing (flag ON CONFLICT DO NOTHING, a swept visit is no longer `assigned`). Runs in the delivery transaction: a failure rolls the whole sweep back. Logs counts only.
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { listAssignedVisitsPastRouteDate } from '../../../../../api/src/modules/homecollection/repository/housekeeping.repo.js';
import { insertVisitAssignment } from '../../../../../api/src/modules/homecollection/repository/visitAssignments.repo.js';
import { insertOpenVisitFlagIfAbsent } from '../../../../../api/src/modules/homecollection/repository/visitFlags.repo.js';
import { insertVisitTransition } from '../../../../../api/src/modules/homecollection/repository/visitTransitions.repo.js';
import { updateVisit } from '../../../../../api/src/modules/homecollection/repository/visits.repo.js';
import { bumpVersion } from '../../../../../api/src/modules/homecollection/route.service.js';

export const sweepMissedVisits: TaskHandler = async (payload, ctx: any) => {
  if (payload?.tenant_id !== ctx.tenantId) return;                                       // another tenant's / malformed payload: resolve, write nothing
  const now: string = ctx.now();
  const routeIds = new Set<string>();
  let returned = 0; let flagged = 0;
  for (const v of await listAssignedVisitsPastRouteDate(ctx.tx, ctx.tenantId, now)) {
    if (!v['pulled'] && !v['has_applied']) {
      const row = await updateVisit(ctx.tx, ctx.tenantId, v['id'], Number(v['version']), { status: 'unassigned', route_id: null, route_date: null, route_sequence: null,
        assigned_membership_id: null, assigned_at: null });                              // order_id / booking_id stay; row is locked, so the version matches
      if (!row) continue;
      await insertVisitAssignment(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: v['centre_id'], visit_id: v['id'], route_id: v['route_id'], membership_id: null,   // 05-SCHEMA visit_assignments: membership_id NULL for unassign/missed (visit_assignments__shape__ck)
        route_date: v['route_date_text'], action: 'missed' });
      await insertVisitTransition(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: v['centre_id'], visit_id: v['id'], from_status: 'assigned', to_status: 'unassigned', cause: 'cron', at: now });
      routeIds.add(v['route_id']);
      returned++;
    }
    if (await insertOpenVisitFlagIfAbsent(ctx.tx, ctx.tenantId, ctx.actor.id, { id: uuidv7(), centre_id: v['centre_id'], visit_id: v['id'], kind: 'missed', related_id: null })) flagged++;
  }
  for (const routeId of [...routeIds].sort()) await bumpVersion(ctx.tx, ctx.tenantId, routeId);   // the phone sees the change on its next pull (TRD §4.1); id order = no deadlock
  ctx.log.info({ returned, flagged }, 'homecollection.missed_visits_swept');
};
