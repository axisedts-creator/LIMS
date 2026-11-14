// HC-T14 H13 listHandovers + H14 getHandover (02-TRD §5.1 rows H13/H14, §5.3 DTOs, §5.4 rule 3; 01-PRD US-12-2 (receiver view), US-12-5 (centre scoping on to_centre_id); 07-SECURITY REQ-SEC-017 + §4 cross-centre probes;
// 08 A19 D-125; LD-140 n/a (backend)). Live PG17, RLS on, USER-actor claims (membership a50a = centre staff of A-C1, NOT a member of the home-collection centre A-HC).
// ASSUMED (spec silent): a centre-scoped list never 403s for another centre: RLS just yields no rows; getHandover/confirm of an invisible handover = 404 common.not_found (load first, then assertRole, TRD §5.4 rule 1);
// H13 validates `status` / `limit` itself (as H1 does) -> 400 common.validation_failed; list order is not pinned; received_by_display / from.display_name come from core.memberships.list (staffName).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../repository/__tests__/helpers.js';
import { responseErrors } from '../settings/helpers.js';
import { ALL_CENTRES_STAFF, CENTRE_C, CENTRE_D, HC_CENTRE, NO_PERM, PERM, RECEIVER, STAFF_C, T, TENANT_B, asUser, closeHandoverPool, countAs, get, handoverWorld, list, rejection, sameInstant,
  staffName, visitSideSql, type HoWorld } from './helpers.js';

afterAll(async () => { await closeHandoverPool(); await closePools(); });
const ids = (r: { body: any }): string[] => r.body.data.map((x: any) => x.id);
const hasNull = (x: unknown): boolean => JSON.stringify(x).includes(':null') || JSON.stringify(x).includes('[null') ;

describe('US-12-2 / D-125: a receiver who is NOT a member of the home-collection centre works from the handover rows alone', () => {
  let w: HoWorld;
  beforeAll(async () => { w = await handoverWorld({ n: 3 }); }, T);

  it('precondition of the scenario: the receiver sees the handover + items but NO visit, collection or lab row (RLS on centre_id = A-HC fails, to_centre_id = A-C1 passes)', { timeout: T }, async () => {
    expect(await countAs(STAFF_C, 'homecollection.handovers', 'id = $1', [w.handover.id])).toBe(1);
    expect(await countAs(STAFF_C, 'homecollection.handover_items', 'handover_id = $1', [w.handover.id])).toBe(3);
    expect(await countAs(STAFF_C, 'homecollection.visits', 'centre_id = $1', [HC_CENTRE.a])).toBe(0);
    expect(await countAs(STAFF_C, 'homecollection.collections', 'centre_id = $1', [HC_CENTRE.a])).toBe(0);
  });
  it('H14 returns the full detail: every item with barcode + specimen type from handover_items (NOT from lab.specimens), status pending, from = phlebotomist name, valid HandoverDetailDto', { timeout: T }, async () => {
    const r = await get(w.handover.id);
    expect(r.status).toBe(200);
    expect(responseErrors('getHandover', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: w.handover.id, version: w.handover.version ?? 1, status: 'pending', to_centre_id: CENTRE_C, item_count: 3, from: { membership_id: w.fromMember, display_name: staffName(w.fromMember) } });
    expect(sameInstant(r.body.handed_over_at, w.handover.handed_over_at)).toBe(true);
    expect(r.body.items).toHaveLength(3);
    for (const it of w.items) {
      const got = r.body.items.find((x: any) => x.specimen_id === it.specimenId);
      expect(got, `item ${it.specimenId}`).toMatchObject({ visit_id: it.visitId, barcode: it.barcode, specimen_type_code: it.typeCode });
      expect(got.barcode).not.toBe(it.labBarcode);                    // the lab specimen carries another barcode: a read through lab.specimens would show it
      expect(got.outcome).toBeUndefined();                            // not decided yet: the key is absent (no null)
    }
    expect(w.items.some((it) => it.typeCode !== it.labTypeCode)).toBe(true);   // and a type that differs from lab.specimens for at least one item
    expect(hasNull(r.body)).toBe(false);
    expect(r.body.received_by_display).toBeUndefined();
    expect(r.body.received_at).toBeUndefined();
  });
  it('H14 reads ONLY homecollection.handovers / handover_items: no statement touches a visit, collection, flag, route, mutation or lab table (probe on every SQL statement of the request)', { timeout: T }, async () => {
    const r = await get(w.handover.id);
    expect(r.probe.sql.length).toBeGreaterThan(0);
    expect(visitSideSql(r.probe)).toEqual([]);
    expect(r.probe.sql.some((s) => /homecollection\.handovers/.test(s))).toBe(true);
    expect(r.probe.sql.some((s) => /homecollection\.handover_items/.test(s))).toBe(true);
  });
  it('H14 authorises on the handover\'s receiving centre: assertRole({permission: handover.receive, centreId: to_centre_id}); a centre denied for that permission -> 403 auth.forbidden', { timeout: T }, async () => {
    const r = await get(w.handover.id);
    expect(r.probe.identity).toContainEqual({ permission: PERM, centreId: CENTRE_C });
    const e = await rejection(get(w.handover.id, STAFF_C, { fx: { deniedCentres: [CENTRE_C] } }));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
  });
  it('H14 never logs the barcode', { timeout: T }, async () => {
    const r = await get(w.handover.id);
    for (const it of w.items) expect(r.probe.logs.join('\n')).not.toContain(it.barcode);
  });
  it('a confirmed handover shows the decided items: outcome per item, received_count, received_by_display, received_at, note', { timeout: T }, async () => {
    const c = await handoverWorld({ n: 2, status: 'confirmed', note: 'synthetic note' });
    const r = await get(c.handover.id);
    expect(responseErrors('getHandover', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ status: 'confirmed', item_count: 2, received_count: 2, received_by_display: staffName(RECEIVER.membershipId), note: 'synthetic note' });
    expect(sameInstant(r.body.received_at, '2026-11-11T05:00:00Z')).toBe(true);
    expect(r.body.items.map((x: any) => x.outcome)).toEqual(['received', 'received']);
  });
  it('a discrepancy handover shows missing items and received_count < item_count', { timeout: T }, async () => {
    const d = await handoverWorld({ n: 3, status: 'discrepancy', outcomes: ['received', 'missing', 'received'] });
    const r = await get(d.handover.id);
    expect(r.body).toMatchObject({ status: 'discrepancy', item_count: 3, received_count: 2 });
    expect(r.body.items.find((x: any) => x.specimen_id === d.items[1]!.specimenId).outcome).toBe('missing');
    expect(responseErrors('getHandover', r.body)).toEqual([]);
  });
});

describe('US-12-5 / REQ-SEC-017: centre scoping on to_centre_id (H13 + H14)', () => {
  let c: HoWorld, d: HoWorld;
  beforeAll(async () => { c = await handoverWorld({ n: 1, to: CENTRE_C }); d = await handoverWorld({ n: 1, to: CENTRE_D }); }, T);

  it('staff of A-C1 list the handover addressed to A-C1 and NOT the one addressed to A-C2', { timeout: T }, async () => {
    const r = await list({ limit: 200 });
    expect(ids(r)).toContain(c.handover.id);
    expect(ids(r)).not.toContain(d.handover.id);
    for (const x of r.body.data) expect(x.to_centre_id).toBe(CENTRE_C);
  });
  it('asking for the other centre explicitly (to_centre_id = A-C2) returns no handover of A-C2 (an empty page, not a leak)', { timeout: T }, async () => {
    const r = await list({ to_centre_id: CENTRE_D, limit: 200 });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });
  it('H14 of a handover addressed to another centre = 404 common.not_found (indistinguishable from an unknown id), before any permission decision on it', { timeout: T }, async () => {
    const e = await rejection(get(d.handover.id));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    const unknown = await rejection(get('01950c17-0000-7000-8000-0000ffff0014'));
    expect([unknown.code, unknown.statusCode]).toEqual(['common.not_found', 404]);
    expect(e.probe.identity.filter((x: any) => x.centreId === CENTRE_D)).toEqual([]);
  });
  it('the error body names nothing of the foreign handover (no barcode, no id of its items)', { timeout: T }, async () => {
    const e = await rejection(get(d.handover.id));
    const seen = JSON.stringify({ code: e.code, detail: e.detail, message: e.message, errors: e.errors });
    for (const it of d.items) { expect(seen).not.toContain(it.barcode); expect(seen).not.toContain(it.specimenId); }
  });
  it('tenant-wide staff (all_centres) see the handovers of both centres', { timeout: T }, async () => {
    const r = await list({ limit: 200 }, asUser(ALL_CENTRES_STAFF.membershipId, ALL_CENTRES_STAFF.userId, [PERM]));
    expect(ids(r)).toEqual(expect.arrayContaining([c.handover.id, d.handover.id]));
  });
  it('tenant isolation: tenant-B staff (claims of B) see no handover of tenant A, and H14 of an A id is 404 (RLS off too: the repository filters tenant_id)', { timeout: T }, async () => {
    const b = await handoverWorld({ s: 'b', n: 1 });
    const who = asUser('01a1a98a-ac40-7000-8000-00000000b500', '01a1a98a-ac40-7000-8000-00000000b300', [PERM], TENANT_B);
    const r = await list({ limit: 200 }, who);
    expect(ids(r)).not.toContain(c.handover.id);
    expect(ids(r)).not.toContain(d.handover.id);
    expect(ids(r)).toContain(b.handover.id);
    const e = await rejection(get(c.handover.id, who));
    expect(e.code).toBe('common.not_found');
  });
});

describe('H13 listHandovers: filters, paging, DTO, permission', () => {
  let p1: HoWorld, p2: HoWorld, cf: HoWorld, dc: HoWorld;
  beforeAll(async () => {
    p1 = await handoverWorld({ n: 2, handedOverAt: '2026-11-09T03:00:00Z' });
    p2 = await handoverWorld({ n: 1, handedOverAt: '2026-11-10T03:00:00Z' });
    cf = await handoverWorld({ n: 3, status: 'confirmed', handedOverAt: '2026-11-08T03:00:00Z' });
    dc = await handoverWorld({ n: 2, status: 'discrepancy', outcomes: ['received', 'missing'], handedOverAt: '2026-11-07T03:00:00Z' });
  }, T);

  it('every row is a valid HandoverSummaryDto (id, version, status, from{membership_id, display_name}, to_centre_id, handed_over_at, item_count[, received_count]); the page object carries the limit; no null', { timeout: T }, async () => {
    const r = await list({ limit: 200 });
    expect(r.status).toBe(200);
    expect(responseErrors('listHandovers', r.body)).toEqual([]);
    const row = r.body.data.find((x: any) => x.id === p1.handover.id);
    expect(row).toMatchObject({ status: 'pending', item_count: 2, to_centre_id: CENTRE_C, from: { membership_id: p1.fromMember, display_name: staffName(p1.fromMember) } });
    expect(r.body.data.find((x: any) => x.id === cf.handover.id)).toMatchObject({ status: 'confirmed', item_count: 3, received_count: 3 });
    expect(r.body.data.find((x: any) => x.id === dc.handover.id)).toMatchObject({ status: 'discrepancy', item_count: 2, received_count: 1 });
    expect(r.body.page.limit).toBe(200);
    expect(hasNull(r.body)).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/barcode/);                       // the summary carries no item data
  });
  it('status filter (csv): pending / confirmed,discrepancy / all three', { timeout: T }, async () => {
    const pend = ids(await list({ status: 'pending', limit: 200 }));
    expect(pend).toEqual(expect.arrayContaining([p1.handover.id, p2.handover.id])); expect(pend).not.toContain(cf.handover.id); expect(pend).not.toContain(dc.handover.id);
    const done = ids(await list({ status: 'confirmed,discrepancy', limit: 200 }));
    expect(done).toEqual(expect.arrayContaining([cf.handover.id, dc.handover.id])); expect(done).not.toContain(p1.handover.id);
    const all = ids(await list({ status: 'pending,confirmed,discrepancy', limit: 200 }));
    expect(all).toEqual(expect.arrayContaining([p1.handover.id, p2.handover.id, cf.handover.id, dc.handover.id]));
  });
  it('handed_over_from / handed_over_to bound handed_over_at (inclusive start)', { timeout: T }, async () => {
    const r = await list({ handed_over_from: '2026-11-09T00:00:00.000Z', handed_over_to: '2026-11-10T23:59:59.000Z', limit: 200 });
    expect(ids(r)).toEqual(expect.arrayContaining([p1.handover.id, p2.handover.id]));
    expect(ids(r)).not.toContain(cf.handover.id); expect(ids(r)).not.toContain(dc.handover.id);
    const only = await list({ handed_over_from: '2026-11-10T00:00:00.000Z', status: 'pending', limit: 200 });
    expect(ids(only)).toContain(p2.handover.id); expect(ids(only)).not.toContain(p1.handover.id);
  });
  it('to_centre_id = the caller\'s own centre filters to it; limit + cursor page through every row exactly once', { timeout: T }, async () => {
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await list({ to_centre_id: CENTRE_C, status: 'pending,confirmed,discrepancy', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...ids(r)); cursor = r.body.page.next_cursor; pages++;
    } while (cursor && pages < 100);
    expect(new Set(seen).size).toBe(seen.length);                                // no row twice
    expect(seen).toEqual(expect.arrayContaining([p1.handover.id, p2.handover.id, cf.handover.id, dc.handover.id]));
    expect(pages).toBeGreaterThan(1);
  });
  it('H13 reads only handovers / handover_items (the item count comes from the item rows, no visit table)', { timeout: T }, async () => {
    const r = await list({ limit: 50 });
    expect(visitSideSql(r.probe)).toEqual([]);
  });
  it('a caller without homecollection.handover.receive -> 403 auth.forbidden (H13 and H14); the permission name is checked verbatim', { timeout: T }, async () => {
    const e = await rejection(list({}, NO_PERM));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    expect(e.probe.identity.map((x: any) => x.permission)).toContain(PERM);
    const e2 = await rejection(get(p1.handover.id, NO_PERM));
    expect([e2.code, e2.statusCode]).toEqual(['auth.forbidden', 403]);
  });
  it('bad query -> 400 common.validation_failed (unknown status word, limit 0 / 201, malformed cursor, bad uuid)', { timeout: T }, async () => {
    for (const q of [{ status: 'pending,bogus' }, { limit: 0 }, { limit: 201 }, { cursor: 'not-a-cursor' }, { to_centre_id: 'nope' }, { handed_over_from: 'yesterday' }]) {
      const e = await rejection(list(q as object));
      expect([JSON.stringify(q), e.code, e.statusCode]).toEqual([JSON.stringify(q), 'common.validation_failed', 400]);
    }
  });
  it('an empty answer is a normal page: no handover of the filter -> 200 with data []', { timeout: T }, async () => {
    const r = await list({ status: 'pending', handed_over_from: '2099-01-01T00:00:00.000Z' });
    expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
  });
  it('staff names failing in core must not fail the list (names are decoration): 200 and the rows are still there', { timeout: T }, async () => {
    const r = await list({ limit: 200 }, STAFF_C, { fx: { namesFail: true } });
    expect(r.status).toBe(200);
    expect(ids(r)).toContain(p1.handover.id);
  });
});
