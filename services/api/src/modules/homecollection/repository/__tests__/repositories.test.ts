// HC-T03 — homecollection repositories + RLS integration (06-PLAN row HC-T03; 07-SEC cross-tenant/table probes). Real migrated PG17, tenant_a/tenant_b.
// Done-when: all queries parameterised, explicit tenant_id filter. Proof of the explicit filter = run each repo fn as the SUPERUSER (RLS bypassed) with the
// other tenant's ids: it must still return null / [] / 0 rows. RLS (lims_api) is only the backstop.
// Contract (ASSUMED — spec names only the files `repository/*.repo.ts`; see .orchestra/notes/HC-T03-tests.md): every fn is `fn(tx, tenantId, ...args)`,
// tx = { query(text, values) -> { rows } }, returns RAW snake_case rows / null / [] (global-table fns drop tenantId). insertX(tx, tenantId, row) ignores row.tenant_id.
// updateX(tx, tenantId, id, expectedVersion, patch) -> updated row | null; version is bumped by the repo; patch keys are allow-listed column names.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows as fd, BRANCH } from '../../../frontdesk/__tests__/integration/helpers.js';
import { HC_CENTRE, MEMBER, T0, TENANT, TENANT_A, TENANT_B, SYS_ACTOR, appTx, closePools, hc, ownerRows, seed, superTx, uid, seedWorld, type Side, type World } from './helpers.js';

const load = (n: string): Promise<any> => import(/* @vite-ignore */ `../${n}.repo.js`);
let W: Record<Side, World>;
beforeAll(async () => { W = { a: await seedWorld('a'), b: await seedWorld('b') }; }, 120_000);
afterAll(closePools);
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
const errOf = async (p: Promise<unknown>): Promise<any> => p.then(() => null, (x) => x);
const rejects42501 = async (p: Promise<unknown>) => {
  const e = await errOf(p);
  expect(e, 'insert across tenants must be refused by RLS WITH CHECK').not.toBeNull();
  expect(e.code).toBe('42501');
};
const fresh = async (s: Side) => { // a new specimen of side s (superuser fixture) for tables with unique (visit,specimen) / (collection)
  const sp = { id: uid(), tenant_id: TENANT[s], centre_id: HC_CENTRE[s], order_id: W[s].order.id, patient_id: W[s].patient.id, barcode: `HCT03F${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 20),
    creation_key: `hct03-${uid()}`, specimen_type_code: 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0 };
  await seed('lab.specimens', sp); return sp;
};

interface Spec {
  name: string; file: string; table: string;
  insert: string; get?: string; list?: string; update?: string;
  make: (s: Side, w: World) => Record<string, unknown> | Promise<Record<string, unknown>>;   // new row for side s, valid parents of side s
  of: (w: World) => any;                                                                      // the seeded row of this table
  listArg?: (w: World) => unknown[];                                                          // args after tenantId for list()
  patch?: (s: Side) => Record<string, unknown>;                                               // a legal change for update()
  appendOnly?: boolean;                                                                       // no update*/delete*/remove*/purge*/set* export
}
const specs: Spec[] = [
  { name: 'bookingRefs', file: 'bookingRefs', table: 'homecollection.booking_refs', insert: 'insertBookingRef', get: 'getBookingRefById', update: 'updateBookingRef',
    make: (s) => hc.bookingRef(s), of: (w) => w.bookingRef, patch: () => ({ state: 'cancelled', last_seq: 2, updated_by: SYS_ACTOR }) },
  { name: 'routes', file: 'routes', table: 'homecollection.routes', insert: 'insertRoute', get: 'getRouteById', list: 'listRoutesByMembershipDate', update: 'updateRoute',
    make: (s) => hc.route(s), of: (w) => w.route, listArg: (w) => [w.route.phlebotomist_membership_id, w.route.route_date], patch: () => ({ last_snapshot_at: T0, updated_by: SYS_ACTOR }) },
  { name: 'visits', file: 'visits', table: 'homecollection.visits', insert: 'insertVisit', get: 'getVisitById', list: 'listVisitsByCentreStatus', update: 'updateVisit',
    make: (s, w) => hc.visit(s, { patient: w.patient, order: { id: w.order.id } }, { kind: 'booking', order_id: null, booking_id: uid(), orderable_ids: [uid()] }),
    of: (w) => w.visit, listArg: (w) => [w.visit.centre_id, 'unassigned'], patch: () => ({ landmark: 'Opposite the synthetic school', updated_by: SYS_ACTOR }) },
  { name: 'visitTransitions', file: 'visitTransitions', table: 'homecollection.visit_transitions', insert: 'insertVisitTransition', list: 'listTransitionsByVisit', appendOnly: true,
    make: (s, w) => hc.transition(s, w.visit.id, { from_status: 'unassigned', to_status: 'assigned' }), of: (w) => w.transition, listArg: (w) => [w.visit.id] },
  { name: 'visitAssignments', file: 'visitAssignments', table: 'homecollection.visit_assignments', insert: 'insertVisitAssignment', list: 'listAssignmentsByVisit', appendOnly: true,
    make: (s, w) => hc.assignment(s, w.visit.id, w.route.id, { action: 'reassign' }), of: (w) => w.assignment, listArg: (w) => [w.visit.id] },
  { name: 'visitSpecimens', file: 'visitSpecimens', table: 'homecollection.visit_specimens', insert: 'insertVisitSpecimen', get: 'getVisitSpecimenById', list: 'listVisitSpecimensByVisit', update: 'updateVisitSpecimen',
    make: async (s, w) => hc.visitSpecimen(s, { specimen: await fresh(s), order: w.order }, w.visit.id), of: (w) => w.visitSpecimen, listArg: (w) => [w.visit.id],
    patch: () => ({ status: 'collected', last_seq: 1, updated_by: SYS_ACTOR }) },
  { name: 'devices', file: 'devices', table: 'homecollection.devices', insert: 'insertDevice', get: 'getDeviceById', update: 'updateDevice',
    make: (s) => hc.device(s), of: (w) => w.device, patch: () => ({ last_seen_at: T0, max_device_seq_received: 5, updated_by: SYS_ACTOR }) },
  { name: 'syncBatches', file: 'syncBatches', table: 'homecollection.sync_batches', insert: 'insertSyncBatch', get: 'getSyncBatchById', appendOnly: true,
    make: (s, w) => hc.syncBatch(s, w.device.id), of: (w) => w.batch },
  { name: 'mutations', file: 'mutations', table: 'homecollection.mutations', insert: 'insertMutation', get: 'getMutationById', list: 'listMutationsByVisit', appendOnly: true,
    make: (s, w) => hc.mutation(s, w.device.id, w.batch.id, w.visit.id, { type: 'visit.identity_checked' }), of: (w) => w.mutation, listArg: (w) => [w.visit.id] },
  { name: 'collections', file: 'collections', table: 'homecollection.collections', insert: 'insertCollection', get: 'getCollectionById', list: 'listHeldCollections', update: 'updateCollection',
    make: async (s, w) => hc.collection(s, { specimen: await fresh(s), order: w.order }, w.visit.id, w.mutation.id), of: (w) => w.collection, listArg: () => [],
    patch: (s) => ({ status: 'applied', review_decision: 'apply', review_reason_code: 'synthetic_ok', reviewed_by: MEMBER[s], reviewed_at: T0, updated_by: SYS_ACTOR }) },
  { name: 'handovers', file: 'handovers', table: 'homecollection.handovers', insert: 'insertHandover', get: 'getHandoverById', list: 'listHandoversByToCentre', update: 'updateHandover',
    make: (s, w) => hc.handover(s, w.mutation.id), of: (w) => w.handover, listArg: (w) => [w.handover.to_centre_id],
    patch: (s) => ({ status: 'confirmed', received_by_membership_id: MEMBER[s], received_at: T0, updated_by: SYS_ACTOR }) },
  { name: 'handoverItems', file: 'handovers', table: 'homecollection.handover_items', insert: 'insertHandoverItem', get: 'getHandoverItemById', list: 'listHandoverItemsByHandover', update: 'updateHandoverItem',
    make: async (s, w) => { // a fresh collection (unique per item) of side s
      const sp = await fresh(s); const col = hc.collection(s, { specimen: sp, order: w.order }, w.visit.id, w.mutation.id); await seed('homecollection.collections', col);
      return hc.handoverItem(s, w.handover.id, col.id, { specimen: sp }, w.visit.id); },
    of: (w) => w.handoverItem, listArg: (w) => [w.handover.id], patch: () => ({ outcome: 'received', updated_by: SYS_ACTOR }) },
  { name: 'visitFlags', file: 'visitFlags', table: 'homecollection.visit_flags', insert: 'insertVisitFlag', get: 'getVisitFlagById', list: 'listVisitFlagsByVisit', update: 'updateVisitFlag',
    make: (s, w) => hc.flag(s, w.visit.id), of: (w) => w.flag, listArg: (w) => [w.visit.id],
    patch: (s) => ({ status: 'resolved', resolution_code: 'synthetic_resolved', resolved_by: MEMBER[s], resolved_at: T0, updated_by: SYS_ACTOR }) },
  { name: 'visitLocations', file: 'visitLocations', table: 'homecollection.visit_locations', insert: 'insertVisitLocation', list: 'listLocationsByVisit',
    make: (s, w) => hc.location(s, w.visit.id, w.mutation.id, { kind: 'collected' }), of: (w) => w.location, listArg: (w) => [w.visit.id] },
];

describe.each(specs)('$name.repo — integration + cross-tenant probes', (sp) => {
  it('module exports the contract functions', async () => {
    const m = await load(sp.file);
    for (const f of [sp.insert, sp.get, sp.list, sp.update].filter(Boolean) as string[]) expect(typeof m[f], f).toBe('function');
    if (sp.appendOnly) expect(Object.keys(m).filter((k) => /^(update|delete|remove|purge|set)/i.test(k)), 'append-only table: no mutating export').toEqual([]);
  });

  it('insert (own tenant, under RLS) persists the row and returns it with the caller tenant_id', async () => {
    const m = await load(sp.file);
    const row = await sp.make('a', W.a);
    const got = await appTx(TENANT_A, (tx) => m[sp.insert](tx, TENANT_A, row));
    expect(got?.tenant_id).toBe(TENANT_A);
    expect(got.id).toBe(row.id);
    expect(await ownerRows(sp.table, 'tenant_id = $1 AND id = $2', [TENANT_A, row.id])).toHaveLength(1);
  });

  it('insert with the OTHER tenant\'s id under tenant_a claims is refused by RLS (42501) and writes nothing', async () => {
    const m = await load(sp.file);
    const row = await sp.make('b', W.b);
    await rejects42501(appTx(TENANT_A, (tx) => m[sp.insert](tx, TENANT_B, row)));
    expect(await ownerRows(sp.table, 'id = $1', [row.id])).toHaveLength(0);
  });

  it('a tenant_id smuggled inside the row object cannot override the tenantId argument (forged tenant_id)', async () => {
    const m = await load(sp.file);
    const row = { ...(await sp.make('a', W.a)), tenant_id: TENANT_B };
    const r = await appTx(TENANT_A, (tx) => m[sp.insert](tx, TENANT_A, row)).then((o) => ({ ok: o }), (e) => ({ err: e }));
    if ('err' in r) expect((r.err as any).code).toBe('42501'); // refusing is fine
    expect(await ownerRows(sp.table, 'tenant_id = $1 AND id = $2', [TENANT_B, row.id])).toHaveLength(0); // never stored under B
  });

  if (sp.get) {
    it('get returns the row inside the tenant', async () => {
      const m = await load(sp.file);
      const got = await appTx(TENANT_A, (tx) => m[sp.get!](tx, TENANT_A, sp.of(W.a).id));
      expect(got?.id).toBe(sp.of(W.a).id);
      expect(got.tenant_id).toBe(TENANT_A);
    });
    it('get of a B id with tenantId=A is null with RLS BYPASSED (the repo\'s own explicit tenant_id filter) — both directions', async () => {
      const m = await load(sp.file);
      expect(await superTx((tx) => m[sp.get!](tx, TENANT_A, sp.of(W.b).id))).toBeNull();
      expect(await superTx((tx) => m[sp.get!](tx, TENANT_B, sp.of(W.a).id))).toBeNull();
      expect((await superTx((tx) => m[sp.get!](tx, TENANT_B, sp.of(W.b).id)))?.id).toBe(sp.of(W.b).id); // same query does work in-tenant
    });
    it('get with tenantId=B but tenant_a claims returns null (RLS backstop); a random id returns null (no throw)', async () => {
      const m = await load(sp.file);
      expect(await appTx(TENANT_A, (tx) => m[sp.get!](tx, TENANT_B, sp.of(W.b).id))).toBeNull();
      expect(await appTx(TENANT_A, (tx) => m[sp.get!](tx, TENANT_A, uid()))).toBeNull();
    });
  }

  if (sp.list) {
    it('list returns only the tenant\'s rows, RLS bypassed (explicit filter) and under RLS', async () => {
      const m = await load(sp.file);
      for (const s of ['a', 'b'] as Side[]) {
        const viaOwner = await superTx((tx) => m[sp.list!](tx, TENANT[s], ...sp.listArg!(W[s])));
        expect(viaOwner.length).toBeGreaterThan(0);
        expect(viaOwner.every((r: any) => r.tenant_id === TENANT[s])).toBe(true);
        expect(viaOwner.map((r: any) => r.id)).toContain(sp.of(W[s]).id);
        const viaApp = await appTx(TENANT[s], (tx) => m[sp.list!](tx, TENANT[s], ...sp.listArg!(W[s])));
        expect(viaApp.every((r: any) => r.tenant_id === TENANT[s])).toBe(true);
      }
    });
    it('list with the OTHER tenant\'s parent id / tenantId yields zero rows — id swap probe', async () => {
      const m = await load(sp.file);
      for (const s of ['a', 'b'] as Side[]) {
        const o = other(s);
        if (sp.listArg!(W[o]).length) // no parent id to swap (e.g. listHeldCollections) -> nothing to probe here; the tenantId-swap line below still runs
          expect(await superTx((tx) => m[sp.list!](tx, TENANT[s], ...sp.listArg!(W[o])))).toEqual([]); // A's tenantId + B's parent ids, RLS bypassed
        expect((await appTx(TENANT[s], (tx) => m[sp.list!](tx, TENANT[o], ...sp.listArg!(W[o])))).filter((r: any) => r.tenant_id === TENANT[o])).toEqual([]);
      }
    });
  }

  if (sp.update) {
    const upd = (m: any, tx: any, t: string, id: string, v: number, p: Record<string, unknown>) => m[sp.update!](tx, t, id, v, p);
    it('update (own tenant, current version) applies the patch, bumps version by 1 and returns the row', async () => {
      const m = await load(sp.file);
      const row = await sp.make('a', W.a); await seed(sp.table, row);
      const got = await appTx(TENANT_A, (tx) => upd(m, tx, TENANT_A, row.id as string, 1, sp.patch!('a')));
      expect(got?.id).toBe(row.id);
      expect(got.version).toBe(2);
      for (const [k, v] of Object.entries(sp.patch!('a'))) if (typeof v === 'string' && !/_at$/.test(k)) expect(got[k], k).toBe(v);
    });
    it('update with a stale expectedVersion returns null and changes nothing (optimistic lock)', async () => {
      const m = await load(sp.file);
      const row = await sp.make('a', W.a); await seed(sp.table, row);
      expect(await appTx(TENANT_A, (tx) => upd(m, tx, TENANT_A, row.id as string, 7, sp.patch!('a')))).toBeNull();
      expect((await ownerRows(sp.table, 'id = $1', [row.id]))[0].version).toBe(1);
    });
    it('update of a B row with tenantId=A is null with RLS BYPASSED (explicit tenant_id in the UPDATE) and B is unchanged', async () => {
      const m = await load(sp.file);
      const row = await sp.make('b', W.b); await seed(sp.table, row);
      expect(await superTx((tx) => upd(m, tx, TENANT_A, row.id as string, 1, sp.patch!('b')))).toBeNull();
      expect((await ownerRows(sp.table, 'id = $1', [row.id]))[0].version).toBe(1);
    });
    it('update with tenantId=B under tenant_a claims is null (RLS backstop) and B is unchanged', async () => {
      const m = await load(sp.file);
      const row = await sp.make('b', W.b); await seed(sp.table, row);
      expect(await appTx(TENANT_A, (tx) => upd(m, tx, TENANT_B, row.id as string, 1, sp.patch!('b')))).toBeNull();
      expect((await ownerRows(sp.table, 'id = $1', [row.id]))[0].version).toBe(1);
    });
    it('patch keys are allow-listed column names: tenant_id, id, unknown and injection-shaped keys are refused and write nothing', async () => {
      const m = await load(sp.file);
      const row = await sp.make('a', W.a); await seed(sp.table, row);
      const evil = [{ tenant_id: TENANT_B }, { id: uid() }, { no_such_column: 1 }, { "version = 99, tenant_id": TENANT_B }, { 'updated_by = updated_by; DROP TABLE homecollection.visits; --': 1 }];
      for (const p of evil) {
        const e = await errOf(appTx(TENANT_A, (tx) => upd(m, tx, TENANT_A, row.id as string, 1, { ...sp.patch!('a'), ...p })));
        expect(e, JSON.stringify(Object.keys(p))).not.toBeNull();
      }
      const after = (await ownerRows(sp.table, 'id = $1', [row.id]))[0];
      expect(after.tenant_id).toBe(TENANT_A); expect(after.version).toBe(1);
      expect((await ownerRows('homecollection.visits', 'id = $1', [W.a.visit.id]))).toHaveLength(1);
    });
  }
});

describe('settings.repo — lazy create (HC-T04 relies on it) + tenant filter', () => {
  it('getSettings / insertSettingsIfAbsent / updateSettings are exported', async () => {
    const m = await load('settings');
    for (const f of ['getSettings', 'insertSettingsIfAbsent', 'updateSettings']) expect(typeof m[f], f).toBe('function');
  });
  it('getSettings: in-tenant row; other tenant null with RLS bypassed; tenantId=B under A claims null', async () => {
    const m = await load('settings');
    expect((await appTx(TENANT_A, (tx) => m.getSettings(tx, TENANT_A)))?.tenant_id).toBe(TENANT_A);
    expect((await superTx((tx) => m.getSettings(tx, TENANT_B)))?.id).toBe(W.b.settings.id);
    expect(await appTx(TENANT_A, (tx) => m.getSettings(tx, TENANT_B))).toBeNull();
  });
  it('insertSettingsIfAbsent is INSERT … ON CONFLICT (tenant_id) DO NOTHING: second call returns null and does not overwrite; B-under-A refused (42501)', async () => {
    const m = await load('settings');
    // fixture: B has no settings row (superuser delete, restored by the lazy insert below)
    await superTx((tx) => tx.query('DELETE FROM homecollection.settings WHERE tenant_id = $1', [TENANT_B]), TENANT_B);
    expect(await appTx(TENANT_B, (tx) => m.getSettings(tx, TENANT_B))).toBeNull(); // a read with no row is null here; the service applies the defaults (08 A17 P-22)
    const first = await appTx(TENANT_B, (tx) => m.insertSettingsIfAbsent(tx, TENANT_B, hc.settings('b', { sync_interval_seconds: 120 })));
    expect(first?.tenant_id).toBe(TENANT_B); expect(first.sync_interval_seconds).toBe(120);
    const second = await appTx(TENANT_B, (tx) => m.insertSettingsIfAbsent(tx, TENANT_B, hc.settings('b', { sync_interval_seconds: 600 })));
    expect(second).toBeNull();
    expect((await ownerRows('homecollection.settings', 'tenant_id = $1', [TENANT_B]))).toHaveLength(1);
    expect((await ownerRows('homecollection.settings', 'tenant_id = $1', [TENANT_B]))[0].sync_interval_seconds).toBe(120);
    await rejects42501(appTx(TENANT_A, (tx) => m.insertSettingsIfAbsent(tx, TENANT_B, hc.settings('b'))));
  });
  it('updateSettings(tx, tenantId, id, expectedVersion, patch): applies + bumps version; stale -> null; other tenant -> null even with RLS bypassed; tenant_id key refused', async () => {
    const m = await load('settings');
    const cur = await appTx(TENANT_A, (tx) => m.getSettings(tx, TENANT_A));
    const got = await appTx(TENANT_A, (tx) => m.updateSettings(tx, TENANT_A, cur.id, cur.version, { sync_interval_seconds: 180, updated_by: SYS_ACTOR }));
    expect(got.sync_interval_seconds).toBe(180); expect(got.version).toBe(cur.version + 1);
    expect(await appTx(TENANT_A, (tx) => m.updateSettings(tx, TENANT_A, cur.id, cur.version, { sync_interval_seconds: 240, updated_by: SYS_ACTOR }))).toBeNull();
    const b = await superTx((tx) => m.getSettings(tx, TENANT_B));
    expect(await superTx((tx) => m.updateSettings(tx, TENANT_A, b.id, b.version, { sync_interval_seconds: 240, updated_by: SYS_ACTOR }))).toBeNull();
    expect(await errOf(appTx(TENANT_A, (tx) => m.updateSettings(tx, TENANT_A, cur.id, got.version, { tenant_id: TENANT_B })))).not.toBeNull();
    expect((await ownerRows('homecollection.settings', 'id = $1', [b.id]))[0].sync_interval_seconds).toBe(120);
  });
});

describe('reasons.repo — global seed codes (D-130), no tenant filter, parameterised', () => {
  const A = hc.reason('visit_cancel_reasons', `hct03_${uid().slice(-8).replace(/-/g, '')}_a`, { sort_order: 9001 });
  const B = hc.reason('visit_cancel_reasons', `hct03_${uid().slice(-8).replace(/-/g, '')}_b`, { sort_order: 9002 });
  beforeAll(async () => { await seed('homecollection.g_cs_reasons', B); await seed('homecollection.g_cs_reasons', A); });
  it('listReasonsBySet(tx, setCode) returns active rows ordered by sort_order and takes no tenant argument', async () => {
    const m = await load('reasons');
    const got = await appTx(TENANT_A, (tx) => m.listReasonsBySet(tx, 'visit_cancel_reasons'));
    const codes = got.map((r: any) => r.code);
    expect(codes).toContain(A.code); expect(codes.indexOf(A.code)).toBeLessThan(codes.indexOf(B.code));
    expect(got.every((r: any) => r.set_code === 'visit_cancel_reasons' && r.is_active)).toBe(true);
    expect(await appTx(TENANT_B, (tx) => m.listReasonsBySet(tx, 'visit_cancel_reasons'))).toEqual(got); // same global rows for every tenant
  });
  it('getReason(tx, setCode, code): found / null on miss; hostile values are data, not SQL', async () => {
    const m = await load('reasons');
    expect((await appTx(TENANT_A, (tx) => m.getReason(tx, 'visit_cancel_reasons', A.code)))?.id).toBe(A.id);
    expect(await appTx(TENANT_A, (tx) => m.getReason(tx, 'unassign_reasons', A.code))).toBeNull();
    for (const evil of ["' OR '1'='1", "x'; DROP TABLE homecollection.g_cs_reasons; --", '\\', '%'])
      expect(await appTx(TENANT_A, (tx) => m.getReason(tx, evil, evil))).toBeNull();
    expect(await appTx(TENANT_A, (tx) => m.listReasonsBySet(tx, "' OR '1'='1"))).toEqual([]);
    expect((await ownerRows('homecollection.g_cs_reasons', 'id = $1', [A.id]))).toHaveLength(1);
  });
  it('exports no write function (v1: reasons come from global seeds only)', async () => {
    expect(Object.keys(await load('reasons')).filter((k) => /^(insert|update|delete|remove|purge|set|upsert)/i.test(k))).toEqual([]);
  });
});

describe('natural-key lookups (05-SCHEMA §5 query→index map)', () => {
  it('getVisitByBookingId / getVisitByOrderId: in-tenant found; other tenant null with RLS bypassed and under RLS', async () => {
    const m = await load('visits');
    expect((await appTx(TENANT_A, (tx) => m.getVisitByBookingId(tx, TENANT_A, W.a.bookingVisit.booking_id)))?.id).toBe(W.a.bookingVisit.id);
    expect((await appTx(TENANT_A, (tx) => m.getVisitByOrderId(tx, TENANT_A, W.a.order.id)))?.id).toBe(W.a.visit.id);
    expect(await superTx((tx) => m.getVisitByBookingId(tx, TENANT_A, W.b.bookingVisit.booking_id))).toBeNull();
    expect(await superTx((tx) => m.getVisitByOrderId(tx, TENANT_A, W.b.order.id))).toBeNull();
    expect(await appTx(TENANT_A, (tx) => m.getVisitByOrderId(tx, TENANT_B, W.b.order.id))).toBeNull();
  });
  it('listVisitsByRoute(tx, tenantId, routeId) is ordered by route_sequence and tenant-scoped', async () => {
    const m = await load('visits');
    const r = hc.route('a'); await seed('homecollection.routes', r);
    // 05-SCHEMA.md:267 visits__order_when_active__ck: an assigned visit needs order_id -> seed a fresh tenant-A order (not W.a.order, keeps getVisitByOrderId unambiguous)
    const o = fd.order('a', W.a.patient.id, { centre_id: HC_CENTRE.a, collection_mode: 'home' }); await seed('frontdesk.orders', o);
    await seed('lab.orders', { id: o.id, tenant_id: TENANT_A, centre_id: HC_CENTRE.a, branch_id: BRANCH.a, patient_id: W.a.patient.id, registration_no: o.registration_no, visit_type: 'opd',
      priority: 'routine', collection_mode: 'home', source: 'home_collection', registered_at: T0, patient_sex: 'female', last_order_seq: 1 });
    const mk = (seq: number) => hc.visit('a', W.a, { kind: 'booking', order_id: o.id, booking_id: uid(), orderable_ids: [uid()], status: 'assigned', route_id: r.id,
      route_date: r.route_date, assigned_membership_id: MEMBER.a, route_sequence: seq });
    const [v2, v1] = [mk(2), mk(1)]; await seed('homecollection.visits', v2); await seed('homecollection.visits', v1);
    expect((await appTx(TENANT_A, (tx) => m.listVisitsByRoute(tx, TENANT_A, r.id))).map((x: any) => x.id)).toEqual([v1.id, v2.id]);
    expect(await superTx((tx) => m.listVisitsByRoute(tx, TENANT_B, r.id))).toEqual([]); // A's route id with B's tenantId, RLS bypassed
  });
  it('getBookingRefByBookingId(tx, tenantId, bookingId): in-tenant found; other tenant null (bypassed + RLS)', async () => {
    const m = await load('bookingRefs');
    expect((await appTx(TENANT_A, (tx) => m.getBookingRefByBookingId(tx, TENANT_A, W.a.bookingRef.booking_id)))?.id).toBe(W.a.bookingRef.id);
    expect(await superTx((tx) => m.getBookingRefByBookingId(tx, TENANT_A, W.b.bookingRef.booking_id))).toBeNull();
    expect(await appTx(TENANT_A, (tx) => m.getBookingRefByBookingId(tx, TENANT_B, W.b.bookingRef.booking_id))).toBeNull();
  });
  it('getRouteByKey(tx, tenantId, centreId, membershipId, routeDate): in-tenant found; other tenant null', async () => {
    const m = await load('routes');
    const a = W.a.route, b = W.b.route;
    expect((await appTx(TENANT_A, (tx) => m.getRouteByKey(tx, TENANT_A, a.centre_id, a.phlebotomist_membership_id, a.route_date)))?.id).toBe(a.id);
    expect(await superTx((tx) => m.getRouteByKey(tx, TENANT_A, b.centre_id, b.phlebotomist_membership_id, b.route_date))).toBeNull();
  });
  it('visit_specimens: listVisitSpecimensByOrder(tx, tenantId, orderId) tenant-scoped', async () => {
    const m = await load('visitSpecimens');
    expect((await superTx((tx) => m.listVisitSpecimensByOrder(tx, TENANT_A, W.a.order.id))).map((r: any) => r.id)).toContain(W.a.visitSpecimen.id);
    expect(await superTx((tx) => m.listVisitSpecimensByOrder(tx, TENANT_A, W.b.order.id))).toEqual([]);
  });
});

describe('visits.repo — status filter is a bound parameter (injection)', () => {
  it('hostile status text returns [] and nothing is dropped', async () => {
    const m = await load('visits');
    for (const evil of ["x' OR '1'='1", "unassigned'; DROP TABLE homecollection.visits; --", '\\'])
      expect(await superTx((tx) => m.listVisitsByCentreStatus(tx, TENANT_A, HC_CENTRE.a, evil))).toEqual([]);
    expect((await ownerRows('homecollection.visits', 'id = $1', [W.a.visit.id]))).toHaveLength(1);
  });
  it('a visit cannot be inserted with another tenant\'s patient (tenant-composite FK -> 23503)', async () => {
    const m = await load('visits');
    const e = await errOf(appTx(TENANT_A, (tx) => m.insertVisit(tx, TENANT_A, hc.visit('a', { patient: W.b.patient, order: W.a.order }, { order_id: null, kind: 'booking', booking_id: uid(), orderable_ids: [uid()] }))));
    expect(e?.code).toBe('23503');
  });
  it('duplicate booking_id in the tenant is 23505; the same booking_id in the other tenant is fine', async () => {
    const m = await load('visits');
    const dup = hc.visit('a', W.a, { kind: 'booking', order_id: null, booking_id: W.a.bookingVisit.booking_id, orderable_ids: [uid()] });
    expect((await errOf(appTx(TENANT_A, (tx) => m.insertVisit(tx, TENANT_A, dup))))?.code).toBe('23505');
    const ok = hc.visit('b', W.b, { kind: 'booking', order_id: null, booking_id: W.a.bookingVisit.booking_id, orderable_ids: [uid()] });
    expect((await appTx(TENANT_B, (tx) => m.insertVisit(tx, TENANT_B, ok)))?.tenant_id).toBe(TENANT_B);
  });
});

describe('mutations.repo — push dedupe primitive (TRD §6.3) ', () => {
  it('getMutationByClientId(tx, tenantId, clientMutationId): in-tenant found; other tenant null (bypassed + RLS)', async () => {
    const m = await load('mutations');
    const a = W.a.mutation, b = W.b.mutation;
    expect((await appTx(TENANT_A, (tx) => m.getMutationByClientId(tx, TENANT_A, a.client_mutation_id)))?.id).toBe(a.id);
    expect(await superTx((tx) => m.getMutationByClientId(tx, TENANT_A, b.client_mutation_id))).toBeNull();
    expect(await appTx(TENANT_A, (tx) => m.getMutationByClientId(tx, TENANT_B, b.client_mutation_id))).toBeNull();
  });
  it('same client_mutation_id twice in a tenant is 23505; the same id in the other tenant is allowed', async () => {
    const m = await load('mutations');
    const dup = hc.mutation('a', W.a.device.id, W.a.batch.id, W.a.visit.id, { client_mutation_id: W.a.mutation.client_mutation_id });
    expect((await errOf(appTx(TENANT_A, (tx) => m.insertMutation(tx, TENANT_A, dup))))?.code).toBe('23505');
    const ok = hc.mutation('b', W.b.device.id, W.b.batch.id, W.b.visit.id, { client_mutation_id: W.a.mutation.client_mutation_id });
    expect((await appTx(TENANT_B, (tx) => m.insertMutation(tx, TENANT_B, ok)))?.tenant_id).toBe(TENANT_B);
  });
  it('20 concurrent inserts of one client_mutation_id: exactly one wins, the rest are 23505 (no partial rows)', async () => {
    const m = await load('mutations');
    const cid = uid();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => appTx(TENANT_A, (tx) => m.insertMutation(tx, TENANT_A,
      hc.mutation('a', W.a.device.id, W.a.batch.id, W.a.visit.id, { client_mutation_id: cid, device_seq: 900000 + i }))).then(() => 'ok', (e) => e.code)));
    expect(rs.filter((r) => r === 'ok')).toHaveLength(1);
    expect(rs.filter((r) => r === '23505')).toHaveLength(19);
    expect(await ownerRows('homecollection.mutations', 'tenant_id = $1 AND client_mutation_id = $2', [TENANT_A, cid])).toHaveLength(1);
  });
  it('listMutationsByVisit is ordered by device_seq ascending', async () => {
    const m = await load('mutations');
    const v = hc.visit('a', W.a, { kind: 'booking', order_id: null, booking_id: uid(), orderable_ids: [uid()] }); await seed('homecollection.visits', v);
    for (const seq of [30, 10, 20]) await seed('homecollection.mutations', hc.mutation('a', W.a.device.id, W.a.batch.id, v.id, { device_seq: seq + 800000 }));
    const got = await appTx(TENANT_A, (tx) => m.listMutationsByVisit(tx, TENANT_A, v.id));
    expect(got.map((r: any) => Number(r.device_seq))).toEqual([800010, 800020, 800030]);
  });
});

describe('collections.repo — one applied collection per specimen; held queue', () => {
  it('a second APPLIED collection for the same specimen is 23505; the same specimen id cannot be reused across tenants (FK)', async () => {
    const m = await load('collections');
    const sp = await fresh('a');
    const one = hc.collection('a', { specimen: sp, order: W.a.order }, W.a.visit.id, W.a.mutation.id, { status: 'applied', hold_code: null });
    await appTx(TENANT_A, (tx) => m.insertCollection(tx, TENANT_A, one));
    const two = hc.collection('a', { specimen: sp, order: W.a.order }, W.a.visit.id, W.a.mutation.id, { status: 'applied', hold_code: null });
    expect((await errOf(appTx(TENANT_A, (tx) => m.insertCollection(tx, TENANT_A, two))))?.code).toBe('23505');
    const cross = hc.collection('b', { specimen: sp, order: W.b.order }, W.b.visit.id, W.b.mutation.id);
    expect((await errOf(appTx(TENANT_B, (tx) => m.insertCollection(tx, TENANT_B, cross))))?.code).toBe('23503');
  });
  it('listHeldCollections(tx, tenantId) returns only status = held rows of the tenant, oldest collected_at first', async () => {
    const m = await load('collections');
    const got = await superTx((tx) => m.listHeldCollections(tx, TENANT_A));
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((r: any) => r.tenant_id === TENANT_A && r.status === 'held')).toBe(true);
    const ts = got.map((r: any) => new Date(r.collected_at).getTime());
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
  });
});

describe('handovers.repo — visible from the receiving centre, tenant filter explicit', () => {
  it('listHandoverItemsByHandover: other tenant\'s handover id yields [] with RLS bypassed', async () => {
    const m = await load('handovers');
    expect(await superTx((tx) => m.listHandoverItemsByHandover(tx, TENANT_A, W.b.handover.id))).toEqual([]);
  });
  it('item carries its own barcode + specimen_type_code copy (D-125) and a second item for the same collection is 23505', async () => {
    const m = await load('handovers');
    const it1 = hc.handoverItem('a', W.a.handover.id, W.a.collection.id, { specimen: W.a.specimen }, W.a.visit.id);
    expect((await errOf(appTx(TENANT_A, (tx) => m.insertHandoverItem(tx, TENANT_A, it1))))?.code).toBe('23505');
    const rows = await appTx(TENANT_A, (tx) => m.listHandoverItemsByHandover(tx, TENANT_A, W.a.handover.id));
    expect(rows[0].barcode).toBe(W.a.specimen.barcode); expect(rows[0].specimen_type_code).toBe('SST');
  });
});

describe('visitLocations.repo — class E retention delete (the only DELETE grant, 05-SCHEMA §4.1 (3))', () => {
  it('deleteExpiredLocations(tx, tenantId) removes only the tenant\'s expired rows (RLS bypassed -> explicit filter) and returns the count', async () => {
    const m = await load('visitLocations');
    const mk = (s: Side, exp: string) => hc.location(s, W[s].visit.id, W[s].mutation.id, { captured_at: '2020-01-01T00:00:00Z', expires_at: exp });
    const aOld = mk('a', '2020-02-01T00:00:00Z'), aNew = mk('a', '2099-01-01T00:00:00Z'), bOld = mk('b', '2020-02-01T00:00:00Z');
    for (const r of [aOld, aNew, bOld]) await seed('homecollection.visit_locations', r);
    const n = await superTx((tx) => m.deleteExpiredLocations(tx, TENANT_A), TENANT_A);
    expect(Number(n)).toBeGreaterThanOrEqual(1);
    expect(await ownerRows('homecollection.visit_locations', 'id = $1', [aOld.id])).toHaveLength(0);
    expect(await ownerRows('homecollection.visit_locations', 'id = $1', [aNew.id])).toHaveLength(1);
    expect(await ownerRows('homecollection.visit_locations', 'id = $1', [bOld.id])).toHaveLength(1); // tenant B untouched
  });
  it('under RLS: a non-system actor deletes nothing (policy needs actor_type system); system claims delete the expired row', async () => {
    const m = await load('visitLocations');
    const r = hc.location('a', W.a.visit.id, W.a.mutation.id, { captured_at: '2020-01-01T00:00:00Z', expires_at: '2020-02-01T00:00:00Z' }); await seed('homecollection.visit_locations', r);
    expect(Number(await appTx(TENANT_A, (tx) => m.deleteExpiredLocations(tx, TENANT_A)))).toBeGreaterThanOrEqual(1); // appTx claims = system actor
    expect(await ownerRows('homecollection.visit_locations', 'id = $1', [r.id])).toHaveLength(0);
  });
});

describe('append-only tables stay append-only through the repos', () => {
  it('mutating a row through any repo export is impossible: no export names UPDATE/DELETE for transitions, assignments, mutations, sync_batches', async () => {
    for (const f of ['visitTransitions', 'visitAssignments', 'mutations', 'syncBatches'])
      expect(Object.keys(await load(f)).filter((k) => /^(update|delete|remove|purge|set)/i.test(k)), f).toEqual([]);
  });
});
