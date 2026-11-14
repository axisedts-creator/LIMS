// @lims/shared-ts/crypto (02-TRD §3.1; 04 A9–A13 token sizes; 08 R24 sha256 bytea). CSPRNG only.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** base64url (no padding) of `bytes` CSPRNG bytes: 16 = 128-bit links/QR/reset, 32 = 256-bit device tokens. */
export function randomToken(bytes: 16 | 32): string {
  if (bytes !== 16 && bytes !== 32) throw new RangeError('randomToken: bytes must be 16 or 32');
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 digest bytes (32) — for `<name>_sha256 bytea` columns. Strings are hashed as UTF-8. */
export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(key: Uint8Array, input: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex');
}

/** Constant-time string equality. Both sides are hashed first so lengths never leak or throw. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** n uniform decimal digits (leading zeros kept); OTPs need n >= 6 (04 A9). */
export function randomDigits(n: number): string {
  if (!Number.isSafeInteger(n) || n < 6) throw new RangeError('randomDigits: n must be an integer >= 6');
  let s = '';
  for (let i = 0; i < n; i++) s += randomInt(10);
  return s;
}
