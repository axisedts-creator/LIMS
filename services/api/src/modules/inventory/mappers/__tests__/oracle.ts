// C12.T-04 test helper (not a test file). The oracle for every DTO is contracts/openapi/inventory.yaml (C0-owned), never the implementation:
// a mapper output may carry only keys the schema declares (explicit allowlist, 02-TRD §3.1 / §6.3) and, without inventory.cost.read,
// none of the cost keys (§6.3: every key ending `_paisa` / `_paisa_x1e6`, and `value_basis`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..');
type Node = Record<string, any>;
const doc = parse(readFileSync(join(REPO, 'contracts', 'openapi', 'inventory.yaml'), 'utf8')) as { components: { schemas: Record<string, Node> } };
export const SCHEMAS = doc.components.schemas;

export const COST_READ = 'inventory.cost.read';
export const WITHOUT_COST: readonly string[] = ['inventory.item.read'];
export const WITH_COST: readonly string[] = ['inventory.item.read', COST_READ];

export const isCostKey = (k: string): boolean => /_paisa(_x1e6)?$/.test(k) || k === 'value_basis';
/** Columns / keys that exist in the database or the spec but are never part of any response (07-SECURITY §3, TRD §6.2). */
export const NEVER_RETURNED = ['tenant_id', 'created_by', 'updated_by', 'removed_by', 'basis_key', 'source_event_id'] as const;

const UUID = '01900000-0000-7000-8000-0000000000aa';

function resolve(n: Node): Node | undefined {
  const ref = n.$ref as string | undefined;
  if (ref === undefined) return n;
  if (ref.startsWith('#/components/schemas/')) return resolve(SCHEMAS[ref.slice('#/components/schemas/'.length)]!);
  return undefined; // _common.yaml scalar (Uuid, IsoUtc, Version, ...)
}

/** A "full" sample of a schema: every declared property present (so nothing is optional), cost keys non-zero. */
export function sampleOf(n: Node, key = ''): any {
  const s = resolve(n);
  if (s === undefined) return /_at$|^occurred/.test(key) ? '2026-11-05T04:15:00.000Z' : UUID;
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: Node) => sampleOf(x, key)));
  if (s.oneOf || s.anyOf) return sampleOf((s.oneOf ?? s.anyOf)[0], key);
  if (s.enum) return s.enum[0];
  switch (s.type) {
    case 'object': {
      const o: Record<string, any> = {};
      for (const [k, v] of Object.entries<Node>(s.properties ?? {})) o[k] = sampleOf(v, k);
      if ('is_exempt' in o) { o.is_exempt = false; } // D-70: tax_code is omitted only on exempt lines; keep both present in the sample
      return o;
    }
    case 'array': return [sampleOf(s.items, key)];
    case 'integer': return isCostKey(key) ? 1234567 : 7;
    case 'number': return 7;
    case 'boolean': return true;
    default: return /_on$|^business_date/.test(key) ? '2026-11-05' : /_at$/.test(key) ? '2026-11-05T04:15:00.000Z' : 'v';
  }
}

/** Adds the DB-only / internal columns at every object level, so a mapper that spreads rows leaks them. */
export function withInternals(v: any): any {
  if (Array.isArray(v)) return v.map(withInternals);
  if (v === null || typeof v !== 'object') return v;
  const o: Record<string, any> = {};
  for (const [k, x] of Object.entries(v)) o[k] = withInternals(x);
  for (const k of NEVER_RETURNED) o[k] = 'INTERNAL-' + k;
  o.last_receipt_value_paisa = 99; o.last_receipt_qty_base = '9'; // lots: DB columns, not DTO fields
  return o;
}

/** Deep structural key shape: arrays collapse to their first element. */
export function shape(v: any): any {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v === null || typeof v !== 'object') return typeof v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
}

/** Every key path in the value (arrays transparent). */
export function keyPaths(v: any, prefix = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, prefix));
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => [`${prefix}${k}`, ...keyPaths(x, `${prefix}${k}.`)]);
}

/** Copy of v without cost keys, at every level. */
export function stripCost(v: any): any {
  if (Array.isArray(v)) return v.map(stripCost);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !isCostKey(k)).map(([k, x]) => [k, stripCost(x)]));
}

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') { Object.values(v as object).forEach(deepFreeze); Object.freeze(v); }
  return v;
}

/** Cost key paths present in a sample (to assert they exist with the permission). */
export const costPaths = (v: any): string[] => keyPaths(v).filter((p) => isCostKey(p.split('.').pop()!));
