// LD-81 / CR-C16 draft: verification of the patient access JWT that identity mints (EdDSA, Ed25519; modules/identity/service/patient-jwt.ts).
// Same rules as auth/jwt.ts: node:crypto only, local public key file only (kid / jku / jwk / x5u are never read), exact pinned alg,
// exact issuer and audience, every claim except sub / session_id / aal / iat / exp dropped. Patient tokens are aal1 only (sessions__patient_aal__ck).
// Optional: only built when LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE is set; otherwise a patient token is simply an unknown token (401).
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AuthError } from './errors.js';
import type { JwtVerifier, VerifiedJwt } from './jwt.js';

export const PATIENT_JWT_ISSUER = 'urn:lims:identity:patient';
export const PATIENT_JWT_AUDIENCE = 'urn:lims:api:patient';

const SKEW_MS = 60_000;
const MAX_TOKEN = 16_384;
const B64U = /^[A-Za-z0-9_-]+$/;
const invalid = () => new AuthError('auth.token_invalid');
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function json(seg: string): Record<string, unknown> {
  const v: unknown = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
}

export function createPatientJwtVerifier(o: { readonly keyFile: string; readonly now?: () => number }): JwtVerifier {
  const key: KeyObject = createPublicKey(readFileSync(o.keyFile)); // throws on a missing / garbage file: boot fails, no fallback
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('jwt: patient key file is not an Ed25519 public key');
  const now = o.now ?? Date.now;

  function check(token: unknown): VerifiedJwt {
    if (typeof token !== 'string' || token.length > MAX_TOKEN) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => B64U.test(p))) throw invalid();
    const [h, p, s] = parts as [string, string, string];
    if (json(h).alg !== 'EdDSA') throw invalid();
    if (!cryptoVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw invalid();
    const c = json(p);
    const t = now();
    if (c.iss !== PATIENT_JWT_ISSUER) throw invalid();
    const aud = c.aud;
    if (!(aud === PATIENT_JWT_AUDIENCE || (Array.isArray(aud) && aud.includes(PATIENT_JWT_AUDIENCE)))) throw invalid();
    if (!isStr(c.sub) || !isStr(c.session_id)) throw invalid();
    if (c.aal !== 'aal1') throw invalid();
    if (!isNum(c.iat) || c.iat * 1000 > t + SKEW_MS) throw invalid();
    if (c.nbf !== undefined && (!isNum(c.nbf) || c.nbf * 1000 > t + SKEW_MS)) throw invalid();
    if (!isNum(c.exp)) throw invalid();
    if (c.exp * 1000 <= t) throw new AuthError('auth.token_expired');
    return { sub: c.sub, sessionId: c.session_id, aal: 'aal1', exp: c.exp, iat: c.iat };
  }

  return {
    async verify(token) {
      try { return check(token); } catch (e) {
        if (e instanceof AuthError) throw e;
        throw invalid();
      }
    },
  };
}

/** Routes a token by the header's `alg` only: EdDSA -> the patient verifier, everything else -> the pinned primary (which rejects any other alg). */
export function createCompositeJwtVerifier(primary: JwtVerifier, patient: JwtVerifier | undefined): JwtVerifier {
  if (!patient) return primary;
  return {
    verify(token) {
      let alg: unknown;
      try {
        const first = typeof token === 'string' ? token.split('.')[0] : undefined;
        alg = first && B64U.test(first) ? json(first).alg : undefined;
      } catch { alg = undefined; }
      return (alg === 'EdDSA' ? patient : primary).verify(token);
    },
  };
}
