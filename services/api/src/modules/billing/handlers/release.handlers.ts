// B14 createReleaseOverride and B15 getReleaseEligibility (02-TRD §5). Schema, auth, x-permission (billing.release.override privileged / billing.invoice.read) and the
// Idempotency-Key are enforced by the core pipeline from contracts/openapi/billing.yaml; these map request -> service and fail closed without an authenticated request context.
// The body never carries tenant, membership or centre: the overrider is the calling membership.
import type { Handler } from '../../../core/module.js';
import { moneyOf } from '../domain/money/paisa.js';
import { createReleaseService, type ReleaseService } from '../service/release.service.js';
import { bind, obj } from './ledger.handlers.js';

let service: ReleaseService | undefined;
const releaseService = () => (service ??= createReleaseService());

export const releaseHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createReleaseOverride: bind(async (ctx, req) => {
    const b = obj(req.body);
    const r = await releaseService().createOverride(ctx, {
      orderId: obj(req.params)['order_id'], reasonCode: b['reason_code'],
      ...(b['reason_text'] === undefined ? {} : { reasonText: b['reason_text'] }), ...(b['expires_at'] === undefined ? {} : { expiresAt: b['expires_at'] }),
    });
    return { status: 201, body: { override_id: r.overrideId, created_at: r.createdAt } };
  }),
  getReleaseEligibility: bind(async (ctx, req) => {
    const r = await releaseService().getEligibility(ctx, { orderId: obj(req.params)['order_id'] });
    return {
      status: 200,
      body: {
        order_id: r.orderId, eligible: r.eligible, basis: r.basis, balance_due: moneyOf(r.balanceDue.amountPaisa),
        ...(r.overrideId === undefined ? {} : { override_id: r.overrideId }), evaluated_at: r.evaluatedAt,
      },
    };
  }),
});
