// FD-T16 / 07-SECURITY §6.2 cross-centre probes. Given a centre-scoped tenant-A user (centre A1 only, every frontdesk permission) and tenant A's objects at centre A2
// (orders, items, discount approvals, TRFs, flags), When the user reads or acts on them, Then 404 common.not_found; list endpoints exclude the A2 rows; an all-centre user sees them.
// Writing INTO another centre (upload / quote / register / approval request with centre_id = A2) is refused with auth.forbidden (IdentityPort.assertRole centre check) or 404.
// Centre scope in these tests = IdentityPort.getActor().centreScope + assertRole({centreId}) (the same fake every frontdesk suite uses); the RLS centre predicate itself is C0's db/tests.
// NOT covered (billing-owned, BL-T22): invoices, credit notes, ledger, cash sessions, balances, charges, tasks, review items, refund requests, periodic (NULL-centre) documents.
import { beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { mergeInto, scenario, sharedFakes } from '../orders/helpers.js';
import { A1_ONLY, CENTRE, CENTRE_A2, FULL_A, T, TENANT_A, codeOf, fire, objs, ownerRows, requestFor, snapshot, type Objs } from './kit.js';

let A1: Objs; let A2: Objs;
const DAY = '2026-02-03T03:03:00.000Z';
const idsOf = (body: any): string[] => (body?.data ?? []).map((x: any) => x.id).filter(Boolean);
const ID_OPS_ON_A2_OBJECT = ['getOrder', 'quoteOrderItemsChange', 'confirmPreRegisteredOrder', 'changeOrderItems', 'cancelOrder', 'getDiscountApproval', 'approveDiscount', 'rejectDiscount',
  'getTrfAttachment', 'getTrfAttachmentContent', 'resolveOrderFlag'];
const WRITE_INTO_A2 = ['uploadTrf', 'createRegistration', 'requestDiscountApproval'];       // a quote writes nothing and §6.2 does not list it

beforeAll(async () => { A1 = await objs('a', { centre: CENTRE.a, at: DAY }); A2 = await objs('a', { centre: CENTRE_A2, at: DAY }); }, T);

describe.each(ID_OPS_ON_A2_OBJECT.map((id) => [id] as const))('%s on an A2 object as an A1-only user', (id) => {
  it('=> 404 common.not_found and the A2 row is unchanged', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    const out = await fire(id, requestFor(id, A2), A1_ONLY);
    expect(out.reply, `answered ${out.reply?.status}; an A2 object must be invisible to an A1-only user`).toBeUndefined();
    expect(out.error).toBeInstanceOf(LimsError);
    expect(codeOf(out), `${out.error?.message}`).toBe('common.not_found');
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
  it('control: the same call on an A1 object is NOT a 404 (the probe measures scope, not a broken request)', { timeout: T }, async () => {
    // FD-T16 ruling (2): the kit's default lab fake knows no A1 order; seed it so a lab not_found cannot masquerade as a scope 404
    const shared = sharedFakes();
    shared.lab.__seed({ orders: [{ id: A1.order.id, tenantId: TENANT_A, patientId: A1.patient.id, centreId: A1.centre, priority: 'routine', patient: { sex: 'female', ageDays: 15000 } }] });
    shared.billing.__seed({ orders: [{ id: A1.order.id, tenantId: TENANT_A }] });
    const out = await fire(id, requestFor(id, A1), A1_ONLY, { lab: shared.lab, billing: shared.billing });
    expect(codeOf(out), `${out.error?.message}`).not.toBe('common.not_found');
  });
});

describe.each(WRITE_INTO_A2.map((id) => [id] as const))('%s into centre A2 as an A1-only user', (id) => {
  it('=> auth.forbidden (or 404), nothing stored', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    const out = await fire(id, requestFor(id, A2), A1_ONLY);
    expect(out.reply, `answered ${out.reply?.status}`).toBeUndefined();
    expect(['auth.forbidden', 'common.not_found']).toContain(codeOf(out));
    expect(out.probe.trf.storage.paths()).toEqual([]);
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
});

describe('lists exclude A2 rows for an A1-only user; an all-centre user sees them', () => {
  it('F10 listOrders', { timeout: T }, async () => {
    const s1 = await scenario({ side: 'a', order: { registered_at: DAY }, centre: CENTRE.a });
    const s2 = await scenario({ side: 'a', order: { registered_at: DAY }, centre: CENTRE_A2 });
    const shared = sharedFakes(); mergeInto(shared, s1); mergeInto(shared, s2);
    // FD-T16 ruling (round 3): F10 derives status per registered order via LabPort, and a lab not_found propagates: seed the objs() orders that share this window too
    for (const o of [A1, A2]) {
      shared.lab.__seed({ orders: [{ id: o.order.id, tenantId: TENANT_A, patientId: o.patient.id, centreId: o.centre, priority: 'routine', patient: { sex: 'female', ageDays: 15000 } }] });
      shared.billing.__seed({ orders: [{ id: o.order.id, tenantId: TENANT_A }] });
    }
    const q ={ ...requestFor('listOrders', A1), query: { registered_at_from: '2026-02-03T00:00:00.000Z', registered_at_to: '2026-02-03T23:59:59.000Z', limit: '200' } };
    const one = await fire('listOrders', q, A1_ONLY, { lab: shared.lab, billing: shared.billing });
    expect(one.reply?.status, JSON.stringify(one.error?.code)).toBe(200);
    expect(idsOf(one.reply!.body)).toContain(s1.order.id);
    expect(idsOf(one.reply!.body)).not.toContain(s2.order.id);
    expect(idsOf(one.reply!.body)).not.toContain(A2.order.id);
    const all = await fire('listOrders', q, FULL_A, { lab: shared.lab, billing: shared.billing });
    expect(idsOf(all.reply!.body)).toEqual(expect.arrayContaining([s1.order.id, s2.order.id]));
  });
  it('F10 listOrders with centre_id = A2 does not widen the scope', { timeout: T }, async () => {
    const q = { ...requestFor('listOrders', A2), query: { centre_id: CENTRE_A2, registered_at_from: '2026-02-03T00:00:00.000Z', registered_at_to: '2026-02-03T23:59:59.000Z' } };
    const r = await fire('listOrders', q, A1_ONLY);
    expect(r.reply ? idsOf(r.reply.body) : [], r.error ? `refused with ${codeOf(r)}` : '').toEqual([]);
    if (r.error) expect(['auth.forbidden', 'common.not_found']).toContain(codeOf(r));
  });
  it('F6 listPatientOrders: a patient whose only order is at A2 lists no order for the A1-only user', { timeout: T }, async () => {
    const r = await fire('listPatientOrders', requestFor('listPatientOrders', A2), A1_ONLY);
    expect(r.reply?.status, JSON.stringify(r.error?.code)).toBe(200);
    expect(idsOf(r.reply!.body)).not.toContain(A2.order.id);
    expect(JSON.stringify(r.reply!.body)).not.toContain(A2.order.registration_no);
  });
  it.each([['F16 listDiscountApprovals', 'listDiscountApprovals', 'approval'], ['F22 listOrderFlags', 'listOrderFlags', 'flag']] as const)('%s (centre filter = A2)', { timeout: T }, async (_n, id, key) => {
    // FD-T16 ruling (4): the ID_OPS controls above approve/reject and resolve A1/A2's approval and flag, so the status filter rightly excludes them: use fresh objects
    const F1 = await objs('a', { centre: CENTRE.a }); const F2 = await objs('a', { centre: CENTRE_A2 });
    const q = (o: Objs) => ({ ...requestFor(id, o), query: { status: id === 'listOrderFlags' ? 'open' : 'pending', centre_id: o.centre } });
    const hidden = await fire(id, q(F2), A1_ONLY);
    expect(hidden.reply ? idsOf(hidden.reply.body) : [], hidden.error ? `refused with ${codeOf(hidden)}` : '').not.toContain(F2[key].id);
    if (hidden.error) expect(['auth.forbidden', 'common.not_found']).toContain(codeOf(hidden));
    const mine = await fire(id, q(F1), A1_ONLY);
    expect(idsOf(mine.reply!.body)).toContain(F1[key].id);                                                     // control
    const all = await fire(id, q(F2), FULL_A);
    expect(idsOf(all.reply!.body)).toContain(F2[key].id);                                                      // an all-centre user sees A2
  });
  it('without a centre filter no A2 row leaks into F16 / F22 for the A1-only user', { timeout: T }, async () => {
    for (const [id, key, status] of [['listDiscountApprovals', 'approval', 'pending'], ['listOrderFlags', 'flag', 'open']] as const) {
      const r = await fire(id, { ...requestFor(id, A1), query: { status, limit: '200' } }, A1_ONLY);
      expect(idsOf(r.reply!.body), id).not.toContain(A2[key].id);
    }
  });
});

describe('an all-centre user reads the A2 objects (control for the 404s above)', () => {
  it('F21 getTrfAttachment / F17 getDiscountApproval as FULL_A', { timeout: T }, async () => {
    expect((await fire('getTrfAttachment', requestFor('getTrfAttachment', A2), FULL_A)).reply?.status).toBe(200);
    expect((await fire('getDiscountApproval', requestFor('getDiscountApproval', A2), FULL_A)).reply?.status).toBe(200);
    expect((await ownerRows('frontdesk.order_flags', 'id = $1', [A2.flag.id])).length).toBe(1);
  });
});
