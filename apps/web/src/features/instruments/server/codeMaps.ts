// WEB-T04 SCR-08: C3 instrument code-map DTOs and the #93/#94/#95 body rules (contracts/openapi/catalog.yaml InstrumentCodeMap*).
// No 'server-only': the editor runs the same checks client-side before calling the action. Builders copy known keys only,
// so server-owned keys (id, version, tenant_id, is_active on rows) and prototype keys never reach C3.
import { UUID_RE } from './types';

export const CODE_MAP_MANAGE = 'catalog.instrument_code_map.manage';
export const DIRECTIONS = ['inbound', 'outbound', 'both'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const UNSETTABLE = ['unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map'] as const;
export type Unsettable = (typeof UNSETTABLE)[number];
export const BULK_MAX = 200;

export interface CodeMapFields {
  direction: Direction;
  instrument_code: string;
  analyte_id: string;
  test_id: string;
  unit_from_raw?: string;
  unit_to_code?: string;
  unit_factor?: string;
  /** JSON object text (contract: string ≤ 2000, ≤ 20 entries, key ≤ 16, value ≤ 64). */
  flag_map?: string;
}
export interface CodeMapCreate extends CodeMapFields { instrument_id: string }
export interface CodeMapPatch {
  unit_from_raw?: string;
  unit_to_code?: string;
  unit_factor?: string;
  flag_map?: string;
  unset?: Unsettable[];
  is_active?: boolean;
}
export interface InstrumentCodeMap extends CodeMapCreate { id: string; is_active: boolean; version: number }
export interface CodeMapResult { direction: Direction; instrument_code: string; outcome: 'created' | 'updated' | 'unchanged' | 'error'; error_code?: string; analyte_id?: string; map_id?: string }
export interface ObservedCode {
  instrument_id: string;
  record_class: 'patient' | 'qc' | 'calibrator';
  instrument_analyte_code: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  last_mapping_status: 'mapped' | 'unmapped';
  last_analyte_id?: string;
  last_mapping_checked_at: string;
}
export interface TestRef { id: string; code: string; name: string; analytes: { id: string; code: string; name: string }[] }
export interface UnitRef { code: string; display: string }

type Obj = Record<string, unknown>;
const str = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
/** DecimalString > 0 with ≤ 6 fraction digits. */
export const isFactor = (v: unknown) => typeof v === 'string' && /^\d{1,12}(\.\d{1,6})?$/.test(v) && /[1-9]/.test(v);

/** Parsed flag map, or undefined when the text breaks the contract limits. */
export function parseFlagMap(v: unknown): Record<string, string> | undefined {
  if (!str(v, 2, 2000)) return undefined;
  let o: unknown;
  try { o = JSON.parse(v as string); } catch { return undefined; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const e = Object.entries(o as Obj);
  return e.length <= 20 && e.every(([k, x]) => str(k, 1, 16) && str(x, 1, 64)) ? (o as Record<string, string>) : undefined;
}

/** Problems in a create/row body as JSON Pointers (empty = valid). */
export function codeMapProblems(b: Obj, withInstrument: boolean): string[] {
  const p: string[] = [];
  if (withInstrument && !isUuid(b['instrument_id'])) p.push('/instrument_id');
  if (!DIRECTIONS.includes(b['direction'] as Direction)) p.push('/direction');
  if (!str(b['instrument_code'], 1, 64)) p.push('/instrument_code');
  if (!isUuid(b['test_id'])) p.push('/test_id');
  if (!isUuid(b['analyte_id'])) p.push('/analyte_id');
  p.push(...unitProblems(b));
  if (b['flag_map'] !== undefined && !parseFlagMap(b['flag_map'])) p.push('/flag_map');
  return p;
}

const UNIT_KEYS = ['unit_from_raw', 'unit_to_code', 'unit_factor'] as const;
/** Per-key checks plus "all three or none" (missing keys of a partial trio are reported). */
function unitProblems(b: Obj): string[] {
  const p = patchProblems(pick(b, UNIT_KEYS)).filter(Boolean);
  const has = UNIT_KEYS.filter((k) => b[k] !== undefined);
  if (has.length !== 0 && has.length !== 3) p.push(...UNIT_KEYS.filter((k) => b[k] === undefined).map((k) => `/${k}`));
  return p;
}

const pick = <K extends string>(b: Obj, keys: readonly K[]) => Object.fromEntries(keys.filter((k) => Object.hasOwn(b, k) && b[k] !== undefined).map((k) => [k, b[k]]));
const ROW_KEYS = ['direction', 'instrument_code', 'analyte_id', 'test_id', 'unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map'] as const;
export const rowBody = (b: Obj) => pick(b, ROW_KEYS) as unknown as CodeMapFields;
export const createBody = (b: Obj) => ({ instrument_id: b['instrument_id'], ...pick(b, ROW_KEYS) }) as CodeMapCreate;

/** #94 patch problems (unit trio checked on the keys sent; C3 checks the merged row). */
export function patchProblems(b: Obj): string[] {
  const p: string[] = [];
  if (b['unit_from_raw'] !== undefined && !str(b['unit_from_raw'], 1, 32)) p.push('/unit_from_raw');
  if (b['unit_to_code'] !== undefined && !str(b['unit_to_code'], 1, 32)) p.push('/unit_to_code');
  if (b['unit_factor'] !== undefined && !isFactor(b['unit_factor'])) p.push('/unit_factor');
  if (b['flag_map'] !== undefined && !parseFlagMap(b['flag_map'])) p.push('/flag_map');
  if (b['is_active'] !== undefined && typeof b['is_active'] !== 'boolean') p.push('/is_active');
  if (b['unset'] !== undefined && !(Array.isArray(b['unset']) && b['unset'].length <= 4 && b['unset'].every((k) => UNSETTABLE.includes(k as Unsettable)))) p.push('/unset');
  if (!Object.keys(patchBody(b)).length) p.push('');
  return p;
}
export const patchBody = (b: Obj) => pick(b, ['unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map', 'unset', 'is_active'] as const) as CodeMapPatch;
