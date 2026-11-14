// PG-T01 config + boot checks (02-TRD §9.1 keys, §9.3 boot rules; 01-PRD US-PG-15 AC-PG-15.1/15.2; 07-SECURITY REQ-SEC-136, ST-14, REQ-SEC-128).
// ASSUMED seam (writer: dispute via .orchestra/notes if wrong):
//   ../../config.ts exports loadPaymentsConfig(env = process.env) -> frozen camelCase config; throws Error whose message names the offending
//   env key (LIMS_PAYMENTS_*) and never contains key material. It reads the KEK file to validate it, but the returned config holds only `kekFile` (path).
//   NODE_ENV is read from `env` (not process.env). Keys of the result: gatewayEnv, publicBaseUrl, returnUrlAllowlist, esewaFormUrl, esewaStatusUrl,
//   khaltiBaseUrl, khaltiRefundOrigin, kekFile, httpTimeoutInitiateMs, httpTimeoutInrequestMs, httpTimeoutJobMs, esewaIntentTtlMinutes,
//   expiryGraceMinutes, pollScheduleSeconds, verifyMinIntervalSeconds, reconLookbackSettledDays, reconLookbackClosedDays, reconConcurrency,
//   esewaAllowFractionalRupees.
// Fails now: ../../config.js does not exist.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPaymentsConfig } from '../../config.js';

const dir = mkdtempSync(join(tmpdir(), 'pg-t01-cfg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const kekFile = (content: string | Buffer): string => { const p = join(dir, `kek-${++n}.json`); writeFileSync(p, content); return p; };
const b64 = (bytes: number) => randomBytes(bytes).toString('base64');
const goodKek = (bytes = 32) => kekFile(JSON.stringify({ keys: { k1: b64(bytes) }, active: 'k1' }));

const UAT_FORM = 'https://uat.esewa.com.np/api/epay/main/v2/form';
const base = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  LIMS_PAYMENTS_PUBLIC_BASE_URL: 'https://api.lims.test',
  LIMS_PAYMENTS_ESEWA_FORM_URL: UAT_FORM,
  LIMS_PAYMENTS_KEK_FILE: goodKek(),
  LIMS_ORIGIN_STAFF_WEB: 'https://staff.lims.test',
  LIMS_ORIGIN_PORTAL: 'https://portal.lims.test',
  ...over,
});
const prod = (over: Record<string, string | undefined> = {}) => base({ NODE_ENV: 'production', LIMS_PAYMENTS_GATEWAY_ENV: 'production', LIMS_PAYMENTS_ESEWA_FORM_URL: undefined, ...over });
const K = (s: string) => `LIMS_PAYMENTS_${s}`;

describe('defaults (TRD §9.1)', () => {
  it('uat defaults: gateway env uat, UAT hosts, documented numeric defaults', () => {
    const c: any = loadPaymentsConfig(base());
    expect(c.gatewayEnv).toBe('uat');
    expect(c.publicBaseUrl).toBe('https://api.lims.test');
    expect(c.esewaFormUrl).toBe(UAT_FORM);
    expect(c.esewaStatusUrl).toBe('https://uat.esewa.com.np/api/epay/transaction/status/');
    expect(c.khaltiBaseUrl).toBe('https://dev.khalti.com/api/v2/');
    expect(c.khaltiRefundOrigin).toBe('https://dev.khalti.com');
    expect([c.httpTimeoutInitiateMs, c.httpTimeoutInrequestMs, c.httpTimeoutJobMs]).toEqual([1200, 2500, 10000]);
    expect([c.esewaIntentTtlMinutes, c.expiryGraceMinutes, c.verifyMinIntervalSeconds]).toEqual([30, 10, 10]);
    expect(c.pollScheduleSeconds).toEqual([120, 300, 600, 1200, 2400]);
    expect([c.reconLookbackSettledDays, c.reconLookbackClosedDays, c.reconConcurrency]).toEqual([2, 7, 2]);
    expect(c.esewaAllowFractionalRupees).toBe(false);
  });

  it('production defaults: production hosts incl. the eSewa form URL', () => {
    const c: any = loadPaymentsConfig(prod());
    expect(c.gatewayEnv).toBe('production');
    expect(c.esewaFormUrl).toBe('https://epay.esewa.com.np/api/epay/main/v2/form');
    expect(c.esewaStatusUrl).toBe('https://epay.esewa.com.np/api/epay/transaction/status/');
    expect(c.khaltiBaseUrl).toBe('https://khalti.com/api/v2/');
    expect(c.khaltiRefundOrigin).toBe('https://khalti.com');
  });

  it('RETURN_URL_ALLOWLIST default = staff origin/, portal origin/, public base /v1/payments/result; explicit value overrides', () => {
    expect((loadPaymentsConfig(base()) as any).returnUrlAllowlist).toEqual(['https://staff.lims.test/', 'https://portal.lims.test/', 'https://api.lims.test/v1/payments/result']);
    expect((loadPaymentsConfig(base({ [K('RETURN_URL_ALLOWLIST')]: 'https://a.test/x, https://b.test/' })) as any).returnUrlAllowlist).toEqual(['https://a.test/x', 'https://b.test/']);
  });

  it('numeric overrides are parsed; POLL_SCHEDULE_SECONDS is a comma list', () => {
    const c: any = loadPaymentsConfig(base({ [K('HTTP_TIMEOUT_JOB_MS')]: '15000', [K('POLL_SCHEDULE_SECONDS')]: '60,120', [K('ESEWA_ALLOW_FRACTIONAL_RUPEES')]: 'true' }));
    expect(c.httpTimeoutJobMs).toBe(15000);
    expect(c.pollScheduleSeconds).toEqual([60, 120]);
    expect(c.esewaAllowFractionalRupees).toBe(true);
  });

  it('result is frozen', () => { expect(Object.isFrozen(loadPaymentsConfig(base()))).toBe(true); });
});

describe('AC-PG-15.1 non-production: boot fails on a production gateway URL (REQ-SEC-136, ST-14)', () => {
  it.each([
    ['ESEWA_FORM_URL', 'https://epay.esewa.com.np/api/epay/main/v2/form'],
    ['ESEWA_STATUS_URL', 'https://epay.esewa.com.np/api/epay/transaction/status/'],
    ['KHALTI_BASE_URL', 'https://khalti.com/api/v2/'],
    ['KHALTI_REFUND_ORIGIN', 'https://khalti.com'],
  ])('GATEWAY_ENV=uat with production %s -> throws naming the key', (key, url) => {
    expect(() => loadPaymentsConfig(base({ [K('GATEWAY_ENV')]: 'uat', [K(key)]: url }))).toThrow(new RegExp(K(key)));
  });
  it('host match is case-insensitive and ignores an explicit port', () => {
    expect(() => loadPaymentsConfig(base({ [K('KHALTI_BASE_URL')]: 'https://KHALTI.com:443/api/v2/' }))).toThrow(/KHALTI_BASE_URL/);
  });
  it('GATEWAY_ENV is a closed set: uat|production (no staging, no near-miss spelling)', () => {
    expect(() => loadPaymentsConfig(base({ [K('GATEWAY_ENV')]: 'staging' }))).toThrow(/GATEWAY_ENV/);
    expect(() => loadPaymentsConfig(base({ [K('GATEWAY_ENV')]: 'PRODUCTION ' }))).toThrow(/GATEWAY_ENV/);
  });
});

describe('AC-PG-15.2 production: boot fails on a sandbox URL or a missing KEK file (REQ-SEC-136, ST-14)', () => {
  it.each([
    ['ESEWA_FORM_URL', 'https://uat.esewa.com.np/api/epay/main/v2/form'],
    ['ESEWA_STATUS_URL', 'https://uat.esewa.com.np/api/epay/transaction/status/'],
    ['KHALTI_BASE_URL', 'https://dev.khalti.com/api/v2/'],
    ['KHALTI_REFUND_ORIGIN', 'https://dev.khalti.com'],
  ])('GATEWAY_ENV=production with sandbox %s -> throws naming the key', (key, url) => {
    expect(() => loadPaymentsConfig(prod({ [K(key)]: url }))).toThrow(new RegExp(K(key)));
  });
  it('production without a KEK file -> throws', () => {
    expect(() => loadPaymentsConfig(prod({ [K('KEK_FILE')]: undefined }))).toThrow(/KEK_FILE/);
    expect(() => loadPaymentsConfig(prod({ [K('KEK_FILE')]: join(dir, 'missing-in-prod.json') }))).toThrow(/KEK_FILE/);
  });
  it('the check is on the URL host, not a substring (a production URL that merely mentions the UAT host in its query is fine)', () => {
    expect(() => loadPaymentsConfig(prod({ [K('ESEWA_FORM_URL')]: 'https://epay.esewa.com.np/api/epay/main/v2/form?ref=uat.esewa.com.np' }))).not.toThrow();
  });
  it('GATEWAY_ENV must be production exactly when NODE_ENV=production', () => {
    expect(() => loadPaymentsConfig(base({ NODE_ENV: 'production', [K('GATEWAY_ENV')]: 'uat' }))).toThrow(/GATEWAY_ENV/);
    expect(() => loadPaymentsConfig(base({ NODE_ENV: 'production' }))).toThrow(/GATEWAY_ENV/); // default uat in a production process
    expect(() => loadPaymentsConfig(base({ NODE_ENV: 'development', [K('GATEWAY_ENV')]: 'production' }))).toThrow(/GATEWAY_ENV/);
    expect(() => loadPaymentsConfig(base({ NODE_ENV: undefined, [K('GATEWAY_ENV')]: 'production' }))).toThrow(/GATEWAY_ENV/);
    expect(() => loadPaymentsConfig(base({ NODE_ENV: 'test', [K('GATEWAY_ENV')]: 'uat' }))).not.toThrow();
  });
});

describe('ESEWA_FORM_URL (UAT value UNVERIFIED -> must be set)', () => {
  it.each([[undefined], [''], ['   ']])('uat with ESEWA_FORM_URL=%j -> throws', (v) => {
    expect(() => loadPaymentsConfig(base({ [K('ESEWA_FORM_URL')]: v }))).toThrow(/ESEWA_FORM_URL/);
  });
  it('must be an https URL', () => {
    expect(() => loadPaymentsConfig(base({ [K('ESEWA_FORM_URL')]: 'http://uat.esewa.com.np/form' }))).toThrow(/ESEWA_FORM_URL/);
    expect(() => loadPaymentsConfig(base({ [K('ESEWA_FORM_URL')]: 'not a url' }))).toThrow(/ESEWA_FORM_URL/);
  });
});

describe('PUBLIC_BASE_URL must be https', () => {
  it.each([[undefined], [''], ['http://api.lims.test'], ['ftp://api.lims.test'], ['api.lims.test'], ['javascript:alert(1)']])('%j -> throws', (v) => {
    expect(() => loadPaymentsConfig(base({ [K('PUBLIC_BASE_URL')]: v }))).toThrow(/PUBLIC_BASE_URL/);
  });
  it('https origin accepted', () => { expect(() => loadPaymentsConfig(base({ [K('PUBLIC_BASE_URL')]: 'https://api.lims.test' }))).not.toThrow(); });
});

describe('KEK file (TRD §6.9 format, §9.3)', () => {
  it('KEK_FILE unset -> throws', () => { expect(() => loadPaymentsConfig(base({ [K('KEK_FILE')]: undefined }))).toThrow(/KEK_FILE/); });
  it('file missing -> throws', () => { expect(() => loadPaymentsConfig(base({ [K('KEK_FILE')]: join(dir, 'nope.json') }))).toThrow(/KEK_FILE/); });
  it.each([
    ['not JSON', 'this is not json'],
    ['empty file', ''],
    ['JSON array', '[]'],
    ['no keys', JSON.stringify({ active: 'k1' })],
    ['no active', JSON.stringify({ keys: { k1: Buffer.alloc(32, 1).toString('base64') } })],
    ['active id not in keys', JSON.stringify({ keys: { k1: Buffer.alloc(32, 1).toString('base64') }, active: 'k2' })],
    ['active key not base64', JSON.stringify({ keys: { k1: '***not-base64***' }, active: 'k1' })],
    ['active key not a string', JSON.stringify({ keys: { k1: 42 }, active: 'k1' })],
  ])('unparseable / malformed (%s) -> throws', (_n, content) => {
    expect(() => loadPaymentsConfig(base({ [K('KEK_FILE')]: kekFile(content) }))).toThrow(/KEK_FILE/);
  });
  it.each([[0], [16], [24], [31], [33], [64]])('active key of %i bytes (not 32) -> throws', (bytes) => {
    expect(() => loadPaymentsConfig(base({ [K('KEK_FILE')]: goodKek(bytes) }))).toThrow(/KEK_FILE/);
  });
  it('only the ACTIVE key length is checked; a 32-byte active key beside a retired key of another length is accepted', () => {
    const f = kekFile(JSON.stringify({ keys: { old: b64(16), k2: b64(32) }, active: 'k2' }));
    expect(() => loadPaymentsConfig(base({ [K('KEK_FILE')]: f }))).not.toThrow();
  });
  it('a valid 32-byte active key boots; production too (AC-PG-15.2 positive)', () => {
    expect(() => loadPaymentsConfig(base())).not.toThrow();
    expect(() => loadPaymentsConfig(prod())).not.toThrow();
  });
  it('security: no error message and no config field ever contains key material (REQ-SEC-128)', () => {
    const secret = randomBytes(31).toString('base64'); // wrong length -> error path
    const f = kekFile(JSON.stringify({ keys: { k1: secret }, active: 'k1' }));
    let msg = '';
    try { loadPaymentsConfig(base({ [K('KEK_FILE')]: f })); } catch (e) { msg = String((e as Error).message) + String((e as Error).stack); }
    expect(msg).not.toBe('');
    expect(msg).not.toContain(secret);
    const good = b64(32);
    const ok = loadPaymentsConfig(base({ [K('KEK_FILE')]: kekFile(JSON.stringify({ keys: { k1: good }, active: 'k1' })) }));
    expect(JSON.stringify(ok)).not.toContain(good);
    expect(JSON.stringify(ok)).not.toContain(Buffer.from(good, 'base64').toString('hex'));
  });
});

describe('numeric / list keys fail closed', () => {
  it.each([
    ['HTTP_TIMEOUT_INITIATE_MS', '0'], ['HTTP_TIMEOUT_INITIATE_MS', 'abc'], ['HTTP_TIMEOUT_INREQUEST_MS', '-5'], ['HTTP_TIMEOUT_JOB_MS', '1.5'],
    ['ESEWA_INTENT_TTL_MINUTES', '0'], ['EXPIRY_GRACE_MINUTES', 'x'], ['VERIFY_MIN_INTERVAL_SECONDS', '0'],
    ['RECON_LOOKBACK_SETTLED_DAYS', '0'], ['RECON_LOOKBACK_CLOSED_DAYS', '-1'], ['RECON_CONCURRENCY', '0'],
    ['POLL_SCHEDULE_SECONDS', '120,abc'], ['POLL_SCHEDULE_SECONDS', '120,,300'], ['POLL_SCHEDULE_SECONDS', '0'], ['POLL_SCHEDULE_SECONDS', '300,120'],
    ['ESEWA_ALLOW_FRACTIONAL_RUPEES', 'yes'], ['ESEWA_ALLOW_FRACTIONAL_RUPEES', '1'],
  ])('%s=%j -> throws naming the key', (key, v) => {
    expect(() => loadPaymentsConfig(base({ [K(key)]: v }))).toThrow(new RegExp(K(key)));
  });
});

describe('purity', () => {
  it('reads only the env it is given (process.env is not consulted when an env object is passed)', () => {
    const before = process.env[K('PUBLIC_BASE_URL')];
    process.env[K('PUBLIC_BASE_URL')] = 'http://insecure.test';
    try { expect(() => loadPaymentsConfig(base())).not.toThrow(); } finally { if (before === undefined) delete process.env[K('PUBLIC_BASE_URL')]; else process.env[K('PUBLIC_BASE_URL')] = before; }
  });
});
