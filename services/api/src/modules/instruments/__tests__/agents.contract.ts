// C7 API-T04 shared contract helper (not a test file): validates a JSON value against the response schema of an operation in contracts/openapi/instruments.yaml,
// with the SAME ajv options as the core (AJV_OPTIONS, no coercion, additionalProperties:false is honoured -> any leaked field fails).
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { AJV_OPTIONS } from '../../../core/openapi.js';

export const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'instruments.yaml'));
const HTTP = ['get', 'put', 'post', 'delete', 'patch'];
export function operation(operationId: string): { path: string; method: string; op: any } {
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const m of HTTP) if (item?.[m]?.operationId === operationId) return { path, method: m, op: item[m] };
  throw new Error(`no operation ${operationId}`);
}
const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => (v: unknown) => boolean & { errors?: unknown[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, strict: false } });

/** Validate against #/components/schemas/<name>. Returns [] when valid. */
export function violations(schemaName: string, value: unknown): unknown[] {
  const v: any = compile({ schema: { components: spec.components, $ref: `#/components/schemas/${schemaName}` } as object });
  return v(value) ? [] : [...(v.errors ?? [])];
}
/** Validate against the JSON response schema of `operationId` for HTTP `status`. */
export function responseViolations(operationId: string, status: string, value: unknown): unknown[] {
  const schema = operation(operationId).op.responses?.[status]?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${operationId} has no ${status} json schema`);
  const v: any = compile({ schema: { components: spec.components, ...schema } as object });
  return v(value) ? [] : [...(v.errors ?? [])];
}
/** Every property name reachable from a schema (follows $ref once each). */
export function propertyNames(schema: any, seen = new Set<string>()): string[] {
  if (!schema || typeof schema !== 'object') return [];
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return [];
    seen.add(schema.$ref);
    const target = schema.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k], spec);
    return propertyNames(target, seen);
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries<any>(schema.properties ?? {})) out.push(k, ...propertyNames(v, seen));
  for (const k of ['items', 'additionalProperties']) out.push(...propertyNames(schema[k], seen));
  for (const k of ['allOf', 'oneOf', 'anyOf']) for (const s of schema[k] ?? []) out.push(...propertyNames(s, seen));
  return out;
}
