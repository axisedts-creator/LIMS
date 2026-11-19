// SEC-HDR-1 (LD-238, audit 10.1): portal response headers from src/middleware.ts (tester contract: set there, next to nosniff / no-store).
//   X-Frame-Options DENY; Referrer-Policy stays `no-referrer` (already set); Permissions-Policy denies camera, microphone, geolocation
//   and payment, `(self)` only for a feature the portal's own code uses (today none: grep of apps/portal/src finds no use).
//   CSP: byte-identical to before; enforced in production (as before), report-only otherwise; nothing flipped.
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertHardened, expectedPermissions, featuresUsedBy, parsePermissionsPolicy, stripNonce } from '../../../../tests/security/sec-hdr1.helpers';

const GOLDEN_CSP =
  "default-src 'self'; img-src 'self' data:; script-src 'self' 'nonce-N'; style-src 'self' 'nonce-N'; font-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

async function load(env: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', env);
  return (await import('../middleware')) as { middleware: (r: NextRequest) => Response };
}
const req = (path: string, method = 'GET') => new NextRequest(`https://portal.test${path}`, { method });
afterEach(() => vi.unstubAllEnvs());

describe('portal: every kind of middleware response carries the new headers', () => {
  it.each([
    ['home page', '/'],
    ['sign-in page', '/auth/login'],
    ['QR verification (rewrite to /v/_)', '/v/synthetic-token-0001'],
    ['QR verification, malformed escape', '/v/%E0%A4%A'],
    ['API route', '/api/anything'],
  ])('%s', async (label, path) => {
    const { middleware } = await load('production');
    assertHardened(middleware(req(path)).headers, 'portal', label, 'no-referrer');
  });
  it('a POST (server action) carries them too', async () => {
    const { middleware } = await load('production');
    assertHardened(middleware(req('/auth/login', 'POST')).headers, 'portal', 'POST', 'no-referrer');
  });
});

describe('portal: Permissions-Policy follows the feature use in apps/portal/src', () => {
  it('no camera, microphone, geolocation or payment use in the portal code, so all four are ()', async () => {
    expect(Object.values(featuresUsedBy('portal')).flat(), 'a feature in use needs (self) and a comment citing the file').toEqual([]);
    expect(expectedPermissions('portal')).toEqual({ camera: '()', microphone: '()', geolocation: '()', payment: '()' });
    const { middleware } = await load('production');
    expect(parsePermissionsPolicy(middleware(req('/')).headers.get('permissions-policy'))).toEqual({ camera: '()', microphone: '()', geolocation: '()', payment: '()' });
  });
});

describe('portal: CSP unchanged', () => {
  it.each(['/', '/v/synthetic-token-0001'])('production %s: enforced header, value byte-identical (nonce aside), no report-only', async (path) => {
    const { middleware } = await load('production');
    const res = middleware(req(path));
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    expect(stripNonce(res.headers.get('content-security-policy') ?? '')).toBe(GOLDEN_CSP);
  });
  it('non-production: still report-only with the same value (not flipped either way)', async () => {
    const { middleware } = await load('test');
    const res = middleware(req('/'));
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(stripNonce(res.headers.get('content-security-policy-report-only') ?? '')).toBe(GOLDEN_CSP);
  });
  it('the other headers it already set are unchanged', async () => {
    const { middleware } = await load('production');
    const h = middleware(req('/')).headers;
    expect(h.get('cache-control')).toBe('no-store');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
  });
});
