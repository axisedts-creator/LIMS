// T-27 (C3) world for instrument code maps over the SQL fake (helpers/testsDb.ts, extended for T-27). No service import here, so the fake can be self-tested (instrumentMapsDb.test.ts)
// before the service exists. helpers/t27.ts adds the service under test. Synthetic data only.
import { TENANT_A, TENANT_B } from './catalogDb.js';
import { ID, ana, icm, makeTestsDb, type Row, type T6Table } from './testsDb.js';
import { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState } from './t6.js';
import { CBC, HB, HB_B, M1, M2, M_B, MICRO, NOW, ONLY_B, RBC, T, TEST_B } from './t7.js';

export { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState, ID, icm, CBC, HB, HB_B, MICRO, NOW, ONLY_B, RBC, T, TEST_B, TENANT_A, TENANT_B };
export type { Row };

/** Instruments live in C7 (no FK, R3): any uuid works. */
export const INST = ID(0xf001), INST2 = ID(0xf002), INST_B = ID(0xf003);
/** Analyte of MICRO (tenant A): the "analyte of another test" in the same tenant. */
export const GROWTH = ana(9, TENANT_A, MICRO.test.id, { code: 'GROWTH', name: 'Growth', sort_order: 10 });
export const PLT = ana(10, TENANT_A, CBC.test.id, { code: 'PLT', name: 'Platelet count', sort_order: 30 });
export const WBC = ana(11, TENANT_A, CBC.test.id, { code: 'WBC', name: 'White cell count', sort_order: 40 });

export interface Setup27Db { maps?: Row[]; t6?: Partial<Record<T6Table, Row[]>>; catalog?: unknown }
/** World: tests CBC (analytes HB, RBC, PLT, WBC) / MICRO (GROWTH) of tenant A, tenant B's test with HB_B / ONLY_B; `maps` seeds instrument_code_maps rows (not validated at seed time). */
export const world27Db = (s: Setup27Db = {}) => {
  const t6: Partial<Record<T6Table, Row[]>> = {
    orderables: [CBC.orderable, MICRO.orderable, TEST_B.orderable], tests: [CBC.test, MICRO.test, TEST_B.test],
    analytes: [HB, RBC, PLT, WBC, GROWTH, HB_B, ONLY_B], instrument_code_maps: s.maps ?? [], ...s.t6,
  };
  return makeTestsDb({
    rows: { departments: [HAEM, BIOC, HAEM_B], specimen_types: [EDTA, SERUM, EDTA_B], containers: [LAV, LAV_B], methods: [M1, M2, M_B] },
    t6, catalog: (s.catalog ?? seedState) as never,
  });
};
type Db27 = ReturnType<typeof world27Db>;

/** The AC-18.1 body (C7's UI posts it) + `test_id`, which the OpenAPI InstrumentCodeMapCreate requires. */
export const hgbBody = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({
  instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id, unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1', ...o,
}).filter(([, v]) => v !== undefined));
/** A bulk row (InstrumentCodeMapRow). */
export const row = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({ direction: 'inbound', instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id, ...o }).filter(([, v]) => v !== undefined));

/** Committed instrument_code_maps rows (all tenants unless filtered), by instrument_code then id. */
export const mapsOf = (db: Db27, tenantId?: string) =>
  db.rows('instrument_code_maps', tenantId).sort((a, b) => (a['instrument_code'] < b['instrument_code'] ? -1 : a['instrument_code'] > b['instrument_code'] ? 1 : a['id'] < b['id'] ? -1 : 1));
/** Statements that touched the map table. */
export const mapStmts = (db: Db27) => db.t6Stmts().filter((s) => /catalog\.instrument_code_maps\b/i.test(s.text));
export const mapWrites = (db: Db27) => mapStmts(db).filter((s) => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+catalog\./i.test(s.text));
export const changedEvents = (db: Db27, tenant = TENANT_A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');
