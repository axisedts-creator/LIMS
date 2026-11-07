// Password policy (01-PRD AC-A6.1–A6.3; 05-SCHEMA §4.6 password_min_length 12–64; 04 A3; REQ-SEC-060). Pure.
import { createHash } from 'node:crypto';

export const MAX_PASSWORD_BYTES = 72; // bcrypt input limit, measured on UTF-8 bytes (AC-A6.2)
export const DEFAULT_MIN_PASSWORD_LENGTH = 12; // floor; a tenant setting can raise it, never lower it (04 A3)

const VIOLATION = 'auth.password_policy_violation' as const;

export type PolicyResult =
  | { ok: true }
  | { ok: false; code: typeof VIOLATION; reason: 'too_short' | 'too_long_bytes' };

export type EvaluateResult = { ok: true } | { ok: false; code: typeof VIOLATION | 'auth.password_breached' };

// Length counts code points (an astral emoji is one character); the string is taken as given (no normalisation).
export function checkPasswordPolicy(password: string, opts: { minLength?: number } = {}): PolicyResult {
  if (typeof password !== 'string') return { ok: false, code: VIOLATION, reason: 'too_short' };
  const min = Math.max(DEFAULT_MIN_PASSWORD_LENGTH, opts.minLength ?? DEFAULT_MIN_PASSWORD_LENGTH);
  if ([...password].length < min) return { ok: false, code: VIOLATION, reason: 'too_short' };
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return { ok: false, code: VIOLATION, reason: 'too_long_bytes' };
  return { ok: true };
}

// Policy first; the breached lookup (local list, SHA-1 of UTF-8 bytes) runs only for a policy-valid password.
// Lookup errors propagate (fail closed).
export async function evaluatePassword(
  password: string,
  opts: { minLength?: number; isBreached: (sha1: Buffer) => Promise<boolean> },
): Promise<EvaluateResult> {
  const policy = checkPasswordPolicy(password, opts.minLength === undefined ? {} : { minLength: opts.minLength });
  if (!policy.ok) return { ok: false, code: policy.code };
  const sha1 = createHash('sha1').update(password, 'utf8').digest();
  return (await opts.isBreached(sha1)) ? { ok: false, code: 'auth.password_breached' } : { ok: true };
}
