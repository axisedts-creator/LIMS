// C6-T02 otp.ts (02-TRD §4.7 OTP row; 07-SECURITY test 8, A3/A4; REQ-SEC-069). Pure + node:crypto.
// Assumed API: generateOtp(), otpHmac(key, challengeId, code) -> Uint8Array(32), verifyOtp(key, challengeId, code, storedHmac) -> boolean,
//              canAttempt({attempts, expiresAt, now}), OTP_MAX_ATTEMPTS, OTP_MAX_TTL_SECONDS, OTP_SENDS_PER_HOUR.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OTP_MAX_ATTEMPTS, OTP_MAX_TTL_SECONDS, OTP_SENDS_PER_HOUR, canAttempt, generateOtp, otpHmac, verifyOtp } from '../otp.js';

const key = new Uint8Array(32).fill(7);
const ID = '0192f3a0-0000-7000-8000-000000000001';
const OTHER_ID = '0192f3a0-0000-7000-8000-000000000002';

describe('generateOtp', () => {
  const samples = Array.from({ length: 100_000 }, () => generateOtp());
  it('is always exactly 6 digits, leading zeros kept', () => {
    expect(samples.every((s) => /^\d{6}$/.test(s))).toBe(true);
    expect(samples.some((s) => s.startsWith('0'))).toBe(true);
  });
  it('is uniform: chi-square per digit position over 100k samples (no modulo bias)', () => {
    for (let pos = 0; pos < 6; pos++) {
      const counts = new Array<number>(10).fill(0);
      for (const s of samples) counts[Number(s[pos])]!++;
      const expected = samples.length / 10;
      const chi2 = counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
      expect(chi2).toBeLessThan(50); // df 9, p < 1e-6 false-alarm rate
    }
  });
});

describe('otpHmac', () => {
  it('= HMAC-SHA256(key, "challenge_id:code"), 32 raw bytes (A2.4)', () => {
    const got = otpHmac(key, ID, '123456');
    expect(got).toHaveLength(32);
    expect(Buffer.from(got).equals(createHmac('sha256', key).update(ID + ':123456').digest())).toBe(true);
  });
  it('is bound to the challenge id and to the code', () => {
    const a = Buffer.from(otpHmac(key, ID, '123456'));
    expect(a.equals(Buffer.from(otpHmac(key, OTHER_ID, '123456')))).toBe(false);
    expect(a.equals(Buffer.from(otpHmac(key, ID, '123457')))).toBe(false);
  });
});

describe('verifyOtp (constant-time compare)', () => {
  const stored = otpHmac(key, ID, '042042');
  it('right code -> true', () => expect(verifyOtp(key, ID, '042042', stored)).toBe(true));
  it('wrong code -> false', () => expect(verifyOtp(key, ID, '042043', stored)).toBe(false));
  it('same code on another challenge -> false', () => {
    expect(verifyOtp(key, OTHER_ID, '042042', stored)).toBe(false);
  });
  it('another key -> false (rotation invalidates open challenges)', () => {
    expect(verifyOtp(new Uint8Array(32).fill(8), ID, '042042', stored)).toBe(false);
  });
  it('stored value of 31 or 33 bytes -> false, never throws', () => {
    expect(verifyOtp(key, ID, '042042', stored.slice(0, 31))).toBe(false);
    expect(verifyOtp(key, ID, '042042', new Uint8Array([...stored, 0]))).toBe(false);
    expect(verifyOtp(key, ID, '042042', new Uint8Array(0))).toBe(false);
  });
  it.each(['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６'])('malformed code %j -> false', (code) => {
    expect(verifyOtp(key, ID, code, stored)).toBe(false);
  });
});

describe('limits (REQ-SEC-069)', () => {
  it('constants: 5 attempts, TTL <= 600 s, 3 sends/destination/hour', () => {
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_MAX_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(OTP_SENDS_PER_HOUR).toBe(3);
  });
  const now = new Date('2026-11-07T10:00:00Z');
  const future = new Date('2026-11-07T10:05:00Z');
  it.each([0, 1, 4])('%i failed attempts so far -> may try', (attempts) => {
    expect(canAttempt({ attempts, expiresAt: future, now })).toBe(true);
  });
  it('5 used -> the 6th is refused (A4)', () => {
    expect(canAttempt({ attempts: 5, expiresAt: future, now })).toBe(false);
    expect(canAttempt({ attempts: 6, expiresAt: future, now })).toBe(false);
  });
  it('expired (now >= expiresAt) -> refused', () => {
    expect(canAttempt({ attempts: 0, expiresAt: now, now })).toBe(false);
    expect(canAttempt({ attempts: 0, expiresAt: new Date('2026-11-07T09:59:59Z'), now })).toBe(false);
  });
});
