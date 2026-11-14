// T-08 (C3) shared test setup: reference-range + critical-limit sets over the SQL fake (helpers/testsDb.ts, extended for T-08). Synthetic data only.
// SEAM (spec silent on names; see .orchestra/notes/C3.T-08-tests.md):
//   catalog/service/ranges.service.ts  export function createRangesService(deps: { events: { publish(ctx, type, input) } })
//     -> one method per operationId #37–#50, snake_case DTOs exactly as contracts/openapi/catalog.yaml (same conventions as createAnalyteVersionsService):
//        listReferenceRangeSets(ctx, { analyte_id, status? })                                           -> { data: RangeSet[] }  (newest first = version_no DESC)
//        createReferenceRangeSetDraft(ctx, { analyte_id, body? })      body = RangeSetDraftCreate | undefined                    -> RangeSet (the 201 body)
//        getReferenceRangeSet(ctx, { id })                                                                                       -> RangeSet
//        replaceReferenceRangeSetBands(ctx, { id, expectedVersion, body })   body = { bands }                                    -> RangeSet
//        publishReferenceRangeSet(ctx, { id, expectedVersion, body })        body = PublishRequest                               -> RangeSet
//        retireReferenceRangeSet(ctx, { id, expectedVersion, body })         body = RetireRequest                                -> RangeSet
//        discardReferenceRangeSetDraft(ctx, { id, expectedVersion })                                                             -> RangeSet
//        …and the same seven for critical limits: listCriticalLimitSets, createCriticalLimitSetDraft, getCriticalLimitSet, replaceCriticalLimitSetBands,
//        publishCriticalLimitSet, retireCriticalLimitSet, discardCriticalLimitSetDraft (CriticalSet / CriticalBand DTOs).
//     ctx = core HandlerContext subset { tenantId, actor, requestId, tx, now, events }; "now" is ctx.now() (ISO string), never the wall clock. Errors are LimsError.
//     The service does NOT check permissions (handlers/ranges.handlers.ts does, through IdentityPort.assertRole).
//   Draft writes (create / replace bands / discard) bump nothing and emit nothing; publish and retire bump the revision once in the SAME tx
//   (entityType 'reference_range' | 'critical_limit', entityId = the SET id, changeKind 'versioned', effective_from = the set's / the retire time) and stamp
//   orderables.revision of the analyte's OWNING test (02-TRD §3, §9.1).
//   Band order in a DTO = ORDER BY sort_order, id. A CriticalBand has no sort_order in the DTO: the service stores the array position as sort_order.
import { TENANT_A, TENANT_B } from './catalogDb.js';
import { spec as specimen } from './mastersDb.js';
import { ID, cband, cset, makeTestsDb, rband, rset, type Row, type T6Table } from './testsDb.js';
import { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState } from './t6.js';
import { CBC, HB, HB_B, HB_V1, M1, M2, M_B, MICRO, NOW, NOW_MS, SEC, DAY, T, T0, T1, TEST_B, at, ana, anv, draftOf, pubOf, pnl, tst } from './t7.js';

export { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState, ID, CBC, HB, HB_B, HB_V1, M1, M2, M_B, MICRO, NOW, NOW_MS, SEC, DAY, T, T0, T1, TEST_B, at, ana, anv,
  draftOf, pubOf, pnl, tst, rset, rband, cset, cband, TENANT_A, TENANT_B };
export type { Row };

/** Specimen types for band specificity: EDTA (seeded in t6), SERUM, and URINE (tenant A) + tenant B's URINE. */
export const URINE = specimen(7, TENANT_A, { code: 'URINE', report_label: 'URINE' });
export const URINE_B = specimen(8, TENANT_B, { code: 'URINE', report_label: 'URINE' });

/** Analytes of the world (all under test CBC unless noted): HB numeric g_dl/M1 1 decimal; K numeric mmol_l, no method; NIT ordinal (URINE_SEMIQ); MENTZER numeric. */
export const K = ana(5, TENANT_A, CBC.test.id, { code: 'K', name: 'Potassium', sort_order: 40 });
export const NIT = ana(6, TENANT_A, CBC.test.id, { code: 'NIT', name: 'Nitrite', sort_order: 50 });
export const MENTZER = ana(7, TENANT_A, CBC.test.id, { code: 'MENTZER', name: 'Mentzer index', sort_order: 60 });
export const K_V1 = pubOf(5, K.id, { unit_code: 'mmol_l', decimals: 1, method_id: null });
export const NIT_V1 = pubOf(6, NIT.id, { result_type: 'ordinal', unit_code: null, decimals: null, method_id: null, value_set_code: 'URINE_SEMIQ' });
export const MENTZER_V1 = pubOf(7, MENTZER.id, { unit_code: null, decimals: 1, method_id: null });
/** A draft version of HB that changes unit and method (the snapshot source when an analyte has an open draft). */
export const HB_V2_UNIT = draftOf(2, HB.id, { unit_code: 'mmol_l', method_id: M2.id, decimals: 1 });

/** Coded values of the global ordered set URINE_SEMIQ (read for ordinal normal_codes / abnormal_codes). */
export const VALUES: Partial<Record<T6Table, Row[]>> = {
  g_value_sets: [{ id: ID(0x5001), code: 'URINE_SEMIQ', display: 'Urine semi-quantitative', is_ordered: true }],
  g_value_set_values: [
    { id: ID(0x5101), value_set_code: 'URINE_SEMIQ', code: 'NEG', display: 'Negative', sort_order: 1 },
    { id: ID(0x5102), value_set_code: 'URINE_SEMIQ', code: 'TRACE', display: 'Trace', sort_order: 2 },
    { id: ID(0x5103), value_set_code: 'URINE_SEMIQ', code: 'POS_1', display: 'Positive 1+', sort_order: 3 },
  ],
};

export interface Setup8 { t6?: Partial<Record<T6Table, Row[]>> }

const BASE: Partial<Record<T6Table, Row[]>> = {
  orderables: [CBC.orderable, MICRO.orderable, TEST_B.orderable], tests: [CBC.test, MICRO.test, TEST_B.test],
  analytes: [HB, K, NIT, MENTZER, HB_B], analyte_versions: [HB_V1, K_V1, NIT_V1, MENTZER_V1, anv(4, TENANT_B, HB_B.id, { unit_code: 'g_dl', decimals: 1 })], ...VALUES,
};
const merge = (a: Partial<Record<T6Table, Row[]>>, b: Partial<Record<T6Table, Row[]>>) =>
  Object.fromEntries((Object.keys({ ...a, ...b }) as T6Table[]).map((k) => [k, [...(a[k] ?? []), ...(b[k] ?? [])]]));

/** World: tenant A tests CBC / MICRO with analytes HB (v1 published) K, NIT, MENTZER, and tenant B's test + analyte. `t6` ADDS rows (sets, bands, versions). */
export const world8Db = (s: Setup8 = {}) => makeTestsDb({
  rows: { departments: [HAEM, BIOC, HAEM_B], specimen_types: [EDTA, SERUM, EDTA_B, URINE, URINE_B], containers: [LAV, LAV_B], methods: [M1, M2, M_B] },
  t6: merge(BASE, s.t6 ?? {}), catalog: seedState,
});

/** A draft set row (no published_*, no effective_from). */
export const draftSet = (mk: typeof rset | typeof cset, n: number, analyteId: string, o: Row = {}): Row =>
  mk(n, TENANT_A, analyteId, { version_no: 2, status: 'draft', effective_from: null, published_at: null, change_reason: null, ...o });

export const pBody = (o: Record<string, unknown> = {}) => ({ change_reason: 'ranges reviewed by the pathologist', ...o });
export const rBody = (o: Record<string, unknown> = {}) => ({ change_reason: 'method withdrawn', ...o });

/** A family = reference-range sets or critical-limit sets: names, tables, DTO band builder, seed band builder. */
export interface Family {
  readonly name: string; readonly label: string;
  readonly list: string; readonly create: string; readonly get: string; readonly replace: string; readonly publish: string; readonly retire: string; readonly discard: string;
  readonly setTable: 'reference_range_sets' | 'critical_limit_sets'; readonly bandTable: 'reference_ranges' | 'critical_limits';
  readonly entity: 'reference_range' | 'critical_limit'; readonly schema: 'RangeSet' | 'CriticalSet'; readonly listSchema: 'RangeSetList' | 'CriticalSetList';
  readonly mkSet: typeof rset; readonly mkBand: typeof rband;
  /** A valid DTO band (override any field). */
  readonly band: (o?: Record<string, unknown>) => Record<string, unknown>;
  /** Fields of a DTO band that must be rejected, each with the offending band. */
  readonly bad: ReadonlyArray<readonly [string, Record<string, unknown>]>;
  /** A DTO band carrying a code list (normal_codes / abnormal_codes) for the ordinal analyte NIT. */
  readonly codeBand: (codes: string[]) => Record<string, unknown>;
  readonly codesField: 'normal_codes' | 'abnormal_codes';
}

const AGE_BAD: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['unknown sex other', { sex: 'other' }], ['unknown sex unknown', { sex: 'unknown' }], ['age_low unit decade', { age_low: { value: 1, unit: 'decade' } }],
  ['age_low value 201', { age_low: { value: 201, unit: 'year' } }], ['age_low value -1', { age_low: { value: -1, unit: 'year' } }],
  ['age_high value 0 (DB CHECK 1..200)', { age_high: { value: 0, unit: 'day' } }], ['age_high value 201', { age_high: { value: 201, unit: 'year' } }],
  ['age_low without unit', { age_low: { value: 1 } }], ['age_high as number', { age_high: 5 }], ['low > high', { low: '17.0', high: '13.0' }],
  ['low not a decimal', { low: 'abc' }], ['high not a decimal', { high: '1e3' }], ['specimen_type_id not a uuid', { specimen_type_id: 'urine' }],
  ['extra field tenant_id', { tenant_id: TENANT_B }], ['extra field set_id', { set_id: ID(1) }], ['extra field id', { id: ID(1) }],
];

export const REF: Family = {
  name: 'reference-range', label: 'reference range', list: 'listReferenceRangeSets', create: 'createReferenceRangeSetDraft', get: 'getReferenceRangeSet', replace: 'replaceReferenceRangeSetBands',
  publish: 'publishReferenceRangeSet', retire: 'retireReferenceRangeSet', discard: 'discardReferenceRangeSetDraft', setTable: 'reference_range_sets', bandTable: 'reference_ranges',
  entity: 'reference_range', schema: 'RangeSet', listSchema: 'RangeSetList', mkSet: rset, mkBand: rband, codesField: 'normal_codes',
  band: (o = {}) => ({ sex: 'any', kind: 'numeric', low: '13.0', high: '17.0', sort_order: 0, ...o }),
  codeBand: (codes) => ({ sex: 'any', kind: 'ordinal', normal_codes: codes, display_text: 'Negative', sort_order: 0 }),
  bad: [
    ...AGE_BAD,
    ['kind bogus', { kind: 'bogus' }], ['kind missing', { kind: undefined }], ['sort_order missing', { sort_order: undefined }], ['sort_order 10000', { sort_order: 10_000 }],
    ['numeric without low and high', { low: undefined, high: undefined }], ['text without display_text', { kind: 'text', low: undefined, high: undefined }],
    ['text WITH low/high', { kind: 'text', display_text: 'Negative', low: '1.0' }], ['ordinal without normal_codes', { kind: 'ordinal', low: undefined, high: undefined, display_text: 'Negative' }],
    ['ordinal with 21 codes', { kind: 'ordinal', low: undefined, high: undefined, display_text: 'x', normal_codes: Array.from({ length: 21 }, (_, i) => `C${i}`) }],
    ['normal_codes item lower case', { kind: 'ordinal', low: undefined, high: undefined, display_text: 'x', normal_codes: ['neg'] }],
    ['display_text 501 chars', { display_text: 'x'.repeat(501) }],
  ],
};

export const CRIT: Family = {
  name: 'critical-limit', label: 'critical limit', list: 'listCriticalLimitSets', create: 'createCriticalLimitSetDraft', get: 'getCriticalLimitSet', replace: 'replaceCriticalLimitSetBands',
  publish: 'publishCriticalLimitSet', retire: 'retireCriticalLimitSet', discard: 'discardCriticalLimitSetDraft', setTable: 'critical_limit_sets', bandTable: 'critical_limits',
  entity: 'critical_limit', schema: 'CriticalSet', listSchema: 'CriticalSetList', mkSet: cset, mkBand: cband, codesField: 'abnormal_codes',
  /** A CriticalBand has no sort_order in the DTO (the service stores the array position): any sort_order given is dropped so tests can share band builders. */
  band: (o = {}) => { const { sort_order: _drop, ...b } = { sex: 'any', low: '2.5', high: '6.5', ...o }; return b; },
  codeBand: (codes) => ({ sex: 'any', abnormal_codes: codes }),
  bad: [
    ...AGE_BAD,
    ['neither limits nor codes', { low: undefined, high: undefined }], ['abnormal_codes item lower case', { abnormal_codes: ['pos'] }],
    ['abnormal_codes 21 items', { low: undefined, high: undefined, abnormal_codes: Array.from({ length: 21 }, (_, i) => `C${i}`) }],
    ['extra field kind', { kind: 'numeric' }], ['extra field normal_codes', { normal_codes: ['NEG'] }],
  ],
};
export const FAMILIES = [REF, CRIT] as const;

/** Statements that touched the four range tables. */
type Db8 = ReturnType<typeof world8Db>;
export const rangeStmts = (db: Db8) => db.t6Stmts().filter((s) => /catalog\.(reference_range_sets|reference_ranges|critical_limit_sets|critical_limits)\b/i.test(s.text));
/** Committed rows of a set table for one analyte, by version_no. */
export const setsOf = (db: Db8, f: Family, analyteId: string) => db.rows(f.setTable).filter((r) => r['analyte_id'] === analyteId).sort((a, b) => a['version_no'] - b['version_no']);
/** Committed bands of one set, in storage order (sort_order, id). */
export const bandsOf = (db: Db8, f: Family, setId: string) => db.rows(f.bandTable).filter((r) => r['set_id'] === setId).sort((a, b) => a['sort_order'] - b['sort_order'] || (a['id'] < b['id'] ? -1 : 1));
export const ownerRev = (db: Db8) => db.orderableRevision(CBC.test.id);
