// GoTrue access-token verification (02-TRD §6.5; REQ-SEC-066/067/128; 04 A7). node:crypto only, local key file only.
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AuthError } from './errors.js';

export const JWT_ALGS = ['HS256', 'ES256', 'RS256'] as const;
export type JwtAlg = (typeof JWT_ALGS)[number];

/** C2 02-TRD §6.1. */
export interface VerifiedJwt {
  readonly sub: string;
  readonly sessionId: string;
  readonly aal: 'aal1' | 'aal2';
  readonly exp: number;
  readonly iat: number;
}
export interface JwtVerifier {
  verify(token: string): Promise<VerifiedJwt>;
}
export interface JwtVerifierOptions {
  readonly alg: JwtAlg;
  readonly issuer: string;
  readonly audience: string;
  readonly keyFile: string;
  /** ms since epoch; injectable for tests */
  readonly now?: () => number;
}

const SKEW_MS = 60_000; // nbf/iat clock skew [CONV] (02-TRD §6.5)
const MAX_TOKEN = 16_384; // [CONV] far above any GoTrue token; bounds work on junk input
const B64U = /^[A-Za-z0-9_-]+$/;

const invalid = () => new AuthError('auth.token_invalid');

function loadKey(alg: JwtAlg, file: string): Buffer | KeyObject {
  const raw = readFileSync(file); // throws on a missing file: boot fails, no fallback
  if (alg === 'HS256') {
    const secret = Buffer.from(raw.toString('utf8').replace(/\r?\n$/, ''), 'utf8'); // [CONV] one trailing newline of a secret mount is not key material
    if (secret.length === 0) throw new Error(`jwt: key file for ${alg} is empty`);
    return secret;
  }
  const key = createPublicKey(raw); // throws on a non-key file
  const ok = alg === 'ES256'
    ? key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
    : key.asymmetricKeyType === 'rsa';
  if (!ok) throw new Error(`jwt: key file is not a ${alg} public key`);
  return key;
}

function json(seg: string): Record<string, unknown> {
  const v: unknown = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function createJwtVerifier(o: JwtVerifierOptions): JwtVerifier {
  if (!(JWT_ALGS as readonly string[]).includes(o.alg)) throw new Error('jwt: alg must be one of HS256|ES256|RS256');
  if (!isStr(o.issuer) || !isStr(o.audience)) throw new Error('jwt: issuer and audience are required');
  const { alg, issuer, audience } = o;
  const key = loadKey(alg, o.keyFile);
  const now = o.now ?? Date.now;

  function signatureOk(input: string, sig: Buffer): boolean {
    if (alg === 'HS256') {
      const mac = createHmac('sha256', key as Buffer).update(input).digest();
      return sig.length === mac.length && timingSafeEqual(sig, mac);
    }
    if (alg === 'ES256') {
      return sig.length === 64 && cryptoVerify('sha256', Buffer.from(input), { key: key as KeyObject, dsaEncoding: 'ieee-p1363' }, sig);
    }
    return cryptoVerify('RSA-SHA256', Buffer.from(input), key as KeyObject, sig);
  }

  function check(token: unknown): VerifiedJwt {
    if (typeof token !== 'string' || token.length > MAX_TOKEN) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => B64U.test(p))) throw invalid();
    const [h, p, s] = parts as [string, string, string];
    const header = json(h);
    if (header.alg !== alg) throw invalid(); // exact pinned alg: none/None/other/lower-case/missing/non-string all fail (REQ-SEC-066)
    // jku/jwk/x5u/kid are never read: the key is the local file only (REQ-SEC-128)
    if (!signatureOk(`${h}.${p}`, Buffer.from(s, 'base64url'))) throw invalid();

    const c = json(p);
    const t = now();
    if (c.iss !== issuer) throw invalid();
    const aud = c.aud;
    if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) throw invalid();
    if (!isStr(c.sub) || !isStr(c.session_id)) throw invalid(); // no session_id -> 401 (AC-0D-2.2a)
    if (c.aal !== 'aal1' && c.aal !== 'aal2') throw invalid();
    if (!isNum(c.iat) || c.iat * 1000 > t + SKEW_MS) throw invalid();
    if (c.nbf !== undefined && (!isNum(c.nbf) || c.nbf * 1000 > t + SKEW_MS)) throw invalid();
    if (!isNum(c.exp)) throw invalid();
    if (c.exp * 1000 <= t) throw new AuthError('auth.token_expired'); // strictly in the future, 0 s leeway (04 A7)
    // Every other claim (tenant_id, role, app_metadata, ...) is dropped here (REQ-SEC-067).
    return { sub: c.sub, sessionId: c.session_id, aal: c.aal, exp: c.exp, iat: c.iat };
  }

  return {
    async verify(token) {
      try {
        return check(token);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        throw invalid(); // JSON/base64/crypto errors on hostile input
      }
    },
  };
}
