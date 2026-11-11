// PG-T05 — Khalti simulator self-test. Contract for ./khalti.sim.ts (TRD §7.3, V9–V11; 04 P4; PRD US-PG-04 AC3, US-PG-12 AC2).
// startKhaltiSim({ apiKey? }): if apiKey is set, a request whose `Authorization` header is not exactly `Key <apiKey>`
// gets 401 {"detail":"Invalid token.","status_code":401} before any scripted reply is used. No apiKey = no check.
// lookup.script(...) and initiate.script(...) script their endpoints independently: last reply repeats; reset() clears all.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { khaltiReplies as R, startKhaltiSim, type KhaltiSim } from './khalti.sim.js';

const KEY = 'synthetic-test-key-0001';
let sim: KhaltiSim;
beforeAll(async () => { sim = await startKhaltiSim({ apiKey: KEY }); });
afterAll(async () => { await sim.close(); });
beforeEach(() => sim.reset());

const post = async (path: 'epayment/lookup/' | 'epayment/initiate/', body: unknown, auth: string | null = `Key ${KEY}`) => {
  const r = await fetch(sim.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
};
const lookup = (pidx = 'pidx-abc123', auth: string | null = `Key ${KEY}`) => post('epayment/lookup/', { pidx }, auth);

describe('khalti sim — server', () => {
  it('baseUrl is loopback and ends with /api/v2/', () => {
    const u = new URL(sim.baseUrl);
    expect(u.hostname).toBe('127.0.0.1');
    expect(u.pathname).toBe('/api/v2/');
  });

  it('records method, path, authorization header and parsed JSON body per call', async () => {
    sim.lookup.script(R.completed({ pidx: 'p1', totalAmount: 225000, transactionId: 'T1' }));
    await lookup('p1');
    expect(sim.requests).toHaveLength(1);
    expect(sim.requests[0]).toMatchObject({
      method: 'POST', path: '/api/v2/epayment/lookup/', authorization: `Key ${KEY}`, body: { pidx: 'p1' },
    });
  });

  it('serves scripted replies in order, last repeats', async () => {
    sim.lookup.script(R.pending({ pidx: 'p' }), R.initiated({ pidx: 'p' }));
    expect((await lookup()).json.status).toBe('Pending');
    expect((await lookup()).json.status).toBe('Initiated');
    expect((await lookup()).json.status).toBe('Initiated');
  });

  it('reset() clears scripts and request log', async () => {
    sim.lookup.script(R.pending({ pidx: 'p' }));
    await lookup();
    sim.reset();
    expect(sim.requests).toHaveLength(0);
  });

  it('unknown path -> 404', async () => {
    const r = await fetch(sim.baseUrl + 'nope/', { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('close() resolves even with a hung request open', async () => {
    const s2 = await startKhaltiSim();
    s2.lookup.script(R.hang());
    fetch(s2.baseUrl + 'epayment/lookup/', { method: 'POST', body: '{"pidx":"x"}', signal: AbortSignal.timeout(300) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await expect(s2.close()).resolves.toBeUndefined();
  });
});

describe('khalti sim — key check (V11, credential test US-PG-12 AC2)', () => {
  it.each([['Key wrong-key'], [`key ${KEY}`], [null]])('auth %j -> 401 Invalid token. (scripted reply ignored)', async (auth) => {
    sim.lookup.script(R.completed({ pidx: 'p', totalAmount: 1000, transactionId: 'T' }));
    const r = await lookup('p', auth);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ detail: 'Invalid token.', status_code: 401 });
  });

  it('correct key passes through to the script', async () => {
    sim.lookup.script(R.pending({ pidx: 'p' }));
    expect((await lookup('p')).status).toBe(200);
  });

  it('sim without apiKey performs no key check', async () => {
    const s2 = await startKhaltiSim();
    try {
      s2.lookup.script(R.pending({ pidx: 'p' }));
      const r = await fetch(s2.baseUrl + 'epayment/lookup/', { method: 'POST', body: '{"pidx":"p"}' });
      expect((await r.json()).status).toBe('Pending');
    } finally { await s2.close(); }
  });

  it('invalidToken() reply can also be scripted explicitly', async () => {
    const s2 = await startKhaltiSim();
    try {
      s2.lookup.script(R.invalidToken());
      const r = await fetch(s2.baseUrl + 'epayment/lookup/', { method: 'POST', body: '{"pidx":"p"}' });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ detail: 'Invalid token.', status_code: 401 });
    } finally { await s2.close(); }
  });
});

describe('khalti sim — lookup bodies (V10: pidx, total_amount, status, transaction_id, fee, refunded)', () => {
  it('Completed: HTTP 200, integer total_amount, transaction_id, fee, refunded=false', async () => {
    sim.lookup.script(R.completed({ pidx: 'p9', totalAmount: 225000, transactionId: 'GFq9PFS7b2iYvL8Lir9oXe' }));
    const r = await lookup('p9');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ pidx: 'p9', total_amount: 225000, status: 'Completed', transaction_id: 'GFq9PFS7b2iYvL8Lir9oXe', refunded: false });
    expect(Number.isSafeInteger(r.json.total_amount)).toBe(true);
    expect(typeof r.json.fee).toBe('number');
  });

  it.each([
    ['pending', 'Pending', 200],
    ['initiated', 'Initiated', 200],
    ['refunded', 'Refunded', 200],
    ['partiallyRefunded', 'Partially Refunded', 200],
    ['expired', 'Expired', 400], // HTTP 400 + body status; HTTP code must not be the signal (04 P4)
    ['userCanceled', 'User canceled', 400],
    ['canceled', 'Canceled', 400],
    ['failed', 'Failed', 400],
  ] as const)('%s -> body status %j, HTTP %i', async (fn, status, http) => {
    sim.lookup.script(R[fn]({ pidx: 'p2' }));
    const r = await lookup('p2');
    expect(r.status).toBe(http);
    expect(r.json.status).toBe(status);
    expect(r.json.pidx).toBe('p2');
  });

  it('refunded=true on Refunded replies', async () => {
    sim.lookup.script(R.refunded({ pidx: 'p' }));
    expect((await lookup('p')).json.refunded).toBe(true);
  });

  it('unknownStatus(x) returns that exact string with HTTP 200', async () => {
    sim.lookup.script(R.unknownStatus('Settling', { pidx: 'p' }));
    const r = await lookup('p');
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('Settling');
  });

  it('notFound() -> {"detail":"Not found.","error_key":"validation_error"}, 4xx, no status field', async () => {
    sim.lookup.script(R.notFound());
    const r = await lookup();
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.json).toEqual({ detail: 'Not found.', error_key: 'validation_error' });
  });

  it('serverError(502) -> HTTP 502; default 500', async () => {
    sim.lookup.script(R.serverError(502));
    expect((await lookup()).status).toBe(502);
    sim.lookup.script(R.serverError());
    expect((await lookup()).status).toBe(500);
  });

  it('malformed() -> HTTP 200 non-JSON; hang() never answers; drop() kills socket', async () => {
    sim.lookup.script(R.malformed());
    const m = await lookup();
    expect(m.status).toBe(200);
    expect(m.json).toBeUndefined();
    sim.lookup.script(R.hang());
    await expect(fetch(sim.baseUrl + 'epayment/lookup/', { method: 'POST', body: '{}', headers: { authorization: `Key ${KEY}` }, signal: AbortSignal.timeout(200) })).rejects.toThrow();
    sim.lookup.script(R.drop());
    await expect(lookup()).rejects.toThrow();
  });

  it('raw SimReply works: custom status + object body + delayMs', async () => {
    sim.lookup.script({ status: 418, body: { status: 'Completed' }, delayMs: 80 });
    const t0 = Date.now();
    const r = await lookup();
    expect(r.status).toBe(418);
    expect(r.json).toEqual({ status: 'Completed' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });
});

describe('khalti sim — initiate (TRD §7.3.2, V11)', () => {
  const body = { return_url: 'https://lims.example/v1/payments/callbacks/khalti/tok', website_url: 'https://lims.example', amount: 225000, purchase_order_id: 'i-1', purchase_order_name: 'Lab invoice' };

  it('initiateOk() -> pidx, https payment_url, expires_at, expires_in; request body recorded', async () => {
    sim.initiate.script(R.initiateOk({ pidx: 'bZQLD9wRVWo4CdESSfuSsB' }));
    const r = await post('epayment/initiate/', body);
    expect(r.status).toBe(200);
    expect(r.json.pidx).toBe('bZQLD9wRVWo4CdESSfuSsB');
    expect(r.json.payment_url).toMatch(/^https:\/\//);
    expect(typeof r.json.expires_at).toBe('string');
    expect(typeof r.json.expires_in).toBe('number');
    expect(sim.requests[0]!.body).toEqual(body);
  });

  it('validation error -> 400 with error_key "validation_error"', async () => {
    sim.initiate.script(R.initiateValidationError({ amount: ['Amount should be greater than Rs. 10, that is 1000 paisa.'] }));
    const r = await post('epayment/initiate/', body);
    expect(r.status).toBe(400);
    expect(r.json.error_key).toBe('validation_error');
    expect(r.json.amount).toEqual(['Amount should be greater than Rs. 10, that is 1000 paisa.']);
  });

  it('wrong key on initiate -> 401 Invalid token.', async () => {
    sim.initiate.script(R.initiateOk({ pidx: 'p' }));
    const r = await post('epayment/initiate/', body, 'Key nope');
    expect(r.status).toBe(401);
    expect(r.json.detail).toBe('Invalid token.');
  });

  it('serverError on initiate -> 5xx', async () => {
    sim.initiate.script(R.serverError(503));
    expect((await post('epayment/initiate/', body)).status).toBe(503);
  });
});
