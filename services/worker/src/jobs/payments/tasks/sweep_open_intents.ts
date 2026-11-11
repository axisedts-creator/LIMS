// PG-T11 — payments.sweep_open_intents (02-TRD §8.3 row 2, AC-PG-05.3): recovers lost poll jobs. Open intents past their deadline (expires_at + grace) with no
// gateway check in the last 15 min get a "poll now" job. Writes nothing, calls no gateway; runs under the job's own tenant scope only.
// Refund sweeping (check_refund) and the held/stalled-run gauges belong to PG-T14 / metrics work.
import type { PaymentsDeps } from '../../../../../api/src/modules/payments/service/outcome.service.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { POLL_INTENT } from './poll_intent.js';

export const SWEEP_OPEN_INTENTS = 'payments.sweep_open_intents';

const QUIET_MS = 15 * 60_000;
const OPEN = ['created', 'initiated', 'pending'];

export function createSweepOpenIntents(deps: PaymentsDeps): TaskHandler {
  return async (_payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (!tenantId) throw new Error('payments.sweep_open_intents: tenant scope required');
    const now = Date.parse(ctx.now());
    const { rows } = await ctx.tx.query(
      'SELECT id, last_checked_at FROM payments.intents WHERE tenant_id = $1 AND status = ANY($2) AND expires_at < $3 ORDER BY expires_at ASC',
      [tenantId, OPEN, new Date(now - deps.config.expiryGraceMinutes * 60_000)]);
    for (const r of rows) {
      if (r.last_checked_at && new Date(r.last_checked_at).getTime() > now - QUIET_MS) continue;
      // n = 0: outside the create-time schedule (1..6). The key is per intent, so repeated sweeps before the job ran stay one job.
      await deps.jobs.enqueue(ctx, POLL_INTENT, { tenant_id: tenantId, intent_id: r.id, n: 0 }, { key: `poll:${r.id}:sweep` });
    }
  };
}
