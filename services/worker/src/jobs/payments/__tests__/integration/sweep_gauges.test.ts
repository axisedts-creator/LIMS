// PG-T20 (C15) — 02-TRD §11 "Backing gauges" + §12 row "Observability (08 A22.4)": payments.sweep_open_intents also sets, per tenant, through ctx.metrics.set(name, value, labels):
//   lims_payments_held_for_review_oldest_age_seconds{tenant_id,kind}  kind in intent|refund, BOTH series set on every tick, 0 when none.
//       intent: now - latest payments.intent_transitions row (to_status='held_for_review') of the OLDEST-held intent whose status is held_for_review now.
//       refund: now - refunds.requested_at of the oldest refund in held_for_review (upper bound, no schema change).
//   lims_payments_reconciliation_stalled_runs{tenant_id}              count of the tenant's reconciliation_runs with status 'running' and updated_at < now - 2 h (strict).
//   lims_payments_open_intents_past_deadline{gateway}                 count of open (created|initiated|pending) intents past expires_at + expiryGrace, per gateway, 0 when none.
//   lims_payments_reconciliation_last_success_timestamp_seconds{tenant_id} is never set for a tenant with reconciliation_enabled = false.
// SEAM THE WRITER FOLLOWS (dispute via .orchestra/notes if wrong): extend createSweepOpenIntents(deps) in tasks/sweep_open_intents.ts; ctx.metrics is optional (absent -> no crash).
// The sweep still writes nothing and calls no gateway. SQL stays in the helpers/merchantDb.ts dialect (no OR / parentheses / sub-selects / intervals: filter and subtract in JS).
// Run: pnpm --dir services/worker exec vitest run src/jobs/payments/__tests__/integration/sweep_gauges.test.ts
// Fails now: the sweep sets no gauge at all.
import { beforeEach, describe, expect, it } from 'vitest';
import { createSweepOpenIntents } from '../../tasks/sweep_open_intents.js';
import { A, B, HOUR, LAST_SUCCESS_METRIC, MIN, START, id, iso, makeReconcileHarness, refundId, type ReconcileHarness } from '../helpers/reconcileHarness';

const HELD = 'lims_payments_held_for_review_oldest_age_seconds';
const STALLED = 'lims_payments_reconciliation_stalled_runs';
const PAST_DEADLINE = 'lims_payments_open_intents_past_deadline';
const NOW = START;

let rh: ReconcileHarness;
beforeEach(async () => { rh = await makeReconcileHarness(); });

const ctxOf = (tenant: string, now: number, ctx: any, withMetrics = true) => ({ ...ctx, tenantId: tenant, actor: { type: 'system', id: tenant }, attempt: 1, maxAttempts: 3, jobId: 'sweep-1', now: () => iso(now),
  ...(withMetrics ? { metrics: { set: (name: string, value: number, labels?: Record<string, string>) => { rh.metrics.sets.push({ name, value, ...(labels ? { labels } : {}) }); },
    inc: (name: string, labels?: Record<string, string>) => { rh.metrics.incs.push({ name, ...(labels ? { labels } : {}) }); } } } : {}) });
const sweep = (tenant = A, now = NOW, withMetrics = true) => rh.h.db.run((ctx: any) => createSweepOpenIntents(rh.h.deps)({ tenant_id: tenant }, ctxOf(tenant, now, ctx, withMetrics)), { tenantId: tenant, now: () => new Date(now) });
/** last value set for (name, labels subset); undefined = series never set */
const last = (name: string, labels: Record<string, string>) => [...rh.metrics.sets].reverse().find((m) => m.name === name && Object.entries(labels).every(([k, v]) => m.labels?.[k] === v))?.value;
const heldTransition = (n: number, agoMs: number, tenant = A, to = 'held_for_review') => rh.h.db.put('payments.intent_transitions',
  { id: `01900000-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`, tenant_id: tenant, intent_id: id(n), to_status: to, cause: 'poll', actor_type: 'system', created_by: tenant, created_at: new Date(NOW - agoMs) });
const run = (n: number, status: string, updatedAgoMs: number, tenant = A) => rh.h.db.put('payments.reconciliation_runs',
  { id: `01900000-0000-7000-8000-0000000a${String(n).padStart(4, '0')}`, tenant_id: tenant, business_date: '2026-11-11', trigger: 'cron', status, started_at: new Date(NOW - 5 * HOUR),
    created_by: tenant, updated_by: tenant, updated_at: new Date(NOW - updatedAgoMs) });
const setRunUpdated = (n: number, agoMs: number, tenant = A) => { rh.h.db.runs(tenant).find((r: any) => r.id.endsWith(String(n).padStart(4, '0')))!.updated_at = new Date(NOW - agoMs); };
const setRefundRequested = (n: number, agoMs: number, tenant = A) => { rh.h.db.refunds(tenant).find((r: any) => r.id === refundId(n))!.requested_at = new Date(NOW - agoMs); };
const writes = (from: number) => rh.h.db.stmts.slice(from).filter((s: any) => /^\s*(update|insert|delete)\b/i.test(s.text));

describe('lims_payments_held_for_review_oldest_age_seconds{tenant_id,kind="intent"} (TRD §11, 08 A22.4)', () => {
  it('intent held 25 h ago -> >= 90000 (spec row: seeded intent held 25 h ago)', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }]); heldTransition(1, 25 * HOUR);
    await sweep();
    const v = last(HELD, { tenant_id: A, kind: 'intent' });
    expect(v).toBeGreaterThanOrEqual(90000); expect(v).toBeLessThan(90000 + 60);
  });

  it('measured from the LATEST held_for_review transition (an older one for the same intent is ignored)', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }]); heldTransition(1, 40 * HOUR); heldTransition(1, 25 * HOUR);
    await sweep();
    expect(last(HELD, { tenant_id: A, kind: 'intent' })).toBe(25 * 3600);
  });

  it('several held intents -> the age of the oldest', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }, { n: 2, status: 'held_for_review' }, { n: 3, status: 'held_for_review' }]);
    heldTransition(1, 5 * HOUR); heldTransition(2, 30 * HOUR); heldTransition(3, 2 * HOUR);
    await sweep();
    expect(last(HELD, { tenant_id: A, kind: 'intent' })).toBe(30 * 3600);
  });

  it('only intents CURRENTLY held count: a settled / pending intent with an old held transition is ignored', async () => {
    await rh.seed([{ n: 1, status: 'settled' }, { n: 2, status: 'pending' }, { n: 3, status: 'held_for_review' }]);
    heldTransition(1, 50 * HOUR); heldTransition(2, 60 * HOUR); heldTransition(3, 3 * HOUR);
    await sweep();
    expect(last(HELD, { tenant_id: A, kind: 'intent' })).toBe(3 * 3600);
  });

  it('a held intent with no transition row does not crash the sweep and is not counted as 0-age garbage (series still set, finite number)', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }]);
    await sweep();
    const v = last(HELD, { tenant_id: A, kind: 'intent' });
    expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('lims_payments_held_for_review_oldest_age_seconds{tenant_id,kind="refund"}', () => {
  it('refund held, requested 2 h ago -> 7200 (spec row ≈ 7200)', async () => {
    await rh.seed([{ n: 1, status: 'settled' }], [{ n: 1, intent: 1, status: 'held_for_review' }]); setRefundRequested(1, 2 * HOUR);
    await sweep();
    expect(last(HELD, { tenant_id: A, kind: 'refund' })).toBe(7200);
  });

  it('oldest of several held refunds; refunds in other statuses are ignored regardless of age', async () => {
    await rh.seed([{ n: 1, status: 'settled' }, { n: 2, status: 'settled' }, { n: 3, status: 'settled' }, { n: 4, status: 'settled' }],
      [{ n: 1, intent: 1, status: 'held_for_review' }, { n: 2, intent: 2, status: 'held_for_review' }, { n: 3, intent: 3, status: 'requested' }, { n: 4, intent: 4, status: 'completed' }]);
    setRefundRequested(1, 6 * HOUR); setRefundRequested(2, 10 * HOUR); setRefundRequested(3, 90 * HOUR); setRefundRequested(4, 90 * HOUR);
    await sweep();
    expect(last(HELD, { tenant_id: A, kind: 'refund' })).toBe(10 * 3600);
  });
});

describe('none held -> both series are SET to 0 (not absent), every tick', () => {
  it('empty tenant: intent 0, refund 0, stalled 0', async () => {
    await rh.seed([{ n: 1, status: 'settled' }]);
    await sweep();
    expect(last(HELD, { tenant_id: A, kind: 'intent' })).toBe(0);
    expect(last(HELD, { tenant_id: A, kind: 'refund' })).toBe(0);
    expect(last(STALLED, { tenant_id: A })).toBe(0);
  });

  it('after the held rows are resolved the next tick resets the gauge to 0 (no stale value)', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }]); heldTransition(1, 25 * HOUR);
    await sweep(); expect(last(HELD, { tenant_id: A, kind: 'intent' })).toBeGreaterThan(0);
    rh.row(1)!.status = 'settled';
    await sweep(A, NOW + 15 * MIN); expect(last(HELD, { tenant_id: A, kind: 'intent' })).toBe(0);
  });
});

describe('lims_payments_reconciliation_stalled_runs{tenant_id} (TRD §11 / §6.7 stalled threshold = 2 h)', () => {
  it('a running run with updated_at 3 h old -> 1; the same run 1 h old -> 0 (spec row)', async () => {
    run(1, 'running', 3 * HOUR);
    await sweep(); expect(last(STALLED, { tenant_id: A })).toBe(1);
    setRunUpdated(1, 1 * HOUR);
    await sweep(); expect(last(STALLED, { tenant_id: A })).toBe(0);
  });

  it('threshold is strict: exactly 2 h old is not stalled, 2 h + 1 s is', async () => {
    run(1, 'running', 2 * HOUR);
    await sweep(); expect(last(STALLED, { tenant_id: A })).toBe(0);
    setRunUpdated(1, 2 * HOUR + 1000);
    await sweep(); expect(last(STALLED, { tenant_id: A })).toBe(1);
  });

  it('counts every stalled running run; completed / failed runs are never counted however old', async () => {
    run(1, 'running', 3 * HOUR); run(2, 'running', 9 * HOUR); run(3, 'running', 30 * MIN); run(4, 'completed', 50 * HOUR); run(5, 'failed', 50 * HOUR);
    await sweep(); expect(last(STALLED, { tenant_id: A })).toBe(2);
  });
});

describe('lims_payments_open_intents_past_deadline{gateway} (TRD §11 "gauge, from sweep")', () => {
  it('counts open intents past expires_at + grace per gateway; 0 for a gateway with none', async () => {
    const grace = rh.h.config.expiryGraceMinutes * MIN;
    await rh.seed([{ n: 1, status: 'initiated', expiresInMin: -(grace / MIN) - 50 }, { n: 2, status: 'pending', expiresInMin: -(grace / MIN) - 5 },
      { n: 3, status: 'initiated', expiresInMin: 60 }, { n: 4, status: 'settled', expiresInMin: -600 }, { n: 5, status: 'initiated', gw: 'khalti', expiresInMin: 60 }]);
    await sweep();
    expect(last(PAST_DEADLINE, { gateway: 'esewa' })).toBe(2);
    expect(last(PAST_DEADLINE, { gateway: 'khalti' })).toBe(0);
  });
});

describe('tenant isolation, label hygiene, and the sweep stays read-only', () => {
  it('tenant B\'s held intent / refund / stalled run never leak into tenant A\'s series; A\'s tick emits no series labelled B', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review', tenant: B }, { n: 2, status: 'settled', tenant: B }], [{ n: 1, intent: 2, status: 'held_for_review', tenant: B }]);
    heldTransition(1, 40 * HOUR, B); setRefundRequested(1, 40 * HOUR, B); run(1, 'running', 9 * HOUR, B);
    await sweep(A);
    expect(last(HELD, { tenant_id: A, kind: 'intent' })).toBe(0); expect(last(HELD, { tenant_id: A, kind: 'refund' })).toBe(0); expect(last(STALLED, { tenant_id: A })).toBe(0);
    expect(rh.metrics.sets.filter((m) => m.labels?.tenant_id === B)).toEqual([]);
    rh.metrics.sets.length = 0;
    await sweep(B);
    expect(last(HELD, { tenant_id: B, kind: 'intent' })).toBe(40 * 3600); expect(last(HELD, { tenant_id: B, kind: 'refund' })).toBe(40 * 3600); expect(last(STALLED, { tenant_id: B })).toBe(1);
  });

  it('label sets are exactly {tenant_id,kind} / {tenant_id} (no ids, no extra labels); kind only intent|refund; values finite and >= 0', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }]); heldTransition(1, 25 * HOUR); run(1, 'running', 3 * HOUR);
    await sweep();
    for (const m of rh.metrics.sets.filter((s) => s.name === HELD)) { expect(Object.keys(m.labels ?? {}).sort()).toEqual(['kind', 'tenant_id']); expect(['intent', 'refund']).toContain(m.labels!.kind); expect(Number.isFinite(m.value) && m.value >= 0).toBe(true); }
    for (const m of rh.metrics.sets.filter((s) => s.name === STALLED)) { expect(Object.keys(m.labels ?? {})).toEqual(['tenant_id']); expect(Number.isFinite(m.value) && m.value >= 0).toBe(true); }
    expect(rh.metrics.sets.filter((s) => s.name === HELD).map((m) => m.labels!.kind).sort()).toEqual(['intent', 'refund']);
  });

  it('setting gauges writes no row and calls no gateway', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }], [{ n: 1, intent: 1, status: 'held_for_review' }]); heldTransition(1, 25 * HOUR); run(1, 'running', 3 * HOUR);
    const mark = rh.h.db.stmts.length;
    await sweep();
    expect(writes(mark)).toEqual([]); expect(rh.h.gateway.calls).toHaveLength(0);
  });

  it('ctx.metrics absent (other callers / PG-T11 harness) -> the sweep still works, no throw', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review' }]); heldTransition(1, 25 * HOUR);
    await expect(sweep(A, NOW, false)).resolves.toBeUndefined();
  });
});

describe('lims_payments_reconciliation_last_success_timestamp_seconds{tenant_id}: exported only for reconciliation_enabled = true', () => {
  const seedOpen = () => rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }]);
  it('disabled tenant: neither the nightly run nor the sweep sets the series; enabled tenant: the completed run does', async () => {
    await seedOpen();
    rh.h.db.put('payments.settings', { tenant_id: A, reconciliation_enabled: false, created_by: A, updated_by: A });
    await rh.tick(); await rh.drain(); await sweep();
    expect(rh.metrics.sets.filter((m) => m.name === LAST_SUCCESS_METRIC)).toEqual([]);
    rh.h.db.settings(A)[0]!.reconciliation_enabled = true;
    await rh.tick(A, NOW + 5 * MIN); await rh.drain(NOW + 6 * MIN);
    expect(last(LAST_SUCCESS_METRIC, { tenant_id: A })).toBeGreaterThan(0);
  });
});
