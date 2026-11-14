// #14-#19 (QC plans + versions; 02-TRD §5.3). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from contracts/openapi/quality.yaml;
// these map request -> service, set ETag, and fail closed without a request context. Bodies are passed unchanged (the service validates and rejects unknown fields).
// Tenant and actor come from the context only; nothing from path/query/header/body is ever read as tenant_id.
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { createPlanService } from '../service/plan.service.js';
import { ifMatch, obj, staff } from './setup.handlers.js';

const plans = createPlanService();   // methods are looked up per call

const pid = (req: HandlerRequest) => obj(req.params)['plan_id'];
const E = { etag: true } as const;

export const planHandlers = Object.freeze({
  listQcPlans: staff((c, req) => {
    const q = obj(req.query);
    return plans.listQcPlans(c, { instrumentId: q['instrument_id'], analyteId: q['analyte_id'], status: q['status'], cursor: q['cursor'], limit: q['limit'] });
  }),
  createQcPlan: staff((c, req) => plans.createQcPlan(c, { body: req.body }), E),
  getQcPlan: staff((c, req) => plans.getQcPlan(c, { planId: pid(req) }), E),
  createQcPlanVersion: staff((c, req) => plans.createQcPlanVersion(c, { planId: pid(req), expectedVersion: ifMatch(req), body: req.body }), E),
  activateQcPlan: staff((c, req) => plans.activateQcPlan(c, { planId: pid(req), expectedVersion: ifMatch(req), body: req.body }), E),
  deactivateQcPlan: staff((c, req) => plans.deactivateQcPlan(c, { planId: pid(req), expectedVersion: ifMatch(req), body: req.body }), E),
} satisfies Record<string, Handler>);
