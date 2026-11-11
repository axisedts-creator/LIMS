// T7 wiring + static guards: the three operations are registered (no longer stubs), run in ONE identityAuthTx each (08 A25 D-212), look the session up through the DEFINER
// app.identity_session_by_token with sha256(cookie token), never read a header for the client IP (P-61), contain no SQL (repository/mfa.repo.ts owns it), and follow the OpenAPI contract.
// Expected now: fail (the three handlers are common.internal stubs; repository/mfa.repo.ts does not exist).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { COOKIE, REQ_ID, SYSTEM_ACTOR, rejection, sha256, tokenN } from './mfa.helpers.js';

const { manifest } = await import('../../index.js');
const MOD = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const OPS = ['verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment'] as const;
const FILES = [...OPS.map((o) => join(MOD, 'handlers', `${o}.ts`)), join(MOD, 'repository', 'mfa.repo.ts')];
const src = (f: string) => readFileSync(f, 'utf8');

function hctx() {
  const txCalls: any[] = []; const tx = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async () => undefined) };
  const forbidden = (n: string) => () => { throw new Error(`MFA handlers must not use ctx.db.${n}`); };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = { operationId: 'x', clientIp: '203.0.113.9', requestId: REQ_ID, bffKey: 'staff_web', actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError: vi.fn(), rateLimit: { consume: vi.fn(async () => undefined) },
    db: { identityAuthTx: async (i: any, fn: any) => { txCalls.push(i); return fn(tx, { noRetry: () => undefined }); }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') } };
  return { ctx, tx, txCalls, log };
}
const REQ = (op: string, o: { body?: unknown; token?: string } = {}) => ({ params: op === 'completeMfaEnrolment' ? { factor_id: '0190a000-0000-7000-8000-0000000000f1' } : {}, query: {}, body: op === 'verifyMfaChallenge' || op === 'completeMfaEnrolment' ? { code: '123456' } : {},
  headers: o.token ? { cookie: `${COOKIE}=${o.token}`, 'user-agent': 'Firefox/130' } : {}, ...(o.body !== undefined ? { body: o.body } : {}) });

describe('manifest: the three handlers are real (not the common.internal stub)', () => {
  it.each(OPS)('%s: a forged body is rejected with common.validation_failed BEFORE any identityAuthTx', async (op) => {
    const h = hctx(); const e = await rejection((manifest.handlers as any)[op](REQ(op, { body: { code: '123456', tenant_id: 'x', aal: 'aal2' }, token: tokenN(1) }), h.ctx));
    expect(e.code).toBe('common.validation_failed'); expect(h.txCalls).toHaveLength(0);
  });
  it.each(OPS)('%s: unknown session token -> 401 auth.session_expired through the REAL repo: exactly one identityAuthTx { identity, <op> }, DEFINER lookup with sha256(token), no write', async (op) => {
    const h = hctx(); const t = tokenN(0x1234); const e = await rejection((manifest.handlers as any)[op](REQ(op, { token: t }), h.ctx));
    expect(e.code).toBe('auth.session_expired'); expect(h.txCalls).toHaveLength(1); expect(h.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: op, context: 'identity_auth' }, requestId: REQ_ID, clientIp: '203.0.113.9' });
    const q = h.tx.query.mock.calls as unknown as Array<[string, unknown[]]>; expect(q).toHaveLength(1);
    expect(q[0]![0]).toMatch(/app\.identity_session_by_token/); expect(Buffer.from(q[0]![1][0] as Buffer).equals(sha256(t))).toBe(true);
    expect(h.tx.bindTenant).not.toHaveBeenCalled(); expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain(t);
  });
  it.each(OPS)('%s: client IP is ctx.clientIp, never a header (P-61)', async (op) => {
    const h = hctx(); const r: any = REQ(op, { token: tokenN(2) }); r.headers = { ...r.headers, 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.8.8.8', forwarded: 'for=10.7.7.7' };
    await rejection((manifest.handlers as any)[op](r, h.ctx)); expect(JSON.stringify(h.txCalls)).not.toMatch(/10\.(9|8|7)\.\d\.\d/);
  });
});

describe('OpenAPI contract of the three operations (contracts/openapi/identity.yaml)', () => {
  const api: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const op = (id: string) => Object.values(api.paths as Record<string, any>).flatMap((p) => Object.values(p) as any[]).find((o) => o?.operationId === id);
  it.each(OPS)('%s: bffSession, x-context identity_auth, x-idempotency none, login rate tier', (id) => {
    const o = op(id); expect(o.security).toEqual([{ bffSession: [] }]); expect(o['x-context']).toBe('identity_auth'); expect(o['x-idempotency']).toBe('none'); expect(o['x-rate-limit-tier']).toBe('login');
  });
  it('error codes the tests rely on exist in contracts/errors.yaml', () => {
    const codes = (parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number }>); const by = new Map(codes.map((c) => [c.code, c.http]));
    expect(by.get('auth.mfa_invalid')).toBe(401); expect(by.get('auth.session_expired')).toBe(401); expect(by.get('common.version_conflict')).toBe(409); expect(by.get('common.not_found')).toBe(404);
    expect(by.get('common.dependency_unavailable')).toBe(503); expect(by.get('common.validation_failed')).toBe(400);
  });
});

describe('static guards on the four T7 files (P-61, D-212, 07-SECURITY s5 logging rules)', () => {
  it('all four files exist', () => { for (const f of FILES) expect(existsSync(f), f).toBe(true); });
  it.each(FILES.map((f) => [f.slice(MOD.length + 1).replace(/\\/g, '/'), f]))('%s: no X-Forwarded-For / x-real-ip read, no console.*, no process.env of secrets in handlers', (_n, f) => {
    if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
    expect(s).not.toMatch(/x-forwarded-for|x-real-ip|\bforwarded\b/i); expect(s).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
  it.each(OPS)('handlers/%s.ts contains no SQL and no db.tx / requestTx / withTenantScope (the repo owns SQL; pre-auth ops use identityAuthTx only)', (o) => {
    const f = join(MOD, 'handlers', `${o}.ts`); if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
    expect(s).not.toMatch(/\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+[\w.]*\s+SET|DELETE\s+FROM)\b/i); expect(s).not.toMatch(/\.(requestTx|withTenantScope)\b|db\.tx\b/); expect(s).toMatch(/identityAuthTx/);
  });
  it('handlers call tx.bindTenant only after the lookup, never with a value read from the request body/params (no `bindTenant(` argument naming body/params/query/headers)', () => {
    for (const o of OPS) { const f = join(MOD, 'handlers', `${o}.ts`); if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/bindTenant\([^)]*(body|params|query|headers)/); }
  });
  it('the repo never writes core.memberships.is_active (generated column, AU-T18) and never interpolates values into SQL text', () => {
    const f = join(MOD, 'repository', 'mfa.repo.ts'); if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
    expect(s).not.toMatch(/\bis_active\s*=\s*(true|false|\$)/i); expect(s).not.toMatch(/(query|sql)\s*\(\s*`[^`]*\$\{/i);
  });
  it('no module-local OTP maths in the handlers: the code is only ever passed to GoTrue (mfaChallengeAndVerify); no createHmac(sha1) / TOTP generator in services/**/identity (non-test)', () => {
    for (const f of FILES) { if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/createHmac\(\s*['"]sha1|base32Decode|hotp/i); }
  });
});
