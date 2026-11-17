// PG-T07 — Khalti adapter vs the PG-T05 loopback simulator (TRD §7.1, §7.3; PRD US-PG-02, US-PG-04; REQ-SEC-047/048/056; ST-02/ST-11).
// Assumed seam (tester; writer may dispute via notes) — gateways/khalti.adapter.ts exports:
//   createKhaltiAdapter({ baseUrl, publicBaseUrl, timeouts: {initiateMs,inrequestMs,jobMs} }) -> adapter with gateway === 'khalti'
//   initiate(i, secret: SecretHandle, c?) -> { gatewayTxnRef: pidx, action: {kind:'redirect', url}, expiresAt: ISO-UTC string, paymentUrl }
//     i = { intentId, amountPaisa, callbackToken, websiteUrl, purchaseOrderName }  (extra props on i must never reach the wire)
//     any failure (timeout, network, 5xx, error_key, no/oversize pidx, non-https payment_url) -> LimsError 'payments.gateway_not_available'
//     amount < 1000 paisa -> LimsError 'payments.amount_not_supported' with NO network call (defence in depth; service checks first)
//   buildAction(i: { paymentUrl }, secret) -> { kind:'redirect', url: paymentUrl }  (no network)
//   check(i: { intentId, gatewayTxnRef (stored pidx), amountPaisa }, secret, c?: { timeoutClass?: 'inrequest'|'job', sink?, log? })
//     -> { kind:'answer', statusRaw, amountPaisa?, secondaryRef?, refundedFlag? } | {kind:'transient', reason} | {kind:'auth_error'} | {kind:'not_found'}
//     body `status` is the signal whatever the HTTP code; total_amount accepted only as a safe JSON integer; callback data is never an input.
// c.sink / c.log are forwarded to callGateway (operations khalti_initiate / khalti_lookup). Every value is synthetic.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../../core/errors.js';
import { mapKhaltiStatus } from '../../../domain/mapping.khalti.js';
import type { IntentStatus } from '../../../domain/intent.state.js';
import { createKhaltiAdapter } from '../../../gateways/khalti.adapter.js';
import { SecretHandle } from '../../../service/credentials.js';
import { khaltiReplies as R, startKhaltiSim, type KhaltiSim } from '../../sim/khalti.sim.js';

const KEY = 'PLANTED-khalti-key-9Zx4';
const PUBLIC = 'https://lims.example.test';
const T = { initiateMs: 150, inrequestMs: 300, jobMs: 600 };
const TOKEN = 'tok_' + 'a'.repeat(43);
const secret = (k = KEY): SecretHandle => new SecretHandle(k);

let sim: KhaltiSim;
let adapter: ReturnType<typeof createKhaltiAdapter>;
beforeAll(async () => {
  sim = await startKhaltiSim({ apiKey: KEY });
  adapter = createKhaltiAdapter({ baseUrl: sim.baseUrl, publicBaseUrl: PUBLIC, timeouts: T });
});
afterAll(async () => { await sim.close(); });
beforeEach(() => sim.reset());

const intent = (o: Record<string, unknown> = {}) => ({
  intentId: '11111111-1111-4111-8111-111111111111', amountPaisa: 225000, callbackToken: TOKEN,
  websiteUrl: 'https://lab.example.test', purchaseOrderName: 'Lab invoice', ...o,
});
const stored = (o: Record<string, unknown> = {}) => ({
  intentId: '11111111-1111-4111-8111-111111111111', gatewayTxnRef: 'pidx-stored-1', amountPaisa: 225000,
  paymentUrl: 'https://test-pay.khalti.com/?pidx=pidx-stored-1', ...o,
});
const rejection = async (p: Promise<unknown>): Promise<unknown> => { try { await p; } catch (e) { return e; } return undefined; };
const expectCode = (e: unknown, code: string): void => { expect(e).toBeInstanceOf(LimsError); expect((e as LimsError).code).toBe(code); };
const sinkRows = (): { rows: Record<string, unknown>[]; logs: Record<string, unknown>[]; c: Record<string, unknown> } => {
  const rows: Record<string, unknown>[] = [], logs: Record<string, unknown>[] = [];
  return { rows, logs, c: { sink: (r: Record<string, unknown>) => { rows.push(r); }, log: (f: Record<string, unknown>) => { logs.push(f); } } };
};

describe('khalti adapter — initiate (US-PG-02)', () => {
  it('AC1: POSTs initiate/ with `Authorization: Key <secret>` and the documented 5-field body; returns redirect action + pidx + expiresAt', async () => {
    sim.initiate.script(R.initiateOk({ pidx: 'P-ok-1' }));
    const out = await adapter.initiate(intent(), secret());
    expect(sim.requests).toHaveLength(1);
    const r = sim.requests[0]!;
    expect(r).toMatchObject({ method: 'POST', path: '/api/v2/epayment/initiate/', authorization: `Key ${KEY}` });
    expect(r.body).toEqual({
      return_url: `${PUBLIC}/v1/payments/callbacks/khalti/${TOKEN}`,
      website_url: 'https://lab.example.test',
      amount: 225000,
      purchase_order_id: '11111111-1111-4111-8111-111111111111',
      purchase_order_name: 'Lab invoice',
    });
    expect(typeof (r.body as { amount: unknown }).amount).toBe('number');
    expect(out.gatewayTxnRef).toBe('P-ok-1');
    expect(out.action).toEqual({ kind: 'redirect', url: 'https://test-pay.khalti.com/?pidx=P-ok-1' });
    expect(out.paymentUrl).toBe('https://test-pay.khalti.com/?pidx=P-ok-1');
    expect(out.expiresAt).toBe('2029-12-31T18:15:00.000Z'); // 2030-01-01T00:00+05:45 normalised to UTC
  });

  it('AC1: expires_at absent -> now + expires_in; both absent -> now + 60 min (TRD §6.1 step 10)', async () => {
    sim.initiate.script({ status: 200, body: { pidx: 'P2', payment_url: 'https://test-pay.khalti.com/?pidx=P2', expires_in: 1800 } });
    let t0 = Date.now();
    let out = await adapter.initiate(intent(), secret());
    let dt = Date.parse(out.expiresAt) - t0;
    expect(dt).toBeGreaterThan(1800_000 - 5_000); expect(dt).toBeLessThan(1800_000 + 5_000);
    sim.initiate.script({ status: 200, body: { pidx: 'P3', payment_url: 'https://test-pay.khalti.com/?pidx=P3' } });
    t0 = Date.now();
    out = await adapter.initiate(intent(), secret());
    dt = Date.parse(out.expiresAt) - t0;
    expect(dt).toBeGreaterThan(3600_000 - 5_000); expect(dt).toBeLessThan(3600_000 + 5_000);
  });

  it('AC2: < 1000 paisa -> payments.amount_not_supported and NO call to Khalti; 1000 is accepted', async () => {
    for (const amountPaisa of [900, 999, 0, -1, 1000.5, Number.NaN]) {
      expectCode(await rejection(adapter.initiate(intent({ amountPaisa }), secret())), 'payments.amount_not_supported');
    }
    expect(sim.requests).toHaveLength(0);
    sim.initiate.script(R.initiateOk({ pidx: 'P-min' }));
    await expect(adapter.initiate(intent({ amountPaisa: 1000 }), secret())).resolves.toMatchObject({ gatewayTxnRef: 'P-min' });
    expect((sim.requests[0]!.body as { amount: number }).amount).toBe(1000);
  });

  it('AC3: validation error (HTTP 400 + error_key) -> payments.gateway_not_available; message/field text is not echoed', async () => {
    sim.initiate.script(R.initiateValidationError({ return_url: ['PLANTED-field-message'], amount: ['Amount should be greater than Rs. 10'] }));
    const e = await rejection(adapter.initiate(intent(), secret()));
    expectCode(e, 'payments.gateway_not_available');
    expect(JSON.stringify([(e as LimsError).message, (e as LimsError).detail ?? ''])).not.toContain('PLANTED-field-message');
  });

  it.each([
    ['5xx', R.serverError(503)],
    ['malformed body', R.malformed()],
    ['connection dropped', R.drop()],
    ['invalid token', R.invalidToken()],
    ['200 without pidx', { status: 200, body: { payment_url: 'https://test-pay.khalti.com/?pidx=x' } }],
    ['200 without payment_url', { status: 200, body: { pidx: 'P-nourl' } }],
    ['payment_url with http: scheme', { status: 200, body: { pidx: 'P-http', payment_url: 'http://test-pay.khalti.com/?pidx=P-http' } }],
    ['payment_url with javascript: scheme', { status: 200, body: { pidx: 'P-js', payment_url: 'javascript:alert(1)' } }],
    ['pidx longer than 64 chars', { status: 200, body: { pidx: 'p'.repeat(65), payment_url: 'https://test-pay.khalti.com/?pidx=x' } }],
    ['error_key present alongside pidx', { status: 200, body: { pidx: 'P-err', payment_url: 'https://test-pay.khalti.com/?pidx=x', error_key: 'validation_error' } }],
  ])('AC3: %s -> payments.gateway_not_available', async (_n, reply) => {
    sim.initiate.script(reply);
    expectCode(await rejection(adapter.initiate(intent(), secret())), 'payments.gateway_not_available');
  });

  it('AC3: timeout is bounded by the initiate class (150 ms here), not the job class', async () => {
    sim.initiate.script(R.hang());
    const t0 = performance.now();
    expectCode(await rejection(adapter.initiate(intent(), secret())), 'payments.gateway_not_available');
    expect(performance.now() - t0).toBeLessThan(T.jobMs);
  });

  it('AC4: body carries no PII even when the caller object does; no customer_info / amount_breakdown / product_details / merchant_*', async () => {
    sim.initiate.script(R.initiateOk({ pidx: 'P-pii' }));
    const pii = {
      customer_info: { name: 'Synthetic Person', phone: '9800000000', email: 'syn@example.test' },
      patientName: 'Synthetic Person', phone: '9800000000', email: 'syn@example.test', testNames: ['CBC', 'Lipid panel'], panel: 'Thyroid',
      amount_breakdown: [{ label: 'x', amount: 1 }], product_details: [{ identity: 'x' }], merchant_name: 'm',
    };
    await adapter.initiate(intent(pii), secret());
    const body = sim.requests[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['amount', 'purchase_order_id', 'purchase_order_name', 'return_url', 'website_url']);
    const wire = JSON.stringify(body);
    for (const needle of ['Synthetic Person', '9800000000', 'syn@example.test', 'CBC', 'Lipid', 'Thyroid', 'customer_info', 'merchant_']) expect(wire).not.toContain(needle);
  });

  it('REQ-SEC-056: sink row / log fields for initiate never contain the key, the payment_url or request data', async () => {
    sim.initiate.script(R.initiateOk({ pidx: 'P-log' }));
    const s = sinkRows();
    await adapter.initiate(intent(), secret(), s.c);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ gateway: 'khalti', operation: 'khalti_initiate', outcome: 'answer' });
    const all = JSON.stringify([s.rows, s.logs]);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('payment_url');
    expect(all).not.toContain('test-pay.khalti.com');
    expect(all).not.toContain(TOKEN);
  });

  it('the secret never appears in a thrown error', async () => {
    sim.initiate.script(R.serverError());
    const e = (await rejection(adapter.initiate(intent(), secret()))) as Error;
    expect(JSON.stringify([e.message, (e as LimsError).detail ?? '', String(e.stack ?? '')])).not.toContain(KEY);
  });

  it('buildAction replays the stored redirect without network', () => {
    const before = sim.requests.length;
    expect(adapter.buildAction(stored(), secret())).toEqual({ kind: 'redirect', url: stored().paymentUrl });
    expect(sim.requests).toHaveLength(before);
  });
});

describe('khalti adapter — check (US-PG-04): body status is the signal, HTTP code is not', () => {
  const P = { pidx: 'pidx-stored-1' };
  const decide = (c: { statusRaw: string; amountPaisa?: number }, intentStatus: IntentStatus = 'initiated', beforeDeadline = true) =>
    mapKhaltiStatus({ statusRaw: c.statusRaw, amountMatches: c.amountPaisa === 225000, beforeDeadline, intentStatus });

  it('AC1: Completed + 225000 -> answer with amount + transaction_id as secondaryRef; maps to settle; request is POST lookup/ {pidx: stored} with Key header', async () => {
    sim.lookup.script(R.completed({ ...P, totalAmount: 225000, transactionId: 'TXN-1' }));
    const c = await adapter.check(stored(), secret());
    expect(c).toMatchObject({ kind: 'answer', statusRaw: 'Completed', amountPaisa: 225000, secondaryRef: 'TXN-1' });
    expect(sim.requests).toHaveLength(1);
    expect(sim.requests[0]).toMatchObject({ method: 'POST', path: '/api/v2/epayment/lookup/', authorization: `Key ${KEY}`, body: { pidx: 'pidx-stored-1' } });
    expect(Object.keys(sim.requests[0]!.body as object)).toEqual(['pidx']);
    expect(decide(c as { statusRaw: string; amountPaisa: number })).toEqual({ kind: 'settle' });
  });

  it('AC2: callback says Completed, lookup says Pending -> state decided by lookup only: hold(gateway_pending)', async () => {
    sim.lookup.script(R.pending(P));
    const c = await adapter.check(stored({ callbackStatus: 'Completed', callbackQuery: '?pidx=P&status=Completed' }), secret());
    expect(c).toMatchObject({ kind: 'answer', statusRaw: 'Pending' });
    expect(decide(c as { statusRaw: string })).toEqual({ kind: 'hold', reason: 'gateway_pending' });
  });

  it.each([
    ['User canceled', R.userCanceled(P), { kind: 'fail', reason: 'gateway_cancelled' }],
    ['Expired', R.expired(P), { kind: 'expire' }],
    ['Canceled', R.canceled(P), { kind: 'fail', reason: 'gateway_cancelled' }],
    ['Failed', R.failed(P), { kind: 'fail', reason: 'gateway_cancelled' }],
  ])('AC3: HTTP 400 with body status %s is an answer; HTTP code not used', async (status, reply, outcome) => {
    sim.lookup.script(reply);
    expect(reply.status).toBe(400);
    const c = await adapter.check(stored(), secret());
    expect(c).toMatchObject({ kind: 'answer', statusRaw: status });
    expect(decide(c as { statusRaw: string })).toEqual(outcome);
  });

  it('AC3: the same status string gives the same answer under HTTP 200 and HTTP 400', async () => {
    sim.lookup.script({ status: 200, body: { pidx: 'pidx-stored-1', status: 'Expired', total_amount: 225000, transaction_id: null } });
    const a = await adapter.check(stored(), secret());
    sim.lookup.script({ status: 400, body: { pidx: 'pidx-stored-1', status: 'Expired', total_amount: 225000, transaction_id: null } });
    const b = await adapter.check(stored(), secret());
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'answer', statusRaw: 'Expired' });
  });

  it.each([['Refunded', R.refunded(P)], ['Partially Refunded', R.partiallyRefunded(P)]])(
    'AC4: %s on an unsettled intent -> hold(gateway_refunded_before_settle)', async (status, reply) => {
      sim.lookup.script(reply);
      const c = await adapter.check(stored(), secret());
      expect(c).toMatchObject({ kind: 'answer', statusRaw: status });
      expect(decide(c as { statusRaw: string })).toEqual({ kind: 'hold', reason: 'gateway_refunded_before_settle' });
    });

  it('AC4: `refunded` flag is surfaced as refundedFlag (kept for refund checks, TRD §7.3.3)', async () => {
    sim.lookup.script(R.refunded(P));
    expect(await adapter.check(stored(), secret())).toMatchObject({ refundedFlag: true });
    sim.lookup.script(R.completed({ ...P, totalAmount: 225000, transactionId: 'T' }));
    const c = await adapter.check(stored(), secret());
    expect((c as { refundedFlag?: boolean }).refundedFlag ?? false).toBe(false);
  });

  it.each(['Weird', 'COMPLETED', 'completed', '', 'constructor', '__proto__', 'x'.repeat(5000)])(
    'AC5: unlisted status %j is passed through as an answer and maps to hold(gateway_status_unknown)', async (s) => {
      sim.lookup.script(R.unknownStatus(s, P));
      const c = await adapter.check(stored(), secret());
      expect(c.kind).toBe('answer');
      expect(decide({ statusRaw: (c as { statusRaw: string }).statusRaw })).toEqual({ kind: 'hold', reason: 'gateway_status_unknown' });
    });

  it('AC6: Initiated -> stay before expires_at + grace, hold(gateway_initiated_after_expiry) after (CR-C15-001)', async () => {
    sim.lookup.script(R.initiated(P));
    const c = (await adapter.check(stored(), secret())) as { statusRaw: string };
    expect(c.statusRaw).toBe('Initiated');
    expect(decide(c, 'initiated', true)).toEqual({ kind: 'stay' });
    expect(decide(c, 'initiated', false)).toEqual({ kind: 'hold', reason: 'gateway_initiated_after_expiry' });
  });

  it('AC7: lookup always uses the STORED pidx; a callback-supplied pidx (any property) is ignored', async () => {
    sim.lookup.script(R.completed({ ...P, totalAmount: 225000, transactionId: 'T' }));
    await adapter.check(stored({ callbackPidx: 'EVIL-pidx', pidx: 'EVIL-pidx-2', callback: { pidx: 'EVIL-pidx-3' } }), secret());
    expect(sim.requests.map((r) => (r.body as { pidx: string }).pidx)).toEqual(['pidx-stored-1']);
  });

  it('REQ-SEC-048: total_amount that is not a safe JSON integer is never trusted (amountPaisa undefined -> amount_mismatch hold)', async () => {
    const bad: unknown[] = ['225000', 2250.5, 9007199254740993, 1e21, null, '', true, [225000], { v: 225000 }, -225000];
    for (const total_amount of bad) {
      sim.lookup.script({ status: 200, body: { pidx: 'pidx-stored-1', status: 'Completed', total_amount, transaction_id: 'T' } });
      const c = (await adapter.check(stored(), secret())) as { kind: string; statusRaw: string; amountPaisa?: number };
      expect(c.kind, JSON.stringify(total_amount)).toBe('answer');
      expect(c.amountPaisa, JSON.stringify(total_amount)).toBeUndefined();
      expect(decide(c)).toEqual({ kind: 'hold', reason: 'amount_mismatch' });
    }
  });

  it('REQ-SEC-048: Completed with a different integer amount -> amountPaisa reported as-is -> amount_mismatch hold, not settle', async () => {
    sim.lookup.script(R.completed({ ...P, totalAmount: 22500, transactionId: 'T' }));
    const c = (await adapter.check(stored(), secret())) as { amountPaisa?: number; statusRaw: string };
    expect(c.amountPaisa).toBe(22500);
    expect(decide(c)).toEqual({ kind: 'hold', reason: 'amount_mismatch' });
  });

  it('transaction_id: non-string / empty -> secondaryRef undefined', async () => {
    for (const transaction_id of [null, '', 12345, {}]) {
      sim.lookup.script({ status: 200, body: { pidx: 'pidx-stored-1', status: 'Completed', total_amount: 225000, transaction_id } });
      const c = (await adapter.check(stored(), secret())) as { secondaryRef?: string };
      expect(c.secondaryRef, JSON.stringify(transaction_id)).toBeUndefined();
    }
  });

  it('no-status bodies: 401 "Invalid token." -> auth_error; wrong key at the server too', async () => {
    sim.lookup.script(R.completed({ ...P, totalAmount: 225000, transactionId: 'T' }));
    expect(await adapter.check(stored(), secret('WRONG-key-0000'))).toEqual({ kind: 'auth_error' });
    sim.reset();
    sim.lookup.script(R.invalidToken());
    expect(await adapter.check(stored(), secret())).toEqual({ kind: 'auth_error' });
  });

  it('no-status bodies: 404 "Not found." -> not_found', async () => {
    sim.lookup.script(R.notFound());
    expect(await adapter.check(stored(), secret())).toEqual({ kind: 'not_found' });
  });

  it.each([
    ['5xx', R.serverError(500)],
    ['502', R.serverError(502)],
    ['malformed body', R.malformed()],
    ['connection dropped', R.drop()],
    ['200 without status', { status: 200, body: { pidx: 'pidx-stored-1', total_amount: 225000 } }],
    ['200 empty object', { status: 200, body: {} }],
    ['200 array', { status: 200, body: [] }],
    ['status is not a string', { status: 200, body: { status: 1 } }],
  ])('%s -> transient (never a state change)', async (_n, reply) => {
    sim.lookup.script(reply);
    const c = await adapter.check(stored(), secret());
    expect(c.kind).toBe('transient');
    expect((c as { reason?: unknown }).reason).toEqual(expect.any(String));
  });

  it('timeout -> transient, bounded by the chosen class (inrequest 300 ms / job 600 ms)', async () => {
    sim.lookup.script(R.hang());
    let t0 = performance.now();
    expect((await adapter.check(stored(), secret(), { timeoutClass: 'inrequest' })).kind).toBe('transient');
    expect(performance.now() - t0).toBeLessThan(T.jobMs);
    t0 = performance.now();
    expect((await adapter.check(stored(), secret(), { timeoutClass: 'job' })).kind).toBe('transient');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(T.inrequestMs);
  });

  it('REQ-SEC-056: check logs a khalti_lookup row with status only; key, pidx-bound URL and Khalti `mobile` never stored/logged', async () => {
    sim.lookup.script({ status: 200, body: { pidx: 'pidx-stored-1', status: 'Completed', total_amount: 225000, transaction_id: 'T9', fee: 0, refunded: false, mobile: '9800000000' } });
    const s = sinkRows();
    await adapter.check(stored(), secret(), s.c);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ gateway: 'khalti', operation: 'khalti_lookup', outcome: 'answer', gatewayStatusRaw: 'Completed' });
    const all = JSON.stringify([s.rows, s.logs]);
    for (const needle of [KEY, '9800000000', 'mobile']) expect(all).not.toContain(needle);
  });

  it('check never throws on transport failure (resolves with transient)', async () => {
    sim.lookup.script(R.drop());
    await expect(adapter.check(stored(), secret())).resolves.toMatchObject({ kind: 'transient' });
  });
});
