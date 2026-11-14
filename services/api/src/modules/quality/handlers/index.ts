// operationId -> handler map of module quality (02-CV §2.2). Keys = every operationId of contracts/openapi/quality.yaml (54);
// the core fails boot on a missing or extra key (AC-0D-1.2). C9 T-01: 54 stubs; each later task replaces its own entries.
// Phase switch (02-TRD §12.2): LIMS_QUALITY_ENABLED=false (default) -> every handler rejects common.feature_disabled (403) in every
// LIMS_CORE_ENV, before the request is looked at. Flag on: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes
// request input); anything else -> common.internal (fail closed).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { loadQualityConfig } from '../config.js';
import { setupHandlers } from './setup.handlers.js';
import { autoverifyHandlers } from './autoverify.handlers.js';
import { planHandlers } from './plan.handlers.js';
import { targetHandlers } from './target.handlers.js';
import { reviewHandlers } from './review.handlers.js';
import { statusHandlers } from './status.handlers.js';

const OPERATION_IDS = [
  'listControlMaterials', 'createControlMaterial', 'getControlMaterial', 'updateControlMaterial', 'deactivateControlMaterial', 'createControlLevel',
  'updateControlLevel', 'createControlLot', 'listControlLots', 'updateControlLot', 'listControlIdMaps', 'createControlIdMap', 'deactivateControlIdMap',
  'listQcPlans', 'createQcPlan', 'getQcPlan', 'createQcPlanVersion', 'activateQcPlan', 'deactivateQcPlan', 'listQcTargets', 'createQcTarget',
  'establishQcTarget', 'activateQcTarget', 'retireQcTarget', 'discardQcTarget', 'listQcObservations', 'excludeQcObservation', 'listQcRuns', 'getQcRun',
  'evaluateQcRunNow', 'recordCorrectiveAction', 'closeQcRun', 'acknowledgeQcRun', 'getQcStatusBoard', 'getLeveyJenningsChart', 'getAutoverifyRuleSet',
  'createAutoverifyVersion', 'getAutoverifyVersion', 'replaceAutoverifyDraft', 'startAutoverifySimulation', 'stopAutoverifySimulation',
  'getAutoverifySimulationReport', 'activateAutoverifyVersion', 'retireAutoverifyVersion', 'discardAutoverifyDraft', 'listAutoverifyDecisions',
  'getAutoverifyDecision', 'listTatAlerts', 'getTatAlert', 'acknowledgeTatAlert', 'getQualitySettings', 'updateQualitySettings', 'listQualityCodedSet',
  'upsertQualityCode',
] as const;

export type QualityOperationId = (typeof OPERATION_IDS)[number];

const { enabled } = loadQualityConfig(); // bad LIMS_QUALITY_* stops the process at boot; frozen: no handler can flip the switch

const stub = (operationId: string): Handler => async () => {
  if (!enabled) throw new LimsError('common.feature_disabled');
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', `quality ${operationId} not implemented`);
};

// Every implemented handler sits behind the same phase switch (02-TRD:120; ruling C9.T-06).
const gated = (h: Handler): Handler => async (req, ctx) => {
  if (!enabled) throw new LimsError('common.feature_disabled');
  return h(req, ctx);
};

const implemented: Partial<Record<QualityOperationId, Handler>> = Object.fromEntries(
  Object.entries({ ...setupHandlers, ...planHandlers, ...targetHandlers, ...reviewHandlers, ...statusHandlers, ...autoverifyHandlers }).map(([op, h]) => [op, gated(h as Handler)]), // T-06: #1-#13; T-07: #14-#19; T-08: #20-#25; T-12: #26-#33; T-13: #34; T-15: #36-#41, #44, #45
);

export const handlers: Readonly<Record<QualityOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<QualityOperationId, Handler>,
);
