// operationId -> handler map of module anatomic (02-CV §2.2). Keys = every operationId of contracts/openapi/anatomic.yaml (70);
// the core fails boot on a missing or extra key (AC-0D-1.2). C11 T-01: 70 stubs; each later task replaces its own entries.
// LD-103 (2026-11-11): anatomic.yaml was transcribed from TRD §5 by T0C-10.C11; operationIds copied verbatim.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import {
  accessionAnatomicCase, addAnatomicPart, getAnatomicCase, listAnatomicAssignees, listAnatomicCases, lookupAnatomicObject, updateAnatomicCaseDetails, updateAnatomicPart,
} from './case.handlers.js';
import { cancelAnatomicCase, markAnatomicCaseReady, saveAnatomicGross, startAnatomicProcessing } from './gross.handlers.js';
import {
  createAnatomicAssay, createAnatomicStain, createAnatomicTextTemplate, getAnatomicSettings, listAnatomicAssays, listAnatomicCodedValues, listAnatomicStains, listAnatomicTestProfiles,
  listAnatomicTextTemplates, updateAnatomicAssay, updateAnatomicSettings, updateAnatomicStain, updateAnatomicTextTemplate, upsertAnatomicCodedValue, upsertAnatomicTestProfile,
} from './config.handlers.js';
import {
  cancelAnatomicStainOrder, completeAnatomicStainOrder, createAnatomicBlocks, createAnatomicSlides, createAnatomicStainOrder, getAnatomicLabels, linkAnatomicAddonItem,
  listAnatomicBlockMovements, listAnatomicBlocks, listAnatomicSlideMovements, listAnatomicStainOrders, markAnatomicSlidesReady, recordAnatomicMovements, saveAnatomicSlideAssessment, startAnatomicStainOrder,
} from './material.handlers.js';
import {
  createAnatomicSynopticTemplate, createAnatomicSynopticTemplateVersion, getAnatomicSynopticTemplate, listAnatomicSynopticTemplates, publishAnatomicSynopticTemplate,
  retireAnatomicSynopticTemplate, updateAnatomicSynopticTemplate,
} from './synoptic.handlers.js';
import {
  addAnatomicBatchMembers, closeAnatomicBatch, createAnatomicBatch, getAnatomicBatch, listAnatomicBatches, removeAnatomicBatchMembers, saveAnatomicMolecularResults,
} from './molecular.handlers.js';

import { deactivateAnatomicImage, getAnatomicImageContent, updateAnatomicImage, uploadAnatomicImage } from './image.handlers.js';
import {
  createAnatomicAddendum, discardAnatomicCaseChange, getAnatomicReportDraft, getAnatomicReportVersion, listAnatomicReportVersions, saveAnatomicReportDraft, signAnatomicAddendum,
  signOutAnatomicCase, startAnatomicCaseChange, updateAnatomicAddendum,
} from './report.handlers.js';

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
const implemented: Partial<Record<AnatomicOperationId, Handler>> = {
  listAnatomicCases, lookupAnatomicObject, getAnatomicCase, // C11 T-07 (A1–A3)
  accessionAnatomicCase, updateAnatomicCaseDetails, addAnatomicPart, updateAnatomicPart, listAnatomicAssignees, // C11 T-06
  saveAnatomicGross, startAnatomicProcessing, markAnatomicCaseReady, cancelAnatomicCase, // C11 T-08
  createAnatomicBlocks, createAnatomicSlides, markAnatomicSlidesReady, createAnatomicStainOrder, startAnatomicStainOrder, completeAnatomicStainOrder, cancelAnatomicStainOrder, // C11 T-09 (M1–M3, M5, M7–M10)
  linkAnatomicAddonItem, recordAnatomicMovements, listAnatomicBlockMovements, listAnatomicSlideMovements, getAnatomicLabels, // M11, M13–M15
  saveAnatomicSlideAssessment, listAnatomicStainOrders, listAnatomicBlocks, // M4, M6, M12 (C11 T-18 writer: the probes name M6/M12 as list endpoints)
  getAnatomicSettings, updateAnatomicSettings, listAnatomicStains, createAnatomicStain, updateAnatomicStain, listAnatomicTestProfiles, upsertAnatomicTestProfile, // C11 T-11 (K1–K7)
  listAnatomicAssays, createAnatomicAssay, updateAnatomicAssay, listAnatomicCodedValues, upsertAnatomicCodedValue, // K8–K12
  listAnatomicTextTemplates, createAnatomicTextTemplate, updateAnatomicTextTemplate, // K20–K22
  listAnatomicSynopticTemplates, createAnatomicSynopticTemplate, getAnatomicSynopticTemplate, updateAnatomicSynopticTemplate, // C11 T-12 (K13–K19)
  publishAnatomicSynopticTemplate, retireAnatomicSynopticTemplate, createAnatomicSynopticTemplateVersion,
  saveAnatomicMolecularResults, listAnatomicBatches, createAnatomicBatch, getAnatomicBatch, addAnatomicBatchMembers, removeAnatomicBatchMembers, closeAnatomicBatch, // C11 T-16 (Q1–Q7)
  uploadAnatomicImage, getAnatomicImageContent, updateAnatomicImage, deactivateAnatomicImage, // C11 T-10 (I1–I4)
  getAnatomicReportDraft, saveAnatomicReportDraft, // C11 T-13 (R1, R2)
  signOutAnatomicCase, // C11 T-14 (R3)
  startAnatomicCaseChange, discardAnatomicCaseChange, listAnatomicReportVersions, getAnatomicReportVersion, // C11 T-15 (R4–R7)
  createAnatomicAddendum, updateAnatomicAddendum, signAnatomicAddendum, // R8–R10
  // markAnatomicCaseReady: the C11 T-08 handler (gross.handlers) covers every case kind incl. molecular (C4: >= 1 active molecular result); the molecular-only variant of T-16 stays in molecular.handlers.ts and is not registered
};

export const handlers: Readonly<Record<AnatomicOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<AnatomicOperationId, Handler>,
);
