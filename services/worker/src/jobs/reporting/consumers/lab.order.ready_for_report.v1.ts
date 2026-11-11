// lab.order.ready_for_report.v1 -> lab readiness on the laboratory report + debounced reporting.assemble_report (02-TRD §8.2; AC-01.5).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { ENQUEUE_SQL } from '../../../core/fanout.js';
import { ASSEMBLY_DEBOUNCE_MS } from '../../../../../api/src/modules/reporting/domain/readiness.js';
import { recordLabReadiness, tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => {
  const tenantId = tenantFor(event, ctx);
  const reportId = await recordLabReadiness(ctx, tenantId, event.payload, event.aggregate.seq);
  if (!reportId) return;
  const runAt = new Date(Date.parse(ctx.now()) + ASSEMBLY_DEBOUNCE_MS).toISOString();
  await ctx.tx.query(ENQUEUE_SQL, ['reporting.assemble_report', JSON.stringify({ tenant_id: tenantId, report_id: reportId }), `assemble:${reportId}`, runAt, 10]);
};
