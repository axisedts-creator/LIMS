// Masters #5–#16 (02-TRD §5 "Masters", §5.0; PRD AC-01.1–01.6) and units / value sets #17–#22 (T-05; AC-02.6); 07-SECURITY S-1, S-5, AB-20.
// Validates its own input (import commits call it directly, not through the HTTP pipeline); every write bumps the catalog revision
// and publishes catalog.changed.v1 in the caller's transaction (T-03). Lock order on writes: masters row, then catalog_state.
// [CONV] uuidv7 via relative import until @lims/shared-ts is a services/api dependency (same as revision.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor, globalSetDto, globalUnitDto, setDto, toDto, unitDto } from '../mappers/masters.mapper.js';
import * as repo from '../repo/masters.repo.js';
import { createRevisionService } from './revision.service.js';

export type Field = { t: 'str'; min: number; max: number } | { t: 'int'; min: number; max: number } | { t: 'bool' } | { t: 'uuid' };
interface Def { R: string; table: repo.MasterTable; entity: string; fields: Record<string, Field>; required: readonly string[]; sorts: readonly string[] }

export const str = (min: number, max: number): Field => ({ t: 'str', min, max });
export const BOOL: Field = { t: 'bool' };
const SORTS = ['code', 'name'];   // [CR-pending] .orchestra/cr/T-04.md: catalog.yaml also lists report_order for specimen types/containers/methods (no such column) -> 400 until ruled
const DEFS: readonly Def[] = [
  { R: 'Department', table: 'departments', entity: 'department', required: ['name', 'report_order'], sorts: [...SORTS, 'report_order'],
    fields: { name: str(1, 100), is_active: BOOL, report_order: { t: 'int', min: 0, max: 9999 }, report_heading: str(0, 100) } },
  { R: 'SpecimenType', table: 'specimen_types', entity: 'specimen_type', required: ['name', 'report_label'], sorts: SORTS,
    fields: { name: str(1, 100), is_active: BOOL, report_label: str(1, 100) } },
  { R: 'Container', table: 'containers', entity: 'container', required: ['name'], sorts: SORTS,
    fields: { name: str(1, 100), is_active: BOOL, additive: str(0, 60), cap_colour_display: str(0, 40), default_specimen_type_id: { t: 'uuid' } } },
  { R: 'Method', table: 'methods', entity: 'method', required: ['name'], sorts: SORTS,
    fields: { name: str(1, 120), is_active: BOOL } },
];

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_IN = /^[A-Za-z0-9][A-Za-z0-9_]{0,31}$/;     // checked BEFORE upper-casing: no Unicode case-fold forgeries (ı -> I)
const BASE_COLS = ['id', 'code', 'version', 'is_active', 'created_at', 'updated_at'];

// Fixed messages only: never a submitted value (AB-20).
export const invalid = (path: string): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' });
export const required = (path: string): FieldError => ({ path, code: 'common.field_required', message: 'Field required' });
export const unknown = (path: string): FieldError => ({ path, code: 'common.unknown_field', message: 'Unknown field' });
export const fail = (errors: FieldError[]): never => { throw new LimsError('common.validation_failed', undefined, errors); };
export const isObj =(v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function okValue(f: Field, v: unknown): boolean {
  switch (f.t) {
    case 'str': return typeof v === 'string' && v.length >= f.min && v.length <= f.max;
    case 'int': return Number.isInteger(v) && (v as number) >= f.min && (v as number) <= f.max;
    case 'bool': return typeof v === 'boolean';
    case 'uuid': return typeof v === 'string' && UUID.test(v);
  }
}
export const ptr = (k: string) => `/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`;
/** Declared fields only (S-5); undefined values are treated as absent. */
export function checkFields(def: Pick<Def, 'fields'>, input: unknown, extra: readonly string[], prefix = ''): Record<string, unknown> {
  if (!isObj(input)) return fail([invalid(prefix)]);
  const errors: FieldError[] = [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (v === undefined) continue;
    if (extra.includes(k)) { out[k] = v; continue; }
    const f = Object.hasOwn(def.fields, k) ? def.fields[k] : undefined;
    if (!f) errors.push(unknown(prefix + ptr(k)));
    else if (!okValue(f, v)) errors.push(invalid(`${prefix}/${k}`));
    else out[k] = v;
  }
  if (errors.length) fail(errors);
  return out;
}

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface Ctx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly requestId: string; readonly tx: unknown; readonly now?: () => string }
export interface Deps { events: { publish(ctx: unknown, type: string, input: object): Promise<unknown> } }

const pgCode = (e: unknown): string | undefined => (typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined);
/** 23505 on these tables = UNIQUE(tenant_id, code); 23503 = default_specimen_type_id not in this tenant (S-1). */
export function mapPg(e: unknown): never {
  const c = pgCode(e);
  if (c === '23505') throw new LimsError('catalog.code_duplicate');
  if (c === '23503') throw new LimsError('common.not_found');
  throw e;
}

/** PATCH preconditions (02-TRD §5.0): id, If-Match present (428) and well-formed (400). */
export function checkUpdate(input: { id?: unknown; expectedVersion?: unknown }): { id: string; ev: number } {
  if (typeof input.id !== 'string' || !UUID.test(input.id)) fail([invalid('/id')]);
  if (input.expectedVersion === undefined) throw new LimsError('common.precondition_required');
  const ev = input.expectedVersion;
  if (!Number.isInteger(ev) || (ev as number) < 1 || (ev as number) > 2147483647) fail([invalid('/if-match')]);
  return { id: input.id as string, ev: ev as number };
}
export async function lockAt(ctx: Ctx, table: repo.MasterTable, cols: readonly string[], id: string, ev: number): Promise<any> {
  const before = await repo.lockRow(ctx.tx as Tx, table, cols, ctx.tenantId, id);
  if (!before) throw new LimsError('common.not_found');
  if (Number(before.version) !== ev) throw new LimsError('common.version_conflict');
  return before;
}
export const kindOf = (before: any, after: any) => (before.is_active === true && after.is_active === false ? 'deactivated' : 'updated');

export function createMastersService(deps: Deps) {
  const revision = createRevisionService(deps);
  const svc: Record<string, (ctx: Ctx, input?: any) => Promise<any>> = {};

  for (const def of DEFS) {
    const fieldNames = Object.keys(def.fields);
    const cols = [...BASE_COLS, ...fieldNames.filter((f) => f !== 'is_active')];
    const dto = (row: Record<string, any>) => toDto(row, fieldNames);
    const bump = (ctx: Ctx, id: string, changeKind: string) => revision.bumpRevision(ctx, {
      entityType: def.entity, entityId: id, changeKind, effectiveFrom: ctx.now?.() ?? new Date().toISOString(),
    });

    svc[`list${def.R}s`] = async (ctx, query) => {
      const q = checkFieldsQuery(query);
      const sort = q.sort ?? 'code';
      if (!def.sorts.includes(sort.replace(/^-/, ''))) fail([invalid('/sort')]);
      const limit = q.limit ?? 50;
      const isActive = q.is_active === 'all' ? undefined : q.is_active === 'false' ? false : q.is_active === 'true' || q.id === undefined ? true : undefined;
      const sortCol = sort.replace(/^-/, '');
      const rows = await repo.listRows(ctx.tx as Tx, def.table, cols, {
        tenantId: ctx.tenantId, ...(q.id === undefined ? {} : { id: q.id }), ...(isActive === undefined ? {} : { isActive }),
        sortCol, desc: sort.startsWith('-'), ...(q.cursor === undefined ? {} : { after: decodeCursor(q.cursor, sort) }), limit: limit + 1,
      });
      const data = rows.slice(0, limit);
      const last = data[data.length - 1];
      const page: { limit: number; next_cursor?: string } = { limit };
      if (rows.length > limit && last) page.next_cursor = encodeCursor(sort, last[sortCol], last.id);
      return { data: data.map(dto), page };
    };

    svc[`create${def.R}`] = async (ctx, body) => {
      const b = checkFields(def, body, ['code']);
      const errors: FieldError[] = [];
      const code = typeof b['code'] === 'string' ? b['code'].trim() : undefined;
      if (b['code'] === undefined) errors.push(required('/code'));
      else if (code === undefined || !CODE_IN.test(code)) errors.push(invalid('/code'));
      for (const r of def.required) if (b[r] === undefined) errors.push(required(`/${r}`));
      if (errors.length) fail(errors);
      const row = { ...b, id: uuidv7(), tenant_id: ctx.tenantId, code: code!.toUpperCase(), is_active: b['is_active'] ?? true, created_by: ctx.actor.id, updated_by: ctx.actor.id };
      const created = await repo.insertRow(ctx.tx as Tx, def.table, cols, row).catch(mapPg);
      await bump(ctx, created.id, 'created');
      return dto(created);
    };

    svc[`update${def.R}`] = async (ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) => {
      const { id, ev } = checkUpdate(input);
      const patch = checkFields(def, input.patch, []);
      const before = await lockAt(ctx, def.table, cols, id, ev);
      const after = await repo.updateRow(ctx.tx as Tx, def.table, cols, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, patch).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, kindOf(before, after));
      return dto(after);
    };
  }
  Object.assign(svc, setsService(revision));
  return svc;
}

// ------------------------------------------------------------------------------------------------ units + value sets (#17–#22, T-05)
// Lists are global ∪ tenant: two SELECTs merged here; a tenant row shadows the global one with its code, even when inactive.
// Global rows are never written: PATCH looks only at cs_* (a g_* id -> 404); a tenant code equal to a global code (active or not) -> 409
// (05-SCHEMA: service rule). In use = a `published` analyte version of this tenant has value_set_code = the set's code; then an existing
// value's sort_order is frozen (02-TRD #22). Removal never happens: codes omitted from a PATCH are left as they are.
const UNIT_CODE = /^[A-Za-z0-9_]{1,32}$/;        // kept as sent: unit codes are case-sensitive (the global ones are lower-case)
const VALUE_CODE = /^[A-Za-z0-9_+-]{1,16}$/;     // [CONV] upper-cased like set/master codes; checked before upper-casing
const SCOPES = ['global', 'tenant'] as const;
const UNIT_COLS = ['id', 'code', 'display', 'is_active', 'version'];
const SET_COLS = ['id', 'code', 'display', 'is_ordered', 'is_active', 'version'];
const VAL_COLS = ['id', 'value_set_id', 'code', 'display', 'sort_order', 'is_active', 'version'];
const G_VAL_COLS = ['value_set_code', 'code', 'display', 'sort_order', 'is_active'];
const VAL_ORDER = 'sort_order, code';
const MAX_VALUES = 50;
const UNIT_CREATE = { fields: { display: str(1, 32) } };
const UNIT_UPDATE = { fields: { display: str(1, 32), is_active: BOOL } };
const SET_CREATE = { fields: { display: str(1, 80), is_ordered: BOOL } };
const SET_UPDATE = { fields: { display: str(1, 80), is_active: BOOL } };
const VALUE_IN = { fields: { display: str(1, 40), sort_order: { t: 'int', min: 0, max: 9999 } as Field, is_active: BOOL } };
type ValueIn = { code: string; display?: string; sort_order?: number; is_active?: boolean };
type UpdateInput = { id?: unknown; expectedVersion?: unknown; patch?: unknown };

function checkEnumQuery(query: unknown, allowed: Record<string, readonly string[]>): Record<string, string> {
  const q = query === undefined ? {} : query;
  if (!isObj(q)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    const ok = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
    if (!ok) errors.push(unknown(ptr(k)));
    else if (typeof v === 'string' && ok.includes(v)) out[k] = v;
    else errors.push(invalid(ptr(k)));
  }
  if (errors.length) fail(errors);
  return out;
}

/** ValueSetValueInput[] (≤50; codes distinct after upper-casing). */
function checkValues(v: unknown): ValueIn[] {
  if (!Array.isArray(v) || v.length > MAX_VALUES) return fail([invalid('/values')]);
  const seen = new Set<string>();
  return v.map((item, i) => {
    const p = `/values/${i}`;
    const o = checkFields(VALUE_IN, item, ['code'], p);
    if (o['code'] === undefined) fail([required(`${p}/code`)]);
    if (typeof o['code'] !== 'string' || !VALUE_CODE.test(o['code'])) fail([invalid(`${p}/code`)]);
    const code = (o['code'] as string).toUpperCase();
    if (seen.has(code)) fail([invalid(`${p}/code`)]);
    seen.add(code);
    return { ...o, code } as ValueIn;
  });
}

/** [CONV] missing sort_order -> after the highest known one, step 10 (distinct); missing display -> the code; is_active defaults true. */
function withDefaults(vals: readonly ValueIn[], known: readonly number[]): Array<Required<ValueIn>> {
  let next = Math.max(0, ...known, ...vals.map((v) => v.sort_order ?? 0));
  return vals.map((v) => ({
    code: v.code, display: v.display ?? v.code, is_active: v.is_active ?? true,
    sort_order: v.sort_order ?? (next = Math.min(next + 10, 9999)),   // ponytail: clamps at 9999 (may then tie); fine below ~1000 steps
  }));
}

function setsService(revision: ReturnType<typeof createRevisionService>) {
  const bump = (ctx: Ctx, entityType: string, id: string, changeKind: string) => revision.bumpRevision(ctx, {
    entityType, entityId: id, changeKind, effectiveFrom: ctx.now?.() ?? new Date().toISOString(),
  });
  const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const globalCodeTaken = async (ctx: Ctx, table: 'g_units' | 'g_value_sets', code: string) =>
    (await repo.selectRows(ctx.tx as Tx, table, ['id'], { code }, 'id', 1)).length > 0;
  const audit = (ctx: Ctx) => ({ tenant_id: ctx.tenantId, created_by: ctx.actor.id, updated_by: ctx.actor.id });
  const insertValues = async (ctx: Ctx, setId: string, vals: ReadonlyArray<Required<ValueIn>>) => {
    for (const v of vals) await repo.insertRow(ctx.tx as Tx, 'cs_value_set_values', VAL_COLS, { id: uuidv7(), value_set_id: setId, ...v, ...audit(ctx) });
  };
  const valuesOf = (ctx: Ctx, setId: string) =>
    repo.selectRows(ctx.tx as Tx, 'cs_value_set_values', VAL_COLS, { tenant_id: ctx.tenantId, value_set_id: setId }, VAL_ORDER);

  return {
    async listUnits(ctx: Ctx, query?: unknown) {
      const q = checkEnumQuery(query, { scope: SCOPES, is_active: ['true', 'false', 'all'] });
      const ia = q['is_active'] ?? 'true';
      const tx = ctx.tx as Tx;
      const g = q['scope'] === 'tenant' ? [] : await repo.selectRows(tx, 'g_units', ['code', 'display', 'is_active'], {}, 'code');
      const t = q['scope'] === 'global' ? [] : await repo.selectRows(tx, 'cs_units', UNIT_COLS, { tenant_id: ctx.tenantId }, 'code');
      const shadowed = new Set(t.map((r) => r.code));
      const data = [...g.filter((r) => !shadowed.has(r.code)).map(globalUnitDto), ...t.map(unitDto)];
      return { data: data.filter((u) => ia === 'all' || u.is_active === (ia === 'true')).sort(byCode) };
    },

    async createUnit(ctx: Ctx, body?: unknown) {
      const b = checkFields(UNIT_CREATE, body, ['code']);
      const errors: FieldError[] = [];
      if (b['code'] === undefined) errors.push(required('/code'));
      else if (typeof b['code'] !== 'string' || !UNIT_CODE.test(b['code'])) errors.push(invalid('/code'));
      if (b['display'] === undefined) errors.push(required('/display'));
      if (errors.length) fail(errors);
      const code = b['code'] as string;
      if (await globalCodeTaken(ctx, 'g_units', code)) throw new LimsError('catalog.code_duplicate');
      const created = await repo.insertRow(ctx.tx as Tx, 'cs_units', UNIT_COLS, { id: uuidv7(), code, display: b['display'], is_active: true, ...audit(ctx) }).catch(mapPg);
      await bump(ctx, 'unit', created.id, 'created');
      return unitDto(created);
    },

    async updateUnit(ctx: Ctx, input: UpdateInput = {}) {
      const { id, ev } = checkUpdate(input);
      const patch = checkFields(UNIT_UPDATE, input.patch, []);
      const before = await lockAt(ctx, 'cs_units', UNIT_COLS, id, ev);
      const after = await repo.updateRow(ctx.tx as Tx, 'cs_units', UNIT_COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, patch);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, 'unit', id, kindOf(before, after));
      return unitDto(after);
    },

    async listValueSets(ctx: Ctx, query?: unknown) {
      const q = checkEnumQuery(query, { scope: SCOPES });
      const tx = ctx.tx as Tx;
      const t = q['scope'] === 'global' ? [] : await repo.selectRows(tx, 'cs_value_sets', SET_COLS, { tenant_id: ctx.tenantId }, 'code');
      const shadowed = new Set(t.map((r) => r.code));
      const g = (q['scope'] === 'tenant' ? [] : await repo.selectRows(tx, 'g_value_sets', ['code', 'display', 'is_ordered', 'is_active'], {}, 'code'))
        .filter((r) => !shadowed.has(r.code));
      const gv = g.length ? await repo.selectRows(tx, 'g_value_set_values', G_VAL_COLS, { value_set_code: g.map((r) => r.code) }, VAL_ORDER) : [];
      const tv = t.length ? await repo.selectRows(tx, 'cs_value_set_values', VAL_COLS, { tenant_id: ctx.tenantId, value_set_id: t.map((r) => r.id) }, VAL_ORDER) : [];
      const data = [
        ...g.map((s) => globalSetDto(s, gv.filter((v) => v.value_set_code === s.code))),
        ...t.map((s) => setDto(s, tv.filter((v) => v.value_set_id === s.id))),
      ];
      return { data: data.sort(byCode) };
    },

    async createValueSet(ctx: Ctx, body?: unknown) {
      const b = checkFields(SET_CREATE, body, ['code', 'values']);
      const errors: FieldError[] = [];
      const code = typeof b['code'] === 'string' ? b['code'].trim() : undefined;
      if (b['code'] === undefined) errors.push(required('/code'));
      else if (code === undefined || !CODE_IN.test(code)) errors.push(invalid('/code'));
      for (const r of ['display', 'is_ordered', 'values']) if (b[r] === undefined) errors.push(required(`/${r}`));
      if (errors.length) fail(errors);
      const vals = withDefaults(checkValues(b['values']), []);
      const setCode = code!.toUpperCase();
      if (await globalCodeTaken(ctx, 'g_value_sets', setCode)) throw new LimsError('catalog.code_duplicate');
      const set = await repo.insertRow(ctx.tx as Tx, 'cs_value_sets', SET_COLS, {
        id: uuidv7(), code: setCode, display: b['display'], is_ordered: b['is_ordered'], is_active: true, ...audit(ctx),
      }).catch(mapPg);
      await insertValues(ctx, set.id, vals);
      await bump(ctx, 'value_set', set.id, 'created');
      return setDto(set, await valuesOf(ctx, set.id));
    },

    async updateValueSet(ctx: Ctx, input: UpdateInput = {}) {
      const { id, ev } = checkUpdate(input);
      const { values, ...setPatch } = checkFields(SET_UPDATE, input.patch, ['values']);
      const vals = values === undefined ? [] : checkValues(values);
      const tx = ctx.tx as Tx;
      const before = await lockAt(ctx, 'cs_value_sets', SET_COLS, id, ev);     // lock order: set row, its values, catalog_state
      const existing = await valuesOf(ctx, id);
      const cur = new Map(existing.map((r) => [r.code as string, r]));
      const changes: Array<[any, Record<string, unknown>]> = [];
      const added: ValueIn[] = [];
      for (const v of vals) {
        const row = cur.get(v.code);
        if (!row) { added.push(v); continue; }
        const p: Record<string, unknown> = {};
        for (const k of ['display', 'sort_order', 'is_active'] as const) if (v[k] !== undefined && v[k] !== row[k]) p[k] = v[k];
        if (Object.keys(p).length) changes.push([row, p]);
      }
      if (existing.length + added.length > MAX_VALUES) fail([invalid('/values')]);
      if (changes.some(([, p]) => 'sort_order' in p)) {
        const inUse = await repo.selectRows(tx, 'analyte_versions', ['id'], { tenant_id: ctx.tenantId, value_set_code: before.code, status: 'published' }, 'id', 1);
        if (inUse.length) throw new LimsError('catalog.version_in_use');
      }
      for (const [row, p] of changes) {
        const ok = await repo.updateRow(tx, 'cs_value_set_values', VAL_COLS, { tenantId: ctx.tenantId, id: row.id, expectedVersion: Number(row.version), actorId: ctx.actor.id }, p);
        if (!ok) throw new LimsError('common.version_conflict');
      }
      const known = existing.map((r) => Number(changes.find(([x]) => x === r)?.[1]['sort_order'] ?? r.sort_order));
      await insertValues(ctx, id, withDefaults(added, known));
      const after = await repo.updateRow(tx, 'cs_value_sets', SET_COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, setPatch);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, 'value_set', id, kindOf(before, after));
      return setDto(after, await valuesOf(ctx, id));
    },
  };
}

interface ListQuery { id?: string; is_active?: 'true' | 'false' | 'all'; sort?: string; cursor?: string; limit?: number }
const SORT_RE = /^-?(code|name|report_order)$/;
function checkFieldsQuery(query: unknown): ListQuery {
  const q = query === undefined ? {} : query;
  if (!isObj(q)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: ListQuery = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (k === 'id') { if (typeof v === 'string' && UUID.test(v)) out.id = v; else errors.push(invalid('/id')); }
    else if (k === 'is_active') { if (v === 'true' || v === 'false' || v === 'all') out.is_active = v; else errors.push(invalid('/is_active')); }
    else if (k === 'sort') { if (typeof v === 'string' && SORT_RE.test(v)) out.sort = v; else errors.push(invalid('/sort')); }
    else if (k === 'cursor') { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v)) throw new LimsError('common.invalid_cursor'); out.cursor = v; }
    else if (k === 'limit') {
      const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v;
      if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 200) out.limit = n as number; else errors.push(invalid('/limit'));
    } else errors.push(unknown(`/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  if (errors.length) fail(errors);
  return out;
}
