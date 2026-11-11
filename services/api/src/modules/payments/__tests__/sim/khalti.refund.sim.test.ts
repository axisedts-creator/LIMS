// PG-T15 — Khalti adapter refundViaApi vs the loopback simulator (TRD §7.4, §6.6 step 4; PRD AC-PG-09.7; REQ-SEC-047/056; ST-11). The refund API is UNVERIFIED (V13): method POST,
// path, body and the success detail are the TRD's reading, so these tests pin exactly that and nothing wider.
// Assumed seam (tester; writer may dispute via .orchestra/notes) — gateways/khalti.adapter.ts:
//   createKhaltiAdapter({ baseUrl, publicBaseUrl, timeouts, refundOrigin })   refundOrigin = LIMS_PAYMENTS_KHALTI_REFUND_ORIGIN (scheme + host, no path)
//   refundViaApi(r: { refundId, intentId, transactionId, amountPaisa, fullRefund }, secret: SecretHandle, c?: { sink?, log? })
//        -> { kind: 'accepted' | 'rejected' | 'unknown'; detail?: string }      (never throws on transport / HTTP trouble; ONE attempt, no retry)
//   transactionId = Khalti `transaction_id` from the lookup; fullRefund -> body {} ; partial -> body { amount: <paisa integer> }.
//   'accepted' only for HTTP 2xx with body.detail === 'Transaction refund successful.'; every other answer is 'unknown' (no failure body is documented, so 'rejected' is never produced today).
//   Sink row: operation 'khalti_refund', attempt 1. The secret is read only inside SecretHandle.use() and goes only into the Authorization header.
// Fails now: refundViaApi is not a function.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKhaltiAdapter } from '../../gateways/khalti.adapter.js';
import { SecretHandle } from '../../service/credentials.js';
import { khaltiReplies as R, startKhaltiSim, type KhaltiSim } from './khalti.sim.js';

const KEY = 'PLANTED-khalti-key-9Zx4';
const T = { initiateMs: 150, inrequestMs: 300, jobMs: 300 };
const secret = (k = KEY): SecretHandle => new SecretHandle(k);
const TXN = 'TXN-SYN-0001';

let sim: KhaltiSim;
let adapter: any;
beforeAll(async () => {
  sim = await startKhaltiSim({ apiKey: KEY });
  adapter = createKhaltiAdapter({ baseUrl: sim.baseUrl, publicBaseUrl: 'https://lims.example.test', timeouts: T, refundOrigin: sim.origin } as any);
});
afterAll(async () => { await sim.close(); });
beforeEach(() => sim.reset());

const refundOf = (o: Record<string, unknown> = {}) => ({ refundId: '01900000-0000-7000-8000-0000000f0001', intentId: '01900000-0000-7000-8000-0000000f0002', transactionId: TXN,
  amountPaisa: 225000, fullRefund: true, ...o });
const call = (o: Record<string, unknown> = {}, s = secret(), c: Record<string, unknown> = {}): Promise<any> => adapter.refundViaApi(refundOf(o), s, c);
const refundReqs = () => sim.requests.filter((r) => /\/refund\/$/.test(r.path));

describe('refundViaApi request shape (TRD §7.4)', () => {
  it('is a function on the adapter (the flag-off path never reaches it, AC-PG-09.7)', () => { expect(typeof adapter.refundViaApi).toBe('function'); });

  it('full refund: POST <origin>/api/merchant-transaction/<transaction_id>/refund/ with `Authorization: Key <secret>` and body {} -> accepted', async () => {
    sim.refund.script(R.refundOk());
    const out = await call();
    expect(out).toMatchObject({ kind: 'accepted' });
    expect(sim.requests).toHaveLength(1);
    expect(sim.requests[0]).toMatchObject({ method: 'POST', path: `/api/merchant-transaction/${TXN}/refund/`, authorization: `Key ${KEY}` });
    expect(sim.requests[0]!.body).toEqual({});
  });

  it('partial refund: body is exactly { amount: <paisa integer> }', async () => {
    sim.refund.script(R.refundOk());
    expect(await call({ amountPaisa: 100000, fullRefund: false })).toMatchObject({ kind: 'accepted' });
    expect(sim.requests[0]!.body).toEqual({ amount: 100000 });
    expect(Number.isInteger((sim.requests[0]!.body as any).amount)).toBe(true);
  });

  it('only the documented fields leave: no refund id, intent id, reason or mobile in the body; the secret only in the Authorization header', async () => {
    sim.refund.script(R.refundOk());
    await call({ amountPaisa: 100000, fullRefund: false, mobile: '9800000000', reasonText: 'patient name SENTINEL' });
    const raw = JSON.stringify(sim.requests[0]!.body);
    for (const s of ['01900000', 'mobile', '9800000000', 'SENTINEL', KEY]) expect(raw).not.toContain(s);
    expect(sim.requests[0]!.path).not.toContain(KEY);
  });
});

describe('refundViaApi outcomes: one attempt, never throws, anything unexpected is "unknown"', () => {
  const CASES: [string, () => any][] = [
    ['HTTP 200 with another detail', () => R.refundOther(200, { detail: 'Something else happened.' })],
    ['HTTP 200 with no detail', () => R.refundOther(200, {})],
    ['HTTP 400 validation body', () => R.refundOther(400, { detail: 'Invalid amount.', error_key: 'validation_error' })],
    ['HTTP 401 invalid token', () => R.invalidToken()],
    ['HTTP 404', () => R.notFound()],
    ['HTTP 500', () => R.serverError(500)],
    ['HTTP 503', () => R.serverError(503)],
    ['non-JSON body', () => R.malformed()],
    ['connection dropped', () => R.drop()],
    ['no answer within the job timeout', () => R.hang()],
  ];
  it.each(CASES)('%s -> { kind: "unknown" } after exactly ONE request (the refund API idempotency is undocumented: never retried)', async (_n, reply) => {
    sim.refund.script(reply());
    const out = await call();
    expect(out.kind).toBe('unknown');
    expect(refundReqs()).toHaveLength(1);
  });

  it('a 2xx whose detail is the success text but with an HTTP error code is still not accepted', async () => {
    sim.refund.script(R.refundOther(500, { detail: 'Transaction refund successful.' }));
    expect((await call()).kind).toBe('unknown');
  });

  it('the success text alone is accepted; the detail is passed back for the evidence row', async () => {
    sim.refund.script(R.refundOk());
    expect(await call()).toMatchObject({ kind: 'accepted', detail: 'Transaction refund successful.' });
  });
});

describe('refundViaApi input guards (no network call on bad input)', () => {
  const BAD: [string, Record<string, unknown>][] = [
    ['transaction id with a path traversal', { transactionId: '../../v2/epayment/initiate' }],
    ['transaction id with a query', { transactionId: 'TXN?amount=1' }],
    ['transaction id with a slash', { transactionId: 'a/b' }],
    ['empty transaction id', { transactionId: '' }],
    ['over-long transaction id', { transactionId: 'T'.repeat(200) }],
    ['zero amount', { amountPaisa: 0, fullRefund: false }],
    ['negative amount', { amountPaisa: -1, fullRefund: false }],
    ['fractional amount', { amountPaisa: 100.5, fullRefund: false }],
    ['unsafe integer amount', { amountPaisa: 2 ** 60, fullRefund: false }],
    ['string amount', { amountPaisa: '100000', fullRefund: false }],
  ];
  it.each(BAD)('%s -> nothing is sent (and it does not report an accepted refund)', async (_n, o) => {
    sim.refund.script(R.refundOk());
    const out = await call(o).catch((e: unknown) => ({ kind: 'threw', e }));
    expect(sim.requests).toHaveLength(0);
    expect((out as any).kind).not.toBe('accepted');
  });
});

describe('refundViaApi evidence + secrecy (REQ-SEC-056, ST-11)', () => {
  it('writes one khalti_refund sink row (attempt 1) and a log line; neither carries the secret, the transaction id or the amount body', async () => {
    sim.refund.script(R.refundOk());
    const rows: any[] = [], logs: any[] = [];
    await call({}, secret(), { sink: (r: unknown) => { rows.push(r); }, log: (f: unknown) => { logs.push(f); } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gateway: 'khalti', operation: 'khalti_refund', attempt: 1, httpStatus: 200, outcome: 'answer' });
    const blob = JSON.stringify([rows, logs]);
    expect(blob).not.toContain(KEY);
    expect(blob).not.toContain('Authorization');
    expect(logs[0]).toMatchObject({ gateway: 'khalti', operation: 'khalti_refund' });
  });

  it('a wrong key is answered by the gateway as an invalid token: unknown, and the planted key of another tenant never appears in the sink', async () => {
    const rows: any[] = [];
    const out = await call({}, secret('OTHER-TENANT-KEY'), { sink: (r: unknown) => { rows.push(r); } });
    expect(out.kind).toBe('unknown');
    expect(JSON.stringify(rows)).not.toContain('OTHER-TENANT-KEY');
  });

  it('no redirect is followed (the Authorization header is never replayed to another host)', async () => {
    sim.refund.script({ status: 302, body: '' });
    expect((await call()).kind).toBe('unknown');
    expect(refundReqs()).toHaveLength(1);
  });
});
