// PG-T02 — return-URL allowlist (TRD §6.1 step 1, §9.1 RETURN_URL_ALLOWLIST; 07-SECURITY AB-11, ST-17).
// Rule: absolute https: URL <= 2000 chars, no userinfo, no fragment; normalised origin+path must start with one
// allowlist entry (origin + path prefix). Else LimsError payments.return_url_not_allowed (422).
import { describe, expect, it } from 'vitest';
import { assertReturnUrlAllowed } from '../../../domain/returnurl.js';

const ALLOW = [
  'https://staff.lims.test/',
  'https://portal.lims.test/',
  'https://api.lims.test/v1/payments/result',
] as const;

const verdict = (url: unknown, allow: readonly string[] = ALLOW): 'ok' | string => {
  try { assertReturnUrlAllowed(url as string, allow); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'threw-without-code'; }
};
const NOT_ALLOWED = 'payments.return_url_not_allowed';

describe('assertReturnUrlAllowed — accepted', () => {
  it.each([
    'https://portal.lims.test/r/payments/0194a1b2/done',          // C6 portal (08 A11.1)
    'https://portal.lims.test/app/payments/0194a1b2/done',        // C16 portal
    'https://staff.lims.test/',
    'https://staff.lims.test/orders/42',
    'https://api.lims.test/v1/payments/result',                   // C4 front desk (08 A19 D-113)
    'https://api.lims.test/v1/payments/result?x=1',
    'https://portal.lims.test/r/payments/1/done?utm=a&b=c',
  ])('%s', (u) => {
    expect(verdict(u)).toBe('ok');
  });

  it('exactly 2000 chars is allowed', () => {
    const base = 'https://portal.lims.test/';
    expect(verdict(base + 'a'.repeat(2000 - base.length))).toBe('ok');
  });
});

describe('assertReturnUrlAllowed — rejected (ST-17 variants)', () => {
  it.each([
    ['other host', 'https://evil.test/'],
    ['allowlisted host as subdomain prefix', 'https://portal.lims.test.evil.test/'],
    ['allowlisted host as suffix of another', 'https://evilportal.lims.test/'],
    ['userinfo hides real host', 'https://portal.lims.test@evil.test/'],
    ['userinfo on allowed host', 'https://user:pw@portal.lims.test/r/payments/1/done'],
    ['username only on allowed host', 'https://user@portal.lims.test/'],
    ['http scheme', 'http://portal.lims.test/r/payments/1/done'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>1</script>'],
    ['protocol-relative', '//evil.test/'],
    ['relative path', '/r/payments/1/done'],
    ['empty', ''],
    ['different port', 'https://portal.lims.test:8443/r/payments/1/done'],
    ['path outside prefix', 'https://api.lims.test/v1/payments/other'],
    ['sibling path on prefix host', 'https://api.lims.test/admin'],
    ['dot-dot escapes prefix', 'https://api.lims.test/v1/payments/result/../../admin'],
    ['encoded dot-dot escapes prefix', 'https://api.lims.test/v1/payments/result/%2e%2e/%2e%2e/admin'],
    ['fragment', 'https://portal.lims.test/r/payments/1/done#frag'],
    ['empty fragment', 'https://portal.lims.test/r/payments/1/done#'],
    ['2001 chars', 'https://portal.lims.test/' + 'a'.repeat(2001 - 'https://portal.lims.test/'.length)],
  ])('%s: %s', (_n, u) => {
    expect(verdict(u)).toBe(NOT_ALLOWED);
  });

  it.each([undefined, null, 42, {}, []])('non-string input %j fails closed', (u) => {
    expect(verdict(u)).toBe(NOT_ALLOWED);
  });

  it('empty allowlist rejects everything (fail closed)', () => {
    expect(verdict('https://portal.lims.test/', [])).toBe(NOT_ALLOWED);
  });

  it('error is 422 and does not echo the URL (07-SECURITY: never log return URLs)', () => {
    let err: { statusCode?: number; message?: string; detail?: string } | undefined;
    try { assertReturnUrlAllowed('https://evil.test/secret-path', ALLOW); } catch (e) { err = e as never; }
    expect(err?.statusCode).toBe(422);
    expect(`${err?.message ?? ''}${err?.detail ?? ''}`).not.toContain('evil.test');
  });
});
