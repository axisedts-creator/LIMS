// T0D-WAKE-1 (LD-277, RS-07): src/middleware.ts when the session resolve got no answer from the API.
// CONTRACT chosen by the tester: resolver returns { ok:false, status:503, problem, waking:true }.
//   document request  -> NextResponse.rewrite to /auth/waking (the URL in the browser stays, so Retry = refresh); NOT a 307, NOT a 401, no Location, no cookie change.
//   JSON request      -> unchanged: problem+json 503.   HTTP 503 answer (no waking flag) -> unchanged problem+json 503, documents too.
//   401 -> 307 as today. The rewrite target is an auth page (exempt from the session requirement); apps/web/src/app/(auth)/auth/waking/page.tsx exists.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('../core/session/provider', () => ({ getSessionResolver: async () => ({ resolve: resolveMock }) }));
import { middleware } from '../middleware';

const ORIGIN = 'http://localhost:3000';
const COOKIE = '__Host-lims_sid=sid-synthetic-0123456789';
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const req = (path: string, accept = HTML) => new NextRequest(`${ORIGIN}${path}`, { headers: { accept, cookie: COOKIE } });
const prob = (code: string, status: number) => ({ type: `urn:lims:error:${code}`, title: code, status, code });
const waking = { ok: false as const, status: 503, problem: prob('common.dependency_unavailable', 503), waking: true as const };

beforeEach(() => resolveMock.mockReset());

describe('RS-07 middleware: no answer from the API', () => {
  it('a document request is rewritten to /auth/waking: not signed out, no redirect', async () => {
    resolveMock.mockResolvedValue(waking);
    const res = await middleware(req('/specimens?tab=open'));
    const rewrite = res.headers.get('x-middleware-rewrite');
    expect(rewrite, 'x-middleware-rewrite header').toBeTruthy();
    expect(new URL(rewrite!).pathname).toBe('/auth/waking');
    expect(new URL(rewrite!).origin).toBe(ORIGIN);
    expect(res.headers.get('location')).toBeNull();
    expect([307, 401]).not.toContain(res.status);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a JSON request keeps problem+json 503 (no HTML state for fetch callers)', async () => {
    resolveMock.mockResolvedValue(waking);
    const res = await middleware(req('/api/x', 'application/json'));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('an HTTP 503 answer (no waking flag) keeps the current problem+json 503 for documents', async () => {
    resolveMock.mockResolvedValue({ ok: false, status: 503, problem: prob('common.dependency_unavailable', 503) });
    const res = await middleware(req('/specimens'));
    expect(res.status).toBe(503);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('a 401 still means signed out: 307 to /auth/session-expired', async () => {
    resolveMock.mockResolvedValue({ ok: false, status: 401, problem: prob('auth.session_expired', 401) });
    const res = await middleware(req('/specimens'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/auth/session-expired');
  });

  it('no cookie is still a 307 to /auth/login; the resolver is not asked', async () => {
    const res = await middleware(new NextRequest(`${ORIGIN}/specimens`, { headers: { accept: HTML } }));
    expect(res.status).toBe(307);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('the waking page exists under (auth), renders WakingState, and never reads the session', () => {
    const page = join(import.meta.dirname, '..', 'app', '(auth)', 'auth', 'waking', 'page.tsx');
    expect(existsSync(page), page).toBe(true);
    const src = readFileSync(page, 'utf8');
    expect(src).toMatch(/WakingState/);
    expect(src).not.toMatch(/getSession|requireSession|resolveSession|cookies\(/);
  });
});
