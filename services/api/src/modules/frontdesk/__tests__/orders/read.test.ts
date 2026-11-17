// FD-T08 F10 listOrders + F11 getOrder (02-TRD §5.1 F10/F11 + DTO notes; contracts/openapi/frontdesk.yaml OrderSummaryPage / OrderDto; 02-CV §4.3 cursors, §4.4 sort;
// 07-SECURITY §5 PHI rules, §6.1 cross-tenant, §6.2 cross-centre). Derived status itself: derived.test.ts. Integration over real PG17 (RLS on) with real port fakes.
// ASSUMED (writer: dispute if wrong): handlers/getOrder.ts + handlers/listOrders.ts export `handler`; service/order.service.ts exports getOrder(ctx, params) / listOrders(ctx, query);
// scope = IdentityPort.getActor().centreScope (as FD-T06/T07); OrderDto.patient.age_at_order = "<age_years> Years" (TRD PatientSummary "43 Years"); query strictness like F6 (unknown param -> 400).
import { describe, expect, it } from 'vitest';
import { CENTRE, CENTRE_A2, T, TENANT_A, TENANT_B, allPages, getFails, getOrder, listFails, listOrders, mergeInto, ownerRows, rows, scenario, schemaErrors, seed, sharedFakes, uid } from './helpers.js';

// every list test uses its own registered_at window (the tenant's order table is shared with other suites running in parallel)
const win = (year: number) => ({ registered_at_from: `${year}-01-01T00:00:00.000Z`, registered_at_to: `${year}-12-31T00:00:00.000Z` });
const when = (year: number, day: number, hour = 4) => `${year}-06-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const ids = (r: any) => r.body.data.map((x: any) => x.id);

describe('F11 getOrder', () => {
  it('200 OrderDto: schema-valid, scalar fields, patient block, items with price snapshot, discounts/TRFs/flags, billing block', { timeout: T }, async () => {
    const s = await scenario({ items: ['not_started', 'not_started'], order: { referrer_id: uid(), credit_party_id: null } });
    const [i1, i2] = s.items;
    await seed('frontdesk.discounts', rows.discount('a', s.order.id));
    await seed('frontdesk.trf_attachments', rows.trf('a', s.order.id));
    await seed('frontdesk.order_flags', rows.flag('a', s.order.id));
    const r = await getOrder(s.order.id, { s });
    expect(r.status).toBe(200);
    expect(schemaErrors('OrderDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: s.order.id, registration_no: s.order.registration_no, branch_id: s.order.branch_id, centre_id: CENTRE.a, visit_type: 'opd',
      billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', status: 'registered', referrer_id: s.order.referrer_id, requires_credit_note: false });
    expect(r.body.version).toBeTypeOf('number');
    expect(r.body.patient).toEqual({ id: s.patient.id, patient_code: s.patient.patient_code, full_name: s.patient.full_name, sex: 'female', age_at_order: '43 Years' });
    expect(r.body.items.map((i: any) => i.id).sort()).toEqual([i1.id, i2.id].sort());
    const it1 = r.body.items.find((i: any) => i.id === i1.id);
    expect(it1).toMatchObject({ orderable_id: i1.orderable_id, orderable_kind: 'test', code: i1.code, name: i1.name, priority: 'routine', status: 'active',
      unit_price: { amount_paisa: 10000, currency: 'NPR' }, outsourced: false });
    expect(r.body.discounts).toHaveLength(1);
    expect(r.body.trf_attachments).toHaveLength(1);
    expect(r.body.flags).toHaveLength(1);
    expect(r.body.billing.order_id).toBe(s.order.id);                     // BillingCommandPort.getOrderBillingSummary().balance, mapped to OrderBalanceDto
    expect(s.billing.calls('getOrderBillingSummary').map((c: any) => c.input)).toEqual([{ orderId: s.order.id }]);
  });

  it('urgent item exposes urgent_surcharge as Money; a routine item has none', { timeout: T }, async () => {
    const s = await scenario({ items: [{ lab: 'not_started', row: { priority: 'urgent', urgent_surcharge_paisa: 5000 } }, 'not_started'] });
    const r = await getOrder(s.order.id, { s });
    expect(schemaErrors('OrderDto', r.body)).toEqual([]);
    expect(r.body.items.find((i: any) => i.id === s.items[0].id).urgent_surcharge).toEqual({ amount_paisa: 5000, currency: 'NPR' });
    expect(r.body.items.find((i: any) => i.id === s.items[1].id)).not.toHaveProperty('urgent_surcharge');
  });

  it('pre-registered order: no registered_at, status pre_registered; cancelled order: cancelled_at + cancel_reason_code are returned', { timeout: T }, async () => {
    const pre = await scenario({ stored: 'pre_registered', items: ['not_started'], order: { registered_at: null } });
    const a = await getOrder(pre.order.id, { s: pre });
    expect(a.body.status).toBe('pre_registered'); expect(a.body).not.toHaveProperty('registered_at'); expect(schemaErrors('OrderDto', a.body)).toEqual([]);
    const can = await scenario({ stored: 'cancelled', items: ['not_started'] });
    const b = await getOrder(can.order.id, { s: can });
    expect(b.body).toMatchObject({ status: 'cancelled', cancel_reason_code: 'patient_request' });
    expect(b.body.cancelled_at).toBeTypeOf('string'); expect(schemaErrors('OrderDto', b.body)).toEqual([]);
  });

  it('read-only: the request tx performs no write', { timeout: T }, async () => {
    const s = await scenario({ items: ['in_progress'] });
    expect((await getOrder(s.order.id, { s })).wrote).toBe(false);
  });

  it('TRF entries are metadata only: no object_path, no sha256, no URL/content anywhere in the body (07-SECURITY P2; F21a is the only content route)', { timeout: T }, async () => {
    const s = await scenario({ items: ['not_started'] });
    const trf = rows.trf('a', s.order.id);
    await seed('frontdesk.trf_attachments', trf);
    const body = JSON.stringify((await getOrder(s.order.id, { s })).body);
    expect(body).not.toContain(trf.object_path);
    expect(body).not.toContain(trf.sha256);
    expect(body).not.toMatch(/object_path|sha256|https?:\/\/|\/content/);
    expect(body).toContain(trf.id);
  });

  it('logs never carry patient name / phone / registration no (07-SECURITY §5.1)', { timeout: T }, async () => {
    const s = await scenario({ items: ['reported'] });
    const r = await getOrder(s.order.id, { s });
    const logs = r.probe.logs.join('\n');
    expect(logs).not.toContain(s.patient.full_name);
    expect(logs).not.toContain(s.patient.phone_e164);
    expect(logs).not.toContain(s.order.registration_no);
  });

  it('requires frontdesk.order.read: patient.read alone -> 403 auth.forbidden, and nothing is fetched from the lab', { timeout: T }, async () => {
    const s = await scenario({ items: ['reported'] });
    const e = await getFails(s.order.id, { s, grants: ['frontdesk.patient.read'] });
    expect(e.code).toBe('auth.forbidden');
    expect(s.labPortCalls()).toHaveLength(0);
  });

  it('unknown id -> 404 common.not_found; detail does not echo the id', { timeout: T }, async () => {
    const s = await scenario({ items: ['not_started'] });
    const id = uid();
    const e = await getFails(id, { s });
    expect(e.code).toBe('common.not_found');
    expect(String(e.detail ?? e.message ?? '')).not.toContain(id);
  });
  it('malformed id -> common.validation_failed (or not_found); never a 500', { timeout: T }, async () => {
    const s = await scenario({ items: ['not_started'] });
    for (const bad of ['not-a-uuid', "' OR 1=1 --", '', '0'.repeat(300)]) {
      const e = await getFails(bad, { s });
      expect(['common.validation_failed', 'common.not_found']).toContain(e.code);
    }
  });

  it('cross-tenant 6.1: tenant B reads A order -> 404 and A reads B order -> 404; a response never mixes tenants', { timeout: T }, async () => {
    const a = await scenario({ side: 'a', items: ['not_started'] });
    const b = await scenario({ side: 'b', items: ['not_started'] });
    expect((await getFails(a.order.id, { tenant: TENANT_B, s: a })).code).toBe('common.not_found');
    expect((await getFails(b.order.id, { tenant: TENANT_A, s: b })).code).toBe('common.not_found');
    expect((await getOrder(b.order.id, { tenant: TENANT_B, s: b })).body.patient.id).toBe(b.patient.id);
  });

  it('cross-centre 6.2: a user scoped to centre A1 cannot read an A2 order (404); an all-centre-scoped user (A1+A2) can', { timeout: T }, async () => {
    const s = await scenario({ items: ['not_started'], centre: CENTRE_A2 });
    expect((await getFails(s.order.id, { s, centreIds: [CENTRE.a] })).code).toBe('common.not_found');
    expect((await getOrder(s.order.id, { s, centreIds: [CENTRE.a, CENTRE_A2] })).status).toBe(200);
  });

  it('a DTO built from another tenant\'s rows is impossible: a hostile item row (tenant B) attached to the same order id is never returned', { timeout: T }, async () => {
    const a = await scenario({ items: ['not_started'] });
    const b = await scenario({ side: 'b', items: ['not_started'] });
    const r = await getOrder(a.order.id, { s: a });
    expect(r.body.items.map((i: any) => i.id)).not.toContain(b.items[0].id);
    expect(JSON.stringify(r.body)).not.toContain(b.patient.id);
  });
});

describe('F10 listOrders', () => {
  const Y = 2041;
  it('200 OrderSummaryPage: rows are schema-valid; patient_display, item_count (active only), has_open_flag (open only), centre/billing/source/version', { timeout: T }, async () => {
    const shared = sharedFakes();
    const s = await scenario({ items: ['not_started', 'not_started', { lab: 'not_started', status: 'removed' }], order: { registered_at: when(Y, 1) } });
    await seed('frontdesk.order_flags', rows.flag('a', s.order.id));
    const t = await scenario({ items: ['not_started'], order: { registered_at: when(Y, 2) } });
    await seed('frontdesk.order_flags', rows.flag('a', t.order.id, { status: 'resolved', resolved_at: '2026-11-08T00:00:00Z', resolved_by: uid(), resolution_code: 'recollected' }));
    mergeInto(shared, s); mergeInto(shared, t);
    const r = await listOrders({ ...win(Y), limit: 50 }, { lab: shared.lab, billing: shared.billing });
    expect(r.status).toBe(200);
    expect(schemaErrors('OrderSummaryPage', r.body)).toEqual([]);
    const a = r.body.data.find((x: any) => x.id === s.order.id), b = r.body.data.find((x: any) => x.id === t.order.id);
    expect(a).toMatchObject({ registration_no: s.order.registration_no, patient_id: s.patient.id, patient_display: s.patient.full_name, centre_id: CENTRE.a, status: 'registered',
      billing_mode: 'cash', source: 'front_desk', item_count: 2, has_open_flag: true });
    expect(b).toMatchObject({ item_count: 1, has_open_flag: false });
    expect(r.wrote).toBe(false);
    expect(r.body.page.limit).toBe(50);
  });

  it('default sort is -registered_at (newest first, id tiebreak); sort=registered_at reverses it', { timeout: T }, async () => {
    const Yr = 2042;
    const made = [];
    for (const d of [1, 2, 3, 4]) made.push(await scenario({ items: ['not_started'], order: { registered_at: when(Yr, d) } }));
    const want = made.map((s) => s.order.id);
    const shared = sharedFakes(); made.forEach((s) => mergeInto(shared, s));
    const o = { lab: shared.lab, billing: shared.billing };
    expect(ids(await listOrders({ ...win(Yr) }, o))).toEqual([...want].reverse());
    expect(ids(await listOrders({ ...win(Yr), sort: '-registered_at' }, o))).toEqual([...want].reverse());
    expect(ids(await listOrders({ ...win(Yr), sort: 'registered_at' }, o))).toEqual(want);
  });

  it('ties on registered_at are ordered by id in the sort direction, and paging across ties loses/duplicates nothing', { timeout: T }, async () => {
    const Yr = 2044;
    const made = [];
    for (let k = 0; k < 5; k++) made.push(await scenario({ items: ['not_started'], order: { registered_at: when(Yr, 7) } }));
    const shared = sharedFakes(); made.forEach((s) => mergeInto(shared, s));
    const o = { lab: shared.lab, billing: shared.billing };
    const desc = await allPages({ ...win(Yr), limit: 2 }, o);
    expect(desc.pages).toBe(3);
    expect(desc.data.map((x) => x.id)).toEqual(made.map((s) => s.order.id).sort().reverse());
    const asc = await allPages({ ...win(Yr), limit: 2, sort: 'registered_at' }, o);
    expect(asc.data.map((x) => x.id)).toEqual(made.map((s) => s.order.id).sort());
  });

  it('keyset paging: next_cursor only when more rows exist; the last page has none; every row appears exactly once', { timeout: T }, async () => {
    const Yr = 2045;
    const made = [];
    for (const d of [1, 2, 3, 4, 5, 6, 7]) made.push(await scenario({ items: ['not_started'], order: { registered_at: when(Yr, d) } }));
    const shared = sharedFakes(); made.forEach((s) => mergeInto(shared, s));
    const o = { lab: shared.lab, billing: shared.billing };
    const first = await listOrders({ ...win(Yr), limit: 3 }, o);
    expect(first.body.data).toHaveLength(3); expect(first.body.page.next_cursor).toBeTypeOf('string');
    const all = await allPages({ ...win(Yr), limit: 3 }, o);
    expect(all.pages).toBe(3);
    expect(all.data.map((x) => x.id)).toEqual(made.map((s) => s.order.id).reverse());
    const exact = await listOrders({ ...win(Yr), limit: 7 }, o);
    expect(exact.body.data).toHaveLength(7); expect(exact.body.page).not.toHaveProperty('next_cursor');
  });

  it('filters: status (stored values), source, has_open_flag, centre_id, registered_at window — each narrows the window set', { timeout: T }, async () => {
    const Yr = 2046;
    const mk = (o: any, d: number) => scenario({ items: ['not_started'], ...o, order: { registered_at: when(Yr, d), ...(o.order ?? {}) } });
    const reg = await mk({}, 1);
    const pre = await mk({ stored: 'pre_registered' }, 2);   // registered_at set on purpose: whether a NULL registered_at matches a window is unspecified (not asserted)
    const can = await mk({ stored: 'cancelled' }, 3);
    const hb = await mk({ order: { source: 'home_collection', source_ref_id: uid() } }, 4);
    const a2 = await mk({ centre: CENTRE_A2 }, 5);
    const flagged = await mk({}, 6);
    await seed('frontdesk.order_flags', rows.flag('a', flagged.order.id));
    const shared = sharedFakes(); [reg, pre, can, hb, a2, flagged].forEach((s) => mergeInto(shared, s));
    const o = { lab: shared.lab, billing: shared.billing, centreIds: [CENTRE.a, CENTRE_A2] };
    const q = async (extra: object) => ids(await listOrders({ ...win(Yr), limit: 200, ...extra }, o)).sort();
    const sorted = (...x: any[]) => x.map((s) => s.order.id).sort();
    expect(await q({ status: 'cancelled' })).toEqual(sorted(can));
    expect(await q({ status: 'pre_registered' })).toEqual(sorted(pre));
    expect(await q({ source: 'home_collection' })).toEqual(sorted(hb));
    expect(await q({ has_open_flag: true })).toEqual(sorted(flagged));
    expect(await q({ has_open_flag: false })).toEqual(sorted(reg, can, hb, a2, pre));
    expect(await q({ centre_id: CENTRE_A2 })).toEqual(sorted(a2));
    expect(await q({ registered_at_from: when(Yr, 3, 0), registered_at_to: when(Yr, 4, 23) })).toEqual(sorted(can, hb));
  });

  it('no permission -> 403 auth.forbidden', { timeout: T }, async () => {
    expect((await listFails({}, { grants: ['frontdesk.patient.read'] })).code).toBe('auth.forbidden');
  });

  it('malformed query -> common.validation_failed: bad sort, bad limit (0, 201, text), bad status, bad uuid, bad timestamp, bad boolean, unknown parameter', { timeout: T }, async () => {
    for (const q of [{ sort: 'patient_name' }, { limit: 0 }, { limit: 201 }, { limit: 'x' }, { status: 'done' }, { centre_id: 'nope' }, { registered_at_from: 'yesterday' },
      { has_open_flag: 'maybe' }, { tenant_id: TENANT_B }, { status: ['registered', 'cancelled'] }]) {
      const e = await listFails(q as object, {});
      expect(e.code, JSON.stringify(q)).toBe('common.validation_failed');
    }
  });

  it('cursor: garbage / wrong sort / tampered -> 400 common.invalid_cursor (never a 500, never SQL)', { timeout: T }, async () => {
    const Yr = 2047;
    const made = [await scenario({ items: ['not_started'], order: { registered_at: when(Yr, 1) } }), await scenario({ items: ['not_started'], order: { registered_at: when(Yr, 2) } })];
    const shared = sharedFakes(); made.forEach((s) => mergeInto(shared, s));
    const o = { lab: shared.lab, billing: shared.billing };
    const page = await listOrders({ ...win(Yr), limit: 1 }, o);
    const cur = page.body.page.next_cursor as string;
    expect((await listFails({ ...win(Yr), cursor: 'garbage!!' }, o)).code).toBe('common.invalid_cursor');
    expect((await listFails({ ...win(Yr), cursor: Buffer.from("[\"-registered_at\",\"x'; DROP TABLE frontdesk.orders;--\",\"y\"]").toString('base64url') }, o)).code).toBe('common.invalid_cursor');
    expect((await listFails({ ...win(Yr), cursor: cur, sort: 'registered_at' }, o)).code).toBe('common.invalid_cursor');
    expect((await listFails({ ...win(Yr), cursor: 'A'.repeat(600) }, o)).code).toBe('common.invalid_cursor');
  });

  it('cross-tenant 6.1: with tenant B orders in the same window, tenant A sees zero B rows (and vice versa); DB check as owner', { timeout: T }, async () => {
    const Yr = 2048;
    const a = await scenario({ side: 'a', items: ['not_started'], order: { registered_at: when(Yr, 1) } });
    const b = await scenario({ side: 'b', items: ['not_started'], order: { registered_at: when(Yr, 1) } });
    const shared = sharedFakes(); mergeInto(shared, a); mergeInto(shared, b);
    const o = { lab: shared.lab, billing: shared.billing };
    const ra = await listOrders({ ...win(Yr), limit: 200 }, { ...o, tenant: TENANT_A });
    const rb = await listOrders({ ...win(Yr), limit: 200 }, { ...o, tenant: TENANT_B });
    expect(ids(ra)).toContain(a.order.id); expect(ids(ra)).not.toContain(b.order.id);
    expect(ids(rb)).toContain(b.order.id); expect(ids(rb)).not.toContain(a.order.id);
    for (const row of ra.body.data) expect((await ownerRows('frontdesk.orders', 'id = $1', [row.id]))[0].tenant_id).toBe(TENANT_A);
    expect(JSON.stringify(ra.body)).not.toContain(b.patient.id);
  });

  it('cross-centre 6.2: A1-scoped user sees no A2 rows; centre_id=A2 yields nothing (empty page or 404); an A1+A2 user sees both', { timeout: T }, async () => {
    const Yr = 2049;
    const a1 = await scenario({ items: ['not_started'], order: { registered_at: when(Yr, 1) } });
    const a2 = await scenario({ items: ['not_started'], centre: CENTRE_A2, order: { registered_at: when(Yr, 2) } });
    const shared = sharedFakes(); mergeInto(shared, a1); mergeInto(shared, a2);
    const o = { lab: shared.lab, billing: shared.billing };
    const scoped = await listOrders({ ...win(Yr), limit: 200 }, { ...o, centreIds: [CENTRE.a] });
    expect(ids(scoped)).toEqual([a1.order.id]);
    try { expect(ids(await listOrders({ ...win(Yr), centre_id: CENTRE_A2 }, { ...o, centreIds: [CENTRE.a] }))).toEqual([]); }
    catch (e: any) { expect(e.code).toBe('common.not_found'); }
    expect(ids(await listOrders({ ...win(Yr), limit: 200 }, { ...o, centreIds: [CENTRE.a, CENTRE_A2] })).sort()).toEqual([a1.order.id, a2.order.id].sort());
  });

  it('PHI: patient_display is the only name field; logs carry no name/phone/registration no', { timeout: T }, async () => {
    const Yr = 2050;
    const s = await scenario({ items: ['not_started'], order: { registered_at: when(Yr, 1) } });
    const shared = sharedFakes(); mergeInto(shared, s);
    const r = await listOrders({ ...win(Yr) }, { lab: shared.lab, billing: shared.billing });
    const row = r.body.data.find((x: any) => x.id === s.order.id);
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['phone_e164']));
    expect(JSON.stringify(row)).not.toContain(s.patient.phone_e164);
    const logs = r.probe.logs.join('\n');
    expect(logs).not.toContain(s.patient.full_name); expect(logs).not.toContain(s.patient.phone_e164); expect(logs).not.toContain(s.order.registration_no);
  });
});
