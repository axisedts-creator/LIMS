// PG-T06 — eSewa adapter.check against the PG-T05 simulator + AC-PG-03.1-03.6 flows composed with the PG-T02 status mapping (TRD §7.2.4).
// Seam: see ../unit/gateways/esewa.adapter.test.ts. Extra assumptions (tester contract):
//   ctx (CallContext) = { timeoutClass: 'inrequest' | 'job'; attempt?; sink?(row: GatewayCallRecord); log?(fields) }  — passed through to callGateway
//   check() -> { kind:'answer', statusRaw: string, amountPaisa?: number, secondaryRef?: string }   statusRaw is eSewa's `status` verbatim
//           | { kind:'transient', reason: string }        (code:0, 5xx, timeout, network, unparseable body, >1 MiB)
//   amountPaisa comes from the shared decimal parser (domain/amount.rupeesTextToPaisa), never from floats; undefined = no/unparseable amount.
//   The adapter never settles anything: it reports; mapEsewaStatus + the service decide (REQ-SEC-047).
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mapEsewaStatus } from '../../domain/mapping.esewa.js';
import { createEsewaAdapter } from '../../gateways/esewa.adapter.js';
import { SecretHandle } from '../../service/credentials.js';
import { esewaReplies as E, startEsewaSim, type EsewaSim } from './esewa.sim.js';

const SECRET = 'PLANTED-esewa-secret-9Zx4'; // must never reach the sim, sink rows or logs
const ID = '0192f0a0-7b1e-7c3a-9d2e-4f5a6b7c8d9e';
const CODE = 'SYNTHCODE';
const intent = { id: ID, gatewayTxnRef: ID, amountPaisa: 225000, productCode: CODE, callbackToken: 'tok_SYNTHETIC_0123456789' };
const T = { initiateMs: 150, inrequestMs: 450, jobMs: 900 };
let es: EsewaSim;
beforeAll(async () => { es = await startEsewaSim(); });
afterAll(async () => { await es.close(); });
beforeEach(() => { es.reset(); });

const adapter = () => createEsewaAdapter({ formUrl: 'https://uat-form.example.test/form', statusUrl: es.statusUrl, publicBase: 'https://lims.example.test', timeouts: T });
const handle = () => new SecretHandle(SECRET);
type Row = Record<string, unknown>;
async function check(i: Record<string, unknown> = intent, cls: 'inrequest' | 'job' = 'inrequest') {
  const rows: Row[] = [], logs: Row[] = [];
  const r = await adapter().check(i as never, handle(), { timeoutClass: cls, sink: (x: Row) => { rows.push(x); }, log: (x: Row) => { logs.push(x); } } as never);
  return { r: r as Record<string, unknown>, rows, logs };
}
const outcomeOf = (r: Record<string, unknown>, status = 'initiated' as const) =>
  mapEsewaStatus({
    statusRaw: r['kind'] === 'answer' ? (r['statusRaw'] as string) : null,
    amountMatches: r['amountPaisa'] === intent.amountPaisa, beforeDeadline: true, intentStatus: status,
  });

describe('check: request (TRD §7.2.4)', () => {
  it('GET status?product_code&total_amount&transaction_uuid and nothing else; no secret on the wire', async () => {
    es.script(E.complete({ totalAmount: '2250.0' }));
    await check();
    expect(es.requests).toHaveLength(1);
    expect(es.requests[0]).toEqual({ method: 'GET', query: { product_code: CODE, total_amount: '2250', transaction_uuid: ID } });
  });
});

describe('check: answers (statusRaw verbatim, amount without floats)', () => {
  it('COMPLETE with totalAmount 2250.0 -> amountPaisa 225000, refId -> secondaryRef (AC-PG-03.1)', async () => {
    es.script(E.complete({ totalAmount: '2250.0', refId: '000AB12' }));
    const { r } = await check();
    expect(r).toMatchObject({ kind: 'answer', statusRaw: 'COMPLETE', amountPaisa: 225000, secondaryRef: '000AB12' });
  });

  it('no refId -> no secondaryRef key value', async () => {
    es.script(() => ({ body: `{"scd":"${CODE}","totalAmount":2250.0,"status":"COMPLETE"}` }));
    const { r } = await check();
    expect(r['secondaryRef'] ?? undefined).toBeUndefined();
    expect(r['amountPaisa']).toBe(225000);
  });

  it.each([
    ['2250', 225000], ['2250.0', 225000], ['2250.00', 225000],
    ['2250.1', 225010], // 2250.1 * 100 === 225010.00000000003 in IEEE-754: proves no float math
    ['2250.55', 225055], ['0.29', 29], ['4.35', 435], ['22.5', 2250],
    ['90071992547409.91', 9007199254740991], // beyond float precision; exact only via the decimal parser
  ])('totalAmount %s -> %i paisa exactly', async (text, paisa) => {
    es.script(E.complete({ totalAmount: text }));
    expect((await check()).r['amountPaisa']).toBe(paisa);
  });

  it.each(['2250.001', '2250.0001', '2250.999', '-2250', '-2250.0', '1e3'])('unusable totalAmount %s never equals the intent amount (more than 2 non-zero fraction digits / negative)', async (text) => {
    es.script(() => ({ body: `{"scd":"${CODE}","totalAmount":${text},"status":"COMPLETE","refId":"R1"}` }));
    const { r } = await check();
    if (r['kind'] === 'answer') expect(r['amountPaisa']).not.toBe(225000);
    else expect(r['kind']).toBe('transient');
  });

  it('totalAmount beyond the safe-integer range is not accepted as an amount', async () => {
    es.script(E.complete({ totalAmount: '90071992547409910.00' }));
    const { r } = await check();
    expect(r['amountPaisa'] ?? undefined).toBeUndefined();
  });

  it('COMPLETE without totalAmount -> amountPaisa undefined (cannot match)', async () => {
    es.script(() => ({ body: { scd: CODE, status: 'COMPLETE', refId: 'R1' } }));
    const { r } = await check();
    expect(r).toMatchObject({ kind: 'answer', statusRaw: 'COMPLETE' });
    expect(r['amountPaisa'] ?? undefined).toBeUndefined();
  });

  it('scd different from the product code is not a clean settle (TRD §7.2.4: gateway_identity_mismatch)', async () => {
    es.script(E.complete({ totalAmount: '2250.0', scd: 'ANOTHERCODE' }));
    const { r } = await check();
    if (r['kind'] === 'answer') expect(r['amountPaisa']).not.toBe(225000); // amount_mismatch class: must not map to settle
    expect(outcomeOf(r).kind).not.toBe('settle');
  });

  it('scd equal to the product code, or absent, is fine', async () => {
    es.script(E.complete({ totalAmount: '2250.0', scd: CODE }));
    expect(outcomeOf((await check()).r).kind).toBe('settle');
    es.script(() => ({ body: `{"totalAmount":2250.0,"status":"COMPLETE","refId":"R1"}` }));
    expect(outcomeOf((await check()).r).kind).toBe('settle');
  });

  it.each([
    ['PENDING', E.pending()], ['AMBIGUOUS', E.ambiguous()], ['AMBIGIOUS', E.ambigious()], ['NOT_FOUND', E.notFound()],
    ['CANCELED', E.canceled()], ['FULL_REFUND', E.fullRefund()], ['PARTIAL_REFUND', E.partialRefund()],
    ['SOMETHING_NEW', E.unknownStatus('SOMETHING_NEW')],
  ])('status %s is reported verbatim as an answer', async (s, reply) => {
    es.script(reply);
    expect((await check()).r).toMatchObject({ kind: 'answer', statusRaw: s });
  });
});

describe('check: no answer -> transient (retry), never throws (AC-PG-03.6)', () => {
  it.each([
    ['code 0 "Service is currently unavailable"', E.codeZero()],
    ['HTTP 500', E.serverError(500)],
    ['HTTP 503', E.serverError(503)],
    ['non-JSON body', E.malformed()],
    ['connection dropped', E.drop()],
    ['hung server (timeout)', E.hang()],
  ])('%s', async (_n, reply) => {
    es.script(reply);
    const { r } = await check();
    expect(r['kind']).toBe('transient');
    expect(typeof r['reason']).toBe('string');
  });

  it('oversized (> 1 MiB) body is transient, not an answer (REQ-SEC-101)', async () => {
    es.script({ body: `{"status":"COMPLETE","pad":"${'x'.repeat(1024 * 1024 + 10)}"}` });
    expect((await check()).r['kind']).toBe('transient');
  });

  it('job class uses its own (longer) timeout: a 600 ms reply passes under job (900 ms) but not under inrequest (450 ms)', async () => {
    es.script({ ...E.pending(), delayMs: 600 });
    expect((await check(intent, 'inrequest')).r['kind']).toBe('transient');
    es.script({ ...E.pending(), delayMs: 600 });
    expect((await check(intent, 'job')).r).toMatchObject({ kind: 'answer', statusRaw: 'PENDING' });
  });
});

describe('check: gateway_calls evidence and secrecy (TRD §7.6; REQ-SEC-056/098)', () => {
  it('sink row is operation esewa_status with an allowlisted redacted body; totalAmount stored as string', async () => {
    es.script(E.complete({ totalAmount: '2250.0', refId: 'R1', scd: CODE }));
    const { rows } = await check();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gateway: 'esewa', operation: 'esewa_status', outcome: 'answer', gatewayStatusRaw: 'COMPLETE' });
    const red = rows[0]!['responseRedacted'] as Record<string, unknown>;
    expect(typeof red['totalAmount']).toBe('string');
    expect(red).not.toHaveProperty('pid');
    for (const k of Object.keys(red)) expect(['status', 'totalAmount', 'refId', 'scd', 'code', 'error_message']).toContain(k);
  });

  it('code 0 is recorded as service_unavailable', async () => {
    es.script(E.codeZero());
    expect((await check()).rows[0]).toMatchObject({ operation: 'esewa_status', outcome: 'service_unavailable' });
  });

  it('the secret reaches neither the wire, the sink rows nor the log fields', async () => {
    es.script(E.complete({ totalAmount: '2250.0' }));
    const { rows, logs } = await check();
    expect(JSON.stringify(es.requests)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});

// ---- AC flows: signed callback (verifyCallbackSignature) + server-side status check + shared mapping ----
const NAMES = 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names';
function callback(over: Record<string, string> = {}, names = NAMES, secret = SECRET): string {
  const f: Record<string, string> = { transaction_code: '0001SIM', status: 'COMPLETE', total_amount: '2250', transaction_uuid: ID, product_code: CODE, signed_field_names: names, ...over };
  const sig = createHmac('sha256', secret).update(names.split(',').map((n) => `${n}=${f[n]}`).join(',')).digest('base64');
  return Buffer.from(JSON.stringify({ ...f, signature: sig }), 'utf8').toString('base64');
}
const verify = async (p: string) => adapter().verifyCallbackSignature!(p, handle(), intent as never);

describe('AC-PG-03.x flows (adapter facts only; state changes are the service\'s, PG-T14)', () => {
  it('AC-PG-03.1: signed COMPLETE callback + status COMPLETE 2250.0 -> valid, amount equal -> settle', async () => {
    expect((await verify(callback())).valid).toBe(true);
    es.script(E.complete({ totalAmount: '2250.0' }));
    expect(outcomeOf((await check()).r)).toEqual({ kind: 'settle' });
  });

  it('AC-PG-03.2: forged signature is invalid and the status check PENDING does not settle (-> to_pending)', async () => {
    expect((await verify(callback({}, NAMES, 'attacker-guess'))).valid).toBe(false);
    es.script(E.pending());
    expect(outcomeOf((await check()).r)).toEqual({ kind: 'to_pending' });
  });

  it('AC-PG-03.3: signed_field_names without total_amount is signature-invalid even though the HMAC is genuine', async () => {
    const names = 'transaction_code,status,transaction_uuid,product_code,signed_field_names';
    expect((await verify(callback({}, names))).valid).toBe(false);
  });

  it('AC-PG-03.4: COMPLETE with totalAmount 22.5 -> amount_mismatch hold (no settle)', async () => {
    es.script(E.complete({ totalAmount: '22.5' }));
    const { r } = await check();
    expect(r['amountPaisa']).toBe(2250);
    expect(outcomeOf(r)).toEqual({ kind: 'hold', reason: 'amount_mismatch' });
  });

  it.each([['AMBIGUOUS', E.ambiguous()], ['AMBIGIOUS', E.ambigious()]])('AC-PG-03.5: %s -> hold gateway_ambiguous', async (_s, reply) => {
    es.script(reply);
    expect(outcomeOf((await check()).r)).toEqual({ kind: 'hold', reason: 'gateway_ambiguous' });
  });

  it('AC-PG-03.6: code 0 -> unchanged intent, retry (poll job scheduled by the service)', async () => {
    es.script(E.codeZero());
    expect(outcomeOf((await check()).r)).toEqual({ kind: 'retry' });
  });

  it('a callback claiming COMPLETE changes nothing by itself: check() ignores the callback and asks eSewa (REQ-SEC-047)', async () => {
    es.script(E.notFound());
    expect(outcomeOf((await check()).r)).toEqual({ kind: 'stay' });
    expect(es.requests).toHaveLength(1);
  });
});
