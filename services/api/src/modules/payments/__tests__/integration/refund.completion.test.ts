// PG-T15 integration: refund completion by hand - P11 confirmManualPaymentRefund, P7b recheckPaymentRefund, P11b failManualPaymentRefund (TRD §5.1, §6.6 steps 5-9; 02-TRD R5-R8;
// BillingPort.recordGatewayRefund CR-C15-002). ACs: AC-PG-09.4 (manual confirm -> completed + ledger once + intent refunded / partially_refunded), AC-PG-09.5 (gateway shows no refund ->
// held_for_review, held_reason, no ledger row), AC-PG-09.9 (P11b only after a no-refund check; gateway shows a refund -> 409 and nothing written; failed frees the slot),
// AC-PG-09.10 (P7b in-request check; 2nd press within 10 s -> 429 + Retry-After). Security (07-SECURITY): ST-10 (aal1 -> auth.mfa_required, wrong permission 403), ST-18 (other centre -> 404),
// ST-24 (no access-log row, no ctx.audit), tenant isolation, body smuggling, replay (ledger written once), AB-7 (the gateway confirms THAT a refund happened; the amount rests on approval).
// Wiring seam: helpers/refundActionHarness.ts header. The in-memory DB fake serialises transactions; true concurrency needs the C0 payments DDL (not in the repo yet).
// Fails now: handlers/{confirmManualPaymentRefund,recheckPaymentRefund,failManualPaymentRefund}.ts do not exist.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { CENTRE_1, CENTRE_2, M, uid } from '../helpers/refundHarness';
import { GW, at, hdr, makeActionHarness, type ActionHarness } from '../helpers/refundActionHarness';

const A = TENANTS.A;
const CAPTURED = 225000;
const RID = uid(500);
const REF = { gateway_refund_reference: 'KH-REF-2026/0001', refunded_on: '2026-11-10' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const day = (v: unknown): string => new Date(v as string).toISOString().slice(0, 10);

let t: ActionHarness;
const seed = (status = 'requested', o: Partial<Parameters<ActionHarness['addRefund']>[0]> = {}) => t.addRefund({ id: RID, intent: t.intentId, status, ...o });
const confirm = (o: Partial<Parameters<ActionHarness['act']>[1]> = {}) => t.act('confirmManualPaymentRefund', { refundId: RID, as: 'B', body: REF, ...o });
const recheck = (o: Partial<Parameters<ActionHarness['act']>[1]> = {}) => t.act('recheckPaymentRefund', { refundId: RID, as: 'B', body: {}, ...o });
const fail = (o: Partial<Parameters<ActionHarness['act']>[1]> = {}) => t.act('failManualPaymentRefund', { refundId: RID, as: 'B', body: { reason_code: 'gateway_confirmed_not_refunded' },
  headers: t.ifMatch(RID), ...o });
/** columns a seeded row never set read back as undefined, an UPDATE that clears them as null: both mean "empty" */
const empty = (row: any, ...cols: string[]): void => { for (const c of cols) expect(row[c] ?? null, c).toBeNull(); };
const nothingChanged = (before: ReturnType<ActionHarness['snap']>) => expect(t.snap(RID)).toEqual(before);
const intentTransitions = (id = t.intentId) => t.h.db.transitions(A).filter((x: any) => x.intent_id === id);
beforeEach(async () => { t = await makeActionHarness(); t.script(GW.khalti.full); });

/** the whole completion effect set (TRD §6.6 step 6), identical for P11, P7b and the task */
function expectCompleted(amount: number, intentStatus: 'refunded' | 'partially_refunded', o: { gateway?: string; refundedBefore?: number; id?: string } = {}) {
  const row = t.refundRow(o.id ?? RID), intent = t.intent();
  expect(row.status).toBe('completed'); empty(row, 'held_reason', 'failure_reason');
  expect(new Date(row.completed_at).toISOString()).toBe(FIXED_NOW);
  expect(new Date(row.last_checked_at).toISOString()).toBe(FIXED_NOW);
  expect(row.ledger_entry_id).toBe('01900000-0000-7000-8000-0000000cc000');
  expect(t.h.ledger.refunds).toHaveLength(1);                                                       // recordGatewayRefund exactly once
  expect(t.h.ledger.refunds[0]).toMatchObject({ refundId: o.id ?? RID, intentId: t.intentId, orderId: t.orderId, gateway: o.gateway ?? 'khalti', gatewayTxnRef: intent.gateway_txn_ref,
    amount: { amountPaisa: amount, currency: 'NPR' }, reasonCode: 'test_cancelled', approvedByMembershipId: M.B });
  expect(t.h.ledger.refunds[0].refundedAt).toMatch(ISO);
  expect(intent.status).toBe(intentStatus);
  expect(Number(intent.refunded_paisa)).toBe((o.refundedBefore ?? 0) + amount);
  expect(intentTransitions().at(-1)).toMatchObject({ to_status: intentStatus, cause: 'refund', actor_type: 'user' });
  expect(t.access()).toEqual([]);                                                                   // ST-24: row audit only
  expect(t.h.jobs).toEqual([]);
}

describe('AC-PG-09.4 P11 confirm a manual refund', () => {
  it('gateway shows a full refund -> completed: reference + date + confirmer stored, ledger once, intent refunded', async () => {
    seed();
    const r = await confirm();
    expect(r.code).toBeUndefined(); expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: RID, status: 'completed' });
    const row = t.refundRow(RID);
    expect(row).toMatchObject({ gateway_refund_reference: REF.gateway_refund_reference, confirmed_by_membership_id: M.B, version: 2 });
    expect(day(row.refunded_on)).toBe(REF.refunded_on);
    expect(new Date(row.confirmed_at).toISOString()).toBe(FIXED_NOW);
    expectCompleted(CAPTURED, 'refunded');
    expect(t.checks()).toHaveLength(1);                                                             // exactly one in-request gateway check
  });

  it('a partial refund (100000 of 225000, gateway "Partially Refunded") -> completed; intent partially_refunded with refunded_paisa 100000', async () => {
    seed('requested', { amountPaisa: 100000 }); t.script(GW.khalti.partial);
    expect((await confirm()).body).toMatchObject({ status: 'completed' });
    expectCompleted(100000, 'partially_refunded');
  });

  it('the refund that brings the total to the captured amount is "full": intent partially_refunded (100000) + 125000 + gateway "Refunded" -> intent refunded', async () => {
    t = await makeActionHarness({ intents: [{ status: 'partially_refunded', refundedPaisa: 100000 }] }); t.script(GW.khalti.full);
    seed('requested', { amountPaisa: 125000 });
    expect((await confirm()).body).toMatchObject({ status: 'completed' });
    expectCompleted(125000, 'refunded', { refundedBefore: 100000 });
  });

  it('eSewa: FULL_REFUND confirms a full refund, PARTIAL_REFUND a partial one', async () => {
    t = await makeActionHarness({ intents: [{ gateway: 'esewa' }] }); t.script(GW.esewa.full);
    seed('requested', { gateway: 'esewa' });
    expect((await confirm()).body).toMatchObject({ status: 'completed' });
    expectCompleted(CAPTURED, 'refunded', { gateway: 'esewa' });

    t = await makeActionHarness({ intents: [{ gateway: 'esewa' }] }); t.script(GW.esewa.partial);
    seed('requested', { gateway: 'esewa', amountPaisa: 50000 });
    expect((await confirm()).body).toMatchObject({ status: 'completed' });
    expectCompleted(50000, 'partially_refunded', { gateway: 'esewa' });
  });

  it('a replay (double click, retried request) is refused and writes the ledger only once', async () => {
    seed(); await confirm();
    const again = await confirm();
    expect(again.code).toBe('payments.refund_not_allowed'); expect(again.status).toBe(409);
    expect(t.h.ledger.refunds).toHaveLength(1); expect(Number(t.intent().refunded_paisa)).toBe(CAPTURED);
  });

  it('a ledger failure rolls the whole unit back: refund still requested, intent untouched, reference not kept', async () => {
    seed(); const before = t.snap(RID);
    const orig = t.h.ports.BillingPort.recordGatewayRefund;
    t.h.ports.BillingPort.recordGatewayRefund = async () => { throw Object.assign(new Error('boom'), { code: 'billing.ledger_reversal_invalid', statusCode: 422 }); };
    try { const r = await confirm(); expect(r.code).toBe('billing.ledger_reversal_invalid'); } finally { t.h.ports.BillingPort.recordGatewayRefund = orig; }
    nothingChanged(before);
  });
});

describe('AC-PG-09.5 gateway does not (yet) show the refund -> held_for_review', () => {
  it('requested + no refund visible -> held_for_review / refund_not_visible; reference kept; no ledger row, intent unchanged, no job', async () => {
    seed(); t.script(GW.khalti.none);
    const r = await confirm();
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: RID, status: 'held_for_review' });
    expect(t.refundRow(RID)).toMatchObject({ status: 'held_for_review', held_reason: 'refund_not_visible', gateway_refund_reference: REF.gateway_refund_reference, version: 2 });
    empty(t.refundRow(RID), 'ledger_entry_id', 'completed_at');
    expect(new Date(t.refundRow(RID).last_checked_at).toISOString()).toBe(FIXED_NOW);
    expect(t.h.ledger.refunds).toEqual([]); expect(t.intent()).toMatchObject({ status: 'settled', version: 1 }); expect(Number(t.intent().refunded_paisa)).toBe(0);
    expect(t.h.jobs).toEqual([]);
  });

  it.each([
    ['full refund expected, gateway says "Partially Refunded"', 225000, GW.khalti.partial, 'khalti'],
    ['partial refund expected, gateway says "Refunded"', 100000, GW.khalti.full, 'khalti'],
    ['eSewa: full expected, PARTIAL_REFUND', 225000, GW.esewa.partial, 'esewa'],
    ['eSewa: partial expected, FULL_REFUND', 100000, GW.esewa.full, 'esewa'],
  ] as const)('kind mismatch (%s) -> held_for_review / refund_kind_mismatch, no ledger row', async (_n, amount, raw, gateway) => {
    t = await makeActionHarness({ intents: [{ gateway }] }); t.script(raw);
    seed('requested', { gateway, amountPaisa: amount });
    expect((await confirm()).body).toMatchObject({ status: 'held_for_review' });
    expect(t.refundRow(RID).held_reason).toBe('refund_kind_mismatch'); empty(t.refundRow(RID), 'ledger_entry_id');
    expect(t.h.ledger.refunds).toEqual([]); expect(Number(t.intent().refunded_paisa)).toBe(0);
  });

  it('a transient gateway answer leaves everything unchanged: 503 payments.gateway_not_available (nothing stored, not even the reference)', async () => {
    seed(); t.script('code:0'); const before = t.snap(RID);
    const r = await confirm();
    expect(r.code).toBe('payments.gateway_not_available'); expect(r.status).toBe(503);
    nothingChanged(before); expect(t.h.ledger.refunds).toEqual([]);
  });
});

describe('P11 validation and state rules', () => {
  it.each(['pending_approval', 'approved', 'rejected', 'completed', 'failed'])('refund in %s -> 409 payments.refund_not_allowed, no gateway call, nothing written', async (status) => {
    seed(status); const before = t.snap(RID); const mark = t.h.db.stmts.length;
    const r = await confirm();
    expect(r.code).toBe('payments.refund_not_allowed'); expect(r.status).toBe(409);
    expect(t.checks()).toHaveLength(0); expect(t.writes(mark)).toEqual([]); nothingChanged(before);
  });

  it.each([
    ['reference missing', { refunded_on: '2026-11-10' }],
    ['date missing', { gateway_refund_reference: 'KH-1' }],
    ['empty reference', { gateway_refund_reference: '', refunded_on: '2026-11-10' }],
    ['reference over 100 chars', { gateway_refund_reference: 'R'.repeat(101), refunded_on: '2026-11-10' }],
    ['reference with a space', { gateway_refund_reference: 'KH 1', refunded_on: '2026-11-10' }],
    ['reference with SQL / markup characters', { gateway_refund_reference: "KH-1'; DROP TABLE payments.refunds;--", refunded_on: '2026-11-10' }],
    ['reference not a string', { gateway_refund_reference: 12345, refunded_on: '2026-11-10' }],
    ['date not ISO', { gateway_refund_reference: 'KH-1', refunded_on: '10/11/2026' }],
    ['impossible date', { gateway_refund_reference: 'KH-1', refunded_on: '2026-02-30' }],
    ['date with a time', { gateway_refund_reference: 'KH-1', refunded_on: '2026-11-10T00:00:00Z' }],
    ['unknown field', { ...REF, extra: 1 }],
    ['smuggled status', { ...REF, status: 'completed' }],
    ['smuggled amount', { ...REF, amount_paisa: 1 }],
    ['smuggled ledger entry', { ...REF, ledger_entry_id: '01900000-0000-7000-8000-0000000cc999' }],
    ['body is an array', [REF]],
    ['no body', undefined],
  ] as const)('%s -> 400 common.validation_failed, no gateway call, nothing written', async (_n, body) => {
    seed(); const before = t.snap(RID);
    const r = await confirm({ body });
    expect(r.code).toBe('common.validation_failed'); expect(r.status).toBe(400);
    expect(t.checks()).toHaveLength(0); expect(t.h.ledger.refunds).toEqual([]); nothingChanged(before);
  });
});

describe('AC-PG-09.10 P7b re-check', () => {
  it('requested + refund visible -> completed with the ledger call (same effects as P11); no reference needed', async () => {
    seed();
    const r = await recheck();
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: RID, status: 'completed' });
    expectCompleted(CAPTURED, 'refunded');
    expect(t.checks()).toHaveLength(1);
  });

  it('held_for_review + refund now visible -> completed', async () => {
    seed('held_for_review'); expect((await recheck()).body).toMatchObject({ status: 'completed' });
    expectCompleted(CAPTURED, 'refunded');
  });

  it('requested + not visible -> held_for_review / refund_not_visible and last_checked_at = now (no ledger row)', async () => {
    seed(); t.script(GW.khalti.none);
    expect((await recheck()).body).toMatchObject({ status: 'held_for_review' });
    expect(t.refundRow(RID)).toMatchObject({ held_reason: 'refund_not_visible', version: 2 }); empty(t.refundRow(RID), 'ledger_entry_id');
    expect(new Date(t.refundRow(RID).last_checked_at).toISOString()).toBe(FIXED_NOW);
    expect(t.h.ledger.refunds).toEqual([]);
  });

  it('held_for_review + still not visible -> stays held_for_review, last_checked_at advances', async () => {
    seed('held_for_review'); t.script(GW.khalti.none);
    expect((await recheck({ now: at(120) })).body).toMatchObject({ status: 'held_for_review' });
    expect(new Date(t.refundRow(RID).last_checked_at).toISOString()).toBe(at(120)); expect(t.h.ledger.refunds).toEqual([]);
  });

  it('kind mismatch -> held_for_review / refund_kind_mismatch', async () => {
    seed('requested', { amountPaisa: 100000 }); t.script(GW.khalti.full);
    expect((await recheck()).body).toMatchObject({ status: 'held_for_review' });
    expect(t.refundRow(RID).held_reason).toBe('refund_kind_mismatch');
  });

  it('within VERIFY_MIN_INTERVAL_SECONDS (10 s) of the last check -> 429 common.rate_limited + Retry-After, NO gateway call, nothing written', async () => {
    seed(); t.script(GW.khalti.none);
    expect((await recheck()).body).toMatchObject({ status: 'held_for_review' });                  // first press: checks
    const calls = t.checks().length, before = t.snap(RID), mark = t.h.db.stmts.length, min = t.h.config.verifyMinIntervalSeconds;
    expect(min).toBe(10);
    const second = await recheck({ now: at(5) });
    expect(second.code).toBe('common.rate_limited'); expect(second.status).toBe(429);
    expect(second.err.retryAfterSeconds).toBeGreaterThanOrEqual(1); expect(second.err.retryAfterSeconds).toBeLessThanOrEqual(min);
    expect(Number(hdr(second, 'retry-after'))).toBeGreaterThanOrEqual(1);
    expect(t.checks()).toHaveLength(calls); expect(t.writes(mark)).toEqual([]); nothingChanged(before);
    expect((await recheck({ now: at(9) })).code).toBe('common.rate_limited');                      // 9 s: still too soon
    expect((await recheck({ now: at(10) })).status).toBe(200);                                     // 10 s: allowed again
    expect(t.checks()).toHaveLength(calls + 1);
  });

  it('a refund never checked before (last_checked_at null) is not throttled', async () => {
    seed(); expect(t.refundRow(RID).last_checked_at ?? null).toBeNull();
    expect((await recheck()).status).toBe(200);
  });

  it('the throttle does not hold the money back: a completed check is final, the next press is refund_not_allowed (not 429)', async () => {
    seed(); await recheck();
    expect((await recheck({ now: at(1) })).code).toBe('payments.refund_not_allowed');
  });

  it('transient gateway answer -> 503 payments.gateway_not_available, unchanged (last_checked_at not advanced, so the retry is not throttled)', async () => {
    seed(); t.script('code:0'); const before = t.snap(RID);
    const r = await recheck();
    expect(r.code).toBe('payments.gateway_not_available'); expect(r.status).toBe(503);
    nothingChanged(before);
    t.script(GW.khalti.full); expect((await recheck({ now: at(1) })).status).toBe(200);
  });

  it.each(['pending_approval', 'approved', 'rejected', 'completed', 'failed'])('refund in %s -> 409 payments.refund_not_allowed, no gateway call', async (status) => {
    seed(status);
    const r = await recheck();
    expect(r.code).toBe('payments.refund_not_allowed'); expect(t.checks()).toHaveLength(0);
  });

  it('the body is ignored / must be {}: a smuggled status or amount is a 400 and changes nothing', async () => {
    seed(); const before = t.snap(RID);
    const r = await recheck({ body: { status: 'completed', amount_paisa: 1 } });
    expect(r.code).toBe('common.validation_failed'); nothingChanged(before); expect(t.checks()).toHaveLength(0);
  });
});

describe('AC-PG-09.9 P11b mark failed (only after a gateway check shows NO refund)', () => {
  it('requested + gateway shows no refund -> failed: reason, note, last_checked_at stored; no ledger row; intent untouched; ONE read-only check', async () => {
    seed(); t.script(GW.khalti.none);
    const r = await fail({ body: { reason_code: 'gateway_confirmed_not_refunded', note: 'Khalti support confirmed on call 12' } });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: RID, status: 'failed' });
    expect(t.refundRow(RID)).toMatchObject({ status: 'failed', failure_reason: 'gateway_confirmed_not_refunded', failure_note: 'Khalti support confirmed on call 12', version: 2 });
    empty(t.refundRow(RID), 'ledger_entry_id', 'completed_at');
    expect(new Date(t.refundRow(RID).last_checked_at).toISOString()).toBe(FIXED_NOW);
    expect(t.checks()).toHaveLength(1);
    expect(t.h.ledger.refunds).toEqual([]); expect(t.intent()).toMatchObject({ status: 'settled', version: 1 }); expect(Number(t.intent().refunded_paisa)).toBe(0);
    expect(t.access()).toEqual([]); expect(t.h.jobs).toEqual([]);
  });

  it('held_for_review + no refund -> failed (the in-flight slot is freed: a new refund request for the intent now succeeds)', async () => {
    seed('held_for_review'); t.script(GW.khalti.none);
    expect((await fail()).body).toMatchObject({ status: 'failed' });
    const again = await t.call('createPaymentRefundRequest', { intentId: t.intentId, body: { refund_amount_paisa: CAPTURED, reason_code: 'test_cancelled' } }, { as: 'A' });
    expect(again.code).toBeUndefined(); expect(again.value).toMatchObject({ status: 'pending_approval' });
    expect(t.refunds().filter((x: any) => x.status === 'failed')).toHaveLength(1);
  });

  it('eSewa: COMPLETE (no refund status) -> failed', async () => {
    t = await makeActionHarness({ intents: [{ gateway: 'esewa' }] }); t.script(GW.esewa.none);
    seed('requested', { gateway: 'esewa' });
    expect((await fail()).body).toMatchObject({ status: 'failed' });
  });

  it.each([
    ['khalti full', 'khalti', GW.khalti.full], ['khalti partial', 'khalti', GW.khalti.partial], ['esewa full', 'esewa', GW.esewa.full], ['esewa partial', 'esewa', GW.esewa.partial],
  ] as const)('gateway shows a refund (%s) -> 409 payments.refund_not_allowed (detail gateway_shows_refund), NOTHING written, no ledger row (finance uses Re-check)', async (_n, gateway, raw) => {
    t = await makeActionHarness({ intents: [{ gateway }] }); t.script(raw);
    seed('requested', { gateway }); const before = t.snap(RID); const mark = t.h.db.stmts.length;
    const r = await fail();
    expect(r.code).toBe('payments.refund_not_allowed'); expect(r.status).toBe(409); expect(r.err.detail).toBe('gateway_shows_refund');
    expect(t.checks()).toHaveLength(1); expect(t.writes(mark)).toEqual([]); nothingChanged(before);
    expect(t.h.ledger.refunds).toEqual([]); expect(t.h.jobs).toEqual([]);
  });

  it('the refund shown by the gateway is NOT completed by P11b, but the re-check then completes it (no double handling)', async () => {
    seed('held_for_review'); expect((await fail()).code).toBe('payments.refund_not_allowed');
    expect((await recheck()).body).toMatchObject({ status: 'completed' }); expect(t.h.ledger.refunds).toHaveLength(1);
  });

  it('transient gateway answer -> 503 payments.gateway_not_available, nothing written', async () => {
    seed(); t.script('code:0'); const before = t.snap(RID);
    const r = await fail();
    expect(r.code).toBe('payments.gateway_not_available'); expect(r.status).toBe(503); nothingChanged(before);
  });

  it.each(['pending_approval', 'approved', 'rejected', 'completed', 'failed'])('refund in %s -> 409 payments.refund_not_allowed, no gateway call', async (status) => {
    seed(status); t.script(GW.khalti.none);
    const r = await fail();
    expect(r.code).toBe('payments.refund_not_allowed'); expect(t.checks()).toHaveLength(0);
  });

  it('If-Match: missing -> 428 common.precondition_required; malformed -> 400; stale -> 409 common.version_conflict; none of them changes anything', async () => {
    seed(); t.script(GW.khalti.none); const before = t.snap(RID);
    expect((await fail({ headers: {} })).code).toBe('common.precondition_required');
    expect((await fail({ headers: { 'if-match': 'abc' } })).code).toBe('common.validation_failed');
    const stale = await fail({ headers: { 'if-match': '"7"' } });
    expect(stale.code).toBe('common.version_conflict'); expect(stale.status).toBe(409);
    nothingChanged(before);
  });

  it('a version bumped by another actor between read and write is a conflict, not a silent overwrite', async () => {
    seed(); t.script(GW.khalti.none);
    const header = t.ifMatch(RID);
    t.refundRow(RID).version = 2;                                                                  // someone else acted
    expect((await fail({ headers: header })).code).toBe('common.version_conflict');
    expect(t.refundRow(RID).status).toBe('requested');
  });

  it.each([
    ['unknown code', { reason_code: 'because' }],
    ['code of another set (refund_reasons)', { reason_code: 'test_cancelled' }],
    ['malformed code', { reason_code: 'Gateway Confirmed!' }],
    ['code missing', {}],
    ['"other" without a note (requires_text)', { reason_code: 'other' }],
    ['"other" with a blank note', { reason_code: 'other', note: '   ' }],
    ['note over 500 chars', { reason_code: 'gateway_confirmed_not_refunded', note: 'n'.repeat(501) }],
    ['note not a string', { reason_code: 'gateway_confirmed_not_refunded', note: 5 }],
    ['unknown field', { reason_code: 'gateway_confirmed_not_refunded', extra: true }],
    ['smuggled status', { reason_code: 'gateway_confirmed_not_refunded', status: 'completed' }],
    ['smuggled ledger entry', { reason_code: 'gateway_confirmed_not_refunded', ledger_entry_id: '01900000-0000-7000-8000-0000000cc999' }],
    ['no body', undefined],
  ] as const)('%s -> 400 common.validation_failed, nothing written', async (_n, body) => {
    seed(); t.script(GW.khalti.none); const before = t.snap(RID);
    const r = await fail({ body });
    expect(r.code).toBe('common.validation_failed'); expect(r.status).toBe(400); nothingChanged(before); expect(t.h.ledger.refunds).toEqual([]);
  });

  it('"other" with a note is accepted; a tenant that deactivated a code cannot use it', async () => {
    seed(); t.script(GW.khalti.none);
    expect((await fail({ body: { reason_code: 'other', note: 'provider confirmed by phone' } })).body).toMatchObject({ status: 'failed' });
    t = await makeActionHarness(); seed(); t.script(GW.khalti.none);
    t.h.db.put('payments.cs_reasons', { id: uid(8800), tenant_id: A, set_name: 'refund_fail_reasons', code: 'gateway_confirmed_not_refunded', display: 'x', is_active: false, created_by: A, updated_by: A });
    expect((await fail()).code).toBe('common.validation_failed');
  });
});

describe('security: permissions, aal, centre scope, tenant isolation (ST-10, ST-18, ST-24)', () => {
  const OPS = [
    ['confirmManualPaymentRefund', 'payments.refund.approve', 'approver_only', 'requester_only'],
    ['failManualPaymentRefund', 'payments.refund.approve', 'approver_only', 'requester_only'],
    ['recheckPaymentRefund', 'payments.intent.resolve', 'A', 'approver_only'],
  ] as const;
  const run = (op: (typeof OPS)[number][0], o: Parameters<ActionHarness['act']>[1]) => t.act(op, { ...o, ...(op === 'confirmManualPaymentRefund' ? { body: REF } : op === 'failManualPaymentRefund'
    ? { body: { reason_code: 'gateway_confirmed_not_refunded' }, headers: t.ifMatch(RID) } : { body: {} }) });

  it.each(OPS)('%s: the permission is asserted WITHOUT a centre before any payments read; a caller without it gets 403 auth.forbidden and no gateway call', async (op, _perm, _ok, bad) => {
    seed(); t.script(GW.khalti.none); const mark = t.h.db.stmts.length;
    for (const persona of [bad, 'front_desk', 'reader'] as const) {
      const r = await run(op, { refundId: RID, as: persona });
      expect(r.code, `${op} ${persona}`).toBe('auth.forbidden'); expect(r.status).toBe(403);
    }
    expect(t.refundStmts(mark)).toEqual([]); expect(t.checks()).toHaveLength(0); expect(t.refundRow(RID).status).toBe('requested');
    expect(t.idCalls.find((c) => c.at >= mark)!.centreId).toBeUndefined();
  });

  it.each(OPS)('%s: aal1 -> 403 auth.mfa_required (privileged permission), no gateway call, nothing written', async (op) => {
    seed(); const before = t.snap(RID);
    const r = await run(op, { refundId: RID, as: 'B_aal1' });
    expect(r.code).toBe('auth.mfa_required'); expect(t.checks()).toHaveLength(0); nothingChanged(before);
  });

  it.each(OPS)('%s: another centre\'s refund is "not found" (404 common.not_found, no oracle), no gateway call', async (op) => {
    seed('requested', { centre: CENTRE_2 }); const before = t.snap(RID);
    const r = await run(op, { refundId: RID, as: 'finance_centre1' });
    expect(r.code).toBe('common.not_found'); expect(r.status).toBe(404); expect(t.checks()).toHaveLength(0); nothingChanged(before);
    expect(t.idCalls.some((c) => c.centreId === CENTRE_2)).toBe(true);
    void CENTRE_1;
  });

  it.each(OPS)('%s: a refund of tenant A is "not found" for tenant B; an unknown id is the same 404; a malformed id is 400', async (op) => {
    seed(); const before = t.snap(RID);
    const foreign = await run(op, { refundId: RID, as: 'A', tenant: 'B' });
    const unknown = await run(op, { refundId: uid(999), as: 'A' });
    expect([foreign.code, foreign.status]).toEqual(['common.not_found', 404]); expect([unknown.code, unknown.status]).toEqual(['common.not_found', 404]);
    expect((await run(op, { refundId: 'not-a-uuid', as: 'A' })).code).toBe('common.validation_failed');
    expect(t.checks()).toHaveLength(0); nothingChanged(before); expect(t.h.ledger.refunds).toEqual([]);
  });

  it.each(OPS)('%s: only staff actors (08 R8): patient / portal / device actors get 403 auth.forbidden', async (op) => {
    seed(); const before = t.snap(RID);
    for (const actorType of ['patient', 'portal', 'device']) expect((await run(op, { refundId: RID, as: 'B', actorType })).code, actorType).toBe('auth.forbidden');
    expect(t.checks()).toHaveLength(0); nothingChanged(before);
  });

  it('the money cannot be moved by the caller: P11 / P7b complete only on a gateway answer, never on a body field (AB-7: the amount is the approved amount)', async () => {
    seed('requested', { amountPaisa: 100000 }); t.script(GW.khalti.partial);
    await confirm({ body: { ...REF } });
    expect(Number(t.h.ledger.refunds[0].amount.amountPaisa)).toBe(100000); expect(Number(t.intent().refunded_paisa)).toBe(100000);
  });

  it('no handler writes an access-log row or calls ctx.audit; error responses carry the code only (no row data, no secret)', async () => {
    seed(); t.script(GW.khalti.none);
    for (const r of [await recheck(), await recheck({ now: at(1) }), await fail(), await confirm()]) { expect(JSON.stringify(r.body ?? {})).not.toMatch(/secret|ciphertext|KEK|synthetic-khalti/i); }
    expect(t.access()).toEqual([]); expect(t.h.db.stmts.some((s) => /audit\./i.test(s.text))).toBe(false);
  });
});
