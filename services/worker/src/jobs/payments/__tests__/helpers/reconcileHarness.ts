// PG-T13 worker test harness: payments.reconcile_tenant / payments.reconcile_batch over the api helpers (DB fake with runs/findings/refunds, scripted gateways, tx-aware ledger +
// job spies; api helpers/portHarness.ts). Fake clock per call (ctx.now()), job queue drained by hand (a batch job = one db.run = one transaction, like the worker's JobContext).
// Seam the writer follows (LD-122): tasks/reconcile_tenant.ts RECONCILE_TENANT / createReconcileTenant(deps, ports), tasks/reconcile_batch.ts RECONCILE_BATCH / createReconcileBatch(deps, ports);
// metrics via ctx.metrics?.set(name, value, labels) / ctx.metrics?.inc(name, labels). Synthetic data only.
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makePortHarness, type PortHarness } from '../../../../../../api/src/modules/payments/__tests__/helpers/portHarness';
import { RECONCILE_BATCH, createReconcileBatch } from '../../tasks/reconcile_batch.js';
import { RECONCILE_TENANT, createReconcileTenant } from '../../tasks/reconcile_tenant.js';

export const A = TENANTS.A, B = TENANTS.B;
export const MIN = 60_000, HOUR = 3600_000, DAY = 86_400_000;
export const DUE = 225000;
export const START = Date.parse('2026-11-11T20:40:00Z');                 // the cron tick: 02:25 Asia/Kathmandu on 2026-11-12
export const FINDINGS_METRIC = 'lims_payments_reconciliation_findings_total';
export const LAST_SUCCESS_METRIC = 'lims_payments_reconciliation_last_success_timestamp_seconds';
export const iso = (ms: number) => new Date(ms).toISOString();
/** deterministic uuidv7 ids; the number orders them (id order = candidate order) */
export const id = (n: number) => `01900000-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`;
export const orderId = (n: number) => `01900000-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const refundId = (n: number) => `01900000-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`;
export type Job = { task: string; payload: any; key: string; runAt?: Date };

export type IntentSpec = {
  n: number; status: 'created' | 'initiated' | 'pending' | 'held_for_review' | 'settled' | 'partially_refunded' | 'refunded' | 'failed' | 'expired';
  gw?: 'esewa' | 'khalti'; tenant?: string; amount?: number;
  /** what the gateway answers (raw status) and for how much */
  raw?: string; gwAmount?: number;
  /** deadline offset from START in minutes (default: 4 h in the future = before the deadline) */
  expiresInMin?: number;
  settledAgoMs?: number; closedAgoMs?: number; refunded?: number;
};
export type RefundSpec = { n: number; intent: number; status?: 'requested' | 'held_for_review' | 'completed' | 'failed'; amount?: number; unconfirmed?: number; tenant?: string };

export interface ReconcileHarness {
  h: PortHarness;
  metrics: { sets: { name: string; value: number; labels?: Record<string, string> }[]; incs: { name: string; labels?: Record<string, string> }[] };
  seed(intents: IntentSpec[], refunds?: RefundSpec[]): Promise<void>;
  row(n: number, tenant?: string): any;
  /** payments.reconcile_tenant for `tenant` at `now` (payload {tenant_id}) */
  tick(tenant?: string, now?: number, payload?: any): Promise<void>;
  /** run ONE queued batch job at `now` (transaction per job; the job's tenant scope = payload.tenant_id unless `as` overrides it) */
  batch(job: Job, now?: number, as?: string): Promise<void>;
  /** run every not-yet-run reconcile_batch job, FIFO, at `now` (a function of the job index when given); returns the jobs run */
  drain(now?: number | ((i: number) => number)): Promise<Job[]>;
  batchJobs(): Job[];
  runs(tenant?: string): any[];
  findings(tenant?: string): any[];
  kinds(tenant?: string): string[];
  gatewayChecks(intentN?: number): number;
}

export async function makeReconcileHarness(): Promise<ReconcileHarness> {
  const h = await makePortHarness();
  const metrics: ReconcileHarness['metrics'] = { sets: [], incs: [] };
  const ran = new Set<Job>();
  const ctxOf = (tenant: string, now: number, ctx: any, jobId: string) => ({ ...ctx, tenantId: tenant, actor: { type: 'system', id: tenant }, attempt: 1, maxAttempts: 3, jobId, now: () => iso(now),
    metrics: { set: (name: string, value: number, labels?: Record<string, string>) => { metrics.sets.push({ name, value, ...(labels ? { labels } : {}) }); },
      inc: (name: string, labels?: Record<string, string>) => { metrics.incs.push({ name, ...(labels ? { labels } : {}) }); } } });
  const inTx = <T>(tenant: string, now: number, fn: (ctx: any) => Promise<T>) => h.db.run(fn, { tenantId: tenant, now: () => new Date(now) });

  const self: ReconcileHarness = {
    h, metrics,
    async seed(intents, refunds = []) {
      const mk = (s: IntentSpec) => ({ id: id(s.n), tenantId: s.tenant ?? A, orderId: orderId(s.n), gateway: s.gw ?? 'esewa', status: s.status, amountPaisa: s.amount ?? DUE,
        idempotencyKey: `seed-${s.n}`, expiresAt: iso(START + (s.expiresInMin ?? 240) * MIN), ...(s.refunded ? { refundedPaisa: s.refunded } : {}) });
      await h.seed({
        orders: intents.map((s) => ({ id: orderId(s.n), tenantId: s.tenant ?? A, dueAmountPaisa: s.amount ?? DUE, gatewayStatus: s.raw ?? 'COMPLETE', ...(s.gwAmount !== undefined ? { gatewayAmountPaisa: s.gwAmount } : {}) })),
        returnUrlHosts: ['app.lims.test'], intents: intents.map(mk),
      });
      for (const s of intents) {
        const r = self.row(s.n, s.tenant ?? A);
        if (['settled', 'partially_refunded', 'refunded'].includes(s.status)) r.settled_at = new Date(START - (s.settledAgoMs ?? HOUR));
        if (['failed', 'expired'].includes(s.status)) r.closed_at = new Date(START - (s.closedAgoMs ?? HOUR));
      }
      for (const f of refunds) {
        const intent = self.row(f.intent, f.tenant ?? A);
        h.db.put('payments.refunds', { id: refundId(f.n), tenant_id: f.tenant ?? A, intent_id: id(f.intent), order_id: intent.order_id, centre_id: intent.centre_id, gateway: intent.gateway, mode: 'manual',
          status: f.status ?? 'requested', amount_paisa: f.amount ?? Number(intent.amount_paisa), reason_code: 'test_cancelled', requested_by_membership_id: A, requested_at: new Date(START - DAY),
          approved_by_membership_id: A, approved_at: new Date(START - DAY), unconfirmed_run_count: f.unconfirmed ?? 0,
          ...(f.status === 'held_for_review' ? { held_reason: 'refund_not_visible' } : {}), ...(f.status === 'completed' ? { completed_at: new Date(START), ledger_entry_id: '01900000-0000-7000-8000-0000000cc000' } : {}),
          created_by: A, updated_by: A });
      }
    },
    row: (n, tenant = A) => h.db.intents(tenant).find((r) => r.id === id(n)),
    tick: (tenant = A, now = START, payload) => inTx(tenant, now, (ctx) => createReconcileTenant(h.deps, h.ports)(payload ?? { tenant_id: tenant }, ctxOf(tenant, now, ctx, 'tick-1'))),
    batch: (job, now = START, as) => { const tenant = as ?? job.payload.tenant_id ?? A; return inTx(tenant, now, (ctx) => createReconcileBatch(h.deps, h.ports)(job.payload, ctxOf(tenant, now, ctx, `batch-${job.key}`))); },
    async drain(now = START) {
      const out: Job[] = [];
      for (let guard = 0; guard < 400; guard++) {
        const next = h.jobs.find((j) => j.task === RECONCILE_BATCH && !ran.has(j));
        if (!next) break;
        ran.add(next); out.push(next);
        await self.batch(next, typeof now === 'function' ? now(out.length - 1) : now);
      }
      return out;
    },
    batchJobs: () => h.jobs.filter((j) => j.task === RECONCILE_BATCH),
    runs: (tenant = A) => h.db.runs(tenant),
    findings: (tenant = A) => h.db.findings(tenant),
    kinds: (tenant = A) => h.db.findings(tenant).map((f) => f.kind).sort(),
    gatewayChecks: (n) => h.gateway.calls.filter((c) => c.op === 'check' && (n === undefined || c.intentId === id(n))).length,
  };
  return self;
}
export { RECONCILE_BATCH, RECONCILE_TENANT, FIXED_NOW };
