// T0D-FIX-2 (LD-446, CR DEPLOY-AXIS-012 item 3): the parameters the API enforces for an operation (what fastify-openapi-glue hands to the
// route schema after core/module.ts loadSpec) must equal the parameters declared in the YAML, for EVERY operation of EVERY contracts/openapi/*.yaml.
// Found by the live sweep: three billing list operations took Cursor and Limit through YAML aliases (*a1, *a2) and the strict query validation
// then rejected `limit` (400 "querystring must NOT have additional properties"). The test reports every operation that differs; the list must be empty.
// core/openapi.ts is not edited by this task (T0D-FIX-1 owns it): if the loader itself is the cause the finding goes to notes/T0D-FIX-2-left.md.
// Declared side: the raw YAML parsed on its own, parameter $refs (local or _common.yaml) resolved here, path level + operation level (operation wins).
// Loaded side: the real loadSpec, mounted through fastify-openapi-glue; the route schema is read in onRoute (before core adds additionalProperties).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import openapiGlue from 'fastify-openapi-glue';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadSpec, REPO_ROOT } from '../module.js';

const DIR = join(REPO_ROOT, 'contracts', 'openapi');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.yaml') && f !== '_common.yaml').sort();
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const LOCS = ['query', 'path', 'header'] as const;
type Loc = (typeof LOCS)[number];

const raw = (f: string): any => parse(readFileSync(join(DIR, f), 'utf8'));
const walk = (doc: any, ptr: string): any => ptr.replace(/^#?\//, '').split('/').reduce((o, k) => o?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], doc);

/** `loc:name` keys declared for each operationId in the raw YAML. */
function declared(file: string): Map<string, string[]> {
  const doc = raw(file);
  const common = raw('_common.yaml');
  const resolve = (p: any): any => {
    if (!p || typeof p.$ref !== 'string') return p;
    const [f, ptr = ''] = p.$ref.split('#') as [string, string?];
    return f ? walk(common, ptr) : walk(doc, ptr);
  };
  const out = new Map<string, string[]>();
  for (const item of Object.values<any>(doc.paths ?? {})) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op?.operationId) continue;
      const byKey = new Map<string, string>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolve)) {
        if (!p || !LOCS.includes(p.in)) continue;
        const name = p.in === 'header' ? String(p.name).toLowerCase() : String(p.name);
        byKey.set(`${p.in}:${name}`, `${p.in}:${name}`);
      }
      out.set(op.operationId, [...byKey.keys()].sort());
    }
  }
  return out;
}

/** `loc:name` keys the route schema carries for each operationId after loadSpec + glue. */
async function loaded(file: string): Promise<Map<string, string[]>> {
  const spec = structuredClone(loadSpec(join(DIR, file)));
  delete spec.security; // no auth in this probe: only the parameter handling is under test
  for (const item of Object.values<any>(spec.paths ?? {})) for (const m of METHODS) if (item?.[m]) delete item[m].security;
  const app = Fastify();
  app.setValidatorCompiler(() => () => true); // schemas are read in onRoute, never compiled here (the app's ajv knows the x-* keywords, plain fastify does not)
  app.setSerializerCompiler(() => (d) => JSON.stringify(d));
  const out = new Map<string, string[]>();
  app.addHook('onRoute', (route) => {
    const s = route.schema as any;
    if (!s?.operationId) return;
    const keys: string[] = [];
    for (const [part, loc] of [['querystring', 'query'], ['params', 'path'], ['headers', 'header']] as const) {
      for (const n of Object.keys(s[part]?.properties ?? {})) keys.push(`${loc}:${loc === 'header' ? n.toLowerCase() : n}`);
    }
    out.set(s.operationId, [...new Set(keys)].sort());
  });
  await app.register(openapiGlue, { specification: spec, operationResolver: () => async () => ({}) });
  await app.ready();
  await app.close();
  return out;
}

describe('every operation keeps the parameters its YAML declares through the API spec load (T0D-FIX-2, CR DEPLOY-AXIS-012 item 3)', () => {
  it('there are contract files to check', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
    expect(FILES).toContain('billing.yaml');
  });

  it.each(FILES)('%s: the list of operations whose loaded parameters differ from the declared ones is empty', async (file) => {
    const want = declared(file);
    const got = await loaded(file);
    expect(want.size, `${file}: operations found in the YAML`).toBeGreaterThan(0);
    const differ: string[] = [];
    for (const [op, keys] of want) {
      const have = got.get(op);
      if (!have) { differ.push(`${op}: not mounted by the loader`); continue; }
      const dropped = keys.filter((k) => !have.includes(k));
      const extra = have.filter((k) => !keys.includes(k));
      if (dropped.length || extra.length) differ.push(`${op}: dropped [${dropped.join(', ')}] extra [${extra.join(', ')}]`);
    }
    expect(differ, `${file}: operations whose parameters differ after the spec load`).toEqual([]);
  });

  it('billing: the three CR item 3 operations declare Cursor and Limit by an explicit $ref (no YAML alias) and keep cursor + limit when loaded', async () => {
    const IDS = ['listPartyDiscountSlabs', 'listUserDiscountLimits', 'listDiscountAuthorities'];
    const text = readFileSync(join(DIR, 'billing.yaml'), 'utf8');
    // the operation block runs from its operationId line to the next operationId line
    for (const id of IDS) {
      const start = text.search(new RegExp(`operationId: ${id}\\r?\\n`));
      expect(start, `${id} is in billing.yaml`).toBeGreaterThan(-1);
      const next = text.indexOf('operationId:', start + 10);
      const block = text.slice(start, next === -1 ? undefined : next);
      expect(block, `${id}: Cursor by explicit $ref`).toMatch(/\$ref:\s*_common\.yaml#\/components\/parameters\/Cursor/);
      expect(block, `${id}: Limit by explicit $ref`).toMatch(/\$ref:\s*_common\.yaml#\/components\/parameters\/Limit/);
      expect(block, `${id}: no YAML alias in the operation`).not.toMatch(/^\s*-\s*\*a\d+\s*$/m);
    }
    const got = await loaded('billing.yaml');
    for (const id of IDS) expect(got.get(id), id).toEqual(expect.arrayContaining(['query:cursor', 'query:limit']));
  });
});
