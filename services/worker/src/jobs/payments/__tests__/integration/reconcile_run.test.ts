// PG-T13 (C15) — run mechanics of payments.reconcile_tenant / payments.reconcile_batch (02-TRD §6.7 "Transaction boundaries", §8.3 rows 4-5; AC-PG-08.1, 08.6, 08.8):
// batches <= 50 in their own jobs (key recon:<run>:<phase>:<after_id|start>, id order, no candidate twice), candidate windows relative to the run's started_at, business_date rule,
// one running run, stalled-run rule, untrusted job payloads. LD-122 (2026-11-12): recreated after the lost tester pass. Seam: helpers/reconcileHarness.ts header.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, B, DAY, HOUR, MIN, START, id, makeReconcileHarness, type Job, type ReconcileHarness } from '../helpers/reconcileHarness';

let rh: ReconcileHarness;
const seedOpen = (count: number) => rh.seed(Array.from({ length: count }, (_, i) => ({ n: i + 1, status: 'pending' as const, raw: 'PENDING' })));   // eSewa PENDING before the deadline: stays, no finding
const keys = () => rh.batchJobs().map((j) => j.key);
const runId = () => rh.runs()[0]!.id;
const stable = () => JSON.stringify([rh.runs(), rh.findings(), rh.batchJobs().length, rh.h.gateway.calls.length]);

beforeEach(async () => { rh = await makeReconcileHarness(); });

describe('batches <= 50 in their own jobs (TRD §6.7 [CONV], AC-PG-08.1)', () => {
  it('120 open intents -> batches of 50 / 50 / 20, each its own job with key recon:<run>:intents:<start|last id of the previous batch>, then the refunds phase', async () => {
    await seedOpen(120);
    await rh.tick();
    const rid = runId();
    expect(keys()).toEqual([`recon:${rid}:intents:start`]);                     // the tick enqueues ONLY the first batch
    expect(rh.h.gateway.calls).toHaveLength(0);                                 // and calls no gateway
    const sizes: number[] = []; const run = async () => { const before = rh.gatewayChecks(); const j = rh.batchJobs().find((x) => !ranJobs.has(x))!; ranJobs.add(j); await rh.batch(j); sizes.push(rh.gatewayChecks() - before); };
    const ranJobs = new Set<Job>();
    await run(); expect(keys()).toEqual([`recon:${rid}:intents:start`, `recon:${rid}:intents:${id(50)}`]);
    expect(rh.runs()[0]).toMatchObject({ status: 'running', checked_count: 50 });
    expect([1, 50].map((n) => rh.gatewayChecks(n))).toEqual([1, 1]); expect(rh.gatewayChecks(51)).toBe(0);   // id order, 50 per batch
    await run(); expect(keys()[2]).toBe(`recon:${rid}:intents:${id(100)}`);
    await run(); expect(keys()[3]).toBe(`recon:${rid}:refunds:start`);          // intents done -> refunds phase
    expect(rh.runs()[0]).toMatchObject({ status: 'running', checked_count: 120 });
    await run();                                                                // the refunds batch (no refunds) completes the run
    expect(sizes).toEqual([50, 50, 20, 0]);
    expect(rh.batchJobs()).toHaveLength(4);
    expect(rh.runs()[0]).toMatchObject({ status: 'completed', checked_count: 120, ok_count: 120, findings_count: 0, critical_count: 0 });
    for (let n = 1; n <= 120; n++) expect(rh.gatewayChecks(n), `intent ${n} checked once`).toBe(1);
  });

  it('exactly 50 candidates are ONE batch (no after_id batch); 51 candidates are 50 + 1', async () => {
    await seedOpen(50); await rh.tick(); await rh.drain();
    expect(keys()).toEqual([`recon:${runId()}:intents:start`, `recon:${runId()}:refunds:start`]);
    await seedOpen(51); await rh.tick(); const rid = runId();
    await rh.drain();
    expect(keys()).toEqual([`recon:${rid}:intents:start`, `recon:${rid}:intents:${id(50)}`, `recon:${rid}:refunds:start`]);
    expect(rh.runs()[0]).toMatchObject({ status: 'completed', checked_count: 51 });
  });

  it('the refunds phase batches the same way (51 refunds -> 2 jobs after_id = last refund id order)', async () => {
    const specs = Array.from({ length: 51 }, (_, i) => ({ n: i + 1, status: 'settled' as const, raw: 'FULL_REFUND' }));
    await rh.seed(specs, specs.map((s) => ({ n: s.n, intent: s.n, status: 'requested' as const })));
    await rh.tick(); const rid = runId(); await rh.drain();
    const refundJobs = rh.batchJobs().filter((j) => j.payload.phase === 'refunds');
    expect(refundJobs).toHaveLength(2);
    expect(refundJobs[0]!.key).toBe(`recon:${rid}:refunds:start`);
    expect(refundJobs[1]!.key).toMatch(new RegExp(`^recon:${rid}:refunds:[0-9a-f-]{36}$`)); expect(refundJobs[1]!.payload).toMatchObject({ tenant_id: A, run_id: rid, phase: 'refunds', after_id: expect.any(String) });
    expect(rh.runs()[0]!.status).toBe('completed');
  });

  it('every batch payload is {tenant_id, run_id, phase, after_id?} and nothing else (ids only)', async () => {
    await seedOpen(60); await rh.tick(); await rh.drain();
    for (const j of rh.batchJobs()) { expect(Object.keys(j.payload).every((k) => ['tenant_id', 'run_id', 'phase', 'after_id'].includes(k))).toBe(true); expect(j.payload.tenant_id).toBe(A); }
  });

  it('counts are added per batch onto the run row and equal the findings written (checked / ok / findings / critical)', async () => {
    await rh.seed(Array.from({ length: 60 }, (_, i) => ({ n: i + 1, status: 'initiated' as const, raw: i % 3 === 0 ? 'COMPLETE' : i % 3 === 1 ? 'PENDING' : 'COMPLETE', gwAmount: i % 3 === 2 ? 5 : undefined })));
    await rh.tick(); await rh.drain();
    const f = rh.findings(); const run = rh.runs()[0]!;
    expect(run.status).toBe('completed');
    expect(run.checked_count).toBe(60); expect(run.findings_count).toBe(f.length);
    expect(run.critical_count).toBe(f.filter((x) => x.severity === 'critical').length);
    expect(run.ok_count).toBe(60 - new Set(f.map((x) => x.intent_id)).size);
    expect(f.filter((x) => x.kind === 'missed_settlement')).toHaveLength(20); expect(f.filter((x) => x.kind === 'amount_mismatch')).toHaveLength(20);
  });

  it('a run with no candidates still completes (0 counts) and sets the success metric', async () => {
    await rh.seed([]);
    await rh.tick(); await rh.drain();
    expect(rh.runs()[0]).toMatchObject({ status: 'completed', checked_count: 0, ok_count: 0, findings_count: 0 });
    expect(rh.metrics.sets.filter((m) => m.name === 'lims_payments_reconciliation_last_success_timestamp_seconds')).toHaveLength(1);
  });
});

describe('candidate windows are evaluated relative to the run\'s started_at (TRD §6.7), AC-PG-08.1', () => {
  it('open and held intents always; settled-family only when settled_at >= started_at - 2 d; failed/expired only when closed_at >= started_at - 7 d', async () => {
    await rh.seed([
      { n: 1, status: 'created' }, { n: 2, status: 'initiated', raw: 'PENDING' }, { n: 3, status: 'pending', raw: 'PENDING' }, { n: 4, status: 'held_for_review', raw: 'PENDING' },
      { n: 5, status: 'settled', settledAgoMs: DAY }, { n: 6, status: 'settled', settledAgoMs: 2 * DAY + MIN },
      { n: 7, status: 'partially_refunded', refunded: 1000, settledAgoMs: DAY }, { n: 8, status: 'refunded', refunded: 225000, settledAgoMs: 3 * DAY },
      { n: 9, status: 'failed', closedAgoMs: 6 * DAY }, { n: 10, status: 'expired', closedAgoMs: 8 * DAY }, { n: 11, status: 'expired', closedAgoMs: 7 * DAY - MIN },
    ]);
    await rh.tick(); await rh.drain();
    const checked = (n: number) => rh.gatewayChecks(n) > 0;
    expect([1, 2, 3, 4, 5, 7, 9, 11].map(checked)).toEqual(Array(8).fill(true));
    expect([6, 8, 10].map(checked)).toEqual([false, false, false]);
    expect(rh.runs()[0]!.checked_count).toBe(8);
  });

  it('the window boundaries are inclusive: settled exactly 2 d and closed exactly 7 d before started_at are candidates', async () => {
    await rh.seed([{ n: 1, status: 'settled', settledAgoMs: 2 * DAY }, { n: 2, status: 'failed', closedAgoMs: 7 * DAY }]);
    await rh.tick(); await rh.drain();
    expect([rh.gatewayChecks(1) > 0, rh.gatewayChecks(2) > 0]).toEqual([true, true]);
  });

  it('a later batch (5 h after the tick) still uses started_at, not its own wall clock: an intent settled 2 d - 1 min before started_at is checked', async () => {
    await rh.seed([{ n: 1, status: 'settled', settledAgoMs: 2 * DAY - MIN }]);
    await rh.tick(A, START); await rh.drain(START + 5 * HOUR);
    expect(rh.gatewayChecks(1)).toBeGreaterThan(0);
  });

  it('only the job\'s tenant: intents of tenant B are never candidates of A\'s run', async () => {
    await rh.seed([{ n: 1, status: 'pending', raw: 'PENDING' }, { n: 2, status: 'pending', raw: 'PENDING', tenant: B }]);
    await rh.tick(); await rh.drain();
    expect(rh.gatewayChecks(2)).toBe(0); expect(rh.runs()[0]!.checked_count).toBe(1); expect(rh.runs(B)).toHaveLength(0);
  });
});

describe('payments.reconcile_tenant (AC-PG-08.6, 08.8, one running run)', () => {
  it('cron run: business_date = previous Kathmandu date, trigger cron, first batch only, no gateway call', async () => {
    await seedOpen(3); await rh.tick();
    expect(rh.runs()).toHaveLength(1);
    expect(rh.runs()[0]).toMatchObject({ trigger: 'cron', status: 'running', checked_count: 0 }); expect(String(rh.runs()[0]!.business_date).slice(0, 10)).toBe('2026-11-11');
    expect(rh.batchJobs()).toHaveLength(1); expect(rh.batchJobs()[0]!.payload).toMatchObject({ tenant_id: A, phase: 'intents' }); expect(rh.h.gateway.calls).toHaveLength(0);
  });

  it('a second tick while the first run is healthy starts nothing: one running run, one batch job', async () => {
    await seedOpen(2); await rh.tick(A, START);
    await rh.tick(A, START + 30 * MIN).catch((e) => { expect(e.code).toBe('payments.reconciliation_in_progress'); });
    expect(rh.runs().filter((r) => r.status === 'running')).toHaveLength(1); expect(rh.runs()).toHaveLength(1); expect(rh.batchJobs()).toHaveLength(1);
  });

  it('stalled-run rule: no update for > 2 h -> failed with error_code stalled and a fresh run is started; a late batch of the dead run does nothing', async () => {
    await seedOpen(2); await rh.tick(A, START);
    const dead = rh.batchJobs()[0]!;
    await rh.tick(A, START + 2 * HOUR + MIN);
    expect(rh.runs().map((r) => [r.status, r.error_code ?? null])).toEqual([['failed', 'stalled'], ['running', null]]);
    expect(rh.batchJobs()).toHaveLength(2);
    await rh.batch(dead, START + 3 * HOUR);
    expect(rh.gatewayChecks()).toBe(0); expect(rh.runs()[0]).toMatchObject({ status: 'failed', checked_count: 0 });
  });

  it('a batch that updated the run keeps it alive: updated_at moves, so 2 h after the LAST batch (not after the start) is the stall point', async () => {
    await seedOpen(60); await rh.tick(A, START);
    await rh.batch(rh.batchJobs()[0]!, START + 90 * MIN);                       // first batch of 50 at +1.5 h -> next batch enqueued, run still running
    await rh.tick(A, START + 3 * HOUR).catch(() => undefined);                  // +3 h: only 1.5 h since the last update -> healthy
    expect(rh.runs().map((r) => r.status)).toEqual(['running']);
    await rh.tick(A, START + 4 * HOUR);                                         // +4 h: 2.5 h since the last update -> stalled
    expect(rh.runs().map((r) => r.status)).toEqual(['failed', 'running']);
  });

  it('reconciliation_enabled = false: no run, no job; payload naming another tenant: nothing happens', async () => {
    await seedOpen(1);
    rh.h.db.put('payments.settings', { tenant_id: A, reconciliation_enabled: false, created_by: A, updated_by: A });
    await rh.tick(); expect(rh.runs()).toHaveLength(0); expect(rh.batchJobs()).toHaveLength(0);
    rh.h.db.settings(A)[0]!.reconciliation_enabled = true;
    await rh.tick(A, START, { tenant_id: B }); expect(rh.runs(A)).toHaveLength(0); expect(rh.runs(B)).toHaveLength(0); expect(rh.batchJobs()).toHaveLength(0);
    await rh.tick(A, START, {}); expect(rh.runs(A)).toHaveLength(0);
  });
});

describe('payments.reconcile_batch — untrusted payload (tenant scope from the job, ids validated, dead runs ignored)', () => {
  beforeEach(async () => { await seedOpen(3); await rh.tick(); });
  const attempt = async (payload: any, as: string = A) => { const before = stable(); await rh.batch({ task: 'payments.reconcile_batch', key: 'x', payload }, START, as); expect(stable()).toBe(before); };
  const good = () => rh.batchJobs()[0]!.payload;

  it('payload tenant_id that is not the job\'s tenant -> nothing (no gateway call, no row changed)', async () => { await attempt({ ...good(), tenant_id: B }, A); await attempt(good(), B); });
  it('malformed / foreign ids and phases -> nothing', async () => {
    for (const p of [{ ...good(), run_id: 'x' }, { ...good(), run_id: id(9999) }, { ...good(), phase: 'bogus' }, { ...good(), phase: undefined }, { ...good(), after_id: 'x' }, { ...good(), after_id: 5 }, { ...good(), run_id: undefined }, {}, undefined]) await attempt(p);
  });
  it('a batch of a failed or completed run does nothing', async () => {
    rh.runs()[0]!.status = 'failed'; await attempt(good());
    rh.runs()[0]!.status = 'completed'; await attempt(good());
  });
  it('the valid payload works (control)', async () => { await rh.batch(rh.batchJobs()[0]!); expect(rh.runs()[0]!.checked_count).toBe(3); });
  it('a payload with extra fields cannot widen the scope: after_id past all ids yields an empty intents batch, extra keys are ignored', async () => {
    await rh.batch({ task: 'payments.reconcile_batch', key: 'y', payload: { ...good(), after_id: id(9000), centre_id: 'x', limit: 9999, include_all: true } });
    expect(rh.gatewayChecks()).toBe(0);
  });
});
