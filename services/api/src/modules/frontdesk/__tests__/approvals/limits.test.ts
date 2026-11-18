// T0B-FINCTRL-1 (LD-321, LD-310) done_when (3) LIMITS, in the frontdesk discount approval service (additive): requestDiscountApproval computes within_limit from the REQUESTER's limit
// (basis points and paisa per bill); a discount within the limit and with a reason is recorded without a second person; a discount above it needs approval by a person whose authority
// covers the amount and who is not the requester; without a reason_code it is refused while the tenant setting require_discount_reason is on (default on).
// The existing FD-T07 approval tests (request.test.ts, decide.test.ts, ...) stay green UNCHANGED: they run with requesters that have no limit row, so none of this applies to them.
// Real PG17 under RLS. Fails now: DiscountApproval carries no within_limit and approveDiscount checks no authority.
// PINS (CONV, none is in the contract text; the writer may dispute through the ruling path):
//   - the limit of the requester = the ACTIVE billing.user_discount_limit row of core.memberships.user_id of the requesting membership; NO active row = no tenant policy for that user:
//     within_limit is absent and the legacy flow (pending, any holder of frontdesk.discount.approve) is unchanged (that is what keeps the existing tests green);
//   - with a limit row: within_limit = (sum of amount-kind discounts <= max_discount_paisa) AND (sum of percent-kind bp <= max_discount_bp) (F15 knows no gross, so bp is compared as given);
//   - within_limit true -> the approval is recorded as status 'approved' at once with NO decided_by (the DB check allows a NULL decider) and is returned with within_limit true;
//   - within_limit false -> status 'pending'; approveDiscount then needs an ACTIVE billing.discount_authority of the approver's user with max_discount_paisa >= amount and
//     max_discount_bp >= bp, else 403 auth.forbidden (the requester himself keeps frontdesk.discount_self_approval_forbidden);
//   - require_discount_reason comes from IdentityPort.getTenantSettings (absent = true); off lets the top level reason_code be omitted.
import { describe, expect, it } from 'vitest';
import { person } from '../../../billing/__tests__/finctrl/kit.js';
import { seed } from '../registration/helpers.js';
import { APPROVER, CENTRE, REQUESTER, T, TENANT_A, approvalRow, approve, approveFails, getApproval, hex64, request, requestFails, seedPatient, uid, type Who } from './helpers.js';

const pct = (bp: number) => ({ scope: 'bill', kind: 'percent', percent_bp: bp, reason_code: 'staff_family' });
const amt = (paisa: number) => ({ scope: 'bill', kind: 'amount', amount_paisa: paisa, reason_code: 'staff_family' });
const limitRow = (userId: string, bp: number, paisa: number, active = true) => seed('billing.user_discount_limit', { id: uid(), tenant_id: TENANT_A, user_id: userId, max_discount_bp: bp, max_discount_paisa: paisa, is_active: active, created_by: uid(), updated_by: uid() });
const authorityRow = (userId: string, bp: number, paisa: number, active = true) => seed('billing.discount_authority', { id: uid(), tenant_id: TENANT_A, user_id: userId, max_discount_bp: bp, max_discount_paisa: paisa, is_active: active, created_by: uid(), updated_by: uid() });

/** A fresh front desk requester (own user + membership) so no shared actor of the other suites ever gets a limit row. */
async function requester(limit?: { bp: number; paisa: number; active?: boolean }, over: Partial<Who> = {}): Promise<Who> {
  const p = await person(TENANT_A);
  if (limit) await limitRow(p.userId, limit.bp, limit.paisa, limit.active ?? true);
  return { ...REQUESTER, membershipId: p.membershipId, displayName: 'Synthetic Limited Front desk (SYNTHETIC)', ...over };
}
/** A fresh approver at aal2, with an authority when given. */
async function approver(authority?: { bp: number; paisa: number; active?: boolean }): Promise<Who & { userId: string }> {
  const p = await person(TENANT_A);
  if (authority) await authorityRow(p.userId, authority.bp, authority.paisa, authority.active ?? true);
  return { ...APPROVER, membershipId: p.membershipId, displayName: 'Synthetic Authority Finance (SYNTHETIC)', userId: p.userId };
}
async function ask(who: Who, discounts: unknown[], over: Record<string, unknown> = {}) {
  const patient = await seedPatient('a');
  const body: Record<string, unknown> = { centre_id: CENTRE.a, base_fingerprint: hex64(), discounts, reason_code: 'staff_family', patient_ref: { patient_id: patient.id }, ...over };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return request(body, who);
}

describe('within_limit is computed from the requester limit', () => {
  it('amount and percent inside the limit: 201, status approved at once, no decider, within_limit true; the row agrees', async () => {
    const who = await requester({ bp: 1000, paisa: 50_000 });
    const r = await ask(who, [amt(40_000), pct(800)]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'approved', within_limit: true, requested_by: { membership_id: who.membershipId } });
    expect(r.body).not.toHaveProperty('decided_by');
    expect(await approvalRow(r.body.id)).toMatchObject({ status: 'approved', decided_by_membership_id: null, requested_by_membership_id: who.membershipId });
    expect(Number.isSafeInteger(r.body.computed_discount.amount_paisa)).toBe(true);
  }, T);

  it('exactly on the limit is inside (<=): paisa == max and bp == max', async () => {
    const who = await requester({ bp: 1000, paisa: 50_000 });
    expect((await ask(who, [amt(50_000)])).body).toMatchObject({ within_limit: true, status: 'approved' });
    expect((await ask(who, [pct(1000)])).body).toMatchObject({ within_limit: true, status: 'approved' });
  }, T);

  it.each<[string, unknown[]]>([
    ['one paisa above the paisa limit', [amt(50_001)]], ['one basis point above the bp limit', [pct(1001)]], ['paisa fine but bp above', [amt(1), pct(2000)]],
    ['bp fine but the amounts add up above the paisa limit', [amt(30_000), amt(20_001), pct(10)]], ['the bp of two percent discounts add up above the limit', [pct(600), pct(401)]],
  ])('%s: within_limit false, status pending, a second person is needed', async (_n, discounts) => {
    const who = await requester({ bp: 1000, paisa: 50_000 });
    const r = await ask(who, discounts);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', within_limit: false });
    expect(await approvalRow(r.body.id)).toMatchObject({ status: 'pending', decided_by_membership_id: null });
  }, T);

  it('a zero limit allows no discount at all; getDiscountApproval returns the same within_limit as the request', async () => {
    const who = await requester({ bp: 0, paisa: 0 });
    const r = await ask(who, [amt(1)]);
    expect(r.body).toMatchObject({ status: 'pending', within_limit: false });
    const again = await getApproval(r.body.id, who);
    expect(again.body).toMatchObject({ id: r.body.id, within_limit: false });
    const ok1 = await requester({ bp: 500, paisa: 500 });
    const w = await ask(ok1, [pct(500)]);
    expect((await getApproval(w.body.id, ok1)).body).toMatchObject({ within_limit: true, status: 'approved' });
  }, T);

  it('no active limit row (never set, or switched off) = no tenant policy for that user: within_limit absent, the legacy pending flow, any approver', async () => {
    for (const who of [await requester(), await requester({ bp: 10, paisa: 10, active: false })]) {
      const r = await ask(who, [pct(3000)]);
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('pending');
      expect(r.body).not.toHaveProperty('within_limit');
      expect((await approve(r.body.id, '"1"', {}, APPROVER)).body.status).toBe('approved');          // the shared approver has no authority row: unchanged behaviour
    }
  }, T);

  it('another user\'s limit never applies: the limit belongs to the requesting user only', async () => {
    const rich = await requester({ bp: 10_000, paisa: 9_000_000 });
    const poor = await requester({ bp: 1, paisa: 1 });
    expect((await ask(rich, [amt(1_000_000)])).body.within_limit).toBe(true);
    expect((await ask(poor, [amt(1_000_000)])).body.within_limit).toBe(false);
  }, T);
});

describe('above the limit: approval by a person whose authority covers the amount, never the requester', () => {
  it('an approver with no authority -> 403 auth.forbidden, the approval stays pending; one whose authority covers amount and bp approves it', async () => {
    const who = await requester({ bp: 1000, paisa: 50_000 });
    const r = await ask(who, [amt(200_000), pct(2500)]);
    expect(r.body).toMatchObject({ status: 'pending', within_limit: false });
    const none = await approver();
    expect((await approveFails(r.body.id, '"1"', {}, none)).code).toBe('auth.forbidden');
    expect((await approvalRow(r.body.id)).status).toBe('pending');
    const boss = await approver({ bp: 3000, paisa: 250_000 });
    const done = await approve(r.body.id, '"1"', {}, boss);
    expect(done.body).toMatchObject({ status: 'approved', decided_by: { membership_id: boss.membershipId } });
    expect(await approvalRow(r.body.id)).toMatchObject({ status: 'approved', decided_by_membership_id: boss.membershipId });
  }, T);

  it.each<[string, { bp: number; paisa: number; active?: boolean }]>([
    ['paisa authority one short', { bp: 3000, paisa: 199_999 }], ['bp authority one short', { bp: 2499, paisa: 250_000 }], ['an authority that was deactivated', { bp: 10_000, paisa: 9_000_000, active: false }],
  ])('%s -> 403 auth.forbidden, still pending', async (_n, authority) => {
    const who = await requester({ bp: 1000, paisa: 50_000 });
    const r = await ask(who, [amt(200_000), pct(2500)]);
    const a = await approver(authority);
    expect((await approveFails(r.body.id, '"1"', {}, a)).code).toBe('auth.forbidden');
    expect((await approvalRow(r.body.id)).status).toBe('pending');
  }, T);

  it('an authority of exactly the amount and bp is enough (<=)', async () => {
    const who = await requester({ bp: 1, paisa: 1 });
    const r = await ask(who, [amt(7_000), pct(700)]);
    const a = await approver({ bp: 700, paisa: 7_000 });
    expect((await approve(r.body.id, '"1"', {}, a)).body.status).toBe('approved');
  }, T);

  it('the requester cannot approve his own request even with a wide authority: frontdesk.discount_self_approval_forbidden (CR-C4-007), nothing decided', async () => {
    const p = await person(TENANT_A);
    await limitRow(p.userId, 1, 1);
    await authorityRow(p.userId, 10_000, 9_000_000);
    const who: Who = { ...APPROVER, membershipId: p.membershipId };                 // holds the approve grant AND the apply grant
    const r = await ask(who, [amt(100_000)]);
    expect(r.body.status).toBe('pending');
    expect((await approveFails(r.body.id, '"1"', {}, who)).code).toBe('frontdesk.discount_self_approval_forbidden');
    expect((await approvalRow(r.body.id)).decided_by_membership_id).toBeNull();
  }, T);

  it('a within-limit approval has nothing left to approve: a later approve is refused as an immutable record', async () => {
    const who = await requester({ bp: 1000, paisa: 50_000 });
    const r = await ask(who, [amt(100)]);
    expect((await approveFails(r.body.id, '"1"', {}, await approver({ bp: 10_000, paisa: 9_000_000 }))).code).toBe('common.immutable_record');
  }, T);
});

describe('require_discount_reason (tenant setting, default on)', () => {
  it('on by default: a request without reason_code is 400 with /reason_code, nothing stored (also for a requester inside the limit)', async () => {
    const who = await requester({ bp: 1000, paisa: 50_000 });
    const e = await requestFails({ centre_id: CENTRE.a, base_fingerprint: hex64(), discounts: [amt(100)], patient_ref: { patient_id: (await seedPatient('a')).id } }, who);
    expect(e.code).toBe('common.validation_failed');
    expect((e.errors ?? []).map((x: any) => x.path)).toContain('/reason_code');
  }, T);

  it('an empty reason_code is refused while the setting is on, and with an explicit true too', async () => {
    const who = await requester({ bp: 1000, paisa: 50_000 }, { settings: { require_discount_reason: true } });
    const e = await requestFails({ centre_id: CENTRE.a, base_fingerprint: hex64(), discounts: [amt(100)], reason_code: '', patient_ref: { patient_id: (await seedPatient('a')).id } }, who);
    expect((e.errors ?? []).map((x: any) => x.path)).toContain('/reason_code');
  }, T);

  it('off: the same request without a reason_code is accepted (and still computed against the limit)', async () => {
    const who = await requester({ bp: 1000, paisa: 50_000 }, { settings: { require_discount_reason: false } });
    const r = await ask(who, [amt(100)], { reason_code: undefined });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'approved', within_limit: true });
  }, T);
});
