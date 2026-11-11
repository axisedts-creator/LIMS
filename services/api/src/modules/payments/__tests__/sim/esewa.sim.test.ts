// PG-T05 — eSewa simulator self-test. Contract for ./esewa.sim.ts (TRD §7.2.4, §12; V5; 04 P3).
// Sim = local HTTP server on 127.0.0.1 answering the status check; replies are scripted per test.
// script(...replies): replaces the queue; served in order, the LAST reply repeats. reset() clears queue + requests.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { esewaReplies as R, startEsewaSim, type EsewaSim } from './esewa.sim.js';

let sim: EsewaSim;
beforeAll(async () => { sim = await startEsewaSim(); });
afterAll(async () => { await sim.close(); });
beforeEach(() => sim.reset());

const UUID = '7b1f0c52-0d51-4a63-9a52-2f0c1b7a9e11';
const Q = `product_code=EPAYTEST&total_amount=2250&transaction_uuid=${UUID}`;
const check = async (qs = Q) => {
  const r = await fetch(`${sim.statusUrl}?${qs}`);
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
};

describe('esewa sim — server', () => {
  it('listens on loopback and statusUrl ends with the documented path', () => {
    const u = new URL(sim.statusUrl);
    expect(u.hostname).toBe('127.0.0.1');
    expect(u.pathname).toBe('/api/epay/transaction/status/');
  });

  it('records each request: method GET + parsed query', async () => {
    sim.script(R.pending());
    await check();
    expect(sim.requests).toHaveLength(1);
    expect(sim.requests[0]!.method).toBe('GET');
    expect(sim.requests[0]!.query).toEqual({ product_code: 'EPAYTEST', total_amount: '2250', transaction_uuid: UUID });
  });

  it('serves scripted replies in order and repeats the last', async () => {
    sim.script(R.pending(), R.canceled());
    expect((await check()).json.status).toBe('PENDING');
    expect((await check()).json.status).toBe('CANCELED');
    expect((await check()).json.status).toBe('CANCELED');
  });

  it('reset() clears script and request log', async () => {
    sim.script(R.pending());
    await check();
    sim.reset();
    expect(sim.requests).toHaveLength(0);
  });

  it('close() resolves even with a hung request open', async () => {
    const s2 = await startEsewaSim();
    s2.script(R.hang());
    fetch(`${s2.statusUrl}?${Q}`, { signal: AbortSignal.timeout(300) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await expect(s2.close()).resolves.toBeUndefined();
  });
});

describe('esewa sim — documented bodies (HTTP 200, JSON, body.status is the signal)', () => {
  it('COMPLETE carries pid, scd, totalAmount as a JSON number, status, refId', async () => {
    sim.script(R.complete({ totalAmount: '2250.0', refId: '0001TS9', scd: 'EPAYTEST', pid: 'u-1' }));
    const r = await check();
    expect(r.status).toBe(200);
    // raw text matters: the adapter regex-extracts "totalAmount" (TRD §7.2.4), so 2250.0 must stay "2250.0"
    expect(r.text).toMatch(/"totalAmount"\s*:\s*2250\.0\b/);
    expect(r.json).toEqual({ pid: 'u-1', scd: 'EPAYTEST', totalAmount: 2250, status: 'COMPLETE', refId: '0001TS9' });
  });

  it('COMPLETE defaults echo the request transaction_uuid and product_code', async () => {
    sim.script(R.complete({ totalAmount: '2250' }));
    const r = await check();
    expect(r.json.status).toBe('COMPLETE');
    expect(r.json.pid).toBe(UUID);
    expect(r.json.scd).toBe('EPAYTEST');
    expect(typeof r.json.refId).toBe('string');
  });

  it.each([
    ['pending', 'PENDING'],
    ['ambiguous', 'AMBIGUOUS'],
    ['ambigious', 'AMBIGIOUS'], // vendor misspelling, kept verbatim (04 P3)
    ['fullRefund', 'FULL_REFUND'],
    ['partialRefund', 'PARTIAL_REFUND'],
    ['notFound', 'NOT_FOUND'],
    ['canceled', 'CANCELED'],
  ] as const)('%s -> status %s, HTTP 200', async (fn, status) => {
    sim.script(R[fn]());
    const r = await check();
    expect(r.status).toBe(200);
    expect(r.json.status).toBe(status);
  });

  it('code:0 -> {"code":0,"error_message":"Service is currently unavailable"} with no status field', async () => {
    sim.script(R.codeZero());
    const r = await check();
    expect(r.json).toEqual({ code: 0, error_message: 'Service is currently unavailable' });
    expect(r.json).not.toHaveProperty('status');
  });

  it('unknownStatus(x) returns that exact string (whitespace/case preserved)', async () => {
    sim.script(R.unknownStatus(' complete '));
    expect((await check()).json.status).toBe(' complete ');
  });
});

describe('esewa sim — failure modes', () => {
  it('serverError(503) -> HTTP 503; default 500', async () => {
    sim.script(R.serverError(503));
    expect((await check()).status).toBe(503);
    sim.script(R.serverError());
    expect((await check()).status).toBe(500);
  });

  it('malformed() -> HTTP 200 with non-JSON text', async () => {
    sim.script(R.malformed());
    const r = await check();
    expect(r.status).toBe(200);
    expect(r.json).toBeUndefined();
  });

  it('hang() never answers (client timeout fires)', async () => {
    sim.script(R.hang());
    await expect(fetch(`${sim.statusUrl}?${Q}`, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
  });

  it('drop() kills the socket (network error)', async () => {
    sim.script(R.drop());
    await expect(fetch(`${sim.statusUrl}?${Q}`)).rejects.toThrow();
  });

  it('raw SimReply works: custom status + object body + delayMs', async () => {
    sim.script({ status: 202, body: { status: 'PENDING' }, delayMs: 80 });
    const t0 = Date.now();
    const r = await check();
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ status: 'PENDING' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it('no secret is needed: request without any auth header is answered normally', async () => {
    sim.script(R.pending());
    expect((await check()).status).toBe(200);
  });
});
