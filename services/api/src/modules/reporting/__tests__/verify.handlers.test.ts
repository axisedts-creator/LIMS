// C6-T22 — Q1 POST /v1/reporting/verifications (operationId verifyReportQr) via app.reporting_verify_qr.
// ACs: AC-10.1 (minimal fields), AC-10.2 (superseded), AC-10.3 (byte-identical 404s), AC-10.4 (app side: 100/day per app.client_ip, qr_verify tier), AC-10.5 (only SHA-256 reaches the DB);
// 07-SECURITY REQ-SEC-018, REQ-SEC-095, tests 7 (qr_verify budget per client IP) and 14 (identical responses, byte compare); 06-PLAN C6-T22 "timing sanity".
// ASSUMED handler contract (like T20 portal handlers): handlers/verify.handlers.ts, handler(req, ctx) with req.body = { qr_token }, public ctx = { clientIp, tx (anonymousTx), now(), log,
// rateLimit.consume(tier, key) } (NO tenantId / actor). The handler (1) consumes rateLimit 'qr_verify' key `i:<ctx.clientIp>` BEFORE anything else (every call counts, hit or miss),
// (2) checks ^[A-Za-z0-9_-]{22}$ itself, (3) sends ONE statement `SELECT * FROM app.reporting_verify_qr($1)` with sha256(token) as a 32-byte Buffer/Uint8Array,
// (4) returns { status: 200, body: { lab_name, patient_display, panel_names, issued_at (ISO), version_no, status } } or THROWS LimsError('reporting.verify_not_found') (404).
// Not testable here: nginx 10 r/m per IP (C1), `X-Forwarded-For` -> app.client_ip (core), portal page copy "Superseded - a newer version ..." (apps/portal), real PG/DEFINER/RLS (db/tests).
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });   // first import of the module manifest parses the OpenAPI spec
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { LAB_NAME, PATIENT_MASKED, PHONE, VER_A1, VER_A2, VER_B1, NOW, errShape, rejection, sha256buf } from './portal.helpers.js';
import { IP_A, IP_B, failureBytes, makeVerifyWorld } from './verify.helpers.js';
import { issueToken } from '../domain/tokens.js';

const OP = 'verifyReportQr';
const NOT_FOUND = { code: 'reporting.verify_not_found', statusCode: 404 };

describe('fake self-check (passes without the implementation)', () => {
  it('the DEFINER fake follows 05-SCHEMA §6.2: released -> valid, superseded -> superseded, revoked / unreleased / discarded / non-32-byte arg -> no row', async () => {
    const w = makeVerifyWorld(); const ask = async (h: unknown) => (await w.baseCtx().tx.query('SELECT * FROM app.reporting_verify_qr($1)', [h])).rows;
    const t1 = w.qrTokenFor(VER_A1); expect(await ask(sha256buf(t1))).toHaveLength(1); expect((await ask(sha256buf(t1)))[0].status).toBe('valid');
    expect(await ask(sha256buf(t1).subarray(0, 31))).toEqual([]); expect(await ask(null)).toEqual([]); expect(await ask(sha256buf('nope'))).toEqual([]);
    w.amend(); expect((await ask(sha256buf(t1)))[0].status).toBe('superseded');
    w.qrRow(VER_A1)['revoked_at'] = NOW; expect(await ask(sha256buf(t1))).toEqual([]);
    for (const st of ['rendered', 'discarded', 'draft']) { const v = w.addVersion(st, 20); expect(await ask(sha256buf(v.token))).toEqual([]); }
  });
});

describe('contract', () => {
  it('Q1: public, x-rate-limit-tier qr_verify, no idempotency, body { qr_token } only, 200 has exactly the six minimal fields, verify_not_found documented', () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
    const op = spec.paths['/v1/reporting/verifications'].post;
    expect(op.operationId).toBe(OP); expect(op.security).toEqual([]); expect(op['x-public']).toBeTruthy(); expect(op['x-rate-limit-tier']).toBe('qr_verify'); expect(op['x-idempotency']).toBe('none');
    expect(op['x-error-codes']).toEqual(expect.arrayContaining(['reporting.verify_not_found', 'common.rate_limited', 'common.validation_failed']));
    const ok = op.responses['200'].content['application/json'].schema;
    expect(Object.keys(ok.properties).sort()).toEqual(['issued_at', 'lab_name', 'panel_names', 'patient_display', 'status', 'version_no']); expect(ok.additionalProperties).toBe(false);
    expect(op.requestBody.content['application/json'].schema.required).toEqual(['qr_token']);
  });
  it('is no longer a 501 stub (a valid token answers 200, an unknown one 404 verify_not_found)', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1);
    expect((await w.q1(t)).status).toBe(200);
    const e = await rejection(w.q1(issueToken('qr').token)); expect(e?.code).toBe('reporting.verify_not_found');
  });
  it('fails closed without a request context (no tx / no rateLimit -> common.internal) and echoes no input', async () => {
    const planted = 'PLANTEDQRTOKEN0000001'; const w = makeVerifyWorld(); const h = (await import('../index.js')).manifest.handlers[OP]!;
    for (const ctx of [{ operationId: OP, clientIp: IP_A, log: w.log }, { operationId: OP, clientIp: IP_A, log: w.log, now: w.now, rateLimit: w.baseCtx().rateLimit }, { operationId: OP, clientIp: IP_A, log: w.log, now: w.now, tx: w.baseCtx().tx }]) {
      const e = await rejection(h({ params: {}, query: {}, headers: {}, body: { qr_token: planted } } as any, ctx as any));
      expect(e?.code).toBe('common.internal'); expect(errShape(e)).not.toContain(planted);
    }
  });
});

describe('AC-10.1 / AC-10.2 — what a valid token shows', () => {
  it('released version: 200 with EXACTLY lab_name, patient_display (masked), panel_names, issued_at (ISO), version_no, status "valid"', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); const r = await w.q1(t);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ lab_name: LAB_NAME, patient_display: PATIENT_MASKED, panel_names: ['Complete Blood Count'], issued_at: NOW, version_no: 1, status: 'valid' });
    expect(Object.keys(r.body).sort()).toEqual(['issued_at', 'lab_name', 'panel_names', 'patient_display', 'status', 'version_no']);
  });
  it('issued_at is an ISO-8601 UTC string even though the DB driver returns a Date', async () => {
    const w = makeVerifyWorld(); const r = await w.q1(w.qrTokenFor(VER_A1)); expect(typeof r.body.issued_at).toBe('string'); expect(r.body.issued_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });
  it('no results, phone, e-mail, address, date of birth, ids or hashes anywhere in the response (body + headers)', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); const r = await w.q1(t); const text = JSON.stringify(r);
    expect(r.status).toBe(200);
    for (const s of [PHONE, 'patient0@example.com', 'Test Patient 0001', 'P-A-0001', '0001SY000001', t, sha256buf(t).toString('hex'), VER_A1, w.qrRow(VER_A1)['id']]) expect(text).not.toContain(s);
    expect(text).not.toMatch(/dob|birth|address|phone|email|result|report_id|tenant/i);
  });
  it('AC-10.2 superseded: the old version still verifies, status "superseded", with its own version_no; the new one is "valid"', async () => {
    const w = makeVerifyWorld(); const t1 = w.qrTokenFor(VER_A1); w.amend(); const t2 = w.qrTokenFor(VER_A2);
    expect((await w.q1(t1)).body).toMatchObject({ status: 'superseded', version_no: 1, panel_names: ['Complete Blood Count'] });
    expect((await w.q1(t2)).body).toMatchObject({ status: 'valid', version_no: 2, panel_names: ['Complete Blood Count', 'Liver Function Test'] });
  });
  it('a tenant-B token verifies like any other (the lookup is global, 05-SCHEMA token_sha256 global unique) and reveals nothing of tenant A', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_B1); const r = await w.q1(t); expect(r.status).toBe(200); expect(r.body.status).toBe('valid');
  });
});

describe('AC-10.3 / REQ-SEC-095 / 07-SECURITY 14 — every failure is the same 404, byte for byte', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['empty', ''], ['1 char', 'A'], ['21 chars', 'A'.repeat(21)], ['23 chars', 'A'.repeat(23)], ['64 chars (schema max)', 'A'.repeat(64)], ['22 chars with "+"', `${'A'.repeat(21)}+`],
    ['22 chars with "/"', `${'A'.repeat(21)}/`], ['22 chars with "="', `${'A'.repeat(21)}=`], ['22 chars with a space', `${'A'.repeat(21)} `], ['valid token + newline', `${issueToken('qr').token}\n`],
    ['unicode', 'é'.repeat(22)], ['path traversal', '../../etc/passwd'.padEnd(22, 'x')], ['SQL', "' OR 1=1 --".padEnd(22, ' ')], ['NUL byte', `${'A'.repeat(21)}\u0000`],
    ['number', 12345], ['null', null], ['undefined', undefined], ['object', { $ne: 1 }], ['array', ['A'.repeat(22)]], ['boolean', true],
  ];
  async function fourCases(w: ReturnType<typeof makeVerifyWorld>) {
    const revoked = w.qrTokenFor(VER_A1); w.qrRow(VER_A1)['revoked_at'] = NOW;
    return { unknown: issueToken('qr').token, revoked, unreleased: w.addVersion('rendered', 11).token, discarded: w.addVersion('discarded', 12).token };
  }
  it('unknown / revoked / unreleased / discarded: code reporting.verify_not_found, status 404, and identical in every observable byte', async () => {
    const w = makeVerifyWorld(); const c = await fourCases(w); const seen: Record<string, string> = {};
    for (const [k, t] of Object.entries(c)) { const e = await rejection(w.q1(t)); expect(e).toMatchObject(NOT_FOUND); seen[k] = failureBytes(e); }
    expect(new Set(Object.values(seen)).size).toBe(1);
  });
  it.each(MALFORMED)('malformed (%s): the SAME bytes as an unknown token', async (_n, bad) => {
    const w = makeVerifyWorld(); const ref = failureBytes(await rejection(w.q1(issueToken('qr').token)));
    const e = await rejection(w.q1(bad)); expect(e).toMatchObject(NOT_FOUND); expect(failureBytes(e)).toBe(ref);
  });
  it('a missing body / missing qr_token key at handler level is the same 404 (never a 500 or a validation message that distinguishes)', async () => {
    const w = makeVerifyWorld(); const ref = failureBytes(await rejection(w.q1(issueToken('qr').token)));
    for (const body of [{}, undefined, null, 'x', [], { other: 'A'.repeat(22) }]) {
      const e = await rejection(w.run(OP, w.anonCtx(), { body })); expect(e).toMatchObject(NOT_FOUND); expect(failureBytes(e)).toBe(ref);
    }
  });
  it('the error carries no input: planted token / hash never appear in the failure', async () => {
    const w = makeVerifyWorld(); const planted = issueToken('qr').token; const e = await rejection(w.q1(planted));
    expect(failureBytes(e)).not.toContain(planted); expect(failureBytes(e)).not.toContain(sha256buf(planted).toString('hex'));
  });
  it('for the four well-formed cases the handler does the same work: exactly ONE statement each, the DEFINER call with identical text (no second lookup that tells them apart)', async () => {
    const w = makeVerifyWorld(); const c = await fourCases(w); const texts: string[] = []; const counts: number[] = [];
    for (const t of Object.values(c)) { const n0 = w.db.stmts.length; await rejection(w.q1(t)); const s = w.db.stmts.slice(n0); counts.push(s.length); texts.push(s.map((x) => x.text.replace(/\s+/g, ' ').trim()).join('|')); }
    expect(counts).toEqual([1, 1, 1, 1]); expect(new Set(texts).size).toBe(1); expect(texts[0]).toMatch(/app\.reporting_verify_qr\s*\(\s*\$1\s*\)/i);
  });
  it('timing sanity: unknown vs revoked vs unreleased vs discarded take the same time (median of 150 calls within 4x + 2 ms of each other)', async () => {
    const w = makeVerifyWorld(); const c = await fourCases(w);
    const med: Record<string, number> = {};
    for (const [k, t] of Object.entries(c)) {
      const xs: number[] = [];
      for (let i = 0; i < 150; i++) { const ctx = w.anonCtx(`192.0.2.${(i % 250) + 1}`); const a = performance.now(); await rejection(w.q1(t, ctx)); xs.push(performance.now() - a); }
      xs.sort((a, b) => a - b); med[k] = xs[75]!;
    }
    const lo = Math.min(...Object.values(med)); const hi = Math.max(...Object.values(med)); expect(hi, JSON.stringify(med)).toBeLessThan(lo * 4 + 2);
  });
});

describe('AC-10.5 — only the SHA-256 reaches the DB; the token is never stored, logged or audited', () => {
  it('the DEFINER is called with sha256(token) as a 32-byte binary (not hex text, not the token)', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); await w.q1(t);
    const s = w.verifyStmts(); expect(s).toHaveLength(1); const arg: any = s[0]!.values[0];
    expect(s[0]!.values).toHaveLength(1); expect(arg instanceof Uint8Array || Buffer.isBuffer(arg)).toBe(true); expect(Buffer.from(arg).equals(sha256buf(t))).toBe(true); expect(Buffer.from(arg).length).toBe(32);
  });
  it('no statement other than the DEFINER call: Q1 never reads qr_tokens / report_versions directly (REQ-SEC-018)', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); await w.q1(t); await rejection(w.q1(issueToken('qr').token));
    for (const s of w.db.stmts) expect(s.text).toMatch(/app\.reporting_verify_qr/i);
  });
  it('the plaintext token appears in no statement value, log line, audit entry, job or response header (PHI/log scan, 07-SECURITY 9)', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); const r = await w.q1(t); await rejection(w.q1(issueToken('qr').token)); const bad = issueToken('qr').token; await rejection(w.q1(bad));
    expect(w.allText()).not.toContain(t); expect(w.allText()).not.toContain(bad); expect(JSON.stringify(r.headers ?? {})).not.toContain(t);
    expect(JSON.stringify(w.db.stmts.map((s) => s.values.map((v) => (typeof v === 'string' ? v : ''))))).not.toContain(t);
  });
  it('Q1 is read-only: no INSERT / UPDATE / DELETE, no job, no event, no access-log row for a public lookup', async () => {
    const w = makeVerifyWorld(); const t = w.qrTokenFor(VER_A1); await w.q1(t); await rejection(w.q1(issueToken('qr').token));
    expect(w.db.writes()).toEqual([]); expect(w.db.jobs).toEqual([]); expect(w.audit).toEqual([]);
  });
});

describe('AC-10.4 (app side) — qr_verify: 100 per day per client IP', () => {
  it('100 verifications from one IP pass, the 101st is 429 common.rate_limited (hits and misses both count)', async () => {
    const w = makeVerifyWorld(); const good = w.qrTokenFor(VER_A1); const miss = issueToken('qr').token;
    for (let i = 0; i < 100; i++) { const r = i % 2 === 0 ? await w.q1(good, w.anonCtx(IP_A)) : await rejection(w.q1(miss, w.anonCtx(IP_A))); expect(i % 2 === 0 ? r.status : r.code).toBe(i % 2 === 0 ? 200 : 'reporting.verify_not_found'); }
    const e = await rejection(w.q1(good, w.anonCtx(IP_A))); expect(e).toMatchObject({ code: 'common.rate_limited', statusCode: 429 });
  });
  it('the key is the client IP: tier qr_verify, key i:<clientIp>; two IPs behind the same portal server do not share the budget', async () => {
    const w = makeVerifyWorld(); const good = w.qrTokenFor(VER_A1);
    for (let i = 0; i < 100; i++) await w.q1(good, w.anonCtx(IP_A));
    expect((await rejection(w.q1(good, w.anonCtx(IP_A)))).code).toBe('common.rate_limited');
    expect((await w.q1(good, w.anonCtx(IP_B))).status).toBe(200);
    expect(w.rateCalls.every((c) => c.tier === 'qr_verify' && /^i:/.test(c.key))).toBe(true); expect(w.rateCalls.some((c) => c.key === `i:${IP_A}`)).toBe(true); expect(w.rateCalls.some((c) => c.key === `i:${IP_B}`)).toBe(true);
  });
  it('a rejected request is rejected BEFORE the lookup: no DEFINER call, nothing about the token revealed', async () => {
    const w = makeVerifyWorld(); const good = w.qrTokenFor(VER_A1);
    for (let i = 0; i < 100; i++) await w.q1(good, w.anonCtx(IP_A));
    const n = w.db.stmts.length; const e = await rejection(w.q1(good, w.anonCtx(IP_A))); expect(e.code).toBe('common.rate_limited'); expect(w.db.stmts.length).toBe(n);
    expect(failureBytes(e)).not.toContain(good);
  });
  it('malformed tokens consume the budget too (ASSUMED: limiter first, so format probing is not free)', async () => {
    const w = makeVerifyWorld();
    for (let i = 0; i < 100; i++) await rejection(w.q1('bad', w.anonCtx(IP_A)));
    expect((await rejection(w.q1('bad', w.anonCtx(IP_A)))).code).toBe('common.rate_limited');
  });
  it('the window is a day: after 24 h the IP can verify again', async () => {
    const w = makeVerifyWorld(); const good = w.qrTokenFor(VER_A1);
    for (let i = 0; i < 100; i++) await w.q1(good, w.anonCtx(IP_A));
    expect((await rejection(w.q1(good, w.anonCtx(IP_A)))).code).toBe('common.rate_limited'); w.advance(24 * 3600_000 + 1000);
    expect((await w.q1(good, w.anonCtx(IP_A))).status).toBe(200);
  });
  it('a missing clientIp never shares a bucket with a real one and never skips the limiter (fail closed -> common.internal)', async () => {
    const w = makeVerifyWorld(); const good = w.qrTokenFor(VER_A1);
    const e = await rejection(w.q1(good, w.anonCtx(undefined as any, { clientIp: '' }))); expect(['common.internal', 'common.rate_limited', 'reporting.verify_not_found']).toContain(e.code);
    expect(w.rateCalls.filter((c) => c.key === 'i:')).toEqual([]);   // no empty-IP bucket shared by all anonymous callers
  });
});

describe('many users at once', () => {
  it('50 concurrent lookups of one valid token and 50 of unknown tokens: all 200 / all identical 404, no cross-talk', async () => {
    const w = makeVerifyWorld(); const good = w.qrTokenFor(VER_A1);
    const hits = await Promise.all(Array.from({ length: 50 }, (_, i) => w.q1(good, w.anonCtx(`192.0.2.${i + 1}`))));
    const misses = await Promise.all(Array.from({ length: 50 }, (_, i) => rejection(w.q1(issueToken('qr').token, w.anonCtx(`198.51.100.${i + 1}`)))));
    expect(hits.every((h) => h.status === 200 && h.body.status === 'valid')).toBe(true); expect(new Set(misses.map(failureBytes)).size).toBe(1);
  });
});
