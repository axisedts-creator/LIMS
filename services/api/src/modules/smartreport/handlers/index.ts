// operationId -> handler map of module smartreport (02-CV §2.2, 02-TRD §5). Keys = every operationId of contracts/openapi/smartreport.yaml (35);
// the core fails boot on a missing or extra key (AC-0D-1.2). SR-T01: 35 stubs; each later task replaces its own entries.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';

const OPERATION_IDS = [
  'listSmartLibraryVersions', 'createSmartLibraryVersion', 'getSmartLibraryVersion', 'updateSmartLibraryVersion',
  'listSmartTemplateBlocks', 'createSmartTemplateBlock', 'replaceSmartTemplateBlock', 'deleteSmartTemplateBlock',
  'listSmartRules', 'createSmartRule', 'replaceSmartRule', 'deleteSmartRule',
  'listSmartAnalyteGroups', 'putSmartAnalyteGroup', 'deleteSmartAnalyteGroup', 'listSmartGroupSettings', 'putSmartGroupSetting',
  'validateSmartLibraryVersion', 'submitSmartLibraryVersion', 'approveSmartLibraryVersion', 'returnSmartLibraryVersion', 'previewSmartLibraryVersion',
  'listSmartDenyTerms', 'createSmartDenyTerm', 'deactivateSmartDenyTerm', 'getSmartCodedSet', 'getSmartLibraryCodedSet',
  'listSmartSummaries', 'getSmartSummary', 'getCurrentSmartSummary', 'buildSmartSummary', 'approveSmartSummary', 'rejectSmartSummary',
  'requestSmartLlmRephrase', 'listSmartLlmRuns',
] as const;

export type SmartreportOperationId = (typeof OPERATION_IDS)[number];

const stub = (operationId: string): Handler => async () => {
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', `smartreport ${operationId} not implemented`);
};

const implemented: Partial<Record<SmartreportOperationId, Handler>> = {};

export const handlers: Readonly<Record<SmartreportOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<SmartreportOperationId, Handler>,
);
