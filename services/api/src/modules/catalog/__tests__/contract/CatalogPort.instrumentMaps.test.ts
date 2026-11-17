// T-27 (C3) — the REAL CatalogPort.mapInstrumentCode (03-IC §4.2 contract cases (11) round trip and (12) unmapped).
// Spec: 03-IC §4.2 (InstrumentCodeQuery / InstrumentCodeMapping, "@throws catalog.instrument_code_unmapped", ownership note X4), error catalog (catalog.instrument_code_unmapped, 422),
//       02-TRD §6.1 (method table: also an inbound query without `instrumentCode`, or an outbound one without `analyteId`/`testId`, is catalog.instrument_code_unmapped) and §7.8
//       (inbound: ACTIVE map, instrument_id + instrument_code exact and case-sensitive, direction in {inbound, both}; outbound: ACTIVE map by (instrument_id, analyte_id) or, if only testId
//       is given, the LOWEST instrument_code among the test's analytes, direction in {outbound, both}; `unitConversion` only when all three unit fields are set; `flagMap` when set),
//       PRD AC-18.1 (round trip with the map the UI created), AC-18.2 (no active map -> catalog.instrument_code_unmapped), 07-SECURITY S-1 (port probes: tenant from ctx only).
// The shared suite packages/fakes/contract-tests/CatalogPort.contract.ts (cases 11–12, fixture key `instrumentMaps`) runs against the real impl when T-29 wires its fixture->rows harness;
// here the same cases are asserted against rows seeded in the SQL fake (helpers/testsDb.ts, instrument_code_maps modelled with the schema's constraints). World: helpers/t28a.ts.
// Interface: createCatalogPort(deps).mapInstrumentCode(ctx, input) (SEAM: same factory as T-28a; the method is added to ports/CatalogPort.impl.ts).
// ASSUMPTIONS (spec silent): invalid input (non-uuid ids, a direction outside inbound|outbound) -> common.validation_failed or catalog.instrument_code_unmapped; a result is a plain
// camelCase object (no snake_case keys, no tenant_id / version / isActive); outbound with BOTH analyteId and testId is not asserted; ties on instrument_code cannot occur (partial unique).
import { describe, expect, it } from 'vitest';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { icm } from '../helpers/testsDb.js';
import { ID, LAB, LHB, LNEW, LORD, RB, REV, RHB, RNG, T, TENANT_A, TENANT_B, TEST_B, call, codeOf, inB, keysOf, one, setup28a, stmtsOf, type Rows } from '../helpers/t28a.js';

const INST = ID(0xf001), INST2 = ID(0xf002);
const A = TENANT_A;
const M = (n: number, o: Record<string, unknown> = {}) => icm(n, A, INST, { instrument_code: `C${n}`, analyte_id: LHB.id, test_id: LAB.test.id, ...o });
const withMaps = (...maps: Array<Record<string, unknown>>) => setup28a({ extra: { instrument_code_maps: maps } as Rows });
const inb = (code: unknown, o: Record<string, unknown> = {}) => ({ instrumentId: INST, direction: 'inbound', instrumentCode: code, ...o });
const outb = (o: Record<string, unknown>) => ({ instrumentId: INST, direction: 'outbound', ...o });
const UNMAPPED = 'catalog.instrument_code_unmapped';
const CONV = { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' };

describe('CatalogPort real impl: mapInstrumentCode shape', () => {
  it('is a function on the port created by createCatalogPort', { timeout: T }, () => {
    expect(typeof setup28a().port['mapInstrumentCode']).toBe('function');
  });
});

describe('contract (11) mapInstrumentCode inbound and outbound round-trip — AC-18.1', () => {
  it('inbound: exact InstrumentCodeMapping (ids, code, analyte, test, unitConversion {fromUnitRaw, toUnitCode, factor}, flagMap)', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both', ...CONV, flag_map: { H: 'HIGH', L: 'LOW' } }));
    expect(await one(env, 'mapInstrumentCode', inb('SHB1'))).toEqual({
      mappingId: ID(0xb001), instrumentId: INST, instrumentCode: 'SHB1', analyteId: LHB.id, testId: LAB.test.id,
      unitConversion: { fromUnitRaw: 'g/L', toUnitCode: 'g_dl', factor: '0.1' }, flagMap: { H: 'HIGH', L: 'LOW' },
    });
  });

  it('outbound by analyteId returns the same mapping (instrumentCode SHB1, same mappingId) — the round trip', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both', ...CONV }));
    const inbound = await one(env, 'mapInstrumentCode', inb('SHB1'));
    const outbound = await one(env, 'mapInstrumentCode', outb({ analyteId: inbound.analyteId }));
    expect([outbound.instrumentCode, outbound.mappingId, outbound.analyteId, outbound.testId]).toEqual(['SHB1', inbound.mappingId, LHB.id, LAB.test.id]);
  });

  it('a map without units / flag map returns NO unitConversion / flagMap keys (absent, not null / undefined-valued)', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'PLAIN', direction: 'both' }));
    for (const input of [inb('PLAIN'), outb({ analyteId: LHB.id })]) {
      const r = await one(env, 'mapInstrumentCode', input);
      expect(Object.keys(r).sort()).toEqual(['analyteId', 'instrumentCode', 'instrumentId', 'mappingId', 'testId']);
    }
  });

  it('flagMap alone is returned without unitConversion, and a unit conversion alone without flagMap', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'FLAGS', flag_map: { H: 'HIGH' } }), M(2, { instrument_code: 'UNITS', analyte_id: LNEW.id, ...CONV }));
    const f = await one(env, 'mapInstrumentCode', inb('FLAGS'));
    expect(f.flagMap).toEqual({ H: 'HIGH' }); expect(f).not.toHaveProperty('unitConversion');
    const u = await one(env, 'mapInstrumentCode', inb('UNITS'));
    expect(u.unitConversion).toEqual({ fromUnitRaw: 'g/L', toUnitCode: 'g_dl', factor: '0.1' }); expect(u).not.toHaveProperty('flagMap');
  });

  it('direction is honoured: inbound-only answers inbound only; outbound-only answers outbound only; both answers both', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'IN', direction: 'inbound', analyte_id: LHB.id }), M(2, { instrument_code: 'OUT', direction: 'outbound', analyte_id: LNEW.id }), M(3, { instrument_code: 'BOTH', direction: 'both', analyte_id: LORD.id }));
    expect((await one(env, 'mapInstrumentCode', inb('IN'))).analyteId).toBe(LHB.id);
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: LHB.id })))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', inb('OUT')))).toBe(UNMAPPED);
    expect((await one(env, 'mapInstrumentCode', outb({ analyteId: LNEW.id }))).instrumentCode).toBe('OUT');
    expect((await one(env, 'mapInstrumentCode', inb('BOTH'))).analyteId).toBe(LORD.id);
    expect((await one(env, 'mapInstrumentCode', outb({ analyteId: LORD.id }))).instrumentCode).toBe('BOTH');
  });

  it('AC-18.1 end to end: the map created through the service (the UI body) is found inbound and outbound by the port (cache keyed by the bumped revision cannot serve a stale miss)', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'mapInstrumentCode', inb('HGB')))).toBe(UNMAPPED);              // warm any negative path before the write
    const { createInstrumentMapsService } = await import('../../service/instrumentMaps.service.js');
    const { createEvents } = await import('../../../../core/events/publish.js');
    const svc = createInstrumentMapsService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Record<string, (c: any, i?: any) => Promise<any>>;
    const created = await env.db.run((ctx) => svc['createInstrumentCodeMap']!(ctx, { instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: LHB.id, test_id: LAB.test.id,
      unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' }));
    const inbound = await one(env, 'mapInstrumentCode', inb('HGB'));
    expect(inbound).toMatchObject({ mappingId: created.id, instrumentCode: 'HGB', analyteId: LHB.id, testId: LAB.test.id, unitConversion: { fromUnitRaw: 'g/L', toUnitCode: 'g_dl', factor: '0.1' } });
    expect((await one(env, 'mapInstrumentCode', outb({ analyteId: LHB.id }))).instrumentCode).toBe('HGB');
    // an edit and a deactivation through the service are visible to the very next request
    await env.db.run((ctx) => svc['updateInstrumentCodeMap']!(ctx, { id: created.id, expectedVersion: 1, patch: { unit_factor: '0.2' } }));
    expect((await one(env, 'mapInstrumentCode', inb('HGB'))).unitConversion.factor).toBe('0.2');
    await env.db.run((ctx) => svc['updateInstrumentCodeMap']!(ctx, { id: created.id, expectedVersion: 2, patch: { is_active: false } }));
    expect(await codeOf(one(env, 'mapInstrumentCode', inb('HGB')))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: LHB.id })))).toBe(UNMAPPED);
  });
});

describe('contract (12) unmapped -> catalog.instrument_code_unmapped — AC-18.2', () => {
  it('(12) no active map for the inbound code -> LimsError catalog.instrument_code_unmapped, HTTP 422', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1' }));
    const x = await one(env, 'mapInstrumentCode', inb('NOPE')).then(() => undefined, (e) => e);
    expect(x).toBeInstanceOf(LimsError);
    expect(isLimsError(x, UNMAPPED)).toBe(true);
    expect(x.statusCode).toBe(422);
  });

  it('no map at all / outbound for an analyte or test without a map -> unmapped', { timeout: T }, async () => {
    const empty = setup28a();
    expect(await codeOf(one(empty, 'mapInstrumentCode', inb('SHB1')))).toBe(UNMAPPED);
    expect(await codeOf(one(empty, 'mapInstrumentCode', outb({ analyteId: LHB.id })))).toBe(UNMAPPED);
    expect(await codeOf(one(empty, 'mapInstrumentCode', outb({ testId: LAB.test.id })))).toBe(UNMAPPED);
    const env = withMaps(M(1, { instrument_code: 'SHB1' }));
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: LNEW.id })))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: ID(0xdead) })))).toBe(UNMAPPED);
  });

  it('an INACTIVE map is not a mapping (inbound, outbound by analyte, outbound by test)', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'OFF', direction: 'both', is_active: false }));
    expect(await codeOf(one(env, 'mapInstrumentCode', inb('OFF')))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: LHB.id })))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ testId: LAB.test.id })))).toBe(UNMAPPED);
  });

  it('an inactive map beside an active map of the same key: the active one answers (partial unique lets both exist)', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'DUP', is_active: false, analyte_id: LNEW.id }), M(2, { instrument_code: 'DUP', analyte_id: LHB.id }));
    expect((await one(env, 'mapInstrumentCode', inb('DUP'))).analyteId).toBe(LHB.id);
  });

  it('TRD §6.1: an inbound query WITHOUT instrumentCode, and an outbound query with neither analyteId nor testId, are catalog.instrument_code_unmapped (not a validation error)', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both' }));
    expect(await codeOf(one(env, 'mapInstrumentCode', { instrumentId: INST, direction: 'inbound' }))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', { instrumentId: INST, direction: 'inbound', analyteId: LHB.id }))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', { instrumentId: INST, direction: 'outbound' }))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', { instrumentId: INST, direction: 'outbound', instrumentCode: 'SHB1' }))).toBe(UNMAPPED);
  });

  it('the instrument is part of the key: the same code on another instrument is unmapped', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both' }));
    expect(await codeOf(one(env, 'mapInstrumentCode', { ...inb('SHB1'), instrumentId: INST2 }))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', { ...outb({ analyteId: LHB.id }), instrumentId: INST2 }))).toBe(UNMAPPED);
  });
});

describe('§7.8 matching rules', () => {
  it('inbound match is EXACT and case-sensitive: other case, padding, LIKE wildcards and prefixes do not match', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'HGB', direction: 'inbound' }));
    expect((await one(env, 'mapInstrumentCode', inb('HGB'))).instrumentCode).toBe('HGB');
    for (const code of ['hgb', 'Hgb', ' HGB', 'HGB ', 'HG', 'HGBX', '%', 'H%', 'HG_', '_GB', 'HGB%', '%GB', '']) expect(await codeOf(one(env, 'mapInstrumentCode', inb(code))), JSON.stringify(code)).toBe(UNMAPPED);
  });

  it('two codes differing only by case are two distinct maps and each resolves to its own analyte', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'Na', analyte_id: LHB.id }), M(2, { instrument_code: 'NA', analyte_id: LNEW.id }));
    expect((await one(env, 'mapInstrumentCode', inb('Na'))).analyteId).toBe(LHB.id);
    expect((await one(env, 'mapInstrumentCode', inb('NA'))).analyteId).toBe(LNEW.id);
  });

  it('outbound by testId: the LOWEST instrument_code among the test\'s analytes with an active outbound/both map; other tests\', inactive and inbound-only maps are ignored', { timeout: T }, async () => {
    const env = withMaps(
      M(1, { instrument_code: 'ZZ9', direction: 'outbound', analyte_id: LHB.id }),
      M(2, { instrument_code: 'MM5', direction: 'both', analyte_id: LNEW.id }),
      M(3, { instrument_code: 'AA1', direction: 'outbound', analyte_id: LORD.id, is_active: false }),   // lowest but inactive
      M(4, { instrument_code: '0IN', direction: 'inbound', analyte_id: LORD.id }),                       // lowest but inbound-only
      M(5, { instrument_code: 'AAA0', direction: 'outbound', analyte_id: RHB.id, test_id: RNG.test.id }), // another test
      icm(6, A, INST2, { instrument_code: 'AA0', direction: 'outbound', analyte_id: LHB.id, test_id: LAB.test.id }),   // another instrument
    );
    const r = await one(env, 'mapInstrumentCode', outb({ testId: LAB.test.id }));
    expect([r.instrumentCode, r.analyteId, r.testId]).toEqual(['MM5', LNEW.id, LAB.test.id]);
    expect((await one(env, 'mapInstrumentCode', outb({ testId: RNG.test.id }))).instrumentCode).toBe('AAA0');
  });

  it('outbound by analyteId ignores the test\'s other analytes', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'A1', direction: 'outbound', analyte_id: LHB.id }), M(2, { instrument_code: 'B1', direction: 'outbound', analyte_id: LNEW.id }));
    expect((await one(env, 'mapInstrumentCode', outb({ analyteId: LNEW.id }))).instrumentCode).toBe('B1');
  });
});

describe('security (S-1, AB-20): tenant isolation, read-only, bound values', () => {
  it('the SAME instrument id and code in two tenants: each tenant resolves ITS OWN analyte, in both directions', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both' }),
      icm(2, TENANT_B, INST, { instrument_code: 'SHB1', direction: 'both', analyte_id: RB.id, test_id: TEST_B.test.id }));
    expect((await one(env, 'mapInstrumentCode', inb('SHB1'))).analyteId).toBe(LHB.id);
    expect((await one(env, 'mapInstrumentCode', inb('SHB1'), inB)).analyteId).toBe(RB.id);
    expect((await one(env, 'mapInstrumentCode', outb({ analyteId: RB.id }), inB)).mappingId).toBe(ID(0xb002));
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: RB.id })))).toBe(UNMAPPED);      // B's analyte asked by A
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: LHB.id }), inB))).toBe(UNMAPPED);  // A's analyte asked by B
  });

  it('a map row of another tenant is never returned: A asking for the code B owns exclusively -> unmapped; B asking for A\'s exclusive code -> unmapped', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'ONLY_A', direction: 'both' }));
    expect(await codeOf(one(env, 'mapInstrumentCode', inb('ONLY_A'), inB))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ analyteId: LHB.id }), inB))).toBe(UNMAPPED);
    expect(await codeOf(one(env, 'mapInstrumentCode', outb({ testId: LAB.test.id }), inB))).toBe(UNMAPPED);
    expect((await one(env, 'mapInstrumentCode', inb('ONLY_A'))).mappingId).toBe(ID(0xb001));
  });

  it('read-only: no INSERT / UPDATE / DELETE / FOR UPDATE, no event, no revision change; every statement on the map table names tenant_id', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both' }));
    const stmts = await stmtsOf(env, async () => {
      await one(env, 'mapInstrumentCode', inb('SHB1'));
      await one(env, 'mapInstrumentCode', outb({ analyteId: LHB.id }));
      await one(env, 'mapInstrumentCode', outb({ testId: LAB.test.id }));
      await codeOf(one(env, 'mapInstrumentCode', inb('NOPE')));
    });
    const mapQueries = stmts.filter((s) => /instrument_code_maps/i.test(s.text));
    expect(mapQueries.length).toBeGreaterThan(0);
    for (const s of stmts) expect(s.text, s.text).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b|\bFOR\s+(UPDATE|SHARE)\b/i);
    for (const s of mapQueries) expect(s.text, s.text).toMatch(/tenant_id/i);
    expect(env.db.events).toHaveLength(0);
    expect(env.db.revisionOf(A)).toBe(REV);
  });

  it('SQL injection: hostile instrument codes are bound values — unmapped, never concatenated, nothing dropped', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both' }));
    const hostile = ["x'; DROP TABLE catalog.instrument_code_maps; --", "' OR '1'='1", 'SHB1\' OR instrument_code LIKE \'%', '\\', '%', '"'];
    const stmts = await stmtsOf(env, async () => { for (const code of hostile) expect(await codeOf(one(env, 'mapInstrumentCode', inb(code))), code).toBe(UNMAPPED); });
    for (const s of stmts) for (const code of hostile) expect(s.text.includes(code), `${code} in ${s.text}`).toBe(false);
    expect((await one(env, 'mapInstrumentCode', inb('SHB1'))).instrumentCode).toBe('SHB1');
  });

  it('malformed input is a typed LimsError (never a crash): non-uuid instrumentId / analyteId / testId, a direction outside inbound|outbound, a non-string code', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both' }));
    const inputs: unknown[] = [
      { instrumentId: 'inst-1', direction: 'inbound', instrumentCode: 'SHB1' }, { instrumentId: INST, direction: 'outbound', analyteId: 'x' }, { instrumentId: INST, direction: 'outbound', testId: 7 },
      { instrumentId: INST, direction: 'both', instrumentCode: 'SHB1' }, { instrumentId: INST, direction: 'sideways', instrumentCode: 'SHB1' }, { instrumentId: INST, instrumentCode: 'SHB1' },
      { instrumentId: INST, direction: 'inbound', instrumentCode: 12 }, { instrumentId: INST, direction: 'inbound', instrumentCode: { $ne: '' } }, { direction: 'inbound', instrumentCode: 'SHB1' },
    ];
    for (const input of inputs) {
      const code = await codeOf(one(env, 'mapInstrumentCode', input));
      expect(['common.validation_failed', UNMAPPED], JSON.stringify(input)).toContain(code);
    }
  });

  it('the result is a plain camelCase InstrumentCodeMapping: no snake_case keys, no tenant / version / active flags / internals', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both', ...CONV, flag_map: { H: 'HIGH' } }));
    const r = await one(env, 'mapInstrumentCode', inb('SHB1'));
    for (const k of keysOf(r).filter((k) => !['H'].includes(k))) expect(k, k).not.toMatch(/_|^(tenantId|version|isActive|createdBy|updatedBy|createdAt|updatedAt)$/);
  });

  it('repeatable: the same input in the same revision gives the same output (03-IC invariant), also within one request (two calls, one ctx)', { timeout: T }, async () => {
    const env = withMaps(M(1, { instrument_code: 'SHB1', direction: 'both', ...CONV }));
    const a = await one(env, 'mapInstrumentCode', inb('SHB1'));
    expect(await one(env, 'mapInstrumentCode', inb('SHB1'))).toEqual(a);
    const [x, y] = await call(env, async (p, ctx) => [await p['mapInstrumentCode']!(ctx, inb('SHB1')), await p['mapInstrumentCode']!(ctx, outb({ analyteId: LHB.id }))]);
    expect(x).toEqual(a);
    expect(y.mappingId).toBe(a.mappingId);
  });
});
