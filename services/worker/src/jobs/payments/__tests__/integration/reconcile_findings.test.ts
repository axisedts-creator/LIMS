// PG-T13 (C15) — every reconciliation finding kind of 02-TRD §6.7 produced from simulated gateway scenarios through the real tasks (payments.reconcile_tenant -> payments.reconcile_batch),
// AC-PG-08.1-08.5, 08.9, the ledger repair refusal (billing.payment_exceeds_due), the P-44 savepoint marker test (TRD §4 "ctx.db.tx"), metrics.
// LD-122 (2026-11-12): tests recreated after the lost tester pass. SEAM (header of helpers/reconcileHarness.ts): tasks/reconcile_tenant.ts + tasks/reconcile_batch.ts over
// service/reconciliation.service.ts. [CONV] pinned (writer notes): run `checked` counts every processed candidate, a failed candidate is counted but not ok; transient answers retry up to 3 times in
// the run, then gateway_unreachable; gateway_refund_unrecorded is suppressed when completed + in-flight refunds cover the gateway refund; a visible refund is left untouched (completion = PG-T15).
import { beforeEach, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../../../api/src/core/errors.js';
import { A, DAY, DUE, FINDINGS_METRIC, LAST_SUCCESS_METRIC, START, id, makeReconcileHarness, refundId, type ReconcileHarness } from '../helpers/reconcileHarness';

let rh: ReconcileHarness;
const go = async (now = START) => { await rh.tick(A, now); return rh.drain(now); };
const one = (kind: string) => { const f = rh.findings().filter((x) => x.kind === kind); expect(f, `findings of kind ${kind}`).toHaveLength(1); return f[0]!; };
const ofIntent = (n: number) => rh.findings().filter((f) => f.intent_id === id(n));
/** the ledger already holds the entry of this intent (so recordGatewayPayment answers duplicate:true) */
const ledgerHas = (...ns: number[]) => { for (const n of ns) { const r = rh.row(n); rh.h.ledger.calls.push({ gateway: r.gateway, gatewayTxnRef: r.gateway_txn_ref }); } };
const intent = (n: number) => rh.row(n);

beforeEach(async () => { rh = await makeReconcileHarness(); });

describe('task ids', () => {
  it('are exactly payments.reconcile_tenant and payments.reconcile_batch', async () => {
    const m = await import('../helpers/reconcileHarness');
    expect(m.RECONCILE_TENANT).toBe('payments.reconcile_tenant'); expect(m.RECONCILE_BATCH).toBe('payments.reconcile_batch');
  });
});

describe('AC-PG-08.2 missed_settlement (warning, auto_action settled)', () => {
  it('an initiated eSewa intent whose gateway says COMPLETE + exact amount is settled by the run; one finding with both amounts and statuses', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }]);
    await go();
    const f = one('missed_settlement');
    expect(f).toMatchObject({ severity: 'warning', auto_action: 'settled', status: 'open', intent_id: id(1), refund_id: null, our_status: 'initiated', gateway_status_raw: 'COMPLETE', run_id: rh.runs()[0]!.id, version: 1 });
    expect([Number(f.our_amount_paisa), Number(f.gateway_amount_paisa)]).toEqual([DUE, DUE]);
    expect(intent(1)).toMatchObject({ status: 'settled', verified_amount_paisa: DUE });
    expect(rh.h.ledger.calls).toHaveLength(1);                                 // exactly the settle's own ledger call; no second one for an intent settled by this check
    expect(rh.runs()[0]).toMatchObject({ status: 'completed', checked_count: 1, ok_count: 0, findings_count: 1, critical_count: 0 });
  });

  it('Khalti (Completed) pending intents and held intents with a now-matching amount are settled the same way', async () => {
    await rh.seed([{ n: 1, status: 'pending', gw: 'khalti', raw: 'Completed' }, { n: 2, status: 'held_for_review', raw: 'COMPLETE' }]);
    await go();
    expect(rh.kinds()).toEqual(['missed_settlement', 'missed_settlement']);
    expect([intent(1).status, intent(2).status]).toEqual(['settled', 'settled']);
    expect(rh.findings().every((f) => f.auto_action === 'settled' && f.severity === 'warning')).toBe(true);
  });
});

describe('still_held (info, none)', () => {
  it('a held intent the gateway still cannot settle stays held and yields one info finding', async () => {
    await rh.seed([{ n: 1, status: 'held_for_review', raw: 'PENDING' }]);
    await go();
    expect(one('still_held')).toMatchObject({ severity: 'info', auto_action: 'none', intent_id: id(1), our_status: 'held_for_review', gateway_status_raw: 'PENDING' });
    expect(intent(1).status).toBe('held_for_review');
  });
});

describe('AC-PG-08.4 late_payment_found (critical, auto_action held — I13, CR-C15-003)', () => {
  it('an expired / failed intent whose gateway says success goes to held_for_review with a critical finding; nothing is settled or posted', async () => {
    await rh.seed([{ n: 1, status: 'expired', raw: 'COMPLETE' }, { n: 2, status: 'failed', gw: 'khalti', raw: 'Completed' }]);
    await go();
    expect(rh.kinds()).toEqual(['late_payment_found', 'late_payment_found']);
    expect(rh.findings().every((f) => f.severity === 'critical' && f.auto_action === 'held' && f.status === 'open')).toBe(true);
    expect(ofIntent(1)[0]!.our_status).toBe('expired'); expect(ofIntent(2)[0]!.our_status).toBe('failed');
    expect([intent(1).status, intent(2).status]).toEqual(['held_for_review', 'held_for_review']);
    expect(intent(1).hold_reason).toBe('late_payment_found');
    expect(rh.h.ledger.calls).toHaveLength(0);                                 // a late payment is held for finance, never posted by the run
    expect(rh.runs()[0]).toMatchObject({ checked_count: 2, findings_count: 2, critical_count: 2 });
  });
});

describe('status_divergence (critical, none)', () => {
  it('a settled intent whose gateway no longer says success/refund -> finding, intent and ledger untouched', async () => {
    await rh.seed([{ n: 1, status: 'settled', gw: 'khalti', raw: 'Pending' }, { n: 2, status: 'settled', raw: 'CANCELED' }]);
    ledgerHas(1, 2); const before = rh.h.ledger.calls.length;
    await go();
    expect(rh.kinds()).toEqual(['status_divergence', 'status_divergence']);
    expect(rh.findings().every((f) => f.severity === 'critical' && f.auto_action === 'none')).toBe(true);
    expect(ofIntent(1)[0]).toMatchObject({ our_status: 'settled', gateway_status_raw: 'Pending' });
    expect([intent(1).status, intent(2).status]).toEqual(['settled', 'settled']);
    expect(rh.h.ledger.calls).toHaveLength(before + 2); expect(rh.h.ledger.refunds).toHaveLength(0);   // + the two idempotent re-calls (duplicate:true); nothing new posted
  });

  it('the stored gateway_status_raw is capped at 64 chars (untrusted gateway text) and never breaks the finding row', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: `<script>alert(1)</script>${'Z'.repeat(300)}` }]);
    ledgerHas(1);
    await go();
    const f = one('status_divergence');
    expect(String(f.gateway_status_raw).length).toBeLessThanOrEqual(64);
    expect(rh.runs()[0]!.status).toBe('completed');
  });
});

describe('AC-PG-08.3 gateway_refund_unrecorded (critical, none; "reconciliation never silently edits the ledger")', () => {
  it('a settled intent the gateway shows as FULL_REFUND / Refunded with no C15 refund -> finding, no automatic ledger or intent change', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'FULL_REFUND' }, { n: 2, status: 'settled', gw: 'khalti', raw: 'Refunded' }]);
    ledgerHas(1, 2); const before = rh.h.ledger.calls.length;
    await go();
    expect(rh.kinds()).toEqual(['gateway_refund_unrecorded', 'gateway_refund_unrecorded']);
    expect(rh.findings().every((f) => f.severity === 'critical' && f.auto_action === 'none')).toBe(true);
    expect(ofIntent(1)[0]).toMatchObject({ our_status: 'settled', gateway_status_raw: 'FULL_REFUND' });
    expect([intent(1).status, intent(1).refunded_paisa, intent(2).status]).toEqual(['settled', 0, 'settled']);
    expect(rh.h.ledger.refunds).toHaveLength(0); expect(rh.h.ledger.calls).toHaveLength(before + 2);   // only the idempotent re-calls
  });

  it('is suppressed when C15 refunds already explain the gateway refund (completed refunded_paisa or an in-flight requested / held refund), still raised when they cover less', async () => {
    await rh.seed([
      { n: 1, status: 'refunded', raw: 'FULL_REFUND', refunded: DUE },                 // completed in full
      { n: 2, status: 'settled', raw: 'FULL_REFUND' },                                  // in flight, full amount
      { n: 3, status: 'settled', raw: 'PARTIAL_REFUND' },                               // partial gateway refund, in-flight partial refund
      { n: 4, status: 'settled', raw: 'FULL_REFUND' },                                  // only a partial refund is recorded -> not explained
      { n: 5, status: 'settled', raw: 'PARTIAL_REFUND' },                               // nothing recorded -> raised
    ], [{ n: 2, intent: 2, status: 'requested' }, { n: 3, intent: 3, status: 'held_for_review', amount: 1000 }, { n: 4, intent: 4, status: 'requested', amount: 1000 }]);
    ledgerHas(1, 2, 3, 4, 5);
    await go();
    expect(rh.findings().filter((f) => f.kind === 'gateway_refund_unrecorded').map((f) => f.intent_id).sort()).toEqual([id(4), id(5)]);
  });
});

describe('amount_mismatch (critical)', () => {
  it('open intent + COMPLETE with another amount -> held_for_review + finding auto_action held (both amounts recorded)', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE', gwAmount: 100 }]);
    await go();
    const f = one('amount_mismatch');
    expect(f).toMatchObject({ severity: 'critical', auto_action: 'held', our_status: 'initiated', gateway_status_raw: 'COMPLETE' });
    expect([Number(f.our_amount_paisa), Number(f.gateway_amount_paisa)]).toEqual([DUE, 100]);
    expect(intent(1).status).toBe('held_for_review'); expect(rh.h.ledger.calls).toHaveLength(0);
  });

  it('settled intent whose gateway amount differs -> finding auto_action none, intent stays settled; held intent whose amount still differs -> amount_mismatch (not still_held)', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE', gwAmount: 5 }, { n: 2, status: 'held_for_review', raw: 'COMPLETE', gwAmount: 5 }]);
    ledgerHas(1);
    await go();
    expect(ofIntent(1).map((f) => [f.kind, f.severity, f.auto_action])).toEqual([['amount_mismatch', 'critical', 'none']]);
    expect(ofIntent(2).map((f) => [f.kind, f.severity, f.auto_action])).toEqual([['amount_mismatch', 'critical', 'none']]);
    expect([intent(1).status, intent(2).status]).toEqual(['settled', 'held_for_review']);
  });
});

describe('AC-PG-08.5 ledger_entry_missing — the idempotent recordGatewayPayment re-call for every settled intent', () => {
  it('duplicate:true is the healthy answer: no finding, the intent counts as ok', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }]);
    ledgerHas(1); const before = rh.h.ledger.calls.length;
    await go();
    expect(rh.findings()).toHaveLength(0);
    expect(rh.h.ledger.calls.length).toBe(before + 1);                          // the re-call happened
    expect(rh.h.ledger.calls[before]).toMatchObject({ intentId: id(1), gateway: 'esewa', gatewayTxnRef: id(1), amount: { amountPaisa: DUE, currency: 'NPR' } });
    expect(rh.runs()[0]).toMatchObject({ checked_count: 1, ok_count: 1, findings_count: 0 });
  });

  it('duplicate:false (the entry was missing, now recorded) -> critical finding with auto_action ledger_repaired', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }]);
    await go();
    expect(one('ledger_entry_missing')).toMatchObject({ severity: 'critical', auto_action: 'ledger_repaired', intent_id: id(1), our_status: 'settled' });
    expect(rh.h.ledger.calls).toHaveLength(1);
    expect(rh.runs()[0]).toMatchObject({ ok_count: 0, findings_count: 1, critical_count: 1 });
  });

  it('partially_refunded / refunded intents are settled-family too (the re-call also runs)', async () => {
    await rh.seed([{ n: 1, status: 'partially_refunded', raw: 'COMPLETE', refunded: 1000 }, { n: 2, status: 'refunded', raw: 'COMPLETE', refunded: DUE }]);
    await go();
    expect(rh.findings().filter((f) => f.kind === 'ledger_entry_missing').map((f) => f.intent_id).sort()).toEqual([id(1), id(2)]);
  });

  it('billing.payment_exceeds_due -> finding ledger_entry_missing (critical, auto none), NO retry, the savepoint is rolled back (P-44 marker gone) and the run continues', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }, { n: 2, status: 'initiated', raw: 'COMPLETE' }, { n: 3, status: 'expired', raw: 'COMPLETE' }]);
    rh.h.faults.ledger = { error: new LimsError('billing.payment_exceeds_due'), forIntent: id(1), marker: 'repair-attempt' };
    const real = rh.h.ports.BillingPort.recordGatewayPayment; let attempts = 0;
    rh.h.ports.BillingPort.recordGatewayPayment = (c: any, i: any) => { if (i.intentId === id(1)) attempts++; return real(c, i); };
    await go();
    expect(attempts).toBe(1);                                                    // refused once, never retried
    expect(ofIntent(1).map((f) => [f.kind, f.severity, f.auto_action])).toEqual([['ledger_entry_missing', 'critical', 'none']]);
    expect(rh.h.db.markers(A)).toEqual([]);                                      // the failing call's own write was rolled back to its savepoint
    expect(ofIntent(2)[0]).toMatchObject({ kind: 'missed_settlement' }); expect(ofIntent(3)[0]).toMatchObject({ kind: 'late_payment_found' });
    expect(rh.runs()[0]).toMatchObject({ status: 'completed', checked_count: 3, findings_count: 3 });
  });
});

describe('P-44 savepoint per candidate: one failing candidate is rolled back and counted, the rest of the batch survives', () => {
  it('harness control: the marker written by a failing ledger call is rolled back by ctx.db.tx and would persist without it', async () => {
    await rh.seed([{ n: 1, status: 'settled' }]);
    const input = { intentId: id(1), orderId: 'o', gateway: 'esewa', gatewayTxnRef: id(1), amount: { amountPaisa: DUE, currency: 'NPR' }, verifiedAt: new Date(START).toISOString() };
    rh.h.faults.ledger = { error: new Error('boom'), marker: 'm' };
    await rh.h.db.run(async (ctx) => { await ctx.db.tx(() => rh.h.ports.BillingPort.recordGatewayPayment(ctx, input)).catch(() => undefined); }, { tenantId: A });
    expect(rh.h.db.markers(A)).toHaveLength(0);
    await rh.h.db.run(async (ctx) => { await rh.h.ports.BillingPort.recordGatewayPayment(ctx, input).catch(() => undefined); }, { tenantId: A });
    expect(rh.h.db.markers(A)).toHaveLength(1);
  });

  it('an unexpected error in candidate 1: its marker and writes are absent after commit, candidates 2 and 3 keep their findings, the run completes, checked counts all three, ok counts none of the failed', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }, { n: 2, status: 'initiated', raw: 'COMPLETE' }, { n: 3, status: 'settled', raw: 'COMPLETE' }]);
    ledgerHas(3);
    rh.h.faults.ledger = { error: new Error('boom: ledger offline'), forIntent: id(1), marker: 'candidate-1' };
    await go();
    expect(rh.h.db.markers(A)).toEqual([]);
    expect(ofIntent(1)).toEqual([]);                                             // an unexpected error is never turned into a finding about money
    expect(ofIntent(2)[0]).toMatchObject({ kind: 'missed_settlement' });
    expect(intent(2).status).toBe('settled');
    expect(rh.runs()[0]).toMatchObject({ status: 'completed', checked_count: 3, ok_count: 1, findings_count: 1 });
    expect(rh.h.alerts.filter((a) => a.event === 'payments_reconcile_item_failed')).toHaveLength(1);
    expect(JSON.stringify(rh.h.alerts)).not.toMatch(/boom|secret/i);             // ids only in the alert
    expect(rh.h.alerts[0]!.fields).toMatchObject({ intentId: id(1) });
  });

  it('a failure in the last candidate does not stop the run from completing (metric set, run completed)', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }, { n: 2, status: 'settled', raw: 'COMPLETE' }]);
    rh.h.faults.ledger = { error: new Error('boom'), forIntent: id(2), marker: 'last' };
    await go();
    expect(rh.runs()[0]!.status).toBe('completed'); expect(rh.kinds()).toEqual(['missed_settlement']);
    expect(rh.metrics.sets.filter((s) => s.name === LAST_SUCCESS_METRIC)).toHaveLength(1);
  });
});

describe('AC-PG-08.9 refund_unconfirmed — created when unconfirmed_run_count reaches 2 (review m#20)', () => {
  const scenario = async () => { await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }], [{ n: 1, intent: 1, status: 'requested' }]); ledgerHas(1); };
  const refund = () => rh.h.db.refunds(A).find((r) => r.id === refundId(1))!;

  it('run 1: count 1, no finding; run 2: count 2 and exactly one warning finding on the refund; run 3: count 3, no further finding', async () => {
    await scenario();
    await go(START);
    expect(refund()).toMatchObject({ unconfirmed_run_count: 1, status: 'requested' }); expect(rh.findings()).toHaveLength(0);
    expect(refund().last_checked_at).toBeInstanceOf(Date);
    await go(START + DAY);
    expect(refund().unconfirmed_run_count).toBe(2);
    expect(one('refund_unconfirmed')).toMatchObject({ severity: 'warning', auto_action: 'none', refund_id: refundId(1), intent_id: id(1), our_status: 'requested', status: 'open' });
    await go(START + 2 * DAY);
    expect(refund().unconfirmed_run_count).toBe(3); expect(rh.findings().filter((f) => f.kind === 'refund_unconfirmed')).toHaveLength(1);
  });

  it('a held_for_review refund is a candidate too; completed / failed refunds are not', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }, { n: 2, status: 'settled', raw: 'COMPLETE' }, { n: 3, status: 'settled', raw: 'COMPLETE' }],
      [{ n: 1, intent: 1, status: 'held_for_review', unconfirmed: 1 }, { n: 2, intent: 2, status: 'completed' }, { n: 3, intent: 3, status: 'failed' }]);
    ledgerHas(1, 2, 3);
    await go();
    const byId = (n: number) => rh.h.db.refunds(A).find((r) => r.id === refundId(n))!;
    expect([byId(1).unconfirmed_run_count, byId(2).unconfirmed_run_count, byId(3).unconfirmed_run_count]).toEqual([2, 0, 0]);
    expect(one('refund_unconfirmed').refund_id).toBe(refundId(1));
  });

  it('a refund that IS visible at the gateway gets no count and no finding (completion belongs to check_refund)', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'FULL_REFUND' }], [{ n: 1, intent: 1, status: 'requested', unconfirmed: 1 }]);
    ledgerHas(1);
    await go();
    expect(rh.h.db.refunds(A)[0]).toMatchObject({ unconfirmed_run_count: 1, status: 'requested' });
    expect(rh.kinds()).toEqual([]);                                              // the gateway refund is explained by the in-flight refund: no gateway_refund_unrecorded either
  });
});

describe('gateway_unreachable (warning, none): >= 3 transient failures for an item in this run', () => {
  it('3 transient answers -> finding, intent untouched, exactly 3 gateway checks for it, the rest of the run goes on', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }, { n: 2, status: 'initiated', raw: 'COMPLETE' }]);
    rh.h.gateway.script[id(1)] = ['code:0', 'code:0', 'code:0'];
    await go();
    expect(ofIntent(1).map((f) => [f.kind, f.severity, f.auto_action])).toEqual([['gateway_unreachable', 'warning', 'none']]);
    expect(intent(1).status).toBe('initiated'); expect(rh.gatewayChecks(1)).toBe(3);
    expect(intent(2).status).toBe('settled'); expect(rh.runs()[0]).toMatchObject({ status: 'completed', checked_count: 2 });
  });

  it('2 transient answers then success -> the intent is settled, no gateway_unreachable', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }]);
    rh.h.gateway.script[id(1)] = ['code:0', 'code:0'];
    await go();
    expect(rh.kinds()).toEqual(['missed_settlement']); expect(rh.gatewayChecks(1)).toBe(3);
  });

  it('a transient answer in the refunds phase is never counted as "not visible": gateway_unreachable on the refund, unconfirmed_run_count unchanged', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }], [{ n: 1, intent: 1, status: 'requested' }]);
    ledgerHas(1);
    rh.h.gateway.script[id(1)] = ['code:0', 'code:0', 'code:0', 'code:0', 'code:0', 'code:0'];   // 3 for the intent, 3 for the refund
    await go();
    const un = rh.findings().filter((f) => f.kind === 'gateway_unreachable');
    expect(un.map((f) => [f.intent_id, f.refund_id]).sort()).toEqual([[id(1), null], [id(1), refundId(1)]].sort());
    expect(rh.h.db.refunds(A)[0]!.unconfirmed_run_count).toBe(0);
  });
});

describe('metrics (TRD §6.7 / §11): findings counter, last-success timestamp (26 h alert PaymentsReconciliationMissing)', () => {
  it('increments lims_payments_reconciliation_findings_total{kind, severity} once per finding', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }, { n: 2, status: 'expired', raw: 'COMPLETE' }]);
    await go();
    const incs = rh.metrics.incs.filter((m) => m.name === FINDINGS_METRIC).map((m) => m.labels);
    expect(incs).toHaveLength(2);
    expect(incs).toEqual(expect.arrayContaining([{ kind: 'missed_settlement', severity: 'warning' }, { kind: 'late_payment_found', severity: 'critical' }]));
  });

  it('sets lims_payments_reconciliation_last_success_timestamp_seconds{tenant_id} = completion time (epoch seconds) exactly when the run completes', async () => {
    await rh.seed([{ n: 1, status: 'settled', raw: 'COMPLETE' }]);
    ledgerHas(1);
    const NOWMS = START + 5 * 60_000;
    await rh.tick(A, START);
    expect(rh.metrics.sets.filter((m) => m.name === LAST_SUCCESS_METRIC)).toHaveLength(0);   // a run that only started is not a success
    await rh.drain(NOWMS);
    const s = rh.metrics.sets.filter((m) => m.name === LAST_SUCCESS_METRIC);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ value: Math.floor(NOWMS / 1000), labels: { tenant_id: A } });
    expect(rh.runs()[0]!.finished_at.getTime()).toBe(NOWMS);
  });

  it('a stalled / failed run never sets the success metric', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }]);
    await rh.tick(A, START);                                                      // run 1 started, its batch never runs (dead-lettered)
    await rh.tick(A, START + 3 * 3600_000);                                       // 3 h later: run 1 -> failed(stalled), run 2 starts
    expect(rh.runs().map((r) => [r.status, r.error_code ?? null])).toEqual([['failed', 'stalled'], ['running', null]]);
    expect(rh.metrics.sets.filter((m) => m.name === LAST_SUCCESS_METRIC)).toHaveLength(0);
  });
});

describe('tenant isolation of findings', () => {
  it('a run of tenant A never checks, changes or reports tenant B\'s intents', async () => {
    await rh.seed([{ n: 1, status: 'initiated', raw: 'COMPLETE' }, { n: 2, status: 'initiated', raw: 'COMPLETE', tenant: '01930000-0000-7000-8000-00000000000b' }]);
    await go();
    expect(rh.findings(A)).toHaveLength(1); expect(rh.findings('01930000-0000-7000-8000-00000000000b')).toHaveLength(0);
    expect(rh.gatewayChecks(2)).toBe(0); expect(rh.row(2, '01930000-0000-7000-8000-00000000000b').status).toBe('initiated');
  });
});
