// LD-81 / CR-C16 draft: patient access JWT verification (auth/patient-jwt-verifier.ts) against tokens from the real identity signer.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatientJwtSigner } from '../../../modules/identity/service/patient-jwt.js';
import { createCompositeJwtVerifier, createPatientJwtVerifier, PATIENT_JWT_AUDIENCE, PATIENT_JWT_ISSUER } from '../patient-jwt-verifier.js';
import type { JwtVerifier } from '../jwt.js';

let dir: string; let privFile: string; let pubFile: string; let otherPriv: string; let rsaPub: string;
const NOW = 1_800_000_000_000;
const SUB = '01900000-0000-7000-8000-00000000d001', SID = '01900000-0000-7000-8000-00000000d002';
const claims = { sub: SUB, sessionId: SID, aal: 'aal1', issuedAt: new Date(NOW), expiresAt: new Date(NOW + 3_600_000) };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'patient-verify-'));
  const ed = generateKeyPairSync('ed25519');
  privFile = join(dir, 'priv.pem'); writeFileSync(privFile, ed.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  pubFile = join(dir, 'pub.pem'); writeFileSync(pubFile, createPublicKey(ed.privateKey).export({ type: 'spki', format: 'pem' }));
  otherPriv = join(dir, 'other.pem'); writeFileSync(otherPriv, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  rsaPub = join(dir, 'rsa.pem'); writeFileSync(rsaPub, generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const signer = (file = privFile) => createPatientJwtSigner({ LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: file, LIMS_IDENTITY_PATIENT_JWT_KID: 'pat-2026-11' });
const verifier = (now = NOW + 1000) => createPatientJwtVerifier({ keyFile: pubFile, now: () => now });
const code = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: any) => e))?.code;
// a token with arbitrary header/payload, signed with the real key (to test claim checks, not the signature)
const forge = (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' }) => {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url'), p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = createPrivateKey(readFileSync(privFile));
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
};
const good = { iss: PATIENT_JWT_ISSUER, aud: PATIENT_JWT_AUDIENCE, sub: SUB, session_id: SID, aal: 'aal1', iat: NOW / 1000, exp: NOW / 1000 + 3600 };

describe('createPatientJwtVerifier', () => {
  it('accepts a token from the identity signer and returns exactly sub / sessionId / aal / exp / iat', async () => {
    expect(await verifier().verify(signer()(claims))).toEqual({ sub: SUB, sessionId: SID, aal: 'aal1', exp: NOW / 1000 + 3600, iat: NOW / 1000 });
  });
  it('a token signed by a different key is auth.token_invalid', async () => {
    expect(await code(verifier().verify(signer(otherPriv)(claims)))).toBe('auth.token_invalid');
  });
  it('a tampered payload is auth.token_invalid', async () => {
    const [h, , s] = signer()(claims).split('.');
    const p = Buffer.from(JSON.stringify({ ...good, sub: 'someone-else' })).toString('base64url');
    expect(await code(verifier().verify(`${h}.${p}.${s}`))).toBe('auth.token_invalid');
  });
  it.each([
    ['wrong issuer', { ...good, iss: 'urn:lims:identity:staff' }],
    ['wrong audience', { ...good, aud: 'urn:lims:api:staff' }],
    ['aal2', { ...good, aal: 'aal2' }],
    ['no session_id', { ...good, session_id: undefined }],
    ['no sub', { ...good, sub: undefined }],
    ['iat far in the future', { ...good, iat: NOW / 1000 + 3600 }],
    ['no exp', { ...good, exp: undefined }],
    ['nbf in the future', { ...good, nbf: NOW / 1000 + 3600 }],
  ])('%s -> auth.token_invalid', async (_n, payload) => {
    expect(await code(verifier().verify(forge(payload)))).toBe('auth.token_invalid');
  });
  it('an expired token is auth.token_expired (strictly in the future, no leeway)', async () => {
    expect(await code(verifier(NOW + 3_600_000).verify(signer()(claims)))).toBe('auth.token_expired');
  });
  it('an array audience containing the patient audience is accepted', async () => {
    expect((await verifier().verify(forge({ ...good, aud: ['x', PATIENT_JWT_AUDIENCE] }))).sub).toBe(SUB);
  });
  it.each([['alg none', { alg: 'none' }], ['alg HS256', { alg: 'HS256' }], ['alg ES256', { alg: 'ES256' }], ['lower-case eddsa', { alg: 'eddsa' }], ['no alg', {}]])(
    'header %s -> auth.token_invalid', async (_n, header) => { expect(await code(verifier().verify(forge(good, header)))).toBe('auth.token_invalid'); });
  it.each(['', 'a.b', 'a.b.c.d', 'not a jwt', '...', 'x'.repeat(20_000)])('junk %#: auth.token_invalid', async (t) => {
    expect(await code(verifier().verify(t))).toBe('auth.token_invalid');
  });
  it('a header kid is never read (an unknown or hostile kid changes nothing)', async () => {
    expect((await verifier().verify(forge(good, { alg: 'EdDSA', kid: '../../etc/passwd', jku: 'https://evil.invalid' }))).sub).toBe(SUB);
  });
  it('boot fails on a missing file and on a non-Ed25519 key', () => {
    expect(() => createPatientJwtVerifier({ keyFile: join(dir, 'nope.pem') })).toThrow();
    expect(() => createPatientJwtVerifier({ keyFile: rsaPub })).toThrow(/Ed25519/);
  });
});

describe('createCompositeJwtVerifier', () => {
  const mark = (name: string): JwtVerifier & { seen: string[] } => { const seen: string[] = []; return { seen, async verify(t) { seen.push(t); throw Object.assign(new Error(name), { code: name }); } }; };
  it('without a patient verifier it is the primary itself', () => {
    const p = mark('primary'); expect(createCompositeJwtVerifier(p, undefined)).toBe(p);
  });
  it('EdDSA tokens go to the patient verifier only; everything else to the primary only', async () => {
    const primary = mark('primary'), patient = mark('patient'); const v = createCompositeJwtVerifier(primary, patient);
    expect(await code(v.verify(forge(good)))).toBe('patient');
    const rs = `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.e30.sig`;
    expect(await code(v.verify(rs))).toBe('primary');
    expect(primary.seen).toHaveLength(1); expect(patient.seen).toHaveLength(1);
  });
  it('an unparsable header goes to the primary, which rejects it', async () => {
    const primary = mark('primary'), patient = mark('patient'); const v = createCompositeJwtVerifier(primary, patient);
    for (const t of ['', 'x', '!!.!!.!!', '.e30.sig']) expect(await code(v.verify(t))).toBe('primary');
    expect(patient.seen).toHaveLength(0);
  });
  it('a patient token is rejected by a primary-only setup (the pinned alg)', async () => {
    const { createJwtVerifier } = await import('../jwt.js');
    const hsKey = join(dir, 'hs.key'); writeFileSync(hsKey, 'synthetic-hs256-secret-0123456789');
    const primary = createJwtVerifier({ alg: 'HS256', issuer: 'i', audience: 'a', keyFile: hsKey, now: () => NOW + 1000 });
    expect(await code(createCompositeJwtVerifier(primary, undefined).verify(signer()(claims)))).toBe('auth.token_invalid');
  });
});
