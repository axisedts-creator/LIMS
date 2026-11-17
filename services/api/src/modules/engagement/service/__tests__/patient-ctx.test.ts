// CR-C16 draft: a patient's membership id comes from ctx.actor.membershipId, never from ctx.actor.id (which is the patient's USER id, LD-81).
import { describe, expect, it } from 'vitest';
import { createAccountService } from '../account.service.js';
import { patientMembershipId } from '../patient-ctx.js';

const USER = '01900000-0000-7000-8000-00000000e001', MEM = '01900000-0000-7000-8000-00000000e002', T = '01900000-0000-7000-8000-00000000aaaa';

describe('patientMembershipId', () => {
  it('reads ctx.actor.membershipId', () => expect(patientMembershipId({ actor: { id: USER, membershipId: MEM } })).toBe(MEM));
  it('falls back to ctx.claims.membership_id (the older seam)', () => expect(patientMembershipId({ actor: { id: USER }, claims: { membership_id: MEM } })).toBe(MEM));
  it('actor.membershipId wins over claims', () => expect(patientMembershipId({ actor: { membershipId: MEM }, claims: { membership_id: 'other' } })).toBe(MEM));
  it('never returns the user id', () => expect(patientMembershipId({ actor: { id: USER } })).toBeUndefined());
  it.each([undefined, null, {}, { actor: { membershipId: 7 } }, { claims: { membership_id: {} } }])('non-string / missing -> undefined (%#)', (c) => {
    expect(patientMembershipId(c as never)).toBeUndefined();
  });
});

describe('account service finds the account by the MEMBERSHIP id', () => {
  const row = { id: '01900000-0000-7000-8000-00000000e003', phone_e164: '+9779800000000', status: 'active', reminders_opt_out: false, created_at: '2026-01-01T00:00:00Z', version: 1 };
  const ctx = (actor: Record<string, unknown>) => ({ tenantId: T, actor: { type: 'patient', ...actor }, tx: {}, now: () => '2026-01-01T00:00:00Z' }) as never;
  const svc = () => { const seen: string[] = []; const repo = { lockLiveByMembership: async (_t: unknown, a: { membershipId: string }) => { seen.push(a.membershipId); return row; } } as never; return { seen, s: createAccountService(repo) }; };

  it('a real patient request (user id + membership id) looks up by the membership id, not the user id', async () => {
    const { seen, s } = svc();
    expect((await s.get(ctx({ id: USER, membershipId: MEM }))).status).toBe(200);
    expect(seen).toEqual([MEM]);
  });
  it('the old seam without membershipId still works (actor.id used as before)', async () => {
    const { seen, s } = svc();
    await s.get(ctx({ id: MEM }));
    expect(seen).toEqual([MEM]);
  });
});
