// homecollection.collection.synced.v1 -> lab specimen service (02-TRD §7.2 row 8; 06 row T-09; AC-03.2, AC-03.2a; 08 A19 D-120: booking_id optional, ignored).
// REQ-SEC-024 / 07-SECURITY P-11: the job's tenant is the only tenant; an envelope of another tenant (or a job without one) is refused before any query, port or event.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { applyHomeCollectionSynced, type HomeCollectionCtx, type HomeCollectionEnvelope } from '../../../../../api/src/modules/lab/service/specimen.service.js';
import type { ConsumerHandler, JobContext } from '../../../core/manifest.js';

export const handle: ConsumerHandler = async (event: HomeCollectionEnvelope & { tenant_id?: string }, ctx: JobContext) => {
  if (typeof ctx.tenantId !== 'string' || event?.tenant_id !== ctx.tenantId) throw new LimsError('common.internal');
  // JobContext.now() is an ISO string, the service wants a Date
  await applyHomeCollectionSynced({ ...(ctx as unknown as HomeCollectionCtx), now: () => new Date(ctx.now()) }, event);
};
