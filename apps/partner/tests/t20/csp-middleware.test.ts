// C13.T20 — nonce CSP from apps/partner/src/middleware.ts (REQ-SEC-088–092, 02-TRD §3.6). Report-only by default, enforced when PARTNER_CSP_ENFORCE=true.
// The middleware is imported and called directly with synthetic NextRequests (no server needed).
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const load = async () => (await import('../../src/middleware')) as { middleware: (r: NextRequest) => Response | Promise<Response> };
const call = async (path = '/orders') => (await load()).middleware(new NextRequest(`https://partner.test${path}`));
const parse = (policy: string) =>
  Object.fromEntries(policy.split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const [k, ...v] = s.split(/\s+/); return [k, v]; })) as Record<string, string[]>;
const cspOf = (res: Response) => res.headers.get('content-security-policy') ?? res.headers.get('content-security-policy-report-only') ?? '';
const nonceOf = (policy: string) => /'nonce-([^']+)'/.exec(policy)?.[1];

afterEach(() => { delete process.env.PARTNER_CSP_ENFORCE; });

describe('root layout renders per request (nonce needs dynamic render)', () => {
  // Prerendered pages get no nonce; with 'strict-dynamic' every script on them is blocked once CSP is enforced.
  it("layout.tsx exports dynamic = 'force-dynamic'", async () => {
    const layout = (await import('../../src/app/layout')) as { dynamic?: string };
    expect(layout.dynamic).toBe('force-dynamic');
  });
});

describe('middleware CSP', () => {
  it('exports middleware() (and a matcher that skips hashed static assets, sw.js, manifest)', async () => {
    const m = (await load()) as { middleware?: unknown; config?: { matcher?: unknown } };
    expect(typeof m.middleware).toBe('function');
    expect(JSON.stringify(m.config?.matcher ?? '')).toMatch(/_next\/static/);
  });

  it('report-only by default: Content-Security-Policy-Report-Only set, enforced header absent', async () => {
    const res = await call();
    expect(res.headers.get('content-security-policy-report-only')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('PARTNER_CSP_ENFORCE=true switches to the enforced header only', async () => {
    process.env.PARTNER_CSP_ENFORCE = 'true';
    const res = await call();
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
  });

  it.each([undefined, 'true'])('script-src carries a per-request nonce + strict-dynamic, no unsafe-eval/unsafe-inline (enforce=%s)', async (flag) => {
    if (flag) process.env.PARTNER_CSP_ENFORCE = flag;
    const policy = cspOf(await call('/orders/o-1'));
    const script = parse(policy)['script-src'] ?? [];
    expect(script).toContain("'self'");
    expect(script).toContain("'strict-dynamic'");
    expect(script.some((s) => /^'nonce-[A-Za-z0-9+/=_-]{16,}'$/.test(s)), 'a nonce of >= 16 chars').toBe(true);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
  });

  it('two requests get different nonces; the nonce is forwarded to Next as the x-nonce request header', async () => {
    const a = await call('/orders');
    const b = await call('/orders');
    const na = nonceOf(cspOf(a));
    const nb = nonceOf(cspOf(b));
    expect(na).toBeTruthy();
    expect(nb).toBeTruthy();
    expect(na).not.toBe(nb);
    // NextResponse.next({ request: { headers } }) exposes forwarded request headers as x-middleware-request-*.
    expect(a.headers.get('x-middleware-request-x-nonce')).toBe(na);
    expect(b.headers.get('x-middleware-request-x-nonce')).toBe(nb);
  });

  it('a client-supplied x-nonce header is not trusted', async () => {
    const res = await (await load()).middleware(new NextRequest('https://partner.test/orders', { headers: { 'x-nonce': 'attacker-chosen-nonce-value' } }));
    expect(cspOf(res)).not.toContain('attacker-chosen-nonce-value');
    expect(res.headers.get('x-middleware-request-x-nonce')).not.toBe('attacker-chosen-nonce-value');
  });

  it.each(['/', '/orders/o-1', '/auth/login', '/offline'])('other directives hold on %s: worker/manifest self, object none, frame-ancestors none, no remote origins', async (p) => {
    const policy = cspOf(await call(p));
    const d = parse(policy);
    expect(d['default-src']).toContain("'self'");
    expect(d['worker-src']).toEqual(["'self'"]);
    expect(d['manifest-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toContain("'self'");
    expect(policy.replace(/report-(uri|to)[^;]*/g, '')).not.toMatch(/https?:\/\/|\*/);
  });
});
