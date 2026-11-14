// QualityPort (03-IC §4.11, 02-TRD §11.1). Independent of LIMS_QUALITY_ENABLED (the port always answers; only HTTP routes are gated, §12.2).
// T-13: qcStatusFor reads the data through the status service on ctx.tx. T-16: canAutoVerify = the decision service (rule evaluation + audit rows on the caller's tx, 02-TRD §8.4).
import { createDecisionService } from '../service/decision.service.js';
import { createStatusService } from '../service/status.service.js';

type StatusService = Pick<ReturnType<typeof createStatusService>, 'qcStatusFor'>;
type DecisionService = Pick<ReturnType<typeof createDecisionService>, 'canAutoVerify'>;

export function createQualityPort(deps: { status?: StatusService; decision?: DecisionService } = {}) {
  const status = deps.status ?? createStatusService();
  const decision = deps.decision ?? createDecisionService({ status });   // the SAME status service serves the QC lookups of the decision
  return {
    canAutoVerify: (ctx: any, input: unknown) => decision.canAutoVerify(ctx, input),
    qcStatusFor: (ctx: any, input: any) => status.qcStatusFor(ctx, input),
  };
}

export const qualityPort = createQualityPort();
