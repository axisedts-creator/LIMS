// Orderables + tests #2, #23–#27 (02-TRD §5.2, §7.9; PRD AC-02.1/02.2, AC-08.1–08.4; 07-SECURITY S-1, S-5, S-12, AB-20).
// Validates its own input (import commits call it directly). Every write bumps the catalog revision and publishes catalog.changed.v1
// in the caller's transaction (T-03). Lock order on writes: orderables, tests, test_specimen_types, catalog_state.
// [CONV] uuidv7 via relative import until @lims/shared-ts is a services/api dependency (same as masters.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { assertCode } from '../domain/codes.js';
import { escapeLike, rankOrderables } from '../domain/orderableSearch.js';
import { isWorkflowType } from '../domain/workflowRules.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as repo from '../repo/tests.repo.js';
import { BOOL, checkFields, fail, invalid, isObj, mapPg, required, str, unknown, unsetOf, UUID, type Field } from './masters.service.js';
import { createRevisionService } from './revision.service.js';

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Ctx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly requestId: string; readonly tx: unknown; readonly now?: () => string }
interface Deps { events: { publish(ctx: unknown, type: string, input: object): Promise<unknown> } }

const ORD_COLS = ['id', 'kind', 'code', 'name', 'department_id', 'sex_restriction', 'is_orderable', 'is_active', 'revision'];
const TEST_COLS = ['id', 'workflow_type', 'report_order', 'uses_existing_material', 'version', 'is_active', 'short_name', 'display_name', 'tags', 'barcode_text', 'loyalty_points',
  'display_order', 'description', 'report_type', 'processing_type', 'template_ref', 'outsource_name', 'is_outsourced', 'is_popular', 'smart_report', 'print_category_wise', 'nabl',
  'accab_logo', 'auto_approval_enabled', 'use_normal_range_for_auto_approval', 'template_test', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes', 'category_id'];
const SUMMARY_TEST_COLS = ['id', 'workflow_type', 'category_id', 'short_name', 'display_name'];
const SPEC_COLS = ['specimen_type_id', 'container_id', 'is_preferred', 'min_volume_ul'];
const AN_COLS = ['id', 'test_id', 'code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable', 'is_active', 'version'];
const AV_COLS = ['id', 'analyte_id', 'version_no', 'status', 'result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression',
  'effective_from', 'effective_to', 'change_reason', 'version'];

const TAT_COLS = ['priority', 'segment', 'target_seconds', 'effective_from', 'effective_to'];
const TAT_KEYS = new Set(['priority', 'segment', 'target_seconds']);
const PRIORITIES = new Set(['routine', 'urgent']);
const SEGMENTS = new Set(['within_lab', 'total']);

type Tat = { priority: string; segment: string; target_seconds: number };
/** TRD #28: 1..2 targets, one per priority, one segment for the whole set, target_seconds 60..2592000; TatTargetInput is strict. */
function checkTat(v: unknown): Tat[] {
  if (!Array.isArray(v)) return fail([invalid('/targets')]);
  if (v.length < 1 || v.length > 2) return fail([invalid('/targets')]);   // [] rejected [CONV]: a set needs a new row to carry the revision event
  const errors: FieldError[] = [];
  const out = v.map((item, i): Tat => {
    const p = `/targets/${i}`;
    if (!isObj(item)) { errors.push(invalid(p)); return undefined as never; }
    for (const k of Object.keys(item)) if (!TAT_KEYS.has(k) && item[k] !== undefined) errors.push(unknown(`${p}${ptr(k)}`));
    const { priority: pr, segment: sg, target_seconds: ts } = item;
    if (pr === undefined) errors.push(required(`${p}/priority`));
    else if (typeof pr !== 'string' || !PRIORITIES.has(pr)) errors.push(invalid(`${p}/priority`));
    if (sg === undefined) errors.push(required(`${p}/segment`));
    else if (typeof sg !== 'string' || !SEGMENTS.has(sg)) errors.push(invalid(`${p}/segment`));
    if (ts === undefined) errors.push(required(`${p}/target_seconds`));
    else if (!(Number.isInteger(ts) && (ts as number) >= 60 && (ts as number) <= 2592000)) errors.push(invalid(`${p}/target_seconds`));
    return { priority: pr as string, segment: sg as string, target_seconds: ts as number };
  });
  if (!errors.length) {
    if (out.length === 2 && out[0]!.priority === out[1]!.priority) errors.push(invalid('/targets/1/priority'));
    if (out.length === 2 && out[0]!.segment !== out[1]!.segment) errors.push(invalid('/targets/1/segment'));   // AC-10.1: one segment per test
  }
  if (errors.length) fail(errors);
  return out;
}

const INT = (min: number, max: number): Field => ({ t: 'int', min, max });
const UUID_F: Field = { t: 'uuid' };
// T0B-TESTMGMT-1 (LD-318): the 24 ElabAssist parity fields of TestCreate / TestUpdate; display only, so they change in place (done_when 4).
const FLAGS = ['is_outsourced', 'is_popular', 'smart_report', 'print_category_wise', 'nabl', 'accab_logo', 'auto_approval_enabled', 'use_normal_range_for_auto_approval', 'template_test'];
const PARITY_FIELDS: Record<string, Field> = {
  short_name: str(1, 60), display_name: str(3, 300), tags: { t: 'strs', max: 20, itemMax: 60 }, barcode_text: str(1, 64), loyalty_points: INT(0, 1_000_000),
  display_order: INT(0, 9999), description: str(1, 2000),
  report_type: { t: 'enum', values: ['four_column', 'three_column', 'two_column', 'graph', 'template_based_html', 'micro_automated', 'cbc_four_column', 'micro_manual', 'histo', 'four_column_10_font'] },
  processing_type: { t: 'enum', values: ['local', 'branch_transfer', 'outsource_branch'] }, template_ref: str(1, 120), outsource_name: str(1, 200),
  ...Object.fromEntries(FLAGS.map((k) => [k, BOOL])), nabl_processing_centres: { t: 'strs', max: 20, itemMax: 200 }, font: str(1, 60),
  alert_before_expiry_minutes: INT(0, 525600), category_id: UUID_F,
};
const PARITY = Object.keys(PARITY_FIELDS);
const TEST_UNSET = ['short_name', 'display_name', 'barcode_text', 'description', 'template_ref', 'outsource_name', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes',
  'category_id', 'report_type', 'processing_type'];
const CREATE_FIELDS = { name: str(1, 200), department_id: UUID_F, report_order: INT(0, 9999), is_orderable: BOOL, uses_existing_material: BOOL, ...PARITY_FIELDS };
const UPDATE_FIELDS = { ...CREATE_FIELDS, is_active: BOOL };
const STAGES = ['registration', 'sample_collection', 'accession', 'result', 'approval_1', 'approval_2', 'release'];
const STAGE_KEYS = new Set(['stage', 'target_minutes']);

/** A row (or body) "uses" the parity model when any parity field holds a non-default value. */
const usesParity = (r: Record<string, unknown>) => PARITY.some((k) => r[k] != null && r[k] !== false && !(k === 'loyalty_points' && Number(r[k]) === 0));
/**
 * LD-318 "tags required for an orderable test". PINNED PICK (tester, flagged to the lead): it fires only for a test that uses the parity model (the request
 * touches a parity field, or the stored test already carries one), so the legacy bodies of the existing suites and the import commit stay valid unchanged.
 */
function tagsRule(touched: boolean, next: { is_orderable: unknown; tags: unknown }): FieldError[] {
  return touched && next.is_orderable !== false && !(Array.isArray(next.tags) && next.tags.length > 0) ? [invalid('/tags')] : [];
}
/** setTestTatTargets.stage_targets: <= 7 strict items, each stage once, minutes 0..43200 (StageTatTarget). */
function checkStages(v: unknown): Array<{ stage: string; target_minutes: number }> {
  const P = '/stage_targets';
  if (!Array.isArray(v) || v.length > STAGES.length) return fail([invalid(P)]);
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  const out = v.map((item, i) => {
    const p = `${P}/${i}`;
    if (!isObj(item)) { errors.push(invalid(p)); return undefined as never; }
    for (const k of Object.keys(item)) if (!STAGE_KEYS.has(k) && item[k] !== undefined) errors.push(unknown(`${p}${ptr(k)}`));
    const { stage, target_minutes: m } = item;
    if (stage === undefined) errors.push(required(`${p}/stage`));
    else if (typeof stage !== 'string' || !STAGES.includes(stage) || seen.has(stage)) errors.push(invalid(`${p}/stage`));
    else seen.add(stage);
    if (m === undefined) errors.push(required(`${p}/target_minutes`));
    else if (!(Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 43200)) errors.push(invalid(`${p}/target_minutes`));
    return { stage: stage as string, target_minutes: m as number };
  });
  if (errors.length) fail(errors);
  return out;
}
const SPEC_KEYS = new Set(SPEC_COLS);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SORTS = new Set(['code', '-code', 'name', '-name', 'report_order', '-report_order']);
const ptr = (k: string) => `/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
export const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

type Spec = { specimen_type_id: string; container_id: string | null; is_preferred: boolean; min_volume_ul: number | null };
/** TRD #24/#27: <= 10 entries (min 1 on replace), unique specimen types, exactly one preferred; SpecimenRequirement is strict. */
function checkSpecimens(v: unknown, min: number): Spec[] {
  const P = '/specimen_requirements';
  if (!Array.isArray(v) || v.length < min || v.length > 10) return fail([invalid(P)]);
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  let preferred = 0;
  const out = v.map((item, i): Spec => {
    const p = `${P}/${i}`;
    if (!isObj(item)) { errors.push(invalid(p)); return undefined as never; }
    for (const k of Object.keys(item)) if (!SPEC_KEYS.has(k) && item[k] !== undefined) errors.push(unknown(`${p}${ptr(k)}`));
    const { specimen_type_id: st, container_id: c, is_preferred: pref, min_volume_ul: vol } = item;
    if (st === undefined) errors.push(required(`${p}/specimen_type_id`));
    else if (!isUuid(st) || seen.has(st)) errors.push(invalid(`${p}/specimen_type_id`));
    else seen.add(st);
    if (c !== undefined && !isUuid(c)) errors.push(invalid(`${p}/container_id`));
    if (pref === undefined) errors.push(required(`${p}/is_preferred`));
    else if (typeof pref !== 'boolean') errors.push(invalid(`${p}/is_preferred`));
    if (vol !== undefined && !(Number.isInteger(vol) && (vol as number) >= 1 && (vol as number) <= 100000)) errors.push(invalid(`${p}/min_volume_ul`));
    if (pref === true) preferred++;
    return { specimen_type_id: st as string, container_id: (c as string | undefined) ?? null, is_preferred: pref as boolean, min_volume_ul: (vol as number | undefined) ?? null };
  });
  if (v.length && preferred !== 1) errors.push(invalid(P));
  if (errors.length) fail(errors);
  return out;
}

function checkId(v: unknown): string { return isUuid(v) ? v : fail([invalid('/id')]); }
function checkIfMatch(v: unknown): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 2147483647 ? (v as number) : fail([invalid('/if-match')]);
}
const workflowErr = (v: unknown, errors: FieldError[]) => { if (v !== undefined && !isWorkflowType(v)) errors.push(invalid('/workflow_type')); };

/** Query object: declared keys only; `undefined` = absent. */
export function checkQuery(query: unknown, allowed: readonly string[]): Record<string, unknown> {
  const q = query === undefined ? {} : query;
  if (!isObj(q)) return fail([invalid('')]);
  const bad = Object.keys(q).filter((k) => q[k] !== undefined && !allowed.includes(k));
  if (bad.length) fail(bad.map((k) => unknown(ptr(k))));
  return q;
}
export const isActiveOf = (v: unknown, errors: FieldError[]): boolean | undefined => {
  if (v === undefined || v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'all') return undefined;
  errors.push(invalid('/is_active'));
  return undefined;
};
export const limitOf = (v: unknown, dflt: number, max: number, errors: FieldError[]): number => {
  const n = v === undefined ? dflt : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v;
  if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max) return n as number;
  errors.push(invalid('/limit'));
  return dflt;
};

export function createTestsService(deps: Deps) {
  const revision = createRevisionService(deps);
  const nowIso = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, id: string, changeKind: string) =>
    revision.bumpRevision(ctx, { entityType: 'test', entityId: id, changeKind, effectiveFrom: nowIso(ctx) });

  async function deptCodes(tx: Tx, tenantId: string, ids: readonly unknown[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
    const rows = await repo.find(tx, 'departments', ['id', 'code'], tenantId, {}, { ids: uniq });
    return new Map(rows.map((r) => [r.id, r.code]));
  }

  const summary = (o: any, dept: Map<string, string>, wf?: string, panelKind?: string, extra: Record<string, unknown> = {}) => compact({
    id: o.id, kind: o.kind, code: o.code, name: o.name, department_id: o.department_id, department_code: o.department_id ? dept.get(o.department_id) : undefined,
    panel_kind: panelKind, sex_restriction: o.sex_restriction, workflow_type: wf, is_orderable: o.is_orderable === true, is_active: o.is_active === true, revision: Number(o.revision),
    ...extra,
  });
  /** OrderableSummary parity fields of tests (T0B-TESTMGMT-1): category_id + category_name, short_name, display_name; default_price_paisa from the
   *  tenant's default price list (T0D-FIX-1 item 5, LD-446), absent when that list has no price for the test. */
  async function testExtras(ctx: Ctx, rows: readonly any[]): Promise<Map<string, Record<string, unknown>>> {
    const tx = ctx.tx as Tx, t = ctx.tenantId;
    const catIds = [...new Set(rows.map((r) => r.category_id).filter((x): x is string => typeof x === 'string'))];
    const names = new Map((catIds.length ? await repo.find(tx, 'test_categories', ['id', 'name'], t, {}, { ids: catIds }) : []).map((c) => [c.id, c.name]));
    const prices = await repo.defaultPrices(tx, t, rows.map((r) => r.id as string), String(nowIso(ctx)));
    return new Map(rows.map((r) => [r.id, { category_id: r.category_id, category_name: r.category_id ? names.get(r.category_id) : undefined, short_name: r.short_name,
      display_name: r.display_name, default_price_paisa: prices.get(r.id) }]));
  }
  /** 404 for an unknown / other tenant's category (S-1), 400 /category_id for a deactivated one: a new link may only point at an active category. */
  async function checkCategory(tx: Tx, t: string, id: unknown): Promise<void> {
    if (id === undefined) return;
    const [c] = await repo.find(tx, 'test_categories', ['id', 'is_active'], t, { id });
    if (!c) throw new LimsError('common.not_found');
    if (c.is_active !== true) fail([invalid('/category_id')]);
  }

  const versionDto = (v: any) => {
    const out = compact(Object.fromEntries(AV_COLS.map((c) => [c, v[c]])));
    for (const k of ['effective_from', 'effective_to']) if (out[k] != null) out[k] = iso(out[k]);
    for (const k of ['version_no', 'decimals', 'version']) if (out[k] != null) out[k] = Number(out[k]);
    return out;
  };

  /** Full Test DTO (#25), read inside the caller's transaction. 6 statements regardless of analyte count. */
  async function detail(ctx: Ctx, id: string, asOf: Date) {
    const tx = ctx.tx as Tx, t = ctx.tenantId;
    const [o] = await repo.find(tx, 'orderables', ORD_COLS, t, { id, kind: 'test' });
    if (!o) throw new LimsError('common.not_found');
    const [row] = await repo.find(tx, 'tests', TEST_COLS, t, { id });
    if (!row) throw new LimsError('common.not_found');
    const dept = await deptCodes(tx, t, [o.department_id]);
    const specs = await repo.find(tx, 'test_specimen_types', SPEC_COLS, t, { test_id: id }, { order: 'is_preferred DESC, specimen_type_id' });
    const analytes = await repo.find(tx, 'analytes', AN_COLS, t, { test_id: id }, { order: 'sort_order, code' });
    const tat = await repo.tatAt(tx, TAT_COLS, t, id, asOf);
    // [CONV] a tests row WITHOUT the 20261117170000 columns (loyalty_points is NOT NULL there, so always present on the migrated schema) comes from a
    // pre-parity store (the in-memory catalog double of the older suites) that has no stage table either: skip the read instead of failing.
    const stages = row.loyalty_points === undefined ? undefined
      : (await repo.find(tx, 'test_stage_tat_targets', ['stage', 'target_minutes'], t, { test_id: id, is_active: true }))
        .sort((x, y) => STAGES.indexOf(x.stage) - STAGES.indexOf(y.stage)).map((s) => ({ stage: s.stage as string, target_minutes: Number(s.target_minutes) }));
    const versions = analytes.length ? await repo.analyteVersions(tx, AV_COLS, t, analytes.map((a) => a.id), asOf) : [];
    const current = new Map<string, any>(), draft = new Map<string, string>();
    for (const v of versions) {
      if (v.status === 'draft') draft.set(v.analyte_id, v.id);
      else if (!current.has(v.analyte_id) || Number(v.version_no) > Number(current.get(v.analyte_id).version_no)) current.set(v.analyte_id, v);
    }
    return {
      ...summary(o, dept, row.workflow_type),
      is_active: row.is_active === true,
      report_order: Number(row.report_order), uses_existing_material: row.uses_existing_material === true,
      specimen_requirements: specs.map((s) => compact({ ...pick(s, SPEC_COLS), min_volume_ul: s.min_volume_ul == null ? null : Number(s.min_volume_ul) })),
      analytes: analytes.map((a) => compact({
        ...pick(a, AN_COLS), sort_order: Number(a.sort_order), version: Number(a.version), is_reportable: a.is_reportable === true, is_active: a.is_active === true,
        current_version: current.has(a.id) ? versionDto(current.get(a.id)) : undefined, draft_version_id: draft.get(a.id),
      })),
      tat_targets: tat.map((r) => compact({ priority: r.priority, segment: r.segment, target_seconds: Number(r.target_seconds), effective_from: iso(r.effective_from),
        effective_to: r.effective_to == null ? undefined : iso(r.effective_to) })),
      ...(stages ? { stage_targets: stages } : {}),
      ...compact(pick(row, PARITY)),
      version: Number(row.version),
    };
  }

  /** Locks orderables then tests (same order as createTest); 404 if absent / a panel / another tenant's, 409 if stale. */
  async function lockTest(ctx: Ctx, id: string, expected: number) {
    const [o] = await repo.find(ctx.tx as Tx, 'orderables', ['id', 'is_orderable'], ctx.tenantId, { id, kind: 'test' }, { lock: true });
    if (!o) throw new LimsError('common.not_found');
    const [before] = await repo.find(ctx.tx as Tx, 'tests', TEST_COLS, ctx.tenantId, { id }, { lock: true });
    if (!before) throw new LimsError('common.not_found');
    if (Number(before.version) !== expected) throw new LimsError('common.version_conflict');
    return { ...before, is_orderable: o.is_orderable };
  }

  return {
    /** #2 — ranked §7.9; LIMIT after ranking (in SQL); constant 4 statements. */
    async searchOrderables(ctx: Ctx, query: unknown) {
      const q = checkQuery(query, ['q', 'kind', 'panel_kind', 'department_id', 'is_orderable', 'is_active', 'limit']);
      const errors: FieldError[] = [];
      const text = typeof q['q'] === 'string' && q['q'].length <= 64 ? q['q'].trim() : '';
      if (!text) errors.push(q['q'] === undefined ? required('/q') : invalid('/q'));
      if (q['kind'] !== undefined && q['kind'] !== 'test' && q['kind'] !== 'panel') errors.push(invalid('/kind'));
      if (q['panel_kind'] !== undefined && q['panel_kind'] !== 'clinical' && q['panel_kind'] !== 'package') errors.push(invalid('/panel_kind'));
      if (q['department_id'] !== undefined && !isUuid(q['department_id'])) errors.push(invalid('/department_id'));
      if (q['is_orderable'] !== undefined && typeof q['is_orderable'] !== 'boolean') errors.push(invalid('/is_orderable'));
      const isActive = isActiveOf(q['is_active'], errors);
      const limit = limitOf(q['limit'], 20, 50, errors);
      if (errors.length) fail(errors);

      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const panelKind = q['panel_kind'] as string | undefined;
      // panel_kind lives on catalog.panels (no joins): resolve the id set first, then the panel lookup below is not needed.
      const kindPanels = panelKind ? await repo.find(tx, 'panels', ['id', 'panel_kind'], t, { panel_kind: panelKind }) : undefined;
      const esc = escapeLike(text);
      const rows = await repo.searchOrderables(tx, ORD_COLS, {
        tenantId: t, exact: text.toUpperCase(), codePrefix: `${escapeLike(text.toUpperCase())}%`, namePrefix: `${esc}%`, nameContains: `%${esc}%`,
        isOrderable: (q['is_orderable'] as boolean | undefined) ?? true, ...(isActive === undefined ? {} : { isActive }),
        ...(panelKind ? { kind: 'panel', ids: kindPanels!.map((p) => p.id) } : q['kind'] ? { kind: q['kind'] as string } : {}),
        ...(q['department_id'] ? { departmentId: q['department_id'] as string } : {}), limit,
      });
      const ranked = rankOrderables(rows, text, limit);
      const ids = (k: string) => ranked.filter((r) => r.kind === k).map((r) => r.id);
      const dept = await deptCodes(tx, t, ranked.map((r) => r.department_id));
      const tests = await repo.find(tx, 'tests', SUMMARY_TEST_COLS, t, {}, { ids: ids('test') });
      const panels = kindPanels ?? await repo.find(tx, 'panels', ['id', 'panel_kind'], t, {}, { ids: ids('panel') });
      const wf = new Map(tests.map((r) => [r.id, r.workflow_type])), pk = new Map(panels.map((r) => [r.id, r.panel_kind]));
      const extra = await testExtras(ctx, tests);
      return { data: ranked.map((o) => summary(o, dept, wf.get(o.id), pk.get(o.id), extra.get(o.id))) };
    },

    /** #23 — keyset page; the driving table is orderables (code/name sorts) or tests (report_order). */
    async listTests(ctx: Ctx, query: unknown) {
      const q = checkQuery(query, ['department_id', 'workflow_type', 'is_active', 'category_id', 'sort', 'cursor', 'limit']);
      const errors: FieldError[] = [];
      if (q['department_id'] !== undefined && !isUuid(q['department_id'])) errors.push(invalid('/department_id'));
      if (q['category_id'] !== undefined && !isUuid(q['category_id'])) errors.push(invalid('/category_id'));
      workflowErr(q['workflow_type'], errors);
      const isActive = isActiveOf(q['is_active'], errors);
      if (q['sort'] !== undefined && !(typeof q['sort'] === 'string' && SORTS.has(q['sort']))) errors.push(invalid('/sort'));
      const limit = limitOf(q['limit'], 50, 200, errors);
      if (errors.length) fail(errors);
      const sort = (q['sort'] as string | undefined) ?? 'code';
      const col = sort.replace(/^-/, ''), desc = sort.startsWith('-');
      const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], sort);

      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const active = isActive === undefined ? {} : { is_active: isActive };
      const page = { order: `${col} ${desc ? 'DESC' : 'ASC'}, id ${desc ? 'DESC' : 'ASC'}`, limit: limit + 1,
        ...(after ? { after: { col, desc, value: after[0], id: after[1] } } : {}) };
      let ords: any[], tests: any[];
      const testEq = { ...(q['workflow_type'] ? { workflow_type: q['workflow_type'] } : {}), ...(q['category_id'] ? { category_id: q['category_id'] } : {}) };
      if (col === 'report_order') {
        const ids = q['department_id'] ? (await repo.find(tx, 'orderables', ['id'], t, { kind: 'test', department_id: q['department_id'] })).map((r) => r.id) : undefined;
        tests = await repo.find(tx, 'tests', TEST_COLS, t, { ...active, ...testEq }, { ...page, ...(ids ? { ids } : {}) });
        ords = await repo.find(tx, 'orderables', ORD_COLS, t, {}, { ids: tests.slice(0, limit).map((r) => r.id) });
      } else {
        // ponytail: workflow_type / category filters resolve to an id list (<= catalog size, 5k ASSUMPTION); a join/view if catalogs grow.
        const ids = Object.keys(testEq).length ? (await repo.find(tx, 'tests', ['id'], t, testEq)).map((r) => r.id) : undefined;
        ords = await repo.find(tx, 'orderables', ORD_COLS, t, { kind: 'test', ...active, ...(q['department_id'] ? { department_id: q['department_id'] } : {}) },
          { ...page, ...(ids ? { ids } : {}) });
        tests = await repo.find(tx, 'tests', TEST_COLS, t, {}, { ids: ords.slice(0, limit).map((r) => r.id) });
      }
      const extra = await testExtras(ctx, tests);
      const driving = col === 'report_order' ? tests : ords;
      const byId = new Map(ords.map((o) => [o.id, o])), wf = new Map(tests.map((r) => [r.id, r.workflow_type]));
      const data = driving.slice(0, limit).map((r) => byId.get(r.id)).filter(Boolean);
      const dept = await deptCodes(tx, t, data.map((o) => o.department_id));
      const last = driving[limit - 1];
      return {
        data: data.map((o) => summary(o, dept, wf.get(o.id), undefined, extra.get(o.id))),
        page: { limit, ...(driving.length > limit && last ? { next_cursor: encodeCursor(sort, col === 'report_order' ? Number(last[col]) : last[col], last.id) } : {}) },
      };
    },

    /** #24 */
    async createTest(ctx: Ctx, body: unknown) {
      const b = checkFields({ fields: CREATE_FIELDS }, body, ['code', 'workflow_type', 'specimen_requirements']);
      const errors: FieldError[] = [];
      let code: string | undefined;
      if (b['code'] !== undefined) { try { code = assertCode('orderable', b['code']); } catch { errors.push(invalid('/code')); } }
      for (const r of ['code', 'name', 'department_id', 'workflow_type', 'specimen_requirements']) if (b[r] === undefined) errors.push(required(`/${r}`));
      workflowErr(b['workflow_type'], errors);
      if (errors.length) fail(errors);
      const reqs = checkSpecimens(b['specimen_requirements'], 0);   // [] allowed: add-on tests on existing material (CR-C11-009)

      const tx = ctx.tx as Tx, t = ctx.tenantId, actor = ctx.actor.id, id = uuidv7();
      await checkCategory(tx, t, b['category_id']);                  // 404 for a foreign category outranks the tags rule (same answer as a made-up id, S-1)
      const tagErr = tagsRule(PARITY.some((k) => b[k] !== undefined), { is_orderable: b['is_orderable'], tags: b['tags'] });
      if (tagErr.length) fail(tagErr);
      const who = { tenant_id: t, created_by: actor, updated_by: actor };
      await repo.insert(tx, 'orderables', [{ id, ...who, kind: 'test', code, name: b['name'], department_id: b['department_id'],
        is_orderable: b['is_orderable'] ?? true, is_active: true, revision: 0, version: 1 }], ['created_at', 'updated_at']).catch(mapPg);
      await repo.insert(tx, 'tests', [{ id, ...who, kind: 'test', workflow_type: b['workflow_type'], report_order: b['report_order'] ?? 100,
        uses_existing_material: b['uses_existing_material'] ?? false, is_active: true, version: 1, ...pick(b, PARITY) }], ['created_at', 'updated_at']).catch(mapPg);
      await repo.insert(tx, 'test_specimen_types', reqs.map((s) => ({ tenant_id: t, test_id: id, ...s, created_by: actor })), ['created_at']).catch(mapPg);
      await bump(ctx, id, 'created');
      return detail(ctx, id, new Date(nowIso(ctx)));
    },

    /** #25 */
    async getTestDetail(ctx: Ctx, input: { id?: unknown; as_of?: unknown } = {}) {
      const id = checkId(input.id);
      const asOf = input.as_of === undefined ? nowIso(ctx) : input.as_of;
      if (typeof asOf !== 'string' || !ISO_UTC.test(asOf) || Number.isNaN(Date.parse(asOf))) fail([invalid('/as_of')]);
      return detail(ctx, id, new Date(asOf as string));
    },

    /** #26 — If-Match; workflow_type changes only while no analyte version is published [CONV]. */
    async updateTest(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const id = checkId(input.id);
      const expected = checkIfMatch(input.expectedVersion);
      const patch = checkFields({ fields: UPDATE_FIELDS }, input.patch, ['workflow_type', 'unset']);
      const errors: FieldError[] = [];
      workflowErr(patch['workflow_type'], errors);
      if (errors.length) fail(errors);
      const nulls = unsetOf(patch, TEST_UNSET);
      const tx = ctx.tx as Tx, t = ctx.tenantId;
      await checkCategory(tx, t, patch['category_id']);               // read only; a foreign / unknown category is 404 before any precondition (S-1)
      const before = await lockTest(ctx, id, expected);
      // LD-318 tags rule, evaluated on the RESULTING test (see tagsRule).
      const tagErr = tagsRule(PARITY.some((k) => patch[k] !== undefined) || usesParity(before), { is_orderable: patch['is_orderable'] ?? before.is_orderable, tags: patch['tags'] ?? before.tags });
      if (tagErr.length) fail(tagErr);
      if (patch['workflow_type'] !== undefined && patch['workflow_type'] !== before.workflow_type && await repo.hasPublishedVersion(tx, t, id)) {
        throw new LimsError('catalog.version_in_use');
      }
      const k = { tenantId: t, id, actorId: ctx.actor.id };
      await repo.update(tx, 'orderables', ['id'], k, pick(patch, ['name', 'department_id', 'is_orderable', 'is_active'])).catch(mapPg);
      const after = await repo.update(tx, 'tests', TEST_COLS, { ...k, expectedVersion: expected },
        { ...pick(patch, ['workflow_type', 'report_order', 'uses_existing_material', 'is_active', ...PARITY]), ...nulls }).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, before.is_active === true && after.is_active === false ? 'deactivated' : 'updated');
      return detail(ctx, id, new Date(nowIso(ctx)));
    },

    /** #27 — replace = DELETE then INSERT (moving the preferred flag never trips the partial unique index); bumps tests.version. */
    async replaceTestSpecimenRequirements(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      const id = checkId(input.id);
      const expected = checkIfMatch(input.expectedVersion);
      const b = checkQuery(isObj(input.body) ? input.body : fail([invalid('')]), ['specimen_requirements']);
      if (b['specimen_requirements'] === undefined) fail([required('/specimen_requirements')]);
      const reqs = checkSpecimens(b['specimen_requirements'], 1);
      const tx = ctx.tx as Tx, t = ctx.tenantId, actor = ctx.actor.id;
      await lockTest(ctx, id, expected);
      await repo.deleteSpecimens(tx, t, id);
      await repo.insert(tx, 'test_specimen_types', reqs.map((s) => ({ tenant_id: t, test_id: id, ...s, created_by: actor })), ['created_at']).catch(mapPg);
      const after = await repo.update(tx, 'tests', ['id'], { tenantId: t, id, actorId: actor, expectedVersion: expected }, {});
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, 'updated');
      return detail(ctx, id, new Date(nowIso(ctx)));
    },

    /** #28 — replaces the target set: ends every open row at effective_from, then inserts the new rows (history stays; the open-row unique index is not deferrable,
     *  so end first). Bumps tests.version and the catalog revision once (entity tat_target, `created`, stamping the owning test's orderable). */
    async setTestTatTargets(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      const id = checkId(input.id);
      const expected = checkIfMatch(input.expectedVersion);
      const tx = ctx.tx as Tx, t = ctx.tenantId, actor = ctx.actor.id;
      await lockTest(ctx, id, expected);               // [CONV] preconditions (404 / 409) are judged before the body (RFC 9110 §13.2.2)
      const b = checkQuery(isObj(input.body) ? input.body : fail([invalid('')]), ['targets', 'effective_from', 'stage_targets']);
      if (b['targets'] === undefined) fail([required('/targets')]);
      const targets = checkTat(b['targets']);
      const stages = b['stage_targets'] === undefined ? [] : checkStages(b['stage_targets']);
      const fromIso = b['effective_from'] === undefined ? nowIso(ctx) : b['effective_from'];
      if (typeof fromIso !== 'string' || !ISO_UTC.test(fromIso) || Number.isNaN(Date.parse(fromIso))) fail([invalid('/effective_from')]);
      const from = new Date(fromIso as string);
      // ponytail: no back-dating into recorded history (a window would overlap or be negative); a history rewrite needs its own endpoint.
      const history = await repo.find(tx, 'tat_targets', ['effective_from', 'effective_to'], t, { test_id: id });
      if (history.some((r) => (r.effective_to == null ? r.effective_from : r.effective_to) > from)) fail([invalid('/effective_from')]);
      await repo.endOpenTat(tx, t, id, actor, from);
      const rows = targets.map((x) => ({ id: uuidv7(), tenant_id: t, test_id: id, ...x, effective_from: from, created_by: actor, updated_by: actor }));
      await repo.insert(tx, 'tat_targets', rows, ['created_at', 'updated_at']).catch(mapPg);
      // T0B-TESTMGMT-1: stage targets update in place (one row per stage, id kept); stages not sent keep their value.
      if (stages.length) await repo.upsertStageTargets(tx, stages.map((s) => ({ id: uuidv7(), tenant_id: t, test_id: id, ...s, created_by: actor, updated_by: actor })));
      const after = await repo.update(tx, 'tests', ['id'], { tenantId: t, id, actorId: actor, expectedVersion: expected }, {});
      if (!after) throw new LimsError('common.version_conflict');
      await revision.bumpRevision(ctx, { entityType: 'tat_target', entityId: rows[0]!.id, changeKind: 'created', effectiveFrom: from.toISOString(), stampOrderableId: id });
      return detail(ctx, id, new Date(nowIso(ctx)));
    },
  };
}
