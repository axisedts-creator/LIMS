// Q1–Q7 (02-TRD §5.5) + the molecular branch of A10. Thin: the service does load -> assertRole -> validate -> write.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import * as s from '../service/molecular.service.js';

export const saveAnatomicMolecularResults: Handler = (req, ctx) => s.saveResults(ctx, req.params, req.headers, req.body);
export const listAnatomicBatches: Handler = (req, ctx) => s.listAllBatches(ctx, req.query);
export const createAnatomicBatch: Handler = (req, ctx) => s.createBatch(ctx, req.body);
export const getAnatomicBatch: Handler = (req, ctx) => s.getBatchDetail(ctx, req.params);
export const addAnatomicBatchMembers: Handler = (req, ctx) => s.addMembers(ctx, req.params, req.body);
export const removeAnatomicBatchMembers: Handler = (req, ctx) => s.removeMembers(ctx, req.params, req.headers, req.body);
export const closeAnatomicBatch: Handler = (req, ctx) => s.closeBatch(ctx, req.params, req.headers);

/** AC-11.6 (C4 for molecular cases). Other case kinds: C11 T-08 owns that guard; until it lands they keep the stub answer (fail closed). */
export const markAnatomicCaseReady: Handler = async (req, ctx) => {
  const done = await s.markMolecularReady(ctx, req.params, req.headers);
  if (done) return done;
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', 'anatomic markAnatomicCaseReady not implemented for this case kind');
};
