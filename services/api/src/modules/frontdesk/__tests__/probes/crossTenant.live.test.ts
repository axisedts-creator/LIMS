// FD-T16 / 07-SECURITY §6.1 cross-tenant probes, EVERY frontdesk operation (F1-F26 incl. F8b, F21a = 29 operationIds) on a real PG17 under RLS.
// Given tenant A authenticated with every frontdesk permission (aal2, all centres) and tenant B's full object graph committed,
// When A calls an operation with B's ids in path / query / body (incl. arrays that MIX an A id with a B id),
// Then 404 common.not_found, no B id / name in the answer, and the owner-side snapshot of every B table is byte-identical afterwards ("DB check as owner shows zero b changes").
// List endpoints (F1, F6, F10, F16, F22, F26): with B data present, zero B rows, and an A control row IS returned (the filter is not simply hiding everything).
// Port probes: FrontdeskPort with B ids under A's ctx -> common.not_found.   Consumer probes (event envelopes of tenant B -> only B rows change): ../consumers/* (FD-T12) already assert it; see notes.
import { beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { frontdeskPort } from '../../ports/FrontdeskPort.impl.js';
import { ALL_USER_PERMS, asUser, booking, createFails, creator, fails as portFails, fullPatient, run as portRun } from '../contract/helpers.js';
import { edit } from '../orderchange/helpers.js';
import { scenario } from '../orders/helpers.js';
import { seedPatient } from '../patients/helpers.js';
import { prepare } from '../registration/helpers.js';
import { makeWorld, seedTrf } from '../trf/helpers.js';
import { FULL_A, FULL_B, OPS, T, TENANT_A, TENANT_B, codeOf, fire, objs, ownerRows, phone, requestFor, seed, snapshot, superTx, tag, uid, type Objs } from './kit.js';

let A: Objs; let B: Objs;
const BODY_ID_OPS = new Set(['quoteRegistration', 'createRegistration', 'requestDiscountApproval', 'uploadTrf']);
const LIST_OPS = new Set(['searchPatients', 'listPossibleDuplicatePatients', 'listOrders', 'listDiscountApprovals', 'listOrderFlags']);
const TENANT_LEVEL = new Set(['createPatient', 'getFrontdeskSettings', 'updateFrontdeskSettings', 'listFrontdeskCodes']);   // no foreign id to name: covered by their own probes below
const idsOf = (body: any): string[] => (body?.data ?? []).map((x: any) => x.id ?? x.patient?.id).filter(Boolean);

beforeAll(async () => { A = await objs('a', { at: '2026-02-02T03:03:00.000Z' }); B = await objs('b', { at: '2026-02-02T03:03:00.000Z' }); }, T);

describe('registry', () => {
  it('the contract has exactly the 29 frontdesk operations and every one is probed below', () => {
    expect(OPS).toHaveLength(29);
    const probed = OPS.filter((o) => o.pathParams.length > 0 || BODY_ID_OPS.has(o.id) || LIST_OPS.has(o.id) || TENANT_LEVEL.has(o.id));
    expect(probed.map((o) => o.id).sort()).toEqual(OPS.map((o) => o.id).sort());
  });
});

describe.each(OPS.filter((o) => !TENANT_LEVEL.has(o.id) && !LIST_OPS.has(o.id)).map((o) => [o.id, o] as const))('%s names a tenant-B object', (_id, o) => {
  it('=> 404 common.not_found, no B data in the answer, zero B changes in the DB', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire(o.id, requestFor(o.id, B), FULL_A);
    expect(out.reply, `answered ${out.reply?.status}; B objects must be invisible to A`).toBeUndefined();
    expect(out.error, 'expected a LimsError').toBeInstanceOf(LimsError);
    expect(codeOf(out), `${out.error?.message}`).toBe('common.not_found');
    const seen = JSON.stringify({ code: out.error.code, detail: out.error.detail, errors: out.error.errors, extra: { ...out.error } });
    for (const needle of [B.patient.id, B.order.id, B.item.id, B.approval.id, B.trf.id, B.flag.id, B.name, B.trf.object_path, TENANT_B]) expect(seen, needle).not.toContain(needle);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
});

describe('list endpoints: B data present => zero B rows, A control row present', () => {
  it('F1 searchPatients', { timeout: T }, async () => {
    const own = await fire('searchPatients', requestFor('searchPatients', A), FULL_A);
    expect(own.reply?.status, JSON.stringify(own.error)).toBe(200);
    expect(idsOf(own.reply!.body)).toContain(A.patient.id);
    const theirs = await fire('searchPatients', requestFor('searchPatients', B), FULL_A);
    expect(theirs.reply?.status).toBe(200);
    expect(idsOf(theirs.reply!.body)).not.toContain(B.patient.id);
    expect(JSON.stringify(theirs.reply!.body)).not.toContain(B.patient.id);
    // by exact phone and by patient code too: no B row through any search mode
    for (const q of [B.patient.phone_e164, B.patient.patient_code]) {
      const r = await fire('searchPatients', { ...requestFor('searchPatients', B), body: { query: q, limit: 20 } }, FULL_A);
      expect(JSON.stringify(r.reply?.body ?? r.error?.code), q).not.toContain(B.patient.id);
    }
  });
  it('F10 listOrders (window = the day both tenants have an order on)', { timeout: T }, async () => {
    const s = await scenario({ side: 'a', order: { registered_at: A.at, centre_id: A.centre } });
    // FD-T16 ruling (round 3): A's objs() order is registered in this window too; the lab fake must know it or F10 correctly propagates common.not_found
    s.lab.__seed({ orders: [{ id: A.order.id, tenantId: TENANT_A, patientId: A.patient.id, centreId: A.centre, priority: 'routine', patient: { sex: 'female', ageDays: 15000 } }] });
    s.billing.__seed({ orders: [{ id: A.order.id, tenantId: TENANT_A }] });
    const r = await fire('listOrders', requestFor('listOrders', B), FULL_A, { lab: s.lab, billing: s.billing });
    expect(r.reply?.status, JSON.stringify(r.error?.code)).toBe(200);
    const ids = idsOf(r.reply!.body);
    expect(ids).toContain(s.order.id);
    expect(ids).not.toContain(B.order.id);
    expect(JSON.stringify(r.reply!.body)).not.toContain(B.patient.id);
  });
  it('F16 listDiscountApprovals', { timeout: T }, async () => {
    const r = await fire('listDiscountApprovals', requestFor('listDiscountApprovals', B), FULL_A);
    expect(r.reply?.status, JSON.stringify(r.error?.code)).toBe(200);
    expect(idsOf(r.reply!.body)).toContain(A.approval.id);
    expect(idsOf(r.reply!.body)).not.toContain(B.approval.id);
  });
  it('F22 listOrderFlags', { timeout: T }, async () => {
    const r = await fire('listOrderFlags', requestFor('listOrderFlags', B), FULL_A);
    expect(r.reply?.status, JSON.stringify(r.error?.code)).toBe(200);
    expect(idsOf(r.reply!.body)).toContain(A.flag.id);
    expect(idsOf(r.reply!.body)).not.toContain(B.flag.id);
  });
  it('F26 listPossibleDuplicatePatients: a twin pair that exists only in B never shows for A', { timeout: T }, async () => {
    const D = `203${Math.floor(Math.random() * 9)}-04-1${Math.floor(Math.random() * 9)}`; const t = tag(); const ph = phone();
    const mkTwin = async (side: 'a' | 'b') => seedPatient(side, { full_name: `ZPROBE${t} Twin`, birth_on: '1990-01-01', phone_e164: ph, created_at: `${D}T06:00:00Z` });
    const b1 = await mkTwin('b'); const b2 = await mkTwin('b');
    const r = await fire('listPossibleDuplicatePatients', { ...requestFor('listPossibleDuplicatePatients', B), query: { created_on: D } }, FULL_A);
    expect(r.reply?.status, JSON.stringify(r.error?.code)).toBe(200);
    expect(JSON.stringify(r.reply!.body)).not.toMatch(new RegExp(`${b1.id}|${b2.id}`));
    expect(r.reply!.body.data).toHaveLength(0);
    const rb = await fire('listPossibleDuplicatePatients', { ...requestFor('listPossibleDuplicatePatients', B), query: { created_on: D } }, FULL_B);   // positive control: B sees its own pair
    expect(idsOf(rb.reply!.body).sort()).toEqual([b1.id, b2.id].sort());
  });
});

describe('tenant-level operations never read or write the other tenant', () => {
  it('F2 createPatient with the exact name + phone of a B patient: no duplicate_suspected from B, B untouched', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire('createPatient', requestFor('createPatient', B), FULL_A);
    expect(codeOf(out), `must not see B's twin: ${out.error?.message}`).toBeUndefined();
    expect(out.reply?.status).toBe(201);
    expect(out.reply!.body.id).not.toBe(B.patient.id);
    expect(JSON.stringify(out.reply!.body)).not.toContain(B.patient.id);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('F24 get returns A\'s settings (B holds distinct values); PUT changes only A\'s row', { timeout: T }, async () => {
    try {
      await superTx(async (tx) => { await tx.query(`UPDATE frontdesk.settings SET discount_self_limit_bp = 777 WHERE tenant_id = $1`, [TENANT_B]); }, TENANT_B);
      const g = await fire('getFrontdeskSettings', requestFor('getFrontdeskSettings', B), FULL_A);
      expect(g.reply?.status, JSON.stringify(g.error?.code)).toBe(200);
      expect(g.reply!.body.discount_self_limit_bp).not.toBe(777);
      const before = await snapshot(TENANT_B);
      const aRow = (await ownerRows('frontdesk.settings', 'tenant_id = $1', [TENANT_A]))[0];
      const put = await fire('updateFrontdeskSettings', { ...requestFor('updateFrontdeskSettings', B), headers: { 'if-match': `"${aRow.version}"` } }, FULL_A);
      expect(put.reply?.status, JSON.stringify([put.error?.code, put.error?.message])).toBe(200);
      expect(await snapshot(TENANT_B)).toEqual(before);
      expect((await ownerRows('frontdesk.settings', 'tenant_id = $1', [TENANT_B]))[0].discount_self_limit_bp).toBe(777);
    } finally {   // FD-T16 ruling: one superTx per tenant (the audit row is written under that tenant's claims); in finally so a failed assert cannot leak values into later tests
      for (const tenant of [TENANT_A, TENANT_B]) {
        await superTx(async (tx) => { await tx.query(`UPDATE frontdesk.settings SET discount_self_limit_bp = 0, discount_self_limit_paisa = 0, discount_absolute_max_bp = 10000, require_referrer = false, registration_sms_enabled = true,
          label_autoprint = true, buyer_pan_pattern = '^[0-9]{9}$', patient_search_min_chars = 3, version = 1 WHERE tenant_id = $1`, [tenant]); }, tenant);
      }
    }
  });
  it('F25 listFrontdeskCodes: a code that exists only in tenant B is not listed for A', { timeout: T }, async () => {
    const code = `b_only_${tag()}`.toLowerCase();
    await seed('frontdesk.cs_reasons', { tenant_id: TENANT_B, set_name: 'order_cancel_reasons', code, display: 'B only', sort_order: 99, id: uid() });
    const a = await fire('listFrontdeskCodes', requestFor('listFrontdeskCodes', B), FULL_A);
    expect(a.reply?.status).toBe(200);
    expect(JSON.stringify(a.reply!.body)).not.toContain(code);
    const b = await fire('listFrontdeskCodes', requestFor('listFrontdeskCodes', B), FULL_B);                       // positive control
    expect(JSON.stringify(b.reply!.body)).toContain(code);
  });
});

describe('arrays that mix an A id with a B id refuse as a whole and change nothing (a+b mixes)', () => {
  it('F9 createRegistration: trf_attachment_ids [A draft TRF, B TRF] => not_found; no order, A TRF unlinked, B untouched', { timeout: T }, async () => {
    const p = await prepare({ side: 'a' });
    const aTrf = await seedTrf(makeWorld(TENANT_A), { side: 'a', state: 'clean' });
    const before = { b: await snapshot(TENANT_B), trf: (await ownerRows('frontdesk.trf_attachments', 'id = $1', [aTrf.id]))[0] };
    const body = { ...p.body, trf_attachment_ids: [aTrf.id, B.trf.id] };
    const out = await fire('createRegistration', { params: {}, query: {}, headers: { 'idempotency-key': uid() }, body }, FULL_A, { w: p.w });
    expect(codeOf(out), `${out.error?.message}`).toBe('common.not_found');
    expect((await ownerRows('frontdesk.orders', 'patient_id = $1', [p.patient.id])).length).toBe(0);
    expect((await ownerRows('frontdesk.trf_attachments', 'id = $1', [aTrf.id]))[0]).toEqual(before.trf);
    expect(await snapshot(TENANT_B)).toEqual(before.b);
  });
  it('F9 createRegistration: discount_approval_id of a B approval => not_found, no order', { timeout: T }, async () => {
    const p = await prepare({ side: 'a' });
    const out = await fire('createRegistration', { params: {}, query: {}, headers: { 'idempotency-key': uid() }, body: { ...p.body, discount_approval_id: B.approval.id } }, FULL_A, { w: p.w });
    expect(['common.not_found', 'frontdesk.discount_approval_required']).toContain(codeOf(out));
    expect((await ownerRows('frontdesk.orders', 'patient_id = $1', [p.patient.id])).length).toBe(0);
    expect((await ownerRows('frontdesk.discount_approvals', 'id = $1', [B.approval.id]))[0].status).toBe('pending');
  });
  it('F13 changeOrderItems: remove [A item, B item] => refused, A order and items unchanged', { timeout: T }, async () => {
    const e = await edit({ side: 'a' });
    const snap = async () => ({ items: await ownerRows('frontdesk.order_items', 'order_id = $1 ORDER BY id', [e.order.id]), order: (await ownerRows('frontdesk.orders', 'id = $1', [e.order.id]))[0] });
    const before = await snap(); const bBefore = await snapshot(TENANT_B);
    const r = { params: { order_id: e.order.id }, query: {}, headers: { 'idempotency-key': uid(), 'if-match': `"${before.order.version}"` },
      body: { remove: [{ order_item_id: e.items[0].id, reason_code: 'patient_request' }, { order_item_id: B.item.id, reason_code: 'patient_request' }] } };
    const out = await fire('changeOrderItems', r, FULL_A, { lab: e.lab, billing: e.billing, catalog: e.w.catalog });
    expect(['common.not_found', 'common.validation_failed']).toContain(codeOf(out));
    expect(await snap()).toEqual(before);
    expect(await snapshot(TENANT_B)).toEqual(bBefore);
  });
  it('F20 uploadTrf linked to a B order => not_found, nothing stored, no scan job', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire('uploadTrf', requestFor('uploadTrf', B), FULL_A);
    expect(codeOf(out)).toBe('common.not_found');
    expect(out.probe.trf.storage.paths()).toEqual([]);
    expect(out.probe.trf.jobs).toEqual([]);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
});

describe('FrontdeskPort (03-IC §4.3) with tenant B ids under tenant A\'s ctx => common.not_found', () => {
  it.each([
    ['getOrderSummary', (id: Objs) => ({ orderId: id.order.id })],
    ['getPatientDemographics', (id: Objs) => ({ patientId: id.patient.id, purpose: 'notification' })],
  ] as const)('%s', { timeout: T }, async (m, input) => {
    const e = await portFails(asUser(ALL_USER_PERMS), (p, c) => (p as any)[m](c, input(B)));
    expect(e).toBeInstanceOf(LimsError);
    expect((e as any).code).toBe('common.not_found');
  });
  // FD-T16 ruling: 03-INTERFACE-CATALOG.md:1371 says getPatientDemographicsBatch "Missing/invisible ids omitted"; only auth.forbidden is a documented throw.
  it('getPatientDemographicsBatch [A, B]: B id is omitted from the result, A id is present', { timeout: T }, async () => {
    const a = await fullPatient('a');
    const result = await portRun(asUser(ALL_USER_PERMS), (p, c) => (p as any).getPatientDemographicsBatch(c, { patientIds: [a.id, B.patient.id], purpose: 'notification' }));
    expect(JSON.stringify(result)).toContain(a.id);
    expect(JSON.stringify(result)).not.toContain(B.patient.id);
  });
  it('createOrderFromBooking naming a B patient => not_found and B untouched', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const e = await createFails(booking('engagement_booking', { patientId: B.patient.id }), creator('engagement_booking'));
    expect((e as any).code).toBe('common.not_found');
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('the frontdeskPort object exposes exactly the 5 methods of 03-IC §4.3 + 08 §4.14 (no unprobed method)', () => {
    expect(Object.keys(frontdeskPort).sort()).toEqual(['createOrderFromBooking', 'createSelfRegisteredPatient', 'getOrderSummary', 'getPatientDemographics', 'getPatientDemographicsBatch']);
  });
});
