// #42, #43, #46, #47 (simulation report, activation, decisions; 02-TRD §5.5). Schema, auth, x-permission, aal2 (auth.mfa_required on #43, AC-12.3) and Idempotency-Key (#43 optional)
// are enforced by the core pipeline from contracts/openapi/quality.yaml; these map request -> service, set ETag on #43 only (#42/#46/#47 are computed or immutable reads), and fail
// closed without a request context. Tenant and actor come from the context only; nothing from path/query/header/body is ever read as tenant_id.
import type { Handler } from '../../../core/module.js';
import { createActivationService } from '../service/activation.service.js';
import { ifMatch, obj } from './setup.handlers.js';
import { staff } from './autoverify.handlers.js';

const act = createActivationService();   // methods are looked up per call

export const activationHandlers = Object.freeze({
  getAutoverifySimulationReport: staff((c, req) => act.getAutoverifySimulationReport(c, { versionId: obj(req.params)['version_id'], sampleLimit: obj(req.query)['sample_limit'] })),
  activateAutoverifyVersion: staff((c, req) => act.activateAutoverifyVersion(c, { versionId: obj(req.params)['version_id'], expectedVersion: ifMatch(req), body: req.body }), { etag: true }),
  listAutoverifyDecisions: staff((c, req) => {
    const q = obj(req.query);
    return act.listAutoverifyDecisions(c, {
      resultId: q['result_id'], analyteId: q['analyte_id'], instrumentId: q['instrument_id'], versionId: q['version_id'], mode: q['mode'], decision: q['decision'], reason: q['reason'],
      decidedAtFrom: q['decided_at_from'], decidedAtTo: q['decided_at_to'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'],
    });
  }),
  getAutoverifyDecision: staff((c, req) => act.getAutoverifyDecision(c, { decisionId: obj(req.params)['decision_id'] })),
} satisfies Record<string, Handler>);
