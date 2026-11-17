// FD-T07 F18 approveDiscount + F19 rejectDiscount. ACs US-FD-07.3 (aal1 -> 403 auth.mfa_required), US-FD-07.4 (self-approval -> 403 frontdesk.discount_self_approval_forbidden [CR-C4-007]),
// US-FD-07.2 (aal2 finance approves), 03-APP-FLOW §1.3 guards (approver != requester, not expired, covers centre), 02-TRD F18/F19 rows (If-Match, common.immutable_record),
// 07-SECURITY §6.4 (no permission -> auth.forbidden; permission at aal1 -> auth.mfa_required), §6.1 (tenant / centre), abuse row "self-approval -> DB CHECK + error".
// IdentityPort fake aal1/aal2: see helpers.ts. Fails now: handlers are stubs (common.service_unavailable).
import { describe, expect, it } from 'vitest';
import { schemaErrors } from '../patients/helpers.js';
import { APPROVER, APPROVER2, APPROVER_B, CENTRE_A2, MIN, NOW, OTHER, REQUESTER, T, as, approvalRow, approve, approveFails, getApproval, newApproval, opFails, req, reject, rejectFails, superTx } from './helpers.js';

const unchanged = async (id: string) => expect(await approvalRow(id)).toMatchObject({ status: 'pending', decided_by_membership_id: null, decided_at: null, decision_note: null, version: 1 });
const AT_EXPIRY = { now: new Date(NOW.getTime() + 15 * MIN) };
const A2_REQUESTER = as(REQUESTER, { centreIds: [CENTRE_A2] });

describe('F18 approve (US-FD-07.2)', () => {
  it('aal2 finance approver != requester: 200, status approved, decided_by + decided_at (server clock), note kept, version 2; DTO schema-valid', async () => {
    const a = await newApproval();
    const r = await approve(a.id, '"1"', { note: 'Synthetic approval note' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: a.id, status: 'approved', version: 2, note: 'Synthetic approval note',
      requested_by: { membership_id: REQUESTER.membershipId }, decided_by: { membership_id: APPROVER.membershipId, display_name: APPROVER.displayName } });
    expect(new Date(r.body.decided_at).getTime()).toBe(NOW.getTime());
    expect(schemaErrors('DiscountApproval', r.body)).toEqual([]);
    expect(await approvalRow(a.id)).toMatchObject({ status: 'approved', decided_by_membership_id: APPROVER.membershipId, decision_note: 'Synthetic approval note',
      requested_by_membership_id: REQUESTER.membershipId, consumed_order_id: null, consumed_at: null, version: 2 });
  }, T);

  it('the note is optional; 500 chars are accepted, 501 -> 400 /note; unknown body fields -> 400; nothing changes on a 400', async () => {
    const ok = await newApproval();
    expect((await approve(ok.id, '"1"', {})).status).toBe(200);
    const max = await newApproval();
    expect((await approve(max.id, '"1"', { note: 'x'.repeat(500) })).status).toBe(200);
    const a = await newApproval();
    const e1 = await approveFails(a.id, '"1"', { note: 'x'.repeat(501) });
    expect(e1.code).toBe('common.validation_failed'); expect(e1.statusCode).toBe(400);
    expect((e1.errors ?? []).map((x: any) => x.path)).toContain('/note');
    const e2 = await approveFails(a.id, '"1"', { decided_by: 'someone-else' });
    expect(e2.code).toBe('common.validation_failed');
    await unchanged(a.id);
  }, T);

  it('US-FD-07.3: approver session at aal1 -> 403 auth.mfa_required, request stays pending', async () => {
    const a = await newApproval();
    const e = await approveFails(a.id, '"1"', {}, as(APPROVER, { mfa: 'aal1' }));
    expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403);
    await unchanged(a.id);
  }, T);

  it('without frontdesk.discount.approve (front desk, lab technologist) -> 403 auth.forbidden, request stays pending', async () => {
    const a = await newApproval();
    for (const who of [REQUESTER, OTHER]) {
      const e = await approveFails(a.id, '"1"', {}, who);
      expect(e.code, who.displayName).toBe('auth.forbidden'); expect(e.statusCode).toBe(403);
    }
    await unchanged(a.id);
  }, T);

  it('US-FD-07.4 [CR-C4-007]: a requester who holds frontdesk.discount.approve (aal2) approving their OWN request -> 403 frontdesk.discount_self_approval_forbidden', async () => {
    const a = await newApproval({ who: APPROVER });
    const e = await approveFails(a.id, '"1"', {}, APPROVER);
    expect(e.code).toBe('frontdesk.discount_self_approval_forbidden'); expect(e.statusCode).toBe(403);
    await unchanged(a.id);
  }, T);

  it('the self-approval backstop is in the DB too: decided_by = requested_by violates discount_approvals__decider__ck even for the owner', async () => {
    const a = await newApproval();
    const err = await superTx(async (tx) => { await tx.query('UPDATE frontdesk.discount_approvals SET status = \'approved\', decided_by_membership_id = requested_by_membership_id WHERE id = $1', [a.id]); })
      .then(() => undefined, (e: any) => e);
    expect(err?.code).toBe('23514');
    expect(String(err?.constraint ?? err?.message)).toContain('discount_approvals__decider__ck');
    await unchanged(a.id);
  }, T);

  it('not pending -> 409 common.immutable_record: already approved, already rejected (with the current If-Match), and expired by the clock (now >= expires_at)', async () => {
    const done = await newApproval(); await approve(done.id, '"1"');
    const e1 = await approveFails(done.id, '"2"', {}, APPROVER2);
    expect(e1.code).toBe('common.immutable_record'); expect(e1.statusCode).toBe(409);
    expect(await approvalRow(done.id)).toMatchObject({ status: 'approved', decided_by_membership_id: APPROVER.membershipId, version: 2 });

    const rej = await newApproval(); await reject(rej.id, '"1"');
    const e2 = await approveFails(rej.id, '"2"');
    expect(e2.code).toBe('common.immutable_record'); expect(e2.statusCode).toBe(409);
    expect((await approvalRow(rej.id)).status).toBe('rejected');

    const old = await newApproval();
    const e3 = await approveFails(old.id, '"1"', {}, APPROVER, AT_EXPIRY);
    expect(e3.code).toBe('common.immutable_record'); expect(e3.statusCode).toBe(409);
    expect((await approvalRow(old.id)).status).not.toBe('approved');
    expect((await getApproval(old.id, REQUESTER, AT_EXPIRY)).body.status).toBe('expired');
  }, T);

  it('one second before expiry it is still approvable (expiry is now >= expires_at)', async () => {
    const a = await newApproval();
    expect((await approve(a.id, '"1"', {}, APPROVER, { now: new Date(NOW.getTime() + 15 * MIN - 1000) })).body.status).toBe('approved');
  }, T);

  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed never approves', async () => {
    const a = await newApproval();
    const e1 = await approveFails(a.id, undefined);
    expect(e1.code).toBe('common.precondition_required'); expect(e1.statusCode).toBe(428);
    const e2 = await approveFails(a.id, '"7"');
    expect(e2.code).toBe('common.version_conflict'); expect(e2.statusCode).toBe(409);
    for (const h of ['1', 'W/"1"', '"0"', '*', '""', '"1"; DROP TABLE x']) {
      const e = await approveFails(a.id, h);
      expect(['common.precondition_required', 'common.validation_failed', 'common.version_conflict'], h).toContain(e.code);
    }
    await unchanged(a.id);
  }, T);

  it('other tenant / unknown id -> 404 common.not_found; malformed id -> 400 /approval_id; centre outside the approver\'s scope -> not_found or forbidden, never approved', async () => {
    const a = await newApproval();
    const foreign = await approveFails(a.id, '"1"', {}, APPROVER_B);
    expect(foreign.code).toBe('common.not_found'); expect(foreign.statusCode).toBe(404);
    const unknown = await approveFails('01a1a98a-ac40-7000-8000-0000ffff0003', '"1"');
    expect(unknown.code).toBe('common.not_found');
    const bad = await opFails('approveDiscount', req({ params: { approval_id: 'x' }, body: {}, headers: { 'if-match': '"1"' } }), APPROVER);
    expect(bad.code).toBe('common.validation_failed'); expect((bad.errors ?? []).map((x: any) => x.path)).toContain('/approval_id');
    await unchanged(a.id);

    const other = await newApproval({ who: A2_REQUESTER, centreId: CENTRE_A2 });          // APPROVER covers only A1
    const scoped = await approveFails(other.id, '"1"', {}, APPROVER);
    expect(['common.not_found', 'auth.forbidden']).toContain(scoped.code);
    expect([403, 404]).toContain(scoped.statusCode);
    await unchanged(other.id);
  }, T);

  it('race: two aal2 approvers with the same If-Match -> exactly one 200, the other 409; the stored decider is the winner; version 2', async () => {
    const a = await newApproval();
    const rs = await Promise.allSettled([approve(a.id, '"1"', {}, APPROVER), approve(a.id, '"1"', {}, APPROVER2)]);
    const winners = rs.map((r, i) => (r.status === 'fulfilled' ? i : -1)).filter((i) => i >= 0);
    expect(winners).toHaveLength(1);
    const loser = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['common.version_conflict', 'common.immutable_record']).toContain(loser.reason.code); expect(loser.reason.statusCode).toBe(409);
    expect(await approvalRow(a.id)).toMatchObject({ status: 'approved', decided_by_membership_id: [APPROVER, APPROVER2][winners[0]!]!.membershipId, version: 2 });
  }, T);

  it('race: approve vs reject on the same request -> exactly one decision sticks, the other 409', async () => {
    const a = await newApproval();
    const rs = await Promise.allSettled([approve(a.id, '"1"', {}, APPROVER), reject(a.id, '"1"', { note: 'Synthetic' }, APPROVER2)]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason.statusCode).toBe(409);
    const row = await approvalRow(a.id);
    expect(rs[0]!.status === 'fulfilled' ? 'approved' : 'rejected').toBe(row.status);
    expect(row.version).toBe(2);
  }, T);
});

describe('F19 reject', () => {
  it('aal2 approver rejects with a note: 200 rejected, decided_by, note, version 2; requester sees it on F17', async () => {
    const a = await newApproval();
    const r = await reject(a.id, '"1"', { note: 'Synthetic: discount too high' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', version: 2, note: 'Synthetic: discount too high', decided_by: { membership_id: APPROVER.membershipId, display_name: APPROVER.displayName } });
    expect(schemaErrors('DiscountApproval', r.body)).toEqual([]);
    expect(await approvalRow(a.id)).toMatchObject({ status: 'rejected', decided_by_membership_id: APPROVER.membershipId, decision_note: 'Synthetic: discount too high' });
    expect((await getApproval(a.id)).body).toMatchObject({ status: 'rejected', note: 'Synthetic: discount too high' });
  }, T);

  it('the note is required: missing / empty / 501 chars -> 400 common.validation_failed /note, request stays pending', async () => {
    const a = await newApproval();
    for (const body of [{}, { note: '' }, { note: 'x'.repeat(501) }]) {
      const e = await rejectFails(a.id, '"1"', body);
      expect(e.code, JSON.stringify(body).slice(0, 40)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
      expect((e.errors ?? []).map((x: any) => x.path)).toContain('/note');
    }
    await unchanged(a.id);
  }, T);

  it('same guards as F18: aal1 -> auth.mfa_required; no permission -> auth.forbidden; own request -> frontdesk.discount_self_approval_forbidden; each leaves it pending', async () => {
    const a = await newApproval(), mine = await newApproval({ who: APPROVER });
    const e1 = await rejectFails(a.id, '"1"', { note: 'n' }, as(APPROVER, { mfa: 'aal1' }));
    expect(e1.code).toBe('auth.mfa_required'); expect(e1.statusCode).toBe(403);
    const e2 = await rejectFails(a.id, '"1"', { note: 'n' }, REQUESTER);
    expect(e2.code).toBe('auth.forbidden');
    const e3 = await rejectFails(mine.id, '"1"', { note: 'n' }, APPROVER);
    expect(e3.code).toBe('frontdesk.discount_self_approval_forbidden'); expect(e3.statusCode).toBe(403);
    await unchanged(a.id); await unchanged(mine.id);
  }, T);

  it('rejection is terminal and If-Match is enforced: re-reject with the current version -> 409 common.immutable_record; missing If-Match -> 428; stale -> 409 version_conflict', async () => {
    const a = await newApproval(); await reject(a.id, '"1"');
    const e1 = await rejectFails(a.id, '"2"');
    expect(e1.code).toBe('common.immutable_record'); expect(e1.statusCode).toBe(409);
    const b = await newApproval();
    expect((await rejectFails(b.id, undefined)).code).toBe('common.precondition_required');
    expect((await rejectFails(b.id, '"9"')).code).toBe('common.version_conflict');
    await unchanged(b.id);
  }, T);

  it('other tenant -> 404 common.not_found, request untouched', async () => {
    const a = await newApproval();
    const e = await rejectFails(a.id, '"1"', { note: 'n' }, APPROVER_B);
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    await unchanged(a.id);
  }, T);
});
