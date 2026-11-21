// SEC-HDR-1 (LD-238, audit 10.1): partner portal response headers. The headers may come from src/middleware.ts or next.config.ts headers();
// the test merges both the way Next does, so either place passes. Partner had only Cache-Control, Pragma and nosniff.
//   X-Frame-Options DENY; Referrer-Policy added (it had none); Permissions-Policy denies camera, microphone, geolocation and payment,
//   `(self)` only for a feature apps/partner/src uses (today none). CSP: byte-identical, report-only unless PARTNER_CSP_ENFORCE=true (unchanged).
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import config from '../../next.config';
import { assertHardened, configHeadersFor, expectedPermissions, featuresUsedBy, parsePermissionsPolicy, stripNonce } from '../../../../tests/security/sec-hdr1.helpers';

const require_ = createRequire(import.meta.url);
const GOLDEN_CSP =
  "default-src 'self'; script-src 'self' 'nonce-N' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const mw = async () => (await import('../../src/middleware')) as { middleware: (r: NextRequest) => Response | Promise<Response> };
async function effective(path: string): Promise<Headers> {
  const res = await (await mw()).middleware(new NextRequest(`https://partner.test${path}`));
  const merged = new Headers(res.headers);
  (await configHeadersFor(config as never, path, require_)).forEach((v, k) => { if (!merged.has(k)) merged.set(k, v); });
  return merged;
}
afterEach(() => { delete process.env.PARTNER_CSP_ENFORCE; });

const PAGES = ['/', '/orders', '/orders/o-1', '/reports/r-1/slip', '/statements', '/auth/login', '/auth/mfa', '/account', '/api/bff/orders', '/offline'];

describe('partner: pages, auth pages and BFF routes carry the new headers', () => {
  it.each(PAGES)('%s', async (p) => {
    assertHardened(await effective(p), 'partner', p);
  });
  it('what partner already sent is unchanged: no-store, no-cache, nosniff', async () => {
    const h = await effective('/orders');
    expect(h.get('cache-control')).toMatch(/no-store/i);
    expect(h.get('pragma')).toMatch(/no-cache/i);
    expect(h.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('partner: Permissions-Policy follows the feature use in apps/partner/src', () => {
  it('no camera, microphone, geolocation or payment use in the partner code, so all four are ()', async () => {
    expect(Object.values(featuresUsedBy('partner')).flat(), 'a feature in use needs (self) and a comment citing the file').toEqual([]);
    expect(expectedPermissions('partner')).toEqual({ camera: '()', microphone: '()', geolocation: '()', payment: '()' });
    expect(parsePermissionsPolicy((await effective('/orders')).get('permissions-policy'))).toEqual({ camera: '()', microphone: '()', geolocation: '()', payment: '()' });
  });
});

describe('partner: CSP unchanged', () => {
  it('default: report-only, value byte-identical (nonce aside), enforced header absent, none in next.config headers()', async () => {
    const res = await (await mw()).middleware(new NextRequest('https://partner.test/orders'));
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(stripNonce(res.headers.get('content-security-policy-report-only') ?? '')).toBe(GOLDEN_CSP);
    const cfg = await configHeadersFor(config as never, '/orders', require_);
    expect(cfg.get('content-security-policy')).toBeNull();
    expect(cfg.get('content-security-policy-report-only')).toBeNull();
  });
  it('PARTNER_CSP_ENFORCE=true: enforced header with the same value, report-only absent (the switch still works, is not flipped on by default)', async () => {
    process.env.PARTNER_CSP_ENFORCE = 'true';
    const res = await (await mw()).middleware(new NextRequest('https://partner.test/orders'));
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    expect(stripNonce(res.headers.get('content-security-policy') ?? '')).toBe(GOLDEN_CSP);
  });
  it.each(['false', '1', 'TRUE', ''])('PARTNER_CSP_ENFORCE=%j stays report-only', async (v) => {
    process.env.PARTNER_CSP_ENFORCE = v;
    const res = await (await mw()).middleware(new NextRequest('https://partner.test/orders'));
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-security-policy-report-only')).toBeTruthy();
  });
});
