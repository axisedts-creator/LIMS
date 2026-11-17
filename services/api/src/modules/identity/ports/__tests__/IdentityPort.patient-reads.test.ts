// CR-C16 draft: openPatientSession reads the membership through repo.patientMembership (DEFINER; RLS hides core.memberships from a patient actor)
// and hands the access JWT expiry to the session row. The staff-shaped read (repo.membership) is not used when the pre-auth read exists.
import { describe, expect, it, vi } from 'vitest';
import { createIdentityPort } from '../IdentityPort.impl.js';
import { makeFakeRepo, makeCtx, mid } from './helpers';

const NOW = 1_000_000, H = 3_600_000;
const APP = '01900000-0000-7000-8000-0000000f0001';
const code = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: any) => e))?.code;

function setup(read: { userId: string; status: string; locked: boolean } | undefined) {
  const f = makeFakeRepo({ members: [] });
  const inserted: any[] = []; const membershipCalls = vi.fn();
  const repo: any = { ...f.repo,
    membership: async (...a: any[]) => { membershipCalls(...a); return undefined; },
    patientMembership: vi.fn(async () => read),
    insertPatientSession: async (_c: any, s: any) => { inserted.push(s); },
  };
  const mint = vi.fn(() => 'JWT');
  const port: any = createIdentityPort({ repo, systemActorPermissions: () => [], nowMs: () => NOW, mintPatientAccessToken: mint } as any);
  const ctx = makeCtx('A', 'patient', 'pre'); f.st.claims.set(ctx.actor.id, { aal: 'aal1', patient_stage: 'pre_auth' });
  return { port, ctx, repo, inserted, membershipCalls, mint };
}
const OPEN = { membershipId: mid(20) as any, appInstanceId: APP as any, appPlatform: 'android' as const };

describe('openPatientSession with the pre-auth DEFINER read', () => {
  it('uses patientMembership, never repo.membership, and signs for the user id it returned', async () => {
    const s = setup({ userId: mid(0x2020), status: 'active', locked: false });
    const r = await s.port.openPatientSession(s.ctx, OPEN);
    expect(s.repo.patientMembership).toHaveBeenCalledWith(s.ctx, { membershipId: mid(20) });
    expect(s.membershipCalls).not.toHaveBeenCalled();
    expect(s.inserted[0]).toMatchObject({ membershipId: mid(20), userId: mid(0x2020), kind: 'patient', aal: 'aal1' });
    expect(s.mint.mock.calls[0]![0]).toMatchObject({ sub: mid(0x2020), aal: 'aal1' });
    expect(r.accessToken).toBe('JWT');
  });
  it('the session row carries the access JWT expiry (now + 1 h), equal to the minted exp and to accessExpiresAt of the result', async () => {
    const s = setup({ userId: mid(0x2020), status: 'active', locked: false });
    const r = await s.port.openPatientSession(s.ctx, OPEN);
    expect(s.inserted[0].accessExpiresAt).toEqual(new Date(NOW + H));
    expect(s.mint.mock.calls[0]![0].expiresAt).toEqual(new Date(NOW + H));
    expect(r.accessExpiresAt).toBe(new Date(NOW + H).toISOString());
  });
  it('unknown membership -> common.not_found, nothing inserted, nothing minted', async () => {
    const s = setup(undefined);
    expect(await code(s.port.openPatientSession(s.ctx, OPEN))).toBe('common.not_found');
    expect(s.inserted).toHaveLength(0); expect(s.mint).not.toHaveBeenCalled();
  });
  it.each([['deactivated', 'deactivated', false], ['invited', 'invited', false], ['locked', 'active', true]])('%s membership -> identity.membership_inactive', async (_n, status, locked) => {
    const s = setup({ userId: mid(0x2020), status, locked });
    expect(await code(s.port.openPatientSession(s.ctx, OPEN))).toBe('identity.membership_inactive');
    expect(s.inserted).toHaveLength(0); expect(s.mint).not.toHaveBeenCalled();
  });
  it('a signer that fails closed (no key) stops the sign-in after the insert attempt rolls back with the request: error propagates, no token returned', async () => {
    const f = makeFakeRepo({ members: [] });
    const repo: any = { ...f.repo, patientMembership: async () => ({ userId: mid(0x2020), status: 'active', locked: false }), insertPatientSession: async () => undefined };
    const port: any = createIdentityPort({ repo, systemActorPermissions: () => [], nowMs: () => NOW,
      mintPatientAccessToken: () => { throw Object.assign(new Error('x'), { code: 'common.internal' }); } } as any);
    const ctx = makeCtx('A', 'patient', 'pre'); f.st.claims.set(ctx.actor.id, { aal: 'aal1', patient_stage: 'pre_auth' });
    expect(await code(port.openPatientSession(ctx, OPEN))).toBe('common.internal');
  });
});
