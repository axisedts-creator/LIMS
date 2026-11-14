// homecollection.purge_locations {tenant_id} (daily 02:40 Asia/Kathmandu, per_tenant; 02-TRD §10, 05-SCHEMA §4.1 (3) + §6, 08 A17 P-18(c), REQ-SEC-139): system actor.
// DELETE of the tenant's visit_locations rows with expires_at < now() (the DATABASE clock, never ctx.now()). The delete is decided by the RLS delete policy, not by this code. Logs the count only (no coordinates).
import type { TaskHandler } from '../../../core/manifest.js';
import { deleteExpiredLocations } from '../../../../../api/src/modules/homecollection/repository/visitLocations.repo.js';

export const purgeLocations: TaskHandler = async (payload, ctx: any) => {
  if (payload?.tenant_id !== ctx.tenantId) return;                                       // another tenant's / malformed payload: resolve, delete nothing
  const deleted = await deleteExpiredLocations(ctx.tx, ctx.tenantId);
  ctx.log.info({ deleted }, 'homecollection.locations_purged');
};
