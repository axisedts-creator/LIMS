// PG-T09 HTTP contract: public routes P30-P34 (TRD §5.2, §6.3, §6.3a, §7.2.2-§7.2.3, §7.5) through the handlers, over the real PG-T08 port + in-memory DB fake.
// ACs: AC-PG-03.1-03.9, 04.1-04.7, 11.1-11.4, 11b.1-11b.4 (11b.5 = C0 phase stub, not C15), 14.2. Security: ST-02, ST-04, ST-06, ST-07, ST-11, ST-19 (REQ-SEC-047/049/051/052/056/059/099).
// Also: replay 10x -> one ledger call; forged signature stays unpaid; tenant-B token probes; redirect to P34 with intent_id -> 200 for every outcome (review #2);
// throttled hit -> rate_limited row; P30 writes a launch row; P-44 savepoint marker test on the callback path.
// Wiring seam: helpers/callbackHarness.ts header. Fails now: handlers/service files do not exist (PG-T01 placeholders answer 503 only).
// NOT provable here (needs the C0 payments DDL / a running API): true DB parallelism, the DEFINER against FORCE RLS (ST-21), nginx limits, the core pipeline's strict query 400.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { CANCEL, PORTAL_RETURN, RESULT_PAGE, RETURN, SYSTEM_ACTOR, hdr, makeCallbackHarness, type CallbackHarness, type Made, type Op, type Res } from '../helpers/callbackHarness';
import { PRODUCT_CODE, SECRET } from '../helpers/portHarness';
import { createHmac } from 'node:crypto';

const A = TENANTS.A, B = TENANTS.B;
const UUID7 = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;
let t: CallbackHarness;
beforeEach(async () => { t = await makeCallbackHarness(); });

const target = (r: Res): URL => new URL(hdr(r, 'location')!, 'https://api.lims.test');
const outcomeOf = (r: Res): string | null => target(r).searchParams.get('outcome');
const expectRedirect = (r: Res, base: string, outcome: string, intentId: string): void => {
  expect(r.status).toBe(303);
  const u = target(r);
  expect(`${u.origin}${u.pathname}`).toBe(base);
  expect(u.searchParams.get('intent_id')).toBe(intentId);
  expect(u.searchParams.get('outcome')).toBe(outcome);
};
const UNKNOWN_SUFFIX = '/v1/payments/result?outcome=unknown';
const settle = (m: Made, over: Record<string, string> = {}) => t.call('esewaSuccessCallback', { token: m.token, query: { data: t.esewaData(m), ...over } });
const khalti = (m: Made, q: Record<string, string> = {}) => t.call('khaltiReturnCallback', { token: m.token, query: { pidx: m.pidx!, status: 'Completed', purchase_order_id: m.intentId, ...q } });
const transitions = (m: Made) => t.h.db.transitions(TENANTS[m.tenant]).filter((x) => x.intent_id === m.intentId);
const settledEvents = () => t.h.events.ofType('payments.intent.settled.v1');
const polls = (m: Made) => t.h.jobs.filter((j) => j.task === 'payments.poll_intent' && j.payload.intent_id === m.intentId);

describe('P31 eSewa success callback (US-PG-03)', () => {
  it('AC-PG-03.1: signed COMPLETE + status check COMPLETE -> settled once, ledger once, event with esewa_status_check, 303 to returnUrl?intent_id&outcome=settled', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    const r = await settle(m);
    expectRedirect(r, RETURN, 'settled', m.intentId);
    expect(t.row(m)).toMatchObject({ status: 'settled', verification_method: 'esewa_status_check', last_gateway_status_raw: 'COMPLETE' });
    expect(Number(t.row(m).verified_amount_paisa)).toBe(225000);
    expect(t.h.ledger.calls).toHaveLength(1);
    expect(t.h.ledger.calls[0]).toMatchObject({ intentId: m.intentId, gateway: 'esewa', gatewayTxnRef: m.intentId, amount: { amountPaisa: 225000, currency: 'NPR' } });
    expect(settledEvents()).toHaveLength(1);
    expect((settledEvents()[0]!.payload as any).verification_method).toBe('esewa_status_check');
    expect(transitions(m).filter((x) => x.to_status === 'settled')).toHaveLength(1);
    expect(transitions(m).at(-1)).toMatchObject({ to_status: 'settled', cause: 'callback', actor_type: 'system' });
    expect(t.checks()).toHaveLength(1);
  });

  it('writes one payments.callbacks row: kind, gateway, signature_valid, outcome ok, actor = the resolver\'s system actor, tenant from the claims', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    await settle(m);
    expect(t.callbacks()).toHaveLength(1);
    expect(t.callbacks()[0]).toMatchObject({ tenant_id: A, intent_id: m.intentId, gateway: 'esewa', kind: 'esewa_success', signature_valid: true, outcome_code: 'ok', created_by: SYSTEM_ACTOR });
    expect(t.callbacks('B')).toHaveLength(0);
  });

  it('AC-PG-03.2 / ST-02: forged signature + status check PENDING -> not settled, signature_invalid row, no ledger call, redirect outcome=pending', async () => {
    const m = await t.make({ status: 'PENDING' });
    const forged = t.esewaData(m, { mutate: (f) => { f['signature'] = Buffer.alloc(32, 7).toString('base64'); } });
    const r = await t.call('esewaSuccessCallback', { token: m.token, query: { data: forged } });
    expectRedirect(r, RETURN, 'pending', m.intentId);
    expect(['initiated', 'pending']).toContain(t.row(m).status);
    expect(t.callbacks()[0]).toMatchObject({ kind: 'esewa_success', signature_valid: false, outcome_code: 'payments.signature_invalid' });
    expect(t.h.ledger.calls).toHaveLength(0);
    expect(settledEvents()).toHaveLength(0);
  });

  it('REQ-SEC-047 / §6.3 step 3: callback values never change state - a forged "COMPLETE" payload with a good status check of COMPLETE settles ONLY because the check says so', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    const forged = t.esewaData(m, { secret: 'not-the-merchant-secret' });
    const r = await t.call('esewaSuccessCallback', { token: m.token, query: { data: forged } });
    expect(t.callbacks()[0]).toMatchObject({ signature_valid: false, outcome_code: 'payments.signature_invalid' });
    expect(t.checks()).toHaveLength(1);                                  // the verification always asks the gateway
    expect(t.row(m).status).toBe('settled');                             // ...and its answer (not the payload) is the only thing that settles
    expect(outcomeOf(r)).toBe('settled');
  });

  it('AC-PG-03.3: a payload whose signed_field_names omits total_amount is signature-invalid even when correctly signed over what it lists', async () => {
    const m = await t.make({ status: 'PENDING' });
    const names = ['transaction_code', 'status', 'transaction_uuid', 'product_code', 'signed_field_names'];
    await t.call('esewaSuccessCallback', { token: m.token, query: { data: t.esewaData(m, { names }) } });
    expect(t.callbacks()[0]).toMatchObject({ signature_valid: false, outcome_code: 'payments.signature_invalid' });
  });

  it.each([
    ['an altered field after signing', (m: Made) => ({ mutate: (f: Record<string, string>) => { f['total_amount'] = '1.0'; } })],
    ['product_code missing from signed_field_names', () => ({ names: ['status', 'total_amount', 'transaction_uuid', 'signed_field_names'] })],
    ['reordered signed_field_names (signed in the canonical order)', () => ({ names: ['transaction_uuid', 'total_amount', 'product_code', 'status', 'signed_field_names'], signNames: ['total_amount', 'transaction_uuid', 'product_code', 'status', 'signed_field_names'] })],
    ['a truncated signature', () => ({ mutate: (f: Record<string, string>) => { f['signature'] = f['signature']!.slice(0, 20); } })],
    ['an empty signature', () => ({ mutate: (f: Record<string, string>) => { f['signature'] = ''; } })],
    ['another intent\'s transaction_uuid (correctly signed)', () => ({ uuid: '01900000-0000-7000-8000-0000000c1fff' })],
    ['a different product_code (correctly signed)', () => ({ productCode: 'OTHERSHOP' })],
    ['a missing required key (status)', () => ({ dropKeys: ['status'] })],
  ])('ST-04: %s -> signature_valid=false and the intent stays unpaid', async (_n, over: any) => {
    const m = await t.make({ status: 'PENDING' });
    await t.call('esewaSuccessCallback', { token: m.token, query: { data: t.esewaData(m, over(m)) } });
    const c = t.callbacks()[0]!;
    expect(c.signature_valid).toBe(false);
    expect(['payments.signature_invalid', 'payments.callback_mismatch']).toContain(c.outcome_code);
    expect(t.row(m).status).not.toBe('settled');
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it.each([['no data parameter', {}], ['non-Base64 garbage', { data: '%%%not-base64%%%' }], ['an oversize payload (> 4 KB)', { data: 'QUJD'.repeat(1500) }], ['Base64 of non-JSON', { data: Buffer.from('not json').toString('base64') }]])(
    'ST-04: %s -> 303 pending, signature-invalid row, no throw',
    async (_n, query) => {
      const m = await t.make({ status: 'PENDING' });
      const r = await t.call('esewaSuccessCallback', { token: m.token, query: query as Record<string, string> });
      expect(r.status).toBe(303);
      expect(outcomeOf(r)).toBe('pending');
      expect(t.callbacks()[0]).toMatchObject({ outcome_code: 'payments.signature_invalid' });
      expect(t.callbacks()[0]!.signature_valid).not.toBe(true);
    });

  it('a correctly signed payload with a status check of NOT settled + good signature records signature_valid=true, outcome ok', async () => {
    const m = await t.make({ status: 'PENDING' });
    const r = await settle(m);
    expect(t.callbacks()[0]).toMatchObject({ signature_valid: true, outcome_code: 'ok' });
    expect(outcomeOf(r)).toBe('pending');
    expect(t.row(m).status).toBe('pending');                                          // §6.3 step 4: initiated -> pending (I3)
    expect(transitions(m).at(-1)).toMatchObject({ from_status: 'initiated', to_status: 'pending', cause: 'callback' });
  });

  it('AC-PG-03.4: COMPLETE with totalAmount 22.5 (mismatch) -> held_for_review amount_mismatch, no ledger write, critical alert, redirect pending', async () => {
    const m = await t.make({ status: 'COMPLETE', gatewayAmountPaisa: 2250 });
    const r = await settle(m);
    expect(t.row(m)).toMatchObject({ status: 'held_for_review', hold_reason: 'amount_mismatch' });
    expect(t.h.ledger.calls).toHaveLength(0);
    expect(t.h.alerts.map((a) => a.event)).toContain('payment_amount_mismatch');
    expect(outcomeOf(r)).toBe('pending');
  });

  it.each(['AMBIGUOUS', 'AMBIGIOUS'])('AC-PG-03.5: status %s -> held_for_review gateway_ambiguous, redirect pending', async (status) => {
    const m = await t.make({ status });
    const r = await settle(m);
    expect(t.row(m)).toMatchObject({ status: 'held_for_review', hold_reason: 'gateway_ambiguous' });
    expect(outcomeOf(r)).toBe('pending');
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it('AC-PG-03.6: status check answers code 0 (service unavailable) -> not settled/held/failed, a poll is scheduled, redirect pending', async () => {
    const m = await t.make({ status: 'code:0' });
    const r = await settle(m);
    expect(['initiated', 'pending']).toContain(t.row(m).status);
    expect(outcomeOf(r)).toBe('pending');
    expect(polls(m).length).toBeGreaterThan(0);
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it('AC-PG-03.7 / REQ-SEC-051: the same success callback replayed 10 times -> exactly one ledger call (duplicate:false), one event, one settled transition; every replay redirects settled', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    const rs: Res[] = [];
    for (let i = 0; i < 10; i++) rs.push(await settle(m));
    for (const r of rs) expectRedirect(r, RETURN, 'settled', m.intentId);
    expect(t.h.ledger.calls).toHaveLength(1);
    expect(settledEvents()).toHaveLength(1);
    expect(transitions(m).filter((x) => x.to_status === 'settled')).toHaveLength(1);
    expect(t.checks()).toHaveLength(1);                                               // replays do not call the gateway again
    expect(t.callbacks().map((c) => c.outcome_code)).toEqual(['ok', ...Array(9).fill('payments.callback_stale')]);
  });

  it('ST-06: 10 concurrent callbacks + 5 verify polls on a paying intent -> 1 settled transition, 1 ledger call, 1 event', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    await Promise.all([...Array.from({ length: 10 }, () => settle(m)), ...Array.from({ length: 5 }, () => t.h.impl.verify(t.h.ctxFor('A:system'), { intentId: m.intentId }))]);
    expect(t.h.ledger.calls).toHaveLength(1);
    expect(settledEvents()).toHaveLength(1);
    expect(transitions(m).filter((x) => x.to_status === 'settled')).toHaveLength(1);
    expect(t.row(m).status).toBe('settled');
  });

  it('AC-PG-03.1 follow-up: unknown query keys never reach the stored row (allowlist), and a user-edited outcome= parameter changes nothing (AC-PG-11.3)', async () => {
    const m = await t.make({ status: 'PENDING' });
    const r = await settle(m, { outcome: 'settled', evil: 'x'.repeat(50), status: 'COMPLETE' });
    expect(outcomeOf(r)).toBe('pending');
    expect(t.row(m).status).not.toBe('settled');
    const q = t.queryOf(t.callbacks()[0]);
    expect(JSON.stringify(q ?? {})).not.toMatch(/evil|xxxxx/);
  });

  it('success URL hit for an intent that is already failed -> stale row, redirect to cancelUrl outcome=failed, no gateway call, no state change', async () => {
    const m = await t.make({ status: 'CANCELED' });
    await t.call('esewaFailureCallback', { token: m.token });
    const before = t.checks().length;
    const r = await settle(m);
    expectRedirect(r, CANCEL, 'failed', m.intentId);
    expect(t.callbacks().at(-1)).toMatchObject({ kind: 'esewa_success', outcome_code: 'payments.callback_stale' });
    expect(t.checks()).toHaveLength(before);
    expect(t.row(m).status).toBe('failed');
  });

  it('an existing query string on returnUrl is kept; intent_id and outcome are appended', async () => {
    const m = await t.make({ status: 'COMPLETE', returnUrl: `${RETURN}?ref=abc` });
    const r = await settle(m);
    const u = target(r);
    expect(`${u.origin}${u.pathname}`).toBe(RETURN);
    expect([u.searchParams.get('ref'), u.searchParams.get('intent_id'), u.searchParams.get('outcome')]).toEqual(['abc', m.intentId, 'settled']);
  });
});

describe('P32 eSewa failure callback', () => {
  it('AC-PG-03.8: status check CANCELED -> failed, row esewa_failure, redirect to cancelUrl?intent_id&outcome=failed', async () => {
    const m = await t.make({ status: 'CANCELED' });
    const r = await t.call('esewaFailureCallback', { token: m.token });
    expectRedirect(r, CANCEL, 'failed', m.intentId);
    expect(t.row(m)).toMatchObject({ status: 'failed', failure_reason: 'gateway_cancelled' });
    expect(t.callbacks()[0]).toMatchObject({ kind: 'esewa_failure', gateway: 'esewa', outcome_code: 'ok' });
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it('AC-PG-03.8: status check NOT_FOUND before the deadline -> the intent stays initiated, redirect outcome=pending', async () => {
    const m = await t.make({ status: 'NOT_FOUND' });
    const r = await t.call('esewaFailureCallback', { token: m.token });
    expect(t.row(m).status).toBe('initiated');
    expect(outcomeOf(r)).toBe('pending');
  });

  it('a failure callback cannot un-pay: status check COMPLETE settles (the check decides), never fails the intent', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    const r = await t.call('esewaFailureCallback', { token: m.token });
    expect(t.row(m).status).toBe('settled');
    expectRedirect(r, RETURN, 'settled', m.intentId);
  });

  it('a failure callback on an already settled intent changes nothing and redirects settled', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    await settle(m);
    const r = await t.call('esewaFailureCallback', { token: m.token });
    expectRedirect(r, RETURN, 'settled', m.intentId);
    expect(t.callbacks().at(-1)).toMatchObject({ kind: 'esewa_failure', outcome_code: 'payments.callback_stale' });
    expect(t.h.ledger.calls).toHaveLength(1);
  });
});

describe('P33 Khalti return callback (US-PG-04)', () => {
  it('AC-PG-04.1: Completed + lookup Completed -> settled with khalti_lookup and gateway_secondary_ref, 303 settled', async () => {
    const m = await t.make({ gateway: 'khalti', status: 'Completed' });
    const r = await khalti(m, { transaction_id: 'TX-1', total_amount: '225000', amount: '225000' });
    expectRedirect(r, RETURN, 'settled', m.intentId);
    expect(t.row(m)).toMatchObject({ status: 'settled', verification_method: 'khalti_lookup', gateway_secondary_ref: 'SYN-TXN-REF-1' });
    expect(t.h.ledger.calls).toHaveLength(1);
    expect(t.callbacks()[0]).toMatchObject({ gateway: 'khalti', kind: 'khalti_return', signature_valid: null, outcome_code: 'ok' });
    expect((settledEvents()[0]!.payload as any).verification_method).toBe('khalti_lookup');
  });

  it('AC-PG-04.2: callback says Completed but lookup says Pending -> held_for_review gateway_pending, no ledger, redirect pending', async () => {
    const m = await t.make({ gateway: 'khalti', status: 'Pending' });
    const r = await khalti(m);
    expect(t.row(m)).toMatchObject({ status: 'held_for_review', hold_reason: 'gateway_pending' });
    expect(outcomeOf(r)).toBe('pending');
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it.each([['User canceled', 'failed', 'failed'], ['Expired', 'expired', 'failed']])('AC-PG-04.3: lookup body status %s -> %s, redirect to cancelUrl outcome=failed', async (status, to, out) => {
    const m = await t.make({ gateway: 'khalti', status });
    const r = await khalti(m, { status: 'Completed' });
    expect(t.row(m).status).toBe(to);
    expectRedirect(r, CANCEL, out, m.intentId);
  });

  it.each(['Refunded', 'Partially Refunded'])('AC-PG-04.4: lookup %s for an unsettled intent -> held_for_review gateway_refunded_before_settle', async (status) => {
    const m = await t.make({ gateway: 'khalti', status });
    await khalti(m);
    expect(t.row(m)).toMatchObject({ status: 'held_for_review', hold_reason: 'gateway_refunded_before_settle' });
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it('AC-PG-04.5: an unlisted lookup status -> held_for_review gateway_status_unknown', async () => {
    const m = await t.make({ gateway: 'khalti', status: 'Teleported' });
    await khalti(m);
    expect(t.row(m)).toMatchObject({ status: 'held_for_review', hold_reason: 'gateway_status_unknown' });
  });

  it('AC-PG-04.6: Initiated before expires_at + grace -> stays non-terminal, redirect pending; after the deadline -> held gateway_initiated_after_expiry', async () => {
    const m = await t.make({ gateway: 'khalti', status: 'Initiated' });
    const r = await khalti(m);
    expect(['initiated', 'pending']).toContain(t.row(m).status);
    expect(outcomeOf(r)).toBe('pending');
    const late = new Date(Date.parse(FIXED_NOW) + (60 + t.h.deps.config.expiryGraceMinutes + 5) * 60_000).toISOString();
    await t.call('khaltiReturnCallback', { token: m.token, query: { pidx: m.pidx!, status: 'Completed', purchase_order_id: m.intentId }, now: late });
    expect(t.row(m)).toMatchObject({ status: 'held_for_review', hold_reason: 'gateway_initiated_after_expiry' });
  });

  it.each([['pidx', { pidx: 'FORGED-PIDX' }], ['purchase_order_id', { purchase_order_id: '01900000-0000-7000-8000-0000000c1eee' }]])(
    'AC-PG-04.7: a callback %s that differs from the stored one -> the stored one is used for the lookup, row outcome payments.callback_mismatch', async (_n, over) => {
      const m = await t.make({ gateway: 'khalti', status: 'Completed' });
      const r = await khalti(m, over as Record<string, string>);
      expect(t.callbacks()[0]).toMatchObject({ kind: 'khalti_return', outcome_code: 'payments.callback_mismatch' });
      expect(t.checks().at(-1)).toMatchObject({ gateway: 'khalti', op: 'check', intentId: m.intentId });
      expect(t.row(m).status).toBe('settled');                                          // the lookup decides, not the callback
      expect(outcomeOf(r)).toBe('settled');
    });

  it('ST-11 / REQ-SEC-056: mobile is never stored (row, tables, logs); unknown keys are dropped; allowlisted keys are kept', async () => {
    const m = await t.make({ gateway: 'khalti', status: 'Completed' });
    await khalti(m, { mobile: '9800000000', evil: 'EVIL-VALUE', tidx: 'T-IDX', purchase_order_name: 'Lab payment' });
    const q = t.queryOf(t.callbacks()[0]!) ?? {};
    expect(Object.keys(q)).not.toContain('mobile');
    expect(Object.keys(q)).not.toContain('evil');
    expect(q).toMatchObject({ pidx: m.pidx, status: 'Completed' });
    expect(t.h.db.storedText()).not.toContain('9800000000');
    expect(JSON.stringify([t.logs, t.h.alerts, t.h.db.logs])).not.toMatch(/9800000000|EVIL-VALUE/);
  });

  it('replaying the Khalti return 10 times -> one ledger call, one event, one settled transition', async () => {
    const m = await t.make({ gateway: 'khalti', status: 'Completed' });
    for (let i = 0; i < 10; i++) expectRedirect(await khalti(m), RETURN, 'settled', m.intentId);
    expect(t.h.ledger.calls).toHaveLength(1);
    expect(settledEvents()).toHaveLength(1);
    expect(transitions(m).filter((x) => x.to_status === 'settled')).toHaveLength(1);
  });
});

describe('P30 launch page (TRD §5.2, §6.3a, §7.2.3)', () => {
  const inputs = (html: string): Record<string, string> => Object.fromEntries([...html.matchAll(/<input\b[^>]*>/gi)].map((x) => x[0]).map((tag) => [
    /name="([^"]*)"/i.exec(tag)?.[1] ?? '', (/value="([^"]*)"/i.exec(tag)?.[1] ?? '').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'")]));

  it('initiated eSewa intent -> 200 text/html: one POST form to the eSewa form URL with the signed hidden fields and a visible "Continue to eSewa" button, no JavaScript', async () => {
    const m = await t.make();
    const r = await t.call('launchEsewaPayment', { token: m.token });
    expect(r.status).toBe(200);
    expect(hdr(r, 'content-type')).toMatch(/^text\/html/);
    const html = String(r.body);
    const formUrl = t.h.deps.config.esewaFormUrl;
    expect(html).toMatch(new RegExp(`<form[^>]*method="post"[^>]*action="${formUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"|<form[^>]*action="${formUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*method="post"`, 'i'));
    expect(html.match(/<form\b/gi)).toHaveLength(1);
    expect(html).toMatch(/Continue to eSewa/);
    expect(html).toMatch(/type="submit"/i);
    expect(html).not.toMatch(/<script|onload=|onsubmit=|javascript:/i);
    const f = inputs(html);
    expect(f).toMatchObject({ amount: '2250', total_amount: '2250', tax_amount: '0', product_service_charge: '0', product_delivery_charge: '0', product_code: PRODUCT_CODE,
      transaction_uuid: m.intentId, signed_field_names: 'total_amount,transaction_uuid,product_code' });
    expect(f['signature']).toBe(createHmac('sha256', SECRET.esewa).update(`total_amount=2250,transaction_uuid=${m.intentId},product_code=${PRODUCT_CODE}`).digest('base64'));
    expect(f['success_url']).toBe(`https://api.lims.test/v1/payments/callbacks/esewa/${encodeURIComponent(m.token)}/success`);
    expect(f['failure_url']).toBe(`https://api.lims.test/v1/payments/callbacks/esewa/${encodeURIComponent(m.token)}/failure`);
  });

  it('CSP is exactly default-src none + form-action <eSewa form origin> + style-src unsafe-inline; Referrer-Policy no-referrer keeps the token out of the eSewa Referer', async () => {
    const m = await t.make();
    const r = await t.call('launchEsewaPayment', { token: m.token });
    const origin = new URL(t.h.deps.config.esewaFormUrl).origin;
    expect(hdr(r, 'content-security-policy')).toBe(`default-src 'none'; form-action ${origin}; style-src 'unsafe-inline'`);
    expect(hdr(r, 'referrer-policy')).toBe('no-referrer');
  });

  it('writes exactly one launch row (kind launch, gateway esewa, no query, outcome ok), calls no gateway, changes no state', async () => {
    const m = await t.make();
    const before = { checks: t.checks().length, status: t.row(m).status, version: t.row(m).version };
    await t.call('launchEsewaPayment', { token: m.token });
    expect(t.callbacks()).toHaveLength(1);
    expect(t.callbacks()[0]).toMatchObject({ tenant_id: A, intent_id: m.intentId, kind: 'launch', gateway: 'esewa', outcome_code: 'ok', created_by: SYSTEM_ACTOR });
    expect(t.queryOf(t.callbacks()[0]!)).toBeNull();
    expect(t.checks()).toHaveLength(before.checks);
    expect(t.row(m)).toMatchObject({ status: before.status, version: before.version });
  });

  it('a pending intent still gets the page (200) and a launch row', async () => {
    const m = await t.make({ status: 'PENDING' });
    await settle(m);                                                                  // initiated -> pending
    expect(t.row(m).status).toBe('pending');
    const r = await t.call('launchEsewaPayment', { token: m.token });
    expect(r.status).toBe(200);
    expect(t.callbacks().at(-1)).toMatchObject({ kind: 'launch', outcome_code: 'ok' });
  });

  it('a settled intent -> 303 to the outcome for its state, launch row payments.callback_stale, no form', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    await settle(m);
    const r = await t.call('launchEsewaPayment', { token: m.token });
    expect(r.status).toBe(303);
    expect(outcomeOf(r)).toBe('settled');
    expect(t.callbacks().at(-1)).toMatchObject({ kind: 'launch', outcome_code: 'payments.callback_stale' });
    expect(String(r.body ?? '')).not.toMatch(/<form/i);
  });

  it('a failed intent -> 303 with outcome=failed', async () => {
    const m = await t.make({ status: 'CANCELED' });
    await t.call('esewaFailureCallback', { token: m.token });
    const r = await t.call('launchEsewaPayment', { token: m.token });
    expect(r.status).toBe(303);
    expect(outcomeOf(r)).toBe('failed');
  });

  it('a Khalti intent has no eSewa launch page: 303 by current state, never a form', async () => {
    const m = await t.make({ gateway: 'khalti' });
    const r = await t.call('launchEsewaPayment', { token: m.token });
    expect(r.status).toBe(303);
    expect(String(r.body ?? '')).not.toMatch(/<form/i);
    expect(outcomeOf(r)).toBe('pending');
  });

  it('REQ-SEC-052 / §6.3 step 2: a throttled launch hit -> rate_limited row, no page, no gateway call, 303 by stored status', async () => {
    const m = await t.make();
    t.rl.deny = true;
    const r = await t.call('launchEsewaPayment', { token: m.token });
    expect(r.status).toBe(303);
    expect(t.callbacks()).toHaveLength(1);
    expect(t.callbacks()[0]).toMatchObject({ kind: 'launch', outcome_code: 'rate_limited' });
    expect(t.checks()).toHaveLength(0);
  });
});

describe('throttling (REQ-SEC-078/079, TRD §6.3 step 2, 08 A19 D-116)', () => {
  it('every token route consumes the general tier with the per-intent key payments:cb:<intent_id>', async () => {
    const m = await t.make({ status: 'PENDING' });
    await settle(m); await t.call('esewaFailureCallback', { token: m.token }); await t.call('launchEsewaPayment', { token: m.token });
    const k = await t.make({ gateway: 'khalti' });
    await khalti(k);
    expect(t.rl.calls.filter((c) => c.key === `payments:cb:${m.intentId}`)).toHaveLength(3);
    expect(t.rl.calls.filter((c) => c.key === `payments:cb:${k.intentId}`)).toHaveLength(1);
    expect(t.rl.calls.every((c) => c.tier === 'general')).toBe(true);
  });

  it.each([
    ['esewaSuccessCallback', 'esewa_success', 'esewa'], ['esewaFailureCallback', 'esewa_failure', 'esewa'], ['khaltiReturnCallback', 'khalti_return', 'khalti'],
  ] as const)('%s throttled -> rate_limited row, NO gateway call, state untouched, 303 by the stored status (not 429)', async (op, kind, gateway) => {
    const m = await t.make({ gateway, status: gateway === 'esewa' ? 'COMPLETE' : 'Completed' });
    t.rl.deny = true;
    const query = op === 'esewaSuccessCallback' ? { data: t.esewaData(m) } : op === 'khaltiReturnCallback' ? { pidx: m.pidx!, status: 'Completed' } : {};
    const r = await t.call(op, { token: m.token, query });
    expect(r.status).toBe(303);
    expect(outcomeOf(r)).toBe('pending');
    expect(t.callbacks()).toHaveLength(1);
    expect(t.callbacks()[0]).toMatchObject({ kind, outcome_code: 'rate_limited' });
    expect(t.checks()).toHaveLength(0);
    expect(t.row(m).status).toBe('initiated');
    expect(t.h.ledger.calls).toHaveLength(0);
    expect(t.h.jobs.filter((j) => j.runAt === undefined)).toHaveLength(0);
  });

  it('a throttled hit on a settled intent redirects settled (stored status)', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    await settle(m);
    t.rl.deny = true;
    expect(outcomeOf(await settle(m))).toBe('settled');
  });
});

describe('08 A19 P-44: the callback path runs applyCheck inside ctx.db.tx (SAVEPOINT)', () => {
  const failingBilling = (marker: () => string, err: Error) => ({
    ...t.h.ports.BillingPort,
    async recordGatewayPayment(c: any) {
      await c.tx.query(`INSERT INTO payments.gateway_calls (id, tenant_id, gateway, operation, attempt, outcome, duration_ms, created_by) VALUES ($1, $2, 'esewa', 'credential_test', 1, 'answer', 0, $3)`,
        [marker(), c.tenantId, c.actor.id]);
      throw err;
    },
  });
  const MARKER = '01900000-0000-7000-8000-0000000fa001';
  const markerRows = () => t.h.db.gatewayCalls(A).filter((r) => r.operation === 'credential_test');

  it.each([['a port business error', Object.assign(new Error('boom'), { name: 'LimsError', code: 'billing.order_closed' })], ['an unexpected error', new Error('socket hang up')]])(
    'the ledger port writes a marker row, then fails with %s -> the marker is absent after commit, the browser gets 303 pending, a poll is enqueued, the callback row is kept',
    async (_n, err) => {
      const m = await t.make({ status: 'COMPLETE' });
      const before = t.h.jobs.length;
      const r = await t.call('esewaSuccessCallback', { token: m.token, query: { data: t.esewaData(m) }, ports: { BillingPort: failingBilling(() => MARKER, err) } });
      expect(r.status).toBe(303);
      expect(outcomeOf(r)).toBe('pending');
      expect(markerRows()).toHaveLength(0);                                           // rolled back to the savepoint
      expect(t.row(m).status).not.toBe('settled');
      expect(t.h.ledger.calls).toHaveLength(0);
      expect(settledEvents()).toHaveLength(0);
      expect(t.callbacks()).toHaveLength(1);                                          // written before the savepoint, committed with the request
      expect(t.callbacks()[0]).toMatchObject({ kind: 'esewa_success', outcome_code: 'ok' });
      expect(t.h.jobs.length).toBeGreaterThan(before);                                // TRD §6.3 step 5: enqueue payments.poll_intent (run now) in the OUTER transaction
      expect(polls(m).some((j) => j.runAt === undefined || j.runAt.getTime() <= Date.parse(FIXED_NOW))).toBe(true);
    });

  it('control: when the ledger call succeeds the same path settles and the row is visible (the marker test is meaningful)', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    const ok = { ...t.h.ports.BillingPort, async recordGatewayPayment(c: any, i: any) {
      await c.tx.query(`INSERT INTO payments.gateway_calls (id, tenant_id, gateway, operation, attempt, outcome, duration_ms, created_by) VALUES ($1, $2, 'esewa', 'credential_test', 1, 'answer', 0, $3)`, [MARKER, c.tenantId, c.actor.id]);
      return t.h.ports.BillingPort.recordGatewayPayment(c, i);
    } };
    await t.call('esewaSuccessCallback', { token: m.token, query: { data: t.esewaData(m) }, ports: { BillingPort: ok } });
    expect(markerRows()).toHaveLength(1);
    expect(t.row(m).status).toBe('settled');
  });

  it('the failure and Khalti paths use the same savepoint', async () => {
    const k = await t.make({ gateway: 'khalti', status: 'Completed' });
    const r = await t.call('khaltiReturnCallback', { token: k.token, query: { pidx: k.pidx!, status: 'Completed' }, ports: { BillingPort: failingBilling(() => MARKER, new Error('boom')) } });
    expect(r.status).toBe(303);
    expect(outcomeOf(r)).toBe('pending');
    expect(markerRows()).toHaveLength(0);
    expect(t.row(k).status).not.toBe('settled');
  });
});

describe('invalid tokens and tenant isolation (AC-PG-14.2, REQ-SEC-052, ST-07, AB-9)', () => {
  const ops: [Op, (token: string) => Record<string, string>][] = [
    ['launchEsewaPayment', () => ({})], ['esewaSuccessCallback', () => ({ data: 'e30=' })], ['esewaFailureCallback', () => ({})], ['khaltiReturnCallback', () => ({ pidx: 'P1', status: 'Completed' })],
  ];
  const BAD = ['x', 'A'.repeat(43), 'A'.repeat(4096), "' OR 1=1 --", '../../etc/passwd', '%00', '<script>alert(1)</script>', '０１２３', 'a b'];

  it.each(ops)('%s: every invalid token (garbage, SQL meta, oversize, unknown, no claims) gets the SAME 303 /v1/payments/result?outcome=unknown, no row written, no gateway call', async (op, q) => {
    const seen = new Set<string>();
    for (const token of BAD) {
      const r = await t.call(op, { token, query: q(token) });
      expect(r.status).toBe(303);
      expect(hdr(r, 'location')!.endsWith(UNKNOWN_SUFFIX)).toBe(true);
      seen.add(JSON.stringify({ s: r.status, h: r.headers, b: r.body ?? null }));
    }
    const anon = await t.call(op, { token: 'A'.repeat(43), query: q(''), anonymous: true });   // the pipeline resolved nothing: no tenant, no actor
    seen.add(JSON.stringify({ s: anon.status, h: anon.headers, b: anon.body ?? null }));
    expect(seen.size).toBe(1);                                                        // identical bytes for every invalid token: no existence oracle
    expect(t.callbacks()).toHaveLength(0);
    expect(t.checks()).toHaveLength(0);
    expect(t.rl.calls).toHaveLength(0);                                               // nothing to key a throttle on, nothing consumed
  });

  it.each(ops)('%s: a tenant-B token presented with tenant-A claims behaves exactly like an unknown token and has no side effect on tenant B', async (op, q) => {
    const b = await t.make({ tenant: 'B', status: 'COMPLETE' });
    const before = JSON.stringify([t.h.db.intents(B), t.h.db.transitions(B), t.h.db.callbacks(B)]);
    const invalid = await t.call(op, { token: 'Z'.repeat(43), query: q('') });
    const probe = await t.call(op, { token: b.token, query: op === 'esewaSuccessCallback' ? { data: t.esewaData(b) } : op === 'khaltiReturnCallback' ? { pidx: 'P1', status: 'Completed' } : {}, tenant: 'A' });
    expect(JSON.stringify(probe)).toBe(JSON.stringify(invalid));
    expect(JSON.stringify([t.h.db.intents(B), t.h.db.transitions(B), t.h.db.callbacks(B)])).toBe(before);
    expect(t.h.ledger.calls).toHaveLength(0);
    expect(t.callbacks('A')).toHaveLength(0);
  });

  it('AC-PG-14.2: a tenant-B token under tenant-B claims resolves only tenant B; tenant A gets no row, no event, no ledger call', async () => {
    const a = await t.make({ tenant: 'A', status: 'COMPLETE' });
    const b = await t.make({ tenant: 'B', status: 'COMPLETE' });
    const r = await t.call('esewaSuccessCallback', { token: b.token, query: { data: t.esewaData(b) }, tenant: 'B' });
    expectRedirect(r, RETURN, 'settled', b.intentId);
    expect(t.callbacks('B')).toHaveLength(1);
    expect(t.callbacks('B')[0]).toMatchObject({ tenant_id: B, intent_id: b.intentId });
    expect(t.callbacks('A')).toHaveLength(0);
    expect(t.row(a).status).toBe('initiated');
    expect(t.row(b)).toMatchObject({ status: 'settled' });
    expect(t.h.ledger.calls.every((c) => c.intentId === b.intentId)).toBe(true);
    expect(JSON.stringify(settledEvents())).not.toContain(a.intentId);
  });

  it('the response never echoes the token, the intent id (unknown path) or any input', async () => {
    const r = await t.call('esewaSuccessCallback', { token: 'TOKEN-ECHO-CHECK-1234567890abcdefghijklmnop', query: { data: 'ZWNobw==' } });
    expect(JSON.stringify(r)).not.toMatch(/TOKEN-ECHO|ZWNobw/);
  });
});

describe('P34 result page (TRD §7.5, ST-19, AC-PG-03.9)', () => {
  const MSG: Record<string, string> = {
    settled: 'Payment received. You can close this page.',
    pending: 'We are confirming your payment with the payment provider. You can close this page; the lab will see the result.',
    failed: 'The payment was not completed. No money was taken by this attempt. Please ask the lab for another way to pay.',
    unknown: 'We could not find this payment. Please contact the lab.',
  };
  const page = (query: Record<string, string>) => t.call('getPaymentResultPage', { query, noTx: true });         // "no data, no DB": no tx on the ctx at all

  it.each(Object.keys(MSG))('outcome=%s -> 200 text/html with the fixed English message, the strict CSP and the three security headers', async (outcome) => {
    const r = await page({ outcome });
    expect(r.status).toBe(200);
    expect(hdr(r, 'content-type')).toMatch(/^text\/html/);
    expect(String(r.body)).toContain(MSG[outcome]);
    expect(hdr(r, 'content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(hdr(r, 'cache-control')).toBe('no-store');
    expect(hdr(r, 'referrer-policy')).toBe('no-referrer');
    expect(hdr(r, 'x-content-type-options')).toBe('nosniff');
    expect(String(r.body)).not.toMatch(/<script|<form|<a\s|<img|onerror|javascript:/i);
  });

  it('AC-PG-03.9: intent_id is accepted and ignored: 200, byte-identical body, and the id is never echoed', async () => {
    const id = '01900000-0000-7000-8000-0000000c7777';
    for (const outcome of Object.keys(MSG)) {
      const plain = await page({ outcome });
      const withId = await page({ outcome, intent_id: id });
      expect(withId.status).toBe(200);
      expect(withId.body).toBe(plain.body);
      expect(JSON.stringify(withId)).not.toContain(id);
    }
  });

  it('shows no amounts, names or ids (static pages)', async () => {
    for (const outcome of Object.keys(MSG)) expect(String((await page({ outcome })).body)).not.toMatch(UUID7);
  });

  it.each(['settled"><script>alert(1)</script>', '<b>', '', 'SETTLED', "settled' onload='x"])('a hostile / unknown outcome %j is never reflected and never yields a 5xx', async (outcome) => {
    const r = await page({ outcome });
    expect(r.status).toBeLessThan(500);
    if (outcome) expect(String(r.body ?? '')).not.toContain(outcome);
    expect(String(r.body ?? '')).not.toMatch(/<script|onload=/i);
  });

  it('REQ-SEC-059 / AC-PG-11.3: hitting the result page with outcome=settled changes nothing server-side (no DB, no tx)', async () => {
    const m = await t.make();
    const stmts = t.h.db.stmts.length;
    await page({ outcome: 'settled', intent_id: m.intentId });
    expect(t.h.db.stmts).toHaveLength(stmts);
    expect(t.row(m).status).toBe('initiated');
  });

  it('review #2: the §6.3 step 6 redirect lands on P34 (returnUrl = cancelUrl = C15\'s result page) with intent_id and answers 200 for every outcome', async () => {
    const follow = async (r: Res, outcome: string, intentId?: string) => {
      const u = target(r);
      expect(`${u.origin}${u.pathname}`).toBe(RESULT_PAGE);
      expect(u.searchParams.get('outcome')).toBe(outcome);
      if (intentId) expect(u.searchParams.get('intent_id')).toBe(intentId);
      const q = Object.fromEntries(u.searchParams.entries());
      const res = await page(q);
      expect(res.status).toBe(200);
      expect(String(res.body)).toContain(MSG[outcome]);
      expect(String(res.body)).not.toContain(u.searchParams.get('intent_id') ?? '\u0000');
    };
    const own = { returnUrl: RESULT_PAGE, cancelUrl: RESULT_PAGE };
    const paid = await t.make({ status: 'COMPLETE', ...own });
    await follow(await settle(paid), 'settled', paid.intentId);
    const waiting = await t.make({ status: 'PENDING', ...own });
    await follow(await settle(waiting), 'pending', waiting.intentId);
    const cancelled = await t.make({ status: 'CANCELED', ...own });
    await follow(await t.call('esewaFailureCallback', { token: cancelled.token }), 'failed', cancelled.intentId);
    const kh = await t.make({ gateway: 'khalti', status: 'Expired', ...own });
    await follow(await khalti(kh), 'failed', kh.intentId);
    await follow(await t.call('esewaSuccessCallback', { token: 'nope', query: { data: 'e30=' } }), 'unknown');
  });
});

describe('headers on every public response (REQ-SEC-099, ST-19)', () => {
  const responses = async (): Promise<[string, Res][]> => {
    const m = await t.make({ status: 'COMPLETE' });
    const k = await t.make({ gateway: 'khalti', status: 'Completed' });
    const c = await t.make({ status: 'CANCELED' });
    return [
      ['P30 200 page', await t.call('launchEsewaPayment', { token: (await t.make()).token })],
      ['P30 303', await t.call('launchEsewaPayment', { token: 'bad' })],
      ['P31 303', await settle(m)],
      ['P31 303 invalid token', await t.call('esewaSuccessCallback', { token: 'bad', query: {} })],
      ['P32 303', await t.call('esewaFailureCallback', { token: c.token })],
      ['P33 303', await khalti(k)],
      ['P34 200', await t.call('getPaymentResultPage', { query: { outcome: 'pending' }, noTx: true })],
    ];
  };

  it('Cache-Control no-store, Referrer-Policy no-referrer and X-Content-Type-Options nosniff on every 200 and 303', async () => {
    for (const [name, r] of await responses()) {
      expect([name, hdr(r, 'cache-control')]).toEqual([name, 'no-store']);
      expect([name, hdr(r, 'referrer-policy')]).toEqual([name, 'no-referrer']);
      expect([name, hdr(r, 'x-content-type-options')]).toEqual([name, 'nosniff']);
    }
  });

  it('redirects carry a Location and no body; no response sets a cookie or CORS header', async () => {
    for (const [name, r] of await responses()) {
      expect([name, ['200', '303'].includes(String(r.status))]).toEqual([name, true]);
      if (r.status === 303) { expect(hdr(r, 'location')).toBeTruthy(); expect(r.body === undefined || r.body === '').toBe(true); }
      expect([name, hdr(r, 'set-cookie')]).toEqual([name, undefined]);
      expect([name, hdr(r, 'access-control-allow-origin')]).toEqual([name, undefined]);
    }
  });

  it('SEC §logging: the token, the Base64 payload, the signature and the return URLs never reach the log', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    const data = t.esewaData(m);
    await t.call('esewaSuccessCallback', { token: m.token, query: { data } });
    const signature = JSON.parse(Buffer.from(data, 'base64').toString('utf8')).signature as string;
    const logged = JSON.stringify([t.logs, t.h.alerts, t.h.db.logs]);
    for (const secret of [m.token, data, signature, RETURN, CANCEL]) expect(logged).not.toContain(secret);
  });
});

describe('consumer smoke for US-PG-11 / 11b (full consumer contract = PG-T24)', () => {
  it('AC-PG-11.1: the C16 engagement worker (system) creates an intent with returnUrl <portal>/app/payments/<id>/done; the allowlist accepts it and the action is returned', async () => {
    const m = await t.make({ returnUrl: 'https://portal.lims.test/app/payments/01900000-0000-7000-8000-0000000c9902/done', cancelUrl: 'https://portal.lims.test/app/payments/01900000-0000-7000-8000-0000000c9902/done' });
    expect(m.action.kind).toBe('form_post');
    expect(t.row(m).return_url).toBe('https://portal.lims.test/app/payments/01900000-0000-7000-8000-0000000c9902/done');
  });

  it('AC-PG-11.2 / 11b.1 / 11b.2: C6 portal returnUrl <PORTAL>/r/payments/<id>/done; after the callback verifies it the browser is redirected 303 there with intent_id and outcome', async () => {
    const m = await t.make({ status: 'COMPLETE', returnUrl: PORTAL_RETURN, cancelUrl: PORTAL_RETURN });
    expect(Number(t.row(m).amount_paisa)).toBe(m.dueAmountPaisa);                      // amount = C15's own getOrderBalance read, no amount input
    expectRedirect(await settle(m), PORTAL_RETURN, 'settled', m.intentId);
    expect(t.h.ledger.calls).toHaveLength(1);                                          // settled inside the callback, not waiting for the C4 consumer (08 A19 D-115)
  });

  it.each(['A:portal', 'A:patient'])('AC-PG-11.4 / 11b.4: a %s actor is refused auth.forbidden on every port method', async (actor) => {
    const m = await t.make();
    const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: any) => e?.code);
    const ctx = t.h.ctxFor(actor);
    expect(await code(t.h.impl.createIntent(ctx, { orderId: m.orderId, gateway: 'esewa', idempotencyKey: 'zz', returnUrl: RETURN, cancelUrl: CANCEL }))).toBe('auth.forbidden');
    expect(await code(t.h.impl.getIntent(ctx, { intentId: m.intentId }))).toBe('auth.forbidden');
    expect(await code(t.h.impl.verify(ctx, { intentId: m.intentId }))).toBe('auth.forbidden');
    expect(await code(t.h.impl.cancelIntent(ctx, { intentId: m.intentId, reasonCode: 'x' }))).toBe('auth.forbidden');
  });

  it('AC-PG-11b.3: getIntent returns the stored status without a gateway call (the portal shows Paid only from server state)', async () => {
    const m = await t.make({ status: 'COMPLETE' });
    const r = await t.h.impl.getIntent(t.h.ctxFor('A:system'), { intentId: m.intentId });
    expect(r.status).toBe('initiated');
    expect(t.checks()).toHaveLength(0);
  });
});
