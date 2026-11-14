// Import kinds catalog_master, referrers and credit_parties (02-TRD §8.2 templates, §8.3 validation, §8.5 commit, §8.6 codes; 08 A13 D-18, D-21).
// One planner per kind reads the workbook + the tenant catalog (tenant-bound SELECTs only) and returns the summary, the open drafts a commit would have to
// replace (§8.5) and apply(), which the commit job runs inside its ONE transaction on behalf of imports.committed_by. Validation (dry run) and the commit's
// re-validation run the same planner, so a commit applies exactly what was re-validated.
// [CONV] direct SQL instead of the per-entity services: those bump the revision per write and do not carry source_import_id, while D-21 wants one bump per
// commit; the commit job calls bumpRevision once after apply(). Upsert by code everywhere; rows absent from the workbook are never deactivated.
// No cell value is ever put into an issue or a log (07 S-13): issues carry sheet / row / column key / code only.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { formulaRefs, parseFormula } from '../../../../../../packages/shared-ts/src/formula/index.js';
import { normaliseName } from '../../../../../api/src/modules/catalog/service/referrers.service.js';
import type { Sheet } from '../xlsx/XlsxReader.js';

export const KINDS = ['catalog_master', 'referrers', 'credit_parties'] as const;
export const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
export const txt = (v: unknown) => (blank(v) || v instanceof Date ? '' : String(v).trim());
export const CODE_RE = /^[A-Z0-9][A-Z0-9_\-+.]{0,31}$/;     // orderables__code__ck

type Row = Record<string, any>;
type Q = (text: string, values: unknown[]) => Promise<{ rows: any[] }>;
export type Flag = (code: string, sheet: string, row?: number | null, col?: string | null) => void;
type St = 'add' | 'change' | 'same';
export interface Writer { q: Q; tenantId: string; actor: string; now: Date; effective: Date; reason: string; importId: string; touched: Set<string> }
export interface KindPlan {
  rows: number; added: number; changed: number; unchanged: number; extra: Record<string, number>;
  drafts: Array<{ table: string; id: string }>;
  apply(w: Writer): Promise<void>;
}

const MASTER_RE = /^[A-Z0-9][A-Z0-9_]{0,31}$/, ANALYTE_RE = /^[A-Z][A-Z0-9_]{0,31}$/, UNIT_RE = /^[A-Za-z0-9_]{1,32}$/, VS_RE = /^[A-Z0-9_]{1,32}$/;
const VALUE_RE = /^[A-Z0-9_+-]{1,16}$/, COMMENT_RE = /^[A-Z0-9_]{1,16}$/, PERSON_RE = /^[A-Z0-9_-]{1,20}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/, EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WORKFLOWS = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'];
const RESULT_TYPES = ['numeric', 'text', 'ordinal', 'coded', 'attachment', 'narrative'];
const AGE_UNITS = ['day', 'week', 'month', 'year'];
const DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };   // [CONV] overlap check only
const PARTY_KINDS = ['hospital', 'company', 'clinic', 'partner_lab', 'insurer', 'other'];
export const DOCTOR_COLS = ['doctor_code', 'display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'is_verified'];
export const PARTY_COLS = ['party_code', 'name', 'kind', 'allows_credit', 'pan', 'contact_phone_e164', 'contact_email', 'billing_address'];
const NC = ['name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable'];
const CL = ['result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression'];

const BAD = Symbol('bad');
const norm = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(';') : String(v));
const differs = (a: Row, b: Row, keys: readonly string[]) => keys.some((k) => norm(a[k]) !== norm(b[k]));
const numKey = (v: unknown) => (v == null || v === '' ? null : String(Number(v)));
const latest = (rows: Row[], pred: (r: Row) => boolean) => rows.filter(pred).sort((a, b) => Number(b.version_no) - Number(a.version_no))[0];
const maxNo = (rows: Row[], pred: (r: Row) => boolean) => rows.filter(pred).reduce((m, r) => Math.max(m, Number(r.version_no)), 0);

// ------------------------------------------------------------------------------------------------ SQL (single-table, bind params, tenant predicate)
async function ins(w: Writer, t: string, row: Row, audit = true) {
  const r: Row = { ...row, tenant_id: w.tenantId, created_at: w.now, created_by: w.actor, ...(audit ? { updated_at: w.now, updated_by: w.actor } : {}) };
  const cols = Object.keys(r);
  await w.q(`INSERT INTO catalog.${t} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => r[c]));
}
async function upd(w: Writer, t: string, id: string, patch: Row) {
  const keys = Object.keys(patch), n = keys.length;
  await w.q(`UPDATE catalog.${t} SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = $${n + 3}, updated_by = $${n + 4} WHERE tenant_id = $1 AND id = $2`,
    [w.tenantId, id, ...keys.map((k) => patch[k]), w.now, w.actor]);
}
const published = (w: Writer) => ({ status: 'published', effective_from: w.effective, published_at: w.now, published_by: w.actor, change_reason: w.reason });

// ------------------------------------------------------------------------------------------------ workbook reader + cell parsers
interface Rec { sheet: string; rn: number; bad: boolean; get(k: string): unknown }

function reader(sheets: Sheet[], flag: Flag) {
  const t = { rows: 0, added: 0, changed: 0, unchanged: 0 };
  const err = (r: Rec, code: string, col: string): typeof BAD => { r.bad = true; flag(code, r.sheet, r.rn, col); return BAD; };
  const count = (r: Rec, st: St) => { if (r.bad) return; if (st === 'add') t.added++; else if (st === 'change') t.changed++; else t.unchanged++; };

  /** Data rows of a sheet (blank rows skipped). Unknown header -> warning; a missing required column -> header_mismatch and no rows (still counted). */
  function sheet(name: string, cols: readonly string[], need: readonly string[], required: boolean): Rec[] {
    const s = sheets.find((x) => x.name === name);
    if (!s) { if (required) flag('file.sheet_missing', name); return []; }
    const col: Record<string, number> = {};
    (s.rows[0] ?? []).forEach((h, i) => { const k = txt(h); if (k === '') return; if (cols.includes(k)) col[k] ??= i; else flag('file.unknown_column', name, 1, k); });
    const data = s.rows.slice(1).map((r, i) => ({ r, rn: i + 2 })).filter((x) => !x.r.every(blank));
    t.rows += data.length;
    if (need.some((k) => col[k] === undefined)) { flag('file.header_mismatch', name, 1); return []; }
    return data.map(({ r, rn }) => ({ sheet: name, rn, bad: false, get: (k: string) => (col[k] === undefined ? null : r[col[k]!] ?? null) }));
  }

  const P = {
    str(r: Rec, k: string, max: number, req = false): any {
      const v = r.get(k);
      if (blank(v)) return req ? err(r, 'row.required_missing', k) : null;
      const s = txt(v);
      return s.length > max ? err(r, 'row.value_invalid', k) : s;
    },
    /** Printable ASCII is checked BEFORE upper-casing (no Unicode case-fold forgeries). */
    code(r: Rec, k: string, re: RegExp, req = true, upper = true): any {
      const v = r.get(k);
      if (blank(v)) return req ? err(r, 'row.required_missing', k) : null;
      const s0 = txt(v), s = upper ? s0.toUpperCase() : s0;
      return /^[\x21-\x7e]+$/.test(s0) && re.test(s) ? s : err(r, 'row.code_invalid', k);
    },
    int(r: Rec, k: string, min: number, max: number, def: number | null, req = false): any {
      const v = r.get(k);
      if (blank(v)) return req ? err(r, 'row.required_missing', k) : def;
      const n = typeof v === 'number' ? v : /^-?\d+$/.test(txt(v)) ? Number(txt(v)) : NaN;
      return Number.isInteger(n) && n >= min && n <= max ? n : err(r, 'row.value_invalid', k);
    },
    num(r: Rec, k: string): any {
      const v = r.get(k);
      if (blank(v)) return null;
      const n = typeof v === 'number' ? v : /^-?\d+(\.\d+)?$/.test(txt(v)) ? Number(txt(v)) : NaN;
      return Number.isFinite(n) ? n : err(r, 'row.value_invalid', k);
    },
    yn(r: Rec, k: string, def: boolean | null): any {
      const v = r.get(k);
      if (blank(v)) return def;
      if (typeof v === 'boolean') return v;
      const s = txt(v).toUpperCase();
      return s === 'Y' ? true : s === 'N' ? false : err(r, 'row.value_invalid', k);
    },
    en(r: Rec, k: string, list: readonly string[], def: string | null, req = false): any {
      const v = r.get(k);
      if (blank(v)) return req ? err(r, 'row.required_missing', k) : def;
      const s = txt(v).toLowerCase();
      return list.includes(s) ? s : err(r, 'row.value_invalid', k);
    },
    list: (r: Rec, k: string) => (blank(r.get(k)) ? [] : txt(r.get(k)).split(';').map((x) => x.trim()).filter(Boolean)),
    phone(r: Rec, k: string): any { const v = r.get(k); if (blank(v)) return null; const s = txt(v); return PHONE.test(s) ? s : err(r, 'row.phone_invalid', k); },
    email(r: Rec, k: string): any { const v = r.get(k); if (blank(v)) return null; const s = txt(v); return s.length <= 254 && EMAIL.test(s) ? s : err(r, 'row.email_invalid', k); },
    /** code -> id (or the code itself for unit / value-set references) */
    ref(r: Rec, k: string, ids: Map<string, string>, req = false, upper = true): any {
      const v = r.get(k);
      if (blank(v)) return req ? err(r, 'row.required_missing', k) : null;
      const id = ids.get(upper ? txt(v).toUpperCase() : txt(v));
      return id === undefined ? err(r, 'row.reference_unknown', k) : id;
    },
  };
  return { t, err, count, sheet, P };
}
type Reader = ReturnType<typeof reader>;

interface Ent { r: Rec; code: string; id: string; ex?: Row | undefined; vals: Row; st: St; skip?: boolean }
const idsOf = (wb: Map<string, Ent>, cat: Row[]) => new Map<string, string>([...cat.map((x) => [x.code as string, x.id as string] as const), ...[...wb].map(([c, e]) => [c, e.id] as const)]);

/** Upsert-by-code sheet: entity per valid code; st compares the given columns with the existing row. */
function simple(R: Reader, recs: Rec[], existing: Row[], re: RegExp, fields: Array<[string, (r: Rec) => unknown]>, upper = true) {
  const out = new Map<string, Ent>();
  for (const r of recs) {
    const code = R.P.code(r, 'code', re, true, upper);
    if (code === BAD) continue;
    if (out.has(code)) { R.err(r, 'row.duplicate_code', 'code'); continue; }
    const vals: Row = {};
    for (const [c, f] of fields) vals[c] = f(r);
    const ex = existing.find((x) => x.code === code);
    out.set(code, { r, code, id: ex?.id ?? uuidv7(), ex, vals, st: !ex ? 'add' : differs(vals, ex, Object.keys(vals)) ? 'change' : 'same' });
  }
  return out;
}
async function applySimple(w: Writer, t: string, m: Map<string, Ent>) {
  for (const e of m.values()) {
    if (e.skip) continue;
    if (e.st === 'add') await ins(w, t, { id: e.id, code: e.code, ...e.vals });
    else if (e.st === 'change') await upd(w, t, e.id, e.vals);
  }
}

/** DFS: is `to` reachable from `from`? */
function reaches(edges: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>(), stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(edges.get(n) ?? []));
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ catalog_master
const MASTER_SHEETS: Record<string, string[]> = {
  Departments: ['code', 'name', 'report_order', 'report_heading'],
  SpecimenTypes: ['code', 'name', 'report_label'],
  Containers: ['code', 'name', 'additive', 'cap_colour_display', 'default_specimen_type_code'],
  Methods: ['code', 'name'],
  Units: ['code', 'display'],
  ValueSets: ['value_set_code', 'is_ordered', 'value_code', 'value_display', 'sort_order'],
  Tests: ['code', 'name', 'department_code', 'workflow_type', 'report_order', 'is_orderable', 'specimen_type_codes', 'container_code'],
  Analytes: ['test_code', 'analyte_code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable', 'result_type', 'unit_code', 'decimals', 'method_code', 'value_set_code', 'formula'],
  ReferenceRanges: ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code', 'kind', 'low', 'high', 'normal_codes', 'display_text'],
  CriticalLimits: ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code', 'low', 'high', 'abnormal_codes'],
  Panels: ['code', 'name', 'panel_kind', 'sex_restriction', 'department_code'],
  PanelMembers: ['panel_code', 'member_code', 'sort_order'],
  CommentCodes: ['code', 'department_code', 'text'],
  TatTargets: ['test_code', 'priority', 'segment', 'target_minutes'],
};
const NEED: Record<string, string[]> = {
  Departments: ['code', 'name'], SpecimenTypes: ['code', 'name'], Containers: ['code', 'name'], Methods: ['code', 'name'], Units: ['code'],
  ValueSets: ['value_set_code', 'value_code', 'value_display'], Tests: ['code', 'name', 'department_code'], Analytes: ['test_code', 'analyte_code', 'name', 'result_type'],
  ReferenceRanges: ['analyte_code'], CriticalLimits: ['analyte_code'], Panels: ['code', 'name', 'panel_kind'], PanelMembers: ['panel_code', 'member_code'],
  CommentCodes: ['code', 'text'], TatTargets: ['test_code', 'priority', 'target_minutes'],
};

async function planMaster(sheets: Sheet[], q: Q, tenantId: string, flag: Flag): Promise<KindPlan> {
  const R = reader(sheets, flag);
  const { P, err, count } = R;
  // [CONV] absent catalog_master sheets are "no rows" (upsert semantics), not an error.
  const S = (n: string) => R.sheet(n, MASTER_SHEETS[n]!, NEED[n]!, false);
  // ponytail: whole-tenant reads, fine at catalog scale (≤ a few thousand rows per table).
  const all = async (t: string) => (await q(`SELECT * FROM catalog.${t} WHERE tenant_id = $1`, [tenantId])).rows as Row[];
  const glob = async (t: string) => (await q(`SELECT * FROM catalog.${t}`, [])).rows as Row[];
  const cat = {
    dept: await all('departments'), spec: await all('specimen_types'), cont: await all('containers'), meth: await all('methods'),
    units: await all('cs_units'), gUnits: await glob('g_units'), vsets: await all('cs_value_sets'), vvals: await all('cs_value_set_values'),
    gSets: await glob('g_value_sets'), gVals: await glob('g_value_set_values'),
    ord: await all('orderables'), tests: await all('tests'), panels: await all('panels'), pm: await all('panel_members'), tst: await all('test_specimen_types'),
    an: await all('analytes'), av: await all('analyte_versions'), rs: await all('reference_range_sets'), rr: await all('reference_ranges'),
    cs: await all('critical_limit_sets'), cl: await all('critical_limits'), cc: await all('comment_codes'), tat: await all('tat_targets'),
  };
  const extra = { analyte_versions: 0, range_sets: 0, critical_sets: 0 };
  const drafts: KindPlan['drafts'] = [];

  // ---- masters
  const depts = simple(R, S('Departments'), cat.dept, MASTER_RE, [
    ['name', (r) => P.str(r, 'name', 100, true)], ['report_order', (r) => P.int(r, 'report_order', 0, 9999, 100)], ['report_heading', (r) => P.str(r, 'report_heading', 100)]]);
  const deptIds = idsOf(depts, cat.dept);
  const specs = simple(R, S('SpecimenTypes'), cat.spec, MASTER_RE, [
    ['name', (r) => P.str(r, 'name', 100, true)], ['report_label', (r) => P.str(r, 'report_label', 100) ?? txt(r.get('name'))]]);   // [CONV] blank label = name
  const specIds = idsOf(specs, cat.spec);
  const conts = simple(R, S('Containers'), cat.cont, MASTER_RE, [
    ['name', (r) => P.str(r, 'name', 100, true)], ['additive', (r) => P.str(r, 'additive', 60)], ['cap_colour_display', (r) => P.str(r, 'cap_colour_display', 40)],
    ['default_specimen_type_id', (r) => P.ref(r, 'default_specimen_type_code', specIds)]]);
  const contIds = idsOf(conts, cat.cont);
  const meths = simple(R, S('Methods'), cat.meth, MASTER_RE, [['name', (r) => P.str(r, 'name', 120, true)]]);
  const methIds = idsOf(meths, cat.meth);
  const units = simple(R, S('Units'), cat.units, UNIT_RE, [['display', (r) => P.str(r, 'display', 32) ?? '']], false);
  for (const u of units.values()) if (!u.ex && cat.gUnits.some((g) => g.code === u.code)) { u.st = 'same'; u.skip = true; }   // [CONV] a global unit is used, never shadowed
  const unitCodes = new Map<string, string>([...[...cat.gUnits, ...cat.units].map((u) => [u.code as string, u.code as string] as const), ...[...units.keys()].map((c) => [c, c] as const)]);
  for (const m of [depts, specs, conts, meths, units]) for (const e of m.values()) count(e.r, e.st);

  // ---- value sets (one row = one value; the set is created from its first row)
  interface VSet { code: string; id: string; ex?: Row | undefined; ordered: boolean; st: St; values: Map<string, { r: Rec; id: string; ex?: Row | undefined; display: string; sort: number; st: St }> }
  const vsets = new Map<string, VSet>();
  for (const r of S('ValueSets')) {
    const code = P.code(r, 'value_set_code', VS_RE), vcode = P.code(r, 'value_code', VALUE_RE);
    const ordered = P.yn(r, 'is_ordered', false), display = P.str(r, 'value_display', 40, true), sort = P.int(r, 'sort_order', -2147483648, 2147483647, r.rn);
    if (code === BAD) continue;
    let s = vsets.get(code);
    if (!s) {
      if (cat.gSets.some((g) => g.code === code)) { err(r, 'row.duplicate_code', 'value_set_code'); continue; }   // a tenant code must differ from a global one
      const ex = cat.vsets.find((x) => x.code === code);
      s = { code, id: ex?.id ?? uuidv7(), ex, ordered: ordered === true, st: !ex ? 'add' : ex.is_ordered !== (ordered === true) ? 'change' : 'same', values: new Map() };
      vsets.set(code, s);
    } else if (ordered !== BAD && s.ordered !== (ordered === true)) err(r, 'row.value_invalid', 'is_ordered');
    if (vcode === BAD) continue;
    if (s.values.has(vcode)) { err(r, 'row.duplicate_code', 'value_code'); continue; }
    const ex = s.ex ? cat.vvals.find((x) => x.value_set_id === s!.id && x.code === vcode) : undefined;
    const st: St = !ex ? 'add' : s.st === 'change' || ex.display !== display || Number(ex.sort_order) !== sort ? 'change' : 'same';
    s.values.set(vcode, { r, id: ex?.id ?? uuidv7(), ex, display, sort, st });
    count(r, st);
  }
  /** value-set code -> { ordered, value codes } over workbook ∪ tenant ∪ global sets */
  const vsInfo = new Map<string, { ordered: boolean; values: Set<string> }>();
  for (const g of cat.gSets) vsInfo.set(g.code, { ordered: g.is_ordered === true, values: new Set(cat.gVals.filter((v) => v.value_set_code === g.code).map((v) => v.code)) });
  for (const s of cat.vsets) vsInfo.set(s.code, { ordered: s.is_ordered === true, values: new Set(cat.vvals.filter((v) => v.value_set_id === s.id).map((v) => v.code)) });
  for (const s of vsets.values()) vsInfo.set(s.code, { ordered: s.ordered, values: new Set([...(vsInfo.get(s.code)?.values ?? []), ...s.values.keys()]) });

  // ---- tests and panels (one code space: orderables)
  interface OEnt extends Ent { kind: 'test' | 'panel'; ord: Row; sub: Row; specs?: Row[]; specChanged?: boolean }
  const orderables = new Map<string, OEnt>();
  const ordBy = (code: string) => cat.ord.find((o) => o.code === code);
  const canonSpecs = (rows: Row[]) => rows.map((x) => `${x.specimen_type_id}|${x.is_preferred === true}|${x.container_id ?? ''}`).sort().join(',');
  for (const r of S('Tests')) {
    const code = P.code(r, 'code', CODE_RE);
    const ord = { name: P.str(r, 'name', 200, true), department_id: P.ref(r, 'department_code', deptIds, true), is_orderable: P.yn(r, 'is_orderable', true) };
    const sub = { workflow_type: P.en(r, 'workflow_type', WORKFLOWS, 'standard'), report_order: P.int(r, 'report_order', 0, 9999, 100) };
    const container = P.ref(r, 'container_code', contIds);
    const specIdsOf = [...new Set(P.list(r, 'specimen_type_codes').map((c) => c.toUpperCase()))].map((c) => specIds.get(c) ?? (err(r, 'row.reference_unknown', 'specimen_type_codes'), BAD));
    if (code === BAD) continue;
    if (orderables.has(code)) { err(r, 'row.duplicate_code', 'code'); continue; }
    const ex = ordBy(code);
    if (ex && ex.kind !== 'test') { err(r, 'row.duplicate_code', 'code'); continue; }   // the code is taken by a panel
    const specRows = specIdsOf.map((id, i) => ({ specimen_type_id: id, is_preferred: i === 0, container_id: container }));
    const exSub = ex ? cat.tests.find((t) => t.id === ex.id) ?? {} : {};
    const specChanged = !ex || canonSpecs(specRows) !== canonSpecs(cat.tst.filter((x) => x.test_id === ex.id));
    const st: St = !ex ? 'add' : differs(ord, ex, Object.keys(ord)) || differs(sub, exSub, Object.keys(sub)) || specChanged ? 'change' : 'same';
    orderables.set(code, { r, code, id: ex?.id ?? uuidv7(), ex, vals: {}, st, kind: 'test', ord, sub, specs: specRows, specChanged });
    count(r, st);
  }
  for (const r of S('Panels')) {
    const code = P.code(r, 'code', CODE_RE);
    const ord = { name: P.str(r, 'name', 200, true), department_id: P.ref(r, 'department_code', deptIds), sex_restriction: P.en(r, 'sex_restriction', ['male', 'female'], null) };
    const sub = { panel_kind: P.en(r, 'panel_kind', ['clinical', 'package'], null, true) };
    if (code === BAD) continue;
    const ex = ordBy(code);
    if (orderables.has(code) || (ex && ex.kind !== 'panel')) { err(r, 'row.duplicate_code', 'code'); continue; }
    const exSub = ex ? cat.panels.find((p) => p.id === ex.id) ?? {} : {};
    const st: St = !ex ? 'add' : differs(ord, ex, Object.keys(ord)) || differs(sub, exSub, Object.keys(sub)) ? 'change' : 'same';
    orderables.set(code, { r, code, id: ex?.id ?? uuidv7(), ex, vals: {}, st, kind: 'panel', ord, sub });
    count(r, st);
  }
  const kindIds = (kind: string) => new Map<string, string>([...cat.ord.filter((o) => o.kind === kind).map((o) => [o.code as string, o.id as string] as const),
    ...[...orderables.values()].filter((o) => o.kind === kind).map((o) => [o.code, o.id] as const)]);
  const testIds = kindIds('test'), panelIds = kindIds('panel');
  const anyIds = new Map([...testIds, ...panelIds]);

  // ---- panel members: a panel listed here gets exactly these members; cycles rejected (row.panel_cycle)
  const members = new Map<string, Array<{ r: Rec; member: string; sort: number }>>();
  for (const r of S('PanelMembers')) {
    const panel = P.ref(r, 'panel_code', panelIds, true), member = P.ref(r, 'member_code', anyIds, true), sort = P.int(r, 'sort_order', 0, 9999, 1);
    if (panel === BAD || member === BAD) continue;
    const list = members.get(panel) ?? [];
    if (list.some((m) => m.member === member)) { err(r, 'row.duplicate_code', 'member_code'); continue; }
    list.push({ r, member, sort }); members.set(panel, list);
  }
  const edges = new Map<string, string[]>();
  for (const p of cat.pm) if (!members.has(p.panel_id)) edges.set(p.panel_id, [...(edges.get(p.panel_id) ?? []), p.member_orderable_id]);
  for (const [p, list] of members) edges.set(p, list.map((m) => m.member));
  const memberChanged = new Set<string>();
  for (const [p, list] of members) {
    const old = cat.pm.filter((x) => x.panel_id === p);
    for (const m of list) {
      if (m.member === p || reaches(edges, m.member, p)) err(m.r, 'row.panel_cycle', 'member_code');
      const o = old.find((x) => x.member_orderable_id === m.member);
      count(m.r, !o ? 'add' : Number(o.sort_order) !== m.sort ? 'change' : 'same');
    }
    const canon = (xs: Array<[string, number]>) => xs.map(([a, b]) => `${a}:${b}`).sort().join(',');
    if (canon(list.map((m) => [m.member, m.sort])) !== canon(old.map((x) => [x.member_orderable_id, Number(x.sort_order)]))) memberChanged.add(p);
  }

  // ---- analytes: non-clinical in place; clinical difference vs the current published version -> new version (AC-17.3)
  interface AEnt { r: Rec; code: string; id: string; ex?: Row | undefined; testId: string; nc: Row; cl: Row; cur?: Row | undefined; refs: string[]; formula: string | null; st: St; newVersion: boolean; ncChanged: boolean }
  const analytes = new Map<string, AEnt>();
  const curOf = (id: string) => latest(cat.av, (v) => v.analyte_id === id && v.status === 'published');
  for (const r of S('Analytes')) {
    const testId = P.ref(r, 'test_code', testIds, true), code = P.code(r, 'analyte_code', ANALYTE_RE);
    const nc = { name: P.str(r, 'name', 120, true), print_name: P.str(r, 'print_name', 120), report_subheading: P.str(r, 'report_subheading', 80),
      sort_order: P.int(r, 'sort_order', 0, 9999, 100), is_reportable: P.yn(r, 'is_reportable', true) };
    const rt = P.en(r, 'result_type', RESULT_TYPES, null, true);
    const cl: Row = { result_type: rt, unit_code: P.ref(r, 'unit_code', unitCodes, false, false), decimals: P.int(r, 'decimals', 0, 6, null),
      method_id: P.ref(r, 'method_code', methIds), value_set_code: P.ref(r, 'value_set_code', new Map([...vsInfo.keys()].map((c) => [c, c]))) };
    if (rt === 'numeric' && cl.decimals === null) err(r, 'row.required_missing', 'decimals');
    if ((rt === 'ordinal' || rt === 'coded') && cl.value_set_code === null) err(r, 'row.required_missing', 'value_set_code');
    // [CONV] no "ordinal needs an ORDERED set" rule here: the C0 starter workbook (CR-C3-007) pairs ordinal U_NITRITE with unordered POS_NEG (open point).
    const f = P.str(r, 'formula', 500);
    cl.formula_expression = typeof f === 'string' ? f.replace(/\s+/g, ' ').trim() : f;
    if (code === BAD) continue;
    if (analytes.has(code)) { err(r, 'row.duplicate_code', 'analyte_code'); continue; }
    const ex = cat.an.find((a) => a.code === code);
    if (ex && testId !== BAD && ex.test_id !== testId) err(r, 'row.value_invalid', 'test_code');   // code and test never change
    const cur = ex ? curOf(ex.id) : undefined;
    const newVersion = !cur || differs(cl, cur, CL);
    const ncChanged = !!ex && differs(nc, ex, NC);
    analytes.set(code, { r, code, id: ex?.id ?? uuidv7(), ex, testId, nc, cl, cur, refs: [], formula: typeof f === 'string' ? cl.formula_expression : null,
      st: !ex ? 'add' : ncChanged || newVersion ? 'change' : 'same', newVersion, ncChanged });
  }
  // formulas: parse, inputs known + numeric, no self reference, no cycle (workbook formulas replace the catalog's current ones)
  const anIds = new Map<string, string>([...cat.an.map((a) => [a.code as string, a.id as string] as const), ...[...analytes.values()].map((a) => [a.code, a.id] as const)]);
  const typeOf = (c: string) => analytes.get(c)?.cl.result_type ?? (() => { const a = cat.an.find((x) => x.code === c); return a ? curOf(a.id)?.result_type : undefined; })();
  const fEdges = new Map<string, string[]>();
  for (const a of cat.an) fEdges.set(a.code, [...(curOf(a.id)?.formula_inputs ?? [])]);
  for (const a of analytes.values()) {
    if (a.formula === null) { fEdges.set(a.code, []); continue; }
    const p = parseFormula(a.formula);
    const refs = p.ast && !p.errors.length ? [...formulaRefs(p.ast)] : null;
    a.refs = refs ?? [];
    fEdges.set(a.code, a.refs);
    const activeCat = (c: string) => cat.an.some((x) => x.code === c && x.is_active === true);
    if (!refs || a.cl.result_type !== 'numeric' || refs.includes(a.code) || refs.some((c) => !(analytes.has(c) || activeCat(c)) || typeOf(c) !== 'numeric')) err(a.r, 'row.formula_invalid', 'formula');
  }
  for (const a of analytes.values()) if (a.refs.some((c) => reaches(fEdges, c, a.code)) && !a.r.bad) err(a.r, 'row.formula_invalid', 'formula');
  for (const a of analytes.values()) {
    count(a.r, a.st);
    if (a.newVersion) { extra.analyte_versions++; if (a.ex) for (const d of cat.av.filter((v) => v.analyte_id === a.id && v.status === 'draft')) drafts.push({ table: 'analyte_versions', id: d.id }); }
  }
  const testOfAnalyte = (id: string) => [...analytes.values()].find((a) => a.id === id)?.testId ?? cat.an.find((a) => a.id === id)?.test_id;
  const clinicalOf = (id: string): Row | undefined => [...analytes.values()].find((a) => a.id === id)?.cl ?? curOf(id);
  const valueSetOf = (id: string) => clinicalOf(id)?.value_set_code as string | undefined;

  // ---- reference ranges / critical limits: a set per analyte; a new set when the rows differ (as a set) from the current published one
  interface Fam { sheet: string; ref: boolean; sets: Row[]; bands: Row[]; setT: string; bandT: string; counter: 'range_sets' | 'critical_sets' }
  const bandKey = (b: Row, ref: boolean) => [b.sex, b.age_low_value, b.age_low_unit, b.age_high_value, b.age_high_unit, b.specimen_type_id, ref ? b.kind : '',
    numKey(b.low), numKey(b.high), norm(ref ? b.normal_codes : b.abnormal_codes), ref ? b.display_text : ''].map((x) => String(x ?? '')).join('|');
  const famPlans: Array<{ f: Fam; analyteId: string; bands: Row[]; cur?: Row | undefined }> = [];
  function family(f: Fam) {
    const groups = new Map<string, Array<{ r: Rec; b: Row }>>();
    for (const r of S(f.sheet)) {
      const aId = P.ref(r, 'analyte_code', anIds, true);
      const sex = P.en(r, 'sex', ['any', 'male', 'female'], 'any');
      const alv = P.int(r, 'age_low', 0, 200, null), alu = P.en(r, 'age_low_unit', AGE_UNITS, null);
      const ahv = P.int(r, 'age_high', 1, 200, null), ahu = P.en(r, 'age_high_unit', AGE_UNITS, null);
      if (alv !== BAD && alu !== BAD && (alv === null) !== (alu === null)) err(r, 'row.value_invalid', 'age_low_unit');
      if (ahv !== BAD && ahu !== BAD && (ahv === null) !== (ahu === null)) err(r, 'row.value_invalid', 'age_high_unit');
      const spec = P.ref(r, 'specimen_type_code', specIds);
      const low = P.num(r, 'low'), high = P.num(r, 'high');
      const codesCol = f.ref ? 'normal_codes' : 'abnormal_codes';
      const codes = P.list(r, codesCol).map((c) => c.toUpperCase());
      if (codes.length > 20) err(r, 'row.value_invalid', codesCol);
      const vs = aId !== BAD ? valueSetOf(aId) : undefined;
      if (codes.length && vs && !codes.every((c) => vsInfo.get(vs)?.values.has(c))) err(r, 'row.reference_unknown', codesCol);
      if (typeof low === 'number' && typeof high === 'number' && low > high) err(r, 'row.value_invalid', 'high');
      const b: Row = { sex, age_low_value: alv, age_low_unit: alu, age_high_value: ahv, age_high_unit: ahu, specimen_type_id: spec, low, high };
      if (f.ref) {
        const kind = P.en(r, 'kind', ['numeric', 'text', 'ordinal'], 'numeric');
        let text = P.str(r, 'display_text', 500);
        if (kind === 'numeric' && low === null && high === null) err(r, 'row.required_missing', 'low');
        if (kind !== 'numeric' && kind !== BAD && (low !== null || high !== null)) err(r, 'row.value_invalid', 'low');
        if (kind === 'ordinal' && !codes.length) err(r, 'row.required_missing', 'normal_codes');
        if (kind === 'ordinal' && text === null) text = codes.join(', ');                     // [CONV] the DB needs a display text for ordinal bands
        if (kind === 'text' && text === null) err(r, 'row.required_missing', 'display_text');
        Object.assign(b, { kind, normal_codes: codes.length ? codes : null, display_text: text });
      } else {
        if (low === null && high === null && !codes.length) err(r, 'row.required_missing', 'low');
        b.abnormal_codes = codes.length ? codes : null;
      }
      if (aId === BAD) continue;
      groups.set(aId, [...(groups.get(aId) ?? []), { r, b }]);
    }
    const days = (v: unknown, u: unknown, def: number) => (typeof v === 'number' && typeof u === 'string' ? v * DAYS[u]! : def);
    for (const [aId, list] of groups) {
      list.forEach((x, i) => {
        const lo = days(x.b.age_low_value, x.b.age_low_unit, 0), hi = days(x.b.age_high_value, x.b.age_high_unit, Infinity);
        for (const y of list.slice(0, i)) {
          const sexOv = x.b.sex === y.b.sex || x.b.sex === 'any' || y.b.sex === 'any';
          const specOv = x.b.specimen_type_id == null || y.b.specimen_type_id == null || x.b.specimen_type_id === y.b.specimen_type_id;
          if (sexOv && specOv && lo < days(y.b.age_high_value, y.b.age_high_unit, Infinity) && days(y.b.age_low_value, y.b.age_low_unit, 0) < hi) { err(x.r, 'row.range_overlap', 'age_low'); break; }
        }
      });
      const cur = latest(f.sets, (s) => s.analyte_id === aId && s.status === 'published');
      const oldKeys = cur ? f.bands.filter((b) => b.set_id === cur.id).map((b) => bandKey(b, f.ref)) : [];
      const newKeys = list.map((x) => bandKey(x.b, f.ref));
      const changed = !cur || [...oldKeys].sort().join('\n') !== [...newKeys].sort().join('\n');
      for (const x of list) count(x.r, !changed ? 'same' : !cur ? 'add' : oldKeys.includes(bandKey(x.b, f.ref)) ? 'same' : 'change');
      if (!changed) continue;
      extra[f.counter]++;
      for (const d of f.sets.filter((s) => s.analyte_id === aId && s.status === 'draft')) drafts.push({ table: f.setT, id: d.id });
      famPlans.push({ f, analyteId: aId, bands: list.map((x) => x.b), cur });
    }
  }
  family({ sheet: 'ReferenceRanges', ref: true, sets: cat.rs, bands: cat.rr, setT: 'reference_range_sets', bandT: 'reference_ranges', counter: 'range_sets' });
  family({ sheet: 'CriticalLimits', ref: false, sets: cat.cs, bands: cat.cl, setT: 'critical_limit_sets', bandT: 'critical_limits', counter: 'critical_sets' });

  // ---- comment codes (upsert by code + department); a text change versions comment_code_texts like the service does
  const comments = new Map<string, { r: Rec; code: string; dept: string | null; text: string; ex?: Row | undefined; st: St }>();
  for (const r of S('CommentCodes')) {
    const code = P.code(r, 'code', COMMENT_RE), dept = P.ref(r, 'department_code', deptIds), text = P.str(r, 'text', 2000, true);
    if (code === BAD || dept === BAD) continue;
    const key = `${code}|${dept ?? ''}`;
    if (comments.has(key)) { err(r, 'row.duplicate_code', 'code'); continue; }
    const ex = cat.cc.find((c) => c.code === code && (c.department_id ?? null) === dept);
    const st: St = !ex ? 'add' : ex.text !== text ? 'change' : 'same';
    comments.set(key, { r, code, dept, text, ex, st });
    count(r, st);
  }

  // ---- TAT targets (one open row per test + priority; a change ends the open row and inserts the new one)
  const tats: Array<{ r: Rec; testId: string; priority: string; segment: string; seconds: number; ex?: Row | undefined; st: St }> = [];
  for (const r of S('TatTargets')) {
    const testId = P.ref(r, 'test_code', testIds, true), priority = P.en(r, 'priority', ['routine', 'urgent'], null, true);
    const segment = P.en(r, 'segment', ['within_lab', 'total'], 'within_lab'), minutes = P.int(r, 'target_minutes', 1, 43_200, null, true);
    if (testId === BAD || priority === BAD) continue;
    if (tats.some((x) => x.testId === testId && x.priority === priority)) { err(r, 'row.duplicate_code', 'priority'); continue; }
    const ex = cat.tat.find((x) => x.test_id === testId && x.priority === priority && x.effective_to == null);
    const seconds = typeof minutes === 'number' ? minutes * 60 : NaN;
    const st: St = !ex ? 'add' : ex.segment !== segment || Number(ex.target_seconds) !== seconds ? 'change' : 'same';
    tats.push({ r, testId, priority, segment, seconds, ex, st });
    count(r, st);
  }

  // ------------------------------------------------------------------------------------------------ apply (one transaction, FK order)
  async function apply(w: Writer) {
    await applySimple(w, 'departments', depts);
    await applySimple(w, 'specimen_types', specs);
    await applySimple(w, 'containers', conts);
    await applySimple(w, 'methods', meths);
    await applySimple(w, 'cs_units', units);
    for (const s of vsets.values()) {
      if (s.st === 'add') await ins(w, 'cs_value_sets', { id: s.id, code: s.code, display: s.code, is_ordered: s.ordered });   // [CONV] set display = code
      else if (s.st === 'change') await upd(w, 'cs_value_sets', s.id, { is_ordered: s.ordered });
      for (const [code, v] of s.values) {
        if (v.st === 'add') await ins(w, 'cs_value_set_values', { id: v.id, value_set_id: s.id, code, display: v.display, sort_order: v.sort });
        else if (v.st === 'change') await upd(w, 'cs_value_set_values', v.id, { display: v.display, sort_order: v.sort });
      }
    }
    for (const o of orderables.values()) {
      if (o.st === 'same') continue;
      w.touched.add(o.id);
      const subT = o.kind === 'test' ? 'tests' : 'panels';
      if (o.st === 'add') {
        await ins(w, 'orderables', { id: o.id, kind: o.kind, code: o.code, ...o.ord, ...(o.kind === 'panel' ? { is_orderable: true } : {}), revision: 0 });
        await ins(w, subT, { id: o.id, kind: o.kind, ...o.sub });
      } else {
        if (differs(o.ord, o.ex!, Object.keys(o.ord))) await upd(w, 'orderables', o.id, o.ord);
        const exSub = (o.kind === 'test' ? cat.tests : cat.panels).find((x) => x.id === o.id) ?? {};
        if (differs(o.sub, exSub, Object.keys(o.sub))) await upd(w, subT, o.id, o.sub);
      }
      if (o.kind === 'test' && o.specChanged) {
        if (o.ex) await w.q('DELETE FROM catalog.test_specimen_types WHERE tenant_id = $1 AND test_id = $2', [w.tenantId, o.id]);
        for (const s of o.specs!) await ins(w, 'test_specimen_types', { test_id: o.id, ...s }, false);
      }
    }
    for (const p of memberChanged) {
      w.touched.add(p);
      await w.q('DELETE FROM catalog.panel_members WHERE tenant_id = $1 AND panel_id = $2', [w.tenantId, p]);
      for (const m of members.get(p)!) await ins(w, 'panel_members', { panel_id: p, member_orderable_id: m.member, sort_order: m.sort }, false);
    }
    for (const a of analytes.values()) {
      if (a.st === 'same') continue;
      w.touched.add(a.testId);
      if (!a.ex) await ins(w, 'analytes', { id: a.id, test_id: a.testId, code: a.code, ...a.nc });
      else if (a.ncChanged) await upd(w, 'analytes', a.id, a.nc);
    }
    for (const a of analytes.values()) {        // after every analyte exists (formula_dependencies FKs)
      if (!a.newVersion) continue;
      const id = uuidv7();
      const row = { id, analyte_id: a.id, version_no: maxNo(cat.av, (v) => v.analyte_id === a.id) + 1, ...a.cl, formula_inputs: a.refs, source_import_id: w.importId };
      if (a.cur) await upd(w, 'analyte_versions', a.cur.id, { status: 'superseded', effective_to: w.effective });
      if (!a.refs.length) { await ins(w, 'analyte_versions', { ...row, ...published(w) }); continue; }
      await ins(w, 'analyte_versions', { ...row, status: 'draft' });         // edges are writable only while the version is a draft (tg_parent_is_draft)
      for (const c of new Set(a.refs)) await ins(w, 'formula_dependencies', { analyte_version_id: id, analyte_id: a.id, input_analyte_id: anIds.get(c) }, false);
      await upd(w, 'analyte_versions', id, published(w));
    }
    for (const { f, analyteId, bands, cur } of famPlans) {
      const id = uuidv7(), cl = clinicalOf(analyteId);
      w.touched.add(testOfAnalyte(analyteId)!);
      await ins(w, f.setT, { id, analyte_id: analyteId, version_no: maxNo(f.sets, (s) => s.analyte_id === analyteId) + 1, status: 'draft',
        unit_code: cl?.unit_code ?? null, method_id: cl?.method_id ?? null, source_import_id: w.importId });
      for (const [i, b] of bands.entries()) await ins(w, f.bandT, { id: uuidv7(), set_id: id, ...b, sort_order: (i + 1) * 10 }, false);
      if (cur) await upd(w, f.setT, cur.id, { status: 'superseded', effective_to: w.effective });
      await upd(w, f.setT, id, published(w));
    }
    for (const c of comments.values()) {
      if (c.st === 'add') {
        const id = uuidv7();
        await ins(w, 'comment_codes', { id, code: c.code, department_id: c.dept, text: c.text });
        await ins(w, 'comment_code_texts', { id: uuidv7(), comment_code_id: id, text_version: 1, text: c.text, effective_from: w.now });
      } else if (c.st === 'change') {
        // ponytail: two text changes of one code at the same instant collide on UNIQUE(comment_code_id, effective_from) -> the job retries
        await upd(w, 'comment_codes', c.ex!.id, { text: c.text });
        await w.q('UPDATE catalog.comment_code_texts SET effective_to = $3, version = version + 1, updated_at = $3, updated_by = $4 WHERE tenant_id = $1 AND comment_code_id = $2 AND effective_to IS NULL',
          [w.tenantId, c.ex!.id, w.now, w.actor]);
        await ins(w, 'comment_code_texts', { id: uuidv7(), comment_code_id: c.ex!.id, text_version: Number(c.ex!.version) + 1, text: c.text, effective_from: w.now });
      }
    }
    for (const t of tats) {
      if (t.st === 'same') continue;
      w.touched.add(t.testId);
      if (t.ex) await upd(w, 'tat_targets', t.ex.id, { effective_to: w.effective });
      await ins(w, 'tat_targets', { id: uuidv7(), test_id: t.testId, priority: t.priority, segment: t.segment, target_seconds: t.seconds, effective_from: w.effective });
    }
  }
  return { ...R.t, extra, drafts, apply };
}

// ------------------------------------------------------------------------------------------------ referrers (AC-17.6): upsert by doctor_code, blank = auto DR{seq:5}
async function planReferrers(sheets: Sheet[], q: Q, tenantId: string, flag: Flag): Promise<KindPlan> {
  const R = reader(sheets, flag);
  const { P, err, count } = R;
  const recs = R.sheet('Doctors', DOCTOR_COLS, ['doctor_code', 'display_name'], true);
  const existing = (await q('SELECT * FROM catalog.doctors WHERE tenant_id = $1', [tenantId])).rows as Row[];
  const KEYS = ['display_name', 'name_normalised', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'is_verified'];
  const seen = new Set<string>(), matched = new Set<string>();
  const plan: Array<{ code: string | null; ex?: Row | undefined; vals: Row; st: St }> = [];
  for (const r of recs) {
    const code = P.code(r, 'doctor_code', PERSON_RE, false);
    const name = P.str(r, 'display_name', 120, true);
    const vals: Row = { display_name: name, name_normalised: typeof name === 'string' ? normaliseName(name) : null, qualification: P.str(r, 'qualification', 120),
      registration_council: P.str(r, 'registration_council', 20), registration_no: P.str(r, 'registration_no', 30), phone_e164: P.phone(r, 'phone_e164'), email: P.email(r, 'email') };
    const verified = P.yn(r, 'is_verified', null);
    if (typeof code === 'string') { if (seen.has(code)) { err(r, 'row.duplicate_code', 'doctor_code'); continue; } seen.add(code); }
    if (r.bad) continue;
    // a blank code matches an existing doctor of the same normalised name (never a duplicate on re-import)
    const ex = code ? existing.find((d) => d.doctor_code === code)
      : existing.filter((d) => d.name_normalised === vals.name_normalised && d.merged_into_id == null && !matched.has(d.id)).sort((a, b) => (a.doctor_code < b.doctor_code ? -1 : 1))[0];
    if (ex) matched.add(ex.id);
    vals.is_verified = verified === true || (verified === null && ex?.is_verified === true);   // [CONV] N on an existing verified doctor does not unverify
    const st: St = !ex ? 'add' : differs(vals, ex, KEYS) ? 'change' : 'same';
    plan.push({ code, ex, vals, st });
    count(r, st);
  }
  const taken = new Set([...existing.map((d) => d.doctor_code as string), ...seen]);
  async function apply(w: Writer) {
    for (const p of plan) {
      const verify = p.vals.is_verified === true && p.ex?.is_verified !== true ? { verified_at: w.now, verified_by: w.actor } : {};
      if (p.st === 'change') await upd(w, 'doctors', p.ex!.id, { ...p.vals, ...verify });
      if (p.st !== 'add') continue;
      let code = p.code;
      // auto code: same counter as the service; skips codes already taken (catalog or this sheet). The counter row lock serialises concurrent commits.
      while (code === null || (p.code === null && taken.has(code))) {
        const { rows } = await w.q('INSERT INTO catalog.code_counters (tenant_id, counter_key, next_value, created_by) VALUES ($1, $2, 2, $3) ' +
          'ON CONFLICT (tenant_id, counter_key) DO UPDATE SET next_value = next_value + 1, updated_at = now() RETURNING next_value', [w.tenantId, 'doctor_code', w.actor]);
        code = `DR${String(Number(rows[0].next_value) - 1).padStart(5, '0')}`;
      }
      taken.add(code);
      await ins(w, 'doctors', { id: uuidv7(), doctor_code: code, ...p.vals, ...verify, source: 'import' });
    }
  }
  return { ...R.t, extra: {}, drafts: [], apply };
}

// ------------------------------------------------------------------------------------------------ credit_parties (CR-C18-008): upsert by party_code (required)
async function planCreditParties(sheets: Sheet[], q: Q, tenantId: string, flag: Flag): Promise<KindPlan> {
  const R = reader(sheets, flag);
  const { P, err, count } = R;
  const recs = R.sheet('CreditParties', PARTY_COLS, ['party_code', 'name', 'kind'], true);
  const existing = (await q('SELECT * FROM catalog.credit_parties WHERE tenant_id = $1', [tenantId])).rows as Row[];
  const plan: Array<{ code: string; ex?: Row | undefined; vals: Row; st: St }> = [];
  for (const r of recs) {
    const code = P.code(r, 'party_code', PERSON_RE, true);
    const vals: Row = { name: P.str(r, 'name', 160, true), kind: P.en(r, 'kind', PARTY_KINDS, null, true), allows_credit: P.yn(r, 'allows_credit', true), pan: P.str(r, 'pan', 20),
      contact_phone_e164: P.phone(r, 'contact_phone_e164'), contact_email: P.email(r, 'contact_email'), billing_address: P.str(r, 'billing_address', 500) };
    if (code === BAD) continue;
    if (plan.some((p) => p.code === code)) { err(r, 'row.duplicate_code', 'party_code'); continue; }
    const ex = existing.find((p) => p.party_code === code);
    const st: St = !ex ? 'add' : differs(vals, ex, Object.keys(vals)) ? 'change' : 'same';
    plan.push({ code, ex, vals, st });
    count(r, st);
  }
  async function apply(w: Writer) {
    for (const p of plan) {
      if (p.st === 'add') await ins(w, 'credit_parties', { id: uuidv7(), party_code: p.code, ...p.vals });
      else if (p.st === 'change') await upd(w, 'credit_parties', p.ex!.id, p.vals);
    }
  }
  return { ...R.t, extra: {}, drafts: [], apply };
}

/** _meta (template_kind, template_version) + the kind's planner. */
export async function planKind(kind: string, sheets: Sheet[], q: Q, tenantId: string, flag: Flag): Promise<KindPlan> {
  const meta = sheets.find((s) => s.name === '_meta');
  const m = new Map<string, unknown>();
  for (const r of meta?.rows ?? []) if (typeof r[0] === 'string') m.set(r[0].trim(), r[1]);
  if (!meta || blank(m.get('template_kind')) || blank(m.get('template_version'))) flag('file.meta_missing', '_meta');
  else if (txt(m.get('template_kind')) !== kind || Number(m.get('template_version')) !== 1) flag('file.meta_mismatch', '_meta');
  const plan = kind === 'catalog_master' ? planMaster : kind === 'referrers' ? planReferrers : planCreditParties;
  return plan(sheets, q, tenantId, flag);
}
