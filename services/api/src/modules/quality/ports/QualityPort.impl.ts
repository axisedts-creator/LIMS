// QualityPort (03-IC §4.11, 02-TRD §11.1). Independent of LIMS_QUALITY_ENABLED (the port always answers; only HTTP routes are gated, §12.2).
// T-13: qcStatusFor reads the data through the status service on ctx.tx. T-16: canAutoVerify = the decision service (rule evaluation + audit rows on the caller's tx, 02-TRD §8.4).
import { createDecisionService } from '../service/decision.service.js';
import { createStatusService } from '../service/status.service.js';

type StatusService = Pick<ReturnType<typeof createStatusService>, 'qcStatusFor'>;
type DecisionService = Pick<ReturnType<typeof createDecisionService>, 'canAutoVerify'>;

export function createQualityPort(deps: { status?: StatusService; decision?: DecisionService } = {}) {
  const status = deps.status ?? createStatusService();
  const decision = deps.decision ?? createDecisionService({ status });   // the SAME status service serves the QC lookups of the decision
  // §14 lims_quality_port_duration_seconds{method}: observed on success and failure; metrics never break a port call.
  const timed = async <T>(method: string, ctx: any, f: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try { return await f(); } finally { try { ctx?.metrics?.observe('lims_quality_port_duration_seconds', (performance.now() - t0) / 1000, { method }); } catch { /* ignore */ } }
  };
  return {
    canAutoVerify: (ctx: any, input: unknown) => timed('canAutoVerify', ctx, () => decision.canAutoVerify(ctx, input)),
    qcStatusFor: (ctx: any, input: any) => timed('qcStatusFor', ctx, () => status.qcStatusFor(ctx, input)),
  };
}

export const qualityPort = createQualityPort();
