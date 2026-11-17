// PG-T11 — payments.poll_intent (02-TRD §8.3 row 1; AC-PG-05.1/05.2): one gateway check through the PG-T08 applyCheck, transition cause 'poll'.
// Terminal intent -> no-op (that is what stops the polls: the remaining keyed jobs find nothing to do). No usable gateway answer ("retry") -> throw, so the
// queue's built-in backoff re-runs the job (max_attempts 8). The payload is untrusted: tenant and intent come from the job scope / a validated uuid, never an amount or status.
import { createOutcomeService, type PaymentsDeps } from '../../../../../api/src/modules/payments/service/outcome.service.js';
import { findById } from '../../../../../api/src/modules/payments/repository/intents.repo.js';
import type { Ctx } from '../../../../../api/src/modules/payments/repository/shared.js';
import { isUuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const POLL_INTENT = 'payments.poll_intent';

const OPEN = ['created', 'initiated', 'pending', 'held_for_review'];   // held_for_review can still settle on a gateway answer (outcome.service SETTLEABLE); the rest is terminal

export function createPollIntent(deps: PaymentsDeps, ports: Ctx['ports']): TaskHandler {
  return async (payload, ctx) => {
    const intentId = payload?.['intent_id'];
    if (!ctx.tenantId || payload?.['tenant_id'] !== ctx.tenantId || typeof intentId !== 'string' || !isUuidv7(intentId)) return;   // never retry a malformed job
    const c = { ...ctx, tenantId: ctx.tenantId, ports } as unknown as Ctx;
    const row = await findById(c, intentId);                                // tenant-scoped: a foreign / unknown id is "not found" -> nothing to poll
    if (!row || !OPEN.includes(row['status'])) return;

    let answered: boolean | undefined;                                      // did the adapter give a usable answer during this run? (undefined: no call made)
    const watch = <F extends (...a: any[]) => Promise<any>>(f: F): F => (async (...a: any[]) => {
      try { const r = await f(...a); answered = r?.kind === 'answer'; return r; } catch (e) { answered = false; throw e; }
    }) as F;
    const watched: PaymentsDeps = { ...deps, adapters: {
      esewa: { ...deps.adapters.esewa, check: watch(deps.adapters.esewa.check) },
      khalti: { ...deps.adapters.khalti, check: watch(deps.adapters.khalti.check) } } };

    const res = await createOutcomeService(watched).applyCheck(c, intentId, 'verify', { cause: 'poll' });
    if (answered === false && res.status === row['status']) throw new Error('payments.poll_intent: no usable gateway answer');   // rolls the unit back; backoff retries
  };
}
