// T1 test helpers: JWT decode, RFC 6238 TOTP, mapping.md verdict reader. No implementation code here.
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const GOTRUE_DIR = resolve(here, '..');
export const MAPPING_MD = resolve(GOTRUE_DIR, 'mapping.md');
export const REPO_ROOT = resolve(here, '../../../../../../..');
export const CR_DIR = resolve(REPO_ROOT, '.orchestra/cr');

export const PINNED_VERSION = 'v2.197.0'; // infra/compose/supabase/upstream/docker-compose.yml

export function jwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238, SHA-1, 6 digits, 30 s step. `offsetSteps` shifts the window (e.g. -3 = a code that must be stale). */
export function totp(secretBase32: string, atMs = Date.now(), offsetSteps = 0): string {
  const counter = Math.floor(atMs / 1000 / 30) + offsetSteps;
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let seq = 0;
export const uniqueEmail = (tag = 'u') => `t1-${tag}-${Date.now().toString(36)}-${(seq++).toString(36)}@lims-test.example`;
/** 12+ chars (LIMS min length 12, 07-SECURITY AU-T4), synthetic. */
export const goodPassword = () => `Zq7-${Math.random().toString(36).slice(2, 10)}-Lims!`;

export type VerdictKey =
  | 'AAL_CLAIM' | 'SESSION_ID_CLAIM' | 'REFRESH_ROTATION' | 'REFRESH_REUSE' | 'TOKEN_HASH_VERIFY'
  | 'ADMIN_CREATE' | 'ADMIN_FIND' | 'ADMIN_SIGNOUT' | 'FACTOR_DELETE' | 'PASSWORD_MIN_LENGTH'
  | 'LINK_TTL_LE_60MIN' | 'D218_A_CREATE_WITHOUT_EMAIL' | 'D218_B_CREDENTIALLESS_SESSION';
export const VERDICT_KEYS: readonly VerdictKey[] = [
  'AAL_CLAIM', 'SESSION_ID_CLAIM', 'REFRESH_ROTATION', 'REFRESH_REUSE', 'TOKEN_HASH_VERIFY',
  'ADMIN_CREATE', 'ADMIN_FIND', 'ADMIN_SIGNOUT', 'FACTOR_DELETE', 'PASSWORD_MIN_LENGTH',
  'LINK_TTL_LE_60MIN', 'D218_A_CREATE_WITHOUT_EMAIL', 'D218_B_CREDENTIALLESS_SESSION',
];

export function readMapping(): string {
  if (!existsSync(MAPPING_MD)) throw new Error(`missing ${MAPPING_MD}`);
  return readFileSync(MAPPING_MD, 'utf8');
}

/** Verdict line format inside mapping.md:  `- KEY: CONFIRMED — evidence`  or  `- KEY: REFUTED — evidence`. */
export function readVerdicts(md = readMapping()): Partial<Record<VerdictKey, 'CONFIRMED' | 'REFUTED'>> {
  const out: Partial<Record<VerdictKey, 'CONFIRMED' | 'REFUTED'>> = {};
  for (const k of VERDICT_KEYS) {
    const m = new RegExp(`^\\s*[-*]\\s*\`?${k}\`?\\s*:\\s*(CONFIRMED|REFUTED)\\b`, 'm').exec(md);
    if (m) out[k] = m[1] as 'CONFIRMED' | 'REFUTED';
  }
  return out;
}
