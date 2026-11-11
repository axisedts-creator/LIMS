// reporting.report.released.v1 -> lab report service (02-TRD §7.2 row 9 (A8) + "one rule"; 06 row T-27; AC-18.2, AC-18.3; CR-C5-006 order_item_ids).
// REQ-SEC-024 / 07-SECURITY P-11: the job's tenant is the only tenant; an envelope of another tenant (or a job without one) is refused before any query, port or event.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { applyReportReleased, type ReportReleasedCtx, type ReportReleasedEnvelope } from '../../../../../api/src/modules/lab/service/report.service.js';
import type { ConsumerHandler, JobContext } from '../../../core/manifest.js';

export const handle: ConsumerHandler = async (event: ReportReleasedEnvelope & { tenant_id?: string }, ctx: JobContext) => {
  if (typeof ctx.tenantId !== 'string' || event?.tenant_id !== ctx.tenantId) throw new LimsError('common.internal');
  // JobContext.now() is an ISO string, the service wants a Date
  await applyReportReleased({ ...(ctx as unknown as ReportReleasedCtx), now: () => new Date(ctx.now()) }, event);
};
