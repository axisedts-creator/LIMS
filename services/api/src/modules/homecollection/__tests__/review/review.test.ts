// HC-T13 H9 reviewHeldCollection — 01-PRD US-09-1..4, 02-TRD §5.1 H9 + §8.1 trigger (b) (CR-C17-006), 03-APP-FLOW §1.2 C3/C4, 03-IC §3.23, 07-SECURITY §4 (phlebotomist -> 403), §6 (PHI).
// Fails now: H9 is an HC-T01 stub (common.internal "not implemented"); collection.service.ts + handlers/reviewHeldCollection.ts do not exist.
// ASSUMED (spec silent, flagged per test): If-Match "<version>" as H5-H8/H17; apply on a collection whose specimen already has another applied collection -> 409 mutation_superseded; a collection that
//   is applied/discarded (any decision) -> 409 collection_not_held; discard resolves the held_collection flag with resolution_code = reason_code and resolution_note = reason_text; apply stores
//   applied_event_id = the emitted event id; reviewed_by = actor user id OR membership id; apply leaves hold_code in place (the CollectionDto example does).
import { describe, expect, it } from 'vitest';
import { APPLY, COLLECTED_AT, COLLECTED_AT_DEVICE, DISCARD, DISPATCHER, DISPATCHER_B, EVENT, HC_CENTRE, NOBODY, NOW, PHLEBO, SYS_ACTOR, T, TENANT_A, TENANT_B, colRow, colRowsOfVisit, eventKeyRe,
  eventsOfVisit, flagOf, frozen, heldWorld, keysDeep, review, reviewFails, schemaErrors, staffName, stringsDeep, uid, visitRow } from './helpers.js';

const iso = (d: unknown) => new Date(d as string).toISOString();
const code = (e: any) => e?.code ?? e?.problem?.code;

describe('US-09-1: Apply a held collection -> applied + ONE homecollection.collection.synced.v1 with that collection only (CR-C17-006)', () => {
  it('200 CollectionDto (status applied, version+1, review block), row updated, one event', { timeout: T }, async () => {
    const w = await heldWorld();
    const r = await review(w.col.id, { ...APPLY, reason_text: 'Phone call with the phlebotomist' });
    expect(r.status).toBe(200);
    expect(schemaErrors('CollectionDto', r.body), JSON.stringify(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: w.col.id, version: 2, visit_id: w.visit.id, specimen_id: w.specimen.specimenId, client_mutation_id: w.col.client_mutation_id, status: 'applied',
      scan_method: 'camera', barcode_verified: true, collected_at: COLLECTED_AT, collected_by: { membership_id: w.member, display_name: staffName(w.member) },
      review: { decision: 'apply', reason_code: 'confirmed_with_phlebotomist', reason_text: 'Phone call with the phlebotomist', by_display: staffName(DISPATCHER.membershipId), at: NOW.toISOString() } });
    const row = await colRow(w.col.id);
    expect(row).toMatchObject({ status: 'applied', version: 2, review_decision: 'apply', review_reason_code: 'confirmed_with_phlebotomist', review_reason_text: 'Phone call with the phlebotomist' });
    expect(iso(row.reviewed_at)).toBe(NOW.toISOString());
    expect([SYS_ACTOR, DISPATCHER.membershipId]).toContain(row.reviewed_by);
    expect(row.updated_by).toBeTruthy();
    expect(await eventsOfVisit(w)).toHaveLength(1);
  });

  it('the event: type, aggregate home_visit seq = visit version, key <visit_id>:sync:<sha256>, collections = THAT collection only (corrected time, barcode_verified), no payments, actor = the dispatcher', { timeout: T }, async () => {
    const w = await heldWorld();
    const r = await review(w.col.id, APPLY);
    const evs = await eventsOfVisit(w);
    expect(evs).toHaveLength(1);
    const e = evs[0]!;
    expect(e.event_type).toBe(EVENT);
    expect(e.idempotency_key).toMatch(eventKeyRe(w.visit.id));
    expect(e.envelope.producer).toBe('homecollection');
    expect(e.envelope.aggregate).toEqual({ type: 'home_visit', id: w.visit.id, seq: (await visitRow(w.visit.id)).version });
    expect(e.envelope.actor).toMatchObject({ type: 'user', id: SYS_ACTOR, membership_id: DISPATCHER.membershipId });
    const p = e.envelope.payload;
    expect(p).toMatchObject({ visit_id: w.visit.id, order_id: w.order.id, phlebotomist_membership_id: w.member, synced_at: NOW.toISOString() });   // the AUTHOR of the collection, not the reviewer
    expect(p.collections).toEqual([{ client_mutation_id: w.col.client_mutation_id, specimen_id: w.specimen.specimenId, barcode_verified: true, collected_at_device: COLLECTED_AT }]);
    expect(iso(COLLECTED_AT_DEVICE)).not.toBe(iso(COLLECTED_AT));   // fixture sanity: the raw device time differs, the event must carry the corrected one (TRD §7.5)
    expect(p.payments ?? []).toEqual([]);
    expect(r.status).toBe(200);
    expect((await colRow(w.col.id)).applied_event_id).toBe(e.envelope.event_id);   // ASSUMED: column applied_event_id = this event
  });

  it('only the reviewed collection is in the event; a second held collection of the same visit stays held and unreported', { timeout: T }, async () => {
    const w = await heldWorld({ cols: [{}, {}] });
    await review(w.cols[1]!.row.id, APPLY);
    const evs = await eventsOfVisit(w);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.envelope.payload.collections.map((c: any) => c.client_mutation_id)).toEqual([w.cols[1]!.row.client_mutation_id]);
    expect((await colRow(w.cols[0]!.row.id)).status).toBe('held');
    expect((await flagOf(w.cols[0]!.row.id)).status).toBe('open');
  });

  it('barcode_verified in the event is the stored value: manual scan -> false', { timeout: T }, async () => {
    const w = await heldWorld({ cols: [{ method: 'manual' }] });
    await review(w.col.id, APPLY);
    expect((await eventsOfVisit(w))[0]!.envelope.payload.collections[0].barcode_verified).toBe(false);
  });

  it('booking_id is in the event IFF the visit is kind=booking (08 A19 D-120)', { timeout: T }, async () => {
    const fd = await heldWorld();
    await review(fd.col.id, APPLY);
    expect('booking_id' in (await eventsOfVisit(fd))[0]!.envelope.payload).toBe(false);
    const bk = await heldWorld({ kind: 'booking' });
    await review(bk.col.id, APPLY);
    expect((await eventsOfVisit(bk))[0]!.envelope.payload.booking_id).toBe(bk.visit.booking_id);
  });

  it('checks the order and the specimen through the ports by order id: FrontdeskPort.getOrderSummary + LabPort.lookupSpecimens({orderId}); assertRole(visit.assign)', { timeout: T }, async () => {
    const w = await heldWorld();
    const r = await review(w.col.id, APPLY);
    expect(r.probe.orderSummary).toEqual([w.order.id]);
    expect(r.probe.lab.length).toBeGreaterThanOrEqual(1);
    expect(r.probe.lab.every((a) => a['orderId'] === w.order.id)).toBe(true);
    expect(r.probe.identity.some((i) => i.permission === 'homecollection.visit.assign')).toBe(true);
  });

  it('PHI: the event carries no barcode, name or GPS; no log line carries a barcode or the free text', { timeout: T }, async () => {
    const w = await heldWorld();
    const r = await review(w.col.id, { ...APPLY, reason_text: 'SYNTHETIC-FREE-TEXT-13' });
    const e = (await eventsOfVisit(w))[0]!;
    const keys = [...keysDeep(e.envelope.payload)];
    for (const bad of ['barcode', 'scanned_barcode', 'latitude', 'longitude', 'gps', 'full_name', 'patient_name', 'phone', 'reason_text']) expect(keys, bad).not.toContain(bad);
    expect(stringsDeep(e.envelope.payload).join('|')).not.toContain(w.specimen.barcode);
    expect(r.probe.logs.join('\n')).not.toContain(w.specimen.barcode);
    expect(r.probe.logs.join('\n')).not.toContain('SYNTHETIC-FREE-TEXT-13');
  });

  it('emits the event ONCE: a second apply -> 409 collection_not_held and still exactly one event row; the row is untouched by the loser', { timeout: T }, async () => {
    const w = await heldWorld();
    await review(w.col.id, APPLY);
    const after = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY, { version: 2 });
    expect(code(e)).toBe('homecollection.collection_not_held');
    expect(e.statusCode ?? e.status).toBe(409);
    expect(await eventsOfVisit(w)).toHaveLength(1);
    expect(frozen(await colRow(w.col.id))).toBe(after);
  });

  it('race: two concurrent applies of the same held collection -> exactly one 200, one rejection (collection_not_held or version_conflict), ONE event, status applied', { timeout: T }, async () => {
    const w = await heldWorld();
    const out = await Promise.allSettled([review(w.col.id, APPLY), review(w.col.id, APPLY)]);
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(['homecollection.collection_not_held', 'common.version_conflict']).toContain(code(lost.reason));
    expect(await eventsOfVisit(w)).toHaveLength(1);
    expect((await colRow(w.col.id)).status).toBe('applied');
  });

  it('race: apply vs discard of the same held collection -> exactly one wins; applied <=> one event, discarded <=> no event', { timeout: T }, async () => {
    const w = await heldWorld();
    const out = await Promise.allSettled([review(w.col.id, APPLY), review(w.col.id, DISCARD)]);
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const row = await colRow(w.col.id);
    expect(['applied', 'discarded']).toContain(row.status);
    expect((await eventsOfVisit(w)).length).toBe(row.status === 'applied' ? 1 : 0);
  });
});

describe('US-09-1 / 09-2 refusals: Apply needs the order active in C4 AND the specimen `ordered` in C5 (C3 guard); nothing changes, no event', () => {
  const unchanged = async (w: Awaited<ReturnType<typeof heldWorld>>, before: string) => {
    expect(frozen(await colRow(w.col.id))).toBe(before);
    expect((await colRow(w.col.id)).status).toBe('held');
    expect((await flagOf(w.col.id)).status).toBe('open');
    expect(await eventsOfVisit(w)).toHaveLength(0);
  };

  it.each(['collected', 'received', 'rejected', 'cancelled'])('US-09-2: specimen is %s in C5 -> 409 homecollection.mutation_superseded; collection stays held; only Discard remains (works afterwards)', { timeout: T }, async (status) => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY, { fx: { lab: { [w.order.id]: [{ status }] } } });
    expect(code(e)).toBe('homecollection.mutation_superseded');
    expect(e.statusCode ?? e.status).toBe(409);
    await unchanged(w, before);
    const d = await review(w.col.id, DISCARD);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('discarded');
  });

  it('the order is cancelled in C4 (getOrderSummary status cancelled) -> 409 homecollection.mutation_superseded', { timeout: T }, async () => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY, { fx: { orderStatus: 'cancelled' } });
    expect(code(e)).toBe('homecollection.mutation_superseded');
    await unchanged(w, before);
  });

  it('another applied collection already exists for the specimen (C3 "no other applied collection") -> 409 homecollection.mutation_superseded, never a unique-index 500 (ASSUMED code)', { timeout: T }, async () => {
    const w = await heldWorld({ specimens: 1, cols: [{ specimen: 0 }, { specimen: 0, status: 'applied' }] });
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY);
    expect(code(e)).toBe('homecollection.mutation_superseded');
    expect(e.statusCode ?? e.status).toBe(409);
    await unchanged(w, before);
  });

  it('hold code barcode_mismatch -> apply refused with homecollection.barcode_mismatch (TRD H9, C3 guard) even when the lab says everything is fine; Discard still works', { timeout: T }, async () => {
    const w = await heldWorld({ cols: [{ hold: 'homecollection.barcode_mismatch' }] });
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY);
    expect(code(e)).toBe('homecollection.barcode_mismatch');
    expect(e.statusCode ?? e.status).toBe(422);   // 03-IC §8: barcode_mismatch is http 422
    await unchanged(w, before);
    expect((await review(w.col.id, DISCARD)).body.status).toBe('discarded');
  });

  it.each([['LabPort', { labFails: 'common.dependency_unavailable' }], ['FrontdeskPort', { orderFails: 'common.dependency_unavailable' }]] as const)(
    '%s fails -> the error propagates (no silent apply), nothing changes, no event', { timeout: T }, async (_n, fx) => {
      const w = await heldWorld();
      const before = frozen(await colRow(w.col.id));
      const e = await reviewFails(w.col.id, APPLY, { fx });
      expect(code(e)).toBe('common.dependency_unavailable');
      await unchanged(w, before);
    });

  it('the lab answers without the specimen (not in the order list) -> not applied (409 mutation_superseded), nothing changes', { timeout: T }, async () => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY, { fx: { lab: { [w.order.id]: [{ specimenId: uid(), status: 'ordered' }] } } });
    expect(code(e)).toBe('homecollection.mutation_superseded');
    await unchanged(w, before);
  });
});

describe('US-09-3: Discard with reason -> discarded, NO event, the held_collection flag resolved with the reason', () => {
  it.each(['specimen_destroyed', 'duplicate_draw', 'wrong_patient'])('discard with %s -> 200 CollectionDto discarded, row + flag updated, no event', { timeout: T }, async (reason) => {
    const w = await heldWorld();
    const r = await review(w.col.id, { decision: 'discard', reason_code: reason, reason_text: 'Synthetic note' });
    expect(r.status).toBe(200);
    expect(schemaErrors('CollectionDto', r.body), JSON.stringify(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: w.col.id, version: 2, status: 'discarded', review: { decision: 'discard', reason_code: reason, reason_text: 'Synthetic note', by_display: staffName(DISPATCHER.membershipId), at: NOW.toISOString() } });
    const row = await colRow(w.col.id);
    expect(row).toMatchObject({ status: 'discarded', version: 2, review_decision: 'discard', review_reason_code: reason, review_reason_text: 'Synthetic note' });
    expect(iso(row.reviewed_at)).toBe(NOW.toISOString());
    expect(row.applied_event_id ?? null).toBeNull();
    expect(await eventsOfVisit(w)).toHaveLength(0);
    const flag = await flagOf(w.col.id);
    expect(flag).toMatchObject({ status: 'resolved', resolution_code: reason, resolution_note: 'Synthetic note' });   // ASSUMED: "flag resolved with the reason"
    expect(iso(flag.resolved_at)).toBe(NOW.toISOString());
    expect(flag.resolved_by).toBeTruthy();
  });

  it('discard with `other` + text works; the specimen/visit are untouched; discard needs neither the order nor the specimen state (a cancelled order or a collected specimen can still be discarded)', { timeout: T }, async () => {
    const w = await heldWorld();
    const v0 = await visitRow(w.visit.id);
    const r = await review(w.col.id, { decision: 'discard', reason_code: 'other', reason_text: 'Synthetic other reason' }, { fx: { orderStatus: 'cancelled', lab: { [w.order.id]: [{ status: 'collected' }] } } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('discarded');
    expect(r.probe.orderSummary).toEqual([]);   // C4: discard guard = reason required only
    expect(r.probe.lab).toEqual([]);
    const v1 = await visitRow(w.visit.id);
    expect({ status: v1.status, outcome: v1.outcome }).toEqual({ status: v0.status, outcome: v0.outcome });
  });

  it('discarding one of two held collections leaves the other held with its flag open', { timeout: T }, async () => {
    const w = await heldWorld({ cols: [{}, {}] });
    await review(w.cols[0]!.row.id, DISCARD);
    expect((await colRow(w.cols[1]!.row.id)).status).toBe('held');
    expect((await flagOf(w.cols[1]!.row.id)).status).toBe('open');
    expect((await colRowsOfVisit(w.visit.id)).map((c) => c.status).sort()).toEqual(['discarded', 'held']);
  });

  it('a discarded collection frees the specimen: it cannot be applied afterwards (collection_not_held) and no event appears', { timeout: T }, async () => {
    const w = await heldWorld();
    await review(w.col.id, DISCARD);
    expect(code(await reviewFails(w.col.id, APPLY, { version: 2 }))).toBe('homecollection.collection_not_held');
    expect(await eventsOfVisit(w)).toHaveLength(0);
  });
});

describe('US-09-4: the collection is not `held` -> 409 homecollection.collection_not_held (CR-C17-007); nothing changes', () => {
  it.each([['applied', 'apply'], ['applied', 'discard'], ['discarded', 'apply'], ['discarded', 'discard']] as const)('%s collection + decision %s -> 409', { timeout: T }, async (status, decision) => {
    const w = await heldWorld({ cols: [{ status }] });
    const before = frozen(await colRow(w.col.id));
    const body = decision === 'apply' ? APPLY : DISCARD;
    const e = await reviewFails(w.col.id, body);
    expect(code(e)).toBe('homecollection.collection_not_held');
    expect(e.statusCode ?? e.status).toBe(409);
    expect(frozen(await colRow(w.col.id))).toBe(before);
    expect(await eventsOfVisit(w)).toHaveLength(0);
  });

  it('applied by the review, then discard -> 409 collection_not_held; the applied collection and the single event survive', { timeout: T }, async () => {
    const w = await heldWorld();
    await review(w.col.id, APPLY);
    expect(code(await reviewFails(w.col.id, DISCARD, { version: 2 }))).toBe('homecollection.collection_not_held');
    expect((await colRow(w.col.id)).status).toBe('applied');
    expect(await eventsOfVisit(w)).toHaveLength(1);
  });
});

describe('request contract: If-Match, body validation, 404, permissions, tenants', () => {
  it('no If-Match -> 428 common.precondition_required; stale If-Match -> 409 common.version_conflict; nothing changes', { timeout: T }, async () => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    const a = await reviewFails(w.col.id, APPLY, { version: null });
    expect(code(a)).toBe('common.precondition_required');
    expect(a.statusCode ?? a.status).toBe(428);
    const b = await reviewFails(w.col.id, APPLY, { version: 7 });
    expect(code(b)).toBe('common.version_conflict');
    expect(b.statusCode ?? b.status).toBe(409);
    expect(frozen(await colRow(w.col.id))).toBe(before);
    expect(await eventsOfVisit(w)).toHaveLength(0);
  });

  it.each([
    ['unknown decision', { decision: 'maybe', reason_code: 'duplicate_draw' }],
    ['missing decision', { reason_code: 'duplicate_draw' }],
    ['missing reason_code', { decision: 'discard' }],
    ['reason_code outside homecollection.review_reasons', { decision: 'discard', reason_code: 'not_a_review_reason' }],
    ['`other` without reason_text (requires_text)', { decision: 'discard', reason_code: 'other' }],
    ['reason_text > 500 chars', { decision: 'discard', reason_code: 'duplicate_draw', reason_text: 'x'.repeat(501) }],
    ['empty reason_text', { decision: 'discard', reason_code: 'duplicate_draw', reason_text: '' }],
    ['unknown extra property', { decision: 'discard', reason_code: 'duplicate_draw', status: 'applied' }],
  ] as const)('400 common.validation_failed: %s; nothing changes', { timeout: T }, async (_n, body) => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, body);
    expect(code(e)).toBe('common.validation_failed');
    expect(e.statusCode ?? e.status).toBe(400);
    expect(frozen(await colRow(w.col.id))).toBe(before);
    expect(await eventsOfVisit(w)).toHaveLength(0);
  });

  it('unknown collection id -> 404 common.not_found', { timeout: T }, async () => {
    await heldWorld();
    const e = await reviewFails(uid(), APPLY);
    expect(code(e)).toBe('common.not_found');
    expect(e.statusCode ?? e.status).toBe(404);
  });

  it.each([['phlebotomist (sync.upload + visit.read only)', PHLEBO], ['no grants', NOBODY]] as const)('%s -> 403 auth.forbidden, decided before the lookup; nothing changes (07 §4 item 5)', { timeout: T }, async (_n, who) => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY, { who });
    expect(code(e)).toBe('auth.forbidden');
    expect(e.statusCode ?? e.status).toBe(403);
    expect(code(await reviewFails(uid(), APPLY, { who }))).toBe('auth.forbidden');   // an unknown id answers the same: no existence oracle
    expect(frozen(await colRow(w.col.id))).toBe(before);
    expect(await eventsOfVisit(w)).toHaveLength(0);
  });

  it('a dispatcher without access to the visit centre -> 403 auth.forbidden (centre-scoped assertRole); nothing changes', { timeout: T }, async () => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    const e = await reviewFails(w.col.id, APPLY, { fx: { deniedCentres: [HC_CENTRE.a] } });
    expect(code(e)).toBe('auth.forbidden');
    expect(frozen(await colRow(w.col.id))).toBe(before);
    expect(await eventsOfVisit(w)).toHaveLength(0);
  });

  it.each([['RLS on', false], ['RLS bypassed (only the repository tenant filter protects)', true]] as const)('tenant isolation (%s): tenant B dispatcher cannot review tenant A collection -> 404 common.not_found; nothing changes', { timeout: T }, async (_n, bypassRls) => {
    const w = await heldWorld();
    const before = frozen(await colRow(w.col.id));
    for (const body of [APPLY, DISCARD]) {
      const e = await reviewFails(w.col.id, body, { who: DISPATCHER_B, bypassRls });
      expect(code(e)).toBe('common.not_found');
    }
    expect(frozen(await colRow(w.col.id))).toBe(before);
    expect(await eventsOfVisit(w, TENANT_A)).toHaveLength(0);
    expect(await eventsOfVisit(w, TENANT_B)).toHaveLength(0);
  });

  it('02-TRD §5 (P-17): staff names of the response come from ONE batched ctx.core.memberships.list call, never a direct core.memberships read', { timeout: T }, async () => {
    const w = await heldWorld();
    const r = await review(w.col.id, DISCARD);
    expect(r.probe.memberships).toHaveLength(1);
    expect([...(r.probe.memberships[0]!['membershipIds'] as string[])].sort()).toEqual([...new Set([w.member, DISPATCHER.membershipId])].sort());
  });
});
