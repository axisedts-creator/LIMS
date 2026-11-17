// operationId -> handler map of module micro (02-CV §2.2). Keys = every operationId of contracts/openapi/micro.yaml (M1–M49); the core
// fails boot on a missing or extra key (AC-0D-1.2). 06-IMPLEMENTATION-PLAN T-01: no 501 — every stub rejects common.internal (fail closed,
// in every LIMS_CORE_ENV) until its task replaces it with handlers/<operationId>.ts and adds it to REAL below.
// [CONV] keys are derived from micro.yaml (cannot drift) instead of 49 placeholder files. The stub message names the operation only — never request input.
import { join } from 'node:path';
import { LimsError } from '../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds, type Handler } from '../../../core/module.js';
import { astHandlers } from './ast.handlers.js';
import { breakpointHandlers } from './breakpoint.handlers.js';
import { configHandlers } from './config.handlers.js';
import { cultureHandlers } from './culture.handlers.js';
import { instrumentRecordHandlers } from './instrument-record.handlers.js';
import { isolateHandlers } from './isolate.handlers.js';
import { reportHandlers } from './report.handlers.js';

/** Implemented operations; each later task adds its own import + entry. */
const REAL: Readonly<Record<string, Handler>> = {
  ...cultureHandlers, // T-07: M1, M2, M15, M16; T-08: M3–M6
  ...isolateHandlers, // T-09: M7–M10
  ...astHandlers, // T-10: M11, M12, M29–M32
  ...configHandlers, // T-05: M23–M28, M39, M40
  ...instrumentRecordHandlers, // T-14: M19–M22, M33–M38
  ...reportHandlers, // T-15: M14
  ...breakpointHandlers, // T-11: M41–M45, M49; T-13: M13, M46–M48
};

const notImplemented = (op: string): Handler => async () => {
  throw new LimsError('common.internal', `micro operation ${op} not implemented`);
};

export const handlers: Readonly<Record<string, Handler>> = Object.freeze(
  Object.fromEntries(operationIds(loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'))).map((op) => [op, REAL[op] ?? notImplemented(op)])),
);
