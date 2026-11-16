// T0A-HEADERS-1 (LD-277, LD-278): contract-wide check, offline, no database.
// For every operation in contracts/openapi/*.yaml with a required header parameter, the header schema is compiled through
// the real core validator factory (schemaController) and a header object built the way Node delivers it (lower-case names,
// valid sample values) must pass; dropping any one required header must be refused.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../module.js';
import { schemaController } from '../openapi.js';

const DIR = join(REPO_ROOT, 'contracts', 'openapi');
const build = (schemaController.compilersFactory as any).buildValidator as (ext: object) => (c: { schema: object; httpPart?: string }) => (d: unknown) => any;
const factory = build({});
const compileHeaders = (schema: object) => factory({ schema, httpPart: 'headers' });
const passes = (r: any): boolean => r === true || (r !== false && r != null && !r.error);

/** Inline local `#/components/...` refs (the contract is bundled by loadSpec, so every ref is local). */
function deref(node: any, spec: any, seen: readonly string[] = []): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, spec, seen));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const ref: string = node.$ref;
    if (seen.includes(ref)) throw new Error(`recursive $ref in a header schema: ${ref}`);
    const target = ref.slice(2).split('/').reduce((o: any, k) => o?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
    if (target === undefined) throw new Error(`unresolved $ref in a header schema: ${ref}`);
    return deref(target, spec, [...seen, ref]);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, spec, seen)]));
}

interface Hdr { name: string; required: boolean; schema: object }
function headerParams(spec: any, pathItem: any, op: any): Hdr[] {
  const byKey = new Map<string, Hdr>();
  for (const raw of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(raw, spec); // op-level wins over path-level for the same (in, name)
    if (p?.in === 'header') byKey.set(p.name.toLowerCase(), { name: p.name, required: p.required === true, schema: p.schema ?? {} });
  }
  return [...byKey.values()];
}

/** Valid sample for a header, picked from the candidates by a reference compile that uses lower-case names on both sides. */
const CANDIDATES = [
  'abc_123-XYZ', '"1"', '1.2.3', 'android', '01926f3a-8b1c-7d2e-9f40-123456789abc', 'a'.repeat(43), 'sample-value', 'x',
  '0'.repeat(32), 'A1B2C3D4',
];
const sampleCache = new Map<string, string>();
function sample(h: Hdr, where: string): string {
  const key = `${h.name.toLowerCase()}|${JSON.stringify(h.schema)}`;
  const hit = sampleCache.get(key);
  if (hit) return hit;
  const ref = compileHeaders({ type: 'object', properties: { [h.name.toLowerCase()]: h.schema }, required: [h.name.toLowerCase()] });
  const v = CANDIDATES.find((c) => passes(ref({ [h.name.toLowerCase()]: c })));
  if (v === undefined) throw new Error(`no sample value for required header ${h.name} (${where}); extend CANDIDATES`);
  sampleCache.set(key, v);
  return v;
}

describe('every operation with a required header parameter accepts the lower-case request headers', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort();
  const ops: Array<{ id: string; headers: Hdr[]; spec: any }> = [];
  for (const f of files) {
    const spec = loadSpec(join(DIR, f));
    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
      for (const [method, op] of Object.entries<any>(item ?? {})) {
        if (!op?.operationId) continue;
        const headers = headerParams(spec, item, op);
        if (headers.some((h) => h.required)) ops.push({ id: `${f}:${method.toUpperCase()} ${path} (${op.operationId})`, headers, spec });
      }
    }
  }

  it('the contracts carry required Idempotency-Key, If-Match and X-Lims-* header parameters (guard against a vacuous test)', () => {
    const names = new Set(ops.flatMap((o) => o.headers.filter((h) => h.required).map((h) => h.name.toLowerCase())));
    expect(names).toContain('idempotency-key');
    expect(names).toContain('if-match');
    expect([...names].some((n) => n.startsWith('x-lims-'))).toBe(true);
  });

  it('all operations pass with lower-case names; each required header, when dropped, is refused', () => {
    const failures: string[] = [];
    for (const o of ops) {
      const schema = {
        type: 'object',
        properties: Object.fromEntries(o.headers.map((h) => [h.name, deref(h.schema, o.spec)])),
        required: o.headers.filter((h) => h.required).map((h) => h.name),
      };
      const validate = compileHeaders(schema);
      const sent: Record<string, string> = {};
      for (const h of o.headers.filter((x) => x.required)) sent[h.name.toLowerCase()] = sample({ ...h, schema: deref(h.schema, o.spec) }, o.id);
      if (!passes(validate({ ...sent }))) failures.push(`${o.id}: refused lower-case ${Object.keys(sent).join(',')}`);
      for (const drop of Object.keys(sent)) {
        const { [drop]: _gone, ...rest } = sent;
        if (passes(compileHeaders(schema)({ ...rest }))) failures.push(`${o.id}: accepted a request without required ${drop}`);
      }
    }
    // Counts for .orchestra/notes/T0A-HEADERS-1-tests.md
    const count = (n: (x: string) => boolean) => ops.filter((o) => o.headers.some((h) => h.required && n(h.name.toLowerCase()))).length;
    console.log(`[T0A-HEADERS-1] operations with a required header: ${ops.length}; If-Match: ${count((n) => n === 'if-match')}; Idempotency-Key: ${count((n) => n === 'idempotency-key')}; X-Lims-*: ${count((n) => n.startsWith('x-lims-'))}`);
    expect(failures).toEqual([]);
    expect(ops.length).toBeGreaterThan(0);
  });
});
