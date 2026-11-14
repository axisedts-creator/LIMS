// T8 wiring + static guards: resolveSession / logoutSession are registered (no longer stubs), run in ONE identityAuthTx each (08 A25 D-212), look the session up through the DEFINER
// app.identity_session_by_token with sha256(cookie token), never read a header for the client IP (P-61), keep SQL out of handlers and service, and follow the OpenAPI contract.
// Expected now: fail (both handlers are common.internal stubs; handlers/resolveSession.ts, handlers/logoutSession.ts, service/session.service.ts do not exist).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { COOKIE, REQ_ID, SYSTEM_ACTOR, rejection, sha256, tokenN } from './session.helpers.js';

const { manifest } = await import('../../index.js');
const MOD = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const OPS = ['resolveSession', 'logoutSession'] as const;
const FILES = [...OPS.map((o) => join(MOD, 'handlers', `${o}.ts`)), join(MOD, 'service', 'session.service.ts')];
const src = (f: string) => readFileSync(f, 'utf8');

function hctx() {
  const txCalls: any[] = []; const tx = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async () => undefined) };
  const forbidden = (n: string) => () => { throw new Error(`session handlers must not use ctx.db.${n}`); };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = { operationId: 'x', clientIp: '203.0.113.9', requestId: REQ_ID, bffKey: 'staff_web', actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError: vi.fn(),
    db: { identityAuthTx: async (i: any, fn: any) => { txCalls.push(i); return fn(tx, { noRetry: () => undefined }); }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') } };
  return { ctx, tx, txCalls, log };
}
const REQ = (o: { body?: unknown; token?: string } = {}) => ({ params: {}, query: {}, body: 'body' in o ? o.body : { touch: true }, headers: o.token ? { cookie: `${COOKIE}=${o.token}`, 'user-agent': 'Firefox/130' } : {} });

describe('manifest: both handlers are real (not the common.internal stub)', () => {
  it('resolveSession: a forged / malformed body is rejected with common.validation_failed BEFORE any identityAuthTx', async () => {
    for (const body of [{ touch: true, tenant_id: 'x' }, { touch: 'true' }, {}]) {
      const h = hctx(); const e = await rejection((manifest.handlers as any).resolveSession(REQ({ body, token: tokenN(1) }), h.ctx));
      expect(e.code).toBe('common.validation_failed'); expect(h.txCalls).toHaveLength(0);
    }
  });
  it.each(OPS)('%s: unknown session token -> 401 auth.session_expired through the REAL repo: exactly one identityAuthTx { identity, <op> }, DEFINER lookup with sha256(token), no write', async (op) => {
    const h = hctx(); const t = tokenN(0x1234); const e = await rejection((manifest.handlers as any)[op](REQ({ token: t }), h.ctx));
    expect(e.code).toBe('auth.session_expired'); expect(String(e.message)).not.toMatch(/not implemented/);
    expect(h.txCalls).toHaveLength(1); expect(h.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: op, context: 'identity_auth' }, requestId: REQ_ID, clientIp: '203.0.113.9' });
    const q = h.tx.query.mock.calls as unknown as Array<[string, unknown[]]>; expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q[0]![0]).toMatch(/app\.identity_session_by_token/); expect(Buffer.from(q[0]![1][0] as Buffer).equals(sha256(t))).toBe(true);
    for (const [sql] of q) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(h.tx.bindTenant).not.toHaveBeenCalled(); expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain(t);
  });
  it.each(OPS)('%s: client IP is ctx.clientIp, never a header (P-61)', async (op) => {
    const h = hctx(); const r: any = REQ({ token: tokenN(2) }); r.headers = { ...r.headers, 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.8.8.8', forwarded: 'for=10.7.7.7' };
    const e = await rejection((manifest.handlers as any)[op](r, h.ctx)); expect(e.code).toBe('auth.session_expired'); expect(JSON.stringify(h.txCalls)).not.toMatch(/10\.(9|8|7)\.\d\.\d/);
  });
});

describe('OpenAPI contract of the two operations (contracts/openapi/identity.yaml)', () => {
  const api: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const op = (id: string) => Object.values(api.paths as Record<string, any>).flatMap((p) => Object.values(p) as any[]).find((o) => o?.operationId === id);
  it.each(OPS)('%s: bffSession, x-context identity_auth, x-idempotency none, general rate tier', (id) => {
    const o = op(id); expect(o.security).toEqual([{ bffSession: [] }]); expect(o['x-context']).toBe('identity_auth'); expect(o['x-idempotency']).toBe('none'); expect(o['x-rate-limit-tier']).toBe('general');
  });
  it('resolveSession declares exactly 401/403 codes the tests use; logoutSession answers 204', () => {
    expect(op('resolveSession')['x-error-codes']).toEqual(['auth.session_expired', 'auth.account_locked', 'identity.tenant_suspended']); expect(Object.keys(op('logoutSession').responses)).toContain('204');
  });
  it('error codes the tests rely on exist in contracts/errors.yaml with the expected status', () => {
    const codes = (parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number }>); const by = new Map(codes.map((c) => [c.code, c.http]));
    expect(by.get('auth.session_expired')).toBe(401); expect(by.get('auth.account_locked')).toBe(403); expect(by.get('identity.tenant_suspended')).toBe(403);
    expect(by.get('common.dependency_unavailable')).toBe(503); expect(by.get('common.validation_failed')).toBe(400); expect(by.get('common.internal')).toBe(500);
  });
});

describe('static guards on the three T8 files (P-61, D-212, 07-SECURITY s5 logging rules)', () => {
  it('all three files exist', () => { for (const f of FILES) expect(existsSync(f), f).toBe(true); });
  it.each(FILES.map((f) => [f.slice(MOD.length + 1).replace(/\\/g, '/'), f]))('%s: no X-Forwarded-For / x-real-ip read, no console.*, no secret env beyond the touch/refresh knobs', (_n, f) => {
    if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
    expect(s).not.toMatch(/x-forwarded-for|x-real-ip|\bforwarded\b/i); expect(s).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(s).not.toMatch(/process\.env\[?\.?['"]?LIMS_IDENTITY_(TOKEN_ENC|EMAIL_HMAC|GOTRUE_SERVICE)/);
  });
  it.each(OPS)('handlers/%s.ts and service/session.service.ts contain no SQL and no db.tx / requestTx / withTenantScope (the repo owns SQL; pre-auth ops use identityAuthTx only)', (o) => {
    for (const f of [join(MOD, 'handlers', `${o}.ts`), join(MOD, 'service', 'session.service.ts')]) {
      if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
      expect(s).not.toMatch(/\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+[\w.]*\s+SET|DELETE\s+FROM)\b/i); expect(s).not.toMatch(/\.(requestTx|withTenantScope)\b|db\.tx\b/);
    }
    const h = join(MOD, 'handlers', `${o}.ts`); const sv = join(MOD, 'service', 'session.service.ts');   // the one identityAuthTx call may live in the handler or the service
    expect((existsSync(h) ? src(h) : '') + (existsSync(sv) ? src(sv) : '')).toMatch(/identityAuthTx/);
  });
  it('bindTenant is never called with a value read from the request (body / params / query / headers)', () => {
    for (const f of FILES) { if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/bindTenant\([^)]*(body|params|query|headers)/); }
  });
  it('the touch interval and refresh window are the 02-TRD s11/s12 constants (60 s / 120 s), not invented values', () => {
    const f = FILES[2]!; if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
    expect(s).toMatch(/LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS|\b60(_000)?\b/); expect(s).toMatch(/\b120(_000)?\b/);
  });
  it('the refresh token / access token are never interpolated into a log call or an Error message', () => {
    for (const f of FILES) { if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/(log|logger)\??\.(info|warn|error|debug)\([^)]*(refreshToken|accessToken|token)/i); expect(src(f)).not.toMatch(/new (Lims)?Error\([^)]*\$\{[^}]*(refreshToken|accessToken)/); }
  });
});
