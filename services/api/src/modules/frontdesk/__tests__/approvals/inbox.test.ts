// FD-T07 F16 listDiscountApprovals (approver inbox) + F17 getDiscountApproval (requester polls own) — US-FD-07.2 ("appears in approvers' inbox", "my screen shows Approved by <name>"),
// 03-APP-FLOW §1.3 (lazy expiry on read when now >= expires_at), §2.7, 07-SECURITY §6.1 (list endpoints: zero other-tenant rows; centre-scoped user sees no other-centre rows), §6.4 (aal1).
// Fails now: handlers are stubs. Tests run in parallel with other files on the same DB: list assertions are inclusive/exclusive on the ids THIS test created, never exact counts.
import { describe, expect, it } from 'vitest';
import { schemaErrors } from '../patients/helpers.js';
import { APPROVER, APPROVER_B, CENTRE, CENTRE_A2, MIN, NOW, OTHER, P, REQUESTER, REQUESTER_B, T, as, approve, approvedApproval, getApproval, listApprovals, newApproval, opFails, req, rejection } from './helpers.js';

const ids = (r: { body: any }): string[] => (r.body.data as any[]).map((x) => x.id);
const A2_REQUESTER = as(REQUESTER, { centreIds: [CENTRE_A2] });
const A2_APPROVER = as(APPROVER, { centreIds: [CENTRE_A2] });

describe('F16 inbox', () => {
  it('a pending request appears for an aal2 approver: schema-valid page, requester name shown, bound to the centre', async () => {
    const a = await newApproval();
    const r = await listApprovals({ status: 'pending', centre_id: CENTRE.a, limit: 200 });
    expect(r.status).toBe(200);
    expect(schemaErrors('DiscountApprovalPage', r.body)).toEqual([]);
    const mine = r.body.data.find((x: any) => x.id === a.id);
    expect(mine).toMatchObject({ status: 'pending', centre_id: CENTRE.a, requested_by: { membership_id: REQUESTER.membershipId, display_name: REQUESTER.displayName } });
  }, T);

  it('default status is pending; status filters: an approved one leaves the pending inbox and shows under approved', async () => {
    const pending = await newApproval(), done = await approvedApproval();
    const dflt = await listApprovals({ limit: 200 });
    expect(ids(dflt)).toContain(pending.id);
    expect(ids(dflt)).not.toContain(done.id);
    expect(ids(await listApprovals({ status: 'approved', limit: 200 }))).toContain(done.id);
    expect(ids(await listApprovals({ status: 'approved', limit: 200 }))).not.toContain(pending.id);
    for (const x of (await listApprovals({ status: 'approved', limit: 200 })).body.data) expect(x.status).toBe('approved');
  }, T);

  it('lazy expiry: a pending request is listed until now >= expires_at (15 min), then it is not pending any more', async () => {
    const a = await newApproval();
    expect(ids(await listApprovals({ limit: 200 }, APPROVER, { now: new Date(NOW.getTime() + 15 * MIN - 1000) }))).toContain(a.id);
    expect(ids(await listApprovals({ limit: 200 }, APPROVER, { now: new Date(NOW.getTime() + 15 * MIN) }))).not.toContain(a.id);
  }, T);

  it('tenant isolation (REQ-SEC-024): tenant B\'s approvals never appear for tenant A and vice versa', async () => {
    const a = await newApproval(), b = await newApproval({ who: REQUESTER_B });
    const ra = await listApprovals({ limit: 200 }), rb = await listApprovals({ limit: 200 }, APPROVER_B);
    expect(ids(ra)).toContain(a.id); expect(ids(ra)).not.toContain(b.id);
    expect(ids(rb)).toContain(b.id); expect(ids(rb)).not.toContain(a.id);
  }, T);

  it('centre scope: an approver scoped to centre A1 never sees centre A2 requests; one covering both sees both', async () => {
    const a1 = await newApproval(), a2 = await newApproval({ who: A2_REQUESTER, centreId: CENTRE_A2 });
    const only1 = await listApprovals({ limit: 200 });
    expect(ids(only1)).toContain(a1.id); expect(ids(only1)).not.toContain(a2.id);
    const both = await listApprovals({ limit: 200 }, as(APPROVER, { centreIds: [CENTRE.a, CENTRE_A2] }));
    expect(ids(both)).toEqual(expect.arrayContaining([a1.id, a2.id]));
  }, T);

  it('centre_id filter narrows to that centre', async () => {
    const a1 = await newApproval(), a2 = await newApproval({ who: A2_REQUESTER, centreId: CENTRE_A2 });
    const r = await listApprovals({ centre_id: CENTRE_A2, limit: 200 }, as(APPROVER, { centreIds: [CENTRE.a, CENTRE_A2] }));
    expect(ids(r)).toContain(a2.id); expect(ids(r)).not.toContain(a1.id);
    for (const x of r.body.data) expect(x.centre_id).toBe(CENTRE_A2);
  }, T);

  it('cursor paging: limit 2 over three requests at one centre -> pages <= 2, no id twice, all three found, page.limit echoed', async () => {
    const made = [await newApproval({ who: A2_REQUESTER, centreId: CENTRE_A2 }), await newApproval({ who: A2_REQUESTER, centreId: CENTRE_A2 }), await newApproval({ who: A2_REQUESTER, centreId: CENTRE_A2 })].map((x) => x.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 60; page++) {
      const r = await listApprovals({ limit: 2, ...(cursor ? { cursor } : {}) }, A2_APPROVER);
      expect(schemaErrors('DiscountApprovalPage', r.body)).toEqual([]);
      expect(r.body.data.length).toBeLessThanOrEqual(2);
      expect(r.body.page.limit).toBe(2);
      seen.push(...ids(r));
      cursor = r.body.page.next_cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(made));
  }, T);

  it('authority: requester-only -> 403 auth.forbidden; approve holder at aal1 -> 403 auth.mfa_required (privileged => aal2, 07-SECURITY §6.4)', async () => {
    for (const [who, code] of [[REQUESTER, 'auth.forbidden'], [OTHER, 'auth.forbidden'], [as(APPROVER, { mfa: 'aal1' }), 'auth.mfa_required']] as const) {
      const e = await rejection(listApprovals({ limit: 5 }, who));
      expect(e.code, who.displayName).toBe(code); expect(e.statusCode).toBe(403);
    }
  }, T);

  it('bad query: unknown status, limit 0 / 201, non-uuid centre_id -> 400 common.validation_failed with the path', async () => {
    for (const [q, path] of [[{ status: 'bogus' }, '/status'], [{ limit: 0 }, '/limit'], [{ limit: 201 }, '/limit'], [{ centre_id: 'not-a-uuid' }, '/centre_id']] as const) {
      const e = await opFails('listDiscountApprovals', req({ query: q }), APPROVER);
      expect(e.code, JSON.stringify(q)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
      expect((e.errors ?? []).map((x: any) => x.path), JSON.stringify(q)).toContain(path);
    }
  }, T);
});

describe('F17 requester polls own approval', () => {
  it('requester reads own pending request: 200, schema-valid, binding internals not exposed', async () => {
    const a = await newApproval();
    const r = await getApproval(a.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: a.id, status: 'pending', version: 1 });
    expect(schemaErrors('DiscountApproval', r.body)).toEqual([]);
    for (const k of ['patient_id', 'draft_hash', 'base_fingerprint']) expect(r.body, k).not.toHaveProperty(k);
  }, T);

  it('US-FD-07.2: after an aal2 approval the requester sees status approved with "Approved by <name>" (decided_by.display_name) and decided_at', async () => {
    const a = await newApproval();
    await approve(a.id, '"1"', { note: 'ok' }, APPROVER);
    const r = await getApproval(a.id);
    expect(r.body).toMatchObject({ status: 'approved', decided_by: { membership_id: APPROVER.membershipId, display_name: APPROVER.displayName }, note: 'ok', version: 2 });
    expect(new Date(r.body.decided_at).getTime()).toBe(NOW.getTime());
  }, T);

  it('requesters see only their own: another apply-only user -> 404 common.not_found (not 403: existence is not confirmed)', async () => {
    const a = await newApproval();
    const e = await rejection(getApproval(a.id, OTHER));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
  }, T);

  it('an approver (approve + apply) can open any request in their centre (detail page, 03-APP-FLOW §2.7 step 2) [ASSUMED]', async () => {
    const a = await newApproval();
    expect((await getApproval(a.id, APPROVER)).status).toBe(200);
  }, T);

  it('lazy expiry on read: pending and approved both read as expired once now >= expires_at; not before', async () => {
    const p = await newApproval(), ap = await approvedApproval();
    for (const [a, before] of [[p, 'pending'], [ap, 'approved']] as const) {
      expect((await getApproval(a.id, REQUESTER, { now: new Date(NOW.getTime() + 15 * MIN - 1000) })).body.status).toBe(before);
      expect((await getApproval(a.id, REQUESTER, { now: new Date(NOW.getTime() + 15 * MIN) })).body.status).toBe('expired');
    }
  }, T);

  it('tenant B cannot read tenant A\'s approval and the reverse -> 404; unknown id -> 404; malformed id -> 400 /approval_id; no apply grant -> 403', async () => {
    const a = await newApproval(), b = await newApproval({ who: REQUESTER_B });
    for (const e of [await rejection(getApproval(a.id, REQUESTER_B)), await rejection(getApproval(b.id, REQUESTER)), await rejection(getApproval('01a1a98a-ac40-7000-8000-0000ffff0002'))]) {
      expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    }
    const bad = await opFails('getDiscountApproval', req({ params: { approval_id: 'x' } }), REQUESTER);
    expect(bad.code).toBe('common.validation_failed'); expect((bad.errors ?? []).map((x: any) => x.path)).toContain('/approval_id');
    const none = await rejection(getApproval(a.id, as(REQUESTER, { grants: [P.reg] })));
    expect(none.code).toBe('auth.forbidden'); expect(none.statusCode).toBe(403);
  }, T);
});
