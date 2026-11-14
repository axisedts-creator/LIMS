// #26-#33 (runs read + review actions; 02-TRD §5.5). Schema, auth, x-permission and Idempotency-Key (required on #30-#33) are enforced by the core pipeline from contracts/openapi/quality.yaml;
// these map request -> service, set ETag, and fail closed without a request context. Bodies are passed unchanged (the service validates and rejects unknown fields).
// Tenant and actor come from the context only; nothing from path/query/header/body is ever read as tenant_id. #31 / #33 create log rows: no version, no If-Match.
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { createReviewService } from '../service/review.service.js';
import { ifMatch, obj, staff } from './setup.handlers.js';

const reviews = createReviewService();   // methods are looked up per call

const runId = (req: HandlerRequest) => obj(req.params)['qc_run_id'];
const E = { etag: true } as const;

export const reviewHandlers = Object.freeze({
  listQcObservations: staff((c, req) => {
    const q = obj(req.query);
    return reviews.listQcObservations(c, {
      planId: q['plan_id'], instrumentId: q['instrument_id'], analyteId: q['analyte_id'], levelId: q['level_id'], lotId: q['lot_id'], status: q['status'],
      observedAtFrom: q['observed_at_from'], observedAtTo: q['observed_at_to'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'],
    });
  }),
  excludeQcObservation: staff((c, req) => reviews.excludeQcObservation(c, { observationId: obj(req.params)['observation_id'], expectedVersion: ifMatch(req), body: req.body }), E),
  listQcRuns: staff((c, req) => {
    const q = obj(req.query);
    return reviews.listQcRuns(c, {
      planId: q['plan_id'], instrumentId: q['instrument_id'], analyteId: q['analyte_id'], status: q['status'], outcome: q['outcome'], needsAction: q['needs_action'],
      runAtFrom: q['run_at_from'], runAtTo: q['run_at_to'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'],
    });
  }),
  getQcRun: staff((c, req) => reviews.getQcRun(c, { runId: runId(req) }), E),   // the ETag is the version the client sends as If-Match on #30 / #32
  evaluateQcRunNow: staff((c, req) => reviews.evaluateQcRunNow(c, { runId: runId(req), expectedVersion: ifMatch(req), body: req.body }), E),
  recordCorrectiveAction: staff((c, req) => reviews.recordCorrectiveAction(c, { runId: runId(req), body: req.body })),
  closeQcRun: staff((c, req) => reviews.closeQcRun(c, { runId: runId(req), expectedVersion: ifMatch(req), body: req.body }), E),
  acknowledgeQcRun: staff((c, req) => reviews.acknowledgeQcRun(c, { runId: runId(req), body: req.body })),
} satisfies Record<string, Handler>);
