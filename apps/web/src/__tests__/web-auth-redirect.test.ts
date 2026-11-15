// WEB-AUTH-REDIRECT-1 (LD-200, 2026-11-15; CR-C1-WEB-STYLE-1 option 3; AC-0D-7.2 read as the real sign-in screen; REQ-SEC-068).
// Behavioural tests of src/middleware.ts with a stubbed session resolver. No network, no build.
// Run: .orchestra/notes/WEB-AUTH-REDIRECT-1-verify.cmd
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('../core/session/provider', () => ({ getSessionResolver: async () => ({ resolve: resolveMock }) }));

import { middleware } from '../middleware';

const ORIGIN = 'http://localhost:3000';
const SID = 'sid-synthetic-0123456789';
const COOKIE = `__Host-lims_sid=${SID}`;
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const req = (path: string, init: { accept?: string | null; cookie?: string; method?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.accept !== null) headers.accept = init.accept ?? HTML;
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers });
};

const unauthResolution = (code: 'auth.session_expired' | 'auth.unauthenticated') => ({
  ok: false as const,
  status: 401,
  problem: { type: `urn:lims:error:${code}`, title: code, status: 401, code },
});

/** The Location header resolved against the request origin, as a browser would. */
const target = (res: Response) => new URL(res.headers.get('location') ?? '', ORIGIN);

beforeEach(() => {
  resolveMock.mockReset();
  resolveMock.mockResolvedValue(unauthResolution('auth.unauthenticated'));
});

describe('WEB-AUTH-REDIRECT-1 document requests without a session get a 307 (AC-0D-7.2, LD-200)', () => {
  it('no cookie → 307 to /auth/login (missing)', async () => {
    const res = await middleware(req('/'));
    expect(res.status).toBe(307);
    const t = target(res);
    expect(t.origin).toBe(ORIGIN);
    expect(t.pathname).toBe('/auth/login');
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('resolver says auth.session_expired → 307 to /auth/session-expired (expired)', async () => {
    resolveMock.mockResolvedValue(unauthResolution('auth.session_expired'));
    const res = await middleware(req('/specimens', { cookie: COOKIE }));
    expect(res.status).toBe(307);
    expect(target(res).origin).toBe(ORIGIN);
    expect(target(res).pathname).toBe('/auth/session-expired');
  });

  it('resolver 401 with another code (unknown/revoked session) → 307 to /auth/login', async () => {
    const res = await middleware(req('/specimens', { cookie: COOKIE }));
    expect(res.status).toBe(307);
    expect(target(res).pathname).toBe('/auth/login');
  });

  it('a request with no Accept header, or one that lists both json and text/html, is a document request', async () => {
    for (const accept of [null, 'application/json, text/html']) {
      const res = await middleware(req('/', { accept }));
      expect(res.status, String(accept)).toBe(307);
      expect(target(res).pathname).toBe('/auth/login');
    }
  });

  it('no 401 HTML stub any more: the redirect carries no sign-in-prompt body', async () => {
    const res = await middleware(req('/'));
    expect(await res.text()).not.toContain('sign-in-prompt');
  });

  it('a non-401 resolver failure is still relayed as problem+json (no redirect)', async () => {
    resolveMock.mockResolvedValue({ ok: false, status: 503, problem: { type: 'urn:lims:error:core.unavailable', title: 'x', status: 503, code: 'core.unavailable' } });
    const res = await middleware(req('/specimens', { cookie: COOKIE }));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('JSON requests keep problem+json 401 exactly as before', () => {
  it('missing session → 401 auth.unauthenticated', async () => {
    const res = await middleware(req('/v1/anything', { accept: 'application/json' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 401, code: 'auth.unauthenticated' });
  });

  it('expired session → 401 auth.session_expired', async () => {
    resolveMock.mockResolvedValue(unauthResolution('auth.session_expired'));
    const res = await middleware(req('/v1/anything', { accept: 'application/json', cookie: COOKIE }));
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 401, code: 'auth.session_expired' });
  });

  it('problem+json responses still carry the security headers and CSP', async () => {
    const res = await middleware(req('/v1/anything', { accept: 'application/json' }));
    expect(res.headers.get('content-security-policy-report-only')).toMatch(/nonce-/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('public paths are never redirected (no loops)', () => {
  const PUBLIC = ['/auth/login', '/auth/session-expired', '/auth/', '/auth', '/auth/logout', '/auth/mfa', '/queue-display', '/queue-display/lab-1'];
  for (const accept of [HTML, 'application/json']) {
    it(`Accept ${accept.slice(0, 16)}…: passes through, no resolver call, no 307/401`, async () => {
      for (const p of PUBLIC) {
        const res = await middleware(req(p, { accept }));
        expect(res.status, p).toBe(200);
        expect(res.headers.get('location'), p).toBeNull();
        expect(res.headers.get('x-middleware-next'), p).toBe('1');
      }
      expect(resolveMock).not.toHaveBeenCalled();
    });
  }

  it('public paths are not redirected even with a stale cookie', async () => {
    resolveMock.mockResolvedValue(unauthResolution('auth.session_expired'));
    for (const p of ['/auth/login', '/auth/session-expired']) {
      const res = await middleware(req(p, { cookie: COOKIE }));
      expect(res.status, p).toBe(200);
      expect(res.headers.get('location'), p).toBeNull();
    }
  });

  it('an authenticated request to a staff path passes through untouched', async () => {
    resolveMock.mockResolvedValue({
      ok: true,
      accessToken: 'tok-synthetic',
      session: { sessionId: SID, kind: 'staff', aal: 'aal1', idleExpiresAt: 'x', absoluteExpiresAt: 'y', actor: { displayName: 'Test User', tenantCode: 't', roles: [], permissions: [] } },
    });
    const res = await middleware(req('/specimens', { cookie: COOKIE }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('the redirect keeps the security headers and CSP (REQ-SEC-089)', () => {
  it.each([
    ['missing', undefined],
    ['expired', COOKIE],
  ])('%s: CSP (report-only, with nonce), nosniff, referrer-policy, no-store', async (reason, cookie) => {
    if (reason === 'expired') resolveMock.mockResolvedValue(unauthResolution('auth.session_expired'));
    const res = await middleware(req('/', { cookie }));
    expect(res.status).toBe(307);
    const csp = res.headers.get('content-security-policy-report-only') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the nonce is fresh per request', async () => {
    const n = async () => ((await middleware(req('/'))).headers.get('content-security-policy-report-only') ?? '').match(/nonce-([^']+)'/)?.[1];
    expect(await n()).not.toBe(await n());
  });
});

describe('the redirect target is a literal (no open redirect, no echo)', () => {
  const HOSTILE = [
    '/?next=https://evil.example/x&redirect=//evil.example&returnTo=/\\evil.example',
    '/%2F%2Fevil.example',
    '/lab/evil.example?url=http://evil.example',
  ];

  it('query strings, paths and spoofed Host / X-Forwarded-* headers never reach Location', async () => {
    const headers = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example', referer: 'https://evil.example/' };
    for (const p of HOSTILE) {
      const res = await middleware(req(p, { headers }));
      expect(res.status, p).toBe(307);
      const loc = res.headers.get('location') ?? '';
      expect(loc, p).not.toMatch(/evil/i);
      expect(loc, p).not.toContain('?');
      expect(loc, p).not.toContain('#');
      const t = target(res);
      expect(t.origin, p).toBe(ORIGIN);
      expect(t.pathname, p).toBe('/auth/login');
    }
  });

  it('REQ-SEC-068: the session id and tokens are never echoed in Location or body, and no cookie is set', async () => {
    resolveMock.mockResolvedValue(unauthResolution('auth.session_expired'));
    const res = await middleware(req('/', { cookie: COOKIE }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).not.toContain(SID);
    expect(await res.text()).not.toContain(SID);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('an unsafe method without a valid Origin is still rejected 403 auth.csrf_failed before any redirect', async () => {
    const res = await middleware(req('/specimens', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'auth.csrf_failed' });
  });
});

describe('source guards (LD-200)', () => {
  const src = readFileSync(resolve(fileURLToPath(new URL('../', import.meta.url)), 'middleware.ts'), 'utf8');
  it('cites LD-200 and uses the two literal targets', () => {
    expect(src).toMatch(/LD-200/);
    expect(src).toMatch(/['"`]\/auth\/login['"`]/);
    expect(src).toMatch(/['"`]\/auth\/session-expired['"`]/);
  });
  it('the session-exempt list and the CSRF-before-session order are unchanged', () => {
    expect(src).toContain('const SESSION_EXEMPT = [/^\\/auth(\\/|$)/, /^\\/queue-display(\\/|$)/];');
    expect(src.replace(/\s+/g, ' ')).toMatch(/!SAFE_METHODS\.has\(req\.method\) && !csrfOk\(req\)\) return/);
  });
});
