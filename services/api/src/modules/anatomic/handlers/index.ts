// operationId -> handler map of module anatomic (02-CV §2.2). Keys = every operationId of contracts/openapi/anatomic.yaml (70);
// the core fails boot on a missing or extra key (AC-0D-1.2). C11 T-01: 70 stubs; each later task replaces its own entries.
// LD-103 (2026-11-11): anatomic.yaml was transcribed from TRD §5 by T0C-10.C11; operationIds copied verbatim.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';

const OPERATION_IDS = [
  'listAnatomicCases', 'lookupAnatomicObject', 'getAnatomicCase', 'accessionAnatomicCase',
  'updateAnatomicCaseDetails', 'addAnatomicPart', 'updateAnatomicPart', 'saveAnatomicGross',
  'startAnatomicProcessing', 'markAnatomicCaseReady', 'cancelAnatomicCase', 'listAnatomicAssignees',
  'createAnatomicBlocks', 'createAnatomicSlides', 'markAnatomicSlidesReady', 'saveAnatomicSlideAssessment',
  'createAnatomicStainOrder', 'listAnatomicStainOrders', 'startAnatomicStainOrder', 'completeAnatomicStainOrder',
  'cancelAnatomicStainOrder', 'linkAnatomicAddonItem', 'recordAnatomicMovements', 'listAnatomicBlocks',
  'listAnatomicBlockMovements', 'listAnatomicSlideMovements', 'getAnatomicLabels', 'getAnatomicReportDraft',
  'saveAnatomicReportDraft', 'signOutAnatomicCase', 'startAnatomicCaseChange', 'discardAnatomicCaseChange',
  'listAnatomicReportVersions', 'getAnatomicReportVersion', 'createAnatomicAddendum', 'updateAnatomicAddendum',
  'signAnatomicAddendum', 'uploadAnatomicImage', 'getAnatomicImageContent', 'updateAnatomicImage',
  'deactivateAnatomicImage', 'saveAnatomicMolecularResults', 'listAnatomicBatches', 'createAnatomicBatch',
  'getAnatomicBatch', 'addAnatomicBatchMembers', 'removeAnatomicBatchMembers', 'closeAnatomicBatch',
  'getAnatomicSettings', 'updateAnatomicSettings', 'listAnatomicStains', 'createAnatomicStain',
  'updateAnatomicStain', 'listAnatomicTestProfiles', 'upsertAnatomicTestProfile', 'listAnatomicAssays',
  'createAnatomicAssay', 'updateAnatomicAssay', 'listAnatomicCodedValues', 'upsertAnatomicCodedValue',
  'listAnatomicSynopticTemplates', 'createAnatomicSynopticTemplate', 'getAnatomicSynopticTemplate', 'updateAnatomicSynopticTemplate',
  'publishAnatomicSynopticTemplate', 'retireAnatomicSynopticTemplate', 'createAnatomicSynopticTemplateVersion', 'listAnatomicTextTemplates',
  'createAnatomicTextTemplate', 'updateAnatomicTextTemplate',
] as const;

export type AnatomicOperationId = (typeof OPERATION_IDS)[number];

const stub = (operationId: string): Handler => async () => {
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', `anatomic ${operationId} not implemented`);
};

// later tasks register their real handlers here
const implemented: Partial<Record<AnatomicOperationId, Handler>> = {};

export const handlers: Readonly<Record<AnatomicOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<AnatomicOperationId, Handler>,
);
