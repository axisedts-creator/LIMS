// QualityPort (03-IC §4.11, 02-TRD §11.1). Independent of LIMS_QUALITY_ENABLED (the port always answers; only HTTP routes are gated, §12.2).
// T-13: qcStatusFor reads the data through the status service on ctx.tx (replaces the T-01 stub-equivalent, 08 A17 P-20).
// canAutoVerify stays the Phase-1 stub (auto-verification off, D-56) until T-16 replaces it.
import { createStatusService } from '../service/status.service.js';

type StatusService = Pick<ReturnType<typeof createStatusService>, 'qcStatusFor'>;

export function createQualityPort(deps: { status?: StatusService } = {}) {
  const status = deps.status ?? createStatusService();
  return {
    async canAutoVerify(_ctx: unknown, _input: unknown): Promise<{ decision: 'deny'; reasons: string[] }> {
      return { decision: 'deny', reasons: ['feature_disabled'] };
    },
    qcStatusFor: (ctx: any, input: any) => status.qcStatusFor(ctx, input),
  };
}

export const qualityPort = createQualityPort();
