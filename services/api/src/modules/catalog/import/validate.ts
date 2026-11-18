// T0B-TESTIMPORT-1 (LD-318 + follow-up, done_when 5): cell hygiene and every row / cross-row rule of the Excel test import. Pure (masters and catalog lookups are passed in),
// so the dry run writes nothing. ALL errors are listed (sheet, Excel row, column, code, message), at most 1000. The band, overlap and formula rules REUSE the T0B-TESTMGMT-1
// domain validators (rangeMatch.findOverlaps / ageHours, ranges.service cmpDec / criticalErrors / groupKey, formulaGraph, the shared-ts formula parser); nothing is copied.
import { evaluateFormula, parseFormula, formulaRefs, type FormulaAst } from '../../../../../../packages/shared-ts/src/formula/index.js';
import { isValidCode, normaliseCode } from '../domain/codes.js';
import { analyzeFormulaGraph } from '../domain/formulaGraph.js';
import { ageHours, findOverlaps, type Band } from '../domain/rangeMatch.js';
import { cmpDec, criticalErrors, groupKey } from '../service/ranges.service.js';
import { DATA_SHEETS, FIELDS, SHEET, STAGES, type DataSheet, type FieldDef, type Master } from './fields.js';

export const MAX_ERRORS = 1000;
export const CELL_CAP = 20_000;                         // the longest contract field (Long Text Value); Excel itself allows 32767
const DEC = /^-?[0-9]+(\.[0-9]+)?$/;
const INJECTION = /^[=+\-@]/;                           // spreadsheet formula injection (done_when 4)
const ANALYTE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;     // analyteVersions.service CODE_IN (checked before upper-casing)
const TRUE = ['yes', 'y', 'true', '1'], FALSE = ['no', 'n', 'false', '0'];
// Test fields that make a test use the LD-318 parity model; tests.service then requires tags for an orderable test (its tagsRule), so the import says so at upload time.
const PARITY = ['short_name', 'display_name', 'tags', 'barcode_text', 'loyalty_points', 'display_order', 'description', 'report_type', 'processing_type', 'outsource_name',
  'is_outsourced', 'is_popular', 'smart_report', 'print_category_wise', 'nabl', 'accab_logo', 'auto_approval_enabled', 'use_normal_range_for_auto_approval', 'template_test', 'font',
  'alert_before_expiry_minutes', 'category'];

export interface ImportError { sheet: string; row: number; column: string; code: string; message: string }
export interface Masters {
  department: Map<string, string>; specimen: Map<string, string>; method: Map<string, string>; unit: Set<string>; valueSet: Map<string, boolean>;
  category: { id: string; name: string; department_id: string }[];
}
export interface Catalog { orderables: Map<string, { id: string; kind: string }>; analytes: Map<string, { id: string; test_id: string }> }
export type Vals = Record<string, unknown>;
export interface ModelTest { row: number; code: string; action: 'create' | 'update'; v: Vals; analytes: ModelAnalyte[] }
export interface ModelAnalyte { row: number; code: string; action: 'create' | 'update'; v: Vals; formula?: string | undefined; refs: string[]; bands: Vals[]; critical: Vals[] }
export interface ModelPanel { row: number; code: string; v: Vals; members: { kind: string; code: string; sort_order: number }[] }
export interface Model { tests: ModelTest[]; panels: ModelPanel[] }
export interface Result {
  errors: ImportError[]; model: Model; rows: Record<DataSheet, { row: number; cells: string[] }[]>;
  counts: { tests: number; analytes: number; ranges: number; panels: number; errors: number };
  preview: { tests: { code: string; name: string; action: 'create' | 'update'; analytes: number; ranges: number }[] };
}

/** NFC, control characters removed (tab = space, CR LF kept as LF), trimmed. */
export const clean = (s: string): string => s.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();

/** Excel numbers may arrive as 1.5E-3; only plain decimals survive (1e999 and friends are not numbers). */
function decimal(s: string): string | undefined {
  if (DEC.test(s)) return s;
  if (!/^-?\d+(\.\d+)?[eE][-+]?\d+$/.test(s)) return undefined;
  const n = Number(s);
  const out = Number.isFinite(n) ? String(n) : '';
  return DEC.test(out) ? out : undefined;
}

type Cell = { ok: true; value: unknown } | { ok: false; code: string; message: string } | undefined;
function parseCell(def: FieldDef, raw: string): Cell {
  if (raw === '') return undefined;
  const k = def.kind;
  if (raw.length > CELL_CAP || ((k.t === 'text') && raw.length > k.max)) return { ok: false, code: 'cell_too_long', message: `${def.label} is longer than ${k.t === 'text' ? k.max : CELL_CAP} characters` };
  if (k.t !== 'int' && k.t !== 'dec' && INJECTION.test(raw)) return { ok: false, code: 'formula_injection', message: `${def.label} may not start with = + - or @` };
  switch (k.t) {
    case 'text': return k.min && raw.length < k.min ? { ok: false, code: 'value_out_of_range', message: `${def.label} needs at least ${k.min} characters` } : { ok: true, value: raw };
    case 'code': case 'master': return { ok: true, value: raw };
    case 'int': {
      if (!/^-?\d{1,10}$/.test(raw)) return { ok: false, code: 'not_a_number', message: `${def.label} must be a whole number` };
      const n = Number(raw);
      return n < k.min || n > k.max ? { ok: false, code: 'value_out_of_range', message: `${def.label} must be between ${k.min} and ${k.max}` } : { ok: true, value: n };
    }
    case 'dec': { const d = decimal(raw); return d === undefined || d.length > 40 ? { ok: false, code: 'not_a_number', message: `${def.label} must be a decimal number` } : { ok: true, value: d }; }
    case 'bool': {
      const l = raw.toLowerCase();
      return TRUE.includes(l) ? { ok: true, value: true } : FALSE.includes(l) ? { ok: true, value: false } : { ok: false, code: 'not_a_boolean', message: `${def.label} must be yes or no` };
    }
    case 'enum': { const l = raw.toLowerCase(); return k.values.includes(l) ? { ok: true, value: l } : { ok: false, code: 'value_not_allowed', message: `${def.label} must be one of the dropdown values` }; }
    case 'list': {
      const items = raw.split(',').map((x) => (k.codes ? x.trim().toUpperCase() : x.trim())).filter(Boolean);
      if (items.length > k.maxItems || items.some((x) => x.length > k.itemMax)) return { ok: false, code: 'value_out_of_range', message: `${def.label}: at most ${k.maxItems} items of ${k.itemMax} characters` };
      if (k.codes && items.some((x) => !/^[A-Z0-9_+\-]{1,16}$/.test(x))) return { ok: false, code: 'value_not_allowed', message: `${def.label}: codes are A-Z, 0-9, _ + -` };
      return { ok: true, value: items };
    }
  }
}

/**
 * Division by a constant zero: the shared-ts AST is opaque, so the expression is evaluated (evaluateFormula, the C5 evaluator) with two independent random positive
 * input sets; a divisor that is zero both times is a constant zero. ponytail: a divisor like (A-B) is zero by chance with negligible probability; a shared-ts
 * "constant divisors" helper would make it exact.
 */
function dividesByZero(ast: FormulaAst, refs: readonly string[]): boolean {
  const once = () => {
    const inputs = Object.fromEntries(refs.map((r) => [r, `${1 + Math.floor(Math.random() * 9000)}.${Math.floor(Math.random() * 1000)}`]));
    const r = evaluateFormula(ast, inputs, { sex: 'female', ageDays: 1 + Math.floor(Math.random() * 30000), ageYears: 1 + Math.floor(Math.random() * 80) });
    return !r.ok && r.reason === 'division_by_zero';
  };
  return once() && once();
}

interface Row { row: number; v: Vals; bad: Set<string> }

export function validate(input: { sheets: Record<DataSheet, { row: number; cells: string[] }[]>; masters: Masters; catalog: Catalog; mode: 'create_only' | 'update' }): Result {
  const { masters: M, catalog: C, mode } = input;
  const errors: ImportError[] = [];
  const add = (sheet: string, row: number, column: string, code: string, message: string) => { if (errors.length < MAX_ERRORS) errors.push({ sheet, row, column, code, message: message.slice(0, 300) }); };
  const rows = {} as Result['rows'];
  const parsed = {} as Record<DataSheet, Row[]>;

  // 1. cells: hygiene + types; a rejected cell is blanked in the stored rows (an injection or a huge cell never reaches the payload or the errors file)
  for (const s of DATA_SHEETS) {
    const defs = FIELDS[s];
    rows[s] = []; parsed[s] = [];
    for (const r of input.sheets[s]) {
      const cells = defs.map((_, i) => clean(r.cells[i] ?? ''));
      if (cells.every((x) => x === '')) continue;
      const v: Vals = {}, bad = new Set<string>();
      defs.forEach((d, i) => {
        const c = parseCell(d, cells[i]!);
        if (c === undefined) { if (d.required) { add(s, r.row, d.label, 'required_missing', `${d.label} is required`); bad.add(d.key); } return; }
        if (!c.ok) { add(s, r.row, d.label, c.code, c.message); bad.add(d.key); if (c.code === 'formula_injection' || c.code === 'cell_too_long' || INJECTION.test(cells[i]!)) cells[i] = ''; return; }
        v[d.key] = c.value;
      });
      rows[s].push({ row: r.row, cells });
      parsed[s].push({ row: r.row, v, bad });
    }
  }
  const T = parsed[SHEET.tests], P = parsed[SHEET.params], R = parsed[SHEET.ranges], K = parsed[SHEET.panels];
  if (!T.length && !P.length && !R.length && !K.length) add(SHEET.tests, 2, 'Test Code', 'workbook_empty', 'The workbook has no data row');

  const master = (s: string, r: Row, key: string, label: string, kind: Master, extra?: (id: string) => boolean): string | undefined => {
    const raw = r.v[key]; if (raw === undefined) return undefined;
    const map = kind === 'department' ? M.department : kind === 'specimen' ? M.specimen : kind === 'method' ? M.method : undefined;
    const hit = map ? (map.get(String(raw)) ?? map.get(String(raw).toUpperCase())) : undefined;
    if (hit && (!extra || extra(hit))) return hit;
    // [CONV] instruments and laboratories live in other modules and no port exposes them to the catalog yet: any value is unknown (never stored unchecked)
    add(s, r.row, label, 'unknown_master', `${label} ${String(raw).slice(0, 40)} is not in the masters`); r.bad.add(key);
    return undefined;
  };

  // 2. Tests
  const tests = new Map<string, ModelTest>();
  for (const r of T) {
    const raw = r.v['code'];
    let code: string | undefined;
    if (raw !== undefined) {
      if (!isValidCode('orderable', raw)) { add(SHEET.tests, r.row, 'Test Code', 'value_not_allowed', 'Test Code: letters, digits, _ - + . (at most 32)'); }
      else code = normaliseCode(String(raw));
    }
    const v: Vals = { ...r.v };
    v['department_id'] = master(SHEET.tests, r, 'department', 'Department Code', 'department');
    v['specimen_type_id'] = master(SHEET.tests, r, 'specimen', 'Specimen Code', 'specimen');
    if (r.v['category'] !== undefined) {
      const name = String(r.v['category']).toLowerCase();
      const cats = M.category.filter((c) => c.name.toLowerCase() === name);
      const cat = cats.find((c) => c.department_id === v['department_id']) ?? cats[0];
      if (cat) v['category_id'] = cat.id; else { add(SHEET.tests, r.row, 'Category Name', 'unknown_master', 'Category Name is not in the masters'); r.bad.add('category'); }
    }
    if (PARITY.some((k) => r.v[k] !== undefined) && r.v['is_orderable'] !== false && !(Array.isArray(r.v['tags']) && r.v['tags'].length))
      add(SHEET.tests, r.row, 'Tags', 'required_missing', 'Tags are required for an orderable test that uses the display fields');
    if (!code) continue;
    if (tests.has(code)) { add(SHEET.tests, r.row, 'Test Code', 'code_duplicate', `Test code ${code} appears twice in the file`); continue; }
    const hit = C.orderables.get(code);
    let action: 'create' | 'update' = 'create';
    if (hit) {
      if (mode === 'update' && hit.kind === 'test') action = 'update';
      else add(SHEET.tests, r.row, 'Test Code', 'code_exists', `Code ${code} already exists in the catalog${mode === 'create_only' ? ' (mode create_only)' : ''}`);
    }
    tests.set(code, { row: r.row, code, action, v: { ...v, ...(hit ? { id: hit.id } : {}) }, analytes: [] });
  }

  // 3. Parameters
  const analyteCodes = new Map<string, string>();   // analyte code -> test code (codes are unique per tenant)
  for (const r of P) {
    const tc = r.v['test_code'] === undefined ? undefined : normaliseCode(String(r.v['test_code']));
    const test = tc ? tests.get(tc) : undefined;
    if (tc && !test && !T.some((x) => x.v['code'] !== undefined && normaliseCode(String(x.v['code'])) === tc)) add(SHEET.params, r.row, 'Test Code', 'orphan_row', `Test Code ${tc.slice(0, 40)} is not on the Tests sheet`);
    const raw = r.v['code'];
    let code: string | undefined;
    if (raw !== undefined) { if (ANALYTE_CODE.test(String(raw))) code = String(raw).toUpperCase(); else add(SHEET.params, r.row, 'Short Name', 'value_not_allowed', 'Short Name: a letter, then letters, digits or _ (at most 32)'); }
    const v: Vals = { ...r.v };
    const rt = r.v['result_type'];
    if (r.v['unit'] !== undefined) {
      const u = String(r.v['unit']);
      if (M.unit.has(u)) v['unit_code'] = u; else { add(SHEET.params, r.row, 'Unit Code', 'unknown_master', `Unit Code ${u.slice(0, 40)} is not in the masters`); r.bad.add('unit'); }
    }
    v['method_id'] = master(SHEET.params, r, 'method', 'Method Code', 'method');
    v['specimen_type_id'] = master(SHEET.params, r, 'specimen', 'Specimen Code', 'specimen');
    if (rt === 'numeric' && r.v['decimals'] === undefined && !r.bad.has('decimals')) add(SHEET.params, r.row, 'Decimals', 'required_missing', 'Decimals is required for a numeric parameter');
    if (r.v['value_set_code'] !== undefined) {
      const vs = String(r.v['value_set_code']).toUpperCase(); const ordered = M.valueSet.get(vs);
      if (ordered === undefined) add(SHEET.params, r.row, 'Value Set Code', 'unknown_master', `Value Set Code ${vs.slice(0, 40)} is not in the masters`);
      else if (rt === 'ordinal' && !ordered) add(SHEET.params, r.row, 'Value Set Code', 'value_not_allowed', 'An ordinal parameter needs an ordered value set');
      else v['value_set_code'] = vs;
    } else if ((rt === 'coded' || rt === 'ordinal') && !r.bad.has('value_set_code')) add(SHEET.params, r.row, 'Value Set Code', 'required_missing', 'A coded or ordinal (List) parameter needs a value set');
    if (!code || !test) continue;
    if (analyteCodes.has(code)) { add(SHEET.params, r.row, 'Short Name', 'code_duplicate', `Short Name ${code} appears twice in the file`); continue; }
    analyteCodes.set(code, test.code);
    const hit = C.analytes.get(code);
    let action: 'create' | 'update' = 'create';
    if (hit) {
      if (mode === 'update' && test.action === 'update' && hit.test_id === test.v['id']) action = 'update';
      else add(SHEET.params, r.row, 'Short Name', 'code_exists', `Parameter ${code} already exists in the catalog`);
    }
    test.analytes.push({ row: r.row, code, action, v: { ...v, ...(hit ? { id: hit.id } : {}), ...(v['sort_order'] === undefined ? { sort_order: test.analytes.length } : {}) },
      ...(typeof r.v['formula_expression'] === 'string' ? { formula: r.v['formula_expression'] } : {}), refs: [], bands: [], critical: [] });
  }

  // 4. Equations: over the Short Names of the same test; unknown names, self reference, cycles, division by a constant zero, syntax (parseFormula = validateFormula's parser)
  for (const t of tests.values()) {
    const mine = new Map(t.analytes.map((a) => [a.code, a]));
    const edges = new Map<string, string[]>();
    for (const a of t.analytes) {
      if (a.formula === undefined) continue;
      const err = (code: string, msg: string) => { add(SHEET.params, a.row, 'Equation', code, msg); a.formula = undefined; };
      const p = parseFormula(a.formula);
      if (p.errors.length || !p.ast) { err('formula_invalid', `Equation: ${p.errors[0]?.message ?? 'syntax error'}`); continue; }
      const refs = [...formulaRefs(p.ast)];
      if (a.v['result_type'] !== 'numeric') { err('formula_invalid', 'An Equation parameter must have Result Type numeric'); continue; }
      if (refs.includes(a.code)) { err('formula_self_reference', `Equation of ${a.code} uses itself`); continue; }
      const unknown = refs.filter((x) => !mine.has(x));
      if (unknown.length) { err('unknown_parameter_reference', `Equation uses ${unknown.join(', ').slice(0, 200)}, not a parameter of test ${t.code}`); continue; }
      if (refs.some((x) => mine.get(x)!.v['result_type'] !== 'numeric')) { err('formula_invalid', 'Equation inputs must be numeric parameters'); continue; }
      if (dividesByZero(p.ast, refs)) { err('formula_division_by_zero', 'Equation divides by a constant zero'); continue; }
      a.refs = refs; edges.set(a.code, refs);
    }
    for (const a of t.analytes) {
      if (a.formula === undefined) continue;
      const g = analyzeFormulaGraph({ root: a.code, rootInputs: a.refs, edges });
      if (g.cycle) { add(SHEET.params, a.row, 'Equation', 'formula_cycle', `Equation cycle: ${g.cycle.join(' -> ')}`.slice(0, 300)); a.formula = undefined; }
    }
  }

  // 5. Reference ranges (one row = one normal band, plus its critical limits unless both are empty or both 0)
  const bandsOf = new Map<ModelAnalyte, { rows: Row[]; normal: Vals[]; crit: { row: Row; band: Vals }[] }>();
  for (const r of R) {
    const tc = r.v['test_code'] === undefined ? undefined : normaliseCode(String(r.v['test_code']));
    const test = tc ? tests.get(tc) : undefined;
    if (tc && !test) { add(SHEET.ranges, r.row, 'Test Code', 'orphan_row', `Test Code ${tc.slice(0, 40)} is not on the Tests sheet`); continue; }
    const sn = r.v['param'] === undefined ? undefined : String(r.v['param']).toUpperCase();
    const an = test && sn ? test.analytes.find((a) => a.code === sn) : undefined;
    if (test && sn && !an) { add(SHEET.ranges, r.row, 'Short Name', 'orphan_row', `Short Name ${sn.slice(0, 40)} is not a parameter of test ${test.code} on the Parameters sheet`); continue; }
    const v = r.v;
    const ageBound = (val: string, unit: string, valLabel: string, unitLabel: string) => {
      if (v[val] !== undefined && v[unit] === undefined && !r.bad.has(unit)) { add(SHEET.ranges, r.row, unitLabel, 'required_missing', `${unitLabel} is required with ${valLabel}`); return undefined; }
      if (v[unit] !== undefined && v[val] === undefined && !r.bad.has(val)) { add(SHEET.ranges, r.row, valLabel, 'required_missing', `${valLabel} is required with ${unitLabel}`); return undefined; }
      return v[val] === undefined ? undefined : { value: v[val] as number, unit: v[unit] as string };
    };
    const lo = ageBound('age_from', 'age_from_unit', 'Age From', 'Age From Unit'), hi = ageBound('age_to', 'age_to_unit', 'Age To', 'Age To Unit');
    if (lo && hi && ageHours(lo.value, lo.unit) >= ageHours(hi.value, hi.unit)) add(SHEET.ranges, r.row, 'Age To', 'range_from_ge_to', 'Age From must be below Age To');
    const specimen = master(SHEET.ranges, r, 'specimen', 'Specimen Code', 'specimen');
    const method = master(SHEET.ranges, r, 'method', 'Method Code', 'method');
    const instrument = master(SHEET.ranges, r, 'instrument', 'Instrument Code', 'instrument');
    const laboratory = master(SHEET.ranges, r, 'laboratory', 'Laboratory Code', 'laboratory');
    const low = v['low'] as string | undefined, high = v['high'] as string | undefined;
    const kind = v['kind'];
    if (kind === 'numeric' && low === undefined && high === undefined && !r.bad.has('low') && !r.bad.has('high')) add(SHEET.ranges, r.row, 'Normal Low', 'required_missing', 'A numeric range needs Normal Low or Normal High');
    if ((kind === 'text' || kind === 'ordinal')) {
      if (low !== undefined || high !== undefined) add(SHEET.ranges, r.row, 'Normal Low', 'value_not_allowed', 'A text or ordinal range has no Normal Low / High');
      if (v['display_text'] === undefined) add(SHEET.ranges, r.row, 'Display Text', 'required_missing', 'A text or ordinal range needs Display Text');
      if (kind === 'ordinal' && !(v['normal_codes'] as string[] | undefined)?.length) add(SHEET.ranges, r.row, 'Normal Codes', 'required_missing', 'An ordinal range needs Normal Codes');
    }
    if (low !== undefined && high !== undefined && cmpDec(low, high) > 0) add(SHEET.ranges, r.row, 'Normal Low', 'normal_low_gt_high', 'Normal Low is above Normal High');
    const aLow = v['auto_approved_low'] as string | undefined, aHigh = v['auto_approved_high'] as string | undefined;
    if (aLow !== undefined && ((low === undefined && high === undefined) || (low !== undefined && cmpDec(aLow, low) < 0) || (aHigh !== undefined && cmpDec(aLow, aHigh) > 0)))
      add(SHEET.ranges, r.row, 'Auto Approved Low', 'auto_approved_outside_normal', 'The auto approved range must lie inside the normal range');
    if (aHigh !== undefined && ((low === undefined && high === undefined) || (high !== undefined && cmpDec(aHigh, high) > 0)))
      add(SHEET.ranges, r.row, 'Auto Approved High', 'auto_approved_outside_normal', 'The auto approved range must lie inside the normal range');
    if (!an) continue;
    const entry = bandsOf.get(an) ?? { rows: [], normal: [], crit: [] }; bandsOf.set(an, entry);
    const common = { sex: v['sex'], ...(lo ? { age_low: lo } : {}), ...(hi ? { age_high: hi } : {}), ...(specimen ? { specimen_type_id: specimen } : {}) };
    const band: Vals = { ...common, kind, sort_order: v['sort_order'] ?? an.bands.length, ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}),
      ...(v['normal_codes'] ? { normal_codes: v['normal_codes'] } : {}), ...(v['display_text'] !== undefined ? { display_text: v['display_text'] } : {}),
      ...(instrument ? { instrument_id: instrument } : {}), ...(laboratory ? { laboratory_id: laboratory } : {}), ...(method ? { method_id: method } : {}),
      ...(v['default_range'] === true ? { default_range: true } : {}), ...(aLow !== undefined ? { auto_approved_low: aLow } : {}), ...(aHigh !== undefined ? { auto_approved_high: aHigh } : {}) };
    an.bands.push(band); entry.rows.push(r);
    // the flat columns the domain validators read (rangeMatch Band / ranges.service rows)
    entry.normal.push({ ...band, age_low_value: lo?.value ?? null, age_low_unit: lo?.unit ?? null, age_high_value: hi?.value ?? null, age_high_unit: hi?.unit ?? null });
    const cl = v['critical_low'] as string | undefined, ch = v['critical_high'] as string | undefined;
    const none = (cl === undefined && ch === undefined) || (cl !== undefined && ch !== undefined && cmpDec(cl, '0') === 0 && cmpDec(ch, '0') === 0);   // LD-318: 0 and 0 = none
    if (!none || v['abnormal_codes']) {
      const crit: Vals = { ...common, ...(none ? {} : { ...(cl !== undefined ? { low: cl } : {}), ...(ch !== undefined ? { high: ch } : {}) }), ...(v['abnormal_codes'] ? { abnormal_codes: v['abnormal_codes'] } : {}) };
      an.critical.push(crit);
      entry.crit.push({ row: r, band: { ...crit, age_low_value: lo?.value ?? null, age_low_unit: lo?.unit ?? null, age_high_value: hi?.value ?? null, age_high_unit: hi?.unit ?? null } });
    }
  }
  for (const e of bandsOf.values()) {
    for (const [, j] of findOverlaps(e.normal.map((b, i) => ({ id: String(i), ...b }) as unknown as Band))) add(SHEET.ranges, e.rows[j]!.row, 'Age From', 'range_overlap', 'This band overlaps an earlier band of the same sex, specimen, instrument and laboratory');
    const seen = new Set<string>();
    e.normal.forEach((b, i) => { if (b['default_range'] !== true) return; const k = groupKey(b); if (seen.has(k)) add(SHEET.ranges, e.rows[i]!.row, 'Default Range', 'default_range_duplicate', 'Only one default range per sex, instrument and laboratory'); seen.add(k); });
    for (const p of criticalErrors(e.crit.map((c) => c.band), e.normal)) {
      const m = /^\/bands\/(\d+)\/(low|high)$/.exec(p);
      if (m) add(SHEET.ranges, e.crit[Number(m[1])]!.row.row, m[2] === 'low' ? 'Critical Low' : 'Critical High', 'critical_inside_normal', 'Critical limits must lie outside the normal range');
    }
  }

  // 6. Panels (one row per member; the panel columns repeat and must agree)
  const panels = new Map<string, ModelPanel>();
  const PANEL_KEYS: [string, string][] = [['name', 'Panel Name'], ['panel_kind', 'Panel Kind'], ['sex_restriction', 'Sex Restriction'], ['department', 'Department Code'],
    ['barcode_text', 'Barcode Text'], ['loyalty_points', 'Loyalty Points'], ['display_order', 'Display Order'], ['is_popular', 'Popular']];
  const panelCodes = new Set(K.map((r) => r.v['code']).filter((x) => x !== undefined && isValidCode('orderable', x)).map((x) => normaliseCode(String(x))));
  const skipped = new Set<string>();
  for (const r of K) {
    const raw = r.v['code'];
    if (raw === undefined) continue;
    if (!isValidCode('orderable', raw)) { add(SHEET.panels, r.row, 'Panel Code', 'value_not_allowed', 'Panel Code: letters, digits, _ - + . (at most 32)'); continue; }
    const code = normaliseCode(String(raw));
    const dept = master(SHEET.panels, r, 'department', 'Department Code', 'department');
    let p = panels.get(code);
    if (!p && !skipped.has(code)) {
      if (tests.has(code)) { add(SHEET.panels, r.row, 'Panel Code', 'code_duplicate', `Code ${code} is also a test of this file`); skipped.add(code); continue; }
      const hit = C.orderables.get(code);
      // ponytail: update mode leaves an existing panel as it is (members are edited in the panel screen); create_only refuses the code
      if (hit) { if (mode === 'create_only' || hit.kind !== 'panel') add(SHEET.panels, r.row, 'Panel Code', 'code_exists', `Code ${code} already exists in the catalog`); skipped.add(code); continue; }
      p = { row: r.row, code, v: { ...r.v, ...(dept ? { department_id: dept } : {}) }, members: [] };
      panels.set(code, p);
    } else if (p) {
      for (const [k, label] of PANEL_KEYS) if (r.v[k] !== undefined && p.v[k] !== undefined && String(r.v[k]) !== String(p.v[k])) add(SHEET.panels, r.row, label, 'panel_inconsistent', `${label} differs from the first row of panel ${code}`);
    }
    if (!p) continue;
    const mk = r.v['member_kind'], mcRaw = r.v['member_code'];
    if (mk === undefined || mcRaw === undefined) continue;
    const mc = normaliseCode(String(mcRaw));
    const known = mk === 'test' ? tests.has(mc) || C.orderables.get(mc)?.kind === 'test' : (panelCodes.has(mc) && mc !== code) || C.orderables.get(mc)?.kind === 'panel';
    if (!known) { add(SHEET.panels, r.row, 'Member Code', 'unknown_member', `Member ${mc.slice(0, 40)} is not a ${String(mk)} of this file or of the catalog`); continue; }
    if (p.members.some((m) => m.code === mc)) { add(SHEET.panels, r.row, 'Member Code', 'code_duplicate', `Member ${mc} appears twice in panel ${code}`); continue; }
    if (p.members.length >= 100) { add(SHEET.panels, r.row, 'Member Code', 'value_out_of_range', 'A panel has at most 100 members'); continue; }
    p.members.push({ kind: String(mk), code: mc, sort_order: (r.v['member_sort_order'] as number | undefined) ?? p.members.length });
  }

  // 7. stage TAT targets of each test
  for (const t of tests.values()) t.v['stage_targets'] = STAGES.filter((s) => typeof t.v[`tat_${s}`] === 'number').map((s) => ({ stage: s, target_minutes: t.v[`tat_${s}`] as number }));

  const ok = errors.length === 0;
  const counts = { tests: T.length, analytes: P.length, ranges: R.length, panels: new Set(K.map((r) => String(r.v['code'] ?? '')).filter(Boolean)).size, errors: errors.length };
  const preview = { tests: ok ? [...tests.values()].slice(0, 100).map((t) => ({ code: t.code, name: String(t.v['name']).slice(0, 200), action: t.action, analytes: t.analytes.length,
    ranges: t.analytes.reduce((n, a) => n + a.bands.length, 0) })) : [] };
  return { errors, model: { tests: [...tests.values()], panels: [...panels.values()] }, rows, counts, preview };
}
