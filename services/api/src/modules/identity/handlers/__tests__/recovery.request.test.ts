// T9 requestPasswordRecovery (03-APP-FLOW s3.7; 01-PRD AC-A7.1; 07-SECURITY AU-T5, REQ-SEC-075; TRD s5 row + s10 row identity.send_recovery).
// Constant response: 202 `{}` for ANY e-mail; the handler makes NO GoTrue call and NO existence-dependent read (the job decides) -> identical work for existing / unknown / locked.
// Expected now: fail (handlers/requestPasswordRecovery.ts is a stub; no createRequestPasswordRecovery).
import { describe, expect, it } from 'vitest';
import { CLIENT_IP, EMAIL, REQ_ID, errBody, hmacHex, makeWorld, norm, otherWrites, rejection, sha256hex } from './recovery.helpers.js';
import { createRequestPasswordRecovery } from '../requestPasswordRecovery.js';

const handler = (w: Awaited<ReturnType<typeof makeWorld>>) => createRequestPasswordRecovery(w.deps as any) as any;
const ALLOWED = ['enqueue', 'recordTenantless'];

describe('AC-A7.1 / AU-T5: constant response', () => {
  it('202 with body {} for an existing, an unknown, a locked-looking and a malformed-but-valid e-mail: identical status+body', async () => {
    const w = await makeWorld(); const known = await w.addUser(); const h = handler(w);
    const out = [];
    for (const email of [known.email, 'nobody-here@lims-test.example', 'locked.user@lims-test.example', 'Ünï.cödé@lims-test.example']) out.push(await w.call(h, { body: { email } }));
    for (const r of out) { expect(r.status).toBe(202); expect(r.body).toEqual({}); }
    expect(new Set(out.map((r) => JSON.stringify(r))).size).toBe(1);
  });
  it('same work for every e-mail: identical sequence of repo/limits/event calls, one tenant-less password_reset_requested event + one enqueue, no GoTrue call, no loginContext/session read', async () => {
    const w = await makeWorld(); const known = await w.addUser(); const h = handler(w); const seqs: string[][] = [];
    for (const email of [known.email, 'unknown-1@lims-test.example', 'unknown-2@lims-test.example']) {
      const o0 = w.store.order.length, c0 = w.lim.calls.length, g0 = w.calls.length; await w.call(h, { body: { email } }); w.advance(11 * 60_000);
      seqs.push([...w.store.order.slice(o0), ...w.lim.calls.slice(c0).map((c) => c.m), ...w.calls.slice(g0).map((c) => `gotrue.${c.method}`)]);
    }
    expect(seqs[0]).toEqual(seqs[1]); expect(seqs[1]).toEqual(seqs[2]);
    expect(seqs[0]).not.toContain('loginContext'); expect(seqs[0]).not.toContain('sessionByToken'); expect(seqs[0].filter((s) => s.startsWith('gotrue.'))).toEqual([]);
    expect(seqs[0].filter((s) => s === 'enqueue')).toHaveLength(1); expect(seqs[0].filter((s) => s === 'recordTenantless')).toHaveLength(1);
    expect(w.tx.bindTenant).not.toHaveBeenCalled();
  });
  it('the e-mail is normalised (trim, NFC, lower-case): "  ANA.Demo@Example.TEST " and "ana.demo@example.test" give the same job payload, job key and event hmac', async () => {
    const w = await makeWorld(); const h = handler(w);
    await w.call(h, { body: { email: '  ANA.Demo@Example.TEST ' } }); await w.call(h, { body: { email: EMAIL } });
    const q = w.store.committed('enqueue').map((x) => x.arg); expect(q).toHaveLength(2);
    expect(q[0]).toEqual(q[1]); expect(q[0].payload).toEqual({ email_norm: EMAIL });
    const ev = w.store.eventsOf('password_reset_requested'); expect(ev[0].emailHmacHex).toBe(hmacHex(EMAIL)); expect(ev[1].emailHmacHex).toBe(hmacHex(EMAIL));
  });
  it('enqueue = platform task identity.send_recovery { email_norm }, job_key recovery:<sha256(email_norm)>:<10-minute bucket> (<= 1 e-mail / 10 min / account)', async () => {
    const w = await makeWorld(); const h = handler(w);
    await w.call(h, { body: { email: EMAIL } }); w.advance(9 * 60_000); await w.call(h, { body: { email: EMAIL } }); w.advance(2 * 60_000); await w.call(h, { body: { email: EMAIL } });
    const q = w.store.committed('enqueue').map((x) => x.arg);
    for (const a of q) { expect(a.identifier).toBe('identity.send_recovery'); expect(a.jobKey).toMatch(/^recovery:[0-9a-f]{64}:\d+$/); expect(a.jobKey.split(':')[1]).toBe(sha256hex(norm(EMAIL))); }
    expect(q[1].jobKey).toBe(q[0].jobKey);          // 9 min later: same bucket -> graphile job_key dedupes
    expect(q[2].jobKey).not.toBe(q[0].jobKey);      // 11 min later: next bucket
    expect(q.map((a: any) => a.jobKey.split(':')[1])).toEqual([sha256hex(norm(EMAIL)), sha256hex(norm(EMAIL)), sha256hex(norm(EMAIL))]);
  });
  it('auth event password_reset_requested is tenant-less, carries the HMAC (never the e-mail), the trusted ctx.clientIp and request id', async () => {
    const w = await makeWorld(); await w.call(handler(w), { body: { email: EMAIL } }, { clientIp: '198.51.100.77' });
    const [e] = w.store.eventsOf('password_reset_requested'); expect(e).toMatchObject({ eventType: 'password_reset_requested', emailHmacHex: hmacHex(EMAIL), clientIp: '198.51.100.77', requestId: REQ_ID });
    expect(w.store.committed().filter((x) => x.m === 'recordTenant')).toHaveLength(0);
    expect(JSON.stringify(w.store.writes.filter((x) => x.m === 'recordTenantless'))).not.toContain(EMAIL);
  });
  it('one identityAuthTx { identity, requestPasswordRecovery } without a tenant; only the event + the enqueue are written; ctx.commitOnError not needed on 202', async () => {
    const w = await makeWorld(); const { hctx, commitOnError } = w.makeHctx(); await handler(w)(w.req({ body: { email: EMAIL } }), hctx);
    expect(w.txCalls).toHaveLength(1); expect(w.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'requestPasswordRecovery', context: 'identity_auth' } });
    expect(otherWrites(w.store, ALLOWED)).toEqual([]); expect(commitOnError).not.toHaveBeenCalled();
  });
  it('the response is independent of GoTrue health: a GoTrue that throws on every call changes nothing (the handler never calls it)', async () => {
    const w = await makeWorld(); const boom = new Proxy({}, { get: () => () => { throw new Error('GoTrue must not be called by requestPasswordRecovery'); } });
    const r = await createRequestPasswordRecovery({ ...(w.deps as any), gotrue: boom } as any)(w.req({ body: { email: EMAIL } }), w.makeHctx().hctx); expect(r.status).toBe(202);
  });
});

describe('rate limits and timing class', () => {
  it('account tier uses the HMAC of the normalised e-mail (a:<hmac> via limits.consumeAttempt), same for unknown and existing; the 11th request in 60 min -> 429 common.rate_limited with Retry-After, equally for an unknown e-mail', async () => {
    const w = await makeWorld(); const known = await w.addUser(); const h = handler(w);
    for (const email of [known.email, 'unknown-rl@lims-test.example']) {
      for (let i = 0; i < 10; i++) { expect((await w.call(h, { body: { email } })).status).toBe(202); w.advance(1_000); }
      const e = await rejection(w.call(h, { body: { email } })); expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(w.lim.calls.filter((c) => c.m === 'consumeAttempt').every((c) => /^[0-9a-f]{64}$/.test(c.key))).toBe(true);
    expect(w.lim.calls.some((c) => c.key.includes('@'))).toBe(false);
  });
  it('real-clock timing class: median of 60 existing vs 60 unknown calls differ by < 5 ms (no existence-dependent work)', async () => {
    const w = await makeWorld(); const known = await w.addUser(); const h = handler(w); const t = async (email: string) => { const s = process.hrtime.bigint(); await w.call(h, { body: { email: `${Math.random().toString(36).slice(2, 8)}-${email}` } }); return Number(process.hrtime.bigint() - s) / 1e6; };
    const a: number[] = [], b: number[] = []; for (let i = 0; i < 60; i++) { a.push(await t(known.email)); b.push(await t('unknown@lims-test.example')); w.advance(60_000); }
    const med = (x: number[]) => x.sort((p, q) => p - q)[x.length >> 1]!; expect(Math.abs(med(a) - med(b))).toBeLessThan(5);
  });
});

describe('validation and hygiene', () => {
  it.each([[{}], [{ email: 5 }], [{ email: 'a'.repeat(250) + '@x.test' }], [{ email: EMAIL, tenant_id: 'x' }], [{ email: EMAIL, redirect_to: 'https://evil.test' }], [null]])('body %j -> 400 common.validation_failed BEFORE any identityAuthTx / limiter call', async (body) => {
    const w = await makeWorld(); const e = await rejection(w.call(handler(w), { body })); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0); expect(w.lim.calls).toHaveLength(0); expect(w.store.writes).toHaveLength(0);
  });
  it('client IP is ctx.clientIp, never a header (P-61); a hostile X-Forwarded-For changes nothing', async () => {
    const w = await makeWorld(); const r: any = w.req({ body: { email: EMAIL } }); r.headers['x-forwarded-for'] = '10.9.9.9'; r.headers['x-real-ip'] = '10.8.8.8';
    await handler(w)(r, w.makeHctx().hctx); expect(JSON.stringify(w.store.writes)).not.toMatch(/10\.(9|8)\.\d\.\d/); expect(w.store.eventsOf('password_reset_requested')[0].clientIp).toBe(CLIENT_IP);
  });
  it('no log line contains the e-mail (02-TRD s11 never-logged list)', async () => {
    const w = await makeWorld(); await w.call(handler(w), { body: { email: EMAIL } }); expect(JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls])).not.toContain(EMAIL);
  });
  it('error bodies of the 429 are identical for existing and unknown e-mails (no oracle through the limiter)', async () => {
    const w = await makeWorld(); const known = await w.addUser(); const h = handler(w); const bodies: string[] = [];
    for (const email of [known.email, 'unknown-eb@lims-test.example']) { for (let i = 0; i < 10; i++) await w.call(h, { body: { email } }); bodies.push(errBody(await rejection(w.call(h, { body: { email } })))); w.advance(2 * 3_600_000); }
    const strip = (s: string) => s.replace(/"retry":\d+/, '"retry":N'); expect(strip(bodies[0]!)).toBe(strip(bodies[1]!));
  });
});
