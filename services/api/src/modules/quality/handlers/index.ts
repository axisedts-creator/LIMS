// operationId -> handler map of module quality (02-CV §2.2). Keys = every operationId of contracts/openapi/quality.yaml (54);
// the core fails boot on a missing or extra key (AC-0D-1.2). C9 T-01: 54 stubs; each later task replaces its own entries.
// Phase switch (02-TRD §12.2): LIMS_QUALITY_ENABLED=false (default) -> every handler rejects common.feature_disabled (403) in every
// LIMS_CORE_ENV, before the request is looked at. Flag on: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes
// request input); anything else -> common.internal (fail closed).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { loadQualityConfig } from '../config.js';

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

const implemented: Partial<Record<QualityOperationId, Handler>> = {};

export const handlers: Readonly<Record<QualityOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<QualityOperationId, Handler>,
);
