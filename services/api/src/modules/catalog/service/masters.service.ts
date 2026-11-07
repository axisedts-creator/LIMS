// Masters #5–#16 (02-TRD §5 "Masters", §5.0; PRD AC-01.1–01.6; 07-SECURITY S-1, S-5, AB-20).
// Validates its own input (import commits call it directly, not through the HTTP pipeline); every write bumps the catalog revision
// and publishes catalog.changed.v1 in the caller's transaction (T-03). Lock order on writes: masters row, then catalog_state.
// [CONV] uuidv7 via relative import until @lims/shared-ts is a services/api dependency (same as revision.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor, toDto } from '../mappers/masters.mapper.js';
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
/** Declared fields only (S-5); undefined values are treated as absent. */
export function checkFields(def: { fields: Record<string, Field> }, input: unknown, extra: readonly string[]): Record<string, unknown> {
  if (!isObj(input)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (v === undefined) continue;
    if (extra.includes(k)) { out[k] = v; continue; }
    const f = Object.hasOwn(def.fields, k) ? def.fields[k] : undefined;
    if (!f) errors.push(unknown(`/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`));
    else if (!okValue(f, v)) errors.push(invalid(`/${k}`));
    else out[k] = v;
  }
  if (errors.length) fail(errors);
  return out;
}

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Ctx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly requestId: string; readonly tx: unknown; readonly now?: () => string }
interface Deps { events: { publish(ctx: unknown, type: string, input: object): Promise<unknown> } }

const pgCode = (e: unknown): string | undefined => (typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined);
/** 23505 on these tables = UNIQUE(tenant_id, code); 23503 = default_specimen_type_id not in this tenant (S-1). */
export function mapPg(e: unknown): never {
  const c = pgCode(e);
  if (c === '23505') throw new LimsError('catalog.code_duplicate');
  if (c === '23503') throw new LimsError('common.not_found');
  throw e;
}

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
      if (typeof input.id !== 'string' || !UUID.test(input.id)) fail([invalid('/id')]);
      if (input.expectedVersion === undefined) throw new LimsError('common.precondition_required');
      const ev = input.expectedVersion;
      if (!Number.isInteger(ev) || (ev as number) < 1 || (ev as number) > 2147483647) fail([invalid('/if-match')]);
      const patch = checkFields(def, input.patch, []);
      const tx = ctx.tx as Tx;
      const id = input.id as string;
      const before = await repo.lockRow(tx, def.table, cols, ctx.tenantId, id);
      if (!before) throw new LimsError('common.not_found');
      if (Number(before.version) !== ev) throw new LimsError('common.version_conflict');
      const after = await repo.updateRow(tx, def.table, cols, { tenantId: ctx.tenantId, id, expectedVersion: ev as number, actorId: ctx.actor.id }, patch).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, before.is_active === true && after.is_active === false ? 'deactivated' : 'updated');
      return dto(after);
    };
  }
  return svc;
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
