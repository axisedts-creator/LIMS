// homecollection.flag_handover_discrepancy {tenant_id, handover_id} (02-TRD §10, 08 A19 D-125): system actor. H15 cannot write visit_flags (the receiver is no member of the visit's centre),
// so for each handover_items row with outcome 'missing' this opens a handover_discrepancy flag (related_id = handover id) on its visit, ON CONFLICT DO NOTHING (open-flag unique index),
// then bumps the version of every route that got a new flag (the phone sees it on its next pull, 02-TRD §4.1). Re-runs / retries add nothing. Uses no port. Logs ids and counts only (no barcode).
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { getHandoverById, listHandoverItemsByHandover } from '../../../../../api/src/modules/homecollection/repository/handovers.repo.js';
import { insertOpenVisitFlagIfAbsent } from '../../../../../api/src/modules/homecollection/repository/visitFlags.repo.js';
import { getVisitById } from '../../../../../api/src/modules/homecollection/repository/visits.repo.js';
import { bumpVersion } from '../../../../../api/src/modules/homecollection/route.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const flagHandoverDiscrepancy: TaskHandler = async (payload, ctx: any) => {
  if (payload?.tenant_id !== ctx.tenantId) return;                                       // another tenant's job: never act on it
  const handoverId = payload['handover_id'];
  if (typeof handoverId !== 'string' || !UUID.test(handoverId)) return;                  // malformed payload: resolve, no retry storm
  const handover = await getHandoverById(ctx.tx, ctx.tenantId, handoverId);
  if (!handover) return;                                                                 // unknown or hidden by RLS
  const missing = (await listHandoverItemsByHandover(ctx.tx, ctx.tenantId, handoverId)).filter((i) => i['outcome'] === 'missing');
  const routeIds = new Set<string>();
  let opened = 0;
  for (const item of missing) {
    const visit = await getVisitById(ctx.tx, ctx.tenantId, item['visit_id']);
    if (!visit) continue;
    const flag = await insertOpenVisitFlagIfAbsent(ctx.tx, ctx.tenantId, ctx.actor.id, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], kind: 'handover_discrepancy', related_id: handoverId });
    if (!flag) continue;
    opened++;
    if (visit['route_id']) routeIds.add(visit['route_id']);
  }
  for (const routeId of routeIds) await bumpVersion(ctx.tx, ctx.tenantId, routeId);
  ctx.log.info({ handover_id: handoverId, missing: missing.length, opened }, 'homecollection.handover_discrepancy_flagged');
};
