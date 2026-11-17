// PG-T11 (C15) — cron task `payments.sweep_open_intents` (02-TRD §8.3 row 2: `*/15 * * * *` per_tenant, max_attempts 3; AC-PG-05.3; 01-PRD §6 KPI
// "open intents past deadline + 30 min = 0"). Real services + DB fake + scripted gateways (api helpers/portHarness.ts), fake clock (ctx.now() = tick time).
// SEAM THE WRITER MUST FOLLOW (dispute via .orchestra/notes if wrong):
//   tasks/sweep_open_intents.ts  export const SWEEP_OPEN_INTENTS = 'payments.sweep_open_intents'
//                                export function createSweepOpenIntents(deps: PaymentsDeps): TaskHandler        // payload {} / { tenant_id }, per tenant via ctx.tenantId
//   Selects, for the job's tenant only, intents in status created|initiated|pending whose deadline (= expires_at + deps.config.expiryGraceMinutes, AC-PG-05.1) is
//   before ctx.now() and which had no gateway check in the last 15 min (last_checked_at null or older); for each it calls
//   deps.jobs.enqueue(ctx, 'payments.poll_intent', { tenant_id, intent_id, n }, { key, runAt? }) with runAt absent or <= now ("poll now"). The key is stable per
//   intent (not per tick) so the same lost intent swept again before its poll ran is one job. The sweep itself never writes an intent row and never calls a gateway.
//   SQL stays in the helpers/merchantDb.ts dialect (no OR / parentheses / sub-selects / intervals: compute cutoffs in JS or filter rows in JS). Intents without expires_at
//   have no deadline and are skipped. Refund sweeping (`check_refund`, TRD §8.3) and the held/stalled-run gauges are PG-T14 / metrics work: the fake has no refunds table,
//   so the writer must not query payments.refunds here.
// Fails now: ../../tasks/sweep_open_intents.js does not exist.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makePortHarness, type PortHarness } from '../../../../../../api/src/modules/payments/__tests__/helpers/portHarness';
import { POLL_INTENT, createPollIntent } from '../../tasks/poll_intent.js';
import { SWEEP_OPEN_INTENTS, createSweepOpenIntents } from '../../tasks/sweep_open_intents.js';

const A = TENANTS.A, B = TENANTS.B;
const O1 = '01900000-0000-7000-8000-0000000c1501';
const DUE = 225000;
const MIN = 60_000;
const NOW = Date.parse(FIXED_NOW) + 3 * 3600_000;                         // the sweep tick under test
const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `01900000-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`;
type Job = { task: string; payload: any; key: string; runAt?: Date };

let h: PortHarness;
const GRACE = () => h.config.expiryGraceMinutes * MIN;
const checks = () => h.gateway.calls.filter((c) => c.op === 'check');
const row = (i: string, t = A) => h.db.intents(t).find((r) => r.id === i)!;
const pollJobs = (): Job[] => h.jobs.filter((j) => j.task === POLL_INTENT);
const writes = (from: number) => h.db.stmts.slice(from).filter((s) => /^\s*(update|insert|delete)\b/i.test(s.text));
const ctxOf = (tenant: string, now: number, ctx: any) => ({ ...ctx, tenantId: tenant, actor: { type: 'system', id: tenant }, attempt: 1, maxAttempts: 3, jobId: 'sweep-1', now: () => iso(now) });
const sweep = (tenant = A, now = NOW, handler = createSweepOpenIntents(h.deps)) => h.db.run((ctx) => handler({ tenant_id: tenant }, ctxOf(tenant, now, ctx)), { tenantId: tenant, now: () => new Date(now) });
const poll = (job: Job, now: number) => h.db.run((ctx) => createPollIntent(h.deps, h.ports)(job.payload, ctxOf(job.payload.tenant_id, now, ctx)), { tenantId: job.payload.tenant_id, now: () => new Date(now) });
const swept = (i: string) => pollJobs().filter((j) => j.payload.intent_id === i);

/** expires = deadline - grace, so `pastBy` minutes past the deadline at NOW (negative: not yet due). */
const seedIntents = (specs: { n: number; status?: string; tenant?: string; pastBy?: number; lastCheckedMinAgo?: number; gateway?: 'esewa' | 'khalti'; noExpiry?: boolean; refunded?: number }[]) => h.seed({
  orders: specs.map((s) => ({ id: `01900000-0000-7000-8000-0000000c15${String(s.n).padStart(2, '0')}`, tenantId: s.tenant ?? A, dueAmountPaisa: DUE, gatewayStatus: 'NOT_FOUND' })),
  returnUrlHosts: ['app.lims.test'],
  intents: specs.map((s) => ({ id: id(s.n), tenantId: s.tenant ?? A, orderId: `01900000-0000-7000-8000-0000000c15${String(s.n).padStart(2, '0')}`, gateway: s.gateway ?? 'esewa', status: s.status ?? 'initiated',
    amountPaisa: DUE, idempotencyKey: `seed-${s.n}`, ...(s.noExpiry ? {} : { expiresAt: iso(NOW - (s.pastBy ?? 0) * MIN - GRACE()) }), ...(s.refunded ? { refundedPaisa: s.refunded } : {}) })),
}).then(() => { for (const s of specs) if (s.lastCheckedMinAgo !== undefined) row(id(s.n), s.tenant ?? A).last_checked_at = new Date(NOW - s.lastCheckedMinAgo * MIN); });

beforeEach(async () => { h = await makePortHarness(); });

describe('task id', () => {
  it('is exactly payments.sweep_open_intents', () => { expect(SWEEP_OPEN_INTENTS).toBe('payments.sweep_open_intents'); });
});

describe('AC-PG-05.3 selection: open intents past their deadline with no recent check', () => {
  it('enqueues payments.poll_intent for exactly those; never touches rows, never calls a gateway', async () => {
    await seedIntents([
      { n: 1, status: 'initiated', pastBy: 50 },                                   // lost polls, long overdue -> yes
      { n: 2, status: 'pending', pastBy: 2 },                                      // just past deadline -> yes
      { n: 3, status: 'initiated', pastBy: -5 },                                   // deadline in 5 min -> no
      { n: 4, status: 'initiated', pastBy: 30, lastCheckedMinAgo: 5 },            // checked 5 min ago -> no
      { n: 5, status: 'initiated', pastBy: 30, lastCheckedMinAgo: 20 },           // checked 20 min ago -> yes
      { n: 6, status: 'settled', pastBy: 60 }, { n: 7, status: 'failed', pastBy: 60 }, { n: 8, status: 'expired', pastBy: 60 },
      { n: 9, status: 'held_for_review', pastBy: 60 }, { n: 10, status: 'refunded', pastBy: 60, refunded: DUE }, { n: 11, status: 'partially_refunded', pastBy: 60, refunded: 1000 },
      { n: 12, status: 'initiated', pastBy: 60, noExpiry: true },                  // no deadline -> skipped, no crash
      { n: 13, status: 'initiated', pastBy: 60, gateway: 'khalti' },               // khalti -> yes
    ]);
    const before = h.db.intents(A).map((r) => ({ ...r })); const mark = h.db.stmts.length;
    await sweep();
    expect(pollJobs().map((j) => j.payload.intent_id).sort()).toEqual([1, 2, 5, 13].map(id).sort());
    for (const j of pollJobs()) {
      expect(j.payload).toMatchObject({ tenant_id: A }); expect(typeof j.payload.n).toBe('number');
      expect(j.runAt === undefined || j.runAt.getTime() <= NOW).toBe(true);        // "poll now"
    }
    expect(new Set(pollJobs().map((j) => j.key)).size).toBe(4);
    expect(writes(mark)).toEqual([]); expect(h.db.intents(A)).toEqual(before); expect(checks()).toHaveLength(0);
  });

  it('is per tenant: the tick for tenant A never enqueues tenant B\'s intents, and B\'s own tick enqueues them under tenant_id B', async () => {
    await seedIntents([{ n: 1, pastBy: 50 }, { n: 2, pastBy: 50, tenant: B }]);
    await sweep(A);
    expect(pollJobs().map((j) => [j.payload.tenant_id, j.payload.intent_id])).toEqual([[A, id(1)]]);
    await sweep(B);
    expect(pollJobs().map((j) => [j.payload.tenant_id, j.payload.intent_id]).sort()).toEqual([[A, id(1)], [B, id(2)]].sort());
  });

  it('idempotent: sweeping the same lost intent again (same or a later tick) before its poll ran leaves exactly one job for it', async () => {
    await seedIntents([{ n: 1, pastBy: 50 }]);
    await sweep(A, NOW); await sweep(A, NOW); await sweep(A, NOW + 15 * MIN);
    expect(swept(id(1))).toHaveLength(1);
  });

  it('nothing open or nothing due: a clean no-op', async () => {
    await expect(sweep()).resolves.toBeUndefined();
    await seedIntents([{ n: 1, pastBy: -10 }, { n: 2, status: 'settled', pastBy: 10 }]);
    await expect(sweep()).resolves.toBeUndefined();
    expect(pollJobs()).toEqual([]);
  });

  it('a sweep with a foreign tenant_id in the payload cannot enqueue another tenant\'s intents (the job\'s own tenant scope wins)', async () => {
    await seedIntents([{ n: 1, pastBy: 50 }, { n: 2, pastBy: 50, tenant: B }]);
    await h.db.run((ctx) => createSweepOpenIntents(h.deps)({ tenant_id: B }, ctxOf(A, NOW, ctx)), { tenantId: A, now: () => new Date(NOW) }).catch(() => undefined);
    expect(pollJobs().filter((j) => j.payload.tenant_id === B || j.payload.intent_id === id(2))).toEqual([]);
  });
});

describe('AC-PG-05.3 a lost poll job is recovered by the sweep (fake clock, real createIntent + poll)', () => {
  it('every poll job is lost: the 15-minute sweeps leave the intent alone before its deadline, the first tick after the deadline enqueues the final check, which expires it (never open > deadline + 30 min)', async () => {
    await h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus: 'NOT_FOUND' }], returnUrlHosts: ['app.lims.test'] });
    const created = Date.parse(FIXED_NOW);
    const r = await h.impl.createIntent(h.ctxFor('A:system'), { orderId: O1, gateway: 'esewa', idempotencyKey: 'lost-1', returnUrl: 'https://app.lims.test/pay/done', cancelUrl: 'https://app.lims.test/pay/cancel' });
    const deadline = Date.parse(r.expiresAt) + GRACE();
    h.jobs.length = 0;                                                                   // the queue lost every poll job of the intent
    let closedAt: number | undefined;
    for (let tick = created + 15 * MIN; tick <= created + 4 * 3600_000 && closedAt === undefined; tick += 15 * MIN) {
      const before = h.jobs.length; await sweep(A, tick);
      const fresh = h.jobs.slice(before);
      if (tick <= deadline) { expect(fresh, `tick ${iso(tick)} is not past the deadline`).toEqual([]); expect(checks()).toHaveLength(0); }
      for (const j of fresh) await poll(j, tick);                                       // the enqueued "poll now" job runs at the tick
      if (row(r.intentId).status !== 'initiated') closedAt = tick;
    }
    expect(row(r.intentId).status).toBe('expired');
    expect(closedAt).toBeDefined(); expect(closedAt! - deadline).toBeLessThanOrEqual(30 * MIN); expect(closedAt!).toBeGreaterThan(deadline);
    expect(h.db.transitions(A).filter((t) => t.intent_id === r.intentId).at(-1)).toMatchObject({ to_status: 'expired', cause: 'poll' });
    expect(h.ledger.calls).toHaveLength(0);
  });

  it('a lost poll whose payment succeeded is recovered too: the swept poll settles the intent once (ledger + event once), a later sweep enqueues nothing', async () => {
    await h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus: 'Completed' }], returnUrlHosts: ['app.lims.test'] });
    const r = await h.impl.createIntent(h.ctxFor('A:system'), { orderId: O1, gateway: 'khalti', idempotencyKey: 'lost-2', returnUrl: 'https://app.lims.test/pay/done', cancelUrl: 'https://app.lims.test/pay/cancel' });
    h.jobs.length = 0;
    const tick = Date.parse(r.expiresAt) + GRACE() + 5 * MIN;
    await sweep(A, tick); expect(swept(r.intentId)).toHaveLength(1);
    await poll(swept(r.intentId)[0]!, tick);
    expect(row(r.intentId).status).toBe('settled'); expect(h.ledger.calls).toHaveLength(1); expect(h.events.ofType('payments.intent.settled.v1')).toHaveLength(1);
    const jobs = h.jobs.length; await sweep(A, tick + 15 * MIN);
    expect(h.jobs).toHaveLength(jobs);
  });
});
