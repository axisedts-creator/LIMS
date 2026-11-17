// T-27 (C3) — instrument code maps service, operations #92–#95: list, create, update, bulk upsert.
// Spec: 06-PLAN row T-27 (done_when: analyte ∈ test via composite FK; partial uniques; bulk per-row outcomes; privileged permission — the permission side is in
//         instrumentMaps.handlers.test.ts; tests: integration, probes, contract), 01-PRD US-18: AC-18.1 (create + round trip — the port side is in contract/CatalogPort.instrumentMaps.test.ts),
//         AC-18.3 (second active inbound map for the same instrument+code -> 409 catalog.code_duplicate), AC-18.4 (analyte_id must belong to test_id -> 400 common.validation_failed;
//         both in the caller's tenant, else 404 common.not_found), AC-18.5 (bulk upsert <= 200 rows, per-row outcome);
//       02-TRD §5 rows 92–95 (+ §5.0 If-Match 428/409, cursor lists), §9.1 (entity_type instrument_code_map; created / updated / deactivated), 05-SCHEMA instrument_code_maps
//         (composite FK, partial uniques inbound/outbound, unit triple), contracts/openapi/catalog.yaml (InstrumentCodeMap*, flag_map = JSON object text),
//       07-SECURITY S-1 (cross-tenant), S-5 (mass assignment), AB-20 (no value echo), A4 (wrong map = wrong analyte).
// Real core `createEvents({producer:'catalog'})` + T-03 revision service over the SQL fake (helpers/testsDb.ts; constraints modelled there). Interface: helpers/t27.ts (SEAM header).
// ASSUMPTIONS (spec silent; each is also in .orchestra/notes/C3.T-27-tests.md): list `direction` filter is an exact column match; list order is not asserted (paging is);
//   bulk: rows are keyed (inbound/both: instrument_code; outbound: analyte_id) among the instrument's ACTIVE maps, a keyed row whose analyte differs from the existing map's
//   (analyte_id is immutable) is a per-row `catalog.code_duplicate`; an unchanged row writes nothing; the number of revision bumps of a mixed batch is not asserted (>= 1 when anything changed).
import { describe, expect, it } from 'vitest';
import { UUIDV7, USER } from '../helpers/catalogDb.js';
import { lims, rejection, validation400 } from '../helpers/t6.js';
import {
  CBC, GROWTH, HB, HB_B, ID, INST, INST2, INST_B, MICRO, ONLY_B, PLT, RBC, TEST_B, T, TENANT_A, TENANT_B, WBC,
  changedEvents, hgbBody, icm, mapStmts, mapWrites, mapsOf, row, setup27, type Env27, type Row,
} from '../helpers/t27.js';

const A = TENANT_A, B = TENANT_B;
const create = (e: Env27, body: unknown, o: { tenantId?: string; rollback?: boolean } = {}) => e.db.run((ctx) => e.svc['createInstrumentCodeMap']!(ctx, body), o);
const list = (e: Env27, query: unknown, tenantId = A) => e.db.run((ctx) => e.svc['listInstrumentCodeMaps']!(ctx, query), { tenantId });
const upd = (e: Env27, id: unknown, version: number | undefined, patch: unknown, o: { tenantId?: string } = {}) =>
  e.db.run((ctx) => e.svc['updateInstrumentCodeMap']!(ctx, { id, expectedVersion: version, patch }), o);
const bulk = (e: Env27, body: unknown, o: { tenantId?: string } = {}) => e.db.run((ctx) => e.svc['upsertInstrumentCodeMaps']!(ctx, body), o);
const rev = (e: Env27, tenant = A) => e.db.revisionOf(tenant);
const DTO_BASE = ['id', 'instrument_id', 'direction', 'instrument_code', 'analyte_id', 'test_id', 'is_active', 'version'];
const FLAGS = '{"H":"HIGH","L":"LOW"}';
/** A seeded map of tenant A on INST (HB in CBC), active inbound unless overridden. */
const seed = (n: number, o: Row = {}) => icm(n, A, INST, { instrument_code: `S${n}`, analyte_id: HB.id, test_id: CBC.test.id, ...o });

// ====================================================================================================== CREATE
describe('createInstrumentCodeMap (#93) — AC-18.1 / AC-18.4', () => {
  it('AC-18.1: the UI body (direction both, HGB -> HB, g/L -> g_dl x 0.1) creates the map: exact InstrumentCodeMap DTO, owned by the caller\'s tenant, version 1, active', { timeout: T }, async () => {
    const e = setup27();
    const out = await create(e, hgbBody());
    expect(out).toEqual({ id: out.id, instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id,
      unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1', is_active: true, version: 1 });
    expect(out.id).toMatch(UUIDV7);
    expect(mapsOf(e.db)).toHaveLength(1);
    expect(mapsOf(e.db)[0]).toMatchObject({ id: out.id, tenant_id: A, instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id,
      unit_from_raw: 'g/L', unit_to_code: 'g_dl', is_active: true, version: 1, created_by: USER, updated_by: USER });
    expect(Number(mapsOf(e.db)[0]!['unit_factor'])).toBe(0.1);
  });

  it('a map without units / flag map has NO unit_* / flag_map keys in the DTO (not null); all three directions are accepted', { timeout: T }, async () => {
    const e = setup27();
    for (const [i, direction] of (['inbound', 'outbound', 'both'] as const).entries()) {
      const out = await create(e, hgbBody({ direction, instrument_code: `D${i}`, analyte_id: [HB, RBC, PLT][i]!.id, unit_from_raw: undefined, unit_to_code: undefined, unit_factor: undefined }));
      expect(Object.keys(out).sort(), direction).toEqual([...DTO_BASE].sort());
      expect(out.direction).toBe(direction);
    }
    expect(mapsOf(e.db)).toHaveLength(3);
  });

  it('flag_map: DTO carries JSON object TEXT; the column holds the parsed object', { timeout: T }, async () => {
    const e = setup27();
    const out = await create(e, hgbBody({ flag_map: FLAGS }));
    expect(typeof out.flag_map).toBe('string');
    expect(JSON.parse(out.flag_map)).toEqual({ H: 'HIGH', L: 'LOW' });
    expect(mapsOf(e.db)[0]!['flag_map']).toEqual({ H: 'HIGH', L: 'LOW' });
  });

  it('boundaries accepted: 1- and 64-char instrument_code, 32-char unit_from_raw, 20 flag entries with 16-char keys', { timeout: T }, async () => {
    const e = setup27();
    const flags = JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${'F'.repeat(15)}${String.fromCharCode(65 + i)}`, 'HIGH'])));
    await create(e, hgbBody({ instrument_code: 'X' }));
    await create(e, hgbBody({ instrument_code: 'Y'.repeat(64), analyte_id: RBC.id }));
    await create(e, hgbBody({ instrument_code: 'Z', analyte_id: PLT.id, unit_from_raw: 'u'.repeat(32), flag_map: flags }));
    expect(mapsOf(e.db)).toHaveLength(3);
  });

  it('event catalog.changed.v1 {entity_type instrument_code_map, change_kind created, entity_id = new id} in the same transaction; revision +1; insert before the event', { timeout: T }, async () => {
    const e = setup27();
    const out = await create(e, hgbBody());
    const ev = changedEvents(e.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'instrument_code_map', entity_id: out.id, change_kind: 'created' });
    expect(rev(e)).toBe(418);
    const mine = e.db.stmts.filter((s) => s.tenantId === A);
    const insertAt = mine.findIndex((s) => /^\s*INSERT\s+INTO\s+catalog\.instrument_code_maps\b/i.test(s.text));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(mine.findIndex((s) => /INSERT INTO core\.event_log/i.test(s.text))).toBeGreaterThan(insertAt);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);
  });

  it('atomic: a failing event insert or a rollback leaves no map and no revision change', { timeout: T }, async () => {
    const e = setup27();
    e.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(create(e, hgbBody()));
    expect(mapsOf(e.db)).toHaveLength(0);
    const f = setup27();
    await rejection(create(f, hgbBody(), { rollback: true }));
    expect(mapsOf(f.db)).toHaveLength(0);
    expect(rev(f)).toBe(417);
  });

  // ---- AC-18.4
  it.each([
    ['AC-18.4 analyte of ANOTHER test in the tenant (HB under MICRO)', () => hgbBody({ test_id: MICRO.test.id }), 400, 'common.validation_failed'],
    ['AC-18.4 analyte of MICRO under CBC', () => hgbBody({ analyte_id: GROWTH.id }), 400, 'common.validation_failed'],
    ['AC-18.4 test of ANOTHER tenant', () => hgbBody({ test_id: TEST_B.test.id }), 404, 'common.not_found'],
    ['AC-18.4 analyte of ANOTHER tenant', () => hgbBody({ analyte_id: HB_B.id }), 404, 'common.not_found'],
    ['AC-18.4 test AND analyte of ANOTHER tenant (consistent pair, wrong tenant)', () => hgbBody({ test_id: TEST_B.test.id, analyte_id: HB_B.id }), 404, 'common.not_found'],
    ['unknown test id', () => hgbBody({ test_id: ID(0xdead) }), 404, 'common.not_found'],
    ['unknown analyte id', () => hgbBody({ analyte_id: ID(0xdeae) }), 404, 'common.not_found'],
    ['a panel id is not a test', () => hgbBody({ test_id: ID(0x2001) }), 404, 'common.not_found'],
  ])('%s -> %i %s; no row, no event, no revision bump', { timeout: T }, async (_n, mk, status, code) => {
    const e = setup27();
    lims(await rejection(create(e, mk())), code as string, status as number);
    expect(mapsOf(e.db)).toHaveLength(0);
    expect(changedEvents(e.db)).toHaveLength(0);
    expect(rev(e)).toBe(417);
  });

  it('the symmetric case: tenant B cannot map to tenant A\'s test / analyte (404) but maps its own', { timeout: T }, async () => {
    const e = setup27({ catalog: { state: { [A]: { rootId: ID(0xc3a0), revision: 417 }, [B]: { rootId: ID(0xc3a1), revision: 5 } } } });
    lims(await rejection(create(e, hgbBody({ instrument_id: INST_B }), { tenantId: B })), 'common.not_found', 404);
    const out = await create(e, hgbBody({ instrument_id: INST_B, analyte_id: HB_B.id, test_id: TEST_B.test.id }), { tenantId: B });
    expect(mapsOf(e.db, B).map((r) => r['id'])).toEqual([out.id]);
    expect(mapsOf(e.db, A)).toHaveLength(0);
  });

  it('the DB composite FK (tenant_id, analyte_id, test_id) -> analytes is the backstop: a raw insert of a mismatched pair raises 23503 instrument_code_maps__analyte_test__fk', { timeout: T }, async () => {
    const e = setup27();
    const x = await rejection(e.db.run((ctx) => ctx.tx.query(
      'INSERT INTO catalog.instrument_code_maps (id, tenant_id, instrument_id, direction, instrument_code, analyte_id, test_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [ID(0xb900), A, INST, 'inbound', 'RAW', HB.id, MICRO.test.id, USER, USER])));
    expect(x.code).toBe('23503');
    expect(x.constraint).toBe('instrument_code_maps__analyte_test__fk');
  });

  // ---- AC-18.3 + the partial uniques
  it.each([
    ['inbound vs inbound, same code, another analyte', { direction: 'inbound', instrument_code: 'HGB', analyte_id: HB.id }, { direction: 'inbound', instrument_code: 'HGB', analyte_id: RBC.id }],
    ['AC-18.3 inbound vs inbound, same code and analyte', { direction: 'inbound', instrument_code: 'HGB', analyte_id: HB.id }, { direction: 'inbound', instrument_code: 'HGB', analyte_id: HB.id }],
    ['existing both vs new inbound, same code', { direction: 'both', instrument_code: 'HGB', analyte_id: HB.id }, { direction: 'inbound', instrument_code: 'HGB', analyte_id: RBC.id }],
    ['existing inbound vs new both, same code', { direction: 'inbound', instrument_code: 'HGB', analyte_id: HB.id }, { direction: 'both', instrument_code: 'HGB', analyte_id: RBC.id }],
    ['outbound vs outbound, same analyte (another code)', { direction: 'outbound', instrument_code: 'HGB', analyte_id: HB.id }, { direction: 'outbound', instrument_code: 'HB2', analyte_id: HB.id }],
    ['existing both vs new outbound, same analyte (another code)', { direction: 'both', instrument_code: 'HGB', analyte_id: HB.id }, { direction: 'outbound', instrument_code: 'HB2', analyte_id: HB.id }],
    ['existing outbound vs new both, same analyte (another code)', { direction: 'outbound', instrument_code: 'HGB', analyte_id: HB.id }, { direction: 'both', instrument_code: 'HB2', analyte_id: HB.id }],
  ])('%s -> 409 catalog.code_duplicate; the first map is untouched; no extra row / event / revision', { timeout: T }, async (_n, first, second) => {
    const e = setup27();
    const one = await create(e, hgbBody(first));
    const before = [rev(e), changedEvents(e.db).length];
    lims(await rejection(create(e, hgbBody(second))), 'catalog.code_duplicate', 409);
    expect(mapsOf(e.db).map((r) => r['id'])).toEqual([one.id]);
    expect([rev(e), changedEvents(e.db).length]).toEqual(before);
  });

  it.each([
    ['another instrument, same code and analyte', { instrument_id: INST2 }],
    ['inbound-only and outbound-only maps may share code AND analyte (separate indexes)', { direction: 'outbound' }],
    ['a second INBOUND code for the same analyte (only outbound is one-per-analyte)', { instrument_code: 'HB', direction: 'inbound' }],
    ['code is case-sensitive: "hgb" is a different inbound code', { instrument_code: 'hgb', direction: 'inbound', analyte_id: RBC.id }],
  ])('no clash: %s', { timeout: T }, async (_n, second) => {
    const e = setup27();
    await create(e, hgbBody({ direction: 'inbound' }));
    const out = await create(e, hgbBody(second));
    expect(out.id).toMatch(UUIDV7);
    expect(mapsOf(e.db)).toHaveLength(2);
  });

  it('an INACTIVE map does not block its key (partial unique WHERE is_active); another tenant\'s identical key does not either', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1, { instrument_code: 'HGB', direction: 'both', is_active: false }), icm(2, B, INST, { instrument_code: 'HGB', direction: 'both', analyte_id: HB_B.id, test_id: TEST_B.test.id })] });
    const out = await create(e, hgbBody());
    expect(out.is_active).toBe(true);
    expect(mapsOf(e.db, A)).toHaveLength(2);
    expect(mapsOf(e.db, B)).toHaveLength(1);
  });

  it('race: two concurrent creates of the same inbound key -> exactly one map, the other 409 catalog.code_duplicate', { timeout: T }, async () => {
    const e = setup27();
    const res = await Promise.allSettled([create(e, hgbBody({ analyte_id: HB.id })), create(e, hgbBody({ analyte_id: RBC.id }))]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    lims(lost.reason, 'catalog.code_duplicate', 409);
    expect(mapsOf(e.db)).toHaveLength(1);
    expect(changedEvents(e.db)).toHaveLength(1);
  });

  // ---- validation, mass assignment, no echo
  it.each([
    ['instrument_id missing', { instrument_id: undefined }], ['direction missing', { direction: undefined }], ['instrument_code missing', { instrument_code: undefined }],
    ['analyte_id missing', { analyte_id: undefined }], ['test_id missing', { test_id: undefined }],
    ['instrument_id not a uuid', { instrument_id: 'inst-1' }], ['analyte_id not a uuid', { analyte_id: 'hb' }], ['test_id not a uuid', { test_id: 7 }],
    ['direction bogus', { direction: 'bidirectional' }], ['direction upper case', { direction: 'INBOUND' }],
    ['instrument_code empty', { instrument_code: '' }], ['instrument_code 65 chars', { instrument_code: 'x'.repeat(65) }], ['instrument_code a number', { instrument_code: 12 }],
    ['unit_from_raw 33 chars', { unit_from_raw: 'u'.repeat(33) }], ['unit_to_code with a slash', { unit_to_code: 'g/dl' }], ['unit_to_code 33 chars', { unit_to_code: 'u'.repeat(33) }],
    ['unit_factor zero', { unit_factor: '0' }], ['unit_factor negative', { unit_factor: '-0.1' }], ['unit_factor not a decimal', { unit_factor: 'abc' }],
    ['unit_factor exponent form', { unit_factor: '1e3' }], ['unit_factor a JSON number', { unit_factor: 0.1 }],
    ['unit triple: only unit_from_raw', { unit_to_code: undefined, unit_factor: undefined }], ['unit triple: only unit_factor', { unit_from_raw: undefined, unit_to_code: undefined }],
    ['unit triple: factor missing', { unit_factor: undefined }],
    ['flag_map not JSON', { flag_map: 'H=HIGH' }], ['flag_map a JSON array', { flag_map: '["H"]' }], ['flag_map a JSON string', { flag_map: '"H"' }], ['flag_map a JSON null', { flag_map: 'null' }],
    ['flag_map value not a string', { flag_map: '{"H":1}' }], ['flag_map key longer than 16', { flag_map: JSON.stringify({ [`K${'x'.repeat(16)}`]: 'HIGH' }) }],
    ['flag_map 21 entries', { flag_map: JSON.stringify(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`F${i}`, 'HIGH']))) }],
    ['flag_map as an object (the DTO is text)', { flag_map: { H: 'HIGH' } }],
    ['extra field tenant_id', { tenant_id: B }], ['extra field id', { id: ID(1) }], ['extra field version', { version: 9 }], ['extra field is_active', { is_active: false }],
    ['extra field created_by', { created_by: USER }], ['extra field unknown', { colour: 'red' }],
  ])('400 validation: %s — no row, no write statement on the table, no event', { timeout: T }, async (_n, o) => {
    const e = setup27();
    validation400(await rejection(create(e, hgbBody(o as Record<string, unknown>))));
    expect(mapsOf(e.db)).toHaveLength(0);
    expect(mapWrites(e.db)).toHaveLength(0);
    expect(changedEvents(e.db)).toHaveLength(0);
  });

  it.each([['a null body', null], ['an array body', []], ['a string body', 'x']])('%s -> 400', { timeout: T }, async (_n, body) => {
    validation400(await rejection(create(setup27(), body)));
  });

  it('AB-20: validation and duplicate errors never echo the submitted code, unit or JSON', { timeout: T }, async () => {
    const e = setup27();
    const secret = 'SECRET-CODE-9f3a';
    const bad = await rejection(create(e, hgbBody({ instrument_code: secret, direction: 'sideways', flag_map: '{"SECRETFLAG":' })));
    expect(JSON.stringify({ m: bad.message, d: bad.detail, e: bad.errors })).not.toContain('SECRET');
    await create(e, hgbBody({ instrument_code: secret }));
    const dup = await rejection(create(e, hgbBody({ instrument_code: secret, analyte_id: RBC.id })));
    lims(dup, 'catalog.code_duplicate', 409);
    expect(JSON.stringify({ m: dup.message, d: dup.detail, e: dup.errors })).not.toContain('SECRET');
  });

  it('SQL injection: a hostile instrument_code is stored verbatim as data; every value is a bind parameter', { timeout: T }, async () => {
    const e = setup27();
    const evil = "x'); DROP TABLE catalog.instrument_code_maps;--";
    const out = await create(e, hgbBody({ instrument_code: evil }));
    expect(out.instrument_code).toBe(evil);
    expect(mapsOf(e.db)[0]!['instrument_code']).toBe(evil);
    for (const s of mapStmts(e.db)) expect(s.text, s.text).not.toMatch(/DROP|x'\)/i);
  });

  it('S-1: every statement on the map table names tenant_id (insert column list / select-update predicate); the row carries ctx.tenantId, never a body value', { timeout: T }, async () => {
    const e = setup27();
    await create(e, hgbBody());
    for (const s of mapStmts(e.db)) expect(s.text, s.text).toMatch(/tenant_id/i);
    expect(mapsOf(e.db)[0]!['tenant_id']).toBe(A);
  });
});

// ====================================================================================================== UPDATE
describe('updateInstrumentCodeMap (#94)', () => {
  const withMap = (o: Row = {}) => setup27({ maps: [seed(1, { instrument_code: 'HGB', direction: 'both', ...o })] });
  const ID1 = ID(0xb001);

  it('patching units / flag map / is_active with If-Match 1 -> 200 the new DTO, version 2, row updated by the actor, immutable columns untouched', { timeout: T }, async () => {
    const e = withMap({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' });
    const out = await upd(e, ID1, 1, { unit_factor: '0.2', flag_map: FLAGS });
    expect(out).toMatchObject({ id: ID1, instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id,
      unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.2', is_active: true, version: 2 });
    expect(JSON.parse(out.flag_map)).toEqual({ H: 'HIGH', L: 'LOW' });
    expect(mapsOf(e.db)[0]).toMatchObject({ version: 2, unit_factor: '0.2', updated_by: USER, instrument_code: 'HGB', analyte_id: HB.id, direction: 'both' });
  });

  it('sets the whole unit triple on a map that has none', { timeout: T }, async () => {
    const e = withMap();
    const out = await upd(e, ID1, 1, { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' });
    expect([out.unit_from_raw, out.unit_to_code, out.unit_factor]).toEqual(['g/L', 'g_dl', '0.1']);
  });

  it('unset removes values: flag_map alone; the whole unit triple together (DTO keys disappear, columns NULL)', { timeout: T }, async () => {
    const e = withMap({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1', flag_map: { H: 'HIGH' } });
    const a = await upd(e, ID1, 1, { unset: ['flag_map'] });
    expect(a).not.toHaveProperty('flag_map');
    expect(a.unit_factor).toBe('0.1');
    const b = await upd(e, ID1, 2, { unset: ['unit_from_raw', 'unit_to_code', 'unit_factor'] });
    expect(Object.keys(b).sort()).toEqual([...DTO_BASE].sort());
    expect(mapsOf(e.db)[0]).toMatchObject({ unit_from_raw: null, unit_to_code: null, unit_factor: null, flag_map: null, version: 3 });
  });

  it('is_active true -> false: event change_kind deactivated; false -> true: updated; one event / revision step each', { timeout: T }, async () => {
    const e = withMap();
    const off = await upd(e, ID1, 1, { is_active: false });
    expect([off.is_active, off.version]).toEqual([false, 2]);
    const on = await upd(e, ID1, 2, { is_active: true });
    expect(on.is_active).toBe(true);
    const ev = changedEvents(e.db);
    expect(ev.map((x) => x.envelope.payload)).toMatchObject([
      { entity_type: 'instrument_code_map', entity_id: ID1, change_kind: 'deactivated', catalog_revision: 418 },
      { entity_type: 'instrument_code_map', entity_id: ID1, change_kind: 'updated', catalog_revision: 419 },
    ]);
    expect(rev(e)).toBe(419);
  });

  it('an ordinary update emits one event {instrument_code_map, updated, entity_id = map id} and bumps the revision once', { timeout: T }, async () => {
    const e = withMap({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' });
    await upd(e, ID1, 1, { unit_factor: '0.5' });
    expect(changedEvents(e.db).map((x) => x.envelope.payload)).toMatchObject([{ entity_type: 'instrument_code_map', entity_id: ID1, change_kind: 'updated', catalog_revision: 418 }]);
  });

  it('If-Match: absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing changes, no event', { timeout: T }, async () => {
    const e = withMap({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' });
    lims(await rejection(upd(e, ID1, undefined, { unit_factor: '0.2' })), 'common.precondition_required', 428);
    lims(await rejection(upd(e, ID1, 2, { unit_factor: '0.2' })), 'common.version_conflict', 409);
    expect(mapsOf(e.db)[0]).toMatchObject({ version: 1, unit_factor: '0.1' });
    expect(changedEvents(e.db)).toHaveLength(0);
    expect(rev(e)).toBe(417);
  });

  it('race: two updates with the same If-Match -> one wins (version 2), the other 409 common.version_conflict; one event', { timeout: T }, async () => {
    const e = withMap({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' });
    const res = await Promise.allSettled([upd(e, ID1, 1, { unit_factor: '0.2' }), upd(e, ID1, 1, { unit_factor: '0.3' })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(mapsOf(e.db)[0]!['version']).toBe(2);
    expect(changedEvents(e.db)).toHaveLength(1);
  });

  it.each([['instrument_id', INST2], ['instrument_code', 'OTHER'], ['analyte_id', RBC.id], ['test_id', MICRO.test.id], ['direction', 'inbound'], ['id', ID(9)], ['version', 5], ['tenant_id', B], ['colour', 'red']])(
    'AC-18.4/immutable: %s in the patch -> 400 (deactivate + create instead); the map is unchanged', { timeout: T }, async (k, v) => {
      const e = withMap();
      validation400(await rejection(upd(e, ID1, 1, { [k]: v })));
      expect(mapsOf(e.db)[0]).toMatchObject({ version: 1, instrument_id: INST, instrument_code: 'HGB', analyte_id: HB.id, direction: 'both' });
      expect(mapWrites(e.db)).toHaveLength(0);
    });

  it.each([
    ['unit_factor on a map WITHOUT units (triple would be partial)', {}, { unit_factor: '0.2' }],
    ['unit_from_raw alone on a map without units', {}, { unit_from_raw: 'g/L' }],
    ['unsetting only one unit field', { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' }, { unset: ['unit_to_code'] }],
    ['unsetting two unit fields', { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' }, { unset: ['unit_from_raw', 'unit_factor'] }],
    ['setting and unsetting the same key', { flag_map: { H: 'HIGH' } }, { flag_map: FLAGS, unset: ['flag_map'] }],
    ['duplicate unset keys', { flag_map: { H: 'HIGH' } }, { unset: ['flag_map', 'flag_map'] }],
    ['unset of a non-clearable key', {}, { unset: ['instrument_code'] }],
    ['unset not an array', {}, { unset: 'flag_map' }],
    ['unit_factor zero', { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' }, { unit_factor: '0' }],
    ['unit_to_code with a slash', { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' }, { unit_to_code: 'g/dl' }],
    ['flag_map not an object text', {}, { flag_map: '[1]' }],
    ['is_active not a boolean', {}, { is_active: 'false' }],
    ['a null patch', {}, null],
  ])('400 validation: %s — map unchanged, no event', { timeout: T }, async (_n, base, patch) => {
    const e = withMap(base);
    validation400(await rejection(upd(e, ID1, 1, patch)));
    expect(mapsOf(e.db)[0]).toMatchObject({ version: 1 });
    expect(changedEvents(e.db)).toHaveLength(0);
  });

  it('reactivation clash: reactivating an inactive inbound map whose key is now owned by an active map -> 409 catalog.code_duplicate; still inactive', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1, { instrument_code: 'HGB', direction: 'inbound', is_active: false }), seed(2, { instrument_code: 'HGB', direction: 'inbound', analyte_id: RBC.id })] });
    lims(await rejection(upd(e, ID1, 1, { is_active: true })), 'catalog.code_duplicate', 409);
    expect(mapsOf(e.db).find((r) => r['id'] === ID1)).toMatchObject({ is_active: false, version: 1 });
    expect(changedEvents(e.db)).toHaveLength(0);
  });

  it('reactivation clash on the OUTBOUND key (instrument, analyte)', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1, { instrument_code: 'HGB', direction: 'outbound', is_active: false }), seed(2, { instrument_code: 'HB2', direction: 'both' })] });
    lims(await rejection(upd(e, ID1, 1, { is_active: true })), 'catalog.code_duplicate', 409);
  });

  it('reactivation without a clash works (the key is free)', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1, { instrument_code: 'HGB', direction: 'inbound', is_active: false }), seed(2, { instrument_code: 'HGB', direction: 'inbound', analyte_id: RBC.id, is_active: false })] });
    expect((await upd(e, ID1, 1, { is_active: true })).is_active).toBe(true);
  });

  it('an inactive map can still be edited (units) while it stays inactive', { timeout: T }, async () => {
    const e = withMap({ is_active: false, unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' });
    const out = await upd(e, ID1, 1, { unit_factor: '0.3' });
    expect([out.is_active, out.unit_factor]).toEqual([false, '0.3']);
  });

  it('unknown id and ANOTHER tenant\'s id -> 404 common.not_found (S-1); that map is untouched; a non-uuid id -> 400', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1), icm(2, B, INST, { instrument_code: 'THEIRS', analyte_id: HB_B.id, test_id: TEST_B.test.id })] });
    lims(await rejection(upd(e, ID(0xdead), 1, { is_active: false })), 'common.not_found', 404);
    lims(await rejection(upd(e, ID(0xb002), 1, { is_active: false })), 'common.not_found', 404);
    lims(await rejection(upd(e, ID1, 1, { is_active: false }, { tenantId: B })), 'common.not_found', 404);
    expect(mapsOf(e.db).map((r) => [r['id'], r['version'], r['is_active']])).toEqual([[ID1, 1, true], [ID(0xb002), 1, true]].sort());
    validation400(await rejection(upd(e, 'not-a-uuid', 1, { is_active: false })));
  });

  it('S-1: statements on the table name tenant_id; the update is guarded by the version (WHERE ... version)', { timeout: T }, async () => {
    const e = withMap({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' });
    await upd(e, ID1, 1, { unit_factor: '0.2' });
    for (const s of mapStmts(e.db)) expect(s.text, s.text).toMatch(/tenant_id/i);
    expect(mapWrites(e.db).some((s) => /^\s*UPDATE/i.test(s.text) && /version/i.test(s.text))).toBe(true);
  });
});

// ====================================================================================================== LIST
describe('listInstrumentCodeMaps (#92)', () => {
  const world = () => setup27({ maps: [
    seed(1, { instrument_code: 'AAA', direction: 'inbound' }),
    seed(2, { instrument_code: 'BBB', direction: 'outbound', analyte_id: RBC.id }),
    seed(3, { instrument_code: 'CCC', direction: 'both', analyte_id: PLT.id }),
    seed(4, { instrument_code: 'DDD', direction: 'inbound', analyte_id: WBC.id, is_active: false }),
    seed(5, { instrument_code: 'EEE', direction: 'inbound', analyte_id: RBC.id }),
    icm(6, A, INST2, { instrument_code: 'AAA', analyte_id: HB.id, test_id: CBC.test.id }),
    icm(7, B, INST, { instrument_code: 'AAA', analyte_id: HB_B.id, test_id: TEST_B.test.id }),
  ] });
  const codes = (r: { data: Array<{ instrument_code: string }> }) => r.data.map((x) => x.instrument_code).sort();

  it('instrument_id is required (uuid): missing / malformed -> 400', { timeout: T }, async () => {
    const e = world();
    validation400(await rejection(list(e, {})));
    validation400(await rejection(list(e, undefined)));
    validation400(await rejection(list(e, { instrument_id: 'inst-1' })));
  });

  it('returns the instrument\'s ACTIVE maps of the caller\'s tenant by default: other instrument and other tenant are invisible; page.limit defaults to 50', { timeout: T }, async () => {
    const r = await list(world(), { instrument_id: INST });
    expect(codes(r)).toEqual(['AAA', 'BBB', 'CCC', 'EEE']);
    expect(r.page).toMatchObject({ limit: 50 });
    expect(r.page).not.toHaveProperty('next_cursor');
    expect(r.data.every((x: Row) => x['instrument_id'] === INST)).toBe(true);
    expect(codes(await list(world(), { instrument_id: INST2 }))).toEqual(['AAA']);
    expect(codes(await list(world(), { instrument_id: INST }, B))).toEqual(['AAA']);
    expect((await list(world(), { instrument_id: INST }, B)).data[0].analyte_id).toBe(HB_B.id);
  });

  it('is_active: "true" (default) / "false" / "all"', { timeout: T }, async () => {
    const e = world();
    expect(codes(await list(e, { instrument_id: INST, is_active: 'false' }))).toEqual(['DDD']);
    expect(codes(await list(e, { instrument_id: INST, is_active: 'all' }))).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    expect(codes(await list(e, { instrument_id: INST, is_active: 'true' }))).toEqual(['AAA', 'BBB', 'CCC', 'EEE']);
    validation400(await rejection(list(e, { instrument_id: INST, is_active: 'maybe' })));
  });

  it('filters: direction (exact) and analyte_id', { timeout: T }, async () => {
    const e = world();
    expect(codes(await list(e, { instrument_id: INST, direction: 'inbound' }))).toEqual(['AAA', 'EEE']);
    expect(codes(await list(e, { instrument_id: INST, direction: 'both' }))).toEqual(['CCC']);
    expect(codes(await list(e, { instrument_id: INST, analyte_id: RBC.id }))).toEqual(['BBB', 'EEE']);
    expect(codes(await list(e, { instrument_id: INST, analyte_id: HB.id, direction: 'outbound' }))).toEqual([]);
    validation400(await rejection(list(e, { instrument_id: INST, direction: 'sideways' })));
    validation400(await rejection(list(e, { instrument_id: INST, analyte_id: 'x' })));
  });

  it('DTO of every element: exactly the InstrumentCodeMap keys (units / flag_map only when set; flag_map as JSON text)', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1, { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1', flag_map: { H: 'HIGH' } }), seed(2, { instrument_code: 'PLAIN', analyte_id: RBC.id })] });
    const r = await list(e, { instrument_id: INST });
    const rich = r.data.find((x: Row) => x['instrument_code'] === 'S1');
    const plain = r.data.find((x: Row) => x['instrument_code'] === 'PLAIN');
    expect(Object.keys(rich).sort()).toEqual([...DTO_BASE, 'unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map'].sort());
    expect(JSON.parse(rich.flag_map)).toEqual({ H: 'HIGH' });
    expect(Object.keys(plain).sort()).toEqual([...DTO_BASE].sort());
  });

  it('cursor paging: limit 2 over 5 maps -> 3 pages, every map exactly once, next_cursor only while more remain', { timeout: T }, async () => {
    const e = setup27({ maps: Array.from({ length: 5 }, (_, i) => seed(i + 1, { instrument_code: `P${i}`, analyte_id: HB.id, direction: 'inbound' })) });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await list(e, { instrument_id: INST, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.page.limit).toBe(2);
      expect(r.data.length).toBeLessThanOrEqual(2);
      seen.push(...r.data.map((x: Row) => x['id']));
      cursor = r.page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it('limit 1..200 accepted (strings from the query too), 0 / 201 / non-numeric -> 400; garbage cursor -> 400 common.invalid_cursor; unknown query key -> 400', { timeout: T }, async () => {
    const e = world();
    expect((await list(e, { instrument_id: INST, limit: '200' })).page.limit).toBe(200);
    expect((await list(e, { instrument_id: INST, limit: 1 })).data).toHaveLength(1);
    for (const limit of [0, 201, 'abc', -1]) validation400(await rejection(list(e, { instrument_id: INST, limit })));
    lims(await rejection(list(e, { instrument_id: INST, cursor: '!!!not-a-cursor!!!' })), 'common.invalid_cursor', 400);
    validation400(await rejection(list(e, { instrument_id: INST, colour: 'red' })));
  });

  it('read-only: no write statement, no event, no revision change; every statement on the table names tenant_id', { timeout: T }, async () => {
    const e = world();
    await list(e, { instrument_id: INST, is_active: 'all' });
    expect(mapWrites(e.db)).toHaveLength(0);
    expect(changedEvents(e.db)).toHaveLength(0);
    expect(rev(e)).toBe(417);
    for (const s of mapStmts(e.db)) expect(s.text, s.text).toMatch(/tenant_id/i);
  });

  it('SQL injection in the filters is rejected as validation, never executed', { timeout: T }, async () => {
    const e = world();
    validation400(await rejection(list(e, { instrument_id: `${INST}' OR '1'='1` })));
    validation400(await rejection(list(e, { instrument_id: INST, analyte_id: "x' OR 1=1 --" })));
    expect(mapStmts(e.db)).toHaveLength(0);
  });
});

// ====================================================================================================== BULK UPSERT
describe('upsertInstrumentCodeMaps (#95) — AC-18.5 per-row outcomes', () => {
  const body = (maps: unknown[], o: Record<string, unknown> = {}) => ({ instrument_id: INST, maps, ...o });
  const outcomes = (r: { results: Array<{ outcome: string }> }) => r.results.map((x) => x.outcome);

  it('creates new rows: 200 {results[]} aligned with the input, each echoing direction / instrument_code / analyte_id with the new map_id and outcome "created"', { timeout: T }, async () => {
    const e = setup27();
    const r = await bulk(e, body([row({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' }), row({ direction: 'outbound', instrument_code: 'RBC1', analyte_id: RBC.id })]));
    expect(r.results).toEqual([
      { direction: 'inbound', instrument_code: 'HGB', analyte_id: HB.id, map_id: r.results[0].map_id, outcome: 'created' },
      { direction: 'outbound', instrument_code: 'RBC1', analyte_id: RBC.id, map_id: r.results[1].map_id, outcome: 'created' },
    ]);
    expect(r.results[0].map_id).toMatch(UUIDV7);
    expect(mapsOf(e.db).map((m) => [m['id'], m['instrument_id'], m['direction'], m['tenant_id']])).toEqual(
      [[r.results[0].map_id, INST, 'inbound', A], [r.results[1].map_id, INST, 'outbound', A]]);
    expect(rev(e)).toBeGreaterThan(417);
    expect(changedEvents(e.db).every((x) => (x.envelope.payload as Row)['entity_type'] === 'instrument_code_map')).toBe(true);
  });

  it('keyed upsert: the same row again is "unchanged" (no write, no revision, no event); a changed unit is "updated" (version 2)', { timeout: T }, async () => {
    const e = setup27();
    const r1 = await bulk(e, body([row({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' })]));
    const rev1 = rev(e), ev1 = changedEvents(e.db).length;
    const writes1 = mapWrites(e.db).length;
    const r2 = await bulk(e, body([row({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' })]));
    expect(r2.results).toEqual([{ direction: 'inbound', instrument_code: 'HGB', analyte_id: HB.id, map_id: r1.results[0].map_id, outcome: 'unchanged' }]);
    expect([rev(e), changedEvents(e.db).length, mapWrites(e.db).length]).toEqual([rev1, ev1, writes1]);
    const r3 = await bulk(e, body([row({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.2' })]));
    expect(r3.results[0]).toMatchObject({ outcome: 'updated', map_id: r1.results[0].map_id });
    expect(mapsOf(e.db)).toHaveLength(1);
    expect(mapsOf(e.db)[0]).toMatchObject({ version: 2, unit_factor: '0.2' });
    expect(rev(e)).toBeGreaterThan(rev1);
  });

  it('a numerically equal factor ("0.10" vs "0.1") and the same flag_map in another key order are "unchanged" — no spurious version bump', { timeout: T }, async () => {
    const e = setup27();
    await bulk(e, body([row({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1', flag_map: '{"H":"HIGH","L":"LOW"}' })]));
    const r = await bulk(e, body([row({ unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.10', flag_map: '{"L":"LOW","H":"HIGH"}' })]));
    expect(outcomes(r)).toEqual(['unchanged']);
    expect(mapsOf(e.db)[0]!['version']).toBe(1);
  });

  it('is_active:false on an existing keyed row deactivates it ("updated"); the key is then free for a new row', { timeout: T }, async () => {
    const e = setup27();
    const r1 = await bulk(e, body([row()]));
    const r2 = await bulk(e, body([row({ is_active: false })]));
    expect(r2.results[0]).toMatchObject({ outcome: 'updated', map_id: r1.results[0].map_id });
    expect(mapsOf(e.db)[0]!['is_active']).toBe(false);
    const r3 = await bulk(e, body([row({ analyte_id: RBC.id })]));
    expect(r3.results[0].outcome).toBe('created');
  });

  it('AC-18.4 per row: a mismatched analyte/test pair is an error row `common.validation_failed`, another tenant\'s ids an error row `common.not_found` — the valid rows around them are STILL applied', { timeout: T }, async () => {
    const e = setup27();
    const r = await bulk(e, body([
      row({ instrument_code: 'OK1' }),
      row({ instrument_code: 'BADPAIR', test_id: MICRO.test.id }),
      row({ instrument_code: 'XT', analyte_id: HB_B.id, test_id: TEST_B.test.id }),
      row({ instrument_code: 'XA', analyte_id: HB_B.id }),
      row({ instrument_code: 'OK2', analyte_id: RBC.id }),
    ]));
    expect(outcomes(r)).toEqual(['created', 'error', 'error', 'error', 'created']);
    expect(r.results.map((x: Row) => x['error_code'])).toEqual([undefined, 'common.validation_failed', 'common.not_found', 'common.not_found', undefined]);
    expect(r.results[1]).toMatchObject({ direction: 'inbound', instrument_code: 'BADPAIR', analyte_id: HB.id });
    expect(r.results[1]).not.toHaveProperty('map_id');
    expect(mapsOf(e.db).map((m) => m['instrument_code'])).toEqual(['OK1', 'OK2']);
    expect(mapsOf(e.db, B)).toHaveLength(0);
  });

  it('an in-batch conflict with an existing active map (same inbound code, another analyte; or the outbound analyte under another code) is an error row `catalog.code_duplicate`; earlier rows persist (per-row savepoint), later rows still run', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1, { instrument_code: 'HGB', direction: 'inbound' }), seed(2, { instrument_code: 'RB', direction: 'outbound', analyte_id: RBC.id })] });
    const r = await bulk(e, body([
      row({ instrument_code: 'NEW1', analyte_id: PLT.id }),
      row({ instrument_code: 'HGB', analyte_id: RBC.id }),
      row({ direction: 'outbound', instrument_code: 'RB2', analyte_id: RBC.id }),
      row({ instrument_code: 'NEW2', analyte_id: WBC.id }),
    ]));
    expect(outcomes(r)).toEqual(['created', 'error', 'error', 'created']);
    expect(r.results[1].error_code).toBe('catalog.code_duplicate');
    expect(r.results[2].error_code).toBe('catalog.code_duplicate');
    expect(mapsOf(e.db).map((m) => m['instrument_code'])).toEqual(['HGB', 'NEW1', 'NEW2', 'RB']);
    expect(mapsOf(e.db).find((m) => m['instrument_code'] === 'HGB')).toMatchObject({ analyte_id: HB.id, version: 1 });
  });

  it('all rows unchanged or failing -> nothing written: no revision bump, no event', { timeout: T }, async () => {
    const e = setup27({ maps: [seed(1, { instrument_code: 'HGB', direction: 'inbound' })] });
    const r = await bulk(e, body([row(), row({ instrument_code: 'BAD', test_id: MICRO.test.id })]));
    expect(outcomes(r)).toEqual(['unchanged', 'error']);
    expect(rev(e)).toBe(417);
    expect(changedEvents(e.db)).toHaveLength(0);
    expect(mapWrites(e.db)).toHaveLength(0);
  });

  it('the maps are scoped to body.instrument_id: the same code on another instrument is a separate map; tenant B\'s rows are never matched or changed', { timeout: T }, async () => {
    const e = setup27({ maps: [icm(1, B, INST, { instrument_code: 'HGB', analyte_id: HB_B.id, test_id: TEST_B.test.id })] });
    const r = await bulk(e, body([row()]));
    expect(outcomes(r)).toEqual(['created']);
    const r2 = await bulk(e, body([row()], { instrument_id: INST2 }));
    expect(outcomes(r2)).toEqual(['created']);
    expect(mapsOf(e.db, B)[0]).toMatchObject({ version: 1, analyte_id: HB_B.id });
    expect(mapsOf(e.db, A).map((m) => m['instrument_id']).sort()).toEqual([INST, INST2].sort());
  });

  it('exactly 200 rows are accepted and all created; 201 rows or 0 rows -> 400, nothing written', { timeout: T }, async () => {
    const e = setup27();
    const rows200 = Array.from({ length: 200 }, (_, i) => row({ instrument_code: `C${String(i).padStart(3, '0')}` }));
    const ok = await bulk(e, body(rows200));
    expect(ok.results).toHaveLength(200);
    expect(new Set(outcomes(ok))).toEqual(new Set(['created']));
    expect(mapsOf(e.db)).toHaveLength(200);
    const f = setup27();
    validation400(await rejection(bulk(f, body([...rows200, row({ instrument_code: 'C200' })]))));
    validation400(await rejection(bulk(f, body([]))));
    expect(mapsOf(f.db)).toHaveLength(0);
    expect(mapWrites(f.db)).toHaveLength(0);
  });

  it.each([
    ['instrument_id missing', { instrument_id: undefined }], ['instrument_id not a uuid', { instrument_id: 'x' }], ['maps missing', { maps: undefined }], ['maps not an array', { maps: row() }],
    ['extra top-level field tenant_id', { tenant_id: B }], ['extra top-level field colour', { colour: 'red' }],
  ])('400 validation: %s — nothing written', { timeout: T }, async (_n, o) => {
    const e = setup27();
    validation400(await rejection(bulk(e, { instrument_id: INST, maps: [row()], ...o })));
    expect(mapWrites(e.db)).toHaveLength(0);
  });

  it('a structurally invalid row (direction "sideways", row-level mass assignment) never writes: either the whole request is 400 or that row is an error row `common.validation_failed`', { timeout: T }, async () => {
    for (const bad of [row({ direction: 'sideways' }), row({ instrument_code: 'MA', tenant_id: B }), row({ instrument_code: 'MB', instrument_id: INST2 })]) {
      const e = setup27();
      const out = await bulk(e, body([bad])).then((r) => r, (x) => x);
      if (out?.results) { expect(outcomes(out)).toEqual(['error']); expect(out.results[0].error_code).toBe('common.validation_failed'); } else validation400(out);
      expect(mapsOf(e.db)).toHaveLength(0);
    }
  });

  it('AB-20 / S-1: no error row or error body echoes another tenant\'s id existence differently from an unknown id (both common.not_found)', { timeout: T }, async () => {
    const e = setup27();
    const r = await bulk(e, body([row({ instrument_code: 'OTHER', analyte_id: HB_B.id, test_id: TEST_B.test.id }), row({ instrument_code: 'GHOST', analyte_id: ID(0xdeae), test_id: ID(0xdead) })]));
    expect(r.results.map((x: Row) => [x['outcome'], x['error_code']])).toEqual([['error', 'common.not_found'], ['error', 'common.not_found']]);
    expect(r.results[0]).not.toHaveProperty('map_id');
  });

  it('hostile values stay data: SQL text in a code is stored verbatim; statements never contain it', { timeout: T }, async () => {
    const e = setup27();
    const evil = "q'); DELETE FROM catalog.instrument_code_maps;--";
    const r = await bulk(e, body([row({ instrument_code: evil })]));
    expect(outcomes(r)).toEqual(['created']);
    for (const s of mapStmts(e.db)) expect(s.text, s.text).not.toMatch(/DELETE FROM|q'\)/i);
  });

  it('the maps of one request are written in ONE transaction (a failing event insert rolls the whole batch back)', { timeout: T }, async () => {
    const e = setup27();
    e.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(bulk(e, body([row(), row({ instrument_code: 'B2', analyte_id: RBC.id })])));
    expect(mapsOf(e.db)).toHaveLength(0);
    expect(rev(e)).toBe(417);
  });
});

// keep the unused fixture imports honest (ONLY_B / MICRO / TEST_B are part of the world that the cross-tenant cases rely on)
void ONLY_B;
