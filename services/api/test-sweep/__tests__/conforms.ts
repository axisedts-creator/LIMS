// T0B-SWEEP-2 test helper (tester-owned): a small JSON-schema conformance check for the OpenAPI subset in contracts/openapi
// (ajv is not a direct dependency of services/api). Unknown keywords and formats are ignored on purpose: it only fails on
// type, enum/const, required, additionalProperties:false, length/range/items bounds, pattern, uuid/date/date-time/email.
type S = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function conforms(schema: S | undefined, v: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const errs: string[] = [];
  if (v === null) return schema.nullable === true || schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')) ? [] : [`${path}: null not allowed`];
  for (const s of schema.allOf ?? []) errs.push(...conforms(s, v, path));
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[k]) && schema[k].length && !schema[k].some((s: S) => conforms(s, v, path).length === 0)) errs.push(`${path}: matches none of ${k}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) errs.push(`${path}: const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: not in enum`);
  const t = Array.isArray(schema.type) ? schema.type.filter((x: string) => x !== 'null') : schema.type ? [schema.type] : [];
  const is = (x: string) => x === 'string' ? typeof v === 'string' : x === 'integer' ? Number.isInteger(v) : x === 'number' ? typeof v === 'number'
    : x === 'boolean' ? typeof v === 'boolean' : x === 'array' ? Array.isArray(v) : x === 'object' ? typeof v === 'object' && !Array.isArray(v) : true;
  if (t.length && !t.some(is)) return [...errs, `${path}: type ${t.join('|')} expected, got ${Array.isArray(v) ? 'array' : typeof v}`];
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) errs.push(`${path}: minLength`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) errs.push(`${path}: maxLength`);
    if (typeof schema.pattern === 'string') { try { if (!new RegExp(schema.pattern, 'u').test(v)) errs.push(`${path}: pattern`); } catch { /* exotic regex: ignored */ } }
    if (schema.format === 'uuid' && !UUID.test(v)) errs.push(`${path}: uuid`);
    if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errs.push(`${path}: date`);
    if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) errs.push(`${path}: date-time`);
    if (schema.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errs.push(`${path}: email`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${path}: minimum`);
    if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${path}: maximum`);
    if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) errs.push(`${path}: exclusiveMinimum`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${path}: minItems`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${path}: maxItems`);
    v.forEach((x, i) => errs.push(...conforms(schema.items, x, `${path}[${i}]`)));
  } else if (v && typeof v === 'object') {
    const o = v as S;
    for (const r of schema.required ?? []) if (!(r in o)) errs.push(`${path}.${r}: required`);
    for (const [k, sub] of Object.entries<S>(schema.properties ?? {})) if (k in o) errs.push(...conforms(sub, o[k], `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in (schema.properties ?? {}))) errs.push(`${path}.${k}: additional`);
  }
  return errs;
}

/** Required property names of an object schema, merged through allOf. */
export function requiredOf(schema: S | undefined): string[] {
  if (!schema) return [];
  return [...(schema.required ?? []), ...(schema.allOf ?? []).flatMap((s: S) => requiredOf(s))];
}

export function hasRef(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasRef);
  if (x && typeof x === 'object') return '$ref' in (x as S) || Object.values(x as S).some(hasRef);
  return false;
}
