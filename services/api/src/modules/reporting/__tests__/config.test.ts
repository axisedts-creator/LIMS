// C6-T01 — LIMS_REPORTING_* config validation (02-TRD §10.1; 07-SECURITY REQ-SEC-136, REQ-SEC-069; 04 A9; AC-09.5).
// Expected API: `loadReportingConfig(env)` in ../config.ts, env = a plain key/value map (like core loadConfig). Fields:
// otpTtlSeconds, otpMaxAttempts, portalSessionIdleMinutes, portalSessionAbsoluteMinutes, assemblyDebounceSeconds,
// printTtlHours, transportTimeoutMs, allowRealProviders. Result is frozen. Every bad value throws an Error naming the key.
// "Production" = LIMS_CORE_ENV=production (and NODE_ENV=production); the tests set both so either source works.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadReportingConfig } from '../config.js';

let dir: string;
let goodKey: string;
let shortKey: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'c6-t01-'));
  goodKey = join(dir, 'otp.key');
  shortKey = join(dir, 'otp-short.key');
  writeFileSync(goodKey, Buffer.alloc(32, 7));
  writeFileSync(shortKey, Buffer.alloc(31, 7));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const nonProd = (e: string) => ({ LIMS_CORE_ENV: e });
const prod = { LIMS_CORE_ENV: 'production', NODE_ENV: 'production' };
const load = (extra: Record<string, string> = {}, envName: Record<string, string> = nonProd('dev')) =>
  loadReportingConfig({ ...envName, LIMS_REPORTING_OTP_HMAC_KEY_FILE: goodKey, ...extra }) as any;
const loadProd = (extra: Record<string, string> = {}) => load({ LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'true', ...extra }, prod);

describe('defaults (02-TRD §10.1)', () => {
  it('dev boot with defaults', () => {
    const c = load();
    expect(c.otpTtlSeconds).toBe(600);
    expect(c.otpMaxAttempts).toBe(5);
    expect(c.portalSessionIdleMinutes).toBe(15);
    expect(c.portalSessionAbsoluteMinutes).toBe(60);
    expect(c.assemblyDebounceSeconds).toBe(30);
    expect(c.printTtlHours).toBe(24);
    expect(c.transportTimeoutMs).toBe(10_000);
    expect(c.allowRealProviders).toBe(false);
  });
  it('config is frozen', () => expect(Object.isFrozen(load())).toBe(true));
});

describe('LIMS_REPORTING_OTP_TTL_SECONDS: must be <= 600', () => {
  it.each(['600', '300', '1'])('%s is accepted', (v) => expect(load({ LIMS_REPORTING_OTP_TTL_SECONDS: v }).otpTtlSeconds).toBe(Number(v)));
  it.each(['601', '3600', '0', '-1', '1.5', 'abc', '', '600; x', '1e3', '0x10'])('%j fails naming the key', (v) => {
    expect(() => load({ LIMS_REPORTING_OTP_TTL_SECONDS: v })).toThrow(/LIMS_REPORTING_OTP_TTL_SECONDS/);
  });
});

describe('LIMS_REPORTING_OTP_MAX_ATTEMPTS: fixed at 5', () => {
  it('5 is accepted', () => expect(load({ LIMS_REPORTING_OTP_MAX_ATTEMPTS: '5' }).otpMaxAttempts).toBe(5));
  it.each(['4', '6', '10', '0', '-5', '5.5', 'five', '', '05x'])('%j fails naming the key', (v) => {
    expect(() => load({ LIMS_REPORTING_OTP_MAX_ATTEMPTS: v })).toThrow(/LIMS_REPORTING_OTP_MAX_ATTEMPTS/);
  });
});

describe('LIMS_REPORTING_ALLOW_REAL_PROVIDERS (REQ-SEC-136, AC-09.5)', () => {
  it('production with true boots and exposes allowRealProviders = true', () => {
    expect(loadProd().allowRealProviders).toBe(true);
  });
  it.each([undefined, 'false'])('production with %j fails naming the key', (v) => {
    const extra = v === undefined ? {} : { LIMS_REPORTING_ALLOW_REAL_PROVIDERS: v };
    expect(() => load(extra, prod)).toThrow(/LIMS_REPORTING_ALLOW_REAL_PROVIDERS/);
  });
  it.each(['dev', 'ci', 'staging'])('%s with true fails naming the key', (e) => {
    expect(() => load({ LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'true' }, nonProd(e))).toThrow(/LIMS_REPORTING_ALLOW_REAL_PROVIDERS/);
  });
  it.each(['dev', 'ci', 'staging'])('%s with false boots', (e) => {
    expect(load({ LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'false' }, nonProd(e)).allowRealProviders).toBe(false);
  });
  it.each(['TRUE', 'yes', '1', 'on', ''])('non-boolean %j fails naming the key (in prod and dev)', (v) => {
    expect(() => load({ LIMS_REPORTING_ALLOW_REAL_PROVIDERS: v }, prod)).toThrow(/LIMS_REPORTING_ALLOW_REAL_PROVIDERS/);
    expect(() => load({ LIMS_REPORTING_ALLOW_REAL_PROVIDERS: v })).toThrow(/LIMS_REPORTING_ALLOW_REAL_PROVIDERS/);
  });
  it('a non-production LIMS_CORE_ENV with true still fails even if NODE_ENV says development', () => {
    expect(() => load({ LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'true', NODE_ENV: 'development' }, nonProd('staging'))).toThrow(/LIMS_REPORTING_ALLOW_REAL_PROVIDERS/);
  });
});

describe('other bounds apply in production too', () => {
  it('prod + TTL 601 fails', () => expect(() => loadProd({ LIMS_REPORTING_OTP_TTL_SECONDS: '601' })).toThrow(/LIMS_REPORTING_OTP_TTL_SECONDS/));
  it('prod + attempts 6 fails', () => expect(() => loadProd({ LIMS_REPORTING_OTP_MAX_ATTEMPTS: '6' })).toThrow(/LIMS_REPORTING_OTP_MAX_ATTEMPTS/));
});

describe('LIMS_REPORTING_OTP_HMAC_KEY_FILE: >= 32 bytes (REQ-SEC-128)', () => {
  it('32 bytes accepted', () => expect(() => load()).not.toThrow());
  it('31 bytes fails naming the key', () => expect(() => load({ LIMS_REPORTING_OTP_HMAC_KEY_FILE: shortKey })).toThrow(/LIMS_REPORTING_OTP_HMAC_KEY_FILE/));
  it('missing file fails naming the key', () => expect(() => load({ LIMS_REPORTING_OTP_HMAC_KEY_FILE: join(dir, 'nope.key') })).toThrow(/LIMS_REPORTING_OTP_HMAC_KEY_FILE/));
  it('unset in production fails naming the key', () => {
    expect(() => loadReportingConfig({ ...prod, LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'true' })).toThrow(/LIMS_REPORTING_OTP_HMAC_KEY_FILE/);
  });
  it('error text never contains the key file contents', () => {
    writeFileSync(join(dir, 'secret.key'), 'TOPSECRET-KEY-MATERIAL');
    let msg = '';
    try {
      load({ LIMS_REPORTING_OTP_HMAC_KEY_FILE: join(dir, 'secret.key') });
    } catch (e: any) {
      msg = String(e.message);
    }
    expect(msg).toMatch(/LIMS_REPORTING_OTP_HMAC_KEY_FILE/); // 22 bytes < 32 must throw
    expect(msg).not.toContain('TOPSECRET');
  });
});

describe('numeric [CONV] keys reject junk', () => {
  it.each(['LIMS_REPORTING_PORTAL_SESSION_IDLE_MINUTES', 'LIMS_REPORTING_PORTAL_SESSION_ABSOLUTE_MINUTES', 'LIMS_REPORTING_ASSEMBLY_DEBOUNCE_SECONDS',
    'LIMS_REPORTING_PRINT_TTL_HOURS', 'LIMS_REPORTING_TRANSPORT_TIMEOUT_MS'])('%s: abc / -1 / 1.5 fail naming the key', (k) => {
    for (const v of ['abc', '-1', '1.5']) expect(() => load({ [k]: v })).toThrow(new RegExp(k));
  });
  it('valid overrides are read as integers', () => {
    const c = load({ LIMS_REPORTING_TRANSPORT_TIMEOUT_MS: '2500', LIMS_REPORTING_PRINT_TTL_HOURS: '12' });
    expect(c.transportTimeoutMs).toBe(2500);
    expect(c.printTtlHours).toBe(12);
  });
});
