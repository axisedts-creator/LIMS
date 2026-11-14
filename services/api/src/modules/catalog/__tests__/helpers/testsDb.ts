// T-06 (C3) test fixture: in-memory Postgres fake for catalog.orderables / tests / panels / test_specimen_types and (seed-only)
// analytes / analyte_versions, layered on the T-04 fake (mastersDb.ts: departments, specimen_types, containers, methods) and the T-03 fake
// (catalogDb.ts: catalog_state + core.event_log + row lock). One tx facade routes SQL by CONTENT; statements on the T-06 tables are
// handled here, everything else is delegated untouched.
// Modelled for real (05-SCHEMA §4 orderables/tests/test_specimen_types):
//   - RLS: a tx sees/changes only rows of its own tenant; INSERT with a foreign tenant_id raises 42501. A statement WITHOUT a tenant predicate is
//     therefore still safe here — explicit-predicate rules are asserted separately on `stmts`.
//   - READ COMMITTED + lock-then-re-evaluate (same as mastersDb): INSERT/UPDATE/DELETE/SELECT..FOR UPDATE take a lock per (table, tenant) held to
//     COMMIT/ROLLBACK; the WHERE runs AFTER the lock is granted against freshly committed state. Writes are private to the tx until COMMIT.
//   - Constraints: orderables PK / UNIQUE(tenant_id, code) -> 23505, CHECKs -> 23514 (code regex, name length, sex, test_has_department),
//     FK department -> 23503; tests FK (id, kind) -> orderables -> 23503, workflow/report_order CHECKs; test_specimen_types PK(test, specimen_type),
//     partial UNIQUE (tenant_id, test_id) WHERE is_preferred -> 23505, min_volume_ul CHECK, FKs test/specimen type/container -> 23503
//     (specimen types / containers / departments are looked up in COMMITTED masters rows). DELETE is allowed on test_specimen_types only
//     (association table); every other table raises 42501 (lims_app has no DELETE grant).
//   - T-12 (additive): panels and panel_members are WRITABLE. panels: PK, panel_kind enum CHECK -> 23514, FK (id, kind) -> orderables -> 23503, no DELETE (42501).
//     panel_members: PK (tenant_id, panel_id, member_orderable_id) -> 23505, CHECK panel_id <> member_orderable_id -> 23514 (panel_members__not_self__ck),
//     sort_order integer, FK panel / member orderable -> 23503 (looked up among the tx's own-tenant orderables), DELETE allowed (association table).
//   - g_value_sets (global, no tenant) and cs_value_sets
//     (tenant) are SEED-ONLY too (read by the T-07 ordinal check; their writers are T-05).
//   - T-07 (additive): analytes and analyte_versions are WRITABLE (INSERT / UPDATE; no DELETE: 42501). Analytes: PK, UNIQUE(tenant_id, code) -> 23505,
//     CHECKs (code regex, name/print_name/subheading lengths) -> 23514, FK test -> 23503. Analyte versions: PK, UNIQUE(tenant_id, analyte_id, version_no)
//     -> 23505, partial UNIQUE one draft per analyte -> 23505 (analyte_versions__tenant_id_analyte_id__draft__p_uq), CHECKs (status enum WITHOUT
//     'retired', result_type enum, unit/value-set regexes, decimals 0-6, numeric_decimals, valueset, formula_numeric, published_fields, window) -> 23514,
//     FK analyte / method -> 23503, and the two BEFORE UPDATE triggers of 05-SCHEMA §10.2: catalog.tg_version_status (draft->draft|published|discarded,
//     published->published|superseded|retired, nothing else) and app.enforce_mutable_columns when OLD.status <> 'draft' (only status, effective_to,
//     updated_at, updated_by, version may change) -> P0001 'immutable_row' (DETAIL catalog.analyte_versions).
// SQL dialect (anything else throws "fake: unsupported SQL" — the writer must stay inside it; one table per statement, no joins/subqueries):
//   INSERT INTO catalog.<t> (cols) VALUES (exprs)[, (exprs)…] [RETURNING cols|*]
//   SELECT <anything|count(*)> FROM catalog.<t> [alias] [WHERE expr] [ORDER BY expr [ASC|DESC], …] [LIMIT n|$n] [OFFSET n|$n] [FOR UPDATE|SHARE]
//   UPDATE catalog.<t> [alias] SET col = expr, … WHERE expr [RETURNING cols|*]
//   DELETE FROM catalog.test_specimen_types [alias] WHERE expr [RETURNING cols|*]
//   expr: see the dialect in mastersDb.ts (LIKE/ILIKE … ESCAPE, ||, UPPER, LENGTH, CASE, = ANY($n), row tuples, COALESCE …).
// Synthetic data only.
import { STARTED_AT, TENANT_A, USER } from './catalogDb.js';
import { ID, RowLock, makeMastersDb, parseExpr, pgError, splitTop, tick, type MastersSeed, type Row } from './mastersDb.js';

export { ID, type Row };
export const T6_TABLES = ['orderables', 'tests', 'panels', 'panel_members', 'test_specimen_types', 'analytes', 'analyte_versions', 'g_value_sets', 'cs_value_sets', 'g_value_set_values', 'cs_value_set_values',
  'reference_range_sets', 'reference_ranges', 'critical_limit_sets', 'critical_limits', 'formula_dependencies', 'tat_targets', 'instrument_code_maps'] as const;
export type T6Table = (typeof T6_TABLES)[number];
const TABLE_RE = new RegExp(`catalog\\.(${T6_TABLES.join('|')})\\b`, 'i');
const WRITABLE = new Set<T6Table>(['orderables', 'tests', 'panels', 'panel_members', 'test_specimen_types', 'analytes', 'analyte_versions',
  'reference_range_sets', 'reference_ranges', 'critical_limit_sets', 'critical_limits', 'formula_dependencies', 'tat_targets', 'instrument_code_maps']);
// T-27 (additive): catalog.instrument_code_maps (05-SCHEMA "Instrument code maps (X4)"): PK, UNIQUE(tenant_id, id), CHECKs -> 23514 (direction enum, code length 1..64, unit_from_raw <= 32,
// unit_to_code ~ ^[A-Za-z0-9_]{1,32}$, unit_factor > 0, flag_map jsonb object, unit triple all-or-none), the COMPOSITE FK (tenant_id, analyte_id, test_id) -> analytes (tenant_id, id, test_id)
// -> 23503 instrument_code_maps__analyte_test__fk, and the two PARTIAL UNIQUE indexes -> 23505: instrument_code_maps__inbound__p_uq (tenant, instrument_id, instrument_code) WHERE is_active AND
// direction IN (inbound, both); instrument_code_maps__outbound__p_uq (tenant, instrument_id, analyte_id) WHERE is_active AND direction IN (outbound, both). instrument_id has NO FK (R3).
// flag_map is jsonb: a bound JSON string is parsed (22P02 when invalid), an object is stored as is, and rows READ BACK as the parsed object (node-pg). unit_factor is numeric: read back as a string.
// No casts (`::jsonb`) in the fake's dialect. No triggers, no DELETE grant (42501).
// T-14 (additive): catalog.tat_targets (05-SCHEMA TAT targets): PK, priority / segment / target_seconds 60..2592000 / window CHECKs -> 23514, FK (tenant, test) -> 23503,
// partial UNIQUE (tenant, test, priority) WHERE effective_to IS NULL -> 23505 (tat_targets__open__p_uq; NOT deferrable, so insert-before-end fails like real PG).
// UPDATE is plain (no trigger in the schema); no DELETE grant (42501). The partial unique index is checked per statement on the tx's own view.
// T-09 (additive): catalog.formula_dependencies (05-SCHEMA §10.2): PK (tenant_id, analyte_version_id, input_analyte_id), not_self CHECK, three FKs, and the
// tg_parent_is_draft trigger (INSERT/UPDATE/DELETE only while the parent analyte version is a draft -> P0001 'immutable_row'). No DELETE grant in the fake.
// T-08 (additive): range / critical-limit SETS (versioned, like analyte_versions but WITH 'retired') and their BANDS (children: INSERT/UPDATE/DELETE only while the
// parent set is a draft — catalog.tg_parent_is_draft, P0001 'immutable_row'). DELETE is allowed on the two band tables (draft replace-all) and nowhere else new.
const SET_TABLES = new Set<T6Table>(['reference_range_sets', 'critical_limit_sets']);
const BAND_PARENT: Partial<Record<T6Table, T6Table>> = { reference_ranges: 'reference_range_sets', critical_limits: 'critical_limit_sets' };
const SET_COLUMNS = ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'unit_code', 'method_id', 'effective_from', 'effective_to', 'change_reason', 'published_at', 'published_by',
  'source_import_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const BAND_AGE = ['age_low_value', 'age_low_unit', 'age_high_value', 'age_high_unit'];
const UNITS = ['day', 'week', 'month', 'year'];
const GLOBAL = new Set<T6Table>(['g_value_sets', 'g_value_set_values']);                                  // no tenant_id: visible to every tenant
const VERSION_MUTABLE = new Set(['status', 'effective_to', 'updated_at', 'updated_by', 'version']);

const COLUMNS: Record<T6Table, string[]> = {
  orderables: ['id', 'tenant_id', 'kind', 'code', 'name', 'department_id', 'sex_restriction', 'is_orderable', 'revision', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  tests: ['id', 'tenant_id', 'kind', 'workflow_type', 'report_order', 'uses_existing_material', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  panels: ['id', 'tenant_id', 'kind', 'panel_kind', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  panel_members: ['tenant_id', 'panel_id', 'member_orderable_id', 'sort_order', 'created_at', 'created_by'],
  test_specimen_types: ['tenant_id', 'test_id', 'specimen_type_id', 'container_id', 'is_preferred', 'min_volume_ul', 'created_at', 'created_by'],
  analytes: ['id', 'tenant_id', 'test_id', 'code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  analyte_versions: ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'formula_inputs',
    'formula_input_units', 'effective_from', 'effective_to', 'change_reason', 'published_at', 'published_by', 'source_import_id', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  g_value_sets: ['id', 'code', 'display', 'is_ordered', 'is_active'],
  cs_value_sets: ['id', 'tenant_id', 'code', 'display', 'is_ordered', 'is_active'],
  // T-12 (additive, seed-only): the value rows #3 reads for ordinalSetValues (05-SCHEMA g_value_set_values / cs_value_set_values)
  g_value_set_values: ['id', 'value_set_code', 'code', 'display', 'sort_order', 'is_active'],
  cs_value_set_values: ['id', 'tenant_id', 'value_set_id', 'code', 'display', 'sort_order', 'is_active'],
  reference_range_sets: SET_COLUMNS,
  critical_limit_sets: SET_COLUMNS,
  reference_ranges: ['id', 'tenant_id', 'set_id', 'sex', ...BAND_AGE, 'specimen_type_id', 'kind', 'low', 'high', 'normal_codes', 'display_text', 'sort_order', 'created_at', 'created_by'],
  critical_limits: ['id', 'tenant_id', 'set_id', 'sex', ...BAND_AGE, 'specimen_type_id', 'low', 'high', 'abnormal_codes', 'sort_order', 'created_at', 'created_by'],
  formula_dependencies: ['tenant_id', 'analyte_version_id', 'analyte_id', 'input_analyte_id', 'created_at', 'created_by'],
  tat_targets: ['id', 'tenant_id', 'test_id', 'priority', 'segment', 'target_seconds', 'effective_from', 'effective_to', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  instrument_code_maps: ['id', 'tenant_id', 'instrument_id', 'direction', 'instrument_code', 'analyte_id', 'test_id', 'unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map', 'version', 'is_active',
    'created_at', 'created_by', 'updated_at', 'updated_by'],
};
const NOT_NULL: Record<T6Table, string[]> = {
  orderables: ['id', 'tenant_id', 'kind', 'code', 'name', 'is_orderable', 'revision', 'created_by', 'updated_by'],
  tests: ['id', 'tenant_id', 'kind', 'workflow_type', 'report_order', 'uses_existing_material', 'created_by', 'updated_by'],
  panels: ['id', 'tenant_id', 'kind', 'panel_kind', 'created_by', 'updated_by'],
  panel_members: ['tenant_id', 'panel_id', 'member_orderable_id', 'sort_order', 'created_by'],
  test_specimen_types: ['tenant_id', 'test_id', 'specimen_type_id', 'is_preferred', 'created_by'],
  analytes: ['id', 'tenant_id', 'test_id', 'code', 'name', 'created_by', 'updated_by'],
  analyte_versions: ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'result_type', 'created_by', 'updated_by'],
  g_value_sets: ['id', 'code', 'is_ordered'],
  cs_value_sets: ['id', 'tenant_id', 'code', 'is_ordered'],
  g_value_set_values: ['id', 'value_set_code', 'code', 'display', 'sort_order'],
  cs_value_set_values: ['id', 'tenant_id', 'value_set_id', 'code', 'display', 'sort_order'],
  reference_range_sets: ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'created_by', 'updated_by'],
  critical_limit_sets: ['id', 'tenant_id', 'analyte_id', 'version_no', 'status', 'created_by', 'updated_by'],
  reference_ranges: ['id', 'tenant_id', 'set_id', 'sex', 'kind', 'sort_order', 'created_by'],
  critical_limits: ['id', 'tenant_id', 'set_id', 'sex', 'sort_order', 'created_by'],
  formula_dependencies: ['tenant_id', 'analyte_version_id', 'analyte_id', 'input_analyte_id', 'created_by'],
  tat_targets: ['id', 'tenant_id', 'test_id', 'priority', 'segment', 'target_seconds', 'effective_from', 'created_by', 'updated_by'],
  instrument_code_maps: ['id', 'tenant_id', 'instrument_id', 'direction', 'instrument_code', 'analyte_id', 'test_id', 'created_by', 'updated_by'],
};
const WORKFLOWS = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'];
const keyOf = (t: T6Table, r: Row): string => (t === 'test_specimen_types' ? `${r.test_id}:${r.specimen_type_id}` : t === 'panel_members' ? `${r.panel_id}:${r.member_orderable_id}`
  : t === 'formula_dependencies' ? `${r.analyte_version_id}:${r.input_analyte_id}` : r.id);
const LEN = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;

function checks(t: T6Table, r: Row): void {
  const bad = (c: string) => { throw pgError('23514', `new row for relation "${t}" violates check constraint "${c}"`, c); };
  if (t === 'orderables') {
    if (!['test', 'panel'].includes(r.kind)) bad('orderables__kind__ck');
    if (!(typeof r.code === 'string' && /^[A-Z0-9][A-Z0-9_\-+.]{0,31}$/.test(r.code))) bad('orderables__code__ck');
    if (!LEN(r.name, 1, 200)) bad('orderables__name__ck');
    if (r.sex_restriction != null && !['male', 'female'].includes(r.sex_restriction)) bad('orderables__sex__ck');
    if (r.kind === 'test' && r.department_id == null) bad('orderables__test_has_department__ck');
  }
  if (t === 'panels') {
    if (r.kind !== 'panel') bad('panels__kind__ck');
    if (!['clinical', 'package'].includes(r.panel_kind)) bad('panels__panel_kind__ck');
  }
  if (t === 'panel_members') {
    if (r.panel_id === r.member_orderable_id) bad('panel_members__not_self__ck');
    if (!Number.isInteger(r.sort_order)) bad('panel_members__sort_order__ck');
  }
  if (t === 'tests') {
    if (r.kind !== 'test') bad('tests__kind__ck');
    if (!WORKFLOWS.includes(r.workflow_type)) bad('tests__workflow__ck');
    if (!(Number.isInteger(r.report_order) && r.report_order >= 0 && r.report_order <= 9999)) bad('tests__order__ck');
  }
  if (t === 'analytes') {
    if (!(typeof r.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(r.code))) bad('analytes__code__ck');
    if (!LEN(r.name, 1, 120)) bad('analytes__name__ck');
    if (r.print_name != null && !LEN(r.print_name, 0, 120)) bad('analytes__print_name__ck');
    if (r.report_subheading != null && !LEN(r.report_subheading, 0, 80)) bad('analytes__subheading__ck');
  }
  if (t === 'analyte_versions') {
    if (!(Number.isInteger(r.version_no) && r.version_no >= 1)) bad('analyte_versions__no__ck');
    if (!['draft', 'published', 'superseded', 'discarded'].includes(r.status)) bad('analyte_versions__status__ck');
    if (!['numeric', 'text', 'ordinal', 'coded', 'attachment', 'narrative'].includes(r.result_type)) bad('analyte_versions__result_type__ck');
    if (r.unit_code != null && !(typeof r.unit_code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(r.unit_code))) bad('analyte_versions__unit__ck');
    if (r.decimals != null && !(Number.isInteger(r.decimals) && r.decimals >= 0 && r.decimals <= 6)) bad('analyte_versions__decimals__ck');
    if (r.value_set_code != null && !(typeof r.value_set_code === 'string' && /^[A-Z0-9_]{1,32}$/.test(r.value_set_code))) bad('analyte_versions__vs__ck');
    if (r.formula_expression != null && !LEN(r.formula_expression, 0, 500)) bad('analyte_versions__formula__ck');
    if (r.change_reason != null && !LEN(r.change_reason, 0, 500)) bad('analyte_versions__reason__ck');
    if (r.result_type === 'numeric' && r.decimals == null) bad('analyte_versions__numeric_decimals__ck');
    if ((r.result_type === 'ordinal' || r.result_type === 'coded') && r.value_set_code == null) bad('analyte_versions__valueset__ck');
    if (r.formula_expression != null && r.result_type !== 'numeric') bad('analyte_versions__formula_numeric__ck');
    if (!['draft', 'discarded'].includes(r.status) && (r.effective_from == null || r.published_at == null || r.change_reason == null)) bad('analyte_versions__published_fields__ck');
    if (r.effective_to != null && r.effective_from != null && +new Date(r.effective_to) < +new Date(r.effective_from)) bad('analyte_versions__window__ck');
  }
  if (SET_TABLES.has(t)) {
    if (!(Number.isInteger(r.version_no) && r.version_no >= 1)) bad(`${t}__no__ck`);
    if (!['draft', 'published', 'superseded', 'retired', 'discarded'].includes(r.status)) bad(`${t}__status__ck`);
    if (r.unit_code != null && !(typeof r.unit_code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(r.unit_code))) bad(`${t}__unit__ck`);
    if (r.change_reason != null && !LEN(r.change_reason, 0, 500)) bad(`${t}__reason__ck`);
    if (!['draft', 'discarded'].includes(r.status) && (r.effective_from == null || r.published_at == null || r.change_reason == null)) bad(`${t}__published_fields__ck`);
    if (r.effective_to != null && r.effective_from != null && +new Date(r.effective_to) < +new Date(r.effective_from)) bad(`${t}__window__ck`);
  }
  if (t === 'reference_ranges' || t === 'critical_limits') {
    if (!(t === 'reference_ranges' ? ['any', 'male', 'female'] : ['any', 'male', 'female']).includes(r.sex)) bad(`${t}__sex__ck`);
    if (r.age_low_value != null && !(Number.isInteger(r.age_low_value) && r.age_low_value >= 0 && r.age_low_value <= 200)) bad(`${t}__age_low__ck`);
    if (r.age_high_value != null && !(Number.isInteger(r.age_high_value) && r.age_high_value >= 1 && r.age_high_value <= 200)) bad(`${t}__age_high__ck`);
    if (r.age_low_unit != null && !UNITS.includes(r.age_low_unit)) bad(`${t}__age_low_unit__ck`);
    if (r.age_high_unit != null && !UNITS.includes(r.age_high_unit)) bad(`${t}__age_high_unit__ck`);
    if ((r.age_low_value == null) !== (r.age_low_unit == null)) bad(`${t}__age_low_pair__ck`);
    if ((r.age_high_value == null) !== (r.age_high_unit == null)) bad(`${t}__age_high_pair__ck`);
    if (r.low != null && r.high != null && Number(r.low) > Number(r.high)) bad(`${t}__low_le_high__ck`);
  }
  if (t === 'reference_ranges') {
    if (!['numeric', 'text', 'ordinal'].includes(r.kind)) bad('reference_ranges__kind__ck');
    if (r.display_text != null && !LEN(r.display_text, 0, 500)) bad('reference_ranges__text__ck');
    if (r.kind === 'numeric' && r.low == null && r.high == null) bad('reference_ranges__numeric__ck');
    if (r.kind !== 'numeric' && r.display_text == null) bad('reference_ranges__text__req__ck');
    if (r.kind === 'ordinal' && !(Array.isArray(r.normal_codes) && r.normal_codes.length >= 1 && r.normal_codes.length <= 20)) bad('reference_ranges__ordinal__ck');
    if (r.kind !== 'numeric' && (r.low != null || r.high != null)) bad('reference_ranges__nonnumeric_values__ck');
  }
  if (t === 'critical_limits') {
    if (r.low == null && r.high == null && !(Array.isArray(r.abnormal_codes) && r.abnormal_codes.length >= 1)) bad('critical_limits__something__ck');
    if (r.abnormal_codes != null && !(Array.isArray(r.abnormal_codes) && r.abnormal_codes.length <= 20)) bad('critical_limits__codes_max__ck');
  }
  if (t === 'formula_dependencies' && r.analyte_id === r.input_analyte_id) bad('formula_dependencies__not_self__ck');
  if (t === 'tat_targets') {
    if (!['routine', 'urgent'].includes(r.priority)) bad('tat_targets__priority__ck');
    if (!['within_lab', 'total'].includes(r.segment)) bad('tat_targets__segment__ck');
    if (!(Number.isInteger(r.target_seconds) && r.target_seconds >= 60 && r.target_seconds <= 2592000)) bad('tat_targets__seconds__ck');
    if (r.effective_to != null && +new Date(r.effective_to) < +new Date(r.effective_from)) bad('tat_targets__window__ck');
  }
  if (t === 'instrument_code_maps') {
    if (!['inbound', 'outbound', 'both'].includes(r.direction)) bad('icm__direction__ck');
    if (!LEN(r.instrument_code, 1, 64)) bad('icm__code__ck');
    if (r.unit_from_raw != null && !LEN(r.unit_from_raw, 0, 32)) bad('icm__unit_from__ck');
    if (r.unit_to_code != null && !(typeof r.unit_to_code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(r.unit_to_code))) bad('icm__unit_to__ck');
    if (r.unit_factor != null && !(Number.isFinite(Number(r.unit_factor)) && Number(r.unit_factor) > 0)) bad('icm__factor__ck');
    if (r.flag_map != null && !(typeof r.flag_map === 'object' && !Array.isArray(r.flag_map))) bad('icm__flag_map__ck');
    const set = [r.unit_from_raw, r.unit_to_code, r.unit_factor].filter((x) => x != null).length;
    if (set !== 0 && set !== 3) bad('instrument_code_maps__unit_triple__ck');
  }
  if (t === 'test_specimen_types' && r.min_volume_ul != null && !(Number.isInteger(r.min_volume_ul) && r.min_volume_ul >= 1 && r.min_volume_ul <= 100000)) bad('test_specimen_types__vol__ck');
}

export interface TestsSeed extends MastersSeed { t6?: Partial<Record<T6Table, Row[]>> }

export function makeTestsDb(seed: TestsSeed = {}) {
  const masters = makeMastersDb(seed);
  const base = masters.base;
  const committed = new Map<T6Table, Map<string, Row>>(T6_TABLES.map((t) => [t, new Map()]));
  const locks = new Map<string, RowLock>();
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  const lockOf = (k: string) => { let l = locks.get(k); if (!l) locks.set(k, (l = new RowLock())); return l; };
  let seq = 0;

  function fill(t: T6Table, r: Row): Row {
    const o: Row = {};
    for (const c of COLUMNS[t]) o[c] = r[c] ?? null;
    if ('version' in o) o.version = r.version ?? 1;
    if ('is_active' in o) o.is_active = r.is_active ?? true;
    if ('created_at' in o) { o.created_at = r.created_at ?? STARTED_AT; o.created_by = r.created_by ?? USER; }
    if ('updated_at' in o) { o.updated_at = r.updated_at ?? STARTED_AT; o.updated_by = r.updated_by ?? USER; }
    if (t === 'orderables') { o.is_orderable = r.is_orderable ?? true; o.revision = r.revision ?? 0; }
    if (t === 'tests') { o.kind = 'test'; o.report_order = r.report_order ?? 100; o.uses_existing_material = r.uses_existing_material ?? false; }
    if (t === 'panels') o.kind = 'panel';
    if (t === 'test_specimen_types') o.is_preferred = r.is_preferred ?? false;
    if (t === 'analytes') { o.sort_order = r.sort_order ?? 100; o.is_reportable = r.is_reportable ?? true; }
    if (t === 'analyte_versions') { o.formula_inputs = r.formula_inputs ?? []; o.status = r.status ?? 'draft'; }
    if (SET_TABLES.has(t)) o.status = r.status ?? 'draft';
    if (t in BAND_PARENT) o.sort_order = r.sort_order ?? 100;
    if (t === 'g_value_sets' || t === 'cs_value_sets' || t === 'g_value_set_values' || t === 'cs_value_set_values') o.is_active = r.is_active ?? true;
    if (t === 'tat_targets') o.segment = r.segment ?? 'within_lab';
    if (t === 'instrument_code_maps') {
      o.unit_factor = r.unit_factor == null ? null : String(r.unit_factor);
      if (typeof r.flag_map === 'string') { try { o.flag_map = JSON.parse(r.flag_map); } catch { throw pgError('22P02', 'invalid input syntax for type json'); } }
    }
    return o;
  }
  for (const t of T6_TABLES) for (const r of seed.t6?.[t] ?? []) committed.get(t)!.set(keyOf(t, r), fill(t, r));

  function begin(tenantId: string, actorId = USER) {
    const mtx = masters.begin(tenantId, actorId);
    const local = new Map<T6Table, Map<string, Row | null>>(T6_TABLES.map((t) => [t, new Map()]));
    const held = new Set<string>();
    const now = STARTED_AT;
    const visible = (t: T6Table): Row[] => {
      const m = new Map<string, Row>();
      for (const [k, r] of committed.get(t)!) if (GLOBAL.has(t) || r.tenant_id === tenantId) m.set(k, r);
      for (const [k, r] of local.get(t)!) { if (r === null) m.delete(k); else m.set(k, r); }
      return [...m.values()];
    };
    const take = async (t: T6Table) => { const k = `${t}:${tenantId}`; await lockOf(k).acquire(mtx.id); held.add(k); };
    const releaseAll = () => { for (const k of held) lockOf(k).release(mtx.id); held.clear(); };
    // T-25 (additive): the masters tx's OWN uncommitted rows count too (one Postgres transaction sees its own writes: a catalog_master commit creates a department and a test in it).
    const master = (tbl: 'departments' | 'specimen_types' | 'containers' | 'methods', id: unknown) => id != null && ((mtx as any).visibleRow(tbl, String(id)) ?? masters.row(tbl, String(id)))?.tenant_id === tenantId;
    const out = (rows: Row[], returning: string | undefined) => (returning ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] as Row[] });

    /** All constraints for a row about to be written; `self` = the key of the row being replaced (UPDATE) so it does not conflict with itself. */
    function validate(t: T6Table, r: Row, self?: string, pending: Row[] = []): void {
      for (const c of NOT_NULL[t]) if (r[c] == null) throw pgError('23502', `null value in column "${c}" violates not-null constraint`);
      checks(t, r);
      const others = [...visible(t).filter((x) => keyOf(t, x) !== self), ...pending];
      if (t === 'test_specimen_types') {
        if (others.some((x) => keyOf(t, x) === keyOf(t, r))) throw pgError('23505', 'duplicate key value violates unique constraint "test_specimen_types__pk"', 'test_specimen_types__pk');
        if (r.is_preferred && others.some((x) => x.test_id === r.test_id && x.is_preferred)) {
          throw pgError('23505', 'duplicate key value violates unique constraint "test_specimen_types__tenant_id_test_id__preferred__p_uq"', 'test_specimen_types__tenant_id_test_id__preferred__p_uq');
        }
        if (!visible('tests').some((x) => x.id === r.test_id)) throw pgError('23503', 'violates foreign key constraint "test_specimen_types__test__fk"', 'test_specimen_types__test__fk');
        if (!master('specimen_types', r.specimen_type_id)) throw pgError('23503', 'violates foreign key constraint "test_specimen_types__type__fk"', 'test_specimen_types__type__fk');
        if (r.container_id != null && !master('containers', r.container_id)) throw pgError('23503', 'violates foreign key constraint "test_specimen_types__container__fk"', 'test_specimen_types__container__fk');
        return;
      }
      if (t === 'panel_members') {
        if (others.some((x) => keyOf(t, x) === keyOf(t, r))) throw pgError('23505', 'duplicate key value violates unique constraint "panel_members__pk"', 'panel_members__pk');
        if (!visible('panels').some((x) => x.id === r.panel_id)) throw pgError('23503', 'violates foreign key constraint "panel_members__panel__fk"', 'panel_members__panel__fk');
        if (!visible('orderables').some((x) => x.id === r.member_orderable_id)) throw pgError('23503', 'violates foreign key constraint "panel_members__member__fk"', 'panel_members__member__fk');
        return;
      }
      if (t === 'formula_dependencies') {
        const fk = (c: string) => pgError('23503', `violates foreign key constraint "formula_dependencies__${c}__fk"`, `formula_dependencies__${c}__fk`);
        if (others.some((x) => keyOf(t, x) === keyOf(t, r))) throw pgError('23505', 'duplicate key value violates unique constraint "formula_dependencies__pk"', 'formula_dependencies__pk');
        if (!visible('analyte_versions').some((x) => x.id === r.analyte_version_id)) throw fk('version');
        if (!visible('analytes').some((x) => x.id === r.analyte_id)) throw fk('analyte');
        if (!visible('analytes').some((x) => x.id === r.input_analyte_id)) throw fk('input');
        return;
      }
      if (others.some((x) => x.id === r.id)) throw pgError('23505', `duplicate key value violates unique constraint "${t}__pk"`, `${t}__pk`);
      if (t === 'panels' && !visible('orderables').some((x) => x.id === r.id && x.kind === r.kind)) throw pgError('23503', 'violates foreign key constraint "panels__orderable__fk"', 'panels__orderable__fk');
      if (t === 'orderables') {
        if (others.some((x) => x.code === r.code)) throw pgError('23505', 'duplicate key value violates unique constraint "orderables__tenant_id_code__uq"', 'orderables__tenant_id_code__uq');
        if (r.department_id != null && !master('departments', r.department_id)) throw pgError('23503', 'violates foreign key constraint "orderables__department__fk"', 'orderables__department__fk');
      }
      if (t === 'analytes') {
        if (others.some((x) => x.code === r.code)) throw pgError('23505', 'duplicate key value violates unique constraint "analytes__tenant_id_code__uq"', 'analytes__tenant_id_code__uq');
        if (!visible('tests').some((x) => x.id === r.test_id)) throw pgError('23503', 'violates foreign key constraint "analytes__test__fk"', 'analytes__test__fk');
      }
      if (t === 'analyte_versions') {
        if (others.some((x) => x.analyte_id === r.analyte_id && x.version_no === r.version_no)) {
          throw pgError('23505', 'duplicate key value violates unique constraint "analyte_versions__tenant_id_analyte_id_version_no__uq"', 'analyte_versions__tenant_id_analyte_id_version_no__uq');
        }
        if (r.status === 'draft' && others.some((x) => x.analyte_id === r.analyte_id && x.status === 'draft')) {
          throw pgError('23505', 'duplicate key value violates unique constraint "analyte_versions__tenant_id_analyte_id__draft__p_uq"', 'analyte_versions__tenant_id_analyte_id__draft__p_uq');
        }
        if (!visible('analytes').some((x) => x.id === r.analyte_id)) throw pgError('23503', 'violates foreign key constraint "analyte_versions__analyte__fk"', 'analyte_versions__analyte__fk');
        if (r.method_id != null && !master('methods', r.method_id)) throw pgError('23503', 'violates foreign key constraint "analyte_versions__method__fk"', 'analyte_versions__method__fk');
      }
      if (t === 'instrument_code_maps') {
        if (!visible('analytes').some((x) => x.id === r.analyte_id && x.test_id === r.test_id)) {
          throw pgError('23503', 'violates foreign key constraint "instrument_code_maps__analyte_test__fk"', 'instrument_code_maps__analyte_test__fk');
        }
        if (r.is_active && ['inbound', 'both'].includes(r.direction)
          && others.some((x) => x.is_active && ['inbound', 'both'].includes(x.direction) && x.instrument_id === r.instrument_id && x.instrument_code === r.instrument_code)) {
          throw pgError('23505', 'duplicate key value violates unique constraint "instrument_code_maps__inbound__p_uq"', 'instrument_code_maps__inbound__p_uq');
        }
        if (r.is_active && ['outbound', 'both'].includes(r.direction)
          && others.some((x) => x.is_active && ['outbound', 'both'].includes(x.direction) && x.instrument_id === r.instrument_id && x.analyte_id === r.analyte_id)) {
          throw pgError('23505', 'duplicate key value violates unique constraint "instrument_code_maps__outbound__p_uq"', 'instrument_code_maps__outbound__p_uq');
        }
      }
      if (t === 'tests' && !visible('orderables').some((x) => x.id === r.id && x.kind === r.kind)) throw pgError('23503', 'violates foreign key constraint "tests__orderable__fk"', 'tests__orderable__fk');
      if (t === 'tat_targets') {
        if (!visible('tests').some((x) => x.id === r.test_id)) throw pgError('23503', 'violates foreign key constraint "tat_targets__test__fk"', 'tat_targets__test__fk');
        if (r.effective_to == null && others.some((x) => x.test_id === r.test_id && x.priority === r.priority && x.effective_to == null)) {
          throw pgError('23505', 'duplicate key value violates unique constraint "tat_targets__open__p_uq"', 'tat_targets__open__p_uq');
        }
      }
      if (SET_TABLES.has(t)) {
        if (others.some((x) => x.analyte_id === r.analyte_id && x.version_no === r.version_no)) {
          throw pgError('23505', `duplicate key value violates unique constraint "${t}__tenant_id_analyte_id_version_no__uq"`, `${t}__tenant_id_analyte_id_version_no__uq`);
        }
        if (r.status === 'draft' && others.some((x) => x.analyte_id === r.analyte_id && x.status === 'draft')) {
          throw pgError('23505', `duplicate key value violates unique constraint "${t}__tenant_id_analyte_id__draft__p_uq"`, `${t}__tenant_id_analyte_id__draft__p_uq`);
        }
        if (!visible('analytes').some((x) => x.id === r.analyte_id)) throw pgError('23503', `violates foreign key constraint "${t}__analyte__fk"`, `${t}__analyte__fk`);
        if (r.method_id != null && !master('methods', r.method_id)) throw pgError('23503', `violates foreign key constraint "${t}__method__fk"`, `${t}__method__fk`);
      }
      const parent = BAND_PARENT[t];
      if (parent) {
        if (!visible(parent).some((x) => x.id === r.set_id)) throw pgError('23503', `violates foreign key constraint "${t}__set__fk"`, `${t}__set__fk`);
        if (r.specimen_type_id != null && !master('specimen_types', r.specimen_type_id)) throw pgError('23503', `violates foreign key constraint "${t}__specimen__fk"`, `${t}__specimen__fk`);
      }
    }

    /** catalog.tg_parent_is_draft (05-SCHEMA §10.2): a band is writable only while its set is a draft -> P0001 immutable_row. */
    function parentDraft(t: T6Table, r: Row): void {
      if (t === 'formula_dependencies' && visible('analyte_versions').find((x) => x.id === r.analyte_version_id)?.status !== 'draft') throw pgError('P0001', 'immutable_row');
      const parent = BAND_PARENT[t];
      if (parent && visible(parent).find((x) => x.id === r.set_id)?.status !== 'draft') throw pgError('P0001', 'immutable_row');
    }

    /** BEFORE UPDATE triggers analyte_versions__status + analyte_versions__mutable_columns (05-SCHEMA §10.2). */
    function versionTriggers(o: Row, n: Row, t: T6Table = 'analyte_versions'): void {
      const immutable = () => pgError('P0001', 'immutable_row');
      const ok = (o.status === 'draft' && ['draft', 'published', 'discarded'].includes(n.status)) || (o.status === 'published' && ['published', 'superseded', 'retired'].includes(n.status));
      if (!ok) throw immutable();
      if (o.status !== 'draft') {
        const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date ? +new Date(a as never) === +new Date(b as never) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
        for (const c of COLUMNS[t]) if (!VERSION_MUTABLE.has(c) && !same(o[c], n[c])) throw immutable();
      }
    }

    const target = (m: RegExpExecArray | null, text: string, kind: string): T6Table => {
      if (!m) throw new Error(`fake: unsupported ${kind}: ${text.slice(0, 160)}`);
      const t = m[1]!.toLowerCase() as T6Table;
      if (!WRITABLE.has(t)) throw new Error(`fake: unsupported ${kind} on seed-only table catalog.${t}`);
      return t;
    };

    async function insert(text: string, values: readonly unknown[]) {
      const m = /^INSERT INTO catalog\.(\w+) \(([^)]+)\) VALUES (.+?)(?: RETURNING (.+))?$/i.exec(text);
      const t = target(m, text, 'INSERT');
      const cols = m![2]!.split(',').map((c) => c.trim());
      const groups = splitTop(m![3]!);
      const added: Row[] = [];
      await take(t);
      for (const g of groups) {
        if (!/^\(.*\)$/s.test(g)) throw new Error(`fake: unsupported INSERT VALUES: ${g.slice(0, 80)}`);
        const exprs = splitTop(g.slice(1, -1));
        if (cols.length !== exprs.length) throw new Error('fake: INSERT column/value count mismatch');
        const raw: Row = {};
        cols.forEach((c, i) => { if (!COLUMNS[t].includes(c)) throw pgError('42703', `column "${c}" does not exist`); raw[c] = parseExpr(exprs[i]!)({ row: undefined, values, now }); });
        if (raw.tenant_id !== tenantId) throw pgError('42501', `new row violates row-level security policy for table "${t}"`);
        const r = fill(t, raw);
        parentDraft(t, r);
        validate(t, r, undefined, added);
        added.push(r);
      }
      for (const r of added) local.get(t)!.set(keyOf(t, r), r);
      return out(added, m![4]);
    }

    async function select(text: string, values: readonly unknown[]) {
      const m = /^SELECT (.+?) FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|OFFSET\b|FOR\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?(?: OFFSET (\S+))?(?: FOR (UPDATE|SHARE)(?: NOWAIT)?)?$/i.exec(text);
      if (!m) throw new Error(`fake: unsupported SELECT: ${text.slice(0, 160)}`);
      const t = m[2]!.toLowerCase() as T6Table;
      if (m[8]?.toUpperCase() === 'UPDATE') await take(t);
      const where = m[4] ? parseExpr(m[4]) : () => true;
      let rows = visible(t).filter((r) => where({ row: r, values, now }) === true);
      if (m[5]) {
        const keys = splitTop(m[5]).map((k) => { const mm = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(k.trim().replace(/\s+COLLATE\s+"C"/i, ''))!;
          // fake compares by code point == COLLATE "C"
          return { ev: parseExpr(mm[1]!), desc: /^DESC$/i.test(mm[2] ?? '') }; });
        const dec = rows.map((r) => ({ r, k: keys.map((k) => k.ev({ row: r, values, now })) }));
        dec.sort((a, b) => {
          for (let i = 0; i < keys.length; i++) {
            const x = a.k[i], y = b.k[i];
            const c = x == null || y == null ? 0 : x instanceof Date || y instanceof Date ? +x - +y : x < y ? -1 : x > y ? 1 : 0;
            if (c) return keys[i]!.desc ? -c : c;
          }
          return 0;
        });
        rows = dec.map((d) => d.r);
      }
      const num = (s: string | undefined) => (s === undefined ? undefined : s.startsWith('$') ? Number(values[Number(s.slice(1)) - 1]) : Number(s));
      const off = num(m[7]); const lim = num(m[6]);
      if (off) rows = rows.slice(off);
      if (lim !== undefined) { if (!Number.isInteger(lim) || lim < 0) throw pgError('2201W', 'LIMIT must not be negative'); rows = rows.slice(0, lim); }
      if (/^count\(\*\)/i.test(m[1]!.trim())) return { rows: [{ count: String(rows.length) }] };
      return { rows: rows.map((r) => ({ ...r })) };
    }

    async function update(text: string, values: readonly unknown[]) {
      const m = /^UPDATE catalog\.(\w+)(?: (?:AS )?(?!SET\b)(\w+))? SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      const t = target(m, `${text} (a WHERE clause is required)`, 'UPDATE');
      await take(t);                                          // lock first, evaluate WHERE on the fresh committed state
      const sets = splitTop(m![3]!).map((s) => {
        const eq = s.indexOf('='); const col = s.slice(0, eq).trim();
        if (!COLUMNS[t].includes(col)) throw pgError('42703', `column "${col}" does not exist`);
        return { col, ev: parseExpr(s.slice(eq + 1)) };
      });
      const where = parseExpr(m![4]!);
      const hit = visible(t).filter((r) => where({ row: r, values, now }) === true);
      const changed: Row[] = [];
      for (const r of hit) {
        const n: Row = { ...r };
        for (const s of sets) n[s.col] = s.ev({ row: r, values, now });
        if (t === 'instrument_code_maps') {                  // jsonb / numeric input conversion (same as INSERT)
          if (n.unit_factor != null) n.unit_factor = String(n.unit_factor);
          if (typeof n.flag_map === 'string') { try { n.flag_map = JSON.parse(n.flag_map); } catch { throw pgError('22P02', 'invalid input syntax for type json'); } }
        }
        if (n.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
        if (t === 'analyte_versions' || SET_TABLES.has(t)) versionTriggers(r, n, t);
        parentDraft(t, r); parentDraft(t, n);
        validate(t, n, keyOf(t, r));
        local.get(t)!.set(keyOf(t, n), n); changed.push(n);
      }
      return out(changed, m![5]);
    }

    async function del(text: string, values: readonly unknown[]) {
      const m = /^DELETE FROM catalog\.(\w+)(?: (?:AS )?(?!WHERE\b)(\w+))? WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
      if (!m) throw new Error(`fake: unsupported DELETE (a WHERE clause is required): ${text.slice(0, 160)}`);
      const t = m[1]!.toLowerCase() as T6Table;
      if (t !== 'test_specimen_types' && t !== 'panel_members' && !(t in BAND_PARENT)) throw pgError('42501', `permission denied for table ${t} (lims_app has no DELETE grant)`);
      await take(t);
      const where = parseExpr(m[3]!);
      const hit = visible(t).filter((r) => where({ row: r, values, now }) === true);
      for (const r of hit) parentDraft(t, r);
      for (const r of hit) local.get(t)!.set(keyOf(t, r), null);
      return out(hit, m[4]);
    }

    const facade: any = {
      startedAt: STARTED_AT,
      operation: { module: 'catalog', operationId: 'fake', context: 'tenant' },
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        if (!TABLE_RE.test(text)) return mtx.facade.query(text, values);
        await tick();
        base.stmts.push({ txId: mtx.id, tenantId, text, values });
        const f = failures.find((x) => x.match.test(text));
        if (f) throw f.make();
        const t = text.replace(/\s+/g, ' ').trim();
        if (/^INSERT/i.test(t)) return insert(t, values);
        if (/^SELECT/i.test(t)) return select(t, values);
        if (/^UPDATE/i.test(t)) return update(t, values);
        if (/^DELETE/i.test(t)) return del(t, values);
        throw new Error(`fake: unsupported SQL: ${t.slice(0, 160)}`);
      },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id: mtx.id, tenantId, actorId, facade,
      commit() {
        for (const t of T6_TABLES) for (const [k, r] of local.get(t)!) { if (r === null) committed.get(t)!.delete(k); else committed.get(t)!.set(k, r); }
        mtx.commit(); releaseAll();
      },
      rollback() { mtx.rollback(); releaseAll(); },
    };
  }

  type Tx = ReturnType<typeof begin>;
  /** One transaction: COMMIT when fn resolves (unless `rollback`), ROLLBACK when it rejects. */
  async function run<T>(fn: (ctx: ReturnType<typeof masters.ctxFor>) => Promise<T>, o: { tenantId?: string; rollback?: boolean; actorId?: string; ctx?: Record<string, unknown> } = {}): Promise<T> {
    const tx = begin(o.tenantId ?? TENANT_A, o.actorId ?? USER);
    try {
      const r = await fn(masters.ctxFor(tx as never, o.ctx));
      if (o.rollback) throw new Error('forced rollback');
      tx.commit();
      return r;
    } catch (e) { tx.rollback(); throw e; }
  }

  return {
    run, begin: begin as (tenantId: string, actorId?: string) => Tx, ctxFor: masters.ctxFor, masters, base,
    get stmts() { return base.stmts; },
    get events() { return base.events; },
    revisionOf: base.revisionOf,
    /** Statements that touched the T-06 tables. */
    t6Stmts: () => base.stmts.filter((s) => TABLE_RE.test(s.text)),
    rows: (t: T6Table, tenantId?: string): Row[] => [...committed.get(t)!.values()].filter((r) => tenantId === undefined || r.tenant_id === tenantId).map((r) => ({ ...r })),
    row: (t: T6Table, key: string): Row | undefined => { const r = committed.get(t)!.get(key); return r ? { ...r } : undefined; },
    orderableRevision: (id: string): number | undefined => committed.get('orderables')!.get(id)?.revision,
    newId: () => ID(0xe000 + ++seq),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); masters.fail(match, make); },
  };
}
export type TestsDb = ReturnType<typeof makeTestsDb>;

// ------------------------------------------------------------------------------------------------ seed factories (synthetic)
/** An orderable row (kind test) + its tests row. */
export const tst = (n: number, tenant: string, dept: string, o: Row = {}): { orderable: Row; test: Row } => {
  const id = ID(0x1000 + n);
  return {
    orderable: { id, tenant_id: tenant, kind: 'test', code: o['code'] ?? `T${n}`, name: o['name'] ?? `Test ${n}`, department_id: dept, sex_restriction: o['sex_restriction'] ?? null,
      is_orderable: o['is_orderable'] ?? true, revision: o['revision'] ?? 0, version: o['version'] ?? 1, is_active: o['is_active'] ?? true },
    test: { id, tenant_id: tenant, workflow_type: o['workflow_type'] ?? 'standard', report_order: o['report_order'] ?? 100, uses_existing_material: o['uses_existing_material'] ?? false,
      version: o['version'] ?? 1, is_active: o['is_active'] ?? true },
  };
};
/** An orderable row (kind panel) + its panels row. */
export const pnl = (n: number, tenant: string, o: Row = {}): { orderable: Row; panel: Row } => {
  const id = ID(0x2000 + n);
  return {
    orderable: { id, tenant_id: tenant, kind: 'panel', code: o['code'] ?? `P${n}`, name: o['name'] ?? `Panel ${n}`, department_id: o['department_id'] ?? null, sex_restriction: o['sex_restriction'] ?? null,
      is_orderable: o['is_orderable'] ?? true, revision: o['revision'] ?? 0, is_active: o['is_active'] ?? true },
    panel: { id, tenant_id: tenant, panel_kind: o['panel_kind'] ?? 'clinical', is_active: o['is_active'] ?? true },
  };
};
/** A panel_members row (member = any orderable id of the same tenant). */
export const pmb = (panelId: string, memberId: string, tenant: string, sortOrder = 1): Row => ({ tenant_id: tenant, panel_id: panelId, member_orderable_id: memberId, sort_order: sortOrder });
export const tsr = (testId: string, specimenTypeId: string, tenant: string, o: Row = {}): Row => ({ tenant_id: tenant, test_id: testId, specimen_type_id: specimenTypeId, container_id: o['container_id'] ?? null, is_preferred: o['is_preferred'] ?? false, min_volume_ul: o['min_volume_ul'] ?? null });
export const ana = (n: number, tenant: string, testId: string, o: Row = {}): Row => ({ id: ID(0x3000 + n), tenant_id: tenant, test_id: testId, code: o['code'] ?? `AN${n}`, name: o['name'] ?? `Analyte ${n}`, ...o });
export const anv = (n: number, tenant: string, analyteId: string, o: Row = {}): Row => ({ id: ID(0x4000 + n), tenant_id: tenant, analyte_id: analyteId, version_no: 1, status: 'published', result_type: 'numeric', decimals: 1,
  effective_from: new Date(Date.UTC(2026, 0, 1)), published_at: new Date(Date.UTC(2026, 0, 1)), change_reason: 'initial', ...o });

// ------------------------------------------------------------------------------------------------ T-27 seed factory (synthetic)
/** An instrument_code_maps row (default: active inbound map for instrument `instrumentId`, no units, no flag map). `n` makes the id unique (0xb000 range). */
export const icm = (n: number, tenant: string, instrumentId: string, o: Row = {}): Row => ({ id: ID(0xb000 + n), tenant_id: tenant, instrument_id: instrumentId, direction: 'inbound', ...o });
// ------------------------------------------------------------------------------------------------ T-08 seed factories (synthetic)
// ------------------------------------------------------------------------------------------------ T-14 seed factory (synthetic)
/** A tat_targets row (default: routine, within_lab, 4 h, open since 2026-01-01). `n` makes the id unique (0x9000 range). */
export const tat = (n: number, tenant: string, testId: string, o: Row = {}): Row => ({ id: ID(0x9000 + n), tenant_id: tenant, test_id: testId, priority: 'routine', segment: 'within_lab', target_seconds: 14400,
  effective_from: new Date(Date.UTC(2026, 0, 1)), effective_to: null, ...o });
/** A reference_range_sets row (default: published v1, unit g_dl, method null, effective since 2026-01-01). */
export const rset = (n: number, tenant: string, analyteId: string, o: Row = {}): Row => ({ id: ID(0x6000 + n), tenant_id: tenant, analyte_id: analyteId, version_no: 1, status: 'published', unit_code: 'g_dl', method_id: null,
  effective_from: new Date(Date.UTC(2026, 0, 1)), published_at: new Date(Date.UTC(2026, 0, 1)), change_reason: 'initial', ...o });
/** A reference_ranges (band) row. */
export const rband = (n: number, tenant: string, setId: string, o: Row = {}): Row => ({ id: ID(0x7000 + n), tenant_id: tenant, set_id: setId, sex: 'any', kind: 'numeric', sort_order: 100, ...o });
/** A critical_limit_sets row (same defaults as rset, id range 0x68xx). */
export const cset = (n: number, tenant: string, analyteId: string, o: Row = {}): Row => ({ ...rset(n, tenant, analyteId), id: ID(0x6800 + n), ...o });
/** A critical_limits (band) row. */
export const cband = (n: number, tenant: string, setId: string, o: Row = {}): Row => ({ id: ID(0x7800 + n), tenant_id: tenant, set_id: setId, sex: 'any', sort_order: 100, ...o });
