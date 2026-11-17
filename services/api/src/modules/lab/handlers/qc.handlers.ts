// T-25 handlers #43-#46 (02-TRD §5.7): listQcResults, captureQcResult, listQcHolds, releaseQcHold. Schema / x-permission / Idempotency-Key are enforced by the core pipeline; these map request -> service/qc.service.ts.
// Tenant and actor come from ctx only (a tenant_id in a body is a 400, REQ-SEC-013).
import type { Handler } from '../../../core/module.js';
import { captureQcResult, listQcHolds, listQcResults, releaseQcHold } from '../service/qc.service.js';

export const qcHandlers = Object.freeze({
  listQcResults: ((req, ctx) => listQcResults(ctx, req.query)) as Handler,
  captureQcResult: ((req, ctx) => captureQcResult(ctx, req.body)) as Handler,
  listQcHolds: ((req, ctx) => listQcHolds(ctx, req.query)) as Handler,
  releaseQcHold: ((req, ctx) => releaseQcHold(ctx, req.params, req.body)) as Handler,
});
