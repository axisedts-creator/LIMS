// T-09 (C3) — publish bundle: publishAnalyteVersion (#34) with reference_range_set_id / critical_limit_set_id publishes the analyte version, the range set and the
// critical set in ONE transaction, with one catalog.changed.v1 each, and writes formula_dependencies BEFORE the status UPDATE.
// Spec: 06-PLAN row T-09 (done_when: AC-03.5 enforced; three events; formula_dependencies inserted before the status UPDATE), 02-TRD §5.2 #34 (body), §7.2 step 6
//       (dependencies before UPDATE ... SET status = 'published'; tg_parent_is_draft), §9.1 (entity 'analyte' | 'reference_range' | 'critical_limit', change_kind 'versioned');
//       03-APP-FLOW §2.1 V4/V5; PRD AC-03.5, AC-03.6, AC-05.9; 07-SECURITY S-1, S-4, S-5, AB-9, AB-18.
// Real core createEvents + T-03 revision service over the SQL fake (helpers/testsDb.ts, extended with catalog.formula_dependencies). Services under test:
//   createAnalyteVersionsService (T-07; the writer extends publishAnalyteVersion) — no new service seam. The permission checks are the handler's (last describe).
// Assumptions the spec leaves open (see .orchestra/notes/C3.T-09-tests.md): a set id must name a DRAFT set of THIS analyte in this tenant and family
//   (unknown / other tenant / other family -> 404 common.not_found; another analyte's set -> 400; not a draft -> 409 catalog.version_in_use); the set's unit_code/method_id must equal
//   the version being published (400 at the set id's path); the sets get the bundle's effective_from + change_reason; each set publish runs T-08's publish rules.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { handlers } from '../../handlers/index.js';
import { TENANT_A, TENANT_B, USER } from '../helpers/catalogDb.js';
import { makeIdentity } from '../helpers/identity.js';
import { errPaths, events, lims, rejection } from '../helpers/t6.js';
import { cband, cset, rband, rset } from '../helpers/testsDb.js';
import { CBC, HB, HB_B, HB_V2, ID, M1, M2, MICRO, RBC, T, T1, ana, draftOf, ms, orderableRev, pBody, pubOf, setup7, versionsOf, type Env7 } from '../helpers/t7.js';

const A = TENANT_A;
const MANAGE = 'catalog.test.manage', PUBLISH = 'catalog.reference_range.publish', READ = 'catalog.test.read';
const draftSet = (mk: typeof rset, n: number, analyteId: string, o: Record<string, unknown> = {}) =>
  mk(n, A, analyteId, { version_no: 2, status: 'draft', effective_from: null, published_at: null, change_reason: null, ...o });

// ---- fixtures (synthetic). HB v1 = g_dl / M1 / 1 decimal, published since T0; its draft v2 changes unit AND method (mmol_l / M2).
const V2U = draftOf(2, HB.id, { unit_code: 'mmol_l', method_id: M2.id, decimals: 1 });            // ID(0x4002)
const RS1 = rset(1, A, HB.id, { unit_code: 'g_dl', method_id: M1.id });                           // published v1, ID(0x6001)
const RS1_B = rband(1, A, RS1.id, { low: '13.0', high: '17.0' });
const RS2 = draftSet(rset, 2, HB.id, { unit_code: 'mmol_l', method_id: M2.id });                  // draft v2 for the new unit/method, ID(0x6002)
const RS2_B = rband(2, A, RS2.id, { low: '8.1', high: '10.5' });
const CS1 = cset(1, A, HB.id, { unit_code: 'g_dl', method_id: M1.id });                           // ID(0x6801)
const CS1_B = cband(1, A, CS1.id, { low: '5.0', high: '20.0' });
const CS2 = draftSet(cset, 2, HB.id, { unit_code: 'mmol_l', method_id: M2.id });                  // ID(0x6802)
const CS2_B = cband(2, A, CS2.id, { low: '3.0', high: '12.0' });
const SETS = { reference_range_sets: [RS1, RS2], reference_ranges: [RS1_B, RS2_B], critical_limit_sets: [CS1, CS2], critical_limits: [CS1_B, CS2_B] };
const world = (extra: Record<string, any[]> = {}) => {
  const keys = new Set([...Object.keys(SETS), ...Object.keys(extra)]);
  const t6 = Object.fromEntries([...keys].map((k) => [k, [...((SETS as any)[k] ?? []), ...(extra[k] ?? [])]]));
  return setup7({ t6: { analyte_versions: [V2U], ...t6 } as never });
};
const VID = V2U.id as string;
const publish = (e: Env7, body: Record<string, unknown> = pBody(), id: string = VID, expectedVersion: unknown = 1, o: any = {}) =>
  e.db.run((ctx) => e.svc['publishAnalyteVersion']!(ctx, { id, expectedVersion, body }), o);
const full = (o: Record<string, unknown> = {}) => pBody({ effective_from: T1, reference_range_set_id: RS2.id, critical_limit_set_id: CS2.id, ...o });
const payloads = (db: Env7['db']) => events(db).map((e) => e.envelope.payload);
/** Everything a failed bundle must leave untouched. */
const snap = (db: Env7['db']) => JSON.stringify({
  a: db.rows('analytes'), v: db.rows('analyte_versions'), o: db.rows('orderables'), n: db.events.length, r: db.revisionOf(A), d: db.rows('formula_dependencies'),
  rs: db.rows('reference_range_sets'), rb: db.rows('reference_ranges'), cs: db.rows('critical_limit_sets'), cb: db.rows('critical_limits'),
});
const setRow = (e: Env7, table: 'reference_range_sets' | 'critical_limit_sets', id: unknown) => e.db.row(table, String(id))!;

describe('publish bundle (T-09) — analyte version + reference-range set + critical-limit set in ONE transaction', () => {
  it('AC-03.5: a unit AND method change with a draft reference-range set for the new unit/method publishes; the set is published with the bundle\'s window + reason, its predecessor superseded', { timeout: T }, async () => {
    const e = world();
    const out = await publish(e, pBody({ effective_from: T1, reference_range_set_id: RS2.id, change_reason: 'new analyser, new unit' }));
    expect(out).toMatchObject({ id: VID, status: 'published', unit_code: 'mmol_l', method_id: M2.id, effective_from: T1, version: 2 });
    expect(versionsOf(e.db, HB.id).map((r) => r['status'])).toEqual(['superseded', 'published']);
    expect(setRow(e, 'reference_range_sets', RS2.id)).toMatchObject({ status: 'published', change_reason: 'new analyser, new unit', published_by: USER, version: 2 });
    expect(ms(setRow(e, 'reference_range_sets', RS2.id)['effective_from'])).toBe(Date.parse(T1));
    expect(setRow(e, 'reference_range_sets', RS1.id)).toMatchObject({ status: 'superseded', version: 2 });
    expect(ms(setRow(e, 'reference_range_sets', RS1.id)['effective_to'])).toBe(Date.parse(T1));
    expect(setRow(e, 'critical_limit_sets', CS2.id)).toMatchObject({ status: 'draft', version: 1 });   // not named in the request -> untouched
    expect(setRow(e, 'critical_limit_sets', CS1.id).status).toBe('published');
    expect(payloads(e.db).map((p: any) => p.entity_type)).toEqual(expect.arrayContaining(['analyte', 'reference_range']));
    expect(events(e.db)).toHaveLength(2);
  });

  it('THREE events: one catalog.changed.v1 per entity (analyte, reference_range, critical_limit), each change_kind versioned with the bundle\'s effective_from; revisions 418, 419, 420', { timeout: T }, async () => {
    const e = world();
    await publish(e, full());
    const p = payloads(e.db) as any[];
    expect(p).toHaveLength(3);
    expect(Object.fromEntries(p.map((x) => [x.entity_type, x.entity_id]))).toEqual({ analyte: HB.id, reference_range: RS2.id, critical_limit: CS2.id });
    for (const x of p) expect(x).toMatchObject({ change_kind: 'versioned', effective_from: T1 });
    expect(p.map((x) => x.catalog_revision).sort()).toEqual([418, 419, 420]);
    expect(e.db.revisionOf(A)).toBe(420);
    expect(orderableRev(e.db, CBC.test.id)).toBe(420);                          // the owning test is stamped by each bump; the last wins
    expect(orderableRev(e.db, MICRO.test.id)).toBe(0);
    expect(setRow(e, 'critical_limit_sets', CS2.id)).toMatchObject({ status: 'published', change_reason: 'method change approved by the pathologist', version: 2 });
    expect(setRow(e, 'critical_limit_sets', CS1.id)).toMatchObject({ status: 'superseded' });
    expect(new Set(e.db.stmts.filter((s) => s.tenantId === A).map((s) => s.txId)).size).toBe(1);   // everything in one transaction
  });

  it('no set ids -> unchanged behaviour: ONE event, the sets are not touched', { timeout: T }, async () => {
    const e = world();
    await publish(e, pBody({ effective_from: T1, allow_without_ranges: true }));
    expect(events(e.db)).toHaveLength(1);
    expect(setRow(e, 'reference_range_sets', RS2.id).status).toBe('draft');
    expect(setRow(e, 'critical_limit_sets', CS2.id).status).toBe('draft');
  });

  it('a decimals-only change may carry a critical set alone (two events) — the set\'s unit/method equal the version\'s', { timeout: T }, async () => {
    const cs = draftSet(cset, 3, HB.id, { unit_code: 'g_dl', method_id: M1.id });
    const e = setup7({ t6: { analyte_versions: [HB_V2], critical_limit_sets: [CS1, cs], critical_limits: [CS1_B, cband(3, A, cs.id, { low: '5.0', high: '19.0' })] } });
    const out = await publish(e, pBody({ effective_from: T1, critical_limit_set_id: cs.id }), HB_V2.id);
    expect(out.status).toBe('published');
    expect(setRow(e, 'critical_limit_sets', cs.id).status).toBe('published');
    expect((payloads(e.db) as any[]).map((x) => x.entity_type).sort()).toEqual(['analyte', 'critical_limit']);
  });

  it('AC-03.5 still bites: a critical set alone does NOT satisfy the range requirement -> 400 /reference_range_set_id, nothing changes', { timeout: T }, async () => {
    const e = world(); const before = snap(e.db);
    const x = await rejection(publish(e, pBody({ effective_from: T1, critical_limit_set_id: CS2.id })));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/reference_range_set_id');
    expect(snap(e.db)).toBe(before);
  });

  it('AC-03.5 + allow_without_ranges: true with a set id attached: the set is still published', { timeout: T }, async () => {
    const e = world();
    await publish(e, pBody({ effective_from: T1, reference_range_set_id: RS2.id, allow_without_ranges: true }));
    expect(setRow(e, 'reference_range_sets', RS2.id).status).toBe('published');
  });

  it('AC-05.9: change_reason 500 chars is stored on the version AND both sets; 501 chars -> 400 /change_reason with nothing changed', { timeout: T }, async () => {
    const e = world(); const before = snap(e.db);
    const x = await rejection(publish(e, full({ change_reason: 'x'.repeat(501) })));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/change_reason');
    expect(snap(e.db)).toBe(before);
    await publish(e, full({ change_reason: 'y'.repeat(500) }));
    for (const [t, id] of [['reference_range_sets', RS2.id], ['critical_limit_sets', CS2.id]] as const) expect(String(setRow(e, t, id)['change_reason'])).toHaveLength(500);
    expect(String(e.db.row('analyte_versions', VID)!['change_reason'])).toHaveLength(500);
  });

  // ---- the attached sets must belong here, be drafts, and match the new unit / method
  it.each([
    ['reference_range_set_id', 'unit_code', { unit_code: 'g_dl' }, '/reference_range_set_id'],
    ['reference_range_set_id', 'method_id', { method_id: M1.id }, '/reference_range_set_id'],
    ['reference_range_set_id', 'method removed', { method_id: null }, '/reference_range_set_id'],
    ['critical_limit_set_id', 'unit_code', { unit_code: 'g_dl' }, '/critical_limit_set_id'],
    ['critical_limit_set_id', 'method_id', { method_id: M1.id }, '/critical_limit_set_id'],
  ] as const)('%s whose %s differs from the version being published -> 400 at that path; nothing changes (no half-published bundle)', { timeout: T }, async (key, _n, over, path) => {
    const bad = key === 'reference_range_set_id' ? draftSet(rset, 3, HB.id, over) : draftSet(cset, 3, HB.id, over);
    const kids = key === 'reference_range_set_id' ? { reference_range_sets: [bad], reference_ranges: [rband(3, A, bad.id, { low: '8.1', high: '10.5' })] }
      : { critical_limit_sets: [bad], critical_limits: [cband(3, A, bad.id, { low: '3.0', high: '12.0' })] };
    // the good set of the OTHER family is attached too: it must not be published when the bad one fails
    const body = key === 'reference_range_set_id' ? full({ reference_range_set_id: bad.id }) : full({ critical_limit_set_id: bad.id });
    const e = world(kids); const before = snap(e.db);
    const x = await rejection(publish(e, body));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('a set of ANOTHER analyte (RBC) -> 400 at the set id\'s path; nothing changes', { timeout: T }, async () => {
    const other = draftSet(rset, 4, RBC.id, { unit_code: 'mmol_l', method_id: M2.id });
    const e = world({ reference_range_sets: [other], reference_ranges: [rband(4, A, other.id, { low: '1.0', high: '2.0' })] }); const before = snap(e.db);
    const x = await rejection(publish(e, full({ reference_range_set_id: other.id })));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/reference_range_set_id');
    expect(snap(e.db)).toBe(before);
  });

  it.each([
    ['an id that does not exist', () => ID(0xdead)],
    ['a draft set of ANOTHER TENANT (S-1)', () => ID(0x6b01)],
    ['the critical set\'s id in the reference_range_set_id slot (other family)', () => CS2.id],
  ])('S-1/S-5: reference_range_set_id = %s -> 404 common.not_found, nothing changes (no existence oracle)', { timeout: T }, async (_n, pick) => {
    const foreign = rset(0xb01, TENANT_B, HB_B.id, { version_no: 2, status: 'draft', effective_from: null, published_at: null, change_reason: null, id: ID(0x6b01), unit_code: 'mmol_l', method_id: null });
    const e = world({ reference_range_sets: [foreign], reference_ranges: [rband(0xb01, TENANT_B, foreign.id, { low: '1.0', high: '2.0' })] }); const before = snap(e.db);
    lims(await rejection(publish(e, full({ reference_range_set_id: pick() }))), 'common.not_found', 404);
    expect(snap(e.db)).toBe(before);
  });

  it.each([
    ['published', () => RS1],
    ['discarded', () => draftSet(rset, 5, HB.id, { version_no: 5, status: 'discarded', unit_code: 'mmol_l', method_id: M2.id })],
  ])('a %s reference-range set cannot be attached -> 409 catalog.version_in_use (AB-9); nothing changes', { timeout: T }, async (_s, mk) => {
    const row = mk();
    const e = world(row.id === RS1.id ? {} : { reference_range_sets: [row] }); const before = snap(e.db);
    lims(await rejection(publish(e, full({ reference_range_set_id: row.id }))), 'catalog.version_in_use', 409);
    expect(snap(e.db)).toBe(before);
  });

  it('a draft set without bands, or with overlapping bands, fails the set\'s own publish rules (T-08) -> 400, the whole bundle rolls back', { timeout: T }, async () => {
    const empty = draftSet(rset, 6, HB.id, { unit_code: 'mmol_l', method_id: M2.id });
    const overlapped = draftSet(cset, 7, HB.id, { unit_code: 'mmol_l', method_id: M2.id });
    const e1 = world({ reference_range_sets: [empty] }); const b1 = snap(e1.db);
    const x1 = await rejection(publish(e1, full({ reference_range_set_id: empty.id })));
    lims(x1, 'common.validation_failed', 400); expect(snap(e1.db)).toBe(b1);
    const e2 = world({ critical_limit_sets: [overlapped], critical_limits: [cband(7, A, overlapped.id, { low: '1.0', high: '5.0' }), cband(8, A, overlapped.id, { low: '4.0', high: '9.0' })] });
    const b2 = snap(e2.db);
    const x2 = await rejection(publish(e2, full({ critical_limit_set_id: overlapped.id })));
    lims(x2, 'common.validation_failed', 400); expect(snap(e2.db)).toBe(b2);
  });

  it('V4 for the sets: a published set that starts after the bundle\'s effective_from -> 400 /effective_from, nothing changes', { timeout: T }, async () => {
    const late = rset(1, A, HB.id, { unit_code: 'g_dl', method_id: M1.id, effective_from: new Date('2026-12-15T00:00:00.000Z') });
    const e = setup7({ t6: { analyte_versions: [V2U], reference_range_sets: [late, RS2], reference_ranges: [RS1_B, RS2_B] } as never }); const before = snap(e.db);
    const x = await rejection(publish(e, pBody({ effective_from: T1, reference_range_set_id: RS2.id })));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_from');
    expect(snap(e.db)).toBe(before);
  });

  // ---- atomicity
  it.each([
    ['the analyte-version status UPDATE', /UPDATE catalog\.analyte_versions\b[^]*status/i],
    ['the reference-range set publish', /UPDATE catalog\.reference_range_sets\b[^]*status/i],
    ['the critical-limit set publish', /UPDATE catalog\.critical_limit_sets\b[^]*status/i],
    ['an event insert', /INSERT INTO core\.event_log/i],
  ])('atomic: a failure in %s rolls EVERYTHING back (version, both sets, predecessors, events, revision)', { timeout: T }, async (_n, match) => {
    const e = world(); const before = snap(e.db);
    e.db.fail(match);
    await rejection(publish(e, full()));
    expect(snap(e.db)).toBe(before);
    expect(e.db.revisionOf(A)).toBe(417); expect(e.db.events).toHaveLength(0);
  });

  it('atomic: a forced rollback after a successful bundle discards all three publishes and all three events', { timeout: T }, async () => {
    const e = world(); const before = snap(e.db);
    await rejection(publish(e, full(), VID, 1, { rollback: true }));
    expect(snap(e.db)).toBe(before);
  });

  it('race: two concurrent publishes of the same bundle -> exactly one wins; three events (not six), revision 420, sets published once', { timeout: T }, async () => {
    const e = world();
    const r = await Promise.allSettled([publish(e, full()), publish(e, full())]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(['catalog.version_in_use', 'common.version_conflict'].some((c) => isLimsError(lost.reason, c)), `got ${lost.reason?.code ?? lost.reason?.message}`).toBe(true);
    expect(events(e.db)).toHaveLength(3); expect(e.db.revisionOf(A)).toBe(420);
    expect(setRow(e, 'reference_range_sets', RS2.id)).toMatchObject({ status: 'published', version: 2 });
  });
});

// ============================================================================================================ formula_dependencies (02-TRD §7.2 step 6)
describe('publish writes formula_dependencies in the same transaction BEFORE the status UPDATE (§7.2 step 6; tg_parent_is_draft)', () => {
  const MCV = ana(21, A, CBC.test.id, { code: 'MCV', name: 'Mean cell volume' });
  const MENTZER = ana(22, A, CBC.test.id, { code: 'MENTZER', name: 'Mentzer index' });
  const MCV_V1 = pubOf(21, MCV.id, { unit_code: 'fl', decimals: 1, method_id: null });
  const F1 = draftOf(22, MENTZER.id, { version_no: 1, unit_code: null, method_id: null, decimals: 1, formula_expression: 'MCV / RBC' });   // ID(0x4016)
  const fworld = (extra: Record<string, any[]> = {}) => setup7({ t6: { analytes: [MCV, MENTZER, ...(extra['analytes'] ?? [])], analyte_versions: [MCV_V1, F1, ...(extra['analyte_versions'] ?? [])],
    ...(extra['formula_dependencies'] ? { formula_dependencies: extra['formula_dependencies'] } : {}) } as never });
  const deps = (db: Env7['db']) => db.rows('formula_dependencies').filter((r) => r['analyte_id'] === MENTZER.id);
  const FID = F1.id as string;
  const fpublish = (e: Env7, id = FID, b: Record<string, unknown> = pBody({ change_reason: 'initial release' })) => publish(e, b, id);

  it('MENTZER = MCV / RBC: one edge per input analyte, tenant-scoped, created_by = the actor, version published', { timeout: T }, async () => {
    const e = fworld();
    expect((await fpublish(e)).status).toBe('published');
    const rows = deps(e.db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['input_analyte_id']).sort()).toEqual([MCV.id, RBC.id].sort());
    for (const r of rows) expect(r).toMatchObject({ tenant_id: A, analyte_version_id: FID, analyte_id: MENTZER.id, created_by: USER });
  });

  it('every formula_dependencies INSERT is issued BEFORE the UPDATE that sets the version to published, all in one transaction (the DB trigger rejects it afterwards)', { timeout: T }, async () => {
    const e = fworld();
    await fpublish(e);
    const mine = e.db.stmts.filter((s) => s.tenantId === A);
    const ins = mine.map((s, i) => (/^\s*INSERT INTO\s+catalog\.formula_dependencies\b/i.test(s.text) ? i : -1)).filter((i) => i >= 0);
    const upd = mine.findIndex((s) => /^\s*UPDATE\s+catalog\.analyte_versions\b/i.test(s.text) && (/'published'/.test(s.text) || (s.values ?? []).includes('published')));
    expect(ins.length).toBeGreaterThanOrEqual(1);
    expect(upd).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ins)).toBeLessThan(upd);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);
  });

  it('a repeated input (MCV / RBC + MCV) gives one edge per DISTINCT analyte', { timeout: T }, async () => {
    const dup = draftOf(23, MENTZER.id, { version_no: 1, unit_code: null, method_id: null, decimals: 1, formula_expression: 'MCV / RBC + MCV' });
    const w = setup7({ t6: { analytes: [MCV, MENTZER], analyte_versions: [MCV_V1, dup] } as never });
    await publish(w, pBody({ change_reason: 'initial release' }), dup.id as string);
    expect(deps(w.db)).toHaveLength(2);
  });

  it('an analyte version without a formula writes no formula_dependencies statement at all', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    await publish(e, pBody(), HB_V2.id as string);
    expect(e.db.stmts.some((s) => /formula_dependencies/i.test(s.text))).toBe(false);
    expect(e.db.rows('formula_dependencies')).toHaveLength(0);
  });

  it('a NEW version of a formula analyte gets its own edges; the predecessor\'s edges stay (history)', { timeout: T }, async () => {
    const v1 = pubOf(22, MENTZER.id, { unit_code: null, method_id: null, decimals: 1, formula_expression: 'MCV / RBC' });
    const v2 = draftOf(23, MENTZER.id, { version_no: 2, unit_code: null, method_id: null, decimals: 1, formula_expression: 'MCV / RBC' });
    const old = [MCV, RBC].map((i) => ({ tenant_id: A, analyte_version_id: v1.id, analyte_id: MENTZER.id, input_analyte_id: i.id, created_by: USER }));
    const e = setup7({ t6: { analytes: [MCV, MENTZER], analyte_versions: [MCV_V1, v1, v2], formula_dependencies: old } as never });
    await publish(e, pBody({ change_reason: 'same formula, new release' }), v2.id as string);
    const rows = deps(e.db);
    expect(rows.filter((r) => r['analyte_version_id'] === v1.id)).toHaveLength(2);
    expect(rows.filter((r) => r['analyte_version_id'] === v2.id)).toHaveLength(2);
  });

  it('atomic: a failure after the edges were written (the status UPDATE, or the event insert) leaves NO edge behind and the version a draft', { timeout: T }, async () => {
    for (const match of [/UPDATE catalog\.analyte_versions\b[^]*status/i, /INSERT INTO core\.event_log/i]) {
      const e = fworld(); const before = snap(e.db);
      e.db.fail(match);
      await rejection(fpublish(e));
      expect(snap(e.db)).toBe(before);
      expect(e.db.rows('formula_dependencies')).toHaveLength(0);
      expect(e.db.row('analyte_versions', FID)!['status']).toBe('draft');
    }
  });

  it('the fake enforces the trigger the ordering rule exists for: an edge for an already-published version is rejected (P0001 immutable_row)', { timeout: T }, async () => {
    const e = fworld();
    await fpublish(e);
    const x = await rejection(e.db.run((ctx: any) => ctx.tx.query(
      'INSERT INTO catalog.formula_dependencies (tenant_id, analyte_version_id, analyte_id, input_analyte_id, created_by) VALUES ($1, $2, $3, $4, $5)', [A, FID, MENTZER.id, HB.id, USER])));
    expect(x.code).toBe('P0001');
  });
});

// ============================================================================================================ handler: AC-03.6 / AC-05.9 on the bundle
describe('AC-03.6 / AC-05.9 through the handler: the bundle needs catalog.reference_range.publish (aal2) AND catalog.test.manage; the privileged check precedes everything', () => {
  const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;
  const bundleReq = () => ({ params: { analyte_version_id: VID }, query: {}, headers: { 'if-match': '"1"', 'idempotency-key': 'k-9' }, body: full() });
  const call = (e: Env7, grants: readonly string[], aal: 1 | 2) => {
    const identity = makeIdentity(grants, aal);
    return e.db.run((ctx) => H['publishAnalyteVersion']!(bundleReq(), { ...ctx, ports: { IdentityPort: identity } }));
  };

  it('both permissions at aal2 -> 200 with the published AnalyteVersion; three events', { timeout: T }, async () => {
    const e = world();
    const out = await call(e, [MANAGE, PUBLISH], 2);
    expect(out.status).toBe(200); expect(out.body).toMatchObject({ id: VID, status: 'published' });
    expect(events(e.db)).toHaveLength(3);
  });

  it.each([
    ['lab_manager at aal1 (both permissions)', [MANAGE, PUBLISH], 1, 'auth.mfa_required'],
    ['ONLY catalog.test.manage (aal2)', [MANAGE], 2, 'auth.forbidden'],
    ['a pathologist: ONLY catalog.reference_range.publish (aal2)', [PUBLISH], 2, 'auth.forbidden'],
    ['read-only', [READ], 2, 'auth.forbidden'],
  ] as const)('%s -> 403 %s with set ids in the body; no data access, no set published, no event', { timeout: T }, async (_n, grants, aal, code) => {
    const e = world(); const before = snap(e.db);
    const x = await rejection(call(e, grants, aal));
    expect(isLimsError(x, code), `got ${x?.code}`).toBe(true); expect(x.statusCode).toBe(403);
    expect(snap(e.db)).toBe(before);
    expect(e.db.stmts.filter((s) => s.tenantId === A)).toHaveLength(0);
  });
});
