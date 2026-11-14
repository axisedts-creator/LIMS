// C16-T01 — LIMS_ENGAGEMENT_* config validation (02-TRD §10.1; 04 A9; 07-SECURITY key table, REQ-SEC-128). AC US-EN-01.3.
// done_when: "boot fails on OTP TTL > 600, attempts != 5, length < 6, missing key files".
// SEAM (spec does not fix the export): `loadEngagementConfig(env)` in ../config.ts, env = plain key/value map (like loadReportingConfig).
// Fields (camelCase of the key minus prefix): otpTtlSeconds, otpMaxAttempts, otpLength, linkRedeemFailuresPerHour, orderPollSeconds,
// displayPollSeconds, backfillMaxOrders, projectionReconcileDays. Result frozen. Every bad value throws an Error naming the key, never a secret.
// Key files: OTP_HMAC / LINK_HMAC / PHONE_HMAC = raw file >= 32 bytes; OTP_ENC_KEYS = JSON object {key_id: base64 of exactly 32 bytes}, >= 1 entry.
// All four are "(required)" (TRD §10.1): unset fails in every environment.
// Fails now: ../config.js does not exist.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEngagementConfig } from '../config.js';

const P = 'LIMS_ENGAGEMENT_';
const RAW_KEYS = ['OTP_HMAC_KEY_FILE', 'LINK_HMAC_KEY_FILE', 'PHONE_HMAC_KEY_FILE'] as const;
const PROD = { LIMS_CORE_ENV: 'production', NODE_ENV: 'production' };
let dir: string;
let good: Record<string, string>;
const b64 = (n: number) => Buffer.alloc(n, 9).toString('base64');
const file = (name: string, data: string | Buffer) => {
  const f = join(dir, name);
  writeFileSync(f, data);
  return f;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'c16-t01-'));
  good = {
    LIMS_CORE_ENV: 'dev',
    [`${P}OTP_HMAC_KEY_FILE`]: file('otp.key', Buffer.alloc(32, 1)),
    [`${P}LINK_HMAC_KEY_FILE`]: file('link.key', Buffer.alloc(32, 2)),
    [`${P}PHONE_HMAC_KEY_FILE`]: file('phone.key', Buffer.alloc(32, 3)),
    [`${P}OTP_ENC_KEYS_FILE`]: file('enc.json', JSON.stringify({ 'k-1': b64(32), 'k-2': b64(32) })),
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const load = (extra: Record<string, string | undefined> = {}, base: Record<string, string> = good) => {
  const env: Record<string, string | undefined> = { ...base, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return loadEngagementConfig(env as Record<string, string>) as any;
};
const bad = (key: string, v: string) => expect(() => load({ [`${P}${key}`]: v })).toThrow(new RegExp(`${P}${key}`));

describe('defaults (02-TRD §10.1)', () => {
  it('dev boot with only the four key files set', () => {
    const c = load();
    expect(c.otpTtlSeconds).toBe(300);
    expect(c.otpMaxAttempts).toBe(5);
    expect(c.otpLength).toBe(6);
    expect(c.linkRedeemFailuresPerHour).toBe(5);
    expect(c.orderPollSeconds).toBe(30);
    expect(c.displayPollSeconds).toBe(5);
    expect(c.backfillMaxOrders).toBe(1000);
    expect(c.projectionReconcileDays).toBe(30);
  });
  it('config is frozen', () => expect(Object.isFrozen(load())).toBe(true));
  it('also boots in production with the same defaults', () => {
    expect(load({}, { ...good, ...PROD }).otpTtlSeconds).toBe(300);
  });
});

describe('LIMS_ENGAGEMENT_OTP_TTL_SECONDS: 120..600 (04 A9)', () => {
  it.each(['120', '300', '600'])('%s is accepted', (v) => expect(load({ [`${P}OTP_TTL_SECONDS`]: v }).otpTtlSeconds).toBe(Number(v)));
  it.each(['601', '3600', '119', '0', '-1', '1.5', 'abc', '', '600; x', '1e3', '0x10', ' 300'])('%j fails naming the key', (v) => bad('OTP_TTL_SECONDS', v));
  it('production + 601 fails too', () => {
    expect(() => load({ [`${P}OTP_TTL_SECONDS`]: '601' }, { ...good, ...PROD })).toThrow(/LIMS_ENGAGEMENT_OTP_TTL_SECONDS/);
  });
});

describe('LIMS_ENGAGEMENT_OTP_MAX_ATTEMPTS: fixed at 5 (04 A9)', () => {
  it('5 is accepted', () => expect(load({ [`${P}OTP_MAX_ATTEMPTS`]: '5' }).otpMaxAttempts).toBe(5));
  it.each(['4', '6', '10', '0', '-5', '5.5', 'five', '', '05x', ' 5'])('%j fails naming the key', (v) => bad('OTP_MAX_ATTEMPTS', v));
});

describe('LIMS_ENGAGEMENT_OTP_LENGTH: >= 6 (04 A9)', () => {
  it.each(['6', '7', '8'])('%s is accepted', (v) => expect(load({ [`${P}OTP_LENGTH`]: v }).otpLength).toBe(Number(v)));
  it.each(['5', '4', '0', '-6', '6.5', 'six', '', '6x', '0x6'])('%j fails naming the key', (v) => bad('OTP_LENGTH', v));
});

describe('numeric [CONV] keys: range and junk', () => {
  it.each([
    ['LINK_REDEEM_FAILURES_PER_HOUR', 'linkRedeemFailuresPerHour', ['1', '10'], ['0', '11']],
    ['ORDER_POLL_SECONDS', 'orderPollSeconds', ['15', '120'], ['14', '121']],
    ['DISPLAY_POLL_SECONDS', 'displayPollSeconds', ['3', '30'], ['2', '31']],
  ])('%s: bounds', (key, field, ok, no) => {
    for (const v of ok as string[]) expect(load({ [`${P}${key}`]: v })[field as string]).toBe(Number(v));
    for (const v of [...(no as string[]), 'abc', '-1', '1.5', '']) bad(key as string, v);
  });
  it.each([
    ['BACKFILL_MAX_ORDERS', 'backfillMaxOrders'],
    ['PROJECTION_RECONCILE_DAYS', 'projectionReconcileDays'],
  ])('%s: positive integer', (key, field) => {
    expect(load({ [`${P}${key}`]: '7' })[field as string]).toBe(7);
    for (const v of ['0', 'abc', '-1', '1.5', '']) bad(key as string, v);
  });
});

describe('key files: required, >= 32 bytes (REQ-SEC-128)', () => {
  it.each(RAW_KEYS)('%s: unset fails naming the key (dev and production)', (k) => {
    expect(() => load({ [`${P}${k}`]: undefined })).toThrow(new RegExp(`${P}${k}`));
    expect(() => load({ [`${P}${k}`]: undefined }, { ...good, ...PROD })).toThrow(new RegExp(`${P}${k}`));
  });
  it.each(RAW_KEYS)('%s: missing file fails naming the key', (k) => {
    expect(() => load({ [`${P}${k}`]: join(dir, 'nope.key') })).toThrow(new RegExp(`${P}${k}`));
  });
  it.each(RAW_KEYS)('%s: 31 bytes fails, 32 and 64 bytes pass', (k) => {
    expect(() => load({ [`${P}${k}`]: file('s31.key', Buffer.alloc(31, 5)) })).toThrow(new RegExp(`${P}${k}`));
    expect(() => load({ [`${P}${k}`]: file('s32.key', Buffer.alloc(32, 5)) })).not.toThrow();
    expect(() => load({ [`${P}${k}`]: file('s64.key', Buffer.alloc(64, 5)) })).not.toThrow();
  });
  it.each(RAW_KEYS)('%s: empty file and a directory fail naming the key', (k) => {
    expect(() => load({ [`${P}${k}`]: file('empty.key', '') })).toThrow(new RegExp(`${P}${k}`));
    expect(() => load({ [`${P}${k}`]: dir })).toThrow(new RegExp(`${P}${k}`));
  });
  it('error text never contains key file contents', () => {
    const f = file('secret.key', 'TOPSECRET-KEY-MATERIAL'); // 22 bytes < 32
    let msg = '';
    try {
      load({ [`${P}OTP_HMAC_KEY_FILE`]: f });
    } catch (e: any) {
      msg = String(e.message);
    }
    expect(msg).toMatch(/LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE/);
    expect(msg).not.toContain('TOPSECRET');
  });
});

describe('LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE: JSON {key_id: base64 32 bytes}', () => {
  const key = `${P}OTP_ENC_KEYS_FILE`;
  it('unset fails naming the key', () => expect(() => load({ [key]: undefined })).toThrow(/LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE/));
  it('missing file fails naming the key', () => expect(() => load({ [key]: join(dir, 'nope.json') })).toThrow(/LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE/));
  it('one valid entry is accepted', () => expect(() => load({ [key]: file('one.json', JSON.stringify({ a: b64(32) })) })).not.toThrow());
  it.each([
    ['not JSON', 'not json'],
    ['empty object', '{}'],
    ['array', JSON.stringify([b64(32)])],
    ['null', 'null'],
    ['31-byte key', JSON.stringify({ a: b64(31) })],
    ['33-byte key', JSON.stringify({ a: b64(33) })],
    ['non-base64 value', JSON.stringify({ a: '***not base64***' })],
    ['non-string value', JSON.stringify({ a: 7 })],
    ['one bad entry among good', JSON.stringify({ a: b64(32), b: b64(16) })],
    ['empty file', ''],
  ])('%s fails naming the key', (_n, body) => {
    expect(() => load({ [key]: file('enc-bad.json', body) })).toThrow(/LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE/);
  });
  it('error text never contains the key material', () => {
    const secret = Buffer.alloc(16, 0x41).toString('base64');
    let msg = '';
    try {
      load({ [key]: file('enc-leak.json', JSON.stringify({ a: secret })) });
    } catch (e: any) {
      msg = String(e.message);
    }
    expect(msg).toMatch(/LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE/);
    expect(msg).not.toContain(secret);
  });
});
