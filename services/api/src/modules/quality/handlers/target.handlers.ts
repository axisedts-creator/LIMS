// #20-#25 (QC targets + establish; 02-TRD §5.3). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from contracts/openapi/quality.yaml;
// these map request -> service, set ETag, and fail closed without a request context. Bodies are passed unchanged (the service validates and rejects unknown fields).
// Tenant and actor come from the context only; nothing from path/query/header/body is ever read as tenant_id.
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { createTargetService } from '../service/target.service.js';
import { ifMatch, obj, staff } from './setup.handlers.js';

const targets = createTargetService();   // methods are looked up per call

const tid = (req: HandlerRequest) => obj(req.params)['target_id'];
const E = { etag: true } as const;

export const targetHandlers = Object.freeze({
  listQcTargets: staff((c, req) => {
    const q = obj(req.query);
    return targets.listQcTargets(c, { planId: q['plan_id'], lotId: q['lot_id'], status: q['status'], cursor: q['cursor'], limit: q['limit'] });
  }),
  createQcTarget: staff((c, req) => targets.createQcTarget(c, { body: req.body }), E),
  establishQcTarget: staff((c, req) => targets.establishQcTarget(c, { body: req.body }), E),
  activateQcTarget: staff((c, req) => targets.activateQcTarget(c, { targetId: tid(req), expectedVersion: ifMatch(req), body: req.body }), E),
  retireQcTarget: staff((c, req) => targets.retireQcTarget(c, { targetId: tid(req), expectedVersion: ifMatch(req), body: req.body }), E),
  discardQcTarget: staff((c, req) => targets.discardQcTarget(c, { targetId: tid(req), expectedVersion: ifMatch(req), body: req.body }), E),
} satisfies Record<string, Handler>);
