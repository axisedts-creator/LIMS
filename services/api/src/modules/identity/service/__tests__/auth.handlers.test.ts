// T6 HTTP wiring of loginStaff (02-TRD s5.1, contracts/openapi/identity.yaml, 08 A25 D-212 / P-61) + static guards on the four T6 files.
// The SERVICE is mocked (behaviour: auth.service.test.ts): these tests fix req -> service input mapping, the identityAuthTx envelope, ctx plumbing, forged-body rejection,
// logging hygiene and the OpenAPI contract. ASSUMED: the handler reads ctx.{db.identityAuthTx, commitOnError, clientIp, requestId, bffKey, actor, log} and passes
// { tx, actor, requestId, clientIp, userAgent, bffKey, now, commitOnError, log } to the service (auth.helpers.ts header). Expected now: fail (loginStaff is still the common.internal stub).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { PASSWORD, REQ_ID, SYSTEM_ACTOR, rejection } from './auth.helpers.js';

const svc = { loginStaff: vi.fn() };
vi.mock('../auth.service.js', () => ({ createAuthService: () => svc }));
const { manifest } = await import('../../index.js');
const handler: any = (manifest.handlers as any)['loginStaff'];
const MOD = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');

const noop = () => undefined;
function makeHctx(o: Record<string, unknown> = {}) {
  const txCalls: any[] = []; const tx = { __tx: 'identityAuthTx', query: vi.fn(async () => ({ rows: [] })), bindTenant: vi.fn(async () => undefined) };
  const forbidden = (n: string) => () => { throw new Error(`loginStaff must not use ctx.db.${n}`); };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = { operationId: 'loginStaff', clientIp: '203.0.113.9', requestId: REQ_ID, bffKey: 'staff_web', actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError: vi.fn(),
    rateLimit: { consume: vi.fn(async () => undefined) },
    db: { identityAuthTx: async (input: any, fn: any) => { txCalls.push(input); return fn(tx, { noRetry: noop }); }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') }, ...o };
  return { ctx, tx, txCalls, log };
}
const req = (o: { body?: unknown; headers?: Record<string, string> } = {}) => ({ params: {}, query: {}, headers: {}, body: { email: 'ana.demo@example.test', password: PASSWORD }, ...o });
const sctx = () => svc.loginStaff.mock.calls[0]![0];
beforeEach(() => { svc.loginStaff.mockReset(); svc.loginStaff.mockResolvedValue({ status: 200, body: { session_token: 'T'.repeat(43), session: { session_id: REQ_ID } } }); });

describe('loginStaff handler is no longer a stub', () => {
  it('200 passthrough of the service body; no Set-Cookie (the BFF sets __Host-lims_sid), no token headers', async () => {
    const { ctx } = makeHctx(); const r = await handler(req(), ctx);
    expect(r.status).toBe(200); expect(r.body).toEqual({ session_token: 'T'.repeat(43), session: { session_id: REQ_ID } });
    expect(Object.keys(r.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('set-cookie');
  });
  it('opens exactly ONE ctx.db.identityAuthTx { operation: identity/loginStaff, requestId, clientIp = ctx.clientIp } and never tx / requestTx / withTenantScope (D-212)', async () => {
    const { ctx, txCalls } = makeHctx(); await handler(req(), ctx);
    expect(txCalls).toHaveLength(1); expect(txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'loginStaff' }, requestId: REQ_ID, clientIp: '203.0.113.9' });
  });
});

describe('ctx plumbing into the service', () => {
  it('service ctx: the identityAuthTx tx, the C0 clientIp (never a header), requestId, bffKey, actor, working commitOnError', async () => {
    const { ctx, tx } = makeHctx(); await handler(req({ headers: { 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.8.8.8', forwarded: 'for=10.7.7.7', 'user-agent': 'Firefox/130' } }), ctx);
    const c = sctx(); expect(c.tx).toBe(tx); expect(c.clientIp).toBe('203.0.113.9'); expect(c.requestId).toBe(REQ_ID); expect(c.bffKey).toBe('staff_web'); expect(c.actor).toMatchObject({ type: 'system', id: SYSTEM_ACTOR });
    expect(c.userAgent).toBe('Firefox/130'); expect(JSON.stringify(c)).not.toMatch(/10\.(9|8|7)\.\d\.\d/);
    expect(typeof c.now()?.getTime()).toBe('number'); c.commitOnError(); expect(ctx.commitOnError).toHaveBeenCalledTimes(1);
  });
  it('service input is exactly { email, password } from the body', async () => {
    const { ctx } = makeHctx(); await handler(req({ body: { email: 'ana.demo@example.test', password: PASSWORD } }), ctx);
    expect(svc.loginStaff.mock.calls[0]![1]).toEqual({ email: 'ana.demo@example.test', password: PASSWORD });
  });
  it('the partner BFF key is forwarded so the service can refuse it (AU-T14)', async () => {
    const { ctx } = makeHctx({ bffKey: 'partner' }); await handler(req(), ctx); expect(sctx().bffKey).toBe('partner');
  });
});

describe('probe: forged / malformed body is rejected before any transaction or GoTrue call', () => {
  it.each([
    [{ email: 'a@example.test', password: 'p', tenant_id: '0190a000-0000-7000-8000-0000000000a2' }],
    [{ email: 'a@example.test', password: 'p', membership_id: '0190a000-0000-7000-8000-0000000000b2' }],
    [{ email: 'a@example.test', password: 'p', kind: 'platform' }], [{ email: 'a@example.test', password: 'p', actor_type: 'system' }],
    [{ email: 'a@example.test', password: 'p', client_ip: '10.0.0.1' }], [{ email: 'a@example.test', password: 'p', is_admin: true }],
    [{ email: 'a@example.test' }], [{ password: 'p' }], [{ email: 5, password: 'p' }], [{ email: 'a@example.test', password: ['p'] }], [{ email: 'a@example.test', password: '' }],
    [{ email: 'a@example.test', password: 'p'.repeat(129) }], ['x'], [null], [undefined], [[]],
  ])('body %j -> common.validation_failed; no identityAuthTx, no service call', async (body) => {
    const { ctx, txCalls } = makeHctx(); const e = await rejection(handler(req({ body }), ctx));
    expect(e.code).toBe('common.validation_failed'); expect(txCalls).toHaveLength(0); expect(svc.loginStaff).not.toHaveBeenCalled();
  });
  it('the validation error does not echo the submitted password', async () => {
    const { ctx } = makeHctx(); const e = await rejection(handler(req({ body: { email: 5, password: PASSWORD } }), ctx)); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail, f: e.errors })).not.toContain(PASSWORD);
  });
});

describe('errors and logging', () => {
  it('service errors propagate unchanged (same code, same Retry-After); the password is in no log line and no error text', async () => {
    const lim = Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 42 }); svc.loginStaff.mockRejectedValueOnce(lim);
    const { ctx, log } = makeHctx(); const e = await rejection(handler(req(), ctx));
    expect(e).toBe(lim); expect(e.retryAfterSeconds).toBe(42);
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, e.message, e.detail])).not.toContain(PASSWORD);
  });
  it.each(['auth.login_failed', 'auth.step_up_required', 'auth.account_locked', 'identity.membership_inactive', 'identity.tenant_suspended', 'identity.platform_ip_denied'])('%s is passed through (the 6 documented error codes of loginStaff)', async (code) => {
    svc.loginStaff.mockRejectedValueOnce(new LimsError(code)); const { ctx } = makeHctx(); expect((await rejection(handler(req(), ctx))).code).toBe(code);
  });
  it('an unexpected service crash does not leak the password or the e-mail', async () => {
    svc.loginStaff.mockRejectedValueOnce(new Error(`boom ${PASSWORD} ana.demo@example.test`)); const { ctx, log } = makeHctx();
    await rejection(handler(req(), ctx)); expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain(PASSWORD);
  });
});

describe('contract (contracts/openapi/identity.yaml)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const op = doc.paths['/v1/identity/auth/login'].post;
  it('D-202: x-idempotency none (no key row for a 2xx or a 4xx), no Idempotency-Key parameter, public pre-auth, login rate tier, identity_auth context', () => {
    expect(op.operationId).toBe('loginStaff'); expect(op['x-idempotency']).toBe('none'); expect(JSON.stringify(op.parameters ?? [])).not.toMatch(/Idempotency-Key/i);
    expect(op.security).toEqual([]); expect(op['x-rate-limit-tier']).toBe('login'); expect(op['x-context']).toBe('identity_auth');
  });
  it('LoginRequest is closed (additionalProperties false) with only email + password, password 1-128, email <= 254', () => {
    const s = doc.components.schemas.LoginRequest; expect(s.additionalProperties).toBe(false); expect(Object.keys(s.properties).sort()).toEqual(['email', 'password']);
    expect(s.properties.password).toMatchObject({ minLength: 1, maxLength: 128 }); expect(s.properties.email.maxLength).toBeLessThanOrEqual(254);
  });
});

describe('static guards on the T6 files (P-61, D-212, P-42, rate-limit seam)', () => {
  const files = ['service/auth.service.ts', 'handlers/loginStaff.ts', 'repository/auth-events.repo.ts', 'repository/breached.repo.ts'];
  const src = (f: string) => (existsSync(join(MOD, f)) ? readFileSync(join(MOD, f), 'utf8') : '');
  const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('all four files exist and handlers/index.ts wires ./loginStaff.js', () => {
    for (const f of files) expect(existsSync(join(MOD, f)), f).toBe(true);
    expect(src('handlers/index.ts')).toMatch(/from '\.\/loginStaff\.js'/);
  });
  it('P-61 / AU-T2c: no file reads X-Forwarded-For / Forwarded / X-Real-IP / socket address - the client IP is ctx.clientIp only', () => {
    for (const f of files) { expect(code(f), f).not.toMatch(/x-forwarded-for|x-real-ip|['"]forwarded['"]|remoteAddress|req\.ip\b/i); }
    expect(code('handlers/loginStaff.ts') + code('service/auth.service.ts')).toMatch(/clientIp/);
  });
  it('D-212: the handler uses ctx.db.identityAuthTx; the service binds the tenant with tx.bindTenant and calls ctx.commitOnError', () => {
    expect(code('handlers/loginStaff.ts')).toMatch(/identityAuthTx/); expect(code('handlers/loginStaff.ts')).not.toMatch(/\.db\.(tx|requestTx|withTenantScope)\b/);
    expect(code('service/auth.service.ts')).toMatch(/bindTenant/); expect(code('service/auth.service.ts')).toMatch(/commitOnError/);
  });
  it('rate limits go through C0 ctx.rateLimit.consume with the login tier and the a: / f: key prefixes (02-TRD s4 item 11)', () => {
    const all = files.map(code).join('\n'); expect(all).toMatch(/rateLimit\??\.consume\s*\(\s*['"]login['"]/); expect(all).toMatch(/['"`]a:/); expect(all).toMatch(/['"`]f:/);
  });
  it('the service holds no SQL and the repos never interpolate values into SQL (template literals with ${} inside SQL text)', () => {
    expect(code('service/auth.service.ts')).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\.\w+\s+SET|SELECT\s+.+\s+FROM)\b/i);
    for (const f of ['repository/auth-events.repo.ts', 'repository/breached.repo.ts']) expect(code(f).length, f).toBeGreaterThan(0);
    for (const f of ['repository/auth-events.repo.ts', 'repository/breached.repo.ts']) expect(code(f), f).not.toMatch(/`[^`]*\b(INSERT|SELECT|UPDATE)\b[^`]*\$\{/i);
  });
  it('the password is never logged or stored: no console.*, no log call mentioning password / the raw e-mail', () => {
    for (const f of files) { expect(code(f).length, f).toBeGreaterThan(0); expect(code(f), f).not.toMatch(/console\./); expect(code(f), f).not.toMatch(/log\w*\.\w+\([^)]*\bpassword\b/i); }
  });
  it('identity.notify_ip_throttle and identity.gotrue_signout are the enqueued task identifiers (no invented task names)', () => {
    const s = code('service/auth.service.ts'); expect(s).toMatch(/['"]identity\.notify_ip_throttle['"]/); expect(s).toMatch(/['"]identity\.gotrue_signout['"]/);
  });
});
