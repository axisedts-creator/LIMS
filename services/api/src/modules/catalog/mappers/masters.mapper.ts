// Row -> contract DTO (catalog.yaml Department/SpecimenType/Container/Method) and the opaque list cursor (02-CV §4.3/§4.4).
// Internal columns (tenant_id, created_by, updated_by) never leave; NULL optionals are omitted (the schemas are not nullable).
import { LimsError } from '../../../core/errors.js';

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

export function toDto(row: Record<string, any>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id, code: row.code, version: Number(row.version), is_active: row.is_active === true,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
  for (const f of fields) if (f !== 'is_active' && row[f] != null) out[f] = row[f];
  return out;
}

// Unit / ValueSet / ValueSetValue (catalog.yaml). Global rows carry no id/version (02-TRD: "id (tenant rows)").
type R = Record<string, any>;
const valueDto = (v: R) => ({ code: v.code, display: v.display, sort_order: Number(v.sort_order), is_active: v.is_active === true });
export const globalUnitDto = (r: R) => ({ code: r.code as string, display: r.display, scope: 'global', is_active: r.is_active === true });
export const unitDto = (r: R) => ({ id: r.id, ...globalUnitDto(r), scope: 'tenant', version: Number(r.version) });
export const globalSetDto = (r: R, values: R[]) => ({
  code: r.code as string, display: r.display, is_ordered: r.is_ordered === true, scope: 'global', is_active: r.is_active === true, values: values.map(valueDto),
});
export const setDto = (r: R, values: R[]) => ({ id: r.id, ...globalSetDto(r, values), scope: 'tenant', version: Number(r.version) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url(JSON [sort, last sort value, last id]). */
export const encodeCursor = (sort: string, value: unknown, id: string): string =>
  Buffer.from(JSON.stringify([sort, value, id]), 'utf8').toString('base64url');

export function decodeCursor(raw: unknown, sort: string): readonly [unknown, string] {
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== sort || typeof v[2] !== 'string' || !UUID.test(v[2])) throw bad();
  const ok = sort.replace('-', '') === 'report_order' ? Number.isInteger(v[1]) : typeof v[1] === 'string';
  if (!ok) throw bad();
  return [v[1], v[2]];
}
