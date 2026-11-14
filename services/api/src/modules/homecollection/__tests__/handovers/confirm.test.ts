// HC-T14 H15 confirmHandover (POST /handovers/{handover_id}/confirm; 02-TRD §5.1 row H15 + §5.4 rules 3-4 + §9 task row; 03-APP-FLOW §1.3 + §2.3; 01-PRD US-12-2, US-12-5;
// 07-SECURITY REQ-SEC-017, REQ-SEC-050/051, §4 cross-centre probes; 08 A19 D-125). Live PG17, RLS on, user-actor claims of the receiver (A-C1 staff, not a member of the home-collection centre).
// The core fact of D-125: H15 writes ONLY homecollection.handovers + handover_items and, when >= 1 item is missing, enqueues homecollection.flag_handover_discrepancy {tenant_id, handover_id}
// (job_key flag_handover_discrepancy:<handover_id>) IN THE SAME TRANSACTION. It never inserts visit_flags itself (the worker does, with system-actor rights).
// ASSUMED (spec silent): all received -> confirmed; received_at = ctx.now(); received_by_membership_id = the actor's membership; missing If-Match = 428 common.precondition_required, stale = 409 common.version_conflict
// (as H3-H6); handover not pending = 409 common.version_conflict (TRD H15 row); items must be EXACTLY the handover's items: subset / duplicates / empty / > 50 = 400 common.validation_failed,
// a specimen id that is not an item of THIS visible handover = 404 common.not_found for the whole request (TRD §5.4 rule 4); invalid body fields are rejected by the handler (as H1/H11).
import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../../repository/__tests__/helpers.js';
import { responseErrors } from '../settings/helpers.js';
import { ALL_CENTRES_STAFF, CENTRE_C, CENTRE_D, NO_PERM, NOW, PERM, RECEIVER, STAFF_C, T, TASK, TENANT_B, asUser, closeHandoverPool, confirm, decide, discrepancyJobs, flagsOfVisit, get,
  handoverRow, handoverWorld, itemRowsOf, rejection, sameInstant, staffName, visitSideSql, visitVersion, type HoWorld } from './helpers.js';

afterAll(async () => { await closeHandoverPool(); await closePools(); });
const unchanged = async (w: HoWorld, version = 1) => {
  const h = await handoverRow(w.handover.id);
  expect([h.status, Number(h.version), h.received_by_membership_id, h.received_at]).toEqual(['pending', version, null, null]);
  for (const i of await itemRowsOf(w.handover.id)) expect([i.outcome, Number(i.version)]).toEqual([null, 1]);
  expect(await discrepancyJobs(w.handover.id)).toEqual([]);
};
const noFlags = async (w: HoWorld) => { for (const it of w.items) expect(await flagsOfVisit(it.visitId, 'handover_discrepancy')).toEqual([]); };

describe('US-12-2: all tubes received -> confirmed', () => {
  it('3 of 3 received: status confirmed, received_by_membership_id = the receiver, received_at = now, items outcome received, versions +1; the response is the new HandoverDetailDto', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 3 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, true), note: 'all tubes present (synthetic)' });
    expect(r.status).toBe(200);
    expect(responseErrors('confirmHandover', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: w.handover.id, version: 2, status: 'confirmed', item_count: 3, received_count: 3, received_by_display: staffName(RECEIVER.membershipId), note: 'all tubes present (synthetic)' });
    expect(sameInstant(r.body.received_at, NOW)).toBe(true);
    expect(r.body.items.map((x: any) => x.outcome)).toEqual(['received', 'received', 'received']);
    for (const it of w.items) expect(r.body.items.find((x: any) => x.specimen_id === it.specimenId)).toMatchObject({ barcode: it.barcode, specimen_type_code: it.typeCode, visit_id: it.visitId });
    const h = await handoverRow(w.handover.id);
    expect([h.status, Number(h.version), h.received_by_membership_id, h.note]).toEqual(['confirmed', 2, RECEIVER.membershipId, 'all tubes present (synthetic)']);
    expect(sameInstant(h.received_at, NOW)).toBe(true);
    for (const i of await itemRowsOf(w.handover.id)) expect([i.outcome, Number(i.version)]).toEqual(['received', 2]);
    // what the push wrote stays: who handed over, when, to where
    expect([h.from_membership_id, h.to_centre_id, new Date(h.handed_over_at).toISOString()]).toEqual([w.fromMember, CENTRE_C, new Date(w.handover.handed_over_at).toISOString()]);
  });
  it('all received enqueues nothing and opens no flag; the request reads/writes only handovers + handover_items; assertRole is asked on to_centre_id', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, true) });
    expect(await discrepancyJobs(w.handover.id)).toEqual([]);
    await noFlags(w);
    expect(visitSideSql(r.probe)).toEqual([]);
    expect(r.probe.sql.some((s) => /enqueue_job/i.test(s))).toBe(false);
    expect(r.probe.identity).toContainEqual({ permission: PERM, centreId: CENTRE_C });
    expect(r.probe.sql.some((s) => /UPDATE\s+homecollection\.handovers/i.test(s))).toBe(true);
  });
  it('the note is optional and a 500-character note is accepted', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 1 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, true), note: 'x'.repeat(500) });
    expect(r.status).toBe(200);
    expect((await handoverRow(w.handover.id)).note).toBe('x'.repeat(500));
    const w2 = await handoverWorld({ n: 1 });
    expect((await confirm({ id: w2.handover.id, version: 1, items: decide(w2, true) })).body.note).toBeUndefined();
  });
  it('H14 after the confirm shows the decision (same data as the H15 response)', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    const c = await confirm({ id: w.handover.id, version: 1, items: decide(w, true) });
    const g = await get(w.handover.id);
    expect(g.body).toEqual(c.body);
  });
});

describe('US-12-2 / D-125: >= 1 tube missing -> discrepancy + the flag task (never a visit_flags insert by H15)', () => {
  it('1 of 3 missing: status discrepancy, that item missing, the others received, received_count 2; exactly ONE job flag_handover_discrepancy with key flag_handover_discrepancy:<id> and payload {tenant_id, handover_id}', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 3 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, [true, false, true]), note: 'one tube missing (synthetic)' });
    expect(r.status).toBe(200);
    expect(responseErrors('confirmHandover', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ status: 'discrepancy', version: 2, item_count: 3, received_count: 2, note: 'one tube missing (synthetic)' });
    expect(r.body.items.find((x: any) => x.specimen_id === w.items[1]!.specimenId).outcome).toBe('missing');
    expect(r.body.items.filter((x: any) => x.outcome === 'received')).toHaveLength(2);
    const rows = await itemRowsOf(w.handover.id);
    expect(Object.fromEntries(rows.map((i: any) => [i.specimen_id, i.outcome]))).toEqual({ [w.items[0]!.specimenId]: 'received', [w.items[1]!.specimenId]: 'missing', [w.items[2]!.specimenId]: 'received' });
    const h = await handoverRow(w.handover.id);
    expect([h.status, h.received_by_membership_id]).toEqual(['discrepancy', RECEIVER.membershipId]);
    expect(sameInstant(h.received_at, NOW)).toBe(true);
    const jobs = await discrepancyJobs(w.handover.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: `flag_handover_discrepancy:${w.handover.id}`, task_identifier: TASK });
    expect(jobs[0].payload).toEqual({ tenant_id: w.tenant, handover_id: w.handover.id });
  });
  it('H15 itself inserts NO visit_flags row (the receiver has no write right on the visit centre): the flag appears only when the worker runs', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 3 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, [false, true, true]) });
    await noFlags(w);
    expect(visitSideSql(r.probe)).toEqual([]);                                   // no statement on a visit-side table, not even a read
    expect(r.probe.sql.filter((s) => /INSERT\s+INTO\s+homecollection\.visit_flags/i.test(s))).toEqual([]);
    expect(r.probe.sql.some((s) => /enqueue_job/i.test(s))).toBe(true);
    for (const it of w.items) expect(await visitVersion(it.visitId)).toBe(1);   // visits untouched
  });
  it('every tube missing is still ONE discrepancy and ONE job', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 3 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, false) });
    expect(r.body).toMatchObject({ status: 'discrepancy', received_count: 0 });
    expect(r.body.items.map((x: any) => x.outcome)).toEqual(['missing', 'missing', 'missing']);
    expect(await discrepancyJobs(w.handover.id)).toHaveLength(1);
  });
  it('same transaction: when the request fails after the handler (rollback), the handover stays pending and NO job is left behind', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    await rejection(confirm({ id: w.handover.id, version: 1, items: decide(w, false), failAfter: true }));
    await unchanged(w);
  });
  it('the 50-tube limit: a handover of 50 items is confirmed in one request', { timeout: 180_000 }, async () => {
    const w = await handoverWorld({ n: 50 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, w.items.map((_, i) => i !== 7)) });
    expect(r.body).toMatchObject({ status: 'discrepancy', item_count: 50, received_count: 49 });
    expect(await discrepancyJobs(w.handover.id)).toHaveLength(1);
  });
});

describe('H15 preconditions, conflicts, concurrency (REQ-SEC-050/051)', () => {
  it('If-Match is mandatory: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing changes, nothing is enqueued', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    const none = await rejection(confirm({ id: w.handover.id, version: null, items: decide(w, false) }));
    expect([none.code, none.statusCode]).toEqual(['common.precondition_required', 428]);
    const stale = await rejection(confirm({ id: w.handover.id, version: 7, items: decide(w, false) }));
    expect([stale.code, stale.statusCode]).toEqual(['common.version_conflict', 409]);
    await unchanged(w);
  });
  it('a handover that is no longer pending -> 409 common.version_conflict (even with the current version): confirmed and discrepancy are final', { timeout: T }, async () => {
    const done = await handoverWorld({ n: 2, status: 'confirmed' });
    const e1 = await rejection(confirm({ id: done.handover.id, version: 1, items: decide(done, false) }));
    expect([e1.code, e1.statusCode]).toEqual(['common.version_conflict', 409]);
    expect((await handoverRow(done.handover.id)).status).toBe('confirmed');
    expect(await discrepancyJobs(done.handover.id)).toEqual([]);
    const disc = await handoverWorld({ n: 2, status: 'discrepancy', outcomes: ['received', 'missing'] });
    const e2 = await rejection(confirm({ id: disc.handover.id, version: 1, items: decide(disc, true) }));
    expect([e2.code, e2.statusCode]).toEqual(['common.version_conflict', 409]);
    expect((await handoverRow(disc.handover.id)).status).toBe('discrepancy');
    expect((await itemRowsOf(disc.handover.id)).map((i: any) => i.outcome)).toEqual(['received', 'missing']);
  });
  it('a second confirm after a first one is 409 and does not enqueue a second job', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    await confirm({ id: w.handover.id, version: 1, items: decide(w, false) });
    const again = await rejection(confirm({ id: w.handover.id, version: 2, items: decide(w, true) }));
    expect(again.code).toBe('common.version_conflict');
    expect(await discrepancyJobs(w.handover.id)).toHaveLength(1);
    expect((await handoverRow(w.handover.id)).status).toBe('discrepancy');
  });
  it('two receivers confirming at once with the same version: exactly one wins (200), the other gets 409; one transition, one job, the winner\'s decision stands', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 3 });
    const settle = (p: Promise<unknown>) => p.then((v: any) => ({ ok: true as const, v }), (e: any) => ({ ok: false as const, e }));
    const [a, b] = await Promise.all([
      settle(confirm({ id: w.handover.id, version: 1, items: decide(w, [true, false, true]) })),
      settle(confirm({ id: w.handover.id, version: 1, items: decide(w, [false, false, false]), who: asUser(ALL_CENTRES_STAFF.membershipId, ALL_CENTRES_STAFF.userId, [PERM]) })),
    ]);
    expect([a, b].filter((x) => x.ok)).toHaveLength(1);
    const loser = [a, b].find((x) => !x.ok) as { ok: false; e: any };
    expect([loser.e.code, loser.e.statusCode]).toEqual(['common.version_conflict', 409]);
    const h = await handoverRow(w.handover.id);
    expect([h.status, Number(h.version)]).toEqual(['discrepancy', 2]);
    const winnerIsA = a.ok;
    expect((await itemRowsOf(w.handover.id)).filter((i: any) => i.outcome === 'missing')).toHaveLength(winnerIsA ? 1 : 3);
    expect(await discrepancyJobs(w.handover.id)).toHaveLength(1);
  });
  it('the response of a failed confirm never leaks the handover\'s barcodes', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 1, status: 'confirmed' });
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items: decide(w, false) }));
    const seen = JSON.stringify({ code: e.code, detail: e.detail, message: e.message, errors: e.errors });
    expect(seen).not.toContain(w.items[0]!.barcode);
  });
});

describe('H15 body: the items are exactly the handover\'s items (TRD §5.1 H15, §5.4 rule 4)', () => {
  it('a subset (2 of 3) -> 400 common.validation_failed, nothing changes', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 3 });
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items: decide(w, true).slice(0, 2) }));
    expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]);
    await unchanged(w);
  });
  it('a duplicated specimen id (3 entries, 2 distinct) -> 400 common.validation_failed', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 3 });
    const items = decide(w, true); items[2] = { ...items[0]! };
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items }));
    expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]);
    await unchanged(w);
  });
  it('a specimen of ANOTHER handover (same tenant, same centre) -> 404 common.not_found for the whole request; a random id too; nothing changes on either handover', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 }); const other = await handoverWorld({ n: 1 });
    const items = [...decide(w, true).slice(0, 1), { specimen_id: other.items[0]!.specimenId, received: true }];
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items }));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    const e2 = await rejection(confirm({ id: w.handover.id, version: 1, items: [...decide(w, true).slice(0, 1), { specimen_id: '01950c17-0000-7000-8000-0000ffff0015', received: true }] }));
    expect([e2.code, e2.statusCode]).toEqual(['common.not_found', 404]);
    await unchanged(w); await unchanged(other);
  });
  it('empty items, 51 items, non-boolean received, missing received, a 501-character note, an empty note -> 400 common.validation_failed', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    const good = decide(w, true);
    const cases: Array<[string, unknown, unknown?]> = [
      ['empty', []], ['51 items', Array.from({ length: 51 }, (_, i) => ({ specimen_id: `01950c17-0000-7000-8000-${String(i).padStart(12, '0')}`, received: true }))],
      ['received not boolean', [{ ...good[0]!, received: 'yes' }, good[1]!]], ['received missing', [{ specimen_id: good[0]!.specimen_id }, good[1]!]],
      ['items not an array', 'all'], ['note too long', good, 'x'.repeat(501)], ['note empty', good, ''],
    ];
    for (const [name, items, note] of cases) {
      const e = await rejection(confirm({ id: w.handover.id, version: 1, items, ...(note === undefined ? {} : { note }) }));
      expect([name, e.code, e.statusCode]).toEqual([name, 'common.validation_failed', 400]);
    }
    await unchanged(w);
  });
  it('a path id that is not a uuid / unknown -> 404 common.not_found, nothing is enqueued', { timeout: T }, async () => {
    const e = await rejection(confirm({ id: '01950c17-0000-7000-8000-0000ffff0016', version: 1, items: [{ specimen_id: '01950c17-0000-7000-8000-0000ffff0017', received: true }] }));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
  });
});

describe('US-12-5 / REQ-SEC-017: who may confirm (centre scope on to_centre_id, permission handover.receive)', () => {
  it('centre staff of A-C1 cannot confirm a handover addressed to A-C2: 404 common.not_found, nothing written, no job', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2, to: CENTRE_D });
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items: decide(w, false) }));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    await unchanged(w);
    expect(e.probe.identity.filter((x: any) => x.centreId === CENTRE_D)).toEqual([]);
  });
  it('a caller without homecollection.handover.receive -> 403 auth.forbidden, nothing written, no job', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items: decide(w, false), who: NO_PERM }));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    await unchanged(w);
  });
  it('a centre the permission does not cover (IdentityPort denies to_centre_id) -> 403 auth.forbidden, nothing written', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items: decide(w, true), fx: { deniedCentres: [CENTRE_C] } }));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    await unchanged(w);
  });
  it('tenant-wide staff (all_centres) can confirm a handover to any centre of the tenant (A-C2)', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 1, to: CENTRE_D });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, true), who: asUser(ALL_CENTRES_STAFF.membershipId, ALL_CENTRES_STAFF.userId, [PERM]) });
    expect(r.body).toMatchObject({ status: 'confirmed', to_centre_id: CENTRE_D });
    expect((await handoverRow(w.handover.id)).received_by_membership_id).toBe(ALL_CENTRES_STAFF.membershipId);
  });
  it('tenant B cannot confirm tenant A\'s handover (404), with RLS and by explicit tenant filter', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 1 });
    const b = asUser('01a1a98a-ac40-7000-8000-00000000b500', '01a1a98a-ac40-7000-8000-00000000b300', [PERM], TENANT_B);
    const e = await rejection(confirm({ id: w.handover.id, version: 1, items: decide(w, false), who: b }));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    await unchanged(w);
  });
  it('logs carry ids, codes and counts only: no barcode, no note', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 2 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, [true, false]), note: 'SYNTHETIC-NOTE-DO-NOT-LOG' });
    const logs = r.probe.logs.join('\n');
    for (const it of w.items) expect(logs).not.toContain(it.barcode);
    expect(logs).not.toContain('SYNTHETIC-NOTE-DO-NOT-LOG');
  });
  it('names failing in core do not fail the confirm: the write is committed', { timeout: T }, async () => {
    const w = await handoverWorld({ n: 1 });
    const r = await confirm({ id: w.handover.id, version: 1, items: decide(w, true), fx: { namesFail: true } });
    expect(r.status).toBe(200);
    expect((await handoverRow(w.handover.id)).status).toBe('confirmed');
  });
});
