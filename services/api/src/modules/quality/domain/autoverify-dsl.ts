// Auto-verify rule-set DSL validation (02-TRD §8.2 RuleSetDefinition; contracts/openapi/quality.yaml AutoverifyRule / RuleSetDefinition). Pure: never throws, returns EVERY error.
// Pointers are RFC 6901, relative to the definition root ('' = the root). Messages carry no submitted value: only {path, code} leave this module.
// Pinned pointers (AC-10.2): duplicate key -> /rules/<later>/key; duplicate (analyte, instrument ?? '*') -> /rules/<later>/analyte_id; low > high -> /rules/<i>/limits.

export type DslErrorCode = 'common.unknown_field' | 'common.field_required' | 'common.field_invalid';
export interface DslError { readonly path: string; readonly code: DslErrorCode }
export interface CatalogTest { readonly analytes: ReadonlyArray<{ readonly id: string; readonly resultType: string }> }

export const MAX_RULES = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;                       // _common.yaml DecimalString, maxLength 40
const FLAGS: ReadonlySet<string> = new Set(['N', 'L', 'H']);   // LL / HH / A are never allowed (TRD §8.2)
const RULE_FIELDS = ['key', 'test_id', 'analyte_id', 'instrument_id', 'enabled', 'limits', 'allowed_range_flags', 'instrument_flags_allowed', 'qc_allow_warning', 'note'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);   // own keys only: no inherited constructor/__proto__
const get = (o: Obj, k: string): unknown => (has(o, k) ? o[k] : undefined);
const seg = (s: string): string => s.replaceAll('~', '~0').replaceAll('/', '~1');
const chars = (s: string): number => [...s].length;

/** Decimal strings compared exactly (no float): scale both to the same number of fraction digits, compare as BigInt. */
function cmpDecimal(a: string, b: string): number {
  const parse = (s: string) => {
    const m = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(s)!;
    return { neg: m[1] === '-', int: m[2]!, frac: m[3] ?? '' };
  };
  const x = parse(a), y = parse(b), scale = Math.max(x.frac.length, y.frac.length);
  const big = (p: ReturnType<typeof parse>) => { const n = BigInt(p.int + p.frac.padEnd(scale, '0')); return p.neg ? -n : n; };
  const bx = big(x), by = big(y);
  return bx < by ? -1 : bx > by ? 1 : 0;
}

export function validateRuleSetDefinition(def: unknown, catalog?: ReadonlyMap<string, CatalogTest | undefined>): DslError[] {
  const errs: DslError[] = [];
  const add = (path: string, code: DslErrorCode = 'common.field_invalid') => { errs.push({ path, code }); };
  try {
    if (!isObj(def)) { add(''); return errs; }
    for (const k of Object.keys(def)) if (k !== 'schema_version' && k !== 'rules') add(`/${seg(k)}`, 'common.unknown_field');

    const sv = get(def, 'schema_version');
    if (sv === undefined) add('/schema_version', 'common.field_required'); else if (sv !== 1) add('/schema_version');

    const rules = get(def, 'rules');
    if (rules === undefined) { add('/rules', 'common.field_required'); return errs; }
    if (!Array.isArray(rules)) { add('/rules'); return errs; }
    if (rules.length > MAX_RULES) { add('/rules'); return errs; }   // bounded work: the cap is the answer

    const keys = new Set<string>(), pairs = new Set<string>();
    rules.forEach((r: unknown, i: number) => {
      const at = `/rules/${i}`;
      if (!isObj(r)) { add(at); return; }
      for (const k of Object.keys(r)) if (!(RULE_FIELDS as readonly string[]).includes(k)) add(`${at}/${seg(k)}`, 'common.unknown_field');

      const key = get(r, 'key');
      if (key === undefined) add(`${at}/key`, 'common.field_required');
      else if (typeof key !== 'string' || !KEY.test(key)) add(`${at}/key`);
      else if (keys.has(key)) add(`${at}/key`); else keys.add(key);

      const uuid = (k: string, required: boolean): string | undefined => {
        const v = get(r, k);
        if (v === undefined) { if (required) add(`${at}/${k}`, 'common.field_required'); return undefined; }
        if (typeof v !== 'string' || !UUID.test(v)) { add(`${at}/${k}`); return undefined; }
        return v.toLowerCase();
      };
      const testId = uuid('test_id', true), analyteId = uuid('analyte_id', true), instrumentId = uuid('instrument_id', false);

      const enabled = get(r, 'enabled');
      if (enabled === undefined) add(`${at}/enabled`, 'common.field_required'); else if (typeof enabled !== 'boolean') add(`${at}/enabled`);

      if (analyteId !== undefined) {
        const pair = `${analyteId}|${instrumentId ?? '*'}`;
        if (pairs.has(pair)) add(`${at}/analyte_id`); else pairs.add(pair);
      }

      const limits = get(r, 'limits');
      if (limits !== undefined) {
        if (!isObj(limits)) add(`${at}/limits`);
        else {
          const lk = Object.keys(limits);
          for (const k of lk) if (k !== 'low' && k !== 'high') add(`${at}/limits/${seg(k)}`, 'common.unknown_field');
          if (lk.length === 0) add(`${at}/limits`);
          const bound = (k: 'low' | 'high'): string | undefined => {
            const v = get(limits, k);
            if (v === undefined) return undefined;
            if (typeof v !== 'string' || v.length > 40 || !DECIMAL.test(v)) { add(`${at}/limits/${k}`); return undefined; }
            return v;
          };
          const low = bound('low'), high = bound('high');
          if (low !== undefined && high !== undefined && cmpDecimal(low, high) > 0) add(`${at}/limits`);
        }
      }

      const flags = get(r, 'allowed_range_flags');
      if (flags !== undefined) {
        if (!Array.isArray(flags) || flags.length < 1 || flags.length > 3) add(`${at}/allowed_range_flags`);
        else {
          const seen = new Set<string>();
          let dup = false;
          flags.forEach((f: unknown, j: number) => {
            if (typeof f !== 'string' || !FLAGS.has(f)) { add(`${at}/allowed_range_flags/${j}`); return; }
            if (seen.has(f)) dup = true; else seen.add(f);
          });
          if (dup) add(`${at}/allowed_range_flags`);
        }
      }

      const iflags = get(r, 'instrument_flags_allowed');
      if (iflags !== undefined) {
        if (!Array.isArray(iflags) || iflags.length > 20) add(`${at}/instrument_flags_allowed`);
        else iflags.forEach((f: unknown, j: number) => { if (typeof f !== 'string' || chars(f) < 1 || chars(f) > 16) add(`${at}/instrument_flags_allowed/${j}`); });
      }

      const qc = get(r, 'qc_allow_warning');
      if (qc !== undefined && typeof qc !== 'boolean') add(`${at}/qc_allow_warning`);
      const note = get(r, 'note');
      if (note !== undefined && (typeof note !== 'string' || chars(note) > 200)) add(`${at}/note`);

      // Catalog (CatalogPort.getTest): the analyte must belong to the test and be numeric. Only with a catalog; a rule whose ids are already malformed is not checked.
      if (catalog && testId !== undefined) {
        const t = catalog.get(testId);
        if (!t) add(`${at}/test_id`);
        else if (analyteId !== undefined) {
          const a = t.analytes.find((x) => String(x.id).toLowerCase() === analyteId);
          if (!a || a.resultType !== 'numeric') add(`${at}/analyte_id`);
        }
      }
    });
  } catch {
    // Defence in depth: a hostile shape must never crash the request; it is simply invalid.
    if (!errs.length) add('');
  }
  return errs;
}

/** Distinct, well-formed test ids a catalog lookup is needed for (lower-cased like the validator's lookups). */
export function referencedTestIds(def: unknown): string[] {
  const rules = isObj(def) ? get(def, 'rules') : undefined;
  if (!Array.isArray(rules)) return [];
  const ids = new Set<string>();
  for (const r of rules.slice(0, MAX_RULES)) {
    const t = isObj(r) ? get(r, 'test_id') : undefined;
    if (typeof t === 'string' && UUID.test(t)) ids.add(t.toLowerCase());
  }
  return [...ids];
}
