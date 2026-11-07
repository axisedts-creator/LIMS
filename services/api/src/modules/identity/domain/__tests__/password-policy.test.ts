// T2 password-policy.ts (AC-A6.1, AC-A6.2, AC-A6.3; 05-SCHEMA §4.6 password_min_length 12–64; REQ-SEC-060; 02-TRD §2 domain/password-policy.ts).
// Assumed API (pure, no I/O):
//   checkPasswordPolicy(password, opts?: { minLength?: number /* default 12, never below 12 */ })
//     -> { ok: true } | { ok: false; code: 'auth.password_policy_violation'; reason: 'too_short' | 'too_long_bytes' }
//   evaluatePassword(password, { minLength?, isBreached: (sha1: Buffer /* 20 bytes, SHA-1 of UTF-8 */) => Promise<boolean> })
//     -> { ok: true } | { ok: false; code: 'auth.password_policy_violation' | 'auth.password_breached' }
//   MAX_PASSWORD_BYTES === 72, DEFAULT_MIN_PASSWORD_LENGTH === 12
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES, checkPasswordPolicy, evaluatePassword } from '../password-policy.js';

const VIOLATION = 'auth.password_policy_violation';
const dev = (n: number): string => 'अ'.repeat(n); // U+0905, 3 bytes in UTF-8 (synthetic)
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('constants', () => {
  it('72-byte bcrypt limit and 12-char floor', () => {
    expect(MAX_PASSWORD_BYTES).toBe(72);
    expect(DEFAULT_MIN_PASSWORD_LENGTH).toBe(12);
  });
});

describe('AC-A6.1 minimum length', () => {
  it('11 chars -> violation too_short', () => {
    expect(checkPasswordPolicy('a'.repeat(11))).toEqual({ ok: false, code: VIOLATION, reason: 'too_short' });
  });
  it('12 chars -> ok', () => expect(checkPasswordPolicy('a'.repeat(12))).toEqual({ ok: true }));
  it('13 chars -> ok', () => expect(checkPasswordPolicy('a'.repeat(13))).toEqual({ ok: true }));
  it('empty -> violation', () => expect(checkPasswordPolicy('')).toMatchObject({ ok: false, code: VIOLATION }));
  it('Devanagari: 11 characters (33 bytes) is too short — length counts characters, not bytes', () => {
    expect(checkPasswordPolicy(dev(11))).toMatchObject({ ok: false, reason: 'too_short' });
  });
  it('Devanagari: 12 characters (36 bytes) is ok', () => expect(checkPasswordPolicy(dev(12))).toEqual({ ok: true }));
  it('astral emoji count as ONE character each (11 emoji too short, 12 ok)', () => {
    expect(checkPasswordPolicy('😀'.repeat(11))).toMatchObject({ ok: false, reason: 'too_short' });
    expect(checkPasswordPolicy('😀'.repeat(12))).toEqual({ ok: true });
  });
  it('tenant minLength 64 (upper range) is honoured: 63 fails, 64 ok', () => {
    expect(checkPasswordPolicy('a'.repeat(63), { minLength: 64 })).toMatchObject({ ok: false, reason: 'too_short' });
    // 64 ASCII bytes <= 72, so the byte limit does not interfere
    expect(checkPasswordPolicy('a'.repeat(64), { minLength: 64 })).toEqual({ ok: true });
  });
  it('tenant minLength 20: 19 fails, 20 ok', () => {
    expect(checkPasswordPolicy('a'.repeat(19), { minLength: 20 })).toMatchObject({ ok: false });
    expect(checkPasswordPolicy('a'.repeat(20), { minLength: 20 })).toEqual({ ok: true });
  });
  it('a tenant minLength below the 12 floor never lowers the floor (04 A3)', () => {
    expect(checkPasswordPolicy('a'.repeat(11), { minLength: 8 })).toMatchObject({ ok: false, reason: 'too_short' });
  });
});

describe('AC-A6.2 72-byte UTF-8 boundary', () => {
  it('72 ASCII bytes -> ok', () => expect(checkPasswordPolicy('a'.repeat(72))).toEqual({ ok: true }));
  it('73 ASCII bytes -> violation too_long_bytes', () => {
    expect(checkPasswordPolicy('a'.repeat(73))).toEqual({ ok: false, code: VIOLATION, reason: 'too_long_bytes' });
  });
  it('Devanagari 24 chars = 72 bytes -> ok (fixture sanity)', () => {
    expect(bytes(dev(24))).toBe(72);
    expect(checkPasswordPolicy(dev(24))).toEqual({ ok: true });
  });
  it('Devanagari 25 chars = 75 bytes -> violation although only 25 characters', () => {
    expect(bytes(dev(25))).toBe(75);
    expect(checkPasswordPolicy(dev(25))).toEqual({ ok: false, code: VIOLATION, reason: 'too_long_bytes' });
  });
  it('mixed: 71 ASCII + one 3-byte char = 74 -> violation; 69 + 3 = 72 -> ok', () => {
    expect(checkPasswordPolicy('a'.repeat(71) + 'अ')).toMatchObject({ ok: false, reason: 'too_long_bytes' });
    expect(checkPasswordPolicy('a'.repeat(69) + 'अ')).toEqual({ ok: true });
  });
  it('4-byte astral: 18 emoji = 72 bytes ok, 19 = 76 bytes violation', () => {
    expect(checkPasswordPolicy('😀'.repeat(18))).toEqual({ ok: true });
    expect(checkPasswordPolicy('😀'.repeat(19))).toMatchObject({ ok: false, reason: 'too_long_bytes' });
  });
  it('very long input (10k chars) is rejected, not truncated', () => {
    expect(checkPasswordPolicy('a'.repeat(10_000))).toMatchObject({ ok: false, reason: 'too_long_bytes' });
  });
  it('length is measured on the string as given (no normalisation that shrinks it)', () => {
    // क + nukta as 2 code points = 6 bytes; 13 pairs = 78 bytes -> violation
    expect(checkPasswordPolicy('क़'.repeat(13).normalize('NFD'))).toMatchObject({ ok: false, reason: 'too_long_bytes' });
  });
});

describe('AC-A6.3 breached lookup (local list only)', () => {
  const sha1 = (s: string): Buffer => createHash('sha1').update(s, 'utf8').digest();

  it('breached -> auth.password_breached; lookup receives SHA-1 of the UTF-8 bytes as a 20-byte Buffer', async () => {
    const pw = 'correct-horse-battery';
    const isBreached = vi.fn(async (_h: Buffer) => true);
    const r = await evaluatePassword(pw, { isBreached });
    expect(r).toMatchObject({ ok: false, code: 'auth.password_breached' });
    expect(isBreached).toHaveBeenCalledTimes(1);
    const arg = isBreached.mock.calls[0]![0];
    expect(Buffer.isBuffer(arg)).toBe(true);
    expect(arg.length).toBe(20);
    expect(arg.equals(sha1(pw))).toBe(true);
  });
  it('Devanagari password is hashed over its UTF-8 bytes', async () => {
    const isBreached = vi.fn(async (_h: Buffer) => false);
    expect(await evaluatePassword(dev(14), { isBreached })).toEqual({ ok: true });
    expect(isBreached.mock.calls[0]![0].equals(sha1(dev(14)))).toBe(true);
  });
  it('not breached + valid -> ok', async () => {
    expect(await evaluatePassword('a'.repeat(12), { isBreached: async () => false })).toEqual({ ok: true });
  });
  it('policy violation wins and the breached lookup is NOT called (short)', async () => {
    const isBreached = vi.fn(async (_h: Buffer) => true);
    expect(await evaluatePassword('a'.repeat(11), { isBreached })).toMatchObject({ ok: false, code: VIOLATION });
    expect(isBreached).not.toHaveBeenCalled();
  });
  it('policy violation wins and the breached lookup is NOT called (73 bytes)', async () => {
    const isBreached = vi.fn(async (_h: Buffer) => true);
    expect(await evaluatePassword('a'.repeat(73), { isBreached })).toMatchObject({ ok: false, code: VIOLATION });
    expect(isBreached).not.toHaveBeenCalled();
  });
  it('lookup failure propagates (fail closed, never silently accepts)', async () => {
    await expect(
      evaluatePassword('a'.repeat(12), { isBreached: async () => { throw new Error('db down'); } }),
    ).rejects.toThrow('db down');
  });
  it('honours minLength passed through', async () => {
    const isBreached = vi.fn(async (_h: Buffer) => false);
    expect(await evaluatePassword('a'.repeat(15), { minLength: 16, isBreached })).toMatchObject({ ok: false, code: VIOLATION });
    expect(isBreached).not.toHaveBeenCalled();
  });
});
