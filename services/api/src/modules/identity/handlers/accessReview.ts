// GET + POST /v1/identity/access-reviews (T0D-BUILD-3, LD-447; replaces the T0D-FIX-2 501 stubs). x-permission guard FIRST (SEC-AUTHZ-4, LD-189);
// Idempotency-Key replay / key reuse is the core idempotency hook's (x-idempotency: required). Logic in service/access-review.service.ts.
import type { HandlerContext } from '../../../core/module.js';
import { listAccessReviews as list, recordAccessReview as record, type AccessReviewCtx } from '../service/access-review.service.js';
import { guarded } from './_guard.js';

const c = (hctx: HandlerContext) => hctx as unknown as AccessReviewCtx;

export const listAccessReviews = guarded('identity.user.read', async (_req, hctx) => list(c(hctx)));
export const recordAccessReview = guarded('identity.user.manage', async (req, hctx) => record(c(hctx), req.body));
