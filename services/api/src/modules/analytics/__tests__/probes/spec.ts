// AN-T21 probe helpers (not a test file): analytics.yaml reader + schema walkers shared by the probe suite. Synthetic data only.
// P1 is "generator-driven from analytics.yaml" (07-SECURITY §5): everything below derives from the spec file, nothing is a hard-coded operation list.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { parse } from 'yaml';
import { vi } from 'vitest';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { REPO_ROOT } from '../../../../core/module.js';

// The probes import the whole handler tree (cold, slow under parallel load): a generous per-test budget, set for every file that imports this helper.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const readYaml =(f: string): any => parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', f), 'utf8'));
export const DOCS = { analytics: readYaml('analytics.yaml'), common: readYaml('_common.yaml') } as const;
type DocName = keyof typeof DOCS;

export interface Op {
  readonly id: string; readonly method: string; readonly path: string; readonly permission: string;
  readonly query: readonly string[]; readonly pathParams: readonly string[]; readonly hasBody: boolean; readonly raw: any;
}
function paramName(p: any): string | undefined {
  if (p?.$ref) return DOCS.common.components.parameters[String(p.$ref).split('/').pop()!]?.name;
  return p?.name;
}
export const OPS: readonly Op[] = Object.entries<any>(DOCS.analytics.paths).flatMap(([path, item]) =>
  Object.entries<any>(item).filter(([, o]) => o?.operationId).map(([method, o]) => ({
    id: o.operationId as string, method: method.toUpperCase(), path, permission: o['x-permission'] as string,
    query: (o.parameters ?? []).filter((p: any) => (p.$ref ? DOCS.common.components.parameters[String(p.$ref).split('/').pop()!]?.in : p.in) === 'query').map(paramName),
    pathParams: (o.parameters ?? []).filter((p: any) => p.in === 'path').map(paramName),
    hasBody: Boolean(o.requestBody), raw: o,
  })));
export const op = (id: string): Op => OPS.find((o) => o.id === id) ?? (() => { throw new Error(`no operation ${id}`); })();

/** Resolves every $ref (local + _common.yaml); no cycles in the contract. */
export function deref(node: any, doc: DocName = 'analytics'): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, doc));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const [file, ptr = ''] = node.$ref.split('#');
    const target: DocName = file ? 'common' : doc;
    return deref(ptr.split('/').slice(1).reduce((o: any, k: string) => o[k], DOCS[target]), target);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, doc)]));
}
export const requestSchema = (o: Op): any => deref(o.raw.requestBody?.content?.['application/json']?.schema);
export const responseSchema = (o: Op, status = '200'): any => deref(o.raw.responses?.[status]?.content?.['application/json']?.schema);

// ---------------------------------------------------------------- validation with the core's body options (REQ-SEC-080: no coercion, no stripping)
const compile = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => any;
const bodyCompiler = compile({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false } });
export const bodyErrors = (schema: object, body: unknown): string[] => {
  const v = bodyCompiler({ schema });
  return v(body) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.keyword}`);
};

// ---------------------------------------------------------------- key-path walkers (X3 / P13)
/** Every object schema that declares `properties`, with its path; used to find open objects (additionalProperties not false). */
export function openObjects(schema: any, at = '#'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const out: string[] = [];
  if (schema.type === 'object' && schema.properties && schema.additionalProperties !== false) out.push(at);
  for (const [k, v] of Object.entries<any>(schema.properties ?? {})) out.push(...openObjects(v, `${at}.${k}`));
  if (schema.items) out.push(...openObjects(schema.items, `${at}[]`));
  for (const key of ['allOf', 'oneOf', 'anyOf']) (schema[key] ?? []).forEach((s: any, i: number) => out.push(...openObjects(s, `${at}<${key}${i}>`)));
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.push(...openObjects(schema.additionalProperties, `${at}.*`));
  return out;
}

/** Declared key paths of a (dereferenced) schema: 'a.b', 'a[].c', '*' wildcard for additionalProperties maps. */
export function declaredPaths(schema: any, at = ''): Set<string> {
  const out = new Set<string>();
  const walk = (s: any, p: string): void => {
    if (!s || typeof s !== 'object') return;
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) { const q = p ? `${p}.${k}` : k; out.add(q); walk(v, q); }
    if (s.items) walk(s.items, `${p}[]`);
    for (const key of ['allOf', 'oneOf', 'anyOf']) for (const sub of s[key] ?? []) walk(sub, p);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') { out.add(`${p}.*`); walk(s.additionalProperties, `${p}.*`); }
  };
  walk(schema, at);
  return out;
}
export function valuePaths(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuePaths(v, `${at}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => { const q = at ? `${at}.${k}` : k; return [q, ...valuePaths(v, q)]; });
  }
  return [];
}
/** Key paths present in `body` that the response schema of `operationId` does not declare (X3: DTO key sets, no extra field). */
export function extraPaths(operationId: string, body: unknown): string[] {
  const declared = declaredPaths(responseSchema(op(operationId)));
  const wild = [...declared].filter((d) => d.endsWith('.*') || d === '*').map((d) => d.slice(0, -1));
  return [...new Set(valuePaths(body))].filter((p) => !declared.has(p) && !wild.some((w) => p.startsWith(w)));
}
export const keysDeep = (value: unknown): string[] => [...new Set(valuePaths(value).map((p) => p.split(/[.[\]]+/).filter(Boolean).at(-1)!))];
