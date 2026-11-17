// LD-81: LIMS mints the 1 h patient access JWT (the patient kind has no GoTrue session). EdDSA (Ed25519), node:crypto only, local key file only.
// Claims are exactly iss / aud / sub / session_id / aal / iat / exp. Header: alg EdDSA, typ JWT, kid.
//   LIMS_IDENTITY_PATIENT_JWT_KEY_FILE  path of an Ed25519 PRIVATE key (PEM, PKCS#8); never logged, never returned
//   LIMS_IDENTITY_PATIENT_JWT_KID       the key id put in the header, e.g. pat-2026-11 (LD-81 shape; the YYYY-MM is chosen by whoever rotates the key)
// Construction reads nothing; the key is read on first use and cached, so a module without the setting still boots, and every mint then fails
// closed with common.internal (the patient sign-in answers 500 instead of ever issuing an unsigned or weakly signed token).
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LimsError } from '../../../core/errors.js';

import { PATIENT_JWT_AUDIENCE, PATIENT_JWT_ISSUER } from '../../../core/auth/patient-jwt-verifier.js';
export { PATIENT_JWT_AUDIENCE, PATIENT_JWT_ISSUER };
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface PatientJwtClaims { sub: string; sessionId: string; aal: string; issuedAt: Date; expiresAt: Date }
type Env = Readonly<Record<string, string | undefined>>;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function createPatientJwtSigner(env: Env = process.env, readFile: (p: string) => Buffer = readFileSync): (c: PatientJwtClaims) => string {
  let loaded: { key: KeyObject; kid: string } | undefined;
  const load = (): { key: KeyObject; kid: string } => {
    if (loaded) return loaded;
    const file = env['LIMS_IDENTITY_PATIENT_JWT_KEY_FILE'];
    const kid = env['LIMS_IDENTITY_PATIENT_JWT_KID'];
    if (!file || !kid || !KID_RE.test(kid)) throw new LimsError('common.internal');
    try {
      const key = createPrivateKey(readFile(file));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
      loaded = { key, kid };
      return loaded;
    } catch {
      throw new LimsError('common.internal'); // unreadable / wrong-type key: no detail, no key material in the error
    }
  };
  return (c) => {
    const { key, kid } = load();
    const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    const body = b64u(JSON.stringify({
      iss: PATIENT_JWT_ISSUER, aud: PATIENT_JWT_AUDIENCE, sub: c.sub, session_id: c.sessionId, aal: c.aal,
      iat: Math.floor(c.issuedAt.getTime() / 1000), exp: Math.floor(c.expiresAt.getTime() / 1000),
    }));
    return `${head}.${body}.${b64u(sign(null, Buffer.from(`${head}.${body}`), key))}`;
  };
}
