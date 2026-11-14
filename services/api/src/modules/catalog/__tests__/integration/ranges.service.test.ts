// T-08 (C3) — reference-range sets (#37–#43) and critical-limit sets (#44–#50): list / create draft / get / replace bands / publish / retire / discard.
// Spec: 06-PLAN row T-08 (done_when: overlap validation; unit/method snapshot; publish/retire need catalog.reference_range.publish [handler level, see ranges.handlers.test.ts];
//       V4 guard includes retired siblings; age unknown matches only age-unrestricted bands [domain/__tests__/rangeMatch.test.ts]), 02-TRD §3, §5.2 #37–#50, §7.3 step 6, §9.1;
//       03-APP-FLOW §2.1 V1–V6 + note on scheduled versions; PRD AC-05.1/05.7/05.8/05.9/05.10 (the data side), AC-06.4; 05-SCHEMA (sets, bands, §10.2 triggers);
//       07-SECURITY S-1, S-5, S-6, AB-8, AB-9, AB-18, AB-20.
// Real core createEvents({producer:'catalog'}) and T-03's real revision service over the SQL fake in helpers/testsDb.ts (RLS, row locks, UNIQUE/CHECK/FK, set triggers, the
// parent-is-draft band trigger, READ COMMITTED). Every behaviour is asserted for BOTH families (describe.each: reference ranges and critical limits — AC-06.4 "same rules").
// Interface: see helpers/t8.ts (SEAM header). Authoring notes (assumptions, gaps): .orchestra/notes/C3.T-08-tests.md.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { ISO_UTC, errPaths, events, lims, rejection, validation400 } from '../helpers/t6.js';
import {
  DAY, FAMILIES, HB, HB_V2_UNIT, ID, M1, M2, MICRO, NIT, NOW, REF, SEC, T, T0, T1, URINE, URINE_B, at, bandsOf, draftSet, ownerRev, pBody, rBody, setsOf, setup8,
  type Env8, type Family, type Row,
} from '../helpers/t8.js';

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const run = (e: Env8, f: Family, name: keyof Family, input: unknown, o: any = {}) => e.db.run((ctx) => e.svc[f[name] as string]!(ctx, input), o);
const list = (e: Env8, f: Family, analyte_id: string, status?: string, o: any = {}) => run(e, f, 'list', { analyte_id, status }, o);
const create = (e: Env8, f: Family, analyte_id: string, body?: unknown, o: any = {}) => run(e, f, 'create', { analyte_id, body }, o);
const get = (e: Env8, f: Family, id: string, o: any = {}) => run(e, f, 'get', { id }, o);
const ABSENT = 'absent';                                                    // sentinel = no If-Match (an `undefined` argument would just trigger the default of 1)
const ev = (v: unknown) => (v === ABSENT ? undefined : v);
const replace = (e: Env8, f: Family, id: string, bands: unknown, expectedVersion: unknown = 1, o: any = {}) => run(e, f, 'replace', { id, expectedVersion: ev(expectedVersion), body: { bands } }, o);
const publish = (e: Env8, f: Family, id: string, body: unknown = pBody(), expectedVersion: unknown = 1, o: any = {}) => run(e, f, 'publish', { id, expectedVersion: ev(expectedVersion), body }, o);
const retire = (e: Env8, f: Family, id: string, body: unknown = rBody(), expectedVersion: unknown = 1, o: any = {}) => run(e, f, 'retire', { id, expectedVersion: ev(expectedVersion), body }, o);
const discard = (e: Env8, f: Family, id: string, expectedVersion: unknown = 1, o: any = {}) => run(e, f, 'discard', { id, expectedVersion: ev(expectedVersion) }, o);
const notFound = (x: any) => lims(x, 'common.not_found', 404);
const inUse = (x: any) => lims(x, 'catalog.version_in_use', 409);
const conflict = (x: any) => lims(x, 'common.version_conflict', 409);
const ms = (v: unknown) => new Date(v as string).getTime();

/** Everything a failed call must leave untouched. */
const snap = (db: Env8['db']) => JSON.stringify({ rs: db.rows('reference_range_sets'), r: db.rows('reference_ranges'), cs: db.rows('critical_limit_sets'), c: db.rows('critical_limits'),
  o: db.rows('orderables'), n: db.events.length, rev: db.revisionOf(TENANT_A) });
const only = (db: Env8['db']) => events(db).map((e) => e.envelope.payload);

// ---- fixtures: HB (numeric g_dl, method M1, 1 decimal, v1 published since T0). P1 = published set v1 (+1 band); D2 = draft set v2 (bands as given)
const P1 = (f: Family, o: Row = {}) => f.mkSet(1, TENANT_A, HB.id, { method_id: M1.id, ...o });
const D2 = (f: Family, o: Row = {}) => draftSet(f.mkSet, 2, HB.id, { method_id: M1.id, ...o });
const SY = { age_low_value: 18, age_low_unit: 'year' }, SC = { age_high_value: 18, age_high_unit: 'year' };
const pBand = (f: Family, n = 1, o: Row = {}) => f.mkBand(n, TENANT_A, P1(f).id, { sex: 'any', low: '13.0', high: '17.0', sort_order: 0, ...o });
const dBand = (f: Family, n: number, o: Row = {}) => f.mkBand(n, TENANT_A, D2(f).id, { sex: 'any', low: '13.0', high: '17.0', sort_order: n, ...o });
/** Draft D2 with the given bands (default: two non-overlapping bands) and, optionally, the published predecessor P1. */
const world = (f: Family, o: { bands?: Row[]; pred?: boolean | Row; draft?: Row; extraSets?: Row[]; extraBands?: Row[]; t6?: Record<string, Row[]> } = {}) => {
  const bands = o.bands ?? [dBand(f, 11, { sex: 'male', ...SY, sort_order: 0 }), dBand(f, 12, { sex: 'any', ...SC, sort_order: 1 })];
  const pred = o.pred === false ? [] : [P1(f, typeof o.pred === 'object' ? o.pred : {})];
  return setup8({ t6: { [f.setTable]: [...pred, D2(f, o.draft), ...(o.extraSets ?? [])], [f.bandTable]: [...(o.pred === false ? [] : [pBand(f)]), ...bands, ...(o.extraBands ?? [])], ...o.t6 } as never });
};
/** Only the published predecessor. */
const pubOnly = (f: Family, set: Row = {}, bands: Row[] = [pBand(f)]) => setup8({ t6: { [f.setTable]: [P1(f, set)], [f.bandTable]: bands } as never });

describe.each(FAMILIES)('$name sets — list / get (#37 #39 / #44 #46)', (f) => {
  it('list: newest first (version_no DESC), each set with its bands in sort order; DTO has no internal columns and no null fields', { timeout: T }, async () => {
    const e = world(f);
    const out = await list(e, f, HB.id);
    expect(out.data.map((s: any) => s.version_no)).toEqual([2, 1]);
    expect(out.data[0]).toMatchObject({ id: D2(f).id, analyte_id: HB.id, status: 'draft', unit_code: 'g_dl', method_id: M1.id, version: 1 });
    expect(out.data[0].bands).toHaveLength(2);
    expect(out.data[0].bands[0]).toMatchObject({ sex: 'male', age_low: { value: 18, unit: 'year' }, low: '13.0', high: '17.0' });
    expect(out.data[0].bands[1]).toMatchObject({ sex: 'any', age_high: { value: 18, unit: 'year' } });
    expect(out.data[1]).toMatchObject({ id: P1(f).id, status: 'published', change_reason: 'initial' });
    expect(out.data[1].effective_from).toMatch(ISO_UTC);
    for (const s of out.data) {
      for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'published_by', 'published_at', 'source_import_id', 'is_active']) expect(s, k).not.toHaveProperty(k);
      for (const k of Object.keys(s)) expect(s[k], k).not.toBeNull();
      for (const b of s.bands) { for (const k of ['id', 'set_id', 'tenant_id', 'created_by']) expect(b, k).not.toHaveProperty(k); for (const k of Object.keys(b)) expect(b[k], k).not.toBeNull(); }
    }
  });

  it('list: ?status filters; a draft has no effective_from / change_reason keys', { timeout: T }, async () => {
    const e = world(f);
    expect((await list(e, f, HB.id, 'published')).data.map((s: any) => s.version_no)).toEqual([1]);
    const d = (await list(e, f, HB.id, 'draft')).data;
    expect(d).toHaveLength(1);
    for (const k of ['effective_from', 'effective_to', 'change_reason']) expect(d[0], k).not.toHaveProperty(k);
    expect((await list(e, f, HB.id, 'retired')).data).toEqual([]);
  });

  it('list: an invalid status filter -> 400; an unknown analyte / another tenant\'s analyte -> 404; a malformed id -> 400', { timeout: T }, async () => {
    const e = world(f);
    validation400(await rejection(list(e, f, HB.id, 'bogus')));
    notFound(await rejection(list(e, f, ID(0xdead))));
    notFound(await rejection(list(e, f, ID(0x3003))));                       // HB_B belongs to tenant B
    validation400(await rejection(list(e, f, 'not-a-uuid')));
  });

  it('list: another tenant\'s sets never appear (RLS + explicit tenant predicate)', { timeout: T }, async () => {
    const e = world(f, { extraSets: [f.mkSet(90, TENANT_B, ID(0x3003), { method_id: null })] });
    expect((await list(e, f, HB.id)).data.every((s: any) => s.analyte_id === HB.id)).toBe(true);
    expect((await list(e, f, ID(0x3003), undefined, { tenantId: TENANT_B })).data.map((s: any) => s.id)).toEqual([ID(0x6000 + 90 + (f.setTable === 'critical_limit_sets' ? 0x800 : 0))]);
  });

  it('get: the set with its bands; 404 for unknown and for another tenant\'s id; 400 for a malformed id', { timeout: T }, async () => {
    const e = world(f, { extraSets: [f.mkSet(90, TENANT_B, ID(0x3003), { method_id: null })] });
    expect(await get(e, f, P1(f).id)).toMatchObject({ id: P1(f).id, version_no: 1, status: 'published', bands: [{ sex: 'any', low: '13.0', high: '17.0' }] });
    notFound(await rejection(get(e, f, ID(0x6000 + 90 + (f.setTable === 'critical_limit_sets' ? 0x800 : 0)))));
    notFound(await rejection(get(e, f, ID(0xdead))));
    validation400(await rejection(get(e, f, 'x')));
  });

  it.runIf(f === REF)('get: AC-05.5 / AC-05.6 shapes round-trip — text and ordinal bands keep display_text and the code list', { timeout: T }, async () => {
    const e = pubOnly(f, {}, [pBand(f, 1, { kind: 'text', low: undefined, high: undefined, display_text: '<13.0 - Thalassemia trait / >13.0 - Iron deficiency', sort_order: 0 }),
      pBand(f, 2, { kind: 'ordinal', low: undefined, high: undefined, normal_codes: ['NEG'], display_text: 'Negative', sort_order: 1, sex: 'male' })]);
    const out = await get(e, f, P1(f).id);
    expect(out.bands[0]).toMatchObject({ kind: 'text', display_text: '<13.0 - Thalassemia trait / >13.0 - Iron deficiency' });
    expect(out.bands[0]).not.toHaveProperty('low');
    expect(out.bands[1]).toMatchObject({ kind: 'ordinal', normal_codes: ['NEG'], display_text: 'Negative' });
  });
});

describe.each(FAMILIES)('$name sets — create draft (#38 / #45): V1', (f) => {
  it('201: draft version_no 1 for an analyte without sets, bands [], snapshot = the current published analyte version (unit g_dl, method M1); version 1; nothing bumped, no event', { timeout: T }, async () => {
    const e = setup8(); const rev = e.db.revisionOf(TENANT_A);
    const out = await create(e, f, HB.id);
    expect(out).toMatchObject({ analyte_id: HB.id, version_no: 1, status: 'draft', unit_code: 'g_dl', method_id: M1.id, bands: [], version: 1 });
    expect(out.id).toMatch(UUIDV7);
    for (const k of ['effective_from', 'effective_to', 'change_reason', 'tenant_id', 'created_by']) expect(out, k).not.toHaveProperty(k);
    expect(e.db.row(f.setTable, out.id)).toMatchObject({ tenant_id: TENANT_A, status: 'draft', created_by: USER, effective_from: null, published_at: null, published_by: null });
    expect(events(e.db)).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(rev); expect(ownerRev(e.db)).toBe(0);
  });

  it('the unit / method snapshot comes from the analyte\'s open DRAFT version when there is one (unit mmol_l, method M2), else from the published one', { timeout: T }, async () => {
    const e = setup8({ t6: { analyte_versions: [HB_V2_UNIT] } });
    expect(await create(e, f, HB.id)).toMatchObject({ unit_code: 'mmol_l', method_id: M2.id });
    const k = await create(setup8(), f, ID(0x3005));                         // K: mmol_l, no method
    expect(k).toMatchObject({ unit_code: 'mmol_l' }); expect(k).not.toHaveProperty('method_id');
    const nit = await create(setup8(), f, NIT.id);                           // NIT: no unit, no method
    expect(nit).not.toHaveProperty('unit_code'); expect(nit).not.toHaveProperty('method_id');
  });

  it('with bands: stored in the given order (sort_order), values verbatim (scale preserved), specimen type kept; the response lists them', { timeout: T }, async () => {
    const e = setup8();
    const bands = [f.band({ sex: 'male', age_low: { value: 18, unit: 'year' }, low: '13.0', high: '17.0', sort_order: 0 }), f.band({ sex: 'any', age_high: { value: 18, unit: 'year' }, low: '11.50', high: '16.0', sort_order: 1 }),
      f.band({ sex: 'female', specimen_type_id: URINE.id, low: '1.0', high: '2.0', sort_order: 2 })].map(clean);
    const out = await create(e, f, HB.id, { bands });
    expect(out.bands).toHaveLength(3);
    expect(out.bands[0]).toMatchObject({ sex: 'male', age_low: { value: 18, unit: 'year' }, low: '13.0', high: '17.0' });
    expect(out.bands[1]).toMatchObject({ low: '11.50', high: '16.0', age_high: { value: 18, unit: 'year' } });
    expect(out.bands[2]).toMatchObject({ sex: 'female', specimen_type_id: URINE.id });
    const rows = bandsOf(e.db, f, out.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['sort_order'])).toEqual([0, 1, 2]);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, set_id: out.id, sex: 'male', age_low_value: 18, age_low_unit: 'year', age_high_value: null, low: '13.0', high: '17.0', created_by: USER });
    expect(rows[1]).toMatchObject({ low: '11.50' });
    expect(new Set(rows.map((r) => r['id'])).size).toBe(3);
  });

  it('version_no = max + 1 over ALL statuses (a discarded or retired set still counts)', { timeout: T }, async () => {
    const e = setup8({ t6: { [f.setTable]: [P1(f, { status: 'retired', effective_to: new Date(T1) }), f.mkSet(2, TENANT_A, HB.id, { version_no: 2, status: 'discarded', effective_from: null, published_at: null, change_reason: null })] } as never });
    expect((await create(e, f, HB.id)).version_no).toBe(3);
  });

  it('copy_from_set_id copies the source bands (new band ids, same content) into the draft; the source is untouched', { timeout: T }, async () => {
    const e = pubOnly(f, {}, [pBand(f, 1, { sex: 'male', ...SY }), pBand(f, 2, { sex: 'any', ...SC, low: '11.0', high: '16.0', sort_order: 1 })]);
    const before = bandsOf(e.db, f, P1(f).id);
    const out = await create(e, f, HB.id, { copy_from_set_id: P1(f).id });
    expect(out.bands).toHaveLength(2);
    expect(out.bands[0]).toMatchObject({ sex: 'male', age_low: { value: 18, unit: 'year' }, low: '13.0', high: '17.0' });
    const copy = bandsOf(e.db, f, out.id);
    expect(copy.map((r) => r['id'])).not.toEqual(before.map((r) => r['id']));
    expect(copy.map((r) => r['id'])).not.toContain(before[0]!['id']);
    expect(bandsOf(e.db, f, P1(f).id)).toEqual(before);
  });

  it('no bands and no copy_from_set_id -> copies the latest published set (03-APP-FLOW §2.1 V1): new band ids, same content; no published set -> empty draft', { timeout: T }, async () => {
    const e = pubOnly(f, {}, [pBand(f, 1, { sex: 'male', ...SY }), pBand(f, 2, { sex: 'any', ...SC, low: '11.0', high: '16.0', sort_order: 1 })]);
    const before = bandsOf(e.db, f, P1(f).id);
    const out = await create(e, f, HB.id);
    expect(out.bands).toHaveLength(2);
    expect(out.bands[0]).toMatchObject({ sex: 'male', age_low: { value: 18, unit: 'year' }, low: '13.0', high: '17.0' });
    expect(out.bands[1]).toMatchObject({ sex: 'any', age_high: { value: 18, unit: 'year' }, low: '11.0', high: '16.0' });
    const copy = bandsOf(e.db, f, out.id);
    expect(copy).toHaveLength(2);
    for (const r of copy) expect(before.map((b) => b['id'])).not.toContain(r['id']);
    expect(bandsOf(e.db, f, P1(f).id)).toEqual(before);
    const none = setup8({ t6: { [f.setTable]: [P1(f, { status: 'retired', effective_to: new Date(T1) })], [f.bandTable]: [pBand(f)] } as never });
    expect((await create(none, f, HB.id)).bands).toHaveLength(0);
  });

  it('copy_from_set_id of an unknown set or another tenant\'s set -> 404; nothing written', { timeout: T }, async () => {
    const e = setup8({ t6: { [f.setTable]: [P1(f), f.mkSet(90, TENANT_B, ID(0x3003), { method_id: null })] } as never });
    const before = snap(e.db);
    for (const id of [ID(0xdead), ID(0x6000 + 90 + (f.setTable === 'critical_limit_sets' ? 0x800 : 0))]) notFound(await rejection(create(e, f, HB.id, { copy_from_set_id: id })));
    expect(snap(e.db)).toBe(before);
  });

  it('a second draft for the same analyte -> 409 common.version_conflict (partial unique index); the first is untouched', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    conflict(await rejection(create(e, f, HB.id)));
    expect(snap(e.db)).toBe(before);
  });

  it('two concurrent creates: exactly one 201, the other 409 common.version_conflict; exactly one draft row', { timeout: T }, async () => {
    const e = setup8();
    const r = await Promise.allSettled([create(e, f, HB.id), create(e, f, HB.id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    conflict((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason);
    expect(setsOf(e.db, f, HB.id).filter((s) => s['status'] === 'draft')).toHaveLength(1);
  });

  it('unknown analyte / another tenant\'s analyte -> 404; malformed id -> 400; nothing written', { timeout: T }, async () => {
    const e = setup8(); const before = snap(e.db);
    notFound(await rejection(create(e, f, ID(0xdead)))); notFound(await rejection(create(e, f, ID(0x3003))));
    validation400(await rejection(create(e, f, 'nope')));
    expect(snap(e.db)).toBe(before);
  });

  it.each(f.bad)('an invalid band (%s) -> 400 and nothing written', { timeout: T }, async (_n, patch) => {
    const e = setup8(); const before = snap(e.db);
    validation400(await rejection(create(e, f, HB.id, { bands: [clean(f.band(patch))] })));
    expect(snap(e.db)).toBe(before);
  });

  it('a band naming another tenant\'s specimen type -> 404 (composite FK backstop), nothing written (AB-3 style)', { timeout: T }, async () => {
    const e = setup8(); const before = snap(e.db);
    notFound(await rejection(create(e, f, HB.id, { bands: [clean(f.band({ specimen_type_id: URINE_B.id }))] })));
    expect(snap(e.db)).toBe(before);
  });

  it.each([[null], ['x'], [7], [[]], [{ bands: 'x' }], [{ bands: [] , copy_from_set_id: 1 }], [{ bands: Array.from({ length: 101 }, () => ({ sex: 'any', low: '1', high: '2' })) }], [{ status: 'published' }],
    [{ tenant_id: TENANT_B }], [{ version_no: 9 }], [{ unit_code: 'x' }], [{ effective_from: T0 }]])('a bad body (%j) -> 400', { timeout: T }, async (b) => {
    const e = setup8(); const before = snap(e.db);
    validation400(await rejection(create(e, f, HB.id, b)));
    expect(snap(e.db)).toBe(before);
  });

  it('a rolled-back transaction leaves no set and no bands', { timeout: T }, async () => {
    const e = setup8(); const before = snap(e.db);
    await rejection(create(e, f, HB.id, { bands: [clean(f.band())] }, { rollback: true }));
    expect(snap(e.db)).toBe(before);
    const x = setup8(); x.db.fail(new RegExp(`INSERT INTO catalog\\.${f.bandTable}`, 'i'));
    const b2 = snap(x.db); await rejection(create(x, f, HB.id, { bands: [clean(f.band())] }));
    expect(snap(x.db)).toBe(b2);                                              // the set insert is rolled back with the failing band insert
  });
});

describe.each(FAMILIES)('$name sets — replace bands (#40 / #47): V2', (f) => {
  it('200: replaces ALL bands of the draft; set version +1; bands in the new order; the old rows are gone; no event, no bump (draft write)', { timeout: T }, async () => {
    const e = world(f); const rev = e.db.revisionOf(TENANT_A);
    const out = await replace(e, f, D2(f).id, [f.band({ sex: 'female', low: '12.0', high: '15.0', sort_order: 0 }), f.band({ sex: 'male', low: '13.0', high: '17.0', sort_order: 1 })].map(clean));
    expect(out).toMatchObject({ id: D2(f).id, status: 'draft', version: 2 });
    expect(out.bands.map((b: any) => b.sex)).toEqual(['female', 'male']);
    const rows = bandsOf(e.db, f, D2(f).id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['id'])).not.toContain(ID((f.bandTable === 'reference_ranges' ? 0x7000 : 0x7800) + 11));
    expect(bandsOf(e.db, f, P1(f).id)).toHaveLength(1);                       // the published set's band is untouched
    expect(events(e.db)).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(rev); expect(ownerRev(e.db)).toBe(0);
  });

  it('a draft may hold overlapping bands (overlap is a PUBLISH rule, AC-05.7)', { timeout: T }, async () => {
    const e = world(f);
    const out = await replace(e, f, D2(f).id, [f.band({ sort_order: 0 }), f.band({ sort_order: 1, low: '1.0', high: '2.0' })].map(clean));
    expect(out.bands).toHaveLength(2);
  });

  it('a stale If-Match -> 409 common.version_conflict; a missing one -> 428; the old bands stay', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    conflict(await rejection(replace(e, f, D2(f).id, [clean(f.band())], 7)));
    lims(await rejection(replace(e, f, D2(f).id, [clean(f.band())], ABSENT)), 'common.precondition_required', 428);
    expect(snap(e.db)).toBe(before);
  });

  it.each(['published', 'superseded', 'retired', 'discarded'])('a %s set -> 409 catalog.version_in_use (state outranks If-Match); bands unchanged', { timeout: T }, async (status) => {
    const e = setup8({ t6: { [f.setTable]: [P1(f, { status })], [f.bandTable]: [pBand(f)] } as never }); const before = snap(e.db);
    inUse(await rejection(replace(e, f, P1(f).id, [clean(f.band())])));
    inUse(await rejection(replace(e, f, P1(f).id, [clean(f.band())], 99)));
    expect(snap(e.db)).toBe(before);
  });

  it('unknown set / another tenant\'s set -> 404; malformed id -> 400', { timeout: T }, async () => {
    const e = world(f, { extraSets: [f.mkSet(90, TENANT_B, ID(0x3003), { status: 'draft', method_id: null, effective_from: null, published_at: null, change_reason: null })] });
    const before = snap(e.db);
    notFound(await rejection(replace(e, f, ID(0xdead), [clean(f.band())])));
    notFound(await rejection(replace(e, f, ID(0x6000 + 90 + (f.setTable === 'critical_limit_sets' ? 0x800 : 0)), [clean(f.band())])));
    validation400(await rejection(replace(e, f, 'x', [clean(f.band())])));
    expect(snap(e.db)).toBe(before);
  });

  it.each([[[]], [undefined], [null], ['x'], [Array.from({ length: 101 }, (_, i) => ({ sex: 'any', low: '1', high: '2', sort_order: i }))]])('bands %#: 0 / missing / non-array / 101 bands -> 400 (1–100 required)', { timeout: T }, async (bands) => {
    const e = world(f); const before = snap(e.db);
    validation400(await rejection(replace(e, f, D2(f).id, bands)));
    expect(snap(e.db)).toBe(before);
  });

  it('exactly 100 bands are accepted', { timeout: T }, async () => {
    const e = world(f);
    const out = await replace(e, f, D2(f).id, Array.from({ length: 100 }, (_, i) => clean(f.band({ sort_order: i }))));
    expect(out.bands).toHaveLength(100);
  });

  it.each(f.bad)('an invalid band (%s) -> 400, the draft keeps its old bands', { timeout: T }, async (_n, patch) => {
    const e = world(f); const before = snap(e.db);
    validation400(await rejection(replace(e, f, D2(f).id, [clean(f.band()), clean(f.band(patch))])));
    expect(snap(e.db)).toBe(before);
  });

  it('a band naming another tenant\'s specimen type -> 404 and the old bands survive (delete + insert are one transaction)', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    notFound(await rejection(replace(e, f, D2(f).id, [clean(f.band({ specimen_type_id: URINE_B.id }))])));
    expect(snap(e.db)).toBe(before);
  });

  it('a failure while inserting the new bands rolls the whole replace back (old bands survive, version unchanged)', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    e.db.fail(new RegExp(`INSERT INTO catalog\\.${f.bandTable}`, 'i'));
    await rejection(replace(e, f, D2(f).id, [clean(f.band())]));
    expect(snap(e.db)).toBe(before);
  });

  it('body with extra keys (status, tenant_id, version_no, effective_from) -> 400', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    for (const extra of [{ status: 'published' }, { tenant_id: TENANT_B }, { version_no: 5 }, { effective_from: T0 }]) {
      validation400(await rejection(run(e, f, 'replace', { id: D2(f).id, expectedVersion: 1, body: { bands: [clean(f.band())], ...extra } })));
    }
    expect(snap(e.db)).toBe(before);
  });
});

describe.each(FAMILIES)('$name sets — publish (#41 / #48): V4 + V5', (f) => {
  it('200: draft -> published; effective_from defaults to now; change_reason, published_by recorded; version +1; bands untouched; predecessor superseded with effective_to = the new effective_from (V5)', { timeout: T }, async () => {
    const e = world(f);
    const bandsBefore = bandsOf(e.db, f, D2(f).id);
    const out = await publish(e, f, D2(f).id);
    expect(out).toMatchObject({ id: D2(f).id, analyte_id: HB.id, version_no: 2, status: 'published', change_reason: 'ranges reviewed by the pathologist', effective_from: NOW, unit_code: 'g_dl', method_id: M1.id, version: 2 });
    expect(out).not.toHaveProperty('effective_to');
    expect(out.bands).toHaveLength(2);
    expect(e.db.row(f.setTable, D2(f).id)).toMatchObject({ status: 'published', published_by: USER, updated_by: USER });
    expect(ms(e.db.row(f.setTable, D2(f).id)!['published_at'])).toBe(ms(NOW));
    expect(bandsOf(e.db, f, D2(f).id)).toEqual(bandsBefore);
    const pred = e.db.row(f.setTable, P1(f).id)!;
    expect(pred).toMatchObject({ status: 'superseded', version: 2 });
    expect(ms(pred['effective_to'])).toBe(ms(NOW));
    expect(bandsOf(e.db, f, P1(f).id)).toHaveLength(1);
  });

  it('publishes catalog.changed.v1 {entity_type, entity_id = the SET id, change_kind versioned, effective_from = the set\'s} in the SAME tx, once; stamps the owning test\'s orderable only', { timeout: T }, async () => {
    const e = world(f);
    await publish(e, f, D2(f).id);
    expect(only(e.db)).toHaveLength(1);
    expect(only(e.db)[0]).toMatchObject({ catalog_revision: 418, entity_type: f.entity, entity_id: D2(f).id, change_kind: 'versioned', effective_from: NOW });
    expect(e.db.revisionOf(TENANT_A)).toBe(418);
    expect(ownerRev(e.db)).toBe(418);
    expect(e.db.orderableRevision(MICRO.test.id)).toBe(0);
    const mine = e.db.stmts.filter((s) => s.tenantId === TENANT_A);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);
  });

  it('a scheduled (future) effective_from is allowed: predecessor ends at it (still effective until then), event effective_from = it', { timeout: T }, async () => {
    const e = world(f);
    const out = await publish(e, f, D2(f).id, pBody({ effective_from: T1 }));
    expect(out.effective_from).toBe(T1);
    expect(ms(e.db.row(f.setTable, P1(f).id)!['effective_to'])).toBe(ms(T1));
    expect(e.db.row(f.setTable, P1(f).id)!['status']).toBe('superseded');
    expect(only(e.db)[0]).toMatchObject({ effective_from: T1 });
  });

  it('the first set of an analyte (no predecessor) publishes without touching other sets', { timeout: T }, async () => {
    const e = world(f, { pred: false });
    const out = await publish(e, f, D2(f).id);
    expect(out.status).toBe('published');
    expect(e.db.rows(f.setTable)).toHaveLength(1);
  });

  it('AC-05.7: two bands of equal (sex, specimen) that overlap in age -> 400 common.validation_failed listing BOTH band indexes; no partial publish', { timeout: T }, async () => {
    const e = world(f, { bands: [dBand(f, 11, { sex: 'male', age_low_value: 0, age_low_unit: 'day', age_high_value: 10, age_high_unit: 'year', sort_order: 0 }),
      dBand(f, 12, { sex: 'male', ...SY, sort_order: 1 }), dBand(f, 13, { sex: 'male', age_low_value: 5, age_low_unit: 'year', age_high_value: 20, age_high_unit: 'year', sort_order: 2 })] });
    const before = snap(e.db);
    const x = await rejection(publish(e, f, D2(f).id));
    lims(x, 'common.validation_failed', 400);
    const paths = errPaths(x).join(' ');
    expect(paths).toMatch(/bands\/0/); expect(paths).toMatch(/bands\/2/); expect(paths).toMatch(/bands\/1/);
    expect(snap(e.db)).toBe(before);                                          // still a draft, predecessor still published, no event, no bump
  });

  it('overlap listing names exactly the offending pair: bands 0 and 1 overlap, band 2 is clean', { timeout: T }, async () => {
    const e = world(f, { bands: [dBand(f, 11, { sex: 'any', sort_order: 0 }), dBand(f, 12, { sex: 'any', age_low_value: 1, age_low_unit: 'year', sort_order: 1 }), dBand(f, 13, { sex: 'female', sort_order: 2 })] });
    const x = await rejection(publish(e, f, D2(f).id));
    lims(x, 'common.validation_failed', 400);
    const paths = errPaths(x).join(' ');
    expect(paths).toMatch(/bands\/0/); expect(paths).toMatch(/bands\/1/); expect(paths).not.toMatch(/bands\/2/);
  });

  it('adjacent windows (0 d–18 y / 18 y–inf), different sexes, and different specimen types are NOT overlaps: publishes', { timeout: T }, async () => {
    const e = world(f, { bands: [dBand(f, 11, { sex: 'any', age_low_value: 0, age_low_unit: 'day', ...SC, sort_order: 0 }), dBand(f, 12, { sex: 'any', ...SY, sort_order: 1 }),
      dBand(f, 13, { sex: 'male', sort_order: 2 }), dBand(f, 14, { sex: 'any', specimen_type_id: URINE.id, sort_order: 3 })] });
    expect((await publish(e, f, D2(f).id)).status).toBe('published');
  });

  it('12 months and 1 year touch (365.25 d); 13 months overlaps 1 year — compared in days', { timeout: T }, async () => {
    const mk = (m: number) => world(f, { bands: [dBand(f, 11, { age_low_value: 0, age_low_unit: 'day', age_high_value: m, age_high_unit: 'month', sort_order: 0 }), dBand(f, 12, { age_low_value: 1, age_low_unit: 'year', sort_order: 1 })] });
    expect((await publish(mk(12), f, D2(f).id)).status).toBe('published');
    lims(await rejection(publish(mk(13), f, D2(f).id)), 'common.validation_failed', 400);
  });

  it('an empty draft (no bands) cannot be published -> 400 (/bands)', { timeout: T }, async () => {
    const e = world(f, { bands: [] }); const before = snap(e.db);
    const x = await rejection(publish(e, f, D2(f).id));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x).join(' ')).toMatch(/bands/);
    expect(snap(e.db)).toBe(before);
  });

  it('value precision (TRD §7.3 step 6): at most decimals + 2 places — HB has 1 decimal, so 3 places pass and 4 fail', { timeout: T }, async () => {
    const ok = world(f, { bands: [dBand(f, 11, { low: '13.123', high: '17.0', sort_order: 0 })] });
    expect((await publish(ok, f, D2(f).id)).status).toBe('published');
    const bad = world(f, { bands: [dBand(f, 11, { low: '13.1234', high: '17.0', sort_order: 0 })] }); const before = snap(bad.db);
    const x = await rejection(publish(bad, f, D2(f).id));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x).join(' ')).toMatch(/bands\/0/);
    expect(snap(bad.db)).toBe(before);
  });

  it('ordinal analyte: normal_codes / abnormal_codes must exist in the analyte\'s value set (URINE_SEMIQ: NEG, TRACE, POS_1)', { timeout: T }, async () => {
    const nitSet = (codes: string[]) => ({ [f.setTable]: [draftSet(f.mkSet, 3, NIT.id, { unit_code: null })], [f.bandTable]: [f.mkBand(21, TENANT_A, draftSet(f.mkSet, 3, NIT.id).id as string, { sex: 'any', kind: 'ordinal', display_text: 'Negative', [f.codesField]: codes, sort_order: 0 })] });
    const ok = setup8({ t6: nitSet(['NEG', 'TRACE']) as never });
    expect((await publish(ok, f, draftSet(f.mkSet, 3, NIT.id).id as string)).status).toBe('published');
    for (const codes of [['ZZZ'], ['NEG', 'ZZZ']]) {
      const bad = setup8({ t6: nitSet(codes) as never }); const before = snap(bad.db);
      const x = await rejection(publish(bad, f, draftSet(f.mkSet, 3, NIT.id).id as string));
      lims(x, 'common.validation_failed', 400); expect(errPaths(x).join(' ')).toMatch(/bands\/0/);
      expect(snap(bad.db)).toBe(before);
    }
  });

  it('unit / method snapshot (AC-05.10 data side): a set whose unit or method differs from the analyte\'s current published version -> 400, nothing published', { timeout: T }, async () => {
    for (const o of [{ unit_code: 'mmol_l' }, { method_id: M2.id }, { method_id: null }, { unit_code: null }]) {
      const e = world(f, { draft: o }); const before = snap(e.db);
      lims(await rejection(publish(e, f, D2(f).id)), 'common.validation_failed', 400);
      expect(snap(e.db)).toBe(before);
    }
  });

  it('AB-18 back-dating: effective_from older than now − 300 s -> 400 /effective_from; inside the tolerance it is accepted', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    const x = await rejection(publish(e, f, D2(f).id, pBody({ effective_from: at(-301 * SEC - 1) })));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_from');
    expect(snap(e.db)).toBe(before);
    const e2 = world(f, { pred: { effective_from: new Date(at(-DAY)) } });
    expect((await publish(e2, f, D2(f).id, pBody({ effective_from: at(-240 * SEC) }))).effective_from).toBe(at(-240 * SEC));
  });

  it('V4 guard: effective_from must be strictly after the latest published sibling\'s effective_from', { timeout: T }, async () => {
    const sched = { effective_from: new Date(at(DAY)) };                       // P1 itself is scheduled for tomorrow
    const e = world(f, { pred: sched }); const before = snap(e.db);
    for (const when of [at(DAY), at(DAY - 1000)]) {
      const x = await rejection(publish(e, f, D2(f).id, pBody({ effective_from: when })));
      lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_from');
    }
    expect(snap(e.db)).toBe(before);
    expect((await publish(world(f, { pred: sched }), f, D2(f).id, pBody({ effective_from: at(DAY + 1000) }))).status).toBe('published');
  });

  it('V4 guard includes RETIRED siblings: before the retired sibling\'s effective_to -> 400 /effective_from; at it -> ok; a retired sibling is never superseded', { timeout: T }, async () => {
    const retiredUntil = at(60 * 60 * 1000);                                   // retired at now + 1 h
    const retired = { status: 'retired', effective_to: new Date(retiredUntil) };
    const e = world(f, { pred: retired }); const before = snap(e.db);
    for (const when of [at(30 * 60 * 1000), at(60 * 60 * 1000 - 1)]) {
      const x = await rejection(publish(e, f, D2(f).id, pBody({ effective_from: when })));
      lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_from');
    }
    expect(snap(e.db)).toBe(before);
    const e2 = world(f, { pred: retired });
    expect((await publish(e2, f, D2(f).id, pBody({ effective_from: retiredUntil }))).effective_from).toBe(retiredUntil);
    expect(e2.db.row(f.setTable, P1(f).id)).toMatchObject({ status: 'retired', version: 1 });   // untouched
  });

  it('V4 guard: a retired sibling that started AFTER the new effective_from also blocks (effective_from must exceed every sibling\'s)', { timeout: T }, async () => {
    const e = world(f, { pred: { status: 'retired', effective_from: new Date(at(2 * DAY)), effective_to: new Date(at(3 * DAY)) } });
    const x = await rejection(publish(e, f, D2(f).id, pBody({ effective_from: at(DAY) })));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_from');
  });

  it.each([['change_reason missing', {}, '/change_reason'], ['empty change_reason', { change_reason: '' }, '/change_reason'], ['501-char change_reason', { change_reason: 'x'.repeat(501) }, '/change_reason'],
    ['non-string change_reason', { change_reason: 5 }, '/change_reason'], ['malformed effective_from', { change_reason: 'ok', effective_from: '2026-13-01T00:00:00.000Z' }, '/effective_from'],
    ['effective_from without Z', { change_reason: 'ok', effective_from: '2026-12-01T00:00:00' }, '/effective_from']])('invalid body (%s) -> 400', { timeout: T }, async (_n, body, path) => {
    const e = world(f); const before = snap(e.db);
    const x = await rejection(publish(e, f, D2(f).id, body));
    validation400(x); if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('a 500-char change_reason is accepted; quotes / SQL text are stored verbatim and never reach the statement text (parameterised)', { timeout: T }, async () => {
    const e = world(f);
    const reason = `'; DROP TABLE catalog.${f.setTable}; --`;
    const out = await publish(e, f, D2(f).id, pBody({ change_reason: reason }));
    expect(out.change_reason).toBe(reason);
    expect(e.db.stmts.every((s) => !s.text.includes('DROP TABLE'))).toBe(true);
    const ok500 = world(f); expect((await publish(ok500, f, D2(f).id, pBody({ change_reason: 'x'.repeat(500) }))).change_reason).toHaveLength(500);
  });

  it('S-5 mass assignment: status / tenant_id / version_no / effective_to / published_by / unit_code in the body -> 400, nothing changes', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    for (const extra of [{ status: 'published' }, { tenant_id: TENANT_B }, { version_no: 9 }, { effective_to: T1 }, { published_by: ID(1) }, { unit_code: 'mmol_l' }]) {
      validation400(await rejection(publish(e, f, D2(f).id, pBody(extra))));
    }
    expect(snap(e.db)).toBe(before);
  });

  it.each(['published', 'superseded', 'retired', 'discarded'])('publishing a %s set -> 409 catalog.version_in_use (also with a stale If-Match); nothing changes', { timeout: T }, async (status) => {
    const e = setup8({ t6: { [f.setTable]: [P1(f, { status })], [f.bandTable]: [pBand(f)] } as never }); const before = snap(e.db);
    inUse(await rejection(publish(e, f, P1(f).id)));
    inUse(await rejection(publish(e, f, P1(f).id, pBody(), 42)));
    expect(snap(e.db)).toBe(before);
  });

  it('stale If-Match -> 409 common.version_conflict; missing -> 428; unknown / other tenant\'s id -> 404; malformed -> 400', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    conflict(await rejection(publish(e, f, D2(f).id, pBody(), 5)));
    lims(await rejection(publish(e, f, D2(f).id, pBody(), ABSENT)), 'common.precondition_required', 428);
    notFound(await rejection(publish(e, f, ID(0xdead)))); validation400(await rejection(publish(e, f, 'x')));
    notFound(await rejection(publish(e, f, D2(f).id, pBody(), 1, { tenantId: TENANT_B })));
    expect(snap(e.db)).toBe(before);
  });

  it('atomic: a failing event insert, a failing predecessor update, or a rollback leaves the draft a draft, the predecessor published, no event, revision 417', { timeout: T }, async () => {
    const a = world(f); a.db.fail(/INSERT INTO core\.event_log/i);
    const b = world(f); b.db.fail(new RegExp(`UPDATE catalog\\.${f.setTable}\\b[^]*superseded|UPDATE catalog\\.${f.setTable}\\b[^]*status`, 'i'), () => new Error('injected'));
    const c = world(f);
    const base = snap(c.db);
    await rejection(publish(a, f, D2(f).id)); await rejection(publish(b, f, D2(f).id)); await rejection(publish(c, f, D2(f).id, pBody(), 1, { rollback: true }));
    for (const x of [a, b, c]) {
      expect(x.db.row(f.setTable, D2(f).id)).toMatchObject({ status: 'draft', version: 1 });
      expect(x.db.row(f.setTable, P1(f).id)).toMatchObject({ status: 'published', version: 1 });
      expect(events(x.db)).toHaveLength(0); expect(x.db.revisionOf(TENANT_A)).toBe(417); expect(ownerRev(x.db)).toBe(0);
    }
    expect(snap(c.db)).toBe(base);
  });

  it('two concurrent publishes of the same draft: exactly one succeeds, the other is 409; predecessor superseded once; one event; revision 418', { timeout: T }, async () => {
    const e = world(f);
    const r = await Promise.allSettled([publish(e, f, D2(f).id), publish(e, f, D2(f).id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const reason = (r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
    expect(reason.statusCode).toBe(409); expect(['catalog.version_in_use', 'common.version_conflict']).toContain(reason.code);
    expect(only(e.db)).toHaveLength(1); expect(e.db.revisionOf(TENANT_A)).toBe(418);
    expect(e.db.row(f.setTable, P1(f).id)).toMatchObject({ status: 'superseded', version: 2 });
  });

  it('publish racing a band replace on the same draft: exactly one wins (the loser is 409); a published set\'s bands are exactly what was validated', { timeout: T }, async () => {
    const e = world(f);
    const r = await Promise.allSettled([replace(e, f, D2(f).id, [clean(f.band())]), publish(e, f, D2(f).id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
    const row = e.db.row(f.setTable, D2(f).id)!;
    if (row['status'] === 'published') expect(bandsOf(e.db, f, D2(f).id)).toHaveLength(2);   // the original two validated bands
    else expect(bandsOf(e.db, f, D2(f).id)).toHaveLength(1);
  });

  it('a later set can be published after the previous: v3 supersedes v2, v1 stays superseded (windows chain without gaps or overlap)', { timeout: T }, async () => {
    const e = world(f);
    await publish(e, f, D2(f).id, pBody({ effective_from: at(10 * 60 * 1000) }));
    const d3 = await create(e, f, HB.id, { copy_from_set_id: D2(f).id });
    expect(d3.version_no).toBe(3);
    const out = await publish(e, f, d3.id, pBody({ effective_from: at(20 * 60 * 1000) }), 1);
    expect(out.status).toBe('published');
    const rows = setsOf(e.db, f, HB.id);
    expect(rows.map((r) => r['status'])).toEqual(['superseded', 'superseded', 'published']);
    expect(ms(rows[0]!['effective_to'])).toBe(ms(rows[1]!['effective_from']));
    expect(ms(rows[1]!['effective_to'])).toBe(ms(rows[2]!['effective_from']));
    expect(rows[2]!['effective_to']).toBeNull();
  });
});

describe.each(FAMILIES)('$name sets — retire (#42 / #49): V6', (f) => {
  it('200: published -> retired; effective_to = effective_at (default now); the publish change_reason is NOT overwritten; version +1; bands untouched', { timeout: T }, async () => {
    const e = pubOnly(f);
    const out = await retire(e, f, P1(f).id);
    expect(out).toMatchObject({ id: P1(f).id, status: 'retired', effective_to: NOW, change_reason: 'initial', version: 2 });
    expect(e.db.row(f.setTable, P1(f).id)).toMatchObject({ status: 'retired', change_reason: 'initial', updated_by: USER });
    expect(bandsOf(e.db, f, P1(f).id)).toHaveLength(1);
  });

  it('publishes catalog.changed.v1 {entity_type, entity_id = the SET id, change_kind versioned, effective_from = the retire time}; one bump; stamps the owning test', { timeout: T }, async () => {
    const e = pubOnly(f);
    await retire(e, f, P1(f).id, rBody({ effective_at: at(2 * 60 * 1000) }));
    expect(only(e.db)).toHaveLength(1);
    expect(only(e.db)[0]).toMatchObject({ catalog_revision: 418, entity_type: f.entity, entity_id: P1(f).id, change_kind: 'versioned', effective_from: at(2 * 60 * 1000) });
    expect(ownerRev(e.db)).toBe(418);
  });

  it('effective_at in the future is allowed (the set stays effective until then); up to 300 s in the past is tolerated, older -> 400 /effective_at', { timeout: T }, async () => {
    expect((await retire(pubOnly(f), f, P1(f).id, rBody({ effective_at: at(DAY) }))).effective_to).toBe(at(DAY));
    expect((await retire(pubOnly(f), f, P1(f).id, rBody({ effective_at: at(-240 * SEC) }))).effective_to).toBe(at(-240 * SEC));
    const e = pubOnly(f); const before = snap(e.db);
    const x = await rejection(retire(e, f, P1(f).id, rBody({ effective_at: at(-301 * SEC - 1) })));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_at');
    expect(snap(e.db)).toBe(before);
  });

  it('effective_at before the set\'s own effective_from (a scheduled set not yet started) -> 400 /effective_at, never a 500 from the window CHECK', { timeout: T }, async () => {
    const e = pubOnly(f, { effective_from: new Date(T1) }); const before = snap(e.db);
    const x = await rejection(retire(e, f, P1(f).id));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_at');
    expect(snap(e.db)).toBe(before);
  });

  it.each(['draft', 'superseded', 'retired', 'discarded'])('retiring a %s set -> 409 catalog.version_in_use; nothing changes', { timeout: T }, async (status) => {
    const draft = status === 'draft' || status === 'discarded' ? { effective_from: null, published_at: null, change_reason: null } : { effective_to: new Date(at(-DAY)) };
    const e = setup8({ t6: { [f.setTable]: [P1(f, { status, ...draft })], [f.bandTable]: [pBand(f)] } as never }); const before = snap(e.db);
    inUse(await rejection(retire(e, f, P1(f).id)));
    expect(snap(e.db)).toBe(before);
  });

  it.each([['change_reason missing', {}], ['empty change_reason', { change_reason: '' }], ['501 chars', { change_reason: 'x'.repeat(501) }], ['bad effective_at', { change_reason: 'ok', effective_at: 'tomorrow' }],
    ['extra status', { change_reason: 'ok', status: 'retired' }], ['extra effective_to', { change_reason: 'ok', effective_to: T1 }], ['extra tenant_id', { change_reason: 'ok', tenant_id: TENANT_B }]])('invalid body (%s) -> 400', { timeout: T }, async (_n, body) => {
    const e = pubOnly(f); const before = snap(e.db);
    validation400(await rejection(retire(e, f, P1(f).id, body)));
    expect(snap(e.db)).toBe(before);
  });

  it('stale If-Match -> 409; missing -> 428; unknown / other tenant\'s id -> 404; malformed -> 400', { timeout: T }, async () => {
    const e = pubOnly(f); const before = snap(e.db);
    conflict(await rejection(retire(e, f, P1(f).id, rBody(), 9)));
    lims(await rejection(retire(e, f, P1(f).id, rBody(), ABSENT)), 'common.precondition_required', 428);
    notFound(await rejection(retire(e, f, ID(0xdead)))); validation400(await rejection(retire(e, f, 'x')));
    notFound(await rejection(retire(e, f, P1(f).id, rBody(), 1, { tenantId: TENANT_B })));
    expect(snap(e.db)).toBe(before);
  });

  it('atomic: a failing event insert or a rollback leaves the set published, no event, revision 417', { timeout: T }, async () => {
    const a = pubOnly(f); a.db.fail(/INSERT INTO core\.event_log/i);
    const b = pubOnly(f); const base = snap(b.db);
    await rejection(retire(a, f, P1(f).id)); await rejection(retire(b, f, P1(f).id, rBody(), 1, { rollback: true }));
    for (const x of [a, b]) { expect(x.db.row(f.setTable, P1(f).id)).toMatchObject({ status: 'published', version: 1, effective_to: null }); expect(events(x.db)).toHaveLength(0); expect(x.db.revisionOf(TENANT_A)).toBe(417); }
    expect(snap(b.db)).toBe(base);
  });

  it('two concurrent retires: exactly one succeeds (409 for the other); one event', { timeout: T }, async () => {
    const e = pubOnly(f);
    const r = await Promise.allSettled([retire(e, f, P1(f).id), retire(e, f, P1(f).id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
    expect(only(e.db)).toHaveLength(1);
  });

  it('retire racing a successor\'s publish: the predecessor ends up either retired or superseded, never both, with one consistent effective_to', { timeout: T }, async () => {
    const e = world(f);
    const r = await Promise.allSettled([retire(e, f, P1(f).id, rBody(), 1), publish(e, f, D2(f).id)]);
    const pred = e.db.row(f.setTable, P1(f).id)!;
    expect(['retired', 'superseded']).toContain(pred['status']);
    expect(pred['effective_to']).not.toBeNull();
    expect(r.some((x) => x.status === 'fulfilled')).toBe(true);
    expect(events(e.db).length).toBe(r.filter((x) => x.status === 'fulfilled').length);
  });
});

describe.each(FAMILIES)('$name sets — discard (#43 / #50): V3', (f) => {
  it('200: draft -> discarded; version +1; bands retained; no event, no bump; a new draft can then be created and is numbered max + 1', { timeout: T }, async () => {
    const e = world(f); const rev = e.db.revisionOf(TENANT_A);
    const out = await discard(e, f, D2(f).id);
    expect(out).toMatchObject({ id: D2(f).id, status: 'discarded', version: 2 });
    expect(bandsOf(e.db, f, D2(f).id)).toHaveLength(2);
    expect(events(e.db)).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(rev); expect(ownerRev(e.db)).toBe(0);
    expect((await create(e, f, HB.id)).version_no).toBe(3);
  });

  it.each(['published', 'superseded', 'retired', 'discarded'])('discarding a %s set -> 409 catalog.version_in_use (also with a stale If-Match)', { timeout: T }, async (status) => {
    const e = setup8({ t6: { [f.setTable]: [P1(f, { status })], [f.bandTable]: [pBand(f)] } as never }); const before = snap(e.db);
    inUse(await rejection(discard(e, f, P1(f).id))); inUse(await rejection(discard(e, f, P1(f).id, 7)));
    expect(snap(e.db)).toBe(before);
  });

  it('stale If-Match -> 409; missing -> 428; unknown / other tenant\'s id -> 404; malformed -> 400', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    conflict(await rejection(discard(e, f, D2(f).id, 9)));
    lims(await rejection(discard(e, f, D2(f).id, ABSENT)), 'common.precondition_required', 428);
    notFound(await rejection(discard(e, f, ID(0xdead)))); validation400(await rejection(discard(e, f, 'x')));
    notFound(await rejection(discard(e, f, D2(f).id, 1, { tenantId: TENANT_B })));
    expect(snap(e.db)).toBe(before);
  });

  it('a discarded draft can no longer be edited or published (V3 is terminal)', { timeout: T }, async () => {
    const e = world(f);
    await discard(e, f, D2(f).id);
    inUse(await rejection(replace(e, f, D2(f).id, [clean(f.band())], 2)));
    inUse(await rejection(publish(e, f, D2(f).id, pBody(), 2)));
  });
});

describe.each(FAMILIES)('$name sets — tenant isolation (S-1) and DB backstops (S-6)', (f) => {
  it('tenant B cannot read, list, edit, publish, retire, discard or copy tenant A\'s sets; every attempt is 404 and tenant A\'s data is byte-identical afterwards', { timeout: T }, async () => {
    const e = world(f); const before = snap(e.db);
    const asB = { tenantId: TENANT_B };
    notFound(await rejection(get(e, f, P1(f).id, asB)));
    notFound(await rejection(list(e, f, HB.id, undefined, asB)));
    notFound(await rejection(create(e, f, ID(0x3003), { copy_from_set_id: P1(f).id }, asB)));
    notFound(await rejection(replace(e, f, D2(f).id, [clean(f.band())], 1, asB)));
    notFound(await rejection(publish(e, f, D2(f).id, pBody(), 1, asB)));
    notFound(await rejection(retire(e, f, P1(f).id, rBody(), 1, asB)));
    notFound(await rejection(discard(e, f, D2(f).id, 1, asB)));
    expect(snap(e.db)).toBe(before);
  });

  it('every statement on the set / band tables carries the tenant (explicit tenant_id predicate or value, not RLS alone)', { timeout: T }, async () => {
    const e = world(f);
    await get(e, f, P1(f).id); await list(e, f, HB.id); await replace(e, f, D2(f).id, [clean(f.band())]); await publish(e, f, D2(f).id, pBody(), 2); await retire(e, f, D2(f).id, rBody(), 3);
    const stmts = e.db.t6Stmts().filter((s) => new RegExp(`catalog\\.(${f.setTable}|${f.bandTable})\\b`, 'i').test(s.text));
    expect(stmts.length).toBeGreaterThan(5);
    for (const s of stmts) expect(s.text, s.text).toMatch(/tenant_id/i);
  });

  it('a published set stays immutable even for direct SQL: band INSERT / UPDATE / DELETE and set column UPDATE all raise P0001 (the API guard is not the only one)', { timeout: T }, async () => {
    const e = pubOnly(f);
    const tx = e.db.begin(TENANT_A);
    const bandCols = f.bandTable === 'reference_ranges' ? '(id, tenant_id, set_id, sex, kind, low, high, sort_order, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)' : '(id, tenant_id, set_id, sex, low, high, sort_order, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
    const vals = f.bandTable === 'reference_ranges' ? [ID(0xf001), TENANT_A, P1(f).id, 'any', 'numeric', '1', '2', 5, USER] : [ID(0xf001), TENANT_A, P1(f).id, 'any', '1', '2', 5, USER];
    const attempts: Array<[string, unknown[]]> = [
      [`INSERT INTO catalog.${f.bandTable} ${bandCols}`, vals],
      [`UPDATE catalog.${f.bandTable} SET low = $1 WHERE tenant_id = $2 AND set_id = $3`, ['9', TENANT_A, P1(f).id]],
      [`DELETE FROM catalog.${f.bandTable} WHERE tenant_id = $1 AND set_id = $2`, [TENANT_A, P1(f).id]],
      [`UPDATE catalog.${f.setTable} SET unit_code = $1 WHERE tenant_id = $2 AND id = $3`, ['mmol_l', TENANT_A, P1(f).id]],
    ];
    for (const [text, values] of attempts) expect((await rejection(tx.facade.query(text, values))).code, text).toBe('P0001');
    tx.rollback();
  });

  it('REQ-SEC-080 / AB-20: error details never echo submitted values (change_reason, codes)', { timeout: T }, async () => {
    const e = world(f); const secret = 'S3CRET-REASON-' + 'x'.repeat(520);
    const x = await rejection(publish(e, f, D2(f).id, pBody({ change_reason: secret })));
    expect(JSON.stringify({ m: x.message, d: x.detail, e: x.errors })).not.toContain('S3CRET');
  });
});
