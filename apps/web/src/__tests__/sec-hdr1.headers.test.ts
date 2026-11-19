// SEC-HDR-1 (LD-238, audit 10.1): staff-web response headers from src/middleware.ts. Tester contract: the headers are set where the web
// middleware already sets its others (`secure()`), so redirects, problem+json and rewrites carry them too.
//   X-Frame-Options DENY; Referrer-Policy present (the current `same-origin` stays: LD-238 adds it only "where missing");
//   Permissions-Policy: camera/microphone/geolocation/payment are `()` unless the app's own code uses the feature, then `(self)`
//   (camera = (self): NewPatientForm.tsx PhotoCapture calls navigator.mediaDevices.getUserMedia({ video: true })).
//   No CSP value changes and nothing is flipped to enforced: the golden strings below are copied byte for byte from the code before this task.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertHardened, expectedPermissions, featuresUsedBy, parsePermissionsPolicy, stripNonce } from '../../../../tests/security/sec-hdr1.helpers';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('../core/session/provider', () => ({ getSessionResolver: async () => ({ resolve: resolveMock }) }));
import { middleware } from '../middleware';

const ORIGIN = 'http://localhost:3000';
const HTML = 'text/html,application/xhtml+xml';
const COOKIE = '__Host-lims_sid=sid-synthetic-0123456789';
const call = (path: string, init: { method?: string; accept?: string; cookie?: boolean; origin?: string } = {}) =>
  middleware(new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: { accept: init.accept ?? HTML, ...(init.cookie ? { cookie: COOKIE } : {}), ...(init.origin ? { origin: init.origin } : {}) },
  }));

const GOLDEN_CSP =
  "default-src 'self'; img-src 'self' data:; script-src 'self' 'nonce-N'; style-src 'self' 'nonce-N'; font-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

beforeEach(() => resolveMock.mockReset());

describe('web: every kind of middleware response carries the new headers', () => {
  const kinds: [string, () => Promise<Response>][] = [
    ['auth page (NextResponse.next)', () => call('/auth/login')],
    ['queue display (exempt)', () => call('/queue-display')],
    ['document without a session (307 redirect)', () => call('/specimens')],
    ['JSON without a session (401 problem+json)', () => call('/api/x', { accept: 'application/json' })],
    ['cross-origin POST (403 problem+json)', () => call('/api/x', { method: 'POST', origin: 'https://evil.example', accept: 'application/json' })],
    ['API waking (rewrite to /auth/waking)', async () => {
      resolveMock.mockResolvedValue({ ok: false, status: 503, problem: { type: 'urn:lims:error:common.dependency_unavailable', title: 't', status: 503, code: 'common.dependency_unavailable' }, waking: true });
      return call('/specimens', { cookie: true });
    }],
    ['session service 503 (problem+json)', async () => {
      resolveMock.mockResolvedValue({ ok: false, status: 503, problem: { type: 'urn:lims:error:common.dependency_unavailable', title: 't', status: 503, code: 'common.dependency_unavailable' } });
      return call('/specimens', { cookie: true, accept: 'application/json' });
    }],
  ];
  it.each(kinds)('%s', async (label, run) => {
    assertHardened((await run()).headers, 'web', label, 'same-origin');
  });
});

describe('web: Permissions-Policy follows the feature use in apps/web/src', () => {
  it('camera is the only feature the code uses (PhotoCapture getUserMedia), found in NewPatientForm.tsx', () => {
    const u = featuresUsedBy('web');
    expect(u.camera.some((f) => f.endsWith('frontdesk/components/NewPatientForm.tsx'))).toBe(true);
    expect([u.microphone, u.geolocation, u.payment]).toEqual([[], [], []]);
    expect(expectedPermissions('web')).toEqual({ camera: '(self)', microphone: '()', geolocation: '()', payment: '()' });
  });
  it('the sent policy is exactly that, and names no other feature as allowed for a foreign origin', async () => {
    const pp = parsePermissionsPolicy((await call('/auth/login')).headers.get('permissions-policy'));
    expect(pp).toMatchObject({ camera: '(self)', microphone: '()', geolocation: '()', payment: '()' });
    for (const v of Object.values(pp)) expect(v).not.toMatch(/\*|https?:/);
  });
});

describe('web: CSP unchanged and still report-only', () => {
  it.each(['/auth/login', '/specimens'])('%s: header name and value are byte-identical to before (nonce aside)', async (path) => {
    const res = await call(path);
    expect(res.headers.get('content-security-policy')).toBeNull();
    const csp = res.headers.get('content-security-policy-report-only');
    expect(csp, 'Content-Security-Policy-Report-Only').toBeTruthy();
    expect(stripNonce(csp!)).toBe(GOLDEN_CSP);
  });
  it('the nonce is still fresh per request', async () => {
    const n = async () => /'nonce-([^']+)'/.exec((await call('/auth/login')).headers.get('content-security-policy-report-only')!)![1];
    expect(await n()).not.toBe(await n());
  });
});
