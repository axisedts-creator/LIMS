// homecollection.purge_retention {tenant_id} (1st of month 03:10 Asia/Kathmandu, per_tenant; 02-TRD §10, 05-SCHEMA §4.2, 08 A19 P-41, REQ-SEC-139, B15): system actor.
// app.homecollection_anonymise_retired_visits(ctx.now() - retentionYears): P2 text of closed visits + the copied handover_items.barcode; rows kept, no DELETE.
// retentionYears comes from IdentityPort.getTenantSettings; FAIL CLOSED: anything but a positive integer throws before the function is called (0 would anonymise every closed visit).
// A port error propagates (queue retry). Logs counts only (no address / barcode text).
import type { TaskHandler } from '../../../core/manifest.js';
import { anonymiseRetiredVisits } from '../../../../../api/src/modules/homecollection/repository/housekeeping.repo.js';

export const purgeRetention: TaskHandler = async (payload, ctx: any) => {
  if (payload?.tenant_id !== ctx.tenantId) return;                                       // another tenant's / malformed payload: resolve, write nothing
  const years = (await ctx.ports.identity.getTenantSettings(ctx, { keys: ['retentionYears'] }))?.retentionYears;
  if (typeof years !== 'number' || !Number.isInteger(years) || years < 1) throw new Error('homecollection.purge_retention: retentionYears is not a positive integer');
  const before = new Date(ctx.now());
  before.setUTCFullYear(before.getUTCFullYear() - years);
  const r = await anonymiseRetiredVisits(ctx.tx, before.toISOString());
  ctx.log.info({ visits: r.visits, handover_items: r.handoverItems, retention_years: years }, 'homecollection.retention_anonymised');
};
