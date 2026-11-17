// LD-81 patient access JWT signer (service/patient-jwt.ts): EdDSA, exact claims, fail-closed configuration.
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatientJwtSigner, PATIENT_JWT_AUDIENCE, PATIENT_JWT_ISSUER } from '../patient-jwt.js';

let dir: string; let edKey: string; let rsaKey: string; let edPub: ReturnType<typeof createPublicKey>;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'patient-jwt-'));
  const ed = generateKeyPairSync('ed25519');
  edKey = join(dir, 'ed.pem'); writeFileSync(edKey, ed.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  edPub = createPublicKey(ed.privateKey);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsaKey = join(dir, 'rsa.pem'); writeFileSync(rsaKey, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const claims = { sub: '01900000-0000-7000-8000-00000000c001', sessionId: '01900000-0000-7000-8000-00000000c002', aal: 'aal1', issuedAt: new Date(1_800_000_000_000), expiresAt: new Date(1_800_003_600_000) };
const env = (over: Record<string, string | undefined> = {}) => ({ LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: edKey, LIMS_IDENTITY_PATIENT_JWT_KID: 'pat-2026-11', ...over });
const code = (f: () => unknown) => { try { f(); } catch (e: any) { return e?.code; } return undefined; };
const parts = (t: string) => t.split('.') as [string, string, string];
const json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

describe('createPatientJwtSigner', () => {
  it('signs an EdDSA JWT whose signature verifies with the public key', () => {
    const [h, b, s] = parts(createPatientJwtSigner(env())(claims));
    expect(verify(null, Buffer.from(`${h}.${b}`), edPub, Buffer.from(s, 'base64url'))).toBe(true);
  });
  it('header is exactly { alg: EdDSA, typ: JWT, kid }', () => {
    expect(json(parts(createPatientJwtSigner(env())(claims))[0])).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'pat-2026-11' });
  });
  it('claims are exactly iss / aud / sub / session_id / aal / iat / exp (seconds)', () => {
    expect(json(parts(createPatientJwtSigner(env())(claims))[1])).toEqual({
      iss: PATIENT_JWT_ISSUER, aud: PATIENT_JWT_AUDIENCE, sub: claims.sub, session_id: claims.sessionId, aal: 'aal1', iat: 1_800_000_000, exp: 1_800_003_600,
    });
  });
  it('issuer and audience are the LD-81 / CR-C2-T31 constants', () => {
    expect([PATIENT_JWT_ISSUER, PATIENT_JWT_AUDIENCE]).toEqual(['urn:lims:identity:patient', 'urn:lims:api:patient']);
  });
  it('a tampered payload no longer verifies', () => {
    const [h, , s] = parts(createPatientJwtSigner(env())(claims));
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'x' })).toString('base64url');
    expect(verify(null, Buffer.from(`${h}.${forged}`), edPub, Buffer.from(s, 'base64url'))).toBe(false);
  });
  it('reads the key lazily and once: constructing without settings does not throw; a later mint does', () => {
    const sign = createPatientJwtSigner({});
    expect(code(() => sign(claims))).toBe('common.internal');
  });
  it.each([
    ['no key file', { LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: undefined }],
    ['no kid', { LIMS_IDENTITY_PATIENT_JWT_KID: undefined }],
    ['kid with a space', { LIMS_IDENTITY_PATIENT_JWT_KID: 'pat 2026' }],
    ['kid too long', { LIMS_IDENTITY_PATIENT_JWT_KID: 'k'.repeat(65) }],
    ['missing file', { LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: '/nonexistent/key.pem' }],
    ['an RSA key instead of Ed25519', () => ({ LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: rsaKey })],
  ])('fails closed with common.internal: %s', (_n, over) => {
    const o = typeof over === 'function' ? over() : over;
    expect(code(() => createPatientJwtSigner(env(o))(claims))).toBe('common.internal');
  });
  it('the error never carries key material or the file path', () => {
    let msg = '';
    try { createPatientJwtSigner(env({ LIMS_IDENTITY_PATIENT_JWT_KEY_FILE: rsaKey }))(claims); } catch (e: any) { msg = String(e?.message ?? ''); }
    expect(msg).not.toContain('PRIVATE'); expect(msg).not.toContain(rsaKey);
  });
});
