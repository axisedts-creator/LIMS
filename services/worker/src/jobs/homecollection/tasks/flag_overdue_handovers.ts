// homecollection.flag_overdue_handovers {tenant_id} (every 30 min, per_tenant; 02-TRD §10, 01-PRD US-12-4): system actor. Applied collections with no handover_items row and collected_at strictly
// older than settings.handover_overdue_hours (default 4) -> open flag `handover_overdue` on the visit (one per visit; ON CONFLICT DO NOTHING on the open-flag unique index). Inserts flags only.
// Uses no port. Logs counts only (no barcode).
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { listVisitsWithOverdueCollections } from '../../../../../api/src/modules/homecollection/repository/housekeeping.repo.js';
import { getSettings } from '../../../../../api/src/modules/homecollection/repository/settings.repo.js';
import { insertOpenVisitFlagIfAbsent } from '../../../../../api/src/modules/homecollection/repository/visitFlags.repo.js';

const DEFAULT_HOURS = 4;   // 05-SCHEMA settings.handover_overdue_hours DEFAULT 4 (CHECK 1..24)

export const flagOverdueHandovers: TaskHandler = async (payload, ctx: any) => {
  if (payload?.tenant_id !== ctx.tenantId) return;                                       // another tenant's / malformed payload: resolve, write nothing
  const configured = Number((await getSettings(ctx.tx, ctx.tenantId))?.['handover_overdue_hours']);
  const hours = Number.isInteger(configured) && configured >= 1 && configured <= 24 ? configured : DEFAULT_HOURS;
  const overdue = await listVisitsWithOverdueCollections(ctx.tx, ctx.tenantId, ctx.now(), hours);
  let opened = 0;
  for (const o of overdue) {
    if (await insertOpenVisitFlagIfAbsent(ctx.tx, ctx.tenantId, ctx.actor.id, { id: uuidv7(), centre_id: o['centre_id'], visit_id: o['visit_id'], kind: 'handover_overdue', related_id: null })) opened++;
  }
  ctx.log.info({ overdue: overdue.length, opened, hours }, 'homecollection.handover_overdue_flagged');
};
