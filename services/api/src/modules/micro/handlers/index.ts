// operationId -> handler map of module micro (02-CV §2.2). Keys = every operationId of contracts/openapi/micro.yaml (M1–M49); the core
// fails boot on a missing or extra key (AC-0D-1.2). 06-IMPLEMENTATION-PLAN T-01: no 501 — every stub rejects common.internal (fail closed,
// in every LIMS_CORE_ENV) until its task replaces it with handlers/<operationId>.ts and adds it to REAL below.
// [CONV] keys are derived from micro.yaml (cannot drift) instead of 49 placeholder files. The stub message names the operation only — never request input.
import { join } from 'node:path';
import { LimsError } from '../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds, type Handler } from '../../../core/module.js';

/** Implemented operations; each later task adds its own import + entry. */
const REAL: Readonly<Record<string, Handler>> = {};

const notImplemented = (op: string): Handler => async () => {
  throw new LimsError('common.internal', `micro operation ${op} not implemented`);
};

export const handlers: Readonly<Record<string, Handler>> = Object.freeze(
  Object.fromEntries(operationIds(loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'))).map((op) => [op, REAL[op] ?? notImplemented(op)])),
);
