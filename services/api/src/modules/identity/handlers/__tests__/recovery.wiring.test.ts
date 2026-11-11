// T9 wiring + static guards: the three operations are registered (no longer stubs), run in ONE identityAuthTx (08 A25 D-212), contain no SQL (repository owns it),
// never read a header for the client IP (P-61), follow the OpenAPI contract, and carry NO LIMS-side link-TTL fallback (08 A25 D-219: the <= 60 min TTL is GoTrue's).
// Expected now: fail (the three handlers are common.internal stubs; worker tasks/send_recovery.ts does not exist).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { COOKIE, REQ_ID, SYSTEM_ACTOR, rejection, sha256, tokenN } from './recovery.helpers.js';

const { manifest } = await import('../../index.js');
const MOD = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const OPS = ['requestPasswordRecovery', 'confirmEmailToken', 'setPasswordFromSetup'] as const;
const TASK = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'identity', 'tasks', 'send_recovery.ts');
const FILES = [...OPS.map((o) => join(MOD, 'handlers', `${o}.ts`)), TASK];
const src = (f: string) => readFileSync(f, 'utf8');

function hctx() {
  const txCalls: any[] = []; const tx = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async () => undefined) };
  const forbidden = (n: string) => () => { throw new Error(`T9 handlers must not use ctx.db.${n}`); }; const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = { operationId: 'x', clientIp: '203.0.113.9', requestId: REQ_ID, bffKey: 'staff_web', actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError: vi.fn(), rateLimit: { consume: vi.fn(async () => undefined) },
    db: { identityAuthTx: async (i: any, fn: any) => { txCalls.push(i); return fn(tx, { noRetry: () => undefined }); }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') } };
  return { ctx, tx, txCalls, log };
}
const GOOD = { requestPasswordRecovery: { email: 'ana.demo@example.test' }, confirmEmailToken: { token_hash: 'synthetic-hash', type: 'recovery' }, setPasswordFromSetup: { new_password: 'Zq7-correct-horse-battery-Lims!' } } as const;
const REQ = (op: (typeof OPS)[number], o: { body?: unknown; token?: string } = {}) => ({ params: {}, query: {}, body: o.body === undefined ? GOOD[op] : o.body, headers: o.token ? { cookie: `${COOKIE}=${o.token}`, 'user-agent': 'Firefox/130' } : { 'user-agent': 'Firefox/130' } });

describe('manifest: the three handlers are real (not the common.internal stub)', () => {
  it.each(OPS)('%s: a forged body (tenant_id / aal / state) is rejected with common.validation_failed BEFORE any identityAuthTx', async (op) => {
    const h = hctx(); const e = await rejection((manifest.handlers as any)[op](REQ(op, { body: { ...GOOD[op], tenant_id: 'x', aal: 'aal2', state: 'active' }, token: tokenN(1) }), h.ctx));
    expect(e.code).toBe('common.validation_failed'); expect(h.txCalls).toHaveLength(0);
  });
  it('setPasswordFromSetup: unknown session token -> 401 auth.session_expired through the REAL repo: one identityAuthTx { identity, setPasswordFromSetup }, DEFINER lookup with sha256(token), no write, no bindTenant', async () => {
    const h = hctx(); const t = tokenN(0x4321); const e = await rejection((manifest.handlers as any).setPasswordFromSetup(REQ('setPasswordFromSetup', { token: t }), h.ctx));
    expect(e.code).toBe('auth.session_expired'); expect(h.txCalls).toHaveLength(1); expect(h.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'setPasswordFromSetup', context: 'identity_auth' }, requestId: REQ_ID, clientIp: '203.0.113.9' });
    const q = h.tx.query.mock.calls as unknown as Array<[string, unknown[]]>; expect(q).toHaveLength(1); expect(q[0]![0]).toMatch(/app\.identity_session_by_token/); expect(Buffer.from(q[0]![1][0] as Buffer).equals(sha256(t))).toBe(true);
    expect(h.tx.bindTenant).not.toHaveBeenCalled(); expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain(t);
  });
  it('requestPasswordRecovery through the REAL wiring: 202 {}, one identityAuthTx, no tenant bound, the e-mail never logged', async () => {
    const h = hctx(); const r = await (manifest.handlers as any).requestPasswordRecovery(REQ('requestPasswordRecovery'), h.ctx);
    expect(r.status).toBe(202); expect(r.body).toEqual({}); expect(h.txCalls).toHaveLength(1); expect(h.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'requestPasswordRecovery', context: 'identity_auth' } });
    expect(h.tx.bindTenant).not.toHaveBeenCalled(); expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain(GOOD.requestPasswordRecovery.email);
  });
  it.each(OPS)('%s: client IP is ctx.clientIp, never a header (P-61)', async (op) => {
    const h = hctx(); const r: any = REQ(op, { token: tokenN(2) }); r.headers = { ...r.headers, 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.8.8.8', forwarded: 'for=10.7.7.7' };
    await rejection((manifest.handlers as any)[op](r, h.ctx)).catch(() => undefined); expect(JSON.stringify(h.txCalls)).not.toMatch(/10\.(9|8|7)\.\d\.\d/);
  });
});

describe('OpenAPI contract (contracts/openapi/identity.yaml, errors.yaml)', () => {
  const api: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const op = (id: string) => Object.values(api.paths as Record<string, any>).flatMap((p) => Object.values(p) as any[]).find((o) => o?.operationId === id);
  it('requestPasswordRecovery: public, identity_auth, idempotency none, login tier, 202', () => { const o = op('requestPasswordRecovery'); expect(o.security).toEqual([]); expect(o['x-context']).toBe('identity_auth'); expect(o['x-idempotency']).toBe('none'); expect(o['x-rate-limit-tier']).toBe('login'); expect(Object.keys(o.responses)).toContain('202'); });
  it('confirmEmailToken: public, identity_auth, error codes reset_token_invalid + invite_invalid, 200 LoginResult', () => { const o = op('confirmEmailToken'); expect(o.security).toEqual([]); expect(o['x-context']).toBe('identity_auth'); expect(o['x-error-codes']).toEqual(['auth.reset_token_invalid', 'auth.invite_invalid']); expect(o.responses['200']).toBeTruthy(); });
  it('setPasswordFromSetup: bffSession, identity_auth, policy error codes', () => { const o = op('setPasswordFromSetup'); expect(o.security).toEqual([{ bffSession: [] }]); expect(o['x-context']).toBe('identity_auth'); expect(o['x-error-codes']).toEqual(['auth.password_policy_violation', 'auth.password_breached']); });
  it('error codes exist with the HTTP status the tests rely on', () => {
    const by = new Map((parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number }>).map((c) => [c.code, c.http]));
    expect(by.get('auth.reset_token_invalid')).toBe(400); expect(by.get('auth.invite_invalid')).toBe(400); expect(by.get('auth.password_policy_violation')).toBe(422); expect(by.get('auth.password_breached')).toBe(422);
    expect(by.get('auth.session_expired')).toBe(401); expect(by.get('common.rate_limited')).toBe(429); expect(by.get('common.dependency_unavailable')).toBe(503); expect(by.get('common.validation_failed')).toBe(400);
  });
});

describe('static guards (P-61, D-212, D-219, 07-SECURITY s5 logging)', () => {
  it('the three handlers and the worker task exist', () => { for (const f of FILES) expect(existsSync(f), f).toBe(true); });
  it.each(FILES.map((f) => [f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'), f]))('%s: no X-Forwarded-For / x-real-ip read, no console.*', (_n, f) => {
    if (!existsSync(f)) return expect(existsSync(f)).toBe(true); expect(src(f)).not.toMatch(/x-forwarded-for|x-real-ip|\bforwarded\b/i); expect(src(f)).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
  it.each(OPS)('handlers/%s.ts: no SQL, no db.tx / requestTx / withTenantScope, uses identityAuthTx; bindTenant never fed from body/params/query/headers', (o) => {
    const f = join(MOD, 'handlers', `${o}.ts`); if (!existsSync(f)) return expect(existsSync(f)).toBe(true); const s = src(f);
    expect(s).not.toMatch(/\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+[\w.]*\s+SET|DELETE\s+FROM)\b/i); expect(s).not.toMatch(/\.(requestTx|withTenantScope)\b|db\.tx\b/); expect(s).toMatch(/identityAuthTx/); expect(s).not.toMatch(/bindTenant\([^)]*(body|params|query|headers)/);
  });
  it('requestPasswordRecovery is existence-blind: no GoTrue gateway, no loginContext / adminFindUser / session lookup in the HTTP path (the worker job decides)', () => {
    const f = join(MOD, 'handlers', 'requestPasswordRecovery.ts'); if (!existsSync(f)) return expect(existsSync(f)).toBe(true);
    expect(src(f)).not.toMatch(/adminFindUser|loginContext|sendRecovery|signInWithPassword|sessionByToken|createHttpGoTrueGateway/);
  });
  it('D-219: no LIMS-side link-TTL fallback anywhere in the identity module or worker task (no recovery_requests table, no LINK_TTL / OTP_EXP constant; the three handlers have no 3600 / 60*60 / recovery_sent_at arithmetic)', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : /\.(ts|sql)$/.test(n) && !/\.test\.|\.spec\./.test(n) && !/gotrue[\\/](gateway\.fake)/.test(p) ? [p] : []; });
    const hits = [...walk(join(MOD, 'handlers')), ...walk(join(MOD, 'service')), ...walk(join(MOD, 'repository')), TASK].filter((p) => existsSync(p) && /recovery_requests|LINK_TTL|MAILER_OTP_EXP|recovery_ttl|recoveryTtl/.test(src(p)));
    expect(hits).toEqual([]);
    for (const o of OPS) { const f = join(MOD, 'handlers', `${o}.ts`); if (existsSync(f)) expect(src(f), o).not.toMatch(/\b3600\b|60\s*\*\s*60\b|recovery_sent_at|invited_at|confirmation_sent_at/); }
  });
  it('release precondition (D-219 / A25.2): the local GoTrue config keeps the OTP / link expiry at <= 3600 s', () => {
    const toml = readFileSync(join(REPO_ROOT, 'supabase', 'config.toml'), 'utf8'); const m = toml.match(/^\s*otp_expiry\s*=\s*(\d+)/m); expect(m).not.toBeNull(); expect(Number(m![1])).toBeLessThanOrEqual(3600);
  });
});
