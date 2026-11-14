// T-29 handlers #47-#54 (02-TRD §5.8): getLabSettings, updateLabSettings, listDeltaCheckRules, createDeltaCheckRule, versionDeltaCheckRule, deactivateDeltaCheckRule,
// listLabCodedSet, upsertLabCode. Schema / x-permission / Idempotency-Key are enforced by the core pipeline; these map request -> service/config.service.ts.
// Tenant and actor come from ctx only (a tenant_id in a body is a 400, REQ-SEC-013). Without tenant / actor / tx the service fails closed (auth.unauthenticated).
import type { Handler } from '../../../core/module.js';
import { createRule, deactivateRule, getLabSettings, listCodes, listRules, updateLabSettings, upsertCode, versionRule } from '../service/config.service.js';

export const configHandlers = Object.freeze({
  getLabSettings: ((_req, ctx) => getLabSettings(ctx)) as Handler,
  updateLabSettings: ((req, ctx) => updateLabSettings(ctx, req.headers, req.body)) as Handler,
  listDeltaCheckRules: ((req, ctx) => listRules(ctx, req.query)) as Handler,
  createDeltaCheckRule: ((req, ctx) => createRule(ctx, req.body)) as Handler,
  versionDeltaCheckRule: ((req, ctx) => versionRule(ctx, req.params, req.headers, req.body)) as Handler,
  deactivateDeltaCheckRule: ((req, ctx) => deactivateRule(ctx, req.params, req.headers, req.body)) as Handler,
  listLabCodedSet: ((req, ctx) => listCodes(ctx, req.params)) as Handler,
  upsertLabCode: ((req, ctx) => upsertCode(ctx, req.params, req.headers, req.body)) as Handler,
});
