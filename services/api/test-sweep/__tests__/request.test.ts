// T0B-SWEEP-2 (LD-270) done_when (2): type-correct minimal request (required fields only) for every write and every platform operation,
// so the call passes input validation and reaches the service. Implementation:
//   services/api/test-sweep/ops.ts     Operation gains `bodySchema?: Record<string, any>`: the JSON request-body schema with every $ref resolved (no `$ref` key left).
//   services/api/test-sweep/request.ts export function buildRequest(op: Operation, token: string | undefined, ids?: Record<string, string>):
//                                        { method: string; url: string; headers: Record<string, string>; payload: string | undefined }
//     path/query/header params and JSON body properties named in `ids` (seeded row ids, by parameter or property name) take that value;
//     otherwise a placeholder of the right type, format, enum, bounds. Body = required properties only. Moved out of run.ts (SWEEP-1 had payload '{}').
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOperations, type Operation } from '../ops.js';
import { buildRequest } from '../request.js';
import { conforms, hasRef, requiredOf } from './conforms.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ops = loadOperations(ROOT);
const WRITE = new Set(['post', 'put', 'patch', 'delete']);
const inScope = (o: Operation) => WRITE.has(o.method) || o.context === 'platform';
const scoped = ops.filter(inScope);
const jsonBody = (o: Operation) => o.hasBody && (o.bodyType ?? '').includes('json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('route table carries the body schema', () => {
  it('has write and platform operations to cover', () => {
    expect(scoped.length).toBeGreaterThan(300);
    expect(ops.filter((o) => o.context === 'platform').length).toBeGreaterThanOrEqual(10);
  });
  it('every JSON-body operation has a fully resolved bodySchema', () => {
    const bad = ops.filter(jsonBody).filter((o) => !o.bodySchema || typeof o.bodySchema !== 'object' || hasRef(o.bodySchema)).map((o) => o.operationId);
    expect(bad).toEqual([]);
  });
});

describe('buildRequest: every write and platform operation (done_when 2)', () => {
  it('resolves every path parameter (no `{` left) and puts the bearer token in', () => {
    const bad = scoped.filter((o) => buildRequest(o, 'tok').url.includes('{') || buildRequest(o, 'tok').headers.authorization !== 'Bearer tok').map((o) => o.operationId);
    expect(bad).toEqual([]);
    expect(buildRequest(scoped[0]!, undefined).headers.authorization).toBeUndefined();
  });
  it('every JSON body is valid JSON that conforms to the schema (required fields, types, formats, enums, bounds)', () => {
    const bad: string[] = [];
    for (const o of scoped.filter(jsonBody)) {
      const r = buildRequest(o, 't');
      let body: unknown;
      try { body = JSON.parse(r.payload ?? ''); } catch { bad.push(`${o.operationId}: payload is not JSON (${String(r.payload).slice(0, 30)})`); continue; }
      const errs = conforms(o.bodySchema, body);
      if (errs.length) bad.push(`${o.operationId}: ${errs.slice(0, 2).join('; ')}`);
      if (r.headers['content-type'] !== 'application/json') bad.push(`${o.operationId}: content-type`);
    }
    expect(bad).toEqual([]);
  });
  it('bodies hold the required properties only (no optional field sent)', () => {
    const bad: string[] = [];
    for (const o of scoped.filter(jsonBody)) {
      const s = o.bodySchema ?? {};
      if (s.oneOf || s.anyOf || !s.properties) continue;     // union / free-form bodies: conformance above is the check
      const body = JSON.parse(buildRequest(o, 't').payload ?? '{}') as Record<string, unknown>;
      const req = new Set(requiredOf(s));
      const extra = Object.keys(body).filter((k) => !req.has(k));
      if (extra.length) bad.push(`${o.operationId}: ${extra.join(',')}`);
    }
    expect(bad).toEqual([]);
  });
  it('required query parameters conform to their schema (integer is numeric, enum is a member, uuid is a uuid)', () => {
    const bad: string[] = [];
    for (const o of scoped) {
      const u = new URL(buildRequest(o, 't').url, 'http://x');
      for (const p of o.params.filter((x) => x.in === 'query' && x.required)) {
        const raw = u.searchParams.get(p.name);
        if (raw === null) { bad.push(`${o.operationId}: ?${p.name} missing`); continue; }
        const v = p.schema.type === 'integer' || p.schema.type === 'number' ? Number(raw) : p.schema.type === 'boolean' ? raw === 'true' : raw;
        if (p.schema.type === 'array') continue;
        const errs = conforms(p.schema, v);
        if (errs.length) bad.push(`${o.operationId}: ?${p.name}=${raw} ${errs[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('uuid path parameters are uuids and integer ones are numbers', () => {
    const bad: string[] = [];
    for (const o of scoped) {
      const url = buildRequest(o, 't').url.split('?')[0]!;
      const tpl = o.path.split('/'), got = url.split('/');
      tpl.forEach((seg, i) => {
        const m = /^\{(.+)\}$/.exec(seg);
        if (!m) return;
        const p = o.params.find((x) => x.in === 'path' && x.name === m[1]);
        const v = decodeURIComponent(got[i] ?? '');
        if (p?.schema.format === 'uuid' && !UUID.test(v)) bad.push(`${o.operationId}: {${m[1]}}=${v}`);
        if ((p?.schema.type === 'integer' || p?.schema.type === 'number') && !Number.isFinite(Number(v))) bad.push(`${o.operationId}: {${m[1]}}=${v}`);
      });
    }
    expect(bad).toEqual([]);
  });
  it('sends an Idempotency-Key where the operation needs one, and a quoted If-Match where required', () => {
    const bad: string[] = [];
    for (const o of scoped) {
      const h = buildRequest(o, 't').headers;
      if (o.idempotency && o.idempotency !== 'none' && !h['idempotency-key']) bad.push(`${o.operationId}: idempotency-key`);
      if (o.params.some((p) => p.in === 'header' && p.required && p.name.toLowerCase() === 'if-match') && !/^"/.test(h['if-match'] ?? '')) bad.push(`${o.operationId}: if-match`);
    }
    expect(bad).toEqual([]);
  });
  it('every multipart or other non-JSON body gets a content-type header', () => {
    const bad = scoped.filter((o) => o.hasBody && !jsonBody(o)).filter((o) => !buildRequest(o, 't').headers['content-type']).map((o) => o.operationId);
    expect(bad).toEqual([]);
  });
});

describe('buildRequest: ids from the seeded rows', () => {
  it('a uuid path parameter named in `ids` takes the seeded id', () => {
    const op = scoped.find((o) => o.params.some((p) => p.in === 'path' && p.schema.format === 'uuid'));
    expect(op, 'no write/platform op with a uuid path param').toBeDefined();
    const name = op!.params.find((p) => p.in === 'path' && p.schema.format === 'uuid')!.name;
    const seeded = '01a1a98a-ac40-7000-8000-00000000d00d';
    expect(buildRequest(op!, 't', { [name]: seeded }).url).toContain(seeded);
    expect(buildRequest(op!, 't').url).not.toContain(seeded);
  });
  it('a required uuid body property named in `ids` takes the seeded id', () => {
    let hit: { op: Operation; prop: string } | undefined;
    for (const o of scoped.filter(jsonBody)) {
      const s = o.bodySchema ?? {};
      if (s.oneOf || s.anyOf) continue;
      const prop = requiredOf(s).find((k) => s.properties?.[k]?.format === 'uuid');
      if (prop) { hit = { op: o, prop }; break; }
    }
    expect(hit, 'no write op with a required uuid body property').toBeDefined();
    const seeded = '01a1a98a-ac40-7000-8000-00000000d00e';
    const body = JSON.parse(buildRequest(hit!.op, 't', { [hit!.prop]: seeded }).payload!) as Record<string, unknown>;
    expect(body[hit!.prop]).toBe(seeded);
  });
});
