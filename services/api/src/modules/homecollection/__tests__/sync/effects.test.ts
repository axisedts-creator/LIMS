// HC-T12 push effects + events: what a pushed batch writes besides `mutations` (collections, transitions, GPS rows, handovers + items, flags, route version) and the homecollection.collection.synced.v1 event(s) it emits
// (02-TRD §6.3 steps 4.6, 5, §7.5 clock, §8.1; 03-IC §3.23; 03-APP-FLOW §4 handover row, §5.7). 01-PRD US-07-1 (stored mutations), US-08-1/4/9, US-12-1/3, 07-SECURITY AB15, §5 item 12 (event PHI).
// Handover seam (the only table the spec does not name a writer for): handovers.centre_id = the centre of the included collections; handovers.mutation_id = the handover mutation's row id; items store barcode +
// specimen_type_code FROM LabPort.lookupSpecimens (not from the device payload, D-125); skipped specimens are NOT item rows (only per-item outcomes in PushResponse.handover_items).
// Fails now: A3 is an HC-T01 stub (common.internal "not implemented").
import { describe, expect, it } from 'vitest';
import { A, EVENT, HC_CENTRE, M, MEMBER, MEMBER2, OTHER_CENTRE, T, TENANT_B, addVisit, at, batchOf, codes, colRows, eventKeyRe, eventsOf, flagRows, fullFlow, handoverRows, hc, itemRows, keysDeep, locationRows, mutByClient,
  mutRows, outcomes, ownerRows, push, pushM, pushWorld, routeRow, seed, setSettings, stringsDeep, transitionRows, uid, v7, visitRow, type Mut, type PushWorld } from './helpers.js';

const FILE = 2;
const ev = async (w: PushWorld) => eventsOf(w.who.tenant, w.visit.id);
const payloadsOf = async (w: PushWorld) => (await ev(w)).map((e) => e.envelope.payload);
const sameCaptured = (m: Mut, over: Partial<Mut['captured']>): Mut => ({ ...m, captured: { ...m.captured, ...over } });

describe('homecollection.collection.synced.v1 (US-08-1, 03-IC §3.23, TRD §8.1)', () => {
  it('US-08-1: the 7-mutation flow emits ONE event for the visit: 2 collections (barcode_verified true) + 1 cash payment 180000 NPR; payload mapping, aggregate home_visit seq = visit version, key <visit_id>:sync:<sha256>', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = fullFlow(w);
    const r = await pushM(w, ms);
    expect(outcomes(r)).toEqual(Array(7).fill('applied'));
    const evs = await ev(w);
    expect(evs).toHaveLength(1);
    const e = evs[0]!;
    expect(e.event_type).toBe(EVENT);
    expect(e.idempotency_key).toMatch(eventKeyRe(w.visit.id));
    const v = await visitRow(w.visit.id);
    expect(e.envelope.producer).toBe('homecollection');
    expect(e.envelope.aggregate).toEqual({ type: 'home_visit', id: w.visit.id, seq: v.version });
    const col = ms.filter((m) => m.type === 'specimen.collected'), pay = ms.find((m) => m.type === 'payment.captured')!;
    expect(e.envelope.payload).toEqual({
      visit_id: w.visit.id, order_id: w.order.id, phlebotomist_membership_id: w.member, synced_at: w.now.toISOString(),
      collections: col.map((c, i) => ({ client_mutation_id: c.client_mutation_id, specimen_id: c.payload.specimen_id, barcode_verified: true, collected_at_device: at(w.date, i === 0 ? '04:10' : '04:11') })),
      payments: [{ client_mutation_id: pay.client_mutation_id, payment_method_code: 'cash', amount: { amount_paisa: 180000, currency: 'NPR' }, captured_at_device: at(w.date, '04:15') }],
    });
  });
  it('booking_id is present IFF the visit is kind=booking (08 A19 D-120); a front_desk visit has none', { timeout: T }, async () => {
    const fd = await pushWorld({ file: FILE });
    await pushM(fd, [M.payment(fd)]);
    expect('booking_id' in (await payloadsOf(fd))[0]).toBe(false);
    const bk = await pushWorld({ file: FILE, kind: 'booking' });
    await pushM(bk, [M.payment(bk)]);
    expect((await payloadsOf(bk))[0].booking_id).toBe(bk.visit.booking_id);
  });
  it('US-08-9: manual scan, barcode matches -> collection applied with barcode_verified false in the event', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    await pushM(w, [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!, { method: 'manual' })]);
    expect((await payloadsOf(w))[0].collections.map((c: any) => c.barcode_verified)).toEqual([false]);
  });
  it('optional payment reference travels in the event (CR-C17-006)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    await pushM(w, [M.payment(w, { reference: 'REF-SYN-0001' })]);
    expect((await payloadsOf(w))[0].payments[0].reference).toBe('REF-SYN-0001');
  });
  it('US-08-4: visit cancelled while the collection happened offline -> collection held (mutation_superseded), payment applied and forwarded (D-PAY), the visit stays cancelled, flag collected_after_cancel, the event carries the payment ONLY', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, status: 'cancelled' });
    const r = await pushM(w, [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!), M.payment(w)]);
    expect(r.body.results.map((x: any) => [x.outcome, x.code])).toEqual([['applied', undefined], ['applied', undefined], ['held', A + 'mutation_superseded'], ['applied', undefined]]);
    expect((await visitRow(w.visit.id)).status).toBe('cancelled');
    expect((await flagRows(w.visit.id)).filter((f) => f.status === 'open').map((f) => f.kind)).toContain('collected_after_cancel');
    const [p] = await payloadsOf(w);
    expect([p.collections, p.payments.length]).toEqual([[], 1]);
  });
  it('no event when nothing collected/paid was applied: only arrived/identity/consent/completed, only held collections, only rejected payments', { timeout: T }, async () => {
    const a = await pushWorld({ file: FILE });
    await pushM(a, [M.arrived(a), M.identity(a), M.consent(a), M.completed(a)]);
    expect(await ev(a)).toHaveLength(0);
    const b = await pushWorld({ file: FILE });
    await pushM(b, [M.collected(b, b.specimens[0]!)]);   // no identity -> held
    expect(await ev(b)).toHaveLength(0);
    const c = await pushWorld({ file: FILE });
    await pushM(c, [M.payment(c, { method: 'barter_goats' })]);
    expect(await ev(c)).toHaveLength(0);
  });
  it('one event per VISIT per batch: two visits in one batch -> two events, each on its own aggregate with its own mutations', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const o = await addVisit(w);
    await pushM(w, [M.payment(w), M.payment(w, { visit: o.visit.id, order: o.order.id, min: 16 })]);
    const [a, b] = [await ev(w), await eventsOf(w.who.tenant, o.visit.id)];
    expect([a.length, b.length]).toEqual([1, 1]);
    expect(a[0]!.envelope.payload.order_id).toBe(w.order.id);
    expect(b[0]!.envelope.payload.order_id).toBe(o.order.id);
  });
  it('US-12 §5.12 event PHI: no barcode, name, GPS, address, registration number anywhere in the event (keys or values)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const gps = { status: 'ok', latitude: '27.717200', longitude: '85.324000', accuracy_m: 12 };
    await pushM(w, [M.arrived(w, { gps }), M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!, { gps }), M.payment(w, { reference: 'REF-SYN-9' })]);
    const [p] = await payloadsOf(w);
    const keys = [...keysDeep(p)];
    for (const k of ['barcode', 'scanned_barcode', 'gps', 'latitude', 'longitude', 'accuracy_m', 'full_name', 'patient_name', 'address_text', 'landmark', 'phone_e164', 'registration_no', 'scan_method']) expect(keys, k).not.toContain(k);
    const strs = stringsDeep(p).join('|');
    for (const s of [w.specimens[0]!.barcode, '27.717200', '85.324000', w.visit.address_text, w.visit.landmark ?? 'no-landmark', w.patient.full_name]) expect(strs, s).not.toContain(s);
  });
  it('split: > 50 collections of one visit in one batch -> several events with DISJOINT mutation sets, each <= 50 collections, distinct keys, union = all 60', { timeout: 240_000 }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 60 });
    const ms = [M.identity(w), M.consent(w), ...w.specimens.map((s, i) => M.collected(w, s, { min: 10 + (i % 50), typeCode: s.specimenTypeCode }))];
    const r = await pushM(w, ms);
    expect(outcomes(r).filter((o) => o === 'applied')).toHaveLength(62);
    const evs = await ev(w);
    const sizes = evs.map((e) => e.envelope.payload.collections.length).sort((a, b) => b - a);
    expect(sizes).toEqual([50, 10]);
    const ids = evs.flatMap((e) => e.envelope.payload.collections.map((c: any) => c.client_mutation_id));
    expect(new Set(ids).size).toBe(60);
    expect(new Set(evs.map((e) => e.idempotency_key)).size).toBe(2);
    expect(evs.every((e) => e.idempotency_key.match(eventKeyRe(w.visit.id)))).toBe(true);
  });
  it('split: > 10 payments of one visit -> several events, each <= 10 payments, every payment in exactly one event', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const pays = Array.from({ length: 11 }, (_x, i) => M.payment(w, { paisa: 100 + i, min: 15 }));
    expect(outcomes(await pushM(w, pays))).toEqual(Array(11).fill('applied'));
    const evs = await ev(w);
    expect(evs.length).toBeGreaterThanOrEqual(2);
    expect(evs.every((e) => e.envelope.payload.payments.length <= 10)).toBe(true);
    const ids = evs.flatMap((e) => e.envelope.payload.payments.map((p: any) => p.client_mutation_id));
    expect(ids.sort()).toEqual(pays.map((p) => p.client_mutation_id).sort());
  });
});

describe('server clock correction on pushed mutations (TRD §7.5, AB15)', () => {
  const stamped = async (w: PushWorld, m: Mut) => { const row = await mutByClient(m.client_mutation_id); return { at: row.captured_at.toISOString(), raw: row.captured_at_device.toISOString(), src: row.clock_source, suspect: row.clock_suspect }; };
  it('anchor in the batch + same boot -> captured_at = anchor.server_time + elapsed, clock_source anchor, the raw device time kept in captured_at_device', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const m = sameCaptured(M.consent(w, { min: 30 }), { device_wall_time: at(w.date, '04:35') });   // device clock 5 minutes fast
    await pushM(w, [m]);
    expect(await stamped(w, m)).toEqual({ at: at(w.date, '04:30'), raw: at(w.date, '04:35'), src: 'anchor', suspect: false });
  });
  it('anchor from a previous boot -> offset (device_wall + (anchor.server - anchor.device_wall)), clock_source offset', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const m = sameCaptured(M.consent(w, { min: 30 }), { device_wall_time: at(w.date, '04:31') });
    const body = batchOf(w, [m], { anchors: [{ anchor_id: w.anchorId, server_time: at(w.date, '04:00'), device_wall_time: at(w.date, '04:01'), monotonic_ms: 1000, boot_id: 'b-1' }],
      now: { device_wall_time: at(w.date, '05:59'), monotonic_ms: 5, boot_id: 'b-2' } });
    await push(w, body);
    expect(await stamped(w, m)).toMatchObject({ at: at(w.date, '04:30'), src: 'offset', suspect: false });
  });
  it('no anchor at all -> the device time is used as is, clock_source device', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const m = sameCaptured(M.consent(w, { min: 30 }), { device_wall_time: at(w.date, '04:31') });
    await push(w, batchOf(w, [m], { anchors: [] }));
    expect(await stamped(w, m)).toMatchObject({ at: at(w.date, '04:31'), src: 'device', suspect: false });
  });
  it('AB15: a device clock set to the future is clamped to the server receipt time and flagged clock_suspect; the event carries the corrected time', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const m = sameCaptured(M.payment(w), { device_wall_time: '2099-01-01T00:00:00.000Z', anchor_id: v7(), elapsed_since_anchor_ms: -1 });
    await push(w, batchOf(w, [m], { anchors: [] }));
    expect(await stamped(w, m)).toEqual({ at: w.now.toISOString(), raw: '2099-01-01T00:00:00.000Z', src: 'device', suspect: true });
    expect((await payloadsOf(w))[0].payments[0].captured_at_device).toBe(w.now.toISOString());
  });
  it('a capture far BEFORE assignment is clamped up to assigned_at - clock_tolerance_seconds (600 s) and flagged', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const m = sameCaptured(M.consent(w), { device_wall_time: '2020-01-01T00:00:00.000Z', anchor_id: v7(), elapsed_since_anchor_ms: -1 });
    await push(w, batchOf(w, [m], { anchors: [] }));
    const s = await stamped(w, m);
    const settings = (await ownerRows('homecollection.settings', 'tenant_id = $1', [w.who.tenant]))[0];
    expect(new Date(s.at).getTime()).toBe(new Date(w.visit.assigned_at).getTime() - settings.clock_tolerance_seconds * 1000);
    expect(s.suspect).toBe(true);
  });
});

describe('effects of applied mutations', () => {
  it('GPS: status ok -> one visit_locations row (kind arrived | collected | failed) with expires_at = captured_at + gps_retention_days; off/denied/unavailable -> no row; the mutation payload keeps the gps (P2)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ok = { status: 'ok', latitude: '27.717200', longitude: '85.324000', accuracy_m: 12 };
    const arrived = M.arrived(w, { gps: ok });
    const coll = M.collected(w, w.specimens[0]!, { gps: ok });
    await pushM(w, [arrived, M.identity(w), M.consent(w), coll, M.collected(w, w.specimens[1]!, { gps: { status: 'denied' }, min: 11 })]);
    const locs = await locationRows(w.visit.id);
    expect(locs.map((l) => l.kind)).toEqual(['arrived', 'collected']);
    const days = (await ownerRows('homecollection.settings', 'tenant_id = $1', [w.who.tenant]))[0].gps_retention_days;
    for (const l of locs) {
      expect([Number(l.latitude), Number(l.longitude), l.accuracy_m]).toEqual([27.7172, 85.324, 12]);
      expect(new Date(l.expires_at).getTime() - new Date(l.captured_at).getTime()).toBe(days * 86400000);
    }
    expect(locs.map((l) => l.mutation_id).sort()).toEqual([(await mutByClient(arrived.client_mutation_id)).id, (await mutByClient(coll.client_mutation_id)).id].sort());
    const f = await pushWorld({ file: FILE });
    await pushM(f, [M.failed(f, { reason: 'patient_not_home' })]);   // M.failed sends gps off
    expect(await locationRows(f.visit.id)).toHaveLength(0);
  });
  it('a held or rejected mutation writes NO gps row and no transition (only applied ones have effects)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    await pushM(w, [M.arrived(w, { gps: { status: 'ok', latitude: '27.700000', longitude: '85.300000' } })]);
    expect(await locationRows(w.visit.id)).toHaveLength(0);
    expect(await transitionRows(w.visit.id)).toHaveLength(0);
  });
  it('route version (§4.1): a status change bumps the visit\'s route version in the same tx; a replay / all-rejected batch does not', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const v0 = (await routeRow(w.route.id)).version;
    const ms = [M.arrived(w)];
    await pushM(w, ms);
    const v1 = (await routeRow(w.route.id)).version;
    expect(v1).toBeGreaterThan(v0);
    await pushM(w, ms);   // duplicate
    expect((await routeRow(w.route.id)).version).toBe(v1);
    const closed = await pushWorld({ file: FILE, status: 'completed' });
    const c0 = (await routeRow(closed.route.id)).version;
    await pushM(closed, [M.arrived(closed)]);   // rejected visit_closed
    expect((await routeRow(closed.route.id)).version).toBe(c0);
  });
  it('mutations are stored with author, device, batch, corrected time and received_at (07 STRIDE R: append-only forensic record)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = fullFlow(w);
    const r = await pushM(w, ms);
    const rows = await mutRows(w);
    expect(rows.map((x) => x.type)).toEqual(ms.map((m) => m.type));
    for (const x of rows) {
      expect([x.membership_id, x.device_id, x.batch_id, x.tenant_id, x.centre_id, x.visit_id]).toEqual([w.member, w.device.id, r.body.batch_id, w.who.tenant, w.visit.centre_id, w.visit.id]);
      expect(new Date(x.received_at).getTime()).toBe(w.now.getTime());
      expect(Number(x.device_seq)).toBeGreaterThanOrEqual(1);
    }
    expect(rows.map((x) => x.client_mutation_id)).toEqual(ms.map((m) => m.client_mutation_id));
  });
});

describe('handover.recorded (US-12-1, US-12-3, 03-APP-FLOW §4 + §5.7, D-125)', () => {
  const three = (w: PushWorld) => w.specimens;
  const collectAll = (w: PushWorld): Mut[] => [M.identity(w), M.consent(w), ...three(w).map((s, i) => M.collected(w, s, { min: 10 + i }))];
  it('US-12-1: 3 applied collections by A handed to centre C -> handover pending, 3 items included, from_membership_id = A, handed_over_at = corrected capture time; items carry barcode + specimen_type_code FROM LabPort (not the device payload)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 3, types: ['SST', 'EDTA', 'FLUORIDE'] });
    const h = M.handover(w, w.specimens.map((s) => s.specimenId), { min: 40 });
    const ms = [...collectAll(w).map((m) => (m.type === 'specimen.collected' ? { ...m, payload: { ...m.payload, specimen_type_code: 'DEVICE_SAYS' } } : m)), h];
    const r = await pushM(w, ms);
    expect(outcomes(r)).toEqual(Array(6).fill('applied'));
    expect(r.body.handover_items).toHaveLength(3);
    expect(r.body.handover_items.every((i: any) => i.handover_id === h.payload.handover_id && i.outcome === 'included')).toBe(true);
    expect(r.body.handover_items.map((i: any) => i.specimen_id).sort()).toEqual(w.specimens.map((s) => s.specimenId).sort());
    const [ho] = await handoverRows(w);
    expect([ho.id, ho.status, ho.from_membership_id, ho.to_centre_id, ho.centre_id, ho.mutation_id]).toEqual([h.payload.handover_id, 'pending', w.member, OTHER_CENTRE.a, w.visit.centre_id, (await mutByClient(h.client_mutation_id)).id]);
    expect(new Date(ho.handed_over_at).toISOString()).toBe(at(w.date, '04:40'));
    expect(new Date(ho.handed_over_at_device).toISOString()).toBe(at(w.date, '04:40'));
    const items = await itemRows(ho.id);
    expect(items.map((i) => [i.barcode, i.specimen_type_code]).sort()).toEqual(w.specimens.map((s) => [s.barcode, s.specimenTypeCode]).sort());
    expect(items.every((i) => i.outcome === null && i.to_centre_id === OTHER_CENTRE.a && i.visit_id === w.visit.id && i.centre_id === ho.centre_id)).toBe(true);
    expect(r.probe.lab.map((c) => c.orderId)).toContain(w.order.id);   // lookup by {orderId} for the orders of the handed-over collections
    expect((await mutByClient(h.client_mutation_id)).centre_id).toBe(w.visit.centre_id);
    expect((await mutByClient(h.client_mutation_id)).visit_id).toBeNull();
  });
  it('handover in a LATER batch than the collections works the same (the collections are "applied earlier")', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 2 });
    await pushM(w, collectAll(w));
    const r = await pushM(w, [M.handover(w, w.specimens.map((s) => s.specimenId))]);
    expect(outcomes(r)).toEqual(['applied']);
    expect(await handoverRows(w)).toHaveLength(1);
  });
  it('US-12-3: not collected by A -> skipped_not_collected; already handed over -> skipped_already_handed_over; included ones still go through; skipped specimens are not item rows', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 3 });
    const [s0, s1, s2] = w.specimens as [typeof w.specimens[0], typeof w.specimens[0], typeof w.specimens[0]];
    await pushM(w, [M.identity(w), M.consent(w), M.collected(w, s0), M.collected(w, s1, { min: 11 })]);   // s2 never collected
    const h1 = M.handover(w, [s0.specimenId]);
    expect(outcomes(await pushM(w, [h1]))).toEqual(['applied']);
    const h2 = M.handover(w, [s0.specimenId, s1.specimenId, s2.specimenId]);
    const r = await pushM(w, [h2]);
    expect(r.body.results[0].outcome).toBe('applied');
    const by = Object.fromEntries(r.body.handover_items.map((i: any) => [i.specimen_id, i.outcome]));
    expect(by).toEqual({ [s0.specimenId]: 'skipped_already_handed_over', [s1.specimenId]: 'included', [s2.specimenId]: 'skipped_not_collected' });
    expect((await itemRows(h2.payload.handover_id)).map((i) => i.barcode)).toEqual([s1.barcode]);
    expect((await itemRows(h1.payload.handover_id)).map((i) => i.barcode)).toEqual([s0.barcode]);   // untouched
  });
  it('a HELD collection is not a collection by A for handover purposes -> skipped_not_collected (0 included -> mutation rejected)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 2 });
    await pushM(w, [M.collected(w, w.specimens[0]!)]);   // no identity/consent -> held
    expect((await colRows(w.visit.id)).map((c) => c.status)).toEqual(['held']);
    const r = await pushM(w, [M.handover(w, [w.specimens[0]!.specimenId])]);
    expect(r.body.results[0]).toMatchObject({ outcome: 'rejected', code: 'common.validation_failed' });
    expect(r.body.handover_items.map((i: any) => i.outcome)).toEqual(['skipped_not_collected']);
  });
  it('a specimen collected (applied) by ANOTHER phlebotomist is not A\'s to hand over -> skipped_not_collected', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 2 });
    const dev2 = hc.device(w.s, { id: v7(), membership_id: MEMBER2.a });
    await seed('homecollection.devices', dev2);
    const b = hc.syncBatch(w.s, dev2.id, { membership_id: MEMBER2.a });
    await seed('homecollection.sync_batches', b);
    const m = hc.mutation(w.s, dev2.id, b.id, w.visit.id, { type: 'specimen.collected', membership_id: MEMBER2.a, centre_id: w.visit.centre_id });
    await seed('homecollection.mutations', m);
    await seed('homecollection.collections', hc.collection(w.s, { specimen: { id: w.specimens[0]!.specimenId }, order: w.order }, w.visit.id, m.id,
      { status: 'applied', hold_code: null, collected_by_membership_id: MEMBER2.a, centre_id: w.visit.centre_id }));
    await pushM(w, [M.identity(w), M.consent(w), M.collected(w, w.specimens[1]!)]);
    const r = await pushM(w, [M.handover(w, [w.specimens[0]!.specimenId, w.specimens[1]!.specimenId])]);
    const by = Object.fromEntries(r.body.handover_items.map((i: any) => [i.specimen_id, i.outcome]));
    expect(by).toEqual({ [w.specimens[0]!.specimenId]: 'skipped_not_collected', [w.specimens[1]!.specimenId]: 'included' });
  });
  it('0 included -> the mutation is rejected common.validation_failed and no handover row exists', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 1 });
    const r = await pushM(w, [M.handover(w, [w.specimens[0]!.specimenId])]);
    expect([outcomes(r), codes(r)]).toEqual([['rejected'], ['common.validation_failed']]);
    expect(await handoverRows(w)).toHaveLength(0);
    expect((await mutByClient(r.body.results[0].client_mutation_id)).outcome).toBe('rejected');   // kept (it has a null visit_id, so it can be stored)
  });
  it('handover across TWO centres (collections from visits of two centres) -> rejected common.validation_failed; nothing created; a single-centre handover of the other visit works and takes THAT centre', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 1 });
    const o = await addVisit(w, { centreId: OTHER_CENTRE.a, specimens: 1 });
    await pushM(w, [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!), M.identity(w, { visit: o.visit.id, min: 8 }), M.consent(w, { visit: o.visit.id, min: 9 }), M.collected(w, o.specimens[0]!, { visit: o.visit.id, min: 12 })]);
    expect((await colRows(o.visit.id)).map((c) => c.status)).toEqual(['applied']);
    const both = await pushM(w, [M.handover(w, [w.specimens[0]!.specimenId, o.specimens[0]!.specimenId], { to: HC_CENTRE.a })]);
    expect([outcomes(both), codes(both)]).toEqual([['rejected'], ['common.validation_failed']]);
    expect(await handoverRows(w)).toHaveLength(0);
    const only = M.handover(w, [o.specimens[0]!.specimenId], { to: HC_CENTRE.a });
    expect(outcomes(await pushM(w, [only]))).toEqual(['applied']);
    expect((await handoverRows(w))[0]!.centre_id).toBe(OTHER_CENTRE.a);
    expect((await mutByClient(only.client_mutation_id)).centre_id).toBe(OTHER_CENTRE.a);
  });
  it('to_centre_id must be an active centre of the tenant: unknown id and another tenant\'s centre -> rejected common.validation_failed, no handover row', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 1 });
    await pushM(w, collectAll(w));
    for (const to of [uid(), OTHER_CENTRE.b]) {
      expect(codes(await pushM(w, [M.handover(w, [w.specimens[0]!.specimenId], { to })]))).toEqual(['common.validation_failed']);
    }
    expect(await handoverRows(w)).toHaveLength(0);
  });
  it('handover_confirmation_required = false -> status confirmed at once, received_by_membership_id stays empty, received_at = handed_over_at (03-APP-FLOW §1.3)', { timeout: T }, async () => {
    await setSettings(TENANT_B, 'handover_confirmation_required = $2', [false]);   // helper: $1 is the tenant id
    try {
      const w = await pushWorld({ file: FILE, s: 'b', specimens: 1 });
      await pushM(w, collectAll(w));
      await pushM(w, [M.handover(w, [w.specimens[0]!.specimenId])]);
      const [ho] = await handoverRows(w);
      expect([ho.status, ho.received_by_membership_id, new Date(ho.received_at).getTime()]).toEqual(['confirmed', null, new Date(ho.handed_over_at).getTime()]);
    } finally { await setSettings(TENANT_B, 'handover_confirmation_required = $2', [true]); }
  });
  it('handover replayed in a new batch -> duplicate, still ONE handover and one set of items; a different handover_id for an already-handed specimen -> skipped_already_handed_over', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, specimens: 2 });
    await pushM(w, collectAll(w));
    const h = M.handover(w, w.specimens.map((s) => s.specimenId));
    await pushM(w, [h]);
    expect(outcomes(await pushM(w, [h]))).toEqual(['duplicate']);
    expect(await handoverRows(w)).toHaveLength(1);
    const again = await pushM(w, [M.handover(w, w.specimens.map((s) => s.specimenId))]);
    expect(again.body.handover_items.map((i: any) => i.outcome)).toEqual(['skipped_already_handed_over', 'skipped_already_handed_over']);
    expect(again.body.results[0].outcome).toBe('rejected');
  });
});
