// PG-T11 — payments.sweep_open_intents (02-TRD §8.3 row 2, AC-PG-05.3): recovers lost poll jobs. Open intents past their deadline (expires_at + grace) with no
// gateway check in the last 15 min get a "poll now" job. Writes nothing, calls no gateway; runs under the job's own tenant scope only.
// PG-T20 (TRD §11, 08 A22.4): also sets the per-tenant gauges held_for_review_oldest_age_seconds{tenant_id,kind}, reconciliation_stalled_runs{tenant_id} and
// open_intents_past_deadline{gateway} through ctx.metrics (optional). Refund sweeping (check_refund) belongs to PG-T14.
import type { PaymentsDeps } from '../../../../../api/src/modules/payments/service/outcome.service.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { POLL_INTENT } from './poll_intent.js';

export const SWEEP_OPEN_INTENTS = 'payments.sweep_open_intents';

const QUIET_MS = 15 * 60_000;
const OPEN = ['created', 'initiated', 'pending'];
const STALLED_MS = 2 * 3600_000;                                      // TRD §6.7 stalled-run threshold
const GATEWAYS = ['esewa', 'khalti'];                                  // every enabled gateway gets a series (0 when none)
const HELD = 'lims_payments_held_for_review_oldest_age_seconds';
const ms = (v: unknown) => new Date(v as any).getTime();

export function createSweepOpenIntents(deps: PaymentsDeps): TaskHandler {
  return async (_payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (!tenantId) throw new Error('payments.sweep_open_intents: tenant scope required');
    const now = Date.parse(ctx.now());
    const { rows } = await ctx.tx.query(
      'SELECT id, gateway, last_checked_at FROM payments.intents WHERE tenant_id = $1 AND status = ANY($2) AND expires_at < $3 ORDER BY expires_at ASC',
      [tenantId, OPEN, new Date(now - deps.config.expiryGraceMinutes * 60_000)]);
    const m = (ctx as { metrics?: { set(n: string, v: number, l?: Record<string, string>): void } }).metrics;
    for (const r of rows) {
      if (r.last_checked_at && new Date(r.last_checked_at).getTime() > now - QUIET_MS) continue;
      // n = 0: outside the create-time schedule (1..6). The key is per intent, so repeated sweeps before the job ran stay one job.
      await deps.jobs.enqueue(ctx, POLL_INTENT, { tenant_id: tenantId, intent_id: r.id, n: 0 }, { key: `poll:${r.id}:sweep` });
    }
    if (!m) return;
    const q = async (sql: string, v: unknown[]) => (await ctx.tx.query(sql, [tenantId, ...v])).rows as any[];
    const age = (ts: number[]) => (ts.length ? Math.max(0, Math.floor((now - Math.min(...ts)) / 1000)) : 0);
    // intents held now: age from the latest held_for_review transition of each (filtered in JS: the fake dialect has no joins / aggregates)
    const held = new Set((await q('SELECT id FROM payments.intents WHERE tenant_id = $1 AND status = $2', ['held_for_review'])).map((r) => r.id));
    const since = new Map<string, number>();
    for (const t of await q('SELECT intent_id, created_at FROM payments.intent_transitions WHERE tenant_id = $1 AND to_status = $2', ['held_for_review'])) {
      if (held.has(t.intent_id)) since.set(t.intent_id, Math.max(since.get(t.intent_id) ?? 0, ms(t.created_at)));
    }
    m.set(HELD, age([...since.values()]), { tenant_id: tenantId, kind: 'intent' });
    // refunds carry no hold timestamp: requested_at is an upper bound (TRD §11)
    const refunds = await q('SELECT requested_at FROM payments.refunds WHERE tenant_id = $1 AND status = $2', ['held_for_review']);
    m.set(HELD, age(refunds.map((r) => ms(r.requested_at))), { tenant_id: tenantId, kind: 'refund' });
    const runs = await q('SELECT updated_at FROM payments.reconciliation_runs WHERE tenant_id = $1 AND status = $2', ['running']);
    m.set('lims_payments_reconciliation_stalled_runs', runs.filter((r) => ms(r.updated_at) < now - STALLED_MS).length, { tenant_id: tenantId });
    for (const gateway of GATEWAYS) m.set('lims_payments_open_intents_past_deadline', rows.filter((r: any) => r.gateway === gateway).length, { gateway });
  };
}
