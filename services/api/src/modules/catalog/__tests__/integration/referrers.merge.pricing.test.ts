// T-17 (C3) — price-list reassignment inside mergeDoctor (#66). T-15 owns the merge itself (referrers.service.test.ts); this file only covers what T-17 adds.
// Spec: 03-APP-FLOW §2.4 "Price-list assignment of a merged doctor is removed in the merge transaction; if the survivor has none, the merged doctor's list is re-assigned to
//       the survivor [CONV]"; 06-PLAN T-17 done_when "merge moves/drops the merged doctor's assignment"; 03-APP-FLOW E13 (price precedence uses the canonical doctor's list);
//       05-SCHEMA price_list_assignments (UNIQUE(tenant, doctor_id) — a doctor has at most one list; composite FK to doctors); 07-SECURITY S-1.
// Real core `createEvents({producer:'catalog'})` and the REAL referrers.service over helpers/pricingDb.ts (doctors + price-list tables in one transaction).
// Interface: createReferrersService({events, identity}).mergeDoctor(ctx, { id, expectedVersion, body: { into_doctor_id } }) — unchanged from T-15.
// Not asserted (spec silent): whether the reassignment itself emits an extra `price_list`/`updated` event (the doctor `deactivated` event is the one that must exist);
// whether assigning an already-MERGED doctor to a list via #72/#75 is refused (see the SPEC GAPS line in .orchestra/notes/T-17-tests.md).
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createReferrersService } from '../../service/referrers.service.js';
import { ROOT_A, TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { ID, type Row } from '../helpers/mastersDb.js';
import { MANAGE, READ, actorIdentity, doc, makePricingDb, passign, plist } from '../helpers/pricingDb.js';

const T = 20_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const A = TENANT_A;
const B = TENANT_B;
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s));
const X = doc(1, A, { doctor_code: 'DRX1' });                    // merged away
const Y = doc(2, A, { doctor_code: 'DRY1' });                    // survivor
const W = doc(3, A, { doctor_code: 'DRW1' });
const LX = plist(1, A, { owner_kind: 'referrer', code: 'LISTX' });
const LY = plist(2, A, { owner_kind: 'referrer', code: 'LISTY' });
const LC = plist(3, A, { owner_kind: 'centre', code: 'CENT1' });

const setup = (rows: Record<string, Row[]>) => {
  const db = makePricingDb({ rows: { ...rows, doctors: [X, Y, W, ...(rows['doctors'] ?? [])] } as never, catalog: { state: { [A]: { rootId: ROOT_A, revision: 417 } } } });
  const svc = createReferrersService({ events: createEvents({ producer: 'catalog' } as never), identity: actorIdentity([READ, MANAGE]) } as never) as unknown as Svc;
  return { db, svc };
};
type Db = ReturnType<typeof setup>['db'];
const merge = (db: Db, svc: Svc, id: string, version: number, into: string, o: { tenantId?: string } = {}) =>
  db.run((ctx) => svc['mergeDoctor']!(ctx, { id, expectedVersion: version, body: { into_doctor_id: into } }), { at: at(0), ...o });
const assignments = (db: Db, tenant = A) => db.rows('price_list_assignments', tenant);
const ownerOf = (db: Db, doctorId: string) => assignments(db).find((a) => a.doctor_id === doctorId);
const doctorEvents = (db: Db) => db.events.filter((e) => e.tenantId === A && e.eventType === 'catalog.changed.v1').map((e) => e.envelope.payload as Record<string, any>).filter((p) => p['entity_type'] === 'doctor');

describe('mergeDoctor X -> Y reassigns X\'s price list (03-APP-FLOW §2.4)', () => {
  it('survivor has NO list: X\'s list is re-assigned to Y (same list, same row count); X has none afterwards; the list stays active and unchanged', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    const out = await merge(db, svc, X.id as string, 1, Y.id as string);
    expect(out).toMatchObject({ id: X.id, is_active: false, merged_into_id: Y.id });
    expect(ownerOf(db, X.id as string)).toBeUndefined();
    expect(ownerOf(db, Y.id as string)).toMatchObject({ price_list_id: LX.id, owner_kind: 'referrer', credit_party_id: null, centre_id: null });
    expect(assignments(db)).toHaveLength(1);
    expect(db.row('price_lists', LX.id as string)).toMatchObject({ is_active: true, owner_kind: 'referrer', code: 'LISTX' });
  });

  it('survivor ALREADY has a list: X\'s assignment is dropped, Y keeps its own; X\'s list stays (active, now unassigned); nothing else moves', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LX, LY], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string), passign(2, A, LY.id as string, 'referrer', Y.id as string)] });
    await merge(db, svc, X.id as string, 1, Y.id as string);
    expect(ownerOf(db, X.id as string)).toBeUndefined();
    expect(ownerOf(db, Y.id as string)).toMatchObject({ price_list_id: LY.id });
    expect(assignments(db)).toHaveLength(1);
    expect(db.row('price_lists', LX.id as string)).toMatchObject({ is_active: true });
    expect(db.row('price_lists', LY.id as string)).toMatchObject({ is_active: true });
  });

  it('only the SURVIVOR has a list, or neither has one: assignments are unchanged / stay empty and the merge still succeeds', { timeout: T }, async () => {
    const a = setup({ price_lists: [LY], price_list_assignments: [passign(2, A, LY.id as string, 'referrer', Y.id as string)] });
    await merge(a.db, a.svc, X.id as string, 1, Y.id as string);
    expect(assignments(a.db).map((r) => r.doctor_id)).toEqual([Y.id]);
    const b = setup({});
    expect(await merge(b.db, b.svc, X.id as string, 1, Y.id as string)).toMatchObject({ merged_into_id: Y.id });
    expect(assignments(b.db)).toHaveLength(0);
  });

  it('other owners are never touched: centre / credit-party assignments, other doctors\' assignments, and tenant B\'s rows stay exactly as they were', { timeout: T }, async () => {
    const XB = doc(9, B, { doctor_code: 'DRB1' });
    const LB = plist(9, B, { owner_kind: 'referrer', code: 'BLIST' });
    const rows = {
      price_lists: [LX, LC, LB], collection_centres: [{ id: ID(0x1101), tenant_id: A, code: 'CEN1', name: 'Synthetic Centre 1' }], doctors: [XB],
      price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string), passign(3, A, LC.id as string, 'centre', ID(0x1101)), passign(9, B, LB.id as string, 'referrer', XB.id as string)],
    };
    const { db, svc } = setup(rows);
    const bBefore = JSON.stringify(assignments(db, B));
    await merge(db, svc, X.id as string, 1, Y.id as string);
    expect(assignments(db).filter((a) => a.owner_kind === 'centre')).toHaveLength(1);
    expect(JSON.stringify(assignments(db, B))).toBe(bBefore);
    expect(db.row('doctors', XB.id as string)).toMatchObject({ is_active: true, version: 1 });
  });

  it('the reassignment is in the SAME transaction as the merge: a failing assignment statement rolls the merge back (X stays active and unmerged, X keeps its list, no event)', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    db.fail(/price_list_assignments/i);
    const e: any = await merge(db, svc, X.id as string, 1, Y.id as string).then(() => undefined, (x) => x);
    expect(e, 'merge must fail when the reassignment fails').toBeDefined();
    expect(db.row('doctors', X.id as string)).toMatchObject({ is_active: true, merged_into_id: null, version: 1 });
    expect(ownerOf(db, X.id as string)).toMatchObject({ price_list_id: LX.id });
    expect(doctorEvents(db)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
  });

  it('a rolled-back merge (caller rollback) restores the assignment as well', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    await expect(db.run((ctx) => svc['mergeDoctor']!(ctx, { id: X.id, expectedVersion: 1, body: { into_doctor_id: Y.id } }), { at: at(0), rollback: true })).rejects.toThrow('forced rollback');
    expect(ownerOf(db, X.id as string)).toMatchObject({ price_list_id: LX.id }); expect(ownerOf(db, Y.id as string)).toBeUndefined();
  });

  it('still emits the doctor `deactivated` event for X (entity_id = X) with strictly increasing revisions and no gaps', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    await merge(db, svc, X.id as string, 1, Y.id as string);
    const ev = doctorEvents(db);
    expect(ev).toEqual([expect.objectContaining({ entity_type: 'doctor', entity_id: X.id, change_kind: 'deactivated' })]);
    const revs = db.events.filter((e) => e.tenantId === A && e.eventType === 'catalog.changed.v1').map((e) => (e.envelope.payload as Record<string, any>)['catalog_revision'] as number);
    revs.forEach((r, i) => expect(r).toBe(418 + i));
    expect(db.revisionOf(A)).toBe(417 + revs.length);
  });

  it('chain flattening and assignments together: Z merged into X earlier (its assignment already dropped), then X into Y -> Z -> Y, exactly one assignment (Y\'s, inherited from X)', { timeout: T }, async () => {
    const Z = doc(4, A, { doctor_code: 'DRZ1', is_active: false, merged_into_id: X.id });
    const { db, svc } = setup({ doctors: [Z], price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    await merge(db, svc, X.id as string, 1, Y.id as string);
    expect(db.row('doctors', Z.id as string)).toMatchObject({ merged_into_id: Y.id });
    expect(assignments(db).map((a) => a.doctor_id)).toEqual([Y.id]);
  });

  it('merging into a survivor and then merging the survivor again carries the list forward: X -> Y -> W leaves exactly one assignment, on W, the same list', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    await merge(db, svc, X.id as string, 1, Y.id as string);
    await merge(db, svc, Y.id as string, db.row('doctors', Y.id as string)!.version as number, W.id as string);
    expect(assignments(db)).toHaveLength(1);
    expect(ownerOf(db, W.id as string)).toMatchObject({ price_list_id: LX.id });
  });

  it('a refused merge (target inactive / self / stale If-Match) leaves the assignment where it was', { timeout: T }, async () => {
    const off = doc(5, A, { doctor_code: 'DROFF', is_active: false });
    const { db, svc } = setup({ doctors: [off], price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    for (const [version, into] of [[1, off.id], [1, X.id], [5, Y.id]] as const) {
      const e: any = await merge(db, svc, X.id as string, version, into as string).then(() => undefined, (x) => x);
      expect(isLimsError(e), `got ${e?.message}`).toBe(true);
    }
    expect(ownerOf(db, X.id as string)).toMatchObject({ price_list_id: LX.id }); expect(assignments(db)).toHaveLength(1);
    expect(db.row('doctors', X.id as string)).toMatchObject({ is_active: true, merged_into_id: null });
  });

  it('S-1: every statement the merge issues against price_list_assignments is scoped to the caller\'s tenant', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LX], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string)] });
    await merge(db, svc, X.id as string, 1, Y.id as string);
    const mine = db.stmts.filter((s) => s.tenantId === A && /price_list_assignments/i.test(s.text));
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) { expect(/tenant_id/i.test(s.text), s.text).toBe(true); expect(s.values, s.text).toContain(A); }
  });

  it('concurrent merges X->Y and W->Y with a list each: no deadlock, Y ends with exactly one assignment (a doctor has at most one list)', { timeout: T }, async () => {
    const LW = plist(4, A, { owner_kind: 'referrer', code: 'LISTW' });
    const { db, svc } = setup({ price_lists: [LX, LW], price_list_assignments: [passign(1, A, LX.id as string, 'referrer', X.id as string), passign(4, A, LW.id as string, 'referrer', W.id as string)] });
    const r = await Promise.allSettled([merge(db, svc, X.id as string, 1, Y.id as string), merge(db, svc, W.id as string, 1, Y.id as string)]);
    expect(r.every((x) => x.status === 'fulfilled'), JSON.stringify(r.map((x) => (x as any).reason?.message))).toBe(true);
    expect(assignments(db).filter((a) => a.doctor_id === Y.id)).toHaveLength(1);
    expect(assignments(db).filter((a) => [X.id, W.id].includes(a.doctor_id as string))).toHaveLength(0);
    expect(assignments(db)).toHaveLength(1);
  });
});
