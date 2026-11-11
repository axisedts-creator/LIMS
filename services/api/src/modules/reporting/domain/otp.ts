// OTP helpers (02-TRD §4.7 OTP row; 07-SECURITY test 8; REQ-SEC-069). HMAC-SHA256(key, "challenge_id:code"), constant-time compare.
import { createHmac, timingSafeEqual } from 'node:crypto';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { randomDigits } from '../../../../../../packages/shared-ts/src/crypto/index.js';

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_TTL_SECONDS = 600;
export const OTP_SENDS_PER_HOUR = 3;

const CODE_RE = /^[0-9]{6}$/;

export function generateOtp(): string {
  return randomDigits(6);
}

export function otpHmac(key: Uint8Array, challengeId: string, code: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(`${challengeId}:${code}`, 'utf8').digest());
}

export function verifyOtp(key: Uint8Array, challengeId: string, code: string, storedHmac: Uint8Array): boolean {
  if (!CODE_RE.test(code) || storedHmac.length !== 32) return false;
  return timingSafeEqual(otpHmac(key, challengeId, code), storedHmac);
}

/** `attempts` = failed attempts so far; refused once 5 are used or the challenge has expired. */
export function canAttempt(c: { attempts: number; expiresAt: Date; now: Date }): boolean {
  return c.attempts < OTP_MAX_ATTEMPTS && c.now.getTime() < c.expiresAt.getTime();
}
