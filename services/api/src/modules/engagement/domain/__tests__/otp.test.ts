// C16 T-02 otp.ts (02-TRD §3/§4.1: 6-digit code via @lims/shared-ts/crypto randomDigits — CSPRNG, leading zeros kept; E3 code ^[0-9]{6}$).
// Assumed API: OTP_LENGTH (6), generateOtp() -> string, isWellFormedOtp(code) -> boolean
import { describe, expect, it } from 'vitest';
import { OTP_LENGTH, generateOtp, isWellFormedOtp } from '../otp.js';

describe('generateOtp', () => {
  it('is 6 digits, always (leading zeros kept)', () => {
    expect(OTP_LENGTH).toBe(6);
    for (let i = 0; i < 2000; i++) expect(generateOtp()).toMatch(/^[0-9]{6}$/);
  });

  // Smoke test, not a statistical proof. N=30000 digits per position, expected 3000 each, sd ≈ 52.
  // Window ±20 % (≈ 11 sd) makes a false failure astronomically unlikely, while a biased generator
  // (e.g. Math.random()*999999 → no leading zeros, or `% 10` bias) still fails.
  it('each digit 0-9 is roughly uniform in every position', () => {
    const N = 30000;
    const counts = Array.from({ length: OTP_LENGTH }, () => new Array<number>(10).fill(0));
    for (let i = 0; i < N; i++) {
      const code = generateOtp();
      for (let p = 0; p < OTP_LENGTH; p++) counts[p]![Number(code[p])]!++;
    }
    for (let p = 0; p < OTP_LENGTH; p++)
      for (let d = 0; d < 10; d++) {
        expect(counts[p]![d]!, `position ${p} digit ${d}`).toBeGreaterThan((N / 10) * 0.8);
        expect(counts[p]![d]!, `position ${p} digit ${d}`).toBeLessThan((N / 10) * 1.2);
      }
  });

  it('codes start with 0 about 10 % of the time (no leading-zero loss)', () => {
    let zero = 0;
    for (let i = 0; i < 20000; i++) if (generateOtp().startsWith('0')) zero++;
    expect(zero).toBeGreaterThan(1600);
    expect(zero).toBeLessThan(2400);
  });

  it('successive codes are not all equal (not a constant)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateOtp());
    expect(seen.size).toBeGreaterThan(150);
  });
});

describe('isWellFormedOtp (E3 ^[0-9]{6}$)', () => {
  it.each(['000000', '123456', '999999'])('accepts %s', (c) => expect(isWellFormedOtp(c)).toBe(true));
  it.each(['12345', '1234567', '12345a', ' 12345', '12345\n', '١٢٣٤٥٦', '', '12 456', '+12345'])('rejects %j', (c) => expect(isWellFormedOtp(c)).toBe(false));
  it('rejects non-strings', () => {
    expect(isWellFormedOtp(123456 as never)).toBe(false);
    expect(isWellFormedOtp(null as never)).toBe(false);
  });
});
