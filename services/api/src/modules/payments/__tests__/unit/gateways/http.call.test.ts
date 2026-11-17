// PG-T04 — callGateway: timeouts per class, outcome mapping, redacted sink row, log-field allowlist (TRD §3.2, §7.6; REQ-SEC-056/098/101; ST-11).
// Assumed seam (tester; writer may dispute via notes): gateways/http.ts exports
//   callGateway({ gateway, operation, url, method?, headers?, body?, timeoutClass: 'initiate'|'inrequest'|'job',
//                 timeouts: { initiateMs, inrequestMs, jobMs }, attempt?, intentId?, sink?(row), log?(fields) }) -> Promise<GatewayResult>
//   GatewayResult = { outcome, httpStatus: number|null, durationMs, json?: unknown, text?: string }   // never throws on network/timeout/parse failure
//   sink row = { gateway, operation, attempt, httpStatus, outcome, gatewayStatusRaw (<=64 chars|null), responseRedacted (redactResponse output|null), durationMs }
//   log fields (keys only from) gateway, operation, outcome, http_status, duration_ms, intent_id
//   outcomes: answer | service_unavailable | timeout | network_error | http_error | auth_error | not_found | invalid_response  (05-SCHEMA gateway_calls__outcome__ck)
//   A body carrying `status` is an answer whatever the HTTP code (TRD §7.3.3). Responses above 1 MiB -> invalid_response (size cap, REQ-SEC-101).
// Targets are the PG-T05 loopback simulators; every value is synthetic.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callGateway } from '../../../gateways/http.js';
import { esewaReplies as E, startEsewaSim, type EsewaSim } from '../../sim/esewa.sim.js';
import { khaltiReplies as K, startKhaltiSim, type KhaltiSim } from '../../sim/khalti.sim.js';

const KEY = 'PLANTED-khalti-key-7Hq2'; // must never reach sink rows or logs
const PHONE = '9800000000';
const T = { initiateMs: 150, inrequestMs: 450, jobMs: 900 };
let kh: KhaltiSim, es: EsewaSim;
beforeAll(async () => { kh = await startKhaltiSim({ apiKey: KEY }); es = await startEsewaSim(); });
afterAll(async () => { await kh.close(); await es.close(); });
beforeEach(() => { kh.reset(); es.reset(); });

type Row = Record<string, unknown>;
async function khalti(op: 'khalti_lookup' | 'khalti_initiate', cls: 'initiate' | 'inrequest' | 'job', extra: Record<string, unknown> = {}) {
  const rows: Row[] = [], logs: Row[] = [];
  const path = op === 'khalti_lookup' ? 'epayment/lookup/' : 'epayment/initiate/';
  const res = await callGateway({
    gateway: 'khalti', operation: op, url: kh.baseUrl + path, method: 'POST',
    headers: { authorization: `Key ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pidx: 'p1', note: `PLANTED-body-${PHONE}` }),
    timeoutClass: cls, timeouts: T, intentId: 'intent-1', sink: (r: Row) => { rows.push(r); }, log: (f: Row) => { logs.push(f); }, ...extra,
  } as never);
  return { res, rows, logs };
}

describe('timeouts per class', () => {
  it('initiate class aborts a hung request at ~initiateMs', async () => {
    kh.initiate.script(K.hang());
    const { res, rows } = await khalti('khalti_initiate', 'initiate');
    expect(res.outcome).toBe('timeout');
    expect(res.durationMs).toBeGreaterThanOrEqual(140);
    expect(res.durationMs).toBeLessThan(T.inrequestMs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'timeout', operation: 'khalti_initiate', gateway: 'khalti', httpStatus: null });
  });

  it('inrequest class waits longer than initiate: a 300 ms reply times out at initiate but answers at inrequest', async () => {
    kh.lookup.script({ ...K.pending({ pidx: 'p1' }), delayMs: 300 });
    expect((await khalti('khalti_lookup', 'initiate')).res.outcome).toBe('timeout');
    expect((await khalti('khalti_lookup', 'inrequest')).res.outcome).toBe('answer');
  });

  it('inrequest class aborts a hang at ~inrequestMs, job class at ~jobMs', async () => {
    kh.lookup.script(K.hang());
    const a = await khalti('khalti_lookup', 'inrequest');
    expect(a.res.outcome).toBe('timeout');
    expect(a.res.durationMs).toBeGreaterThanOrEqual(440);
    expect(a.res.durationMs).toBeLessThan(T.jobMs);
    const b = await khalti('khalti_lookup', 'job');
    expect(b.res.outcome).toBe('timeout');
    expect(b.res.durationMs).toBeGreaterThanOrEqual(890);
  }, 10_000);

  it('a timeout is not thrown and does not leak the key or url secrets in the result', async () => {
    kh.lookup.script(K.hang());
    const { res } = await khalti('khalti_lookup', 'initiate');
    expect(JSON.stringify(res)).not.toContain(KEY);
  });
});

describe('outcome mapping', () => {
  it('khalti 200 Completed -> answer; gatewayStatusRaw = body.status; response redacted', async () => {
    kh.lookup.script(K.completed({ pidx: 'p1', totalAmount: 225000, transactionId: 'T1' }));
    const { res, rows } = await khalti('khalti_lookup', 'inrequest');
    expect(res).toMatchObject({ outcome: 'answer', httpStatus: 200 });
    expect(rows[0]).toMatchObject({ outcome: 'answer', httpStatus: 200, gatewayStatusRaw: 'Completed', attempt: 1 });
    expect(rows[0]!['responseRedacted']).toEqual({ status: 'Completed', total_amount: 225000, transaction_id: 'T1', refunded: false, fee: 0 });
  });

  it('khalti 400 with body.status (Expired) is still an answer', async () => {
    kh.lookup.script(K.expired({ pidx: 'p1' }));
    const { res, rows } = await khalti('khalti_lookup', 'inrequest');
    expect(res).toMatchObject({ outcome: 'answer', httpStatus: 400 });
    expect(rows[0]).toMatchObject({ gatewayStatusRaw: 'Expired' });
  });

  it('khalti 401 Invalid token, no status -> auth_error', async () => {
    kh.lookup.script(K.invalidToken());
    expect((await khalti('khalti_lookup', 'inrequest')).res).toMatchObject({ outcome: 'auth_error', httpStatus: 401 });
  });

  it('khalti 404 Not found, no status -> not_found', async () => {
    kh.lookup.script(K.notFound());
    expect((await khalti('khalti_lookup', 'inrequest')).res).toMatchObject({ outcome: 'not_found', httpStatus: 404 });
  });

  it('5xx -> service_unavailable', async () => {
    kh.lookup.script(K.serverError(503));
    expect((await khalti('khalti_lookup', 'inrequest')).res).toMatchObject({ outcome: 'service_unavailable', httpStatus: 503 });
  });

  it('malformed 200 body -> invalid_response, nothing stored in responseRedacted', async () => {
    kh.lookup.script(K.malformed());
    const { res, rows } = await khalti('khalti_lookup', 'inrequest');
    expect(res.outcome).toBe('invalid_response');
    expect(rows[0]).toMatchObject({ outcome: 'invalid_response', responseRedacted: null, gatewayStatusRaw: null });
  });

  it('dropped connection -> network_error', async () => {
    kh.lookup.script(K.drop());
    expect((await khalti('khalti_lookup', 'inrequest')).res).toMatchObject({ outcome: 'network_error', httpStatus: null });
  });

  it('connection refused -> network_error (no throw)', async () => {
    const res = await callGateway({
      gateway: 'khalti', operation: 'khalti_lookup', url: 'http://127.0.0.1:1/api/v2/epayment/lookup/', method: 'POST', body: '{}',
      timeoutClass: 'inrequest', timeouts: T,
    } as never);
    expect(res.outcome).toBe('network_error');
  });

  it('khalti initiate 400 validation error keeps only error_key (no field-message free text)', async () => {
    kh.initiate.script(K.initiateValidationError({ amount: ['Amount should be greater than Rs. 1'] }));
    const { rows } = await khalti('khalti_initiate', 'initiate', { timeouts: { ...T, initiateMs: 1000 } });
    expect(rows[0]!['responseRedacted']).toEqual({ error_key: 'validation_error' });
  });

  it('esewa code:0 (service unavailable) -> service_unavailable, code and error_message kept', async () => {
    es.script(E.codeZero());
    const rows: Row[] = [];
    const res = await callGateway({
      gateway: 'esewa', operation: 'esewa_status', url: es.statusUrl, method: 'GET', timeoutClass: 'job', timeouts: T,
      sink: (r: Row) => { rows.push(r); },
    } as never);
    expect(res.outcome).toBe('service_unavailable');
    expect(rows[0]!['responseRedacted']).toEqual({ code: 0, error_message: 'Service is currently unavailable' });
  });

  it('esewa COMPLETE -> answer; stored totalAmount is a string', async () => {
    es.script(E.complete({ totalAmount: '2250.0', refId: '0001SIM' }));
    const rows: Row[] = [];
    const res = await callGateway({
      gateway: 'esewa', operation: 'esewa_status', url: es.statusUrl + '?transaction_uuid=u1&product_code=EPAYTEST&total_amount=2250', method: 'GET',
      timeoutClass: 'inrequest', timeouts: T, sink: (r: Row) => { rows.push(r); },
    } as never);
    expect(res.outcome).toBe('answer');
    expect(rows[0]).toMatchObject({ gateway: 'esewa', operation: 'esewa_status', gatewayStatusRaw: 'COMPLETE' });
    expect(rows[0]!['responseRedacted']).toMatchObject({ status: 'COMPLETE', refId: '0001SIM' });
    expect(typeof (rows[0]!['responseRedacted'] as Row)['totalAmount']).toBe('string');
    expect(JSON.stringify(rows[0])).not.toContain('pid');
  });

  it('response larger than 1 MiB -> invalid_response, not buffered into the sink', async () => {
    kh.lookup.script({ body: JSON.stringify({ status: 'Completed', pad: 'x'.repeat(5 * 1024 * 1024) }) });
    const { res, rows } = await khalti('khalti_lookup', 'job');
    expect(res.outcome).toBe('invalid_response');
    expect(rows[0]).toMatchObject({ responseRedacted: null });
  });
});

describe('what is stored / logged (REQ-SEC-056/098)', () => {
  it('gatewayStatusRaw is truncated to 64 chars (gateway_calls__raw__ck)', async () => {
    kh.lookup.script(K.unknownStatus('Z'.repeat(300), { pidx: 'p1' }));
    const { rows } = await khalti('khalti_lookup', 'inrequest');
    expect((rows[0]!['gatewayStatusRaw'] as string).length).toBeLessThanOrEqual(64);
  });

  it('sink row never contains request headers/body, the key, the phone, or payment_url', async () => {
    kh.lookup.script(K.completed({ pidx: 'p1', totalAmount: 1, transactionId: 'T1' }));
    const { rows } = await khalti('khalti_lookup', 'inrequest');
    kh.initiate.script({ ...K.initiateOk({ pidx: 'p1' }), body: { ...(K.initiateOk({ pidx: 'p1' }).body as object), mobile: PHONE } });
    const init = await khalti('khalti_initiate', 'initiate', { timeouts: { ...T, initiateMs: 1000 } });
    const all = JSON.stringify([...rows, ...init.rows]);
    expect(all).not.toMatch(/PLANTED|9800000000|payment_url|test-pay\.khalti\.com|authorization/i);
  });

  it('log lines carry only gateway, operation, outcome, http_status, duration_ms, intent_id', async () => {
    kh.lookup.script(K.completed({ pidx: 'p1', totalAmount: 1, transactionId: 'T1' }));
    const ok = await khalti('khalti_lookup', 'inrequest');
    kh.lookup.script(K.hang());
    const bad = await khalti('khalti_lookup', 'initiate');
    const allowed = new Set(['gateway', 'operation', 'outcome', 'http_status', 'duration_ms', 'intent_id']);
    for (const l of [...ok.logs, ...bad.logs]) for (const k of Object.keys(l)) expect(allowed.has(k), `unexpected log key ${k}`).toBe(true);
    expect(ok.logs.length + bad.logs.length).toBeGreaterThanOrEqual(2);
    expect(ok.logs[0]).toMatchObject({ gateway: 'khalti', operation: 'khalti_lookup', outcome: 'answer', http_status: 200, intent_id: 'intent-1' });
    expect(JSON.stringify([...ok.logs, ...bad.logs])).not.toMatch(/PLANTED|9800000000/);
  });
});
