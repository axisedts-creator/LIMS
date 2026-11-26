// CR-C17-017: the job applicant credential is its own credential, apart from the patient pre-auth one.
import { describe, expect, it } from 'vitest';
import { FIXED_ACTOR_PERMISSIONS } from '../../../../../../../contracts/ports/generated/permissions.js';
import { buildAuthResolverClaims } from '../../../../core/auth/claims.js';
import { AUTH_RESOLVER_OWNERS } from '../../../../core/module.js';
import { applicantPreAuth } from '../../auth/applicant.resolver.js';
import { manifest } from '../../index.js';

const TENANT = '01a1a98a-ac40-7000-8000-0000000000a1';
const tx = (row?: Record<string, unknown>) => {
  const calls: unknown[][] = [];
  return { calls, query: async (text: string, values: unknown[]) => { calls.push([text, values]); return { rows: row ? [row] : [] }; } };
};

describe('applicantPreAuth resolver', () => {
  it('t.<code> of an active tenant -> patient-type actor with stage job_applicant, a fresh id each call', async () => {
    const db = tx({ tenant_id: TENANT, status: 'active' });
    const a = (await applicantPreAuth.resolve('t.demo_lab', db)) as any;
    const b = (await applicantPreAuth.resolve('t.demo_lab', db)) as any;
    expect(a).toMatchObject({ tenantId: TENANT, actor: { type: 'patient' }, extraClaims: { patient_stage: 'job_applicant' } });
    expect(a.actor.id).not.toBe(b.actor.id);
    expect(db.calls[0]).toEqual(['SELECT * FROM app.core_resolve_tenant_code($1)', ['demo_lab']]);
  });

  it.each(['', 'demo_lab', 't.', 't.AB', 't.a', "t.demo'; DROP TABLE x;--", 'c.demo_lab.' + 'A'.repeat(43), 't.demo_lab ', 't.demo_lab\n'])(
    'malformed or foreign credential %j is refused without a database round trip', async (cred) => {
      const db = tx({ tenant_id: TENANT, status: 'active' });
      expect(await applicantPreAuth.resolve(cred, db)).toBeUndefined();
      expect(db.calls).toHaveLength(0);
    });

  it('unknown or suspended tenant is refused', async () => {
    expect(await applicantPreAuth.resolve('t.demo_lab', tx())).toBeUndefined();
    expect(await applicantPreAuth.resolve('t.demo_lab', tx({ tenant_id: TENANT, status: 'suspended' }))).toBeUndefined();
    expect(await applicantPreAuth.resolve(42 as unknown as string, tx())).toBeUndefined();
  });
});

describe('applicant credential wiring', () => {
  it('homecollection owns the resolver and supplies it', () => {
    expect(AUTH_RESOLVER_OWNERS['applicantPreAuth']).toBe('homecollection');
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual(['applicantPreAuth']);
  });

  it('homecollection may set patient_stage and nothing else', () => {
    const ok = { tenantId: TENANT, actor: { type: 'patient', id: 'x' } };
    expect(buildAuthResolverClaims('homecollection', { ...ok, extraClaims: { patient_stage: 'job_applicant' } })).toMatchObject({ actor_type: 'patient', patient_stage: 'job_applicant' });
    for (const k of ['membership_id', 'account_id', 'scope', 'device_kind', 'otp_token_sha256']) {
      expect(() => buildAuthResolverClaims('homecollection', { ...ok, extraClaims: { [k]: 'x' } })).toThrow();
    }
  });

  it('permission sets: the applicant holds one permission; patient pre-auth is unchanged and separate', () => {
    expect(FIXED_ACTOR_PERMISSIONS.job_applicant_pre_auth).toEqual(['homecollection.application.submit']);
    expect(FIXED_ACTOR_PERMISSIONS.patient_pre_auth).toEqual(['engagement.auth.challenge']);
    expect(FIXED_ACTOR_PERMISSIONS.patient).not.toContain('homecollection.application.submit');
  });
});
