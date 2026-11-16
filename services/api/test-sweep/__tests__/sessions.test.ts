// T0B-SWEEP-1: session kinds + per-run signing key. Implementation: services/api/test-sweep/sessions.ts
// export const SESSION_KINDS: readonly string[]  // exactly the seven kinds below, in this order
// export function createRunKey(): { publicKeyPem: string; sign(claims: Record<string, unknown>): string }  // ES256, generated in memory per call, never written to disk
import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createRunKey, SESSION_KINDS } from '../sessions.js';

describe('session kinds (done_when 3)', () => {
  it('lists the seven kinds', () => {
    expect([...SESSION_KINDS]).toEqual([
      'platform_superadmin_aal2', 'platform_support_aal1', 'tenant_corp_admin', 'tenant_narrow', 'partner', 'patient', 'mobile_staff',
    ]);
  });
});

describe('per-run test JWT key', () => {
  it('signs ES256 tokens that verify with its public key, and differs per run', () => {
    const a = createRunKey();
    const b = createRunKey();
    expect(a.publicKeyPem).not.toBe(b.publicKeyPem);
    const tok = a.sign({ sub: '00000000-0000-4000-8000-000000000001', aud: 'authenticated' });
    const [h, p, s] = tok.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString()).alg).toBe('ES256');
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString()).aud).toBe('authenticated');
    const check = (pem: string): boolean =>
      verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(pem), dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
    expect(check(a.publicKeyPem)).toBe(true);
    expect(check(b.publicKeyPem)).toBe(false);
  });
  it('leaves no key material in the working tree', () => {
    createRunKey();
    const out = execFileSync('git', ['status', '--porcelain', '--', '*.pem', '*.key'], { encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
});
