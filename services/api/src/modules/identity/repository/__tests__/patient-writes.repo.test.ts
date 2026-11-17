// CR-C16 draft: patient-writes.repo.ts calls only the three DEFINER functions, binds only its own inputs, and fails closed.
import { describe, expect, it, vi } from 'vitest';
import { createPatientWritesRepo, sessionRow } from '../patient-writes.repo.js';

const T = '01900000-0000-7000-8000-00000000aaaa', ACC = '01900000-0000-7000-8000-0000000f0002', M = '01900000-0000-7000-8000-0000000f0003', U = '01900000-0000-7000-8000-0000000f0004';
const mk = (rows: any[] = []) => { const query = vi.fn(async () => ({ rows })); return { query, ctx: { tenantId: T, tx: { query } } as any }; };
const code = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: any) => e))?.code;
const session = () => ({
  id: '01900000-0000-7000-8000-0000000f0005', membershipId: M, userId: U, kind: 'patient' as const, tokenSha256: Buffer.alloc(32, 0xab), state: 'active' as const, aal: 'aal1' as const,
  appInstanceId: '01900000-0000-7000-8000-0000000f0006', appPlatform: 'android' as const, idleTimeoutMinutes: 20160, idleExpiresAt: new Date(2_000_000), absoluteExpiresAt: new Date(3_000_000),
  expiresAt: new Date(3_000_000), actorId: ACC, accessExpiresAt: new Date(2_500_000),
});

describe('createPatientMembership', () => {
  it('calls app.identity_patient_create_membership with the account id only and maps the row', async () => {
    const { query, ctx } = mk([{ membership_id: M, user_id: U }]);
    expect(await createPatientWritesRepo().createPatientMembership!(ctx, { accountId: ACC })).toEqual({ membershipId: M, userId: U });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('app.identity_patient_create_membership($1::uuid)'), [ACC]]);
  });
  it('an empty result is common.internal, not a made-up id', async () => {
    expect(await code(createPatientWritesRepo().createPatientMembership!(mk([]).ctx, { accountId: ACC }))).toBe('common.internal');
  });
  it('a DB error propagates (core maps it to 500)', async () => {
    const ctx = { tenantId: T, tx: { query: async () => { throw Object.assign(new Error('x'), { code: 'P0001' }); } } };
    await expect(createPatientWritesRepo().createPatientMembership!(ctx as any, { accountId: ACC })).rejects.toMatchObject({ code: 'P0001' });
  });
});

describe('insertPatientSession', () => {
  it('calls app.identity_patient_open_session once with the jsonb row of sessionRow()', async () => {
    const { query, ctx } = mk();
    await createPatientWritesRepo().insertPatientSession!(ctx, session());
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as unknown as [string, string[]];
    expect(sql).toContain('app.identity_patient_open_session($1::jsonb)');
    expect(JSON.parse(values[0]!)).toEqual(sessionRow(session(), T));
  });
  it('the row has the tenant of the ctx, kind patient, aal1, a bytea hex token hash and no secrets or GoTrue columns', () => {
    const r = sessionRow(session(), T);
    expect(r).toMatchObject({ tenant_id: T, kind: 'patient', state: 'active', aal: 'aal1', membership_id: M, user_id: U, app_platform: 'android', created_by: ACC, updated_by: ACC });
    expect(r['token_sha256']).toBe(`\\x${'ab'.repeat(32)}`);
    for (const k of ['gotrue_session_id', 'refresh_token_enc', 'access_token_enc', 'enc_key_id']) expect(r).not.toHaveProperty(k);
    expect(r['access_expires_at']).toBe(new Date(2_500_000).toISOString());
  });
  it('without a tx or tenant it is common.internal and nothing is written', async () => {
    expect(await code(createPatientWritesRepo().insertPatientSession!({ tenantId: T } as any, session()))).toBe('common.internal');
    expect(await code(createPatientWritesRepo().insertPatientSession!({ tx: { query: vi.fn() } } as any, session()))).toBe('common.internal');
  });
});

describe('patientMembership', () => {
  it('maps user id / status / locked from app.identity_patient_membership', async () => {
    const { query, ctx } = mk([{ user_id: U, status: 'active', locked: false }]);
    expect(await createPatientWritesRepo().patientMembership(ctx, { membershipId: M })).toEqual({ userId: U, status: 'active', locked: false });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('app.identity_patient_membership($1::uuid)'), [M]]);
  });
  it('no row = undefined; locked is true only for a true value', async () => {
    expect(await createPatientWritesRepo().patientMembership(mk([]).ctx, { membershipId: M })).toBeUndefined();
    expect((await createPatientWritesRepo().patientMembership(mk([{ user_id: U, status: 'active', locked: 'yes' }]).ctx, { membershipId: M }))!.locked).toBe(false);
  });
});
